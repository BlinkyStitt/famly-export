const MANIFEST_URLS = Object.freeze({
  posts: "/metadata/posts.json",
  conversations: "/metadata/conversations.json",
  media: "/metadata/media.json",
  summary: "/metadata/export-summary.json",
});
const ALLOWED_MEDIA_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "application/pdf",
]);

export const FAVORITES_STORAGE_KEY = "famly-export:favorites:v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function displayText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requiredIdentityPart(value) {
  return typeof value === "string" && value ? encodeURIComponent(value) : null;
}

export function mediaIdentity(entry) {
  const parts = [
    entry?.sourceType,
    entry?.ownerType,
    entry?.ownerId,
    entry?.kind,
    entry?.mediaId,
  ].map(requiredIdentityPart);
  return parts.every(Boolean) ? `v1:${parts.join(":")}` : null;
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function safeMediaPathSegments(entry) {
  const relativePath = entry?.relativePath;
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(relativePath)
  ) {
    return null;
  }
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments;
}

export function isAllowedMediaRecord(entry) {
  const segments = safeMediaPathSegments(entry);
  if (!segments) {
    return false;
  }
  if (
    !ALLOWED_MEDIA_MIMES.has(entry?.expectedMime) ||
    (entry.kind === "image" && !entry.expectedMime.startsWith("image/")) ||
    (entry.kind === "video" && entry.expectedMime !== "video/mp4")
  ) {
    return false;
  }
  const isFlat = segments.length === 2;
  if (entry?.sourceType === "home" && entry?.ownerType === "comment") {
    return entry.kind === "image" && segments[0] === "photos" && isFlat;
  }
  if (entry?.sourceType === "home" && entry?.ownerType === "post") {
    return (
      (entry.kind === "image" && segments[0] === "photos" && isFlat) ||
      (entry.kind === "video" &&
        segments[0] === "videos" &&
        segments.length >= 3) ||
      (entry.kind === "file" &&
        segments[0] === "files" &&
        segments.length >= 3)
    );
  }
  if (entry?.sourceType === "message" && entry?.ownerType === "message") {
    return (
      (entry.kind === "image" &&
        segments[0] === "message-images" &&
        isFlat) ||
      (entry.kind === "file" &&
        segments[0] === "messages" &&
        segments[1] === "attachments" &&
        segments.length >= 4)
    );
  }
  return false;
}

