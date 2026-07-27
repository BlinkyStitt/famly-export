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
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  canonicalExportRoot,
  hardenPrivateTrees,
  inspectPrivatePath,
  removeOwnedPrivateTree,
} from "./private-tree.mjs";
import {
  isAllowedMediaRecord,
  mediaIdentity,
} from "./viewer-app.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 4173;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_SELECTIONS = 5_000;
const DEFAULT_ARCHIVE_TTL_MS = 15 * 60 * 1_000;
const STALE_ARCHIVE_AGE_MS = 60 * 60 * 1_000;
const HOST = "127.0.0.1";
const ARCHIVE_PREFIX = "famly-favorites-";

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

function pathInsideRoot(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error("Unsafe export path");
  }
  try {
    return inspectPrivatePath(
      root,
      path.join(root, ...relativePath.split("/")),
      { expectedType: "file" },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw Object.assign(new Error("File not found"), { status: 404 });
    }
    throw error;
  }
}

function manifestState(root) {
  const manifestPath = path.join(root, "metadata", "media.json");
  let cached = null;
  return () => {
    const inspected = inspectPrivatePath(root, manifestPath, {
      expectedType: "file",
    });
    const signature = `${inspected.stat.mtimeMs}:${inspected.stat.size}`;
    if (cached?.signature === signature) {
      return cached;
    }
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("metadata/media.json must contain an array");
    }
    const byIdentity = new Map();
    const byPrivatePath = new Map();
    const publicMedia = [];
    for (const entry of parsed) {
      const identity = mediaIdentity(entry);
      if (
        !identity ||
        entry.identity !== identity ||
        !isSafeRelativePath(entry.relativePath) ||
        !isAllowedMediaRecord(entry) ||
        byIdentity.has(identity) ||
        byPrivatePath.has(`/${entry.relativePath}`)
      ) {
        throw new Error("metadata/media.json contains an unsafe or duplicate record");
      }
      byIdentity.set(identity, entry);
      byPrivatePath.set(`/${entry.relativePath}`, entry);
      const projection = { ...entry };
      delete projection.sourceUrl;
      publicMedia.push(projection);
    }
    cached = { signature, byIdentity, byPrivatePath, publicMedia };
    return cached;
  };
}

