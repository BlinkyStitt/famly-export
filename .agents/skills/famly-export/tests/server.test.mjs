import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createExportServer } from "../scripts/serve-export.mjs";
import { mediaIdentity } from "../scripts/viewer-app.mjs";

function fixtureEntry(overrides = {}) {
  const entry = {
    mediaId: "home-image",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "image",
    sourceUrl: "https://img.famly.co/original.jpg?signature=fresh",
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
  fs.mkdirSync(path.join(root, "metadata"), { recursive: true });
  fs.mkdirSync(path.join(root, "messages"), { recursive: true });
  fs.mkdirSync(path.join(root, "photos"), { recursive: true });
  fs.mkdirSync(path.join(root, "message-images"), { recursive: true });
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
  return { root, entries };
}

function requestRaw({ port, requestPath, method = "GET", headers = {}, body = "" }) {
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
    port: 0,
    ...options,
  });
  const address = await localServer.listen();
  return {
    ...fixture,
    localServer,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

test("server binds to loopback and serves only allowlisted viewer data", async (t) => {
  const fixture = await startFixtureServer();
  t.after(async () => {
    await fixture.localServer.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  assert.equal(fixture.localServer.address().address, "127.0.0.1");
  const index = await fetch(`${fixture.origin}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(index.headers.get("cross-origin-resource-policy"), "same-origin");

  const manifest = await fetch(`${fixture.origin}/metadata/media.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json; charset=utf-8");
  const media = await manifest.json();
  assert.equal(media.length, 2);

  const image = await fetch(`${fixture.origin}/photos/same.jpg`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(await image.text(), "home-original");

  for (const requestPath of [
    "/metadata/captured-export.json",
    "/metadata/media-checksums.sha256",
    "/photos/",
    "/.agents/skills/famly-export/SKILL.md",
    "/unknown",
  ]) {
    const response = await fetch(`${fixture.origin}${requestPath}`);
    assert.equal(response.status, 404, requestPath);
  }

  const traversal = await requestRaw({
    port: fixture.port,
    requestPath: "/photos/%2e%2e/metadata/captured-export.json",
  });
  assert.equal(traversal.status, 400);
  const directoryTraversal = await requestRaw({
    port: fixture.port,
    requestPath: "/photos/../metadata/posts.json",
  });
  assert.equal(directoryTraversal.status, 400);
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
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const endpoint = `${fixture.origin}/api/favorites-archives`;
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
    requestPath: "/api/favorites-archives",
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

test("ZIP contains exactly selected originals in one flat folder and is one-time", async (t) => {
  const fixture = await startFixtureServer();
  t.after(async () => {
    await fixture.localServer.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const creation = await fetch(
    `${fixture.origin}/api/favorites-archives`,
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
  assert.match(payload.filename, /^Famly-Favorites-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.equal(fixture.localServer.archiveCount(), 1);

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
  assert.match(
    download.headers.get("content-disposition"),
    /^attachment; filename="Famly-Favorites-\d{4}-\d{2}-\d{2}\.zip"$/,
  );
  const zipPath = path.join(fixture.root, "fixture.zip");
  fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));
  assert.equal(fixture.localServer.archiveCount(), 0);

  const members = execFileSync("/usr/bin/unzip", ["-Z1", zipPath], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((member) => member && !member.endsWith("/"));
  members.sort();
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

  const expectedChecksums = [
    "home-original",
    "message-original",
  ]
    .map((body) => crypto.createHash("sha256").update(body).digest("hex"))
    .sort();
  const archiveChecksums = archivedBodies
    .map((body) => crypto.createHash("sha256").update(body).digest("hex"))
    .sort();
  assert.deepEqual(archiveChecksums, expectedChecksums);

  const secondDownload = await fetch(
    `${fixture.origin}${payload.downloadUrl}`,
    { headers: { Referer: `${fixture.origin}/` } },
  );
  assert.equal(secondDownload.status, 404);
});

test("abandoned archives expire and are deleted", async (t) => {
  const fixture = await startFixtureServer({ archiveTtlMs: 25 });
  t.after(async () => {
    await fixture.localServer.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const creation = await fetch(
    `${fixture.origin}/api/favorites-archives`,
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
  assert.equal(fixture.localServer.archiveCount(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const expired = await fetch(`${fixture.origin}${payload.downloadUrl}`, {
    headers: { Referer: `${fixture.origin}/` },
  });
  assert.equal(expired.status, 404);
  assert.equal(fixture.localServer.archiveCount(), 0);
});
