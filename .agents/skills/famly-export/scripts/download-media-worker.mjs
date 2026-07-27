#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  KILLSWITCH_URL,
  validateFamlyMediaUrl,
} from "./famly-url.mjs";
import {
  PRIVATE_FILE_MODE,
  canonicalExportRoot,
  ensurePrivateDirectory,
  inspectPrivatePath,
} from "./private-tree.mjs";
import {
  isAllowedMediaRecord,
  mediaIdentity,
} from "./viewer-app.mjs";

export { KILLSWITCH_URL };

export function validateDownloadUrl(value) {
  return validateFamlyMediaUrl(value);
}

function loadManifest(manifestPath, outputRoot) {
  const root = canonicalExportRoot(outputRoot);
  for (const relativeDirectory of [
    "metadata",
    "photos",
    "videos",
    "files",
    "message-images",
    "messages",
    "messages/attachments",
  ]) {
    ensurePrivateDirectory(root, path.join(root, relativeDirectory));
  }
  const inspected = inspectPrivatePath(root, path.resolve(manifestPath), {
    expectedType: "file",
  });
  const manifest = JSON.parse(fs.readFileSync(inspected.path, "utf8"));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("Media manifest must be a nonempty array");
  }
  const relativePaths = new Set();
  const identities = new Set();
  manifest.forEach((entry, index) => {
    try {
      const sourceUrl = validateDownloadUrl(entry?.sourceUrl);
      const identity = mediaIdentity(entry);
      if (
        sourceUrl !== entry.sourceUrl ||
        !identity ||
        identity !== entry.identity ||
        !isAllowedMediaRecord(entry) ||
        relativePaths.has(entry.relativePath) ||
        identities.has(identity)
      ) {
        throw new Error("record is unsafe, unsupported, or duplicated");
      }
      relativePaths.add(entry.relativePath);
      identities.add(identity);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Media manifest record ${index} failed validation: ${detail}`);
    }
  });
  return { root, manifest };
}

function defaultRunCurl(args, input) {
  return spawnSync("curl", args, {
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

export function downloadManifestIndex(
  manifestPath,
  outputRoot,
  index,
  { runCurl = defaultRunCurl } = {},
) {
  const { root, manifest } = loadManifest(manifestPath, outputRoot);
  return downloadEntry({ root, manifest, index, runCurl });
}

function downloadEntry({ root, manifest, index, runCurl }) {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.length) {
    throw new Error("Media manifest index is out of range");
  }
  const entry = manifest[index];
  const targetPath = path.join(root, ...entry.relativePath.split("/"));
  const parentPath = ensurePrivateDirectory(root, path.dirname(targetPath));
  inspectPrivatePath(root, parentPath, { expectedType: "directory" });
  const target = inspectPrivatePath(root, targetPath, {
    allowMissingLeaf: true,
  });
  if (target.exists) {
    if (!target.stat.isFile()) {
      throw new Error(`Media target is not a regular file: ${entry.relativePath}`);
    }
    fs.chmodSync(targetPath, PRIVATE_FILE_MODE);
    if (target.stat.size > 0) {
      return { skipped: true, relativePath: entry.relativePath };
    }
  }

  const partPath = `${targetPath}.part`;
  const part = inspectPrivatePath(root, partPath, { allowMissingLeaf: true });
  if (part.exists) {
    if (!part.stat.isFile()) {
      throw new Error(`Partial media target is not a regular file: ${entry.relativePath}`);
    }
    fs.chmodSync(partPath, PRIVATE_FILE_MODE);
  } else {
    const handle = fs.openSync(
      partPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    fs.closeSync(handle);
  }

  const curlArguments = [
    "--config",
    "-",
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--retry",
    "3",
    "--retry-all-errors",
    "--connect-timeout",
    "15",
    "--max-time",
    "300",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--output",
    partPath,
  ];
  if (fs.statSync(partPath).size > 0) {
    curlArguments.push("--continue-at", "-");
  }
  const curlInput = `url = "${entry.sourceUrl}"\n`;
  const result = runCurl(curlArguments, curlInput);
  const removeEmptyPart = () => {
    try {
      const stat = fs.lstatSync(partPath);
      if (
        !stat.isSymbolicLink() &&
        stat.isFile() &&
        stat.uid === process.getuid() &&
        stat.size === 0
      ) {
        fs.unlinkSync(partPath);
      }
    } catch {
      // Preserve the download error and any nonempty resumable data.
    }
  };
  if (result?.error) {
    removeEmptyPart();
    throw result.error;
  }
  if (result?.status !== 0) {
    removeEmptyPart();
    throw new Error(`curl failed for media manifest record ${index}`);
  }

  const completedPart = inspectPrivatePath(root, partPath, {
    expectedType: "file",
  });
  if (completedPart.stat.size === 0) {
    removeEmptyPart();
    throw new Error(`Downloaded media is empty for manifest record ${index}`);
  }
  const finalTarget = inspectPrivatePath(root, targetPath, {
    allowMissingLeaf: true,
  });
  if (finalTarget.exists && !finalTarget.stat.isFile()) {
    throw new Error(`Media target changed type during download: ${entry.relativePath}`);
  }
  fs.renameSync(partPath, targetPath);
  fs.chmodSync(targetPath, PRIVATE_FILE_MODE);
  return { skipped: false, relativePath: entry.relativePath };
}

export function downloadManifestIndexes(
  manifestPath,
  outputRoot,
  indexes,
  options = {},
) {
  const { root, manifest } = loadManifest(manifestPath, outputRoot);
  return indexes.map((index) =>
    downloadEntry({
      root,
      manifest,
      index,
      runCurl: options.runCurl ?? defaultRunCurl,
    }),
  );
}

export function validateDownloadManifest(manifestPath, outputRoot) {
  return loadManifest(manifestPath, outputRoot).manifest.length;
}

function usage() {
  console.error(
    "Usage: download-media-worker.mjs validate <media.json> <output-root> | download <media.json> <output-root> <index> [index ...]",
  );
}

function main() {
  try {
    if (process.argv.length === 5 && process.argv[2] === "validate") {
      process.stdout.write(
        `${validateDownloadManifest(process.argv[3], process.argv[4])}\n`,
      );
      return;
    }
    if (process.argv.length >= 6 && process.argv[2] === "download") {
      const indexes = process.argv.slice(5).map(Number);
      downloadManifestIndexes(
        process.argv[3],
        process.argv[4],
        indexes,
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