export function safeLocalMediaHref(entry) {
  const segments = safeMediaPathSegments(entry);
  if (!segments || !isAllowedMediaRecord(entry)) {
    return null;
  }
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function timestampDetails(value) {
  if (typeof value !== "string" || !value) {
    return { epoch: Number.NEGATIVE_INFINITY, iso: null };
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    return { epoch: Number.NEGATIVE_INFINITY, iso: null };
  }
  return { epoch, iso: new Date(epoch).toISOString() };
}

export function buildTimeline(posts, conversations) {
  const entries = [];
  asArray(posts).forEach((post, index) => {
    const timestamp = timestampDetails(post?.createdDate);
    const id =
      typeof post?.feedItemId === "string" && post.feedItemId
        ? post.feedItemId
        : `missing-post-${index}`;
    entries.push({
      kind: "post",
      id,
      timestamp: timestamp.iso,
      timestampEpoch: timestamp.epoch,
      tieKey: `post:${id}:${index}`,
      post,
    });
  });
  asArray(conversations).forEach((conversation, conversationIndex) => {
    asArray(conversation?.messages).forEach((message, messageIndex) => {
      const timestamp = timestampDetails(message?.createdAt);
      const id =
        typeof message?.messageId === "string" && message.messageId
          ? message.messageId
          : `missing-message-${conversationIndex}-${messageIndex}`;
      entries.push({
        kind: "message",
        id,
        timestamp: timestamp.iso,
        timestampEpoch: timestamp.epoch,
        tieKey: `message:${id}:${conversationIndex}:${messageIndex}`,
        conversation,
        message,
      });
    });
  });
  return entries.sort(
    (left, right) =>
      right.timestampEpoch - left.timestampEpoch ||
      left.tieKey.localeCompare(right.tieKey),
  );
}

export function indexMedia(media) {
  const byOwner = new Map();
  const byIdentity = new Map();
  for (const entry of asArray(media)) {
    const identity = mediaIdentity(entry);
    if (
      !identity ||
      identity !== entry?.identity ||
      !isAllowedMediaRecord(entry) ||
      byIdentity.has(identity)
    ) {
      continue;
    }
    byIdentity.set(identity, entry);
    const ownerKey = `${entry.ownerType}:${entry.ownerId}`;
    const ownerEntries = byOwner.get(ownerKey) ?? [];
    ownerEntries.push(entry);
    byOwner.set(ownerKey, ownerEntries);
  }
  for (const ownerEntries of byOwner.values()) {
    ownerEntries.sort((left, right) =>
      String(left.relativePath).localeCompare(String(right.relativePath)),
    );
  }
  return { byIdentity, byOwner };
}

export class FavoriteSelection {
  constructor(validIdentities, storage = null, key = FAVORITES_STORAGE_KEY) {
    this.validIdentities = new Set(validIdentities);
    this.storage = storage;
    this.key = key;
    this.selected = new Set();
    this.listeners = new Set();
    this.restore();
  }

  restore() {
    let saved = [];
    try {
      const parsed = JSON.parse(this.storage?.getItem(this.key) ?? "[]");
      saved = Array.isArray(parsed) ? parsed : [];
    } catch {
      saved = [];
    }
    this.selected = new Set(
      saved.filter(
        (identity) =>
          typeof identity === "string" && this.validIdentities.has(identity),
      ),
    );
    this.persist();
  }

  persist() {
    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify([...this.selected].sort()),
      );
    } catch {
      // The viewer still works when browser storage is unavailable.
    }
  }

  has(identity) {
    return this.selected.has(identity);
  }

  toggle(identity) {
    if (!this.validIdentities.has(identity)) {
      return false;
    }
    if (this.selected.has(identity)) {
      this.selected.delete(identity);
    } else {
      this.selected.add(identity);
    }
    this.persist();
    this.emit();
    return this.selected.has(identity);
  }

  values() {
    return [...this.selected].sort();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
}

export async function loadManifests(fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("This browser cannot load the export manifests.");
  }
  const keys = Object.keys(MANIFEST_URLS);
  const responses = await Promise.all(
    keys.map(async (key) => {
      let response;
      try {
        response = await fetchImplementation(MANIFEST_URLS[key], {
          credentials: "same-origin",
        });
      } catch {
        throw new Error(`Could not load ${MANIFEST_URLS[key]}.`);
      }
      if (!response?.ok) {
        throw new Error(
          `Could not load ${MANIFEST_URLS[key]} (HTTP ${response?.status ?? "error"}).`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`${MANIFEST_URLS[key]} is not valid JSON.`);
      }
    }),
  );
  const manifests = Object.fromEntries(
    keys.map((key, index) => [key, responses[index]]),
  );
  if (
    !Array.isArray(manifests.posts) ||
    !Array.isArray(manifests.conversations) ||
    !Array.isArray(manifests.media) ||
    !manifests.summary ||
    typeof manifests.summary !== "object" ||
    Array.isArray(manifests.summary)
  ) {
    throw new Error("One or more export manifests have an unexpected shape.");
  }
  return manifests;
}

function element(documentObject, tagName, className = null, text = null) {
  const node = documentObject.createElement(tagName);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = String(text);
  }
  return node;
}

function appendTimestamp(documentObject, container, value) {
  const details = timestampDetails(value);
  const time = element(
    documentObject,
    "time",
    "entry-time",
    details.iso
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(details.epoch)
      : "Date unavailable",
  );
  if (details.iso) {
    time.dateTime = details.iso;
  }
  container.append(time);
}

