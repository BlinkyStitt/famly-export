#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildExport } from "./build-export.mjs";
import {
  latestValidCheckpoint,
  prepareCapture,
  recordCheckpoint,
} from "./secure-capture.mjs";
import { createExportServer } from "./serve-export.mjs";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  atomicWritePrivate,
  canonicalExportRoot,
  ensurePrivateDirectory,
  inspectPrivatePath,
  removeOwnedPrivateTree,
} from "./private-tree.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");
const LOCK_NAME = ".famly-export.lock";
const JOURNAL_NAME = ".famly-export-transaction.json";
const TRANSACTION_PREFIX = ".famly-export-transaction-";
const VIEWER_PORT = 4173;
const DEVTOOLS_PORT = 9223;
const CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const REQUIRED_COMMANDS = Object.freeze([
  "node",
  "codex",
  "npx",
  "jq",
  "curl",
  "xargs",
  "file",
  "shasum",
  "sips",
  "find",
  "grep",
  "lsof",
  "/usr/bin/ditto",
  "/usr/bin/open",
  "/usr/bin/osascript",
]);
const MCP_ARGS = Object.freeze([
  "-y",
  "chrome-devtools-mcp@1.6.0",
  "--browserUrl=http://127.0.0.1:9223",
  "--redactNetworkHeaders",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--no-category-network",
  "--no-category-performance",
  "--blockedUrlPattern=https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch",
]);
const AUTHORITATIVE_PATHS = Object.freeze([
  "metadata/posts.json",
  "metadata/conversations.json",
  "metadata/media.json",
  "metadata/export-summary.json",
  "metadata/media-checksums.sha256",
  "metadata/captured-export.json",
  "messages/index.html",
  "messages/viewer-app.mjs",
]);

function fail(message) {
  throw new Error(message);
}

function commandPath(command) {
  if (command.startsWith("/")) {
    return fs.existsSync(command) ? command : null;
  }
  const result = spawnSync("/usr/bin/which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function chromeProfilePath(homeDirectory = os.homedir()) {
  if (!path.isAbsolute(homeDirectory)) {
    fail("The current user's home directory is not absolute");
  }
  return path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Famly Export Chrome",
  );
}

export function preflight({
  root = REPOSITORY_ROOT,
  minimumFreeBytes = 2 * 1024 * 1024 * 1024,
  commands = REQUIRED_COMMANDS,
} = {}) {
  const missing = commands.filter((command) => !commandPath(command));
  if (missing.length) {
    fail(`Missing required tool(s): ${missing.join(", ")}. Run brew bundle.`);
  }
  const stat = fs.statfsSync(root);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < minimumFreeBytes) {
    fail(
      `Insufficient free disk space: ${freeBytes} bytes available; ${minimumFreeBytes} required`,
    );
  }
  return { freeBytes, commands: Object.fromEntries(commands.map((name) => [name, commandPath(name)])) };
}

function parseLockOwner(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  const stat = fs.lstatSync(ownerPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid()) {
    fail("Famly export lock owner record is unsafe");
  }
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  if (
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== "string" ||
    !owner.nonce
  ) {
    fail("Famly export lock owner record is invalid");
  }
  return owner;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireRunLock(root = REPOSITORY_ROOT) {
  const canonicalRoot = canonicalExportRoot(root);
  const lockPath = path.join(canonicalRoot, LOCK_NAME);
  try {
    fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) {
      fail("Famly export lock is not a current-user directory");
    }
    const owner = parseLockOwner(lockPath);
    if (pidIsAlive(owner.pid)) {
      fail(`Another Famly export is already running (PID ${owner.pid})`);
    }
    removeOwnedPrivateTree(lockPath);
    fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
  }
  const owner = {
    pid: process.pid,
    uid: process.getuid(),
    startedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(24).toString("base64url"),
  };
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  let released = false;
  return {
    owner,
    path: lockPath,
    release() {
      if (released || !fs.existsSync(lockPath)) {
        return;
      }
      const current = parseLockOwner(lockPath);
      if (current.pid !== owner.pid || current.nonce !== owner.nonce) {
        fail("Refusing to remove a Famly export lock owned by another run");
      }
      removeOwnedPrivateTree(lockPath);
      released = true;
    },
  };
}

export function exactMcpTomlSection() {
  return [
    "[mcp_servers.famly-chrome]",
    'command = "npx"',
    `args = ${JSON.stringify(MCP_ARGS)}`,
    "startup_timeout_sec = 30",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.famly-chrome.env]",
    'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1"',
  ].join("\n");
}

