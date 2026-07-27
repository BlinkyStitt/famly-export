import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { createExportServer } from "../scripts/serve-export.mjs";
import { mediaIdentity } from "../scripts/viewer-app.mjs";

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ENABLED =
  process.platform === "darwin" &&
  process.env.FAMLY_REAL_CHROME_E2E === "1" &&
  fs.existsSync(CHROME);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeFixture(root) {
  for (const directory of [
    "metadata",
    "messages",
    "photos",
    "videos/2026",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
  }
  fs.copyFileSync(
    new URL("../scripts/viewer-shell.html", import.meta.url),
    path.join(root, "messages/index.html"),
  );
  fs.copyFileSync(
    new URL("../scripts/viewer-app.mjs", import.meta.url),
    path.join(root, "messages/viewer-app.mjs"),
  );
  const image = {
    mediaId: "image-1",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "image",
    role: "attachment",
    sourceUrl: "https://img.famly.co/image.png?signature=fixture",
    relativePath: "photos/image.png",
    filename: "image.png",
    expectedMime: "image/png",
  };
  image.identity = mediaIdentity(image);
  const video = {
    mediaId: "video-1",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "video",
    role: "attachment",
    sourceUrl:
      "https://famly-video-storage.s3.eu-central-1.amazonaws.com/video.mp4?signature=fixture",
    relativePath: "videos/2026/video.mp4",
    filename: "video.mp4",
    expectedMime: "video/mp4",
  };
  video.identity = mediaIdentity(video);
  const posts = [
    {
      feedItemId: "post-1",
      createdDate: "2026-01-02T12:00:00Z",
      body: "Café fixture body",
      sender: { title: "Fixture author" },
      comments: [],
    },
  ];
  const summary = {
    manifestSchemaVersion: 3,
    capturedAt: "2026-01-03T00:00:00Z",
    home: {
      oldestPost: "2026-01-02T12:00:00Z",
      newestPost: "2026-01-02T12:00:00Z",
    },
    media: { unsupported: 0, excludedUiAssets: 1 },
    validation: { totalBytes: 100, checksums: "verified" },
    archive: {
      stateMaps: { posts: { "post-1": { presentInLatest: true } } },
      counts: {
        posts: { current: 1, preserved: 0, total: 1 },
        messages: { current: 0, preserved: 0, total: 0 },
      },
    },
  };
  fs.writeFileSync(path.join(root, "metadata/posts.json"), JSON.stringify(posts));
  fs.writeFileSync(path.join(root, "metadata/conversations.json"), "[]");
  fs.writeFileSync(
    path.join(root, "metadata/media.json"),
    JSON.stringify([image, video]),
  );
  fs.writeFileSync(
    path.join(root, "metadata/export-summary.json"),
    JSON.stringify(summary),
  );
  fs.writeFileSync(
    path.join(root, "photos/image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  fs.writeFileSync(
    path.join(root, "videos/2026/video.mp4"),
    Buffer.from("00000018667479706d703432000000006d703432", "hex"),
  );
  return { image, video };
}

async function devtoolsInfo(profile) {
  const target = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(target)) {
      const [port, browserPath] = fs
        .readFileSync(target, "utf8")
        .split(/\r?\n/);
      return { port: Number(port), browserPath };
    }
    await delay(50);
  }
  throw new Error("Chrome did not publish its DevTools port");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let identifier = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++identifier;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
}

