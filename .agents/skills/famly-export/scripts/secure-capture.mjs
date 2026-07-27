#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  atomicWritePrivate,
  canonicalExportRoot,
  removeOwnedPrivateTree,
} from "./private-tree.mjs";

const CAPTURE_PREFIX = "famly-capture-";
const CAPTURE_FILENAME = "captured-export.json";
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const CHECKPOINT_PHASES = new Set([
  "home",
  "conversation-lists",
  "conversations",
  "complete",
]);

export function conversationCheckpointDue(completedConversationCount) {
  return (
    Number.isInteger(completedConversationCount) &&
    completedConversationCount > 0 &&
    completedConversationCount % 5 === 0
  );
}

function currentUid() {
  return process.getuid();
}

function validateCaptureDirectory(directory, temporaryRoot) {
  const resolvedTemporaryRoot = fs.realpathSync(path.resolve(temporaryRoot));
  const resolvedDirectory = path.resolve(directory);
  if (
    path.dirname(resolvedDirectory) !== resolvedTemporaryRoot ||
    !path.basename(resolvedDirectory).startsWith(CAPTURE_PREFIX)
  ) {
    throw new Error("Capture must be inside a dedicated OS temporary directory");
  }
  const stat = fs.lstatSync(resolvedDirectory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== currentUid()
  ) {
    throw new Error(`Capture directory is not a current-user private directory: ${resolvedDirectory}`);
  }
  fs.chmodSync(resolvedDirectory, PRIVATE_DIRECTORY_MODE);
  return resolvedDirectory;
}

function securePreservedCapture(capturePath, temporaryRoot) {
  try {
    const directory = validateCaptureDirectory(
      path.dirname(capturePath),
      temporaryRoot,
    );
    const stat = fs.lstatSync(capturePath);
    if (
      !stat.isSymbolicLink() &&
      stat.isFile() &&
      stat.uid === currentUid()
    ) {
      fs.chmodSync(capturePath, PRIVATE_FILE_MODE);
      fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    }
  } catch {
    // Preserve the original error; only safely tighten modes when possible.
  }
}

export function sweepStaleCaptures({
  temporaryRoot = os.tmpdir(),
  now = Date.now(),
  maxAgeMs = MAX_CAPTURE_AGE_MS,
} = {}) {
  const canonicalTemporaryRoot = fs.realpathSync(path.resolve(temporaryRoot));
  let removed = 0;
  for (const name of fs.readdirSync(canonicalTemporaryRoot)) {
    if (!name.startsWith(CAPTURE_PREFIX)) {
      continue;
    }
    const target = path.join(canonicalTemporaryRoot, name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== currentUid() ||
      now - stat.mtimeMs < maxAgeMs
    ) {
      continue;
    }
    removeOwnedPrivateTree(target);
    removed += 1;
  }
  return removed;
}

export function prepareCapture(options = {}) {
  const temporaryRoot = fs.realpathSync(
    path.resolve(options.temporaryRoot ?? os.tmpdir()),
  );
  sweepStaleCaptures({ ...options, temporaryRoot });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, CAPTURE_PREFIX));
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  return path.join(directory, CAPTURE_FILENAME);
}

function validateCaptureObject(capture, { phase = null } = {}) {
  if (
    !capture ||
    typeof capture !== "object" ||
    Array.isArray(capture) ||
    capture.schemaVersion !== 2
  ) {
    throw new Error("Capture schemaVersion must be exactly 2");
  }
  if (phase && !CHECKPOINT_PHASES.has(phase)) {
    throw new Error(`Unknown capture checkpoint phase: ${phase}`);
  }
  const requiredByPhase = {
    home: () =>
      Array.isArray(capture.feedPages) &&
      capture.feedPages.length > 0 &&
      capture.workflow?.home?.stableBottomChecks >= 8,
    "conversation-lists": () =>
      requiredByPhase.home() &&
      capture.workflow?.lists?.active?.showMoreExhausted === true &&
      capture.workflow?.lists?.archived?.showMoreExhausted === true,
    conversations: () =>
      requiredByPhase["conversation-lists"]() &&
      capture.workflow?.conversations &&
      typeof capture.workflow.conversations === "object" &&
      conversationCheckpointDue(
        Object.keys(capture.workflow.conversations).length,
      ),
    complete: () =>
      requiredByPhase["conversation-lists"]() &&
      capture.workflow?.conversations &&
      typeof capture.workflow.conversations === "object" &&
      typeof capture.capturedAt === "string" &&
      capture.capturedAt.length > 0,
  };
  if (phase && !requiredByPhase[phase]()) {
    throw new Error(`Capture is incomplete for checkpoint phase ${phase}`);
  }
  return capture;
}

function readPrivateCapture(capturePath, temporaryRoot) {
  const absoluteCapturePath = path.resolve(capturePath);
  const directory = validateCaptureDirectory(
    path.dirname(absoluteCapturePath),
    temporaryRoot,
  );
  if (path.basename(absoluteCapturePath) !== CAPTURE_FILENAME) {
    throw new Error(`Capture filename must be ${CAPTURE_FILENAME}`);
  }
  const stat = fs.lstatSync(absoluteCapturePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== currentUid()) {
    throw new Error("Capture must be a current-user owned regular file");
  }
  fs.chmodSync(absoluteCapturePath, PRIVATE_FILE_MODE);
  let raw;
  let capture;
  try {
    raw = fs.readFileSync(absoluteCapturePath);
    capture = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Capture is not valid JSON");
  }
  validateCaptureObject(capture);
  return { absoluteCapturePath, capture, directory, raw, stat };
}