export function replaceMcpTomlSection(contents) {
  const lines = String(contents).split(/\r?\n/);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
    if (table) {
      if (
        table === "mcp_servers.famly-chrome" ||
        table.startsWith("mcp_servers.famly-chrome.")
      ) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }
  while (output.length && output.at(-1) === "") {
    output.pop();
  }
  return `${output.join("\n")}\n\n${exactMcpTomlSection()}\n`;
}

export function ensureMcpConfiguration({
  configPath = path.join(os.homedir(), ".codex", "config.toml"),
} = {}) {
  const stat = fs.lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid()) {
    fail(`Codex configuration is not a current-user regular file: ${configPath}`);
  }
  const existing = fs.readFileSync(configPath, "utf8");
  const desired = replaceMcpTomlSection(existing);
  if (desired === existing) {
    return false;
  }
  const temporary = `${configPath}.famly-${crypto.randomBytes(8).toString("hex")}`;
  fs.writeFileSync(temporary, desired, { flag: "wx", mode: PRIVATE_FILE_MODE });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, PRIVATE_FILE_MODE);
  return true;
}

function listenerPids(port) {
  const result = spawnSync("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ], { encoding: "utf8" });
  if (result.status !== 0 && !result.stdout.trim()) {
    return [];
  }
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}

function processCommand(pid) {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function validateExistingChromeListener(
  profilePath,
  { port = DEVTOOLS_PORT, pids = listenerPids(port), commandForPid = processCommand } = {},
) {
  if (pids.length !== 1) {
    fail(`DevTools port ${port} must have exactly one listener`);
  }
  const command = commandForPid(pids[0]);
  const required = [
    "Google Chrome",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profilePath}`,
  ];
  if (!required.every((value) => command.includes(value))) {
    fail(
      `Port ${port} is occupied by an unexpected process; close it before exporting`,
    );
  }
  return { pid: pids[0], command };
}

function ensureProfile(profilePath) {
  if (fs.existsSync(profilePath)) {
    const stat = fs.lstatSync(profilePath);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) {
      fail(`Chrome profile is not a current-user directory: ${profilePath}`);
    }
  } else {
    fs.mkdirSync(profilePath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  fs.chmodSync(profilePath, PRIVATE_DIRECTORY_MODE);
}

export function launchOrReuseChrome({
  profilePath = chromeProfilePath(),
  port = DEVTOOLS_PORT,
} = {}) {
  ensureProfile(profilePath);
  const pids = listenerPids(port);
  if (pids.length) {
    return { reused: true, ...validateExistingChromeListener(profilePath, { port, pids }) };
  }
  const result = spawnSync("/usr/bin/open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "https://app.famly.co/",
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    fail("Google Chrome could not be launched");
  }
  return { reused: false };
}

function captureContractSchema(stageRoot) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "capturePath", "checkpointPhase", "error"],
    properties: {
      status: { enum: ["success", "failure"] },
      capturePath: { type: ["string", "null"] },
      checkpointPhase: {
        enum: ["home", "conversation-lists", "conversations", "complete", null],
      },
      error: { type: ["string", "null"] },
    },
  };
  const target = path.join(stageRoot, "capture-result-schema.json");
  fs.writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`, {
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  return target;
}

export function capturePrompt({ capturePath, resumePath = null }) {
  return [
    "Use the $famly-export skill and only the famly-chrome MCP server.",
    "The user has already been warned that opening Messages may mark unread conversations read.",
    "Capture the complete authenticated Famly Home and Messages export using the tracked capture hook and required equality/terminal-page/reaction checks.",
    `Save owner-only schema-2 checkpoints by overwriting this exact prepared path after Home, after both conversation lists, and after each five completed conversations: ${capturePath}`,
    `After every checkpoint save run: node ${path.join(SCRIPT_ROOT, "secure-capture.mjs")} checkpoint ${capturePath} <home|conversation-lists|conversations>`,
    resumePath
      ? `Resume the valid capture state from ${resumePath}; merge it into the installed page hook before continuing, without redoing completed conversation work.`
      : "Start a new capture.",
    "On success, save the finalized capture to the prepared path, record checkpoint phase complete, and return only the required JSON contract.",
    "On failure, leave the newest valid checkpoint in place and return the failure contract with the exact phase and error.",
    "Do not inspect headers, cookies, storage, credentials, profile files, or any browser other than famly-chrome.",
  ].join("\n");
}

async function runChild(
  command,
  args,
  {
    input = null,
    cwd = REPOSITORY_ROOT,
    env = process.env,
    signal = undefined,
  } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export async function invokeCodexCapture({
  stageRoot,
  capturePath,
  resumePath = null,
  run = runChild,
  signal = undefined,
} = {}) {
  const schemaPath = captureContractSchema(stageRoot);
  const resultPath = path.join(stageRoot, "capture-result.json");
  const result = await run("codex", [
    "exec",
    "-C",
    REPOSITORY_ROOT,
    "--sandbox",
    "workspace-write",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    resultPath,
    "-c",
    "mcp_servers.famly-chrome.startup_timeout_sec=30",
    "-c",
    "mcp_servers.famly-chrome.tool_timeout_sec=120",
    "-",
  ], { input: capturePrompt({ capturePath, resumePath }), signal });
  if (result.code !== 0) {
    fail(`Browser capture failed (codex exec exit ${result.code ?? result.signal})`);
  }
  const contract = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  if (
    !contract ||
    typeof contract !== "object" ||
    Array.isArray(contract) ||
    !["success", "failure"].includes(contract.status) ||
    !["home", "conversation-lists", "conversations", "complete", null].includes(
      contract.checkpointPhase,
    )
  ) {
    fail("Browser capture returned an invalid result contract");
  }
  if (contract.status !== "success") {
    if (typeof contract.error !== "string" || !contract.error) {
      fail("Browser capture returned an invalid failure contract");
    }
    fail(
      `Browser capture failed during ${contract.checkpointPhase ?? "unknown"}: ${contract.error ?? "unknown error"}`,
    );
  }
  if (
    typeof contract.capturePath !== "string" ||
    contract.checkpointPhase !== "complete" ||
    contract.error !== null
  ) {
    fail("Browser capture returned an invalid success contract");
  }
  if (path.resolve(contract.capturePath) !== path.resolve(capturePath)) {
    fail("Browser capture returned an unexpected capture path");
  }
  recordCheckpoint(capturePath, "complete");
  return contract;
}

export function readChecksumBaseline(root) {
  const checksumPath = path.join(root, "metadata", "media-checksums.sha256");
  if (!fs.existsSync(checksumPath)) {
    return new Map();
  }
  inspectPrivatePath(root, checksumPath, { expectedType: "file" });
  const baseline = new Map();
  for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match || baseline.has(match[2])) {
      fail("The previous media checksum baseline is malformed");
    }
    baseline.set(match[2], match[1]);
  }
  return baseline;
}

function verifiedBaselinePaths(root, baseline) {
  if (baseline.size === 0) return new Set();
  const checksumPath = path.join(root, "metadata", "media-checksums.sha256");
  const result = spawnSync(
    "shasum",
    ["-a", "256", "-c", checksumPath],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  const verified = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.endsWith(": OK")) continue;
    const relativePath = line.slice(0, -4);
    if (baseline.has(relativePath)) verified.add(relativePath);
  }
  return verified;
}

export function seedVerifiedMedia(previousRoot, stageRoot, media) {
  const baseline = readChecksumBaseline(previousRoot);
  const verified = verifiedBaselinePaths(previousRoot, baseline);
  const reused = [];
  const replacements = [];
  for (const entry of media) {
    if (!verified.has(entry.relativePath)) {
      replacements.push(entry.relativePath);
      continue;
    }
    const source = path.join(previousRoot, ...entry.relativePath.split("/"));
    const target = path.join(stageRoot, ...entry.relativePath.split("/"));
    ensurePrivateDirectory(stageRoot, path.dirname(target));
    fs.linkSync(source, target);
    fs.chmodSync(target, PRIVATE_FILE_MODE);
    reused.push(entry.relativePath);
  }
  return { reused, replacements };
}

function copyPrivateFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${target}.next-${crypto.randomBytes(8).toString("hex")}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, PRIVATE_FILE_MODE);
  fs.renameSync(temporary, target);
}

