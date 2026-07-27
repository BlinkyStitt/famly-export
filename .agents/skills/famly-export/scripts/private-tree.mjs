#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_TREE_NAMES = Object.freeze([
  "metadata",
  "photos",
  "videos",
  "files",
  "message-images",
  "messages",
]);

process.umask(0o077);

function fail(message) {
  throw new Error(message);
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    fail("Private export ownership checks require a POSIX operating system");
  }
  return process.getuid();
}

function assertOwned(stat, target) {
  if (stat.uid !== currentUid()) {
    fail(`Private path is not owned by the current user: ${target}`);
  }
}

function lstatOwned(target) {
  const stat = fs.lstatSync(target);
  assertOwned(stat, target);
  if (stat.isSymbolicLink()) {
    fail(`Symbolic links are not allowed in the private export: ${target}`);
  }
  return stat;
}

function assertDirectory(stat, target) {
  if (!stat.isDirectory()) {
    fail(`Private path is not a directory: ${target}`);
  }
}

function assertRegularFile(stat, target) {
  if (!stat.isFile()) {
    fail(`Private path is not a regular file: ${target}`);
  }
}

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`Private path escapes the canonical export root: ${target}`);
  }
  return relative;
}

export function canonicalExportRoot(root) {
  const absolute = path.resolve(root);
  const rootStat = lstatOwned(absolute);
  assertDirectory(rootStat, absolute);
  const canonical = fs.realpathSync(absolute);
  return canonical;
}

function pathSegments(root, target) {
  let absolute = path.resolve(target);
  let relative;
  try {
    relative = relativeInside(root, absolute);
  } catch {
    let existingParent = path.dirname(absolute);
    const suffix = [path.basename(absolute)];
    while (true) {
      try {
        const canonicalParent = fs.realpathSync(existingParent);
        absolute = path.join(canonicalParent, ...suffix);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(existingParent);
        if (parent === existingParent) {
          throw error;
        }
        suffix.unshift(path.basename(existingParent));
        existingParent = parent;
      }
    }
    relative = relativeInside(root, absolute);
  }
  return {
    absolute,
    segments: relative === "" ? [] : relative.split(path.sep),
  };
}

export function inspectPrivatePath(
  root,
  target,
  { allowMissingLeaf = false, expectedType = null, chmod = true } = {},
) {
  const canonicalRoot = canonicalExportRoot(root);
  const { absolute, segments } = pathSegments(canonicalRoot, target);
  let current = canonicalRoot;
  let stat = lstatOwned(current);
  assertDirectory(stat, current);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      stat = lstatOwned(current);
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === segments.length - 1 &&
        error?.code === "ENOENT"
      ) {
        return {
          root: canonicalRoot,
          path: absolute,
          exists: false,
          stat: null,
        };
      }
      throw error;
    }
    if (index < segments.length - 1) {
      assertDirectory(stat, current);
    }
  }
  if (expectedType === "directory") {
    assertDirectory(stat, absolute);
    if (chmod) {
      fs.chmodSync(absolute, PRIVATE_DIRECTORY_MODE);
    }
  } else if (expectedType === "file") {
    assertRegularFile(stat, absolute);
    if (chmod) {
      fs.chmodSync(absolute, PRIVATE_FILE_MODE);
    }
  }
  return {
    root: canonicalRoot,
    path: absolute,
    exists: true,
    stat: fs.statSync(absolute),
  };
}

export function ensurePrivateDirectory(root, target) {
  const canonicalRoot = canonicalExportRoot(root);
  const { absolute, segments } = pathSegments(canonicalRoot, target);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = lstatOwned(current);
      assertDirectory(stat, current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
      const stat = lstatOwned(current);
      assertDirectory(stat, current);
    }
    fs.chmodSync(current, PRIVATE_DIRECTORY_MODE);
  }
  return absolute;
}

export function privateRegularFile(root, target, { mustExist = true } = {}) {
  return inspectPrivatePath(root, target, {
    allowMissingLeaf: !mustExist,
    expectedType: mustExist ? "file" : null,
  });
}

function hardenEntry(target) {
  const stat = lstatOwned(target);
  if (stat.isDirectory()) {
    fs.chmodSync(target, PRIVATE_DIRECTORY_MODE);
    for (const entry of fs.readdirSync(target)) {
      hardenEntry(path.join(target, entry));
    }
    return;
  }
  assertRegularFile(stat, target);
  fs.chmodSync(target, PRIVATE_FILE_MODE);
}

export function hardenPrivateTrees(root, names = PRIVATE_TREE_NAMES) {
  const canonicalRoot = canonicalExportRoot(root);
  const hardened = { directories: 0, files: 0 };
  const visit = (target) => {
    const stat = lstatOwned(target);
    if (stat.isDirectory()) {
      fs.chmodSync(target, PRIVATE_DIRECTORY_MODE);
      hardened.directories += 1;
      for (const entry of fs.readdirSync(target)) {
        visit(path.join(target, entry));
      }
      return;
    }
    assertRegularFile(stat, target);
    fs.chmodSync(target, PRIVATE_FILE_MODE);
    hardened.files += 1;
  };
  for (const name of names) {
    if (
      typeof name !== "string" ||
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".."
    ) {
      fail(`Unsafe private tree name: ${String(name)}`);
    }
    const target = path.join(canonicalRoot, name);
    try {
      visit(target);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return hardened;
}

export function atomicWritePrivate(root, target, contents) {
  const canonicalRoot = canonicalExportRoot(root);
  const { absolute } = pathSegments(canonicalRoot, target);
  const parent = ensurePrivateDirectory(canonicalRoot, path.dirname(absolute));
  inspectPrivatePath(canonicalRoot, parent, { expectedType: "directory" });
  const existing = inspectPrivatePath(canonicalRoot, absolute, {
    allowMissingLeaf: true,
  });
  if (existing.exists) {
    assertRegularFile(lstatOwned(absolute), absolute);
  }
  const temporaryPath = path.join(
    parent,
    `.${path.basename(absolute)}.${crypto.randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    if (typeof contents === "string" || Buffer.isBuffer(contents)) {
      fs.writeFileSync(handle, contents);
    } else {
      fail("Private atomic writes require string or Buffer contents");
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    fs.renameSync(temporaryPath, absolute);
    fs.chmodSync(absolute, PRIVATE_FILE_MODE);
    const parentHandle = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentHandle);
    } finally {
      fs.closeSync(parentHandle);
    }
  } catch (error) {
    if (handle != null) {
      fs.closeSync(handle);
    }
    try {
      const stat = fs.lstatSync(temporaryPath);
      if (stat.isFile() && stat.uid === currentUid()) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // Nothing safe remains to clean up.
    }
    throw error;
  }
  return absolute;
}

export function removeOwnedPrivateTree(target) {
  const stat = lstatOwned(target);
  assertDirectory(stat, target);
  hardenEntry(target);
  fs.rmSync(target, { recursive: true });
}

function usage() {
  console.error("Usage: private-tree.mjs harden <export-root>");
}

function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "harden") {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const result = hardenPrivateTrees(process.argv[3]);
    process.stdout.write(
      `directories=${result.directories}\nfiles=${result.files}\n`,
    );
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