function safeRequestPath(requestUrl) {
  if (
    typeof requestUrl !== "string" ||
    !requestUrl.startsWith("/") ||
    requestUrl.startsWith("//")
  ) {
    return null;
  }
  const rawPath = requestUrl.split("?")[0];
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
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()",
  );
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, value, headOnly = false) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(headOnly ? undefined : body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function parseSingleByteRange(rangeHeader, size) {
  if (typeof rangeHeader !== "string") {
    return null;
  }
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return false;
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return false;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      return false;
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function streamFile(
  request,
  response,
  target,
  contentType,
  extraHeaders = {},
  { allowRanges = false } = {},
) {
  const { path: filePath, stat } = target;
  const responseHeaders = {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    ...extraHeaders,
  };
  let statusCode = 200;
  let streamOptions = undefined;
  if (allowRanges) {
    responseHeaders["Accept-Ranges"] = "bytes";
    const range = parseSingleByteRange(request.headers.range, stat.size);
    if (range === false) {
      response.writeHead(416, {
        ...responseHeaders,
        "Content-Length": 0,
        "Content-Range": `bytes */${stat.size}`,
      });
      response.end();
      return Promise.resolve();
    }
    if (range) {
      statusCode = 206;
      streamOptions = range;
      responseHeaders["Content-Length"] = range.end - range.start + 1;
      responseHeaders["Content-Range"] =
        `bytes ${range.start}-${range.end}/${stat.size}`;
    }
  }
  response.writeHead(statusCode, responseHeaders);
  if (request.method === "HEAD") {
    response.end();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    pipeline(fs.createReadStream(filePath, streamOptions), response, (error) => {
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
    throw new Error("Port must be an integer from 0 through 65535");
  }
  return port;
}

function requestOrigin(port) {
  return `http://${HOST}:${port}`;
}

function sameOriginPost(request, port) {
  return request.headers.origin === requestOrigin(port);
}

function sameOriginDownload(request, port) {
  const expected = requestOrigin(port);
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
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
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

export function sweepStaleArchiveDirectories({
  temporaryRoot = os.tmpdir(),
  now = Date.now(),
  staleAgeMs = STALE_ARCHIVE_AGE_MS,
} = {}) {
  const root = fs.realpathSync(path.resolve(temporaryRoot));
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith(ARCHIVE_PREFIX)) {
      continue;
    }
    const target = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      now - stat.mtimeMs < staleAgeMs
    ) {
      continue;
    }
    removeOwnedPrivateTree(target);
    removed += 1;
  }
  return removed;
}

async function createArchive({ root, entries, createZip, temporaryRoot }) {
  const archiveRoot = fs.mkdtempSync(
    path.join(temporaryRoot, ARCHIVE_PREFIX),
  );
  fs.chmodSync(archiveRoot, PRIVATE_DIRECTORY_MODE);
  const favoritesDirectory = path.join(archiveRoot, "Famly Favorites");
  const zipPath = path.join(archiveRoot, "favorites.zip");
  fs.mkdirSync(favoritesDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  try {
    const names = collisionSafeNames(entries);
    for (const entry of entries) {
      const source = pathInsideRoot(root, entry.relativePath);
      const destination = path.join(
        favoritesDirectory,
        names.get(entry.identity),
      );
      fs.linkSync(source.path, destination);
      fs.chmodSync(destination, PRIVATE_FILE_MODE);
    }
    await createZip(favoritesDirectory, zipPath);
    inspectPrivatePath(archiveRoot, zipPath, { expectedType: "file" });
    fs.chmodSync(zipPath, PRIVATE_FILE_MODE);
    fs.rmSync(favoritesDirectory, { recursive: true });
    return { temporaryRoot: archiveRoot, zipPath };
  } catch (error) {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    throw error;
  }
}

export function createExportServer({
  root,
  port = DEFAULT_PORT,
  archiveTtlMs = DEFAULT_ARCHIVE_TTL_MS,
  createZip = runDitto,
  temporaryRoot = os.tmpdir(),
} = {}) {
  const resolvedRoot = canonicalExportRoot(root ?? ".");
  hardenPrivateTrees(resolvedRoot);
  const resolvedTemporaryRoot = fs.realpathSync(path.resolve(temporaryRoot));
  sweepStaleArchiveDirectories({ temporaryRoot: resolvedTemporaryRoot });
  const configuredPort = parsePort(port);
  const loadManifest = manifestState(resolvedRoot);
  loadManifest();
  const accessToken = crypto.randomBytes(32).toString("base64url");
  const privatePrefix = `/_private/${accessToken}`;
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

    if (request.headers.host !== `${HOST}:${activePort}`) {
      sendError(response, 400, "Invalid Host header");
      return;
    }
    const requestPath = safeRequestPath(request.url);
    if (!requestPath) {
      sendError(response, 400, "Unsafe request target");
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

      if (!requestPath.startsWith(`${privatePrefix}/`)) {
        sendError(response, 404, "Not found");
        return;
      }
      const privatePath = requestPath.slice(privatePrefix.length);

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        MANIFEST_PATHS.has(privatePath)
      ) {
        if (privatePath === "/metadata/media.json") {
          sendJson(
            response,
            200,
            loadManifest().publicMedia,
            request.method === "HEAD",
          );
        } else {
          await streamFile(
            request,
            response,
            pathInsideRoot(resolvedRoot, MANIFEST_PATHS.get(privatePath)),
            MIME_TYPES.get(".json"),
          );
        }
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const mediaEntry = loadManifest().byPrivatePath.get(privatePath);
        if (mediaEntry) {
          await streamFile(
            request,
            response,
            pathInsideRoot(resolvedRoot, mediaEntry.relativePath),
            mediaEntry.expectedMime ||
              MIME_TYPES.get(path.extname(mediaEntry.relativePath).toLowerCase()) ||
              "application/octet-stream",
            {},
            { allowRanges: mediaEntry.kind === "video" },
          );
          return;
        }
      }
      if (
        request.method === "POST" &&
        privatePath === "/api/favorites-archives"
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
            temporaryRoot: resolvedTemporaryRoot,
          });
          const archiveToken = crypto.randomBytes(24).toString("base64url");
          const date = new Date().toISOString().slice(0, 10);
          const filename = `Famly-Favorites-${date}.zip`;
          archives.set(archiveToken, {
            ...archive,
            createdAt: Date.now(),
            filename,
          });
          sendJson(response, 201, {
            downloadUrl: `${privatePrefix}/api/favorites-archives/${archiveToken}`,
            filename,
          });
        } finally {
          archiveCreating = false;
        }
        return;
      }
      const archiveMatch = privatePath.match(
        /^\/api\/favorites-archives\/([A-Za-z0-9_-]{32})$/,
      );
      if (request.method === "GET" && archiveMatch) {
        if (!sameOriginDownload(request, activePort)) {
          sendError(response, 403, "Archive downloads must be same-origin");
          return;
        }
        const archiveToken = archiveMatch[1];
        const archive = archives.get(archiveToken);
        if (!archive) {
          sendError(response, 404, "Archive not found or already downloaded");
          return;
        }
        archives.delete(archiveToken);
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
    accessToken: () => accessToken,
    privatePrefix: () => privatePrefix,
    launchUrl: () =>
      `http://${HOST}:${activePort}/#access=${accessToken}`,
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
    await localServer.listen();
    process.stdout.write(`Famly export viewer: ${localServer.launchUrl()}\n`);
    process.stdout.write(
      "Private files require this launch token. Press Ctrl-C to stop.\n",
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
