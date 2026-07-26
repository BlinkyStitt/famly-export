#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  isAllowedMediaRecord,
  mediaIdentity,
} from "./viewer-app.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 4173;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_SELECTIONS = 5_000;
const DEFAULT_ARCHIVE_TTL_MS = 15 * 60 * 1_000;
const HOST = "127.0.0.1";

const MANIFEST_PATHS = new Map([
  ["/metadata/posts.json", "metadata/posts.json"],
  ["/metadata/conversations.json", "metadata/conversations.json"],
  ["/metadata/media.json", "metadata/media.json"],
  ["/metadata/export-summary.json", "metadata/export-summary.json"],
]);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
]);

function isSafeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return !segments.includes("..") && !segments.includes(".");
}

function isImageRecord(entry) {
  return (
    entry?.kind === "image" &&
    typeof entry?.expectedMime === "string" &&
    entry.expectedMime.startsWith("image/")
  );
}

function manifestState(root) {
  const manifestPath = path.join(root, "metadata", "media.json");
  let cached = null;
  return () => {
    const stat = fs.statSync(manifestPath);
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (cached?.signature === signature) {
      return cached;
    }
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("metadata/media.json must contain an array");
    }
    const byIdentity = new Map();
    const byPublicPath = new Map();
    for (const entry of parsed) {
      const identity = mediaIdentity(entry);
      if (
        !identity ||
        entry.identity !== identity ||
        !isSafeRelativePath(entry.relativePath) ||
        !isAllowedMediaRecord(entry) ||
        byIdentity.has(identity) ||
        byPublicPath.has(`/${entry.relativePath}`)
      ) {
        throw new Error("metadata/media.json contains an unsafe or duplicate record");
      }
      byIdentity.set(identity, entry);
      byPublicPath.set(`/${entry.relativePath}`, entry);
    }
    cached = { signature, byIdentity, byPublicPath };
    return cached;
  };
}

function pathInsideRoot(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error("Unsafe export path");
  }
  let realRoot;
  let realTarget;
  try {
    realRoot = fs.realpathSync(root);
    const target = path.join(realRoot, ...relativePath.split("/"));
    realTarget = fs.realpathSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(new Error("File not found"), { status: 404 });
    }
    throw error;
  }
  const relative = path.relative(realRoot, realTarget);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Export path escapes the selected root");
  }
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    throw new Error("Export path is not a regular file");
  }
  return { path: realTarget, stat };
}

function safeRequestPath(requestUrl) {
  const rawPath = String(requestUrl ?? "").split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  try {
    return new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function streamFile(request, response, target, contentType, extraHeaders = {}) {
  const { path: filePath, stat } = target;
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    ...extraHeaders,
  });
  if (request.method === "HEAD") {
    response.end();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    pipeline(fs.createReadStream(filePath), response, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Port must be an integer from 1 through 65535");
  }
  return port;
}

function requestOrigin(request, port) {
  return `http://${HOST}:${port}`;
}

function sameOriginPost(request, port) {
  return request.headers.origin === requestOrigin(request, port);
}

function sameOriginDownload(request, port) {
  const expected = requestOrigin(request, port);
  if (typeof request.headers.origin === "string") {
    return request.headers.origin === expected;
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return false;
  }
  if (typeof request.headers.referer === "string") {
    try {
      return new URL(request.headers.referer).origin === expected;
    } catch {
      return false;
    }
  }
  return request.headers["sec-fetch-site"] === "same-origin";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers["content-length"]);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_REQUEST_BYTES
    ) {
      reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
      request.resume();
      return;
    }
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (!tooLarge && bytes > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body is not valid JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function collisionSafeNames(entries) {
  const counts = new Map();
  const allocated = new Set();
  const collisionKey = (value) => value.normalize("NFC").toLocaleLowerCase("en-US");
  const result = new Map();
  for (const entry of entries) {
    const basename = path.basename(entry.relativePath);
    const extension = path.extname(basename);
    const stem = basename.slice(0, basename.length - extension.length);
    let ordinal = (counts.get(basename) ?? 0) + 1;
    let candidate = ordinal === 1 ? basename : `${stem} (${ordinal})${extension}`;
    while (allocated.has(collisionKey(candidate))) {
      ordinal += 1;
      candidate = `${stem} (${ordinal})${extension}`;
    }
    counts.set(basename, ordinal);
    allocated.add(collisionKey(candidate));
    result.set(entry.identity, candidate);
  }
  return result;
}

async function runDitto(sourceDirectory, zipPath) {
  await execFileAsync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--norsrc",
    "--keepParent",
    sourceDirectory,
    zipPath,
  ]);
}

