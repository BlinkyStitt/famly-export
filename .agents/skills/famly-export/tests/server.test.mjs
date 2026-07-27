import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  createExportServer,
  sweepStaleArchiveDirectories,
} from "../scripts/serve-export.mjs";
import { mediaIdentity } from "../scripts/viewer-app.mjs";

function fixtureEntry(overrides = {}) {
  const entry = {
    mediaId: "home-image",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "image",
    sourceUrl: "https://img.famly.co/original.jpg?signature=private",
    relativePath: "photos/same.jpg",
    filename: "same.jpg",
    expectedMime: "image/jpeg",
    ...overrides,
  };
  entry.identity = mediaIdentity(entry);
  return entry;
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "famly-server-test-"));
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-server-archives-test-"),
  );
  for (const directory of [
    "metadata",
    "messages",
    "photos",
    "message-images",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "messages", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(root, "messages", "viewer-app.mjs"), "export {};");
  fs.writeFileSync(path.join(root, "metadata", "posts.json"), "[]\n");
  fs.writeFileSync(path.join(root, "metadata", "conversations.json"), "[]\n");
  fs.writeFileSync(path.join(root, "metadata", "export-summary.json"), "{}\n");
  fs.writeFileSync(
    path.join(root, "metadata", "captured-export.json"),
    '{"private":true}\n',
  );
  const entries = [
    fixtureEntry(),
    fixtureEntry({
      mediaId: "message-image",
      sourceType: "message",
      ownerType: "message",
      ownerId: "message-1",
      conversationId: "conversation-1",
      relativePath: "message-images/same.jpg",
    }),
  ];
  fs.writeFileSync(
    path.join(root, "metadata", "media.json"),
    `${JSON.stringify(entries)}\n`,
  );
  fs.writeFileSync(path.join(root, "photos", "same.jpg"), "home-original");
  fs.writeFileSync(
    path.join(root, "message-images", "same.jpg"),
    "message-original",
  );
  return { root, temporaryRoot, entries };
}

function requestRaw({
  port,
  requestPath,
  method = "GET",
  headers = {},
  body = "",
}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function startFixtureServer(options = {}) {
  const fixture = fixtureRoot();
  const localServer = createExportServer({
    root: fixture.root,
    temporaryRoot: fixture.temporaryRoot,
    port: 0,
    ...options,
  });
  const address = await localServer.listen();
  return {
    ...fixture,
    localServer,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    privatePrefix: localServer.privatePrefix(),
  };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.temporaryRoot, { recursive: true, force: true });
}

test("server exposes only fixed public files and token-authenticated private data", async (t) => {
  const fixture = await startFixtureServer();
  t.after(async () => {
    await fixture.localServer.close();
    cleanupFixture(fixture);
  });

  assert.equal(fixture.localServer.address().address, "127.0.0.1");
  assert.match(fixture.localServer.accessToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    fixture.localServer.launchUrl(),
    `${fixture.origin}/#access=${fixture.localServer.accessToken()}`,
  );

  const index = await fetch(`${fixture.origin}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(index.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(index.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(index.headers.get("x-frame-options"), "DENY");
  assert.equal(index.headers.get("referrer-policy"), "no-referrer");
  assert.match(index.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(index.headers.get("content-security-policy"), /frame-ancestors 'none'/);

  const publicModule = await fetch(`${fixture.origin}/messages/viewer-app.mjs`);
  assert.equal(publicModule.status, 200);
  for (const requestPath of [
    "/metadata/posts.json",
    "/metadata/media.json",
    "/photos/same.jpg",
    "/metadata/captured-export.json",
    "/metadata/media-checksums.sha256",
    "/photos/",
    "/.agents/skills/famly-export/SKILL.md",
  ]) {
    const response = await fetch(`${fixture.origin}${requestPath}`);
    assert.equal(response.status, 404, requestPath);
  }

  const wrongToken = "A".repeat(43);
  assert.notEqual(wrongToken, fixture.localServer.accessToken());
  const wrong = await fetch(
    `${fixture.origin}/_private/${wrongToken}/metadata/posts.json`,
  );
  assert.equal(wrong.status, 404);

  const posts = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/metadata/posts.json`,
  );
  assert.equal(posts.status, 200);
  assert.deepEqual(await posts.json(), []);

  const manifest = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/metadata/media.json`,
  );
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json; charset=utf-8");
  const media = await manifest.json();
  assert.equal(media.length, 2);
  assert.ok(media.every((entry) => !Object.hasOwn(entry, "sourceUrl")));
  assert.ok(
    !JSON.stringify(media).includes("signature=private"),
    "signed URLs must not be disclosed by the viewer projection",
  );

  const image = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/photos/same.jpg`,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(await image.text(), "home-original");

  const rawCapture = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/metadata/captured-export.json`,
  );
  assert.equal(rawCapture.status, 404);

  const traversal = await requestRaw({
    port: fixture.port,
    requestPath: `${fixture.privatePrefix}/photos/%2e%2e/metadata/captured-export.json`,
  });
  assert.equal(traversal.status, 400);
  const absoluteForm = await requestRaw({
    port: fixture.port,
    requestPath: `${fixture.origin}${fixture.privatePrefix}/metadata/posts.json`,
  });
  assert.equal(absoluteForm.status, 400);
  const wrongHost = await requestRaw({
    port: fixture.port,
    requestPath: `${fixture.privatePrefix}/metadata/posts.json`,
    headers: { Host: `localhost:${fixture.port}` },
  });
  assert.equal(wrongHost.status, 400);
});

test("server rotates launch tokens without changing the viewer origin", async () => {
  const fixture = fixtureRoot();
  const first = createExportServer({
    root: fixture.root,
    temporaryRoot: fixture.temporaryRoot,
    port: 0,
  });
  const firstAddress = await first.listen();
  const firstToken = first.accessToken();
  await first.close();

  const second = createExportServer({
    root: fixture.root,
    temporaryRoot: fixture.temporaryRoot,
    port: firstAddress.port,
  });
  await second.listen();
  try {
    assert.notEqual(second.accessToken(), firstToken);
    assert.equal(second.address().port, firstAddress.port);
    const stale = await fetch(
      `http://127.0.0.1:${firstAddress.port}/_private/${firstToken}/metadata/posts.json`,
    );
    assert.equal(stale.status, 404);
  } finally {
    await second.close();
    cleanupFixture(fixture);
  }
});

