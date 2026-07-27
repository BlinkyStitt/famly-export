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
      directoryEntries.length !== 1 ||
      directoryEntries[0] !== CAPTURE_FILENAME
    ) {
      throw new Error("Capture directory contains unexpected entries");
    }
    fs.chmodSync(absoluteCapturePath, PRIVATE_FILE_MODE);
    let capture;
    let raw;
    try {
      raw = fs.readFileSync(absoluteCapturePath);
      capture = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Capture is not valid JSON");
    }
    if (
      !capture ||
      typeof capture !== "object" ||
      Array.isArray(capture) ||
      capture.schemaVersion !== 2
    ) {
      throw new Error("Capture schemaVersion must be exactly 2");
    }
    const canonicalRoot = canonicalExportRoot(outputRoot);
    const destination = atomicWritePrivate(
      canonicalRoot,
      path.join(canonicalRoot, "metadata", CAPTURE_FILENAME),
      raw,
    );
    fs.unlinkSync(absoluteCapturePath);
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
    "Usage: secure-capture.mjs prepare | finalize <temp-path> <output-root>",
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