function isSafePublicationPath(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !path.posix.isAbsolute(relativePath) &&
    !relativePath.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(relativePath) &&
    path.posix.normalize(relativePath) === relativePath &&
    !relativePath.split("/").includes("..")
  );
}

export function recoverPublication(root = REPOSITORY_ROOT) {
  root = canonicalExportRoot(root);
  const journalPath = path.join(root, JOURNAL_NAME);
  if (!fs.existsSync(journalPath)) {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(TRANSACTION_PREFIX)) continue;
      const target = path.join(root, name);
      try {
        removeOwnedPrivateTree(target);
      } catch {
        // An unsafe remnant is left in place and will be rejected if targeted.
      }
    }
    return false;
  }
  inspectPrivatePath(root, journalPath, { expectedType: "file" });
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (
    journal?.version !== 1 ||
    !/^\.famly-export-transaction-[a-f0-9]{24}$/.test(
      journal.backupDirectory,
    ) ||
    !Array.isArray(journal.created) ||
    !Array.isArray(journal.replaced) ||
    ![...journal.created, ...journal.replaced].every(isSafePublicationPath)
  ) {
    fail("Famly export publication journal is invalid");
  }
  const backupRoot = path.join(root, journal.backupDirectory);
  inspectPrivatePath(root, backupRoot, { expectedType: "directory" });
  for (const relativePath of journal.created ?? []) {
    const target = path.join(root, ...relativePath.split("/"));
    if (fs.existsSync(target)) {
      inspectPrivatePath(root, target, { expectedType: "file" });
      fs.unlinkSync(target);
    }
  }
  for (const relativePath of journal.replaced ?? []) {
    const backup = path.join(backupRoot, ...relativePath.split("/"));
    const target = path.join(root, ...relativePath.split("/"));
    if (fs.existsSync(backup)) {
      inspectPrivatePath(backupRoot, backup, { expectedType: "file" });
      copyPrivateFile(backup, target);
    }
  }
  fs.unlinkSync(journalPath);
  if (fs.existsSync(backupRoot)) {
    removeOwnedPrivateTree(backupRoot);
  }
  return true;
}