export function recordCheckpoint(
  capturePath,
  phase,
  { temporaryRoot = os.tmpdir() } = {},
) {
  const { absoluteCapturePath, capture, directory } = readPrivateCapture(
    capturePath,
    temporaryRoot,
  );
  validateCaptureObject(capture, { phase });
  const checkpoint = {
    version: 1,
    phase,
    updatedAt: new Date().toISOString(),
    completedConversationIds:
      phase === "conversations" || phase === "complete"
        ? Object.keys(capture.workflow?.conversations ?? {}).sort()
        : [],
  };
  const checkpointPath = path.join(directory, "checkpoint.json");
  atomicWritePrivate(
    directory,
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
  fs.chmodSync(absoluteCapturePath, PRIVATE_FILE_MODE);
  return { path: absoluteCapturePath, ...checkpoint };
}

export function latestValidCheckpoint({
  temporaryRoot = os.tmpdir(),
  now = Date.now(),
  maxAgeMs = MAX_CAPTURE_AGE_MS,
} = {}) {
  const canonicalTemporaryRoot = fs.realpathSync(path.resolve(temporaryRoot));
  let latest = null;
  for (const name of fs.readdirSync(canonicalTemporaryRoot)) {
    if (!name.startsWith(CAPTURE_PREFIX)) continue;
    const directory = path.join(canonicalTemporaryRoot, name);
    const capturePath = path.join(directory, CAPTURE_FILENAME);
    const checkpointPath = path.join(directory, "checkpoint.json");
    try {
      const { capture, stat } = readPrivateCapture(capturePath, canonicalTemporaryRoot);
      const checkpointStat = fs.lstatSync(checkpointPath);
      if (
        checkpointStat.isSymbolicLink() ||
        !checkpointStat.isFile() ||
        checkpointStat.uid !== currentUid()
      ) {
        continue;
      }
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      validateCaptureObject(capture, { phase: checkpoint.phase });
      const updatedAtMs = Math.max(stat.mtimeMs, checkpointStat.mtimeMs);
      if (now - updatedAtMs > maxAgeMs) continue;
      if (!latest || updatedAtMs > latest.updatedAtMs) {
        latest = { path: capturePath, phase: checkpoint.phase, updatedAtMs };
      }
    } catch {
      // Ignore invalid or attacker-controlled remnants.
    }
  }
  return latest;
}

export function finalizeCapture(
  capturePath,
  outputRoot,
  { temporaryRoot = os.tmpdir() } = {},
) {
  const absoluteCapturePath = path.resolve(capturePath);
  try {
    const directory = validateCaptureDirectory(
      path.dirname(absoluteCapturePath),
      temporaryRoot,
    );
    if (path.basename(absoluteCapturePath) !== CAPTURE_FILENAME) {
      throw new Error(`Capture filename must be ${CAPTURE_FILENAME}`);
    }
    const stat = fs.lstatSync(absoluteCapturePath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== currentUid()
    ) {
      throw new Error("Capture must be a current-user owned regular file");
    }
    const directoryEntries = fs.readdirSync(directory);
    if (
      directoryEntries.some(
        (entry) => entry !== CAPTURE_FILENAME && entry !== "checkpoint.json",
      ) ||
      !directoryEntries.includes(CAPTURE_FILENAME)
    ) {
      throw new Error("Capture directory contains unexpected entries");
    }
    fs.chmodSync(absoluteCapturePath, PRIVATE_FILE_MODE);
    const { capture, raw } = readPrivateCapture(
      absoluteCapturePath,
      temporaryRoot,
    );
    validateCaptureObject(capture);
    const canonicalRoot = canonicalExportRoot(outputRoot);
    const destination = atomicWritePrivate(
      canonicalRoot,
      path.join(canonicalRoot, "metadata", CAPTURE_FILENAME),
      raw,
    );
    fs.unlinkSync(absoluteCapturePath);
    const checkpointPath = path.join(directory, "checkpoint.json");
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
    }
    fs.rmdirSync(directory);
    return destination;
  } catch (error) {
    securePreservedCapture(absoluteCapturePath, temporaryRoot);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}. Private capture preserved for retry at ${absoluteCapturePath}`,
    );
  }
}

function usage() {
  console.error(
    "Usage: secure-capture.mjs prepare | checkpoint <temp-path> <phase> | latest | finalize <temp-path> <output-root>",
  );
}

function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === "prepare") {
      process.stdout.write(`${prepareCapture()}\n`);
      return;
    }
    if (process.argv.length === 5 && process.argv[2] === "finalize") {
      process.stdout.write(
        `${finalizeCapture(process.argv[3], process.argv[4])}\n`,
      );
      return;
    }
    if (process.argv.length === 5 && process.argv[2] === "checkpoint") {
      process.stdout.write(
        `${JSON.stringify(recordCheckpoint(process.argv[3], process.argv[4]))}\n`,
      );
      return;
    }
    if (process.argv.length === 3 && process.argv[2] === "latest") {
      process.stdout.write(`${JSON.stringify(latestValidCheckpoint())}\n`);
      return;
    }
    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
