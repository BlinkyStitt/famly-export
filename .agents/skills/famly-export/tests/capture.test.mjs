import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeCapture,
  prepareCapture,
  sweepStaleCaptures,
} from "../scripts/secure-capture.mjs";

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function capture(value = "new") {
  return {
    schemaVersion: 2,
    capturedAt: "2026-07-26T00:00:00Z",
    value,
  };
}

test("prepare and finalize use private modes, atomic replacement, and cleanup", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-parent-test-"),
  );
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-output-test-"),
  );
  try {
    const firstPath = prepareCapture({ temporaryRoot });
    assert.equal(path.basename(firstPath), "captured-export.json");
    assert.equal(mode(path.dirname(firstPath)), 0o700);
    fs.writeFileSync(firstPath, JSON.stringify(capture("first")), {
      mode: 0o644,
    });
    const destination = finalizeCapture(firstPath, outputRoot, {
      temporaryRoot,
    });
    assert.equal(
      destination,
      fs.realpathSync(path.join(outputRoot, "metadata", "captured-export.json")),
    );
    assert.equal(mode(path.join(outputRoot, "metadata")), 0o700);
    assert.equal(mode(destination), 0o600);
    assert.equal(JSON.parse(fs.readFileSync(destination)).value, "first");
    assert.ok(!fs.existsSync(path.dirname(firstPath)));

    const secondPath = prepareCapture({ temporaryRoot });
    fs.writeFileSync(secondPath, JSON.stringify(capture("second")));
    finalizeCapture(secondPath, outputRoot, { temporaryRoot });
    assert.equal(JSON.parse(fs.readFileSync(destination)).value, "second");
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), [
      "captured-export.json",
    ]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("invalid capture remains private and reports its retry location", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-invalid-test-"),
  );
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-invalid-output-test-"),
  );
  const capturePath = prepareCapture({ temporaryRoot });
  fs.writeFileSync(capturePath, '{"schemaVersion":1}', { mode: 0o666 });
  try {
    assert.throws(
      () => finalizeCapture(capturePath, outputRoot, { temporaryRoot }),
      (error) =>
        /schemaVersion must be exactly 2/.test(error.message) &&
        error.message.includes(capturePath),
    );
    assert.ok(fs.existsSync(capturePath));
    assert.equal(mode(capturePath), 0o600);
    assert.equal(mode(path.dirname(capturePath)), 0o700);
    assert.ok(
      !fs.existsSync(path.join(outputRoot, "metadata", "captured-export.json")),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("finalization rejects captures outside the prepared private directory", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-containment-test-"),
  );
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-containment-output-test-"),
  );
  const outside = path.join(temporaryRoot, "captured-export.json");
  fs.writeFileSync(outside, JSON.stringify(capture()));
  try {
    assert.throws(
      () => finalizeCapture(outside, outputRoot, { temporaryRoot }),
      /dedicated OS temporary directory/,
    );
    assert.ok(fs.existsSync(outside));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("finalization rejects a symlinked capture without reading its target", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-symlink-test-"),
  );
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-symlink-output-test-"),
  );
  const capturePath = prepareCapture({ temporaryRoot });
  const outside = path.join(temporaryRoot, "outside.json");
  fs.writeFileSync(outside, JSON.stringify(capture("outside")));
  fs.symlinkSync(outside, capturePath);
  try {
    assert.throws(
      () => finalizeCapture(capturePath, outputRoot, { temporaryRoot }),
      /current-user owned regular file/,
    );
    assert.equal(JSON.parse(fs.readFileSync(outside)).value, "outside");
    assert.ok(
      !fs.existsSync(path.join(outputRoot, "metadata", "captured-export.json")),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("prepare sweeps only owner-matching stale capture directories", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-sweep-test-"),
  );
  const stale = fs.mkdtempSync(path.join(temporaryRoot, "famly-capture-"));
  const active = fs.mkdtempSync(path.join(temporaryRoot, "famly-capture-"));
  fs.writeFileSync(path.join(stale, "captured-export.json"), "{}");
  fs.writeFileSync(path.join(active, "captured-export.json"), "{}");
  const now = Date.now();
  const old = new Date(now - 25 * 60 * 60 * 1_000);
  fs.utimesSync(stale, old, old);
  try {
    assert.equal(sweepStaleCaptures({ temporaryRoot, now }), 1);
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(active));
    const prepared = prepareCapture({ temporaryRoot, now });
    assert.ok(fs.existsSync(path.dirname(prepared)));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("finalization preserves a capture directory with unexpected entries", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-extra-test-"),
  );
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-capture-extra-output-test-"),
  );
  const capturePath = prepareCapture({ temporaryRoot });
  fs.writeFileSync(capturePath, JSON.stringify(capture()));
  fs.writeFileSync(path.join(path.dirname(capturePath), "unexpected"), "data");
  try {
    assert.throws(
      () => finalizeCapture(capturePath, outputRoot, { temporaryRoot }),
      /unexpected entries/,
    );
    assert.ok(fs.existsSync(capturePath));
    assert.equal(mode(capturePath), 0o600);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