export function publishStagedExport(
  stageRoot,
  root = REPOSITORY_ROOT,
  { injectFailure = null } = {},
) {
  stageRoot = canonicalExportRoot(stageRoot);
  root = canonicalExportRoot(root);
  recoverPublication(root);
  const stagedMediaManifest = path.join(stageRoot, "metadata", "media.json");
  inspectPrivatePath(stageRoot, stagedMediaManifest, { expectedType: "file" });
  const media = JSON.parse(fs.readFileSync(stagedMediaManifest));
  if (
    !Array.isArray(media) ||
    media.some((entry) => !isSafePublicationPath(entry?.relativePath))
  ) {
    fail("Staged media manifest contains an unsafe publication path");
  }
  const relativePaths = [
    ...media
      .map((entry) => entry.relativePath)
      .filter((relativePath) => {
        const target = path.join(root, ...relativePath.split("/"));
        if (!fs.existsSync(target)) return true;
        const stagedStat = fs.statSync(
          path.join(stageRoot, ...relativePath.split("/")),
        );
        const targetStat = fs.statSync(target);
        return (
          stagedStat.dev !== targetStat.dev || stagedStat.ino !== targetStat.ino
        );
      }),
    ...AUTHORITATIVE_PATHS,
  ];
  const backupDirectory = `${TRANSACTION_PREFIX}${crypto.randomBytes(12).toString("hex")}`;
  const backupRoot = path.join(root, backupDirectory);
  fs.mkdirSync(backupRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const journal = { version: 1, backupDirectory, replaced: [], created: [] };
  try {
    for (const relativePath of relativePaths) {
      const source = path.join(stageRoot, ...relativePath.split("/"));
      if (!fs.existsSync(source)) {
        fail(`Staged publication is missing ${relativePath}`);
      }
      inspectPrivatePath(stageRoot, source, { expectedType: "file" });
      const target = path.join(root, ...relativePath.split("/"));
      if (fs.existsSync(target)) {
        inspectPrivatePath(root, target, { expectedType: "file" });
        const backup = path.join(backupRoot, ...relativePath.split("/"));
        copyPrivateFile(target, backup);
        journal.replaced.push(relativePath);
      } else {
        journal.created.push(relativePath);
      }
    }
    atomicWritePrivate(
      root,
      path.join(root, JOURNAL_NAME),
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  } catch (error) {
    if (fs.existsSync(backupRoot)) {
      removeOwnedPrivateTree(backupRoot);
    }
    throw error;
  }
  try {
    let index = 0;
    for (const relativePath of relativePaths) {
      copyPrivateFile(
        path.join(stageRoot, ...relativePath.split("/")),
        path.join(root, ...relativePath.split("/")),
      );
      injectFailure?.(++index, relativePath);
    }
    fs.unlinkSync(path.join(root, JOURNAL_NAME));
    removeOwnedPrivateTree(backupRoot);
  } catch (error) {
    recoverPublication(root);
    throw error;
  }
}

export function openViewerFromStdin(
  url,
  { spawnImplementation = spawn } = {},
) {
  if (!/^http:\/\/127\.0\.0\.1:4173\/#access=[A-Za-z0-9_-]{43}$/.test(url)) {
    fail("Viewer launch URL is invalid");
  }
  const script = [
    "ObjC.import('AppKit');",
    "ObjC.import('Foundation');",
    "const data=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
    "const value=$.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding).js.trim();",
    "$.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(value));",
  ].join("");
  const child = spawnImplementation(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    {
      stdio: ["pipe", "ignore", "inherit"],
      env: {},
    },
  );
  child.stdin.end(`${url}\n`);
  return child;
}

export function stopManagedViewer({
  port = VIEWER_PORT,
  pids = listenerPids(port),
  commandForPid = processCommand,
  killProcess = process.kill,
} = {}) {
  if (pids.length === 0) return false;
  if (pids.length !== 1) {
    fail(`Viewer port ${port} has multiple listeners`);
  }
  const command = commandForPid(pids[0]);
  if (
    !command.includes("node") ||
    (!command.includes("serve-export.mjs") && !command.includes("famly-export"))
  ) {
    fail(`Viewer port ${port} is occupied by an unmanaged process`);
  }
  killProcess(pids[0], "SIGTERM");
  return true;
}

async function promptForSignIn(signal) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question(
      "Sign in to Famly in the dedicated Chrome window, open Home, then press Return.\n" +
      "Warning: exporting Messages opens every conversation and may mark unread conversations read; unread state is not restored. ",
      { signal },
    );
  } finally {
    terminal.close();
  }
}