test("archive API rejects cross-origin, oversized, invalid, and concurrent requests", async (t) => {
  let releaseZip;
  let markZipStarted;
  const zipGate = new Promise((resolve) => {
    releaseZip = resolve;
  });
  const zipStarted = new Promise((resolve) => {
    markZipStarted = resolve;
  });
  const fixture = await startFixtureServer({
    createZip: async (_sourceDirectory, zipPath) => {
      markZipStarted();
      await zipGate;
      fs.writeFileSync(zipPath, "fixture-zip");
    },
  });
  t.after(async () => {
    releaseZip();
    await fixture.localServer.close();
    cleanupFixture(fixture);
  });
  const endpoint = `${fixture.origin}${fixture.privatePrefix}/api/favorites-archives`;
  const validBody = JSON.stringify({
    identities: [fixture.entries[0].identity],
  });

  const crossOrigin = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.com",
    },
    body: validBody,
  });
  assert.equal(crossOrigin.status, 403);

  const invalidIdentity = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: fixture.origin,
    },
    body: JSON.stringify({ identities: ["not-current"] }),
  });
  assert.equal(invalidIdentity.status, 400);

  const tooMany = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: fixture.origin,
    },
    body: JSON.stringify({
      identities: Array.from({ length: 5_001 }, (_, index) => `image-${index}`),
    }),
  });
  assert.equal(tooMany.status, 400);

  const oversized = await requestRaw({
    port: fixture.port,
    requestPath: `${fixture.privatePrefix}/api/favorites-archives`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: fixture.origin,
    },
    body: "x".repeat(600 * 1024),
  });
  assert.equal(oversized.status, 413);

  const firstRequest = fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: fixture.origin,
    },
    body: validBody,
  });
  await zipStarted;
  const concurrent = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: fixture.origin,
    },
    body: validBody,
  });
  assert.equal(concurrent.status, 409);
  releaseZip();
  assert.equal((await firstRequest).status, 201);
});