async function createArchive({
  root,
  entries,
  createZip,
}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "famly-favorites-"),
  );
  const favoritesDirectory = path.join(temporaryRoot, "Famly Favorites");
  const zipPath = path.join(temporaryRoot, "favorites.zip");
  fs.mkdirSync(favoritesDirectory, { mode: 0o700 });
  try {
    const names = collisionSafeNames(entries);
    for (const entry of entries) {
      const source = pathInsideRoot(root, entry.relativePath);
      const destination = path.join(
        favoritesDirectory,
        names.get(entry.identity),
      );
      fs.linkSync(source.path, destination);
    }
    await createZip(favoritesDirectory, zipPath);
    fs.rmSync(favoritesDirectory, { recursive: true });
    return { temporaryRoot, zipPath };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function createExportServer({
  root,
  port = DEFAULT_PORT,
  archiveTtlMs = DEFAULT_ARCHIVE_TTL_MS,
  createZip = runDitto,
} = {}) {
  const resolvedRoot = fs.realpathSync(path.resolve(root ?? "."));
  const configuredPort = parsePort(port);
  const loadManifest = manifestState(resolvedRoot);
  const archives = new Map();
  let archiveCreating = false;
  let activePort = configuredPort;

  const deleteArchive = (token) => {
    const archive = archives.get(token);
    archives.delete(token);
    if (archive) {
      fs.rmSync(archive.temporaryRoot, { recursive: true, force: true });
    }
  };
  const expireArchives = () => {
    const now = Date.now();
    for (const [token, archive] of archives) {
      if (now - archive.createdAt >= archiveTtlMs) {
        deleteArchive(token);
      }
    }
  };
  const expiryTimer = setInterval(
    expireArchives,
    Math.min(60_000, Math.max(25, archiveTtlMs)),
  );
  expiryTimer.unref();

  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    expireArchives();
    const requestPath = safeRequestPath(request.url);
    if (!requestPath) {
      sendError(response, 400, "Unsafe request path");
      return;
    }
    if (request.method === "OPTIONS") {
      sendError(response, 405, "Cross-origin requests are not allowed");
      return;
    }

    try {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (requestPath === "/" ||
          requestPath === "/messages" ||
          requestPath === "/messages/" ||
          requestPath === "/messages/index.html")
      ) {
        await streamFile(
          request,
          response,
          pathInsideRoot(resolvedRoot, "messages/index.html"),
          MIME_TYPES.get(".html"),
        );
        return;
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        requestPath === "/messages/viewer-app.mjs"
      ) {
        await streamFile(
          request,
          response,
          pathInsideRoot(resolvedRoot, "messages/viewer-app.mjs"),
          MIME_TYPES.get(".mjs"),
        );
        return;
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        MANIFEST_PATHS.has(requestPath)
      ) {
        await streamFile(
          request,
          response,
          pathInsideRoot(resolvedRoot, MANIFEST_PATHS.get(requestPath)),
          MIME_TYPES.get(".json"),
        );
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const mediaEntry = loadManifest().byPublicPath.get(requestPath);
        if (mediaEntry) {
          await streamFile(
            request,
            response,
            pathInsideRoot(resolvedRoot, mediaEntry.relativePath),
            mediaEntry.expectedMime ||
              MIME_TYPES.get(path.extname(mediaEntry.relativePath).toLowerCase()) ||
              "application/octet-stream",
          );
          return;
        }
      }
      if (
        request.method === "POST" &&
        requestPath === "/api/favorites-archives"
      ) {
        if (!sameOriginPost(request, activePort)) {
          sendError(response, 403, "Archive requests must be same-origin");
          return;
        }
        if (
          !String(request.headers["content-type"] ?? "")
            .toLowerCase()
            .startsWith("application/json")
        ) {
          sendError(response, 415, "Archive requests must use application/json");
          return;
        }
        if (archiveCreating) {
          sendError(response, 409, "Another favorites archive is being created");
          return;
        }
        const body = await readJsonBody(request);
        if (
          !Array.isArray(body?.identities) ||
          body.identities.length === 0 ||
          body.identities.length > MAX_SELECTIONS ||
          body.identities.some(
            (identity) => typeof identity !== "string" || !identity,
          ) ||
          new Set(body.identities).size !== body.identities.length
        ) {
          sendError(
            response,
            400,
            `identities must contain 1 through ${MAX_SELECTIONS} unique strings`,
          );
          return;
        }
        const manifest = loadManifest();
        const entries = body.identities
          .map((identity) => manifest.byIdentity.get(identity))
          .filter(Boolean);
        if (
          entries.length !== body.identities.length ||
          entries.some((entry) => !isImageRecord(entry))
        ) {
          sendError(
            response,
            400,
            "Every selected identity must match a current image record",
          );
          return;
        }
        entries.sort((left, right) =>
          left.identity.localeCompare(right.identity),
        );
        archiveCreating = true;
        try {
          const archive = await createArchive({
            root: resolvedRoot,
            entries,
            createZip,
          });
          const token = crypto.randomBytes(24).toString("base64url");
          const date = new Date().toISOString().slice(0, 10);
          const filename = `Famly-Favorites-${date}.zip`;
          archives.set(token, {
            ...archive,
            createdAt: Date.now(),
            filename,
          });
          sendJson(response, 201, {
            downloadUrl: `/api/favorites-archives/${token}`,
            filename,
          });
        } finally {
          archiveCreating = false;
        }
        return;
      }
      const archiveMatch = requestPath.match(
        /^\/api\/favorites-archives\/([A-Za-z0-9_-]{32,})$/,
      );
      if (request.method === "GET" && archiveMatch) {
        if (!sameOriginDownload(request, activePort)) {
          sendError(response, 403, "Archive downloads must be same-origin");
          return;
        }
        const token = archiveMatch[1];
        const archive = archives.get(token);
        if (!archive) {
          sendError(response, 404, "Archive not found or already downloaded");
          return;
        }
        archives.delete(token);
        try {
          await streamFile(
            request,
            response,
            pathInsideRoot(archive.temporaryRoot, "favorites.zip"),
            MIME_TYPES.get(".zip"),
            {
              "Content-Disposition": `attachment; filename="${archive.filename}"`,
            },
          );
        } finally {
          fs.rmSync(archive.temporaryRoot, { recursive: true, force: true });
        }
        return;
      }
      sendError(response, 404, "Not found");
    } catch (error) {
      if (!response.headersSent) {
        sendError(
          response,
          Number(error?.status) || 500,
          Number(error?.status) ? error.message : "The local export server failed",
        );
      } else {
        response.destroy();
      }
    }
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, HOST, () => {
        server.off("error", reject);
        activePort = server.address().port;
        resolve({ host: HOST, port: activePort });
      });
    });
  const close = () =>
    new Promise((resolve, reject) => {
      clearInterval(expiryTimer);
      for (const token of [...archives.keys()]) {
        deleteArchive(token);
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return {
    server,
    listen,
    close,
    address: () => server.address(),
    archiveCount: () => archives.size,
  };
}

function usage() {
  console.error("Usage: serve-export.mjs <export-root> [port]");
}

async function main() {
  if (process.argv.length < 3 || process.argv.length > 4) {
    usage();
    process.exitCode = 2;
    return;
  }
  let localServer;
  try {
    localServer = createExportServer({
      root: process.argv[2],
      port: process.argv[3] ?? DEFAULT_PORT,
    });
    const address = await localServer.listen();
    process.stdout.write(
      `Famly export viewer: http://${address.host}:${address.port}/\n`,
    );
    process.stdout.write(
      "Private files are available only to this loopback server. Press Ctrl-C to stop.\n",
    );
    const shutdown = async () => {
      await localServer.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  void main();
}
