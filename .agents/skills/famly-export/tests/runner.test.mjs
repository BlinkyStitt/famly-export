import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireRunLock,
  chromeProfilePath,
  exactMcpTomlSection,
  invokeCodexCapture,
  openViewerFromStdin,
  publishStagedExport,
  replaceMcpTomlSection,
  seedVerifiedMedia,
  stopManagedViewer,
  validateExistingChromeListener,
} from "../scripts/run-export.mjs";

function privateFile(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, value, { mode: 0o600 });
}

test("profile path follows the current user's home and MCP configuration is exact", () => {
  assert.equal(
    chromeProfilePath("/Users/example"),
    "/Users/example/Library/Application Support/Famly Export Chrome",
  );
  const original = [
    'model = "gpt-5"',
    "[mcp_servers.famly-chrome]",
    'command = "wrong"',
    "[mcp_servers.famly-chrome.env]",
    'OLD = "1"',
    "[projects.test]",
    'trust_level = "trusted"',
    "",
  ].join("\n");
  const replaced = replaceMcpTomlSection(original);
  assert.ok(replaced.includes(exactMcpTomlSection()));
  assert.ok(replaced.includes("[projects.test]"));
  assert.ok(!replaced.includes('command = "wrong"'));
  assert.ok(!replaced.includes("OLD"));
  assert.ok(replaced.includes("startup_timeout_sec = 30"));
  assert.ok(replaced.includes("tool_timeout_sec = 120"));
  assert.ok(!replaced.includes("--autoConnect"));
  assert.ok(!replaced.includes("--allowUnrestrictedPaths"));
});

test("port reuse requires one exact dedicated Chrome process", () => {
  const profile = chromeProfilePath("/Users/example");
  const command = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9223",
  ].join(" ");
  assert.equal(
    validateExistingChromeListener(profile, {
      pids: [42],
      commandForPid: () => command,
    }).pid,
    42,
  );
  assert.throws(
    () =>
      validateExistingChromeListener(profile, {
        pids: [42],
        commandForPid: () => "python -m http.server 9223",
      }),
    /unexpected process/,
  );
  assert.throws(
    () => validateExistingChromeListener(profile, { pids: [] }),
    /exactly one listener/,
  );
});

test("run lock rejects a live owner and replaces only a dead owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-run-lock-test-"));
  try {
    const first = acquireRunLock(root);
    assert.throws(() => acquireRunLock(root), /already running/);
    first.release();
    const lockPath = path.join(root, ".famly-export.lock");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    privateFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, nonce: "dead" })}\n`,
    );
    const replacement = acquireRunLock(root);
    replacement.release();
    assert.ok(!fs.existsSync(lockPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer token is sent only on stdin", () => {
  const token = crypto.randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:4173/#access=${token}`;
  let invocation;
  let stdin = "";
  const child = {
    stdin: {
      end(value) {
        stdin = value;
      },
    },
  };
  openViewerFromStdin(url, {
    spawnImplementation(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });
  assert.equal(invocation.command, "/usr/bin/osascript");
  assert.equal(invocation.args.join(" ").includes(token), false);
  assert.equal(JSON.stringify(invocation.options.env).includes(token), false);
  assert.equal(stdin.trim(), url);
});

test("managed viewer replacement rejects unrelated listeners", () => {
  let killed = null;
  assert.equal(
    stopManagedViewer({
      pids: [77],
      commandForPid: () => "node /repo/scripts/serve-export.mjs /repo",
      killProcess(pid, signal) {
        killed = { pid, signal };
      },
    }),
    true,
  );
  assert.deepEqual(killed, { pid: 77, signal: "SIGTERM" });
  assert.throws(
    () =>
      stopManagedViewer({
        pids: [78],
        commandForPid: () => "python -m http.server 4173",
      }),
    /unmanaged process/,
  );
});

test("structured capture failures report the exact phase and remain nonzero", async () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "famly-contract-test-"));
  try {
    await assert.rejects(
      invokeCodexCapture({
        stageRoot,
        capturePath: path.join(os.tmpdir(), "famly-capture-test", "captured-export.json"),
        async run(_command, args, options) {
          const outputPath = args[args.indexOf("--output-last-message") + 1];
          fs.writeFileSync(
            outputPath,
            JSON.stringify({
              status: "failure",
              capturePath: null,
              checkpointPhase: "conversation-lists",
              error: "archived list did not terminate",
            }),
          );
          assert.match(options.input, /return only the required JSON contract/i);
          return { code: 0, signal: null };
        },
      }),
      /failed during conversation-lists: archived list did not terminate/,
    );
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test("publication failure restores all prior authoritative files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-publish-root-"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "famly-publish-stage-"));
  const media = [
    {
      identity: "v1:home:post:p:image:m",
      relativePath: "photos/new.jpg",
    },
  ];
  try {
    for (const relativePath of [
      "metadata/posts.json",
      "metadata/conversations.json",
      "metadata/media.json",
      "metadata/export-summary.json",
      "metadata/media-checksums.sha256",
      "metadata/captured-export.json",
      "messages/index.html",
      "messages/viewer-app.mjs",
    ]) {
      privateFile(path.join(root, relativePath), `old:${relativePath}`);
      privateFile(path.join(stage, relativePath), `new:${relativePath}`);
    }
    privateFile(path.join(stage, "metadata/media.json"), JSON.stringify(media));
    privateFile(path.join(stage, "photos/new.jpg"), "new image");
    assert.throws(
      () =>
        publishStagedExport(stage, root, {
          injectFailure(index) {
            if (index === 3) throw new Error("injected");
          },
        }),
      /injected/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "metadata/posts.json"), "utf8"),
      "old:metadata/posts.json",
    );
    assert.ok(!fs.existsSync(path.join(root, "photos/new.jpg")));
    assert.ok(!fs.existsSync(path.join(root, ".famly-export-transaction.json")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("checksum baseline reuses only verified media and stages corrupt replacements", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-baseline-root-"));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "famly-baseline-stage-"));
  try {
    privateFile(path.join(root, "photos/good.jpg"), "good");
    privateFile(path.join(root, "photos/corrupt.jpg"), "changed");
    const digest = (value) =>
      crypto.createHash("sha256").update(value).digest("hex");
    privateFile(
      path.join(root, "metadata/media-checksums.sha256"),
      `${digest("good")}  photos/good.jpg\n${digest("original")}  photos/corrupt.jpg\n`,
    );
    const result = seedVerifiedMedia(root, stage, [
      { relativePath: "photos/good.jpg" },
      { relativePath: "photos/corrupt.jpg" },
    ]);
    assert.deepEqual(result.reused, ["photos/good.jpg"]);
    assert.deepEqual(result.replacements, ["photos/corrupt.jpg"]);
    assert.ok(fs.existsSync(path.join(stage, "photos/good.jpg")));
    assert.ok(!fs.existsSync(path.join(stage, "photos/corrupt.jpg")));
    assert.equal(
      fs.statSync(path.join(root, "photos/good.jpg")).ino,
      fs.statSync(path.join(stage, "photos/good.jpg")).ino,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
