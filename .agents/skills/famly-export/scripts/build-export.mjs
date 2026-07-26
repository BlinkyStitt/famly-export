#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LIST_PAGE_SIZE = 10;
const MESSAGE_PAGE_SIZE = 20;

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
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === "famly.co" ||
    host.endsWith(".famly.co") ||
    (/^famly[-.][a-z0-9.-]*\.amazonaws\.com$/.test(host) &&
      !host.includes("killswitch"))
  );
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

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function linkifyText(value) {
  const text = String(value ?? "");
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(cursor, match.index));
    let urlText = match[0];
    let trailing = "";
    while (/[),.;!?]$/.test(urlText)) {
      trailing = urlText.at(-1) + trailing;
      urlText = urlText.slice(0, -1);
    }
    let safeHref = null;
    try {
      const url = new URL(urlText);
      if (url.protocol === "http:" || url.protocol === "https:") {
        safeHref = url.href;
      }
    } catch {
      // Invalid text remains escaped text.
    }
    result += safeHref
      ? `<a href="${escapeHtml(safeHref)}" rel="noreferrer">${escapeHtml(urlText)}</a>`
      : escapeHtml(urlText);
    result += escapeHtml(trailing);
    cursor = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(cursor));
}

function conversationTitle(conversation) {
  if (typeof conversation.title === "string" && conversation.title.trim()) {
    return conversation.title.trim();
  }
  const participantNames = asArray(conversation.participants)
    .map((participant) => participant?.title)
    .filter((title) => typeof title === "string" && title.trim());
  return participantNames.join(", ") || `Conversation ${conversation.conversationId}`;
}

const VIEWER_STYLE = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0 auto; max-width: 920px; padding: 1.25rem; line-height: 1.45; }
a { color: #0072b2; overflow-wrap: anywhere; }
nav { margin-bottom: 1.5rem; }
.meta { opacity: .75; font-size: .9rem; }
.conversation-list { padding: 0; list-style: none; }
.conversation-list li { border-bottom: 1px solid #8885; padding: .8rem 0; }
.conversation { border-top: 2px solid #8888; margin-top: 3rem; padding-top: 1rem; }
.message { border: 1px solid #8885; border-radius: .6rem; margin: .8rem 0; padding: .9rem; }
.message header { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: space-between; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; }
.attachments { padding-left: 1.25rem; }
`.trim();

function htmlDocument(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${VIEWER_STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function attachmentHtml(attachment) {
  const href = path.posix.relative("messages", attachment.localPath);
  const label = escapeHtml(attachment.filename);
  return `<li><a href="${escapeHtml(href)}">${label}</a></li>`;
}

function messageHtml(message) {
  const author = message.author?.title || "Unknown author";
  const body =
    typeof message.body === "string"
      ? message.body
      : message.body == null
        ? ""
        : JSON.stringify(message.body);
  const attachments = asArray(message.localAttachments);
  const reactionCount = Number(message.reactionSummary?.count || 0);
  return `<article class="message" id="message-${escapeHtml(message.messageId)}">
  <header><strong>${escapeHtml(author)}</strong><time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(message.createdAt)}</time></header>
  <div class="body">${linkifyText(body)}</div>
  ${reactionCount > 0 ? `<div class="meta">Reactions: ${reactionCount}</div>` : ""}
  ${attachments.length > 0 ? `<ul class="attachments">${attachments.map(attachmentHtml).join("")}</ul>` : ""}
</article>`;
}

function conversationSectionHtml(conversation) {
  const safeConversationId = safeId(
    conversation.conversationId,
    "Conversation ID",
  );
  const title = conversationTitle(conversation);
  const participants = asArray(conversation.participants)
    .map((participant) => participant?.title)
    .filter(Boolean)
    .join(", ");
  const messages = conversation.messages.map(messageHtml).join("\n");
  return `<section class="conversation" id="conversation-${escapeHtml(safeConversationId)}">
<h2>${escapeHtml(title)}</h2>
<p class="meta">Participants: ${escapeHtml(participants || "Not recorded")} · ${conversation.messages.length} messages · Initially unread: ${conversation.initialUnread ? "yes" : "no"}</p>
${messages || "<p>No messages.</p>"}
</section>`;
}

function indexViewer(conversations, summary) {
  const items = conversations
    .map((conversation) => {
      const title = conversationTitle(conversation);
      const safeConversationId = safeId(
        conversation.conversationId,
        "Conversation ID",
      );
      return `<li><a href="#conversation-${escapeHtml(safeConversationId)}">${escapeHtml(title)}</a><div class="meta">${conversation.messages.length} messages · ${conversation.listKind}${conversation.initialUnread ? " · initially unread" : ""}</div></li>`;
    })
    .join("\n");
  const sections = conversations.map(conversationSectionHtml).join("\n");
  return htmlDocument(
    "Famly Messages export",
    `<h1>Famly Messages export</h1>
<p class="meta">Captured ${escapeHtml(summary.capturedAt)} · ${conversations.length} conversations · ${summary.messages.messages} messages</p>
<nav aria-label="Conversations"><ul class="conversation-list">${items}</ul></nav>
<main>${sections}</main>`,
  );
}

export function transformCapture(capture) {
  assert(capture && typeof capture === "object", "Capture root must be an object");
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
  const posts = [...postsById.values()].sort((left, right) =>
    String(right.createdDate).localeCompare(String(left.createdDate)),
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
    const chronologicalMessages = [...messagesById.values()].sort((left, right) =>
      String(left.createdAt).localeCompare(String(right.createdAt)),
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
  conversations.sort((left, right) =>
    String(left.createdAt).localeCompare(String(right.createdAt)),
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
    home: {
      feedPages: capture.feedPages.length,
      posts: posts.length,
      oldestPost: dates.length ? [...dates].sort().at(0) : null,
      newestPost: dates.length ? [...dates].sort().at(-1) : null,
      postsWithImages: posts.filter((post) => asArray(post.images).length > 0).length,
      imageReferences: posts.reduce((total, post) => total + asArray(post.images).length, 0),
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
      index: indexViewer(conversations, summary),
    },
  };
}

function writeAtomically(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function writeJson(filePath, value) {
  writeAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
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
        } else if (/\.(?:json|html|sha256)$/i.test(entry.name)) {
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
  assert(fs.existsSync(capturePath), `Capture file not found: ${capturePath}`);
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const result = transformCapture(capture);
  const metadataRoot = path.join(outputRoot, "metadata");
  const messagesRoot = path.join(outputRoot, "messages");
  writeJson(path.join(metadataRoot, "posts.json"), result.posts);
  writeJson(path.join(metadataRoot, "conversations.json"), result.conversations);
  writeJson(path.join(metadataRoot, "media.json"), result.media);
  writeJson(path.join(metadataRoot, "export-summary.json"), result.summary);
  writeAtomically(path.join(messagesRoot, "index.html"), result.html.index);
  for (const entry of fs.readdirSync(messagesRoot, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name !== "index.html" &&
      entry.name.endsWith(".html")
    ) {
      fs.unlinkSync(path.join(messagesRoot, entry.name));
    }
  }
  const markerFiles = credentialMarkerFiles(outputRoot);
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
