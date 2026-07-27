#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mediaIdentity } from "./viewer-app.mjs";
import { validateFamlyMediaUrl } from "./famly-url.mjs";
import {
  atomicWritePrivate,
  canonicalExportRoot,
  ensurePrivateDirectory,
  hardenPrivateTrees,
  inspectPrivatePath,
} from "./private-tree.mjs";

const LIST_PAGE_SIZE = 10;
const MESSAGE_PAGE_SIZE = 20;
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME_BY_EXTENSION = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["mp4", "video/mp4"],
  ["pdf", "application/pdf"],
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseUrl(value, context) {
  try {
    return new URL(value);
  } catch {
    fail(`${context} is not a valid URL`);
  }
}

function urlExtension(value) {
  const url = parseUrl(value, "Media URL");
  return extensionFromName(decodeURIComponent(url.pathname.split("/").at(-1) || ""));
}

function extensionFromName(value) {
  const clean = String(value ?? "").split("?")[0];
  const match = clean.match(/\.([A-Za-z0-9]{1,10})$/);
  return match ? match[1].toLowerCase() : "";
}

function isoDatePart(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  assert(match, `Expected an ISO date, received ${JSON.stringify(value)}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function safeId(value, context) {
  const result = String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "_");
  assert(result && result !== "." && result !== "..", `${context} has no safe identifier`);
  return result.slice(0, 180);
}

export function safeFilename(value, fallback = "attachment") {
  const basename = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const cleaned = String(basename ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  return [...safe].slice(0, 160).join("");
}

function assertSafeRelativePath(relativePath) {
  assert(typeof relativePath === "string" && relativePath, "Media path is empty");
  assert(!path.posix.isAbsolute(relativePath), `Media path is absolute: ${relativePath}`);
  assert(
    path.posix.normalize(relativePath) === relativePath &&
      !relativePath.split("/").includes(".."),
    `Media path escapes the export root: ${relativePath}`,
  );
}

export function isFamlyHostedUrl(value) {
  try {
    validateFamlyMediaUrl(value);
    return true;
  } catch {
    return false;
  }
}

function originalImageUrl(image) {
  if (
    typeof image?.prefix === "string" &&
    image.prefix &&
    typeof image?.key === "string" &&
    image.key &&
    Number.isFinite(Number(image.width)) &&
    Number.isFinite(Number(image.height))
  ) {
    return `${image.prefix}/${image.width}x${image.height}/${image.key}`;
  }
  for (const candidate of [
    image?.url_big,
    image?.big?.url,
    typeof image?.big === "string" ? image.big : null,
    image?.url,
  ]) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }
  return null;
}

function mediaFilename(rawName, sourceUrl, fallback) {
  let urlName = "";
  try {
    urlName = decodeURIComponent(new URL(sourceUrl).pathname.split("/").at(-1) || "");
  } catch {
    // The URL is validated separately and will produce the contextual error.
  }
  return safeFilename(rawName || urlName, fallback);
}

function expectedMime(filename, sourceUrl) {
  const extension = extensionFromName(filename) || urlExtension(sourceUrl);
  return {
    extension,
    mime: MIME_BY_EXTENSION.get(extension) ?? null,
  };
}

function addMediaEntry({
  media,
  mediaKeys,
  unsupported,
  mediaId,
  sourceType,
  ownerType,
  ownerId,
  conversationId = null,
  kind,
  sourceUrl,
  relativePath,
  filename,
}) {
  const descriptor = {
    mediaId: typeof mediaId === "string" ? mediaId : null,
    sourceType,
    ownerType,
    ownerId,
    conversationId,
    kind,
  };
  if (!descriptor.mediaId) {
    unsupported.push({ ...descriptor, reason: "missing-media-id" });
    return null;
  }
  if (typeof sourceUrl !== "string" || !isFamlyHostedUrl(sourceUrl)) {
    unsupported.push({ ...descriptor, reason: "not-famly-hosted" });
    return null;
  }
  const type = expectedMime(filename, sourceUrl);
  if (!type.mime) {
    unsupported.push({
      ...descriptor,
      filename,
      reason: `unsupported-extension:${type.extension || "none"}`,
    });
    return null;
  }
  assertSafeRelativePath(relativePath);
  const key = `${sourceType}:${kind}:${descriptor.mediaId}`;
  const entry = {
    ...descriptor,
    sourceUrl,
    relativePath,
    filename,
    expectedMime: type.mime,
  };
  entry.identity = mediaIdentity(entry);
  assert(entry.identity, `Media record has no stable identity: ${key}`);
  const existing = mediaKeys.get(key);
  if (existing) {
    assert(
      existing.sourceUrl === entry.sourceUrl &&
        existing.relativePath === entry.relativePath &&
        existing.ownerId === entry.ownerId,
      `Conflicting duplicate media ID: ${key}`,
    );
    return existing;
  }
  assert(
    !media.some((candidate) => candidate.relativePath === relativePath),
    `Two media records resolve to the same path: ${relativePath}`,
  );
  media.push(entry);
  mediaKeys.set(key, entry);
  return entry;
}

function relevantConversationListPages(capture, archived) {
  return asArray(capture.conversationListPages).filter((page) => {
    if (!Array.isArray(page?.data) || typeof page?.url !== "string") {
      return false;
    }
    const url = parseUrl(page.url, "Conversation-list response URL");
    return (
      url.pathname === "/api/v2/conversations" &&
      url.searchParams.get("inbox") === "OWN" &&
      url.searchParams.get("limit") === String(LIST_PAGE_SIZE) &&
      url.searchParams.get("archived") === String(archived)
    );
  });
}

function validateListCapture(capture, kind, archived) {
  const workflow = capture.workflow?.lists?.[kind];
  assert(workflow, `Missing ${kind} conversation-list workflow evidence`);
  assert(workflow.showMoreExhausted === true, `${kind} Show More was not exhausted`);
  assert(
    Number.isInteger(workflow.showMoreClicks) && workflow.showMoreClicks >= 0,
    `${kind} Show More click count is invalid`,
  );
  const pages = relevantConversationListPages(capture, archived);
  assert(pages.length > 0, `No ${kind} conversation-list response pages were captured`);
  const conversations = pages.flatMap((page) => page.data);
  const ids = uniqueStrings(conversations.map((conversation) => conversation?.conversationId));
  const offsets = pages.map((page) =>
    Number(parseUrl(page.url, "Conversation-list response URL").searchParams.get("offset")),
  );
  assert(offsets.every(Number.isInteger), `${kind} conversation offsets are invalid`);
  const expectedOffsets = pages.map((_, index) => index * LIST_PAGE_SIZE);
  assert(
    offsets.every((offset, index) => offset === expectedOffsets[index]),
    `${kind} conversation offsets are incomplete or out of order`,
  );
  assert(
    workflow.showMoreClicks === pages.length - 1,
    `${kind} Show More clicks do not match captured pagination`,
  );
  const finalPage = pages.at(-1).data;
  assert(
    finalPage.length < LIST_PAGE_SIZE,
    `${kind} conversation capture did not reach a terminal short page`,
  );
  const workflowIds = uniqueStrings(asArray(workflow.conversationIds));
  assert(
    sameStringSet(ids, workflowIds),
    `${kind} API conversation IDs do not match the complete rendered list`,
  );
  return {
    conversations,
    ids,
    pages: pages.length,
    showMoreClicks: workflow.showMoreClicks,
  };
}

function reactionMap(capture) {
  const result = new Map();
  for (const page of asArray(capture.reactionPages)) {
    const values = page?.data?.data?.conversations?.messageReactions;
    if (!Array.isArray(values)) {
      continue;
    }
    for (const reaction of values) {
      if (typeof reaction?.messageId === "string" && reaction.messageId) {
        result.set(reaction.messageId, reaction);
      }
    }
  }
  return result;
}

function messagePagesByConversation(capture) {
  const result = new Map();
  for (const page of asArray(capture.conversationPages)) {
    const conversationId = page?.data?.conversationId;
    if (
      typeof conversationId !== "string" ||
      !conversationId ||
      !Array.isArray(page?.data?.messages)
    ) {
      continue;
    }
    const current = result.get(conversationId) ?? [];
    current.push(page);
    result.set(conversationId, current);
  }
  return result;
}

function createHomeMedia(posts, media, mediaKeys, unsupported) {
  for (const post of posts) {
    const postId = post.feedItemId;
    assert(typeof postId === "string" && postId, "A Home post is missing feedItemId");
    const date = isoDatePart(post.createdDate);
    const year = date.slice(0, 4);
    for (const image of asArray(post.images)) {
      const sourceUrl = originalImageUrl(image);
      const extension =
        extensionFromName(image?.key) ||
        extensionFromName(image?.url_big) ||
        extensionFromName(image?.url) ||
        "jpg";
      const filename = `${date}_${safeId(postId, "Post ID")}_${safeId(image?.imageId, "Image ID")}.${extension}`;
      addMediaEntry({
        media,
        mediaKeys,
        unsupported,
        mediaId: image?.imageId,
        sourceType: "home",
        ownerType: "post",
        ownerId: postId,
        kind: "image",
        sourceUrl,
        relativePath: `photos/${filename}`,
        filename,
      });
    }
    for (const comment of asArray(post.comments)) {
      const commentId = comment?.commentId;
      for (const image of asArray(comment?.images)) {
        const sourceUrl = originalImageUrl(image);
        const extension =
          extensionFromName(image?.key) ||
          extensionFromName(image?.url_big) ||
          extensionFromName(image?.url) ||
          "jpg";
        const commentDate = isoDatePart(comment?.createdDate);
        const filename = `${commentDate}_${safeId(commentId, "Comment ID")}_${safeId(image?.imageId, "Image ID")}.${extension}`;
        addMediaEntry({
          media,
          mediaKeys,
          unsupported,
          mediaId: image?.imageId,
          sourceType: "home",
          ownerType: "comment",
          ownerId: commentId,
          kind: "image",
          sourceUrl,
          relativePath: `photos/${filename}`,
          filename,
        });
      }
    }
    for (const video of asArray(post.videos)) {
      const mediaId = video?.videoId || video?.persistenceId;
      const sourceUrl = video?.videoUrl;
      const sourceName = mediaFilename(null, sourceUrl, `${mediaId || "video"}.mp4`);
      const extension = extensionFromName(sourceName) || "mp4";
      const filename = `${date}_${safeId(postId, "Post ID")}_${safeId(mediaId, "Video ID")}.${extension}`;
      addMediaEntry({
        media,
        mediaKeys,
        unsupported,
        mediaId,
        sourceType: "home",
        ownerType: "post",
        ownerId: postId,
        kind: "video",
        sourceUrl,
        relativePath: `videos/${year}/${filename}`,
        filename: sourceName,
      });
    }
    for (const file of asArray(post.files)) {
      const mediaId = file?.fileId;
      const sourceUrl = file?.url;
      const sourceName = mediaFilename(file?.filename, sourceUrl, mediaId || "file");
      const filename = `${date}_${safeId(postId, "Post ID")}_${safeId(mediaId, "File ID")}_${sourceName}`;
      addMediaEntry({
        media,
        mediaKeys,
        unsupported,
        mediaId,
        sourceType: "home",
        ownerType: "post",
        ownerId: postId,
        kind: "file",
        sourceUrl,
        relativePath: `files/${year}/${filename}`,
        filename: sourceName,
      });
    }
  }
}

function messageAttachmentMedia({
  conversationId,
  message,
  media,
  mediaKeys,
  unsupported,
}) {
  const refs = [];
  const safeConversationId = safeId(conversationId, "Conversation ID");
  const messageId = message.messageId;
  const date = isoDatePart(message.createdAt);
  for (const image of asArray(message.images)) {
    const mediaId = image?.imageId;
    const sourceUrl = originalImageUrl(image);
    const sourceName = mediaFilename(
      image?.filename || image?.key,
      sourceUrl,
      `${mediaId || "image"}.jpg`,
    );
    const extension =
      extensionFromName(sourceName) || extensionFromName(sourceUrl) || "jpg";
    const filename = `${date}_${safeId(messageId, "Message ID")}_${safeId(mediaId, "Image ID")}.${extension}`;
    const entry = addMediaEntry({
      media,
      mediaKeys,
      unsupported,
      mediaId,
      sourceType: "message",
      ownerType: "message",
      ownerId: messageId,
      conversationId,
      kind: "image",
      sourceUrl,
      relativePath: `message-images/${filename}`,
      filename: sourceName,
    });
    if (entry) {
      refs.push({
        mediaId: entry.mediaId,
        kind: entry.kind,
        filename: entry.filename,
        expectedMime: entry.expectedMime,
        localPath: entry.relativePath,
      });
    }
  }
  for (const file of asArray(message.files)) {
    const mediaId = file?.fileId;
    const sourceUrl = file?.url;
    const sourceName = mediaFilename(file?.filename, sourceUrl, mediaId || "file");
    const filename = `${date}_${safeId(messageId, "Message ID")}_${safeId(mediaId, "File ID")}_${sourceName}`;
    const entry = addMediaEntry({
      media,
      mediaKeys,
      unsupported,
      mediaId,
      sourceType: "message",
      ownerType: "message",
      ownerId: messageId,
      conversationId,
      kind: "file",
      sourceUrl,
      relativePath: `messages/attachments/${safeConversationId}/${filename}`,
      filename: sourceName,
    });
    if (entry) {
      refs.push({
        mediaId: entry.mediaId,
        kind: entry.kind,
        filename: entry.filename,
        expectedMime: entry.expectedMime,
        localPath: entry.relativePath,
      });
    }
  }
  return refs;
}

export function transformCapture(capture) {
  assert(capture && typeof capture === "object", "Capture root must be an object");
  assert(capture.schemaVersion === 2, "Capture schemaVersion must be exactly 2");
  assert(asArray(capture.feedPages).length > 0, "No Home feed response pages were captured");
  assert(capture.workflow?.home?.stableBottomChecks >= 8, "Home feed did not reach a stable bottom");

  const postsById = new Map();
  for (const page of capture.feedPages) {
    assert(
      Array.isArray(page?.data?.feedItems),
      "A Home feed response does not contain feedItems",
    );
    for (const post of page.data.feedItems) {
      if (typeof post?.feedItemId === "string" && post.feedItemId) {
        postsById.set(post.feedItemId, post);
      }
    }
  }
  const posts = [...postsById.values()].sort(
    (left, right) =>
      String(right.createdDate).localeCompare(String(left.createdDate)) ||
      String(left.feedItemId).localeCompare(String(right.feedItemId)),
  );
  assert(posts.length > 0, "The capture contains no Home posts");
  const domPostIds = uniqueStrings(asArray(capture.workflow.home.domPostIds));
  assert(
    sameStringSet([...postsById.keys()], domPostIds),
    "Home API post IDs do not match the complete rendered feed",
  );

  const active = validateListCapture(capture, "active", false);
  const archived = validateListCapture(capture, "archived", true);
  assert(
    active.ids.every((id) => !archived.ids.includes(id)),
    "A conversation appears in both active and archived lists",
  );
  const expectedConversationIds = [...active.ids, ...archived.ids];
  const capturedInitialUnread = capture.workflow?.initialUnreadCount;
  assert(
    Number.isInteger(capturedInitialUnread) && capturedInitialUnread >= 0,
    "Initial unread conversation count was not recorded before opening conversations",
  );
  const listInitialUnread = [...active.conversations, ...archived.conversations]
    .filter((conversation) => conversation?.unread)
    .map((conversation) => conversation.conversationId);
  assert(
    new Set(listInitialUnread).size === capturedInitialUnread,
    "Recorded initial unread count does not match the captured conversation lists",
  );
  const messagePages = messagePagesByConversation(capture);
  assert(
    sameStringSet([...messagePages.keys()], expectedConversationIds),
    "Captured conversation details do not equal the active-plus-archived list",
  );

  const listRecords = new Map();
  for (const conversation of [...active.conversations, ...archived.conversations]) {
    if (typeof conversation?.conversationId === "string") {
      listRecords.set(conversation.conversationId, conversation);
    }
  }
  const reactions = reactionMap(capture);
  const media = [];
  const mediaKeys = new Map();
  const unsupported = [];
  createHomeMedia(posts, media, mediaKeys, unsupported);

  const conversations = [];
  for (const conversationId of expectedConversationIds) {
    const pages = messagePages.get(conversationId);
    const run = capture.workflow?.conversations?.[conversationId];
    assert(run, `Missing browser workflow evidence for conversation ${conversationId}`);
    assert(
      run.terminalShortPage === true,
      `Conversation ${conversationId} did not record a terminal short message page`,
    );
    assert(
      pages.at(-1).data.messages.length < MESSAGE_PAGE_SIZE,
      `Conversation ${conversationId} ended on a full ${MESSAGE_PAGE_SIZE}-message page`,
    );
    assert(
      Number.isInteger(run.reverseScrolls) && run.reverseScrolls >= 0,
      `Conversation ${conversationId} has invalid reverse-scroll evidence`,
    );
    assert(
      run.messagePages === pages.length &&
        run.terminalPageSize === pages.at(-1).data.messages.length,
      `Conversation ${conversationId} workflow evidence does not match captured pages`,
    );
    const messagesById = new Map();
    for (const page of pages) {
      for (const message of page.data.messages) {
        if (typeof message?.messageId === "string" && message.messageId) {
          messagesById.set(message.messageId, message);
        }
      }
    }
    const chronologicalMessages = [...messagesById.values()].sort(
      (left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        String(left.messageId).localeCompare(String(right.messageId)),
    );
    const normalizedMessages = chronologicalMessages.map((message) => {
      const reactionSummary = reactions.get(message.messageId);
      assert(
        reactionSummary,
        `Missing MessageReactions evidence for message ${message.messageId}`,
      );
      const localAttachments = messageAttachmentMedia({
        conversationId,
        message,
        media,
        mediaKeys,
        unsupported,
      });
      return {
        ...message,
        reactionSummary,
        localAttachments,
      };
    });
    const listRecord = listRecords.get(conversationId) ?? {};
    const detail = pages[0].data;
    conversations.push({
      ...listRecord,
      ...detail,
      conversationId,
      listKind: archived.ids.includes(conversationId) ? "archived" : "active",
      initialUnread: Boolean(listRecord.unread),
      messages: normalizedMessages,
      capture: {
        responsePages: pages.length,
        reverseScrolls: run.reverseScrolls,
        terminalShortPage: true,
      },
    });
  }
  conversations.sort(
    (left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt)) ||
      String(left.conversationId).localeCompare(String(right.conversationId)),
  );
  media.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const allMessages = conversations.flatMap((conversation) => conversation.messages);
  const allMessageIds = new Set(allMessages.map((message) => message.messageId));
  assert(
    [...reactions.keys()].every((messageId) => allMessageIds.has(messageId)),
    "MessageReactions capture contains an unknown message ID",
  );
  const dates = posts.map((post) => post.createdDate).filter(Boolean);
  const messageDates = allMessages.map((message) => message.createdAt).filter(Boolean);
  const summary = {
    schemaVersion: 2,
    capturedAt: capture.capturedAt ?? null,
    captureStartedAt: capture.captureStartedAt ?? null,
    pageUrl: capture.pageUrl ?? null,
    blockedKillswitchRequests:
      Number.isInteger(capture.blockedKillswitchRequests) &&
      capture.blockedKillswitchRequests >= 0
        ? capture.blockedKillswitchRequests
        : null,
    home: {
      feedPages: capture.feedPages.length,
      posts: posts.length,
      oldestPost: dates.length ? [...dates].sort().at(0) : null,
      newestPost: dates.length ? [...dates].sort().at(-1) : null,
      postsWithImages: posts.filter((post) => asArray(post.images).length > 0).length,
      imageReferences: posts.reduce((total, post) => total + asArray(post.images).length, 0),
      commentImageReferences: posts.reduce(
        (total, post) =>
          total +
          asArray(post.comments).reduce(
            (commentTotal, comment) =>
              commentTotal + asArray(comment?.images).length,
            0,
          ),
        0,
      ),
      videoReferences: posts.reduce((total, post) => total + asArray(post.videos).length, 0),
      fileReferences: posts.reduce((total, post) => total + asArray(post.files).length, 0),
    },
    messages: {
      activeConversations: active.ids.length,
      archivedConversations: archived.ids.length,
      conversations: conversations.length,
      initialUnreadConversations: capturedInitialUnread,
      listPages: {
        active: active.pages,
        archived: archived.pages,
      },
      showMoreClicks: {
        active: active.showMoreClicks,
        archived: archived.showMoreClicks,
      },
      messages: allMessages.length,
      reactionEvidenceMessages: reactions.size,
      oldestMessage: messageDates.length ? [...messageDates].sort().at(0) : null,
      newestMessage: messageDates.length ? [...messageDates].sort().at(-1) : null,
      messagesWithReactions: allMessages.filter(
        (message) => Number(message.reactionSummary?.count || 0) > 0,
      ).length,
      reactions: allMessages.reduce(
        (total, message) => total + Number(message.reactionSummary?.count || 0),
        0,
      ),
    },
    media: {
      total: media.length,
      homeImages: media.filter(
        (entry) => entry.sourceType === "home" && entry.kind === "image",
      ).length,
      homePostImages: media.filter(
        (entry) =>
          entry.sourceType === "home" &&
          entry.ownerType === "post" &&
          entry.kind === "image",
      ).length,
      homeCommentImages: media.filter(
        (entry) =>
          entry.sourceType === "home" &&
          entry.ownerType === "comment" &&
          entry.kind === "image",
      ).length,
      homeVideos: media.filter(
        (entry) => entry.sourceType === "home" && entry.kind === "video",
      ).length,
      homeFiles: media.filter(
        (entry) => entry.sourceType === "home" && entry.kind === "file",
      ).length,
      messageImages: media.filter(
        (entry) => entry.sourceType === "message" && entry.kind === "image",
      ).length,
      messageFiles: media.filter(
        (entry) => entry.sourceType === "message" && entry.kind !== "image",
      ).length,
      unsupported: unsupported.length,
      unsupportedItems: unsupported,
    },
    validation: {
      captureCompleteness: "passed",
      downloadedMedia: 0,
      partialDownloads: 0,
      mimeValidation: "not-run",
      imageDecoderValidation: "not-run",
      signatureValidation:
        "not-run (MP4 and PDF validation is signature-level only)",
      checksums: "not-run",
    },
  };
  return {
    posts,
    conversations,
    media,
    summary,
    html: {
      index: fs.readFileSync(
        path.join(SCRIPT_ROOT, "viewer-shell.html"),
        "utf8",
      ),
      app: fs.readFileSync(
        path.join(SCRIPT_ROOT, "viewer-app.mjs"),
        "utf8",
      ),
    },
  };
}

function writeAtomically(outputRoot, filePath, contents) {
  atomicWritePrivate(outputRoot, filePath, contents);
}

function writeJson(outputRoot, filePath, value) {
  writeAtomically(
    outputRoot,
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function credentialMarkerFiles(outputRoot) {
  const markers = /x-famly-accesstoken|famly\.session-marker/i;
  const roots = [path.join(outputRoot, "metadata"), path.join(outputRoot, "messages")];
  const matches = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "attachments") {
            pending.push(target);
          }
        } else if (/\.(?:json|html|mjs|sha256)$/i.test(entry.name)) {
          if (markers.test(fs.readFileSync(target, "utf8"))) {
            matches.push(target);
          }
        }
      }
    }
  }
  return matches;
}

export function buildExport(capturePath, outputRoot) {
  const canonicalRoot = canonicalExportRoot(outputRoot);
  hardenPrivateTrees(canonicalRoot);
  const inspectedCapture = inspectPrivatePath(
    canonicalRoot,
    path.resolve(capturePath),
    { expectedType: "file" },
  );
  const capture = JSON.parse(fs.readFileSync(inspectedCapture.path, "utf8"));
  const result = transformCapture(capture);
  const metadataRoot = ensurePrivateDirectory(
    canonicalRoot,
    path.join(canonicalRoot, "metadata"),
  );
  const messagesRoot = ensurePrivateDirectory(
    canonicalRoot,
    path.join(canonicalRoot, "messages"),
  );
  writeJson(canonicalRoot, path.join(metadataRoot, "posts.json"), result.posts);
  writeJson(
    canonicalRoot,
    path.join(metadataRoot, "conversations.json"),
    result.conversations,
  );
  writeJson(canonicalRoot, path.join(metadataRoot, "media.json"), result.media);
  writeJson(
    canonicalRoot,
    path.join(metadataRoot, "export-summary.json"),
    result.summary,
  );
  writeAtomically(
    canonicalRoot,
    path.join(messagesRoot, "index.html"),
    result.html.index,
  );
  writeAtomically(
    canonicalRoot,
    path.join(messagesRoot, "viewer-app.mjs"),
    result.html.app,
  );
  for (const entry of fs.readdirSync(messagesRoot, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name !== "index.html" &&
      entry.name.endsWith(".html")
    ) {
      const obsoletePath = path.join(messagesRoot, entry.name);
      inspectPrivatePath(canonicalRoot, obsoletePath, { expectedType: "file" });
      fs.unlinkSync(obsoletePath);
    }
  }
  hardenPrivateTrees(canonicalRoot);
  const markerFiles = credentialMarkerFiles(canonicalRoot);
  assert(
    markerFiles.length === 0,
    `Credential marker found in generated artifact(s): ${markerFiles.join(", ")}`,
  );
  return result.summary;
}

function usage() {
  console.error("Usage: build-export.mjs <captured-export.json> <output-root>");
}

function main() {
  if (process.argv.length !== 4) {
    usage();
    process.exitCode = 2;
    return;
  }
  try {
    const capturePath = path.resolve(process.argv[2]);
    const outputRoot = path.resolve(process.argv[3]);
    const summary = buildExport(capturePath, outputRoot);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
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