function appendLinkifiedText(documentObject, container, value) {
  const text = displayText(value);
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(documentObject.createTextNode(text.slice(cursor, match.index)));
    let urlText = match[0];
    let trailing = "";
    while (/[),.;!?]$/.test(urlText)) {
      trailing = `${urlText.at(-1)}${trailing}`;
      urlText = urlText.slice(0, -1);
    }
    const href = safeExternalUrl(urlText);
    if (href) {
      const link = element(documentObject, "a", null, urlText);
      link.href = href;
      link.rel = "noopener noreferrer";
      link.target = "_blank";
      container.append(link);
    } else {
      container.append(documentObject.createTextNode(urlText));
    }
    container.append(documentObject.createTextNode(trailing));
    cursor = match.index + match[0].length;
  }
  container.append(documentObject.createTextNode(text.slice(cursor)));
}

function authorName(record) {
  for (const value of [
    record?.title,
    record?.name,
    record?.displayName,
    record?.subtitle,
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "Unknown author";
}

function conversationTitle(conversation) {
  if (typeof conversation?.title === "string" && conversation.title.trim()) {
    return conversation.title.trim();
  }
  const names = asArray(conversation?.participants)
    .map((participant) => authorName(participant))
    .filter((name) => name !== "Unknown author");
  return names.join(", ") || "Untitled conversation";
}

function postBody(post) {
  return post?.body ?? post?.richTextBody ?? "";
}

function mediaForOwner(mediaIndex, ownerType, ownerId) {
  return mediaIndex.byOwner.get(`${ownerType}:${ownerId}`) ?? [];
}

function renderFavoriteImage(
  documentObject,
  entry,
  favorites,
  registerUpdater,
) {
  const identity = mediaIdentity(entry);
  const href = safeLocalMediaHref(entry);
  if (!identity || !href) {
    return null;
  }
  const figure = element(documentObject, "figure", "image-card");
  const imageLink = element(documentObject, "a", "image-toggle");
  imageLink.href = href;
  imageLink.setAttribute("aria-label", `Favorite ${entry.filename || "image"}`);
  const image = element(documentObject, "img");
  image.src = href;
  image.alt = entry.filename || "Famly image";
  image.loading = "lazy";
  image.decoding = "async";
  imageLink.append(image);

  const caption = element(documentObject, "figcaption", "image-actions");
  const originalLink = element(documentObject, "a", null, "Open original");
  originalLink.href = href;
  const favoriteButton = element(documentObject, "button", "favorite-button");
  favoriteButton.type = "button";

  const update = () => {
    const selected = favorites.has(identity);
    figure.classList.toggle("is-favorite", selected);
    favoriteButton.setAttribute("aria-pressed", String(selected));
    favoriteButton.textContent = selected ? "★ Favorited" : "☆ Favorite";
  };
  const toggle = () => favorites.toggle(identity);
  imageLink.addEventListener("click", (event) => {
    event.preventDefault();
    toggle();
  });
  favoriteButton.addEventListener("click", toggle);
  caption.append(originalLink, favoriteButton);
  figure.append(imageLink, caption);
  registerUpdater(update);
  update();
  return figure;
}

function renderAttachments(
  documentObject,
  entries,
  favorites,
  registerUpdater,
) {
  const supported = entries
    .map((entry) => ({ entry, href: safeLocalMediaHref(entry) }))
    .filter(({ href }) => href);
  if (supported.length === 0) {
    return null;
  }
  const container = element(documentObject, "div", "attachments");
  const imageGrid = element(documentObject, "div", "image-grid");
  const fileList = element(documentObject, "ul", "file-list");
  let images = 0;
  let files = 0;
  for (const { entry, href } of supported) {
    if (entry.kind === "image") {
      const image = renderFavoriteImage(
        documentObject,
        entry,
        favorites,
        registerUpdater,
      );
      if (image) {
        imageGrid.append(image);
        images += 1;
      }
    } else {
      const item = element(documentObject, "li");
      const link = element(
        documentObject,
        "a",
        null,
        entry.filename || "Open attachment",
      );
      link.href = href;
      item.append(link);
      fileList.append(item);
      files += 1;
    }
  }
  if (images > 0) {
    container.append(imageGrid);
  }
  if (files > 0) {
    container.append(fileList);
  }
  return images + files > 0 ? container : null;
}

function renderComment(
  documentObject,
  comment,
  mediaIndex,
  favorites,
  registerUpdater,
) {
  const article = element(documentObject, "article", "comment");
  const header = element(documentObject, "header", "entry-header");
  header.append(
    element(
      documentObject,
      "strong",
      null,
      authorName(comment?.sender ?? comment?.owner),
    ),
  );
  appendTimestamp(documentObject, header, comment?.createdDate);
  const body = element(documentObject, "div", "entry-body");
  appendLinkifiedText(documentObject, body, comment?.body);
  article.append(header, body);
  const attachments = renderAttachments(
    documentObject,
    mediaForOwner(mediaIndex, "comment", comment?.commentId),
    favorites,
    registerUpdater,
  );
  if (attachments) {
    article.append(attachments);
  }
  return article;
}

function renderPost(
  documentObject,
  timelineEntry,
  mediaIndex,
  favorites,
  registerUpdater,
) {
  const post = timelineEntry.post;
  const article = element(documentObject, "article", "timeline-entry post-entry");
  article.dataset.entryKind = "post";
  article.dataset.entryId = timelineEntry.id;
  const header = element(documentObject, "header", "entry-header");
  const heading = element(
    documentObject,
    "h2",
    null,
    authorName(post?.sender ?? post?.owner),
  );
  header.append(heading);
  appendTimestamp(documentObject, header, post?.createdDate);
  const label = element(documentObject, "div", "entry-kind", "Home post");
  const body = element(documentObject, "div", "entry-body");
  appendLinkifiedText(documentObject, body, postBody(post));
  article.append(label, header, body);
  const attachments = renderAttachments(
    documentObject,
    mediaForOwner(mediaIndex, "post", post?.feedItemId),
    favorites,
    registerUpdater,
  );
  if (attachments) {
    article.append(attachments);
  }
  const comments = asArray(post?.comments);
  if (comments.length > 0) {
    const commentSection = element(documentObject, "section", "comments");
    commentSection.append(
      element(
        documentObject,
        "h3",
        null,
        `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`,
      ),
    );
    comments
      .slice()
      .sort(
        (left, right) =>
          timestampDetails(left?.createdDate).epoch -
            timestampDetails(right?.createdDate).epoch ||
          String(left?.commentId).localeCompare(String(right?.commentId)),
      )
      .forEach((comment) => {
        commentSection.append(
          renderComment(
            documentObject,
            comment,
            mediaIndex,
            favorites,
            registerUpdater,
          ),
        );
      });
    article.append(commentSection);
  }
  return article;
}

function renderMessage(
  documentObject,
  timelineEntry,
  mediaIndex,
  favorites,
  registerUpdater,
) {
  const { message, conversation } = timelineEntry;
  const article = element(
    documentObject,
    "article",
    "timeline-entry message-entry",
  );
  article.dataset.entryKind = "message";
  article.dataset.entryId = timelineEntry.id;
  const label = element(documentObject, "div", "entry-kind", "Message");
  const header = element(documentObject, "header", "entry-header");
  header.append(
    element(documentObject, "h2", null, authorName(message?.author)),
  );
  appendTimestamp(documentObject, header, message?.createdAt);
  const context = element(documentObject, "div", "conversation-context");
  context.append(
    element(
      documentObject,
      "strong",
      null,
      conversationTitle(conversation),
    ),
  );
  const participants = asArray(conversation?.participants)
    .map((participant) => authorName(participant))
    .filter((name) => name !== "Unknown author");
  const contextDetails = [
    conversation?.listKind === "archived" ? "Archived" : "Active",
    participants.length ? `Participants: ${participants.join(", ")}` : null,
  ].filter(Boolean);
  if (contextDetails.length) {
    context.append(
      element(documentObject, "span", null, contextDetails.join(" · ")),
    );
  }
  const body = element(documentObject, "div", "entry-body");
  appendLinkifiedText(documentObject, body, message?.body);
  article.append(label, header, context, body);
  const attachments = renderAttachments(
    documentObject,
    mediaForOwner(mediaIndex, "message", message?.messageId),
    favorites,
    registerUpdater,
  );
  if (attachments) {
    article.append(attachments);
  }
  const reactionCount = Number(message?.reactionSummary?.count ?? 0);
  if (reactionCount > 0) {
    article.append(
      element(
        documentObject,
        "div",
        "reaction-summary",
        `${reactionCount} ${reactionCount === 1 ? "reaction" : "reactions"}`,
      ),
    );
  }
  return article;
}

function summaryText(manifests) {
  const posts = manifests.posts.length;
  const messages = manifests.conversations.reduce(
    (total, conversation) => total + asArray(conversation?.messages).length,
    0,
  );
  const comments = manifests.posts.reduce(
    (total, post) => total + asArray(post?.comments).length,
    0,
  );
  return `${posts} Home posts · ${messages} Messages · ${comments} comments`;
}

function fileViewerGuidance() {
  return [
    "This viewer cannot load private JSON through file://.",
    "From the export directory, run:",
    "node .agents/skills/famly-export/scripts/serve-export.mjs .",
    "Then open http://127.0.0.1:4173/.",
  ].join(" ");
}

export async function startViewer(
  documentObject = globalThis.document,
  windowObject = globalThis.window,
) {
  const status = documentObject.querySelector("#viewer-status");
  const timelineRoot = documentObject.querySelector("#timeline");
  const selectionCount = documentObject.querySelector("#selected-count");
  const exportButton = documentObject.querySelector("#export-favorites");
  const exportStatus = documentObject.querySelector("#export-status");
  if (
    !status ||
    !timelineRoot ||
    !selectionCount ||
    !exportButton ||
    !exportStatus
  ) {
    throw new Error("The viewer shell is incomplete.");
  }
  if (windowObject.location.protocol === "file:") {
    status.textContent = fileViewerGuidance();
    status.className = "status error";
    return null;
  }

  let manifests;
  try {
    manifests = await loadManifests(windowObject.fetch.bind(windowObject));
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Could not load the export.";
    status.className = "status error";
    return null;
  }

  const mediaIndex = indexMedia(manifests.media);
  const favoriteIdentities = [...mediaIndex.byIdentity]
    .filter(([, entry]) => entry.kind === "image")
    .map(([identity]) => identity);
  const favorites = new FavoriteSelection(
    favoriteIdentities,
    windowObject.localStorage,
  );
  const imageUpdaters = [];
  const registerUpdater = (updater) => imageUpdaters.push(updater);
  const updateFooter = () => {
    const count = favorites.selected.size;
    selectionCount.textContent = `${count} selected`;
    exportButton.disabled = count === 0;
    imageUpdaters.forEach((update) => update());
  };
  favorites.subscribe(updateFooter);

  const timeline = buildTimeline(manifests.posts, manifests.conversations);
  for (const timelineEntry of timeline) {
    timelineRoot.append(
      timelineEntry.kind === "post"
        ? renderPost(
            documentObject,
            timelineEntry,
            mediaIndex,
            favorites,
            registerUpdater,
          )
        : renderMessage(
            documentObject,
            timelineEntry,
            mediaIndex,
            favorites,
            registerUpdater,
          ),
    );
  }
  status.textContent = summaryText(manifests);
  status.className = "status";
  updateFooter();

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    exportStatus.textContent = "Creating ZIP…";
    exportStatus.className = "export-status";
    try {
      const response = await windowObject.fetch("/api/favorites-archives", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identities: favorites.values() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `ZIP creation failed (HTTP ${response.status}).`);
      }
      const downloadUrl = new URL(payload.downloadUrl, windowObject.location.href);
      if (downloadUrl.origin !== windowObject.location.origin) {
        throw new Error("The server returned an unsafe download URL.");
      }
      const link = element(documentObject, "a");
      link.href = downloadUrl.href;
      link.download = payload.filename || "Famly-Favorites.zip";
      documentObject.body.append(link);
      link.click();
      link.remove();
      exportStatus.textContent = "ZIP download started.";
    } catch (error) {
      exportStatus.textContent =
        error instanceof Error ? error.message : "Could not create the ZIP.";
      exportStatus.className = "export-status error";
    } finally {
      exportButton.disabled = favorites.selected.size === 0;
    }
  });

  return { favorites, manifests, timeline };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  void startViewer();
}