test("ZIP is private, flat, checksum-preserving, and one-time", async (t) => {
  const fixture = await startFixtureServer();
  t.after(async () => {
    await fixture.localServer.close();
    cleanupFixture(fixture);
  });
  const creation = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/api/favorites-archives`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.origin,
      },
      body: JSON.stringify({
        identities: fixture.entries.map((entry) => entry.identity).reverse(),
      }),
    },
  );
  assert.equal(creation.status, 201);
  const payload = await creation.json();
  assert.match(
    payload.downloadUrl,
    new RegExp(`^${fixture.privatePrefix}/api/favorites-archives/[A-Za-z0-9_-]{32}$`),
  );
  assert.match(payload.filename, /^Famly-Favorites-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(fixture.localServer.archiveCount(), 1);

  const archiveDirectories = fs
    .readdirSync(fixture.temporaryRoot)
    .filter((name) => name.startsWith("famly-favorites-"));
  assert.equal(archiveDirectories.length, 1);
  const archiveRoot = path.join(fixture.temporaryRoot, archiveDirectories[0]);
  assert.equal(fs.statSync(archiveRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(archiveRoot, "favorites.zip")).mode & 0o777, 0o600);

  const deniedDownload = await fetch(`${fixture.origin}${payload.downloadUrl}`, {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(deniedDownload.status, 403);
  assert.equal(fixture.localServer.archiveCount(), 1);

  const download = await fetch(`${fixture.origin}${payload.downloadUrl}`, {
    headers: { Referer: `${fixture.origin}/` },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/zip");
  const zipPath = path.join(fixture.root, "fixture.zip");
  fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));
  assert.equal(fixture.localServer.archiveCount(), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!fs.existsSync(archiveRoot));

  const members = execFileSync("/usr/bin/unzip", ["-Z1", zipPath], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((member) => member && !member.endsWith("/"))
    .sort();
  assert.deepEqual(members, [
    "Famly Favorites/same (2).jpg",
    "Famly Favorites/same.jpg",
  ]);
  assert.ok(!members.some((member) => member.includes("__MACOSX")));
  const archivedBodies = members
    .map((member) =>
      execFileSync("/usr/bin/unzip", ["-p", zipPath, member], {
        encoding: "utf8",
      }),
    )
    .sort();
  assert.deepEqual(archivedBodies, ["home-original", "message-original"]);

  const digest = (body) =>
    crypto.createHash("sha256").update(body).digest("hex");
  assert.deepEqual(
    archivedBodies.map(digest).sort(),
    ["home-original", "message-original"].map(digest).sort(),
  );

  const secondDownload = await fetch(
    `${fixture.origin}${payload.downloadUrl}`,
    { headers: { Referer: `${fixture.origin}/` } },
  );
  assert.equal(secondDownload.status, 404);
});

test("startup removes stale crash remnants but preserves active archive directories", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-stale-archives-test-"),
  );
  const stale = fs.mkdtempSync(path.join(temporaryRoot, "famly-favorites-"));
  const active = fs.mkdtempSync(path.join(temporaryRoot, "famly-favorites-"));
  fs.writeFileSync(path.join(stale, "favorites.zip"), "stale");
  fs.writeFileSync(path.join(active, "favorites.zip"), "active");
  const now = Date.now();
  const old = new Date(now - 2 * 60 * 60 * 1_000);
  fs.utimesSync(stale, old, old);
  try {
    assert.equal(
      sweepStaleArchiveDirectories({ temporaryRoot, now }),
      1,
    );
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(active));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("abandoned archives expire and are deleted", async (t) => {
  const fixture = await startFixtureServer({ archiveTtlMs: 25 });
  t.after(async () => {
    await fixture.localServer.close();
    cleanupFixture(fixture);
  });
  const creation = await fetch(
    `${fixture.origin}${fixture.privatePrefix}/api/favorites-archives`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.origin,
      },
      body: JSON.stringify({
        identities: [fixture.entries[0].identity],
      }),
    },
  );
  assert.equal(creation.status, 201);
  const payload = await creation.json();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const expired = await fetch(`${fixture.origin}${payload.downloadUrl}`, {
    headers: { Referer: `${fixture.origin}/` },
  });
  assert.equal(expired.status, 404);
  assert.equal(fixture.localServer.archiveCount(), 0);
});

test("server startup rejects symlinks in private trees", () => {
  const fixture = fixtureRoot();
  const outside = path.join(fixture.root, "outside.jpg");
  fs.writeFileSync(outside, "outside");
  fs.unlinkSync(path.join(fixture.root, "photos", "same.jpg"));
  fs.symlinkSync(outside, path.join(fixture.root, "photos", "same.jpg"));
  try {
    assert.throws(
      () =>
        createExportServer({
          root: fixture.root,
          temporaryRoot: fixture.temporaryRoot,
          port: 0,
        }),
      /Symbolic links are not allowed/,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a safe manifest entry with a missing local file returns 404 without blocking startup", async () => {
  const fixture = fixtureRoot();
  fs.unlinkSync(path.join(fixture.root, "photos", "same.jpg"));
  const server = createExportServer({
    root: fixture.root,
    temporaryRoot: fixture.temporaryRoot,
    port: 0,
  });
  const address = await server.listen();
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${server.privatePrefix()}/photos/same.jpg`,
    );
    assert.equal(response.status, 404);
  } finally {
    await server.close();
    cleanupFixture(fixture);
  }
});
