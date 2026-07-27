import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  KILLSWITCH_URL,
  downloadManifestIndex,
  validateDownloadUrl,
} from "../scripts/download-media-worker.mjs";
import { mediaIdentity } from "../scripts/viewer-app.mjs";

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function privateFile(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}

function manifestEntry(overrides = {}) {
  const entry = {
    mediaId: "image-1",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "image",
    sourceUrl:
      "https://img.famly.co/original.jpg?signature=secret-signed-value",
    relativePath: "photos/original.jpg",
    filename: "original.jpg",
    expectedMime: "image/jpeg",
    ...overrides,
  };
  entry.identity = mediaIdentity(entry);
  return entry;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-download-test-"));
  fs.mkdirSync(path.join(root, "metadata"));
  const manifestPath = path.join(root, "metadata", "media.json");
  const entry = manifestEntry();
  fs.writeFileSync(manifestPath, `${JSON.stringify([entry])}\n`);
  return { root, manifestPath, entry };
}

test("download URLs require approved HTTPS hosts and visible safe characters", () => {
  assert.equal(
    validateDownloadUrl("https://img.famly.co/file.jpg?x=1"),
    "https://img.famly.co/file.jpg?x=1",
  );
  assert.equal(
    validateDownloadUrl(
      "https://famly-de.s3.eu-central-1.amazonaws.com/file.pdf?x=1",
    ),
    "https://famly-de.s3.eu-central-1.amazonaws.com/file.pdf?x=1",
  );
  for (const value of [
    "http://img.famly.co/file.jpg",
    "https://example.com/file.jpg",
    "https://other.famly.co/file.jpg",
    "https://famly-evil.amazonaws.com/file.jpg",
    "https://img.famly.co/file.jpg bad",
    "https://img.famly.co/file.jpg\n--output=bad",
    'https://img.famly.co/file.jpg"',
  ]) {
    assert.throws(() => validateDownloadUrl(value));
  }
  assert.throws(
    () => validateDownloadUrl(KILLSWITCH_URL),
    /prohibited Famly killswitch URL was rejected locally/,
  );
});

test("worker supplies signed URL only through curl stdin and creates private output", () => {
  const data = fixture();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "famly-fake-curl-"));
  const curlPath = path.join(fakeBin, "curl");
  const argsPath = path.join(fakeBin, "args");
  const stdinPath = path.join(fakeBin, "stdin");
  fs.writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
output_path=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--output" ]]; then
    output_path="$argument"
  fi
  previous="$argument"
done
cat > "$FAKE_CURL_STDIN"
printf 'downloaded-original' > "$output_path"
`,
    { mode: 0o700 },
  );
  try {
    execFileSync(
      process.execPath,
      [
        new URL("../scripts/download-media-worker.mjs", import.meta.url)
          .pathname,
        "download",
        data.manifestPath,
        data.root,
        "0",
      ],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          FAKE_CURL_ARGS: argsPath,
          FAKE_CURL_STDIN: stdinPath,
        },
      },
    );
    const args = fs.readFileSync(argsPath, "utf8");
    const stdin = fs.readFileSync(stdinPath, "utf8");
    assert.ok(!args.includes(data.entry.sourceUrl));
    assert.ok(!args.includes("secret-signed-value"));
    assert.equal(stdin, `url = "${data.entry.sourceUrl}"\n`);
    assert.match(args, /--proto\n=https\n/);
    assert.match(args, /--proto-redir\n=https\n/);
    const target = path.join(data.root, data.entry.relativePath);
    assert.equal(fs.readFileSync(target, "utf8"), "downloaded-original");
    assert.equal(mode(target), 0o600);
    assert.equal(mode(path.dirname(target)), 0o700);
    assert.ok(!fs.existsSync(`${target}.part`));
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("worker resumes partials, skips complete files, and rejects symlink targets", () => {
  const data = fixture();
  const target = path.join(data.root, data.entry.relativePath);
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(`${target}.part`, "partial");
  let curlCalls = 0;
  try {
    const result = downloadManifestIndex(
      data.manifestPath,
      data.root,
      0,
      {
        runCurl: (args, input) => {
          curlCalls += 1;
          assert.ok(args.includes("--continue-at"));
          assert.equal(input, `url = "${data.entry.sourceUrl}"\n`);
          fs.appendFileSync(`${target}.part`, "-complete");
          return { status: 0 };
        },
      },
    );
    assert.equal(result.skipped, false);
    assert.equal(fs.readFileSync(target, "utf8"), "partial-complete");

    const skipped = downloadManifestIndex(
      data.manifestPath,
      data.root,
      0,
      {
        runCurl: () => {
          throw new Error("complete downloads must be skipped");
        },
      },
    );
    assert.equal(skipped.skipped, true);
    assert.equal(curlCalls, 1);

    fs.unlinkSync(target);
    const outside = path.join(data.root, "outside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, target);
    assert.throws(
      () => downloadManifestIndex(data.manifestPath, data.root, 0),
      /Symbolic links are not allowed/,
    );
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});

test("an empty media manifest fails closed as a capture regression", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-empty-media-test-"));
  const manifestPath = path.join(root, "metadata", "media.json");
  try {
    privateFile(manifestPath, "[]");
    assert.throws(
      () => downloadManifestIndex(manifestPath, root, 0),
      /Media manifest must be a nonempty array/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker refuses a symlinked output parent", () => {
  const data = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "famly-download-outside-"));
  fs.symlinkSync(outside, path.join(data.root, "photos"));
  try {
    assert.throws(
      () => downloadManifestIndex(data.manifestPath, data.root, 0),
      /Symbolic links are not allowed/,
    );
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("failed downloads retain resumable bytes but remove empty partials", () => {
  const empty = fixture();
  const emptyPart = path.join(empty.root, `${empty.entry.relativePath}.part`);
  try {
    assert.throws(
      () =>
        downloadManifestIndex(empty.manifestPath, empty.root, 0, {
          runCurl: () => ({ status: 22 }),
        }),
      /curl failed/,
    );
    assert.ok(!fs.existsSync(emptyPart));
  } finally {
    fs.rmSync(empty.root, { recursive: true, force: true });
  }

  const resumable = fixture();
  const resumablePart = path.join(
    resumable.root,
    `${resumable.entry.relativePath}.part`,
  );
  fs.mkdirSync(path.dirname(resumablePart));
  fs.writeFileSync(resumablePart, "partial bytes");
  try {
    assert.throws(
      () =>
        downloadManifestIndex(resumable.manifestPath, resumable.root, 0, {
          runCurl: () => ({ status: 22 }),
        }),
      /curl failed/,
    );
    assert.equal(fs.readFileSync(resumablePart, "utf8"), "partial bytes");
    assert.equal(mode(resumablePart), 0o600);
  } finally {
    fs.rmSync(resumable.root, { recursive: true, force: true });
  }
});

test("successful curl with empty output removes the partial file", () => {
  const data = fixture();
  const part = path.join(data.root, `${data.entry.relativePath}.part`);
  try {
    assert.throws(
      () =>
        downloadManifestIndex(data.manifestPath, data.root, 0, {
          runCurl: () => ({ status: 0 }),
        }),
      /Downloaded media is empty/,
    );
    assert.ok(!fs.existsSync(part));
  } finally {
    fs.rmSync(data.root, { recursive: true, force: true });
  }
});