function phaseError(phase, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Famly export failed during ${phase}: ${message}`);
}

export async function main() {
  process.umask(0o077);
  const root = canonicalExportRoot(REPOSITORY_ROOT);
  let lock;
  let stageRoot;
  let viewer;
  let completedCaptureDirectory = null;
  let phase = "startup";
  const abortController = new AbortController();
  let resolveSignal;
  const signalReceived = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const handleSignal = () => {
    abortController.abort(new Error("Interrupted by user"));
    resolveSignal();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    recoverPublication(root);
    lock = acquireRunLock(root);
    phase = "preflight";
    preflight({ root });
    ensureMcpConfiguration();
    phase = "browser startup";
    launchOrReuseChrome();
    await promptForSignIn(abortController.signal);

    phase = "capture";
    const checkpoint = latestValidCheckpoint();
    const capturePath = checkpoint?.path ?? prepareCapture();
    completedCaptureDirectory = path.dirname(capturePath);
    stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "famly-export-stage-"));
    fs.chmodSync(stageRoot, PRIVATE_DIRECTORY_MODE);
    await invokeCodexCapture({
      stageRoot,
      capturePath,
      resumePath:
        checkpoint && Date.now() - checkpoint.updatedAtMs <= CAPTURE_MAX_AGE_MS
          ? checkpoint.path
          : null,
      signal: abortController.signal,
    });
    recordCheckpoint(capturePath, "complete");
    ensurePrivateDirectory(stageRoot, path.join(stageRoot, "metadata"));
    const stagedCapture = path.join(stageRoot, "metadata", "captured-export.json");
    fs.copyFileSync(capturePath, stagedCapture);
    fs.chmodSync(stagedCapture, PRIVATE_FILE_MODE);

    phase = "manifest build";
    buildExport(stagedCapture, stageRoot, {
      previousRoot: root,
    });
    const media = JSON.parse(fs.readFileSync(path.join(stageRoot, "metadata", "media.json")));
    seedVerifiedMedia(root, stageRoot, media);

    phase = "media download and integrity validation";
    const download = await runChild(
      "bash",
      [
        path.join(SCRIPT_ROOT, "download-media.sh"),
        path.join(stageRoot, "metadata", "media.json"),
        stageRoot,
        "8",
      ],
      { signal: abortController.signal },
    );
    if (download.code !== 0) {
      fail(`media validation exited ${download.code ?? download.signal}`);
    }

    phase = "publication";
    publishStagedExport(stageRoot, root);
    if (
      completedCaptureDirectory &&
      fs.existsSync(completedCaptureDirectory)
    ) {
      removeOwnedPrivateTree(completedCaptureDirectory);
      completedCaptureDirectory = null;
    }
    phase = "viewer startup";
    stopManagedViewer();
    viewer = createExportServer({ root, port: VIEWER_PORT });
    await viewer.listen();
    const launchUrl = viewer.launchUrl();
    openViewerFromStdin(launchUrl);
    process.stdout.write(`Verified Famly export published. Viewer: ${launchUrl}\n`);
    process.stdout.write("Press Ctrl-C to stop the managed viewer.\n");
    await signalReceived;
  } catch (error) {
    console.error(phaseError(phase, error).message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (viewer) {
      await viewer.close().catch(() => {});
    }
    if (stageRoot && fs.existsSync(stageRoot)) {
      removeOwnedPrivateTree(stageRoot);
    }
    try {
      lock?.release();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