test(
  "real Chrome clears fragments and exercises filters, responsive viewer, ranges, favorites, ZIP, and headers",
  { skip: !ENABLED, timeout: 30_000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-browser-root-"));
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "famly-browser-archives-"),
    );
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "famly-browser-profile-"));
    const fixture = writeFixture(root);
    const server = createExportServer({ root, temporaryRoot, port: 0 });
    const address = await server.listen();
    const launchUrl = server.launchUrl();
    const chrome = spawn(CHROME, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore" });
    t.after(async () => {
      chrome.kill("SIGTERM");
      await new Promise((resolve) => chrome.once("exit", resolve));
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    });

    const { port, browserPath } = await devtoolsInfo(profile);
    const browserCdp = await connectCdp(
      `ws://127.0.0.1:${port}${browserPath}`,
    );
    const created = await browserCdp.send("Target.createTarget", {
      url: "about:blank",
    });
    browserCdp.close();
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((value) =>
      value.json(),
    );
    const page = pages.find((candidate) => candidate.id === created.targetId);
    assert.ok(page);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    t.after(() => cdp.close());
    await cdp.send("Page.enable");
    let navigation = await cdp.send("Page.navigate", { url: launchUrl });
    if (navigation.errorText === "net::ERR_ABORTED") {
      await delay(200);
      navigation = await cdp.send("Page.navigate", { url: launchUrl });
    }
    assert.equal(navigation.errorText, undefined);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await evaluate(
          cdp,
          "document.querySelector('#viewer-status')?.textContent.includes('Home posts')",
        )
      ) {
        break;
      }
      await delay(50);
    }
    const state = await evaluate(
      cdp,
      `({
        hash: location.hash,
        href: location.href,
        entries: document.querySelectorAll('.timeline-entry').length,
        status: document.querySelector('#viewer-status')?.textContent,
        hasFilters: Boolean(document.querySelector('#filter-search')),
        video: {
          controls: document.querySelector('video')?.controls,
          preload: document.querySelector('video')?.preload
        },
        health: document.querySelector('#export-health')?.textContent
      })`,
    );
    assert.equal(state.hash, "");
    assert.equal(state.entries, 1, JSON.stringify(state));
    assert.equal(state.hasFilters, true);
    assert.deepEqual(state.video, { controls: true, preload: "metadata" });
    assert.match(state.health, /Verification: verified/);
    const persistedFavorite = await evaluate(
      cdp,
      `document.querySelector('.favorite-button').click();
       localStorage.getItem('famly-export:favorites:v1')`,
    );
    assert.match(persistedFavorite, /image-1/);
    await cdp.send("Page.reload");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await evaluate(
          cdp,
          "document.querySelector('.favorite-button')?.getAttribute('aria-pressed') === 'true'",
        )
      ) {
        break;
      }
      await delay(50);
    }
    assert.equal(
      await evaluate(
        cdp,
        "document.querySelector('.favorite-button')?.getAttribute('aria-pressed')",
      ),
      "true",
    );

    await evaluate(
      cdp,
      `document.querySelector('#filter-search').value='missing';
       document.querySelector('#filter-search').dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    assert.equal(
      await evaluate(cdp, "document.querySelectorAll('.timeline-entry').length"),
      0,
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 700,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(
      await evaluate(cdp, "document.documentElement.scrollWidth <= innerWidth"),
      true,
    );
    const privatePrefix = server.privatePrefix();
    const range = await evaluate(
      cdp,
      `fetch(${JSON.stringify(`${privatePrefix}/${fixture.video.relativePath}`)}, {headers:{Range:'bytes=0-3'}}).then(async r=>({status:r.status,length:(await r.arrayBuffer()).byteLength}))`,
    );
    assert.deepEqual(range, { status: 206, length: 4 });

    const archive = await evaluate(
      cdp,
      `fetch(${JSON.stringify(`${privatePrefix}/api/favorites-archives`)},{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({identities:[${JSON.stringify(fixture.image.identity)},${JSON.stringify(fixture.video.identity)}]})
      }).then(async r=>({status:r.status,body:await r.json()}))`,
    );
    assert.equal(archive.status, 201);
    const downloadStatus = await evaluate(
      cdp,
      `fetch(${JSON.stringify(privatePrefix)} + ${JSON.stringify(archive.body.downloadUrl.slice(privatePrefix.length))}).then(r=>r.status)`,
    );
    assert.equal(downloadStatus, 200);
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  },
);
