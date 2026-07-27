import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  atomicWritePrivate,
  canonicalExportRoot,
  hardenPrivateTrees,
  inspectPrivatePath,
} from "../scripts/private-tree.mjs";

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function digest(target) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(target))
    .digest("hex");
}

test("hardening preserves content while enforcing owner-only modes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-private-tree-test-"));
  const metadata = path.join(root, "metadata");
  const photos = path.join(root, "photos");
  fs.mkdirSync(metadata, { mode: 0o755 });
  fs.mkdirSync(photos, { mode: 0o777 });
  const manifest = path.join(metadata, "media.json");
  const photo = path.join(photos, "family.jpg");
  fs.writeFileSync(manifest, "[{\"private\":true}]\n", { mode: 0o644 });
  fs.writeFileSync(photo, "original bytes", { mode: 0o666 });
  const before = new Map([
    [manifest, digest(manifest)],
    [photo, digest(photo)],
  ]);
  try {
    const result = hardenPrivateTrees(root);
    assert.equal(result.directories, 2);
    assert.equal(result.files, 2);
    assert.equal(mode(metadata), 0o700);
    assert.equal(mode(photos), 0o700);
    assert.equal(mode(manifest), 0o600);
    assert.equal(mode(photo), 0o600);
    assert.equal(digest(manifest), before.get(manifest));
    assert.equal(digest(photo), before.get(photo));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private paths reject escape, symlinks, and non-regular filesystem nodes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-private-path-test-"));
  const metadata = path.join(root, "metadata");
  fs.mkdirSync(metadata);
  const outside = path.join(os.tmpdir(), `famly-outside-${crypto.randomUUID()}`);
  fs.writeFileSync(outside, "outside");
  const symlink = path.join(metadata, "linked.json");
  fs.symlinkSync(outside, symlink);
  const fifo = path.join(metadata, "pipe");
  execFileSync("mkfifo", [fifo]);
  try {
    assert.throws(
      () => inspectPrivatePath(root, outside, { expectedType: "file" }),
      /escapes the canonical export root/,
    );
    assert.throws(
      () => hardenPrivateTrees(root),
      /Symbolic links are not allowed/,
    );
    fs.unlinkSync(symlink);
    assert.throws(
      () => hardenPrivateTrees(root),
      /not a regular file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test("atomic private writes replace regular files without leaving temporary data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-atomic-test-"));
  const target = path.join(root, "metadata", "captured-export.json");
  try {
    atomicWritePrivate(root, target, "first");
    atomicWritePrivate(root, target, "second");
    assert.equal(fs.readFileSync(target, "utf8"), "second");
    assert.equal(mode(path.dirname(target)), 0o700);
    assert.equal(mode(target), 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), [
      "captured-export.json",
    ]);

    fs.unlinkSync(target);
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, target);
    assert.throws(
      () => atomicWritePrivate(root, target, "unsafe"),
      /Symbolic links are not allowed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an export-root symlink is rejected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-root-test-"));
  const link = `${root}-link`;
  fs.symlinkSync(root, link);
  try {
    assert.throws(() => canonicalExportRoot(link), /Symbolic links are not allowed/);
  } finally {
    fs.unlinkSync(link);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
