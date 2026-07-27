const MANIFEST_PATHS = Object.freeze({
  posts: "/metadata/posts.json",
  conversations: "/metadata/conversations.json",
  media: "/metadata/media.json",
  summary: "/metadata/export-summary.json",
});
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
export const ACCESS_SESSION_KEY = "famly-export:access:v1";
export const TIMELINE_BATCH_SIZE = 100;

export function privateRoutePrefix(token) {
  return ACCESS_TOKEN_PATTERN.test(token)
    ? `/_private/${token}`
    : null;
}

export function consumeAccessToken(windowObject) {
  const hash = String(windowObject?.location?.hash ?? "");
  const fragmentMatch = hash.match(/^#access=([A-Za-z0-9_-]{43})$/);
  let token = fragmentMatch?.[1] ?? null;
  if (hash) {
    try {
      const replacement = `${windowObject.location.pathname}${windowObject.location.search}`;
      windowObject.history.replaceState(null, "", replacement || "/");
    } catch {
      // The fragment remains local even when browser history is unavailable.
    }
  }
  if (token) {
    try {
      windowObject.sessionStorage.setItem(ACCESS_SESSION_KEY, token);
    } catch {
      // This launch can still use the in-memory fragment token.
    }
  } else {
    try {
      const stored = windowObject.sessionStorage.getItem(ACCESS_SESSION_KEY);
      token = ACCESS_TOKEN_PATTERN.test(stored) ? stored : null;
    } catch {
      token = null;
    }
  }
  return token;
}

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

export function safeLocalMediaHref(entry, accessPrefix) {
  const segments = safeMediaPathSegments(entry);
  if (
    !segments ||
    !isAllowedMediaRecord(entry) ||
    !/^\/_private\/[A-Za-z0-9_-]{43}$/.test(accessPrefix)
  ) {
    return null;
  }
  return `${accessPrefix}/${segments
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
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

export function buildTimeline(posts, conversations, archive = null) {
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
      presentInLatest:
        archive?.stateMaps?.posts?.[id]?.presentInLatest !== false,
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
        presentInLatest:
          archive?.stateMaps?.messages?.[id]?.presentInLatest !== false,
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

export function normalizeSearchText(value) {
  return displayText(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase();
}

function searchValues(entry, mediaIndex) {
  const record =
    entry.kind === "post"
      ? entry.post
      : {
          message: entry.message,
          conversation: {
            title: entry.conversation?.title,
            participants: entry.conversation?.participants,
            recipients: entry.conversation?.recipients,
            loginReads: entry.conversation?.loginReads,
          },
        };
  const ownerEntries =
    entry.kind === "post"
      ? [
          ...mediaForOwner(mediaIndex, "post", entry.id),
          ...asArray(entry.post?.comments).flatMap((comment) =>
            mediaForOwner(mediaIndex, "comment", comment?.commentId),
          ),
        ]
      : mediaForOwner(mediaIndex, "message", entry.id);
  return normalizeSearchText([
    record,
    ownerEntries.map((media) => media.filename),
  ]);
}

export function searchTokens(query) {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

export function entryMedia(entry, mediaIndex) {
  return entry.kind === "post"
    ? [
        ...mediaForOwner(mediaIndex, "post", entry.id),
        ...asArray(entry.post?.comments).flatMap((comment) =>
          mediaForOwner(mediaIndex, "comment", comment?.commentId),
        ),
      ]
    : mediaForOwner(mediaIndex, "message", entry.id);
}

function filterKindForMedia(entry) {
  if (entry?.expectedMime?.startsWith("image/")) return "image";
  if (entry?.expectedMime === "video/mp4") return "video";
  return "file";
}

export function matchesTimelineEntry(
  entry,
  filters,
  mediaIndex,
  favorites = null,
) {
  const sourceEnabled =
    (entry.kind === "post" && filters.home !== false) ||
    (entry.kind === "message" && filters.messages !== false);
  if (!sourceEnabled) return false;
  const date = entry.timestamp?.slice(0, 10) ?? "";
  if (filters.dateFrom && date < filters.dateFrom) return false;
  if (filters.dateTo && date > filters.dateTo) return false;
  if (
    filters.conversationId &&
    entry.conversation?.conversationId !== filters.conversationId
  ) {
    return false;
  }
  const wantedState = filters.historyState ?? "all";
  if (
    (wantedState === "current" && !entry.presentInLatest) ||
    (wantedState === "preserved" && entry.presentInLatest)
  ) {
    return false;
  }
  const media = entryMedia(entry, mediaIndex).filter(
    (item) => item.role !== "video-poster",
  );
  const selectedKinds = ["image", "video", "file"].filter(
    (kind) => filters[kind],
  );
  if (
    selectedKinds.length &&
    !media.some((item) => selectedKinds.includes(filterKindForMedia(item)))
  ) {
    return false;
  }
  if (
    filters.favoritesOnly &&
    !media.some((item) => favorites?.has(mediaIdentity(item)))
  ) {
    return false;
  }
  const tokens = searchTokens(filters.query ?? "");
  if (tokens.length) {
    const haystack = searchValues(entry, mediaIndex);
    if (!tokens.every((token) => haystack.includes(token))) return false;
  }
  return true;
}

export function nextTimelineBatch(entries, rendered) {
  const safeRendered =
    Number.isInteger(rendered) && rendered >= 0 ? rendered : 0;
  return asArray(entries).slice(
    safeRendered,
    safeRendered + TIMELINE_BATCH_SIZE,
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

export async function loadManifests(
  fetchImplementation = globalThis.fetch,
  accessPrefix,
) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("This browser cannot load the export manifests.");
  }
  if (!/^\/_private\/[A-Za-z0-9_-]{43}$/.test(accessPrefix)) {
    throw new Error("This viewer launch has no valid access token.");
  }
  const keys = Object.keys(MANIFEST_PATHS);
  const responses = await Promise.all(
    keys.map(async (key) => {
      const manifestUrl = `${accessPrefix}${MANIFEST_PATHS[key]}`;
      let response;
      try {
        response = await fetchImplementation(manifestUrl, {
          credentials: "same-origin",
        });
      } catch {
        throw new Error(`Could not load ${MANIFEST_PATHS[key]}.`);
      }
      if (!response?.ok) {
        throw new Error(
          `Could not load ${MANIFEST_PATHS[key]} (HTTP ${response?.status ?? "error"}).`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`${MANIFEST_PATHS[key]} is not valid JSON.`);
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

function compactMetadataValue(value) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function appendMetadataDetails(documentObject, container, title, fields) {
  const available = Object.entries(fields).filter(
    ([, value]) => compactMetadataValue(value) != null,
  );
  if (!available.length) return;
  const details = element(documentObject, "details", "metadata-details");
  details.append(element(documentObject, "summary", null, title));
  const list = element(documentObject, "dl", "metadata-list");
  for (const [label, value] of available) {
    list.append(
      element(documentObject, "dt", null, label),
      element(documentObject, "dd", null, compactMetadataValue(value)),
    );
  }
  details.append(list);
  container.append(details);
}

function appendHistoryLabel(documentObject, article, timelineEntry) {
  if (!timelineEntry.presentInLatest) {
    article.append(
      element(
        documentObject,
        "div",
        "history-label",
        "Not seen in latest refresh",
      ),
    );
  }
}

function renderFavoriteImage(
  documentObject,
  entry,
  favorites,
  registerUpdater,
  accessPrefix,
) {
  const identity = mediaIdentity(entry);
  const href = safeLocalMediaHref(entry, accessPrefix);
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

function favoriteButtonFor(
  documentObject,
  entry,
  favorites,
  registerUpdater,
) {
  if (!favorites || entry?.role === "video-poster") return null;
  const identity = mediaIdentity(entry);
  if (!identity) return null;
  const button = element(documentObject, "button", "favorite-button");
  button.type = "button";
  const update = () => {
    const selected = favorites.has(identity);
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = selected ? "★ Favorited" : "☆ Favorite";
  };
  button.addEventListener("click", () => favorites.toggle(identity));
  registerUpdater?.(update);
  update();
  return button;
}

export function renderInlineVideo(
  documentObject,
  entry,
  accessPrefix,
  { poster = null, favorites = null, registerUpdater = null } = {},
) {
  if (entry?.kind !== "video" && entry?.expectedMime !== "video/mp4") {
    return null;
  }
  const href = safeLocalMediaHref(entry, accessPrefix);
  if (!href) {
    return null;
  }
  const filename = entry.filename || "Famly video";
  const figure = element(documentObject, "figure", "video-card");
  const video = element(documentObject, "video");
  video.src = href;
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.setAttribute("aria-label", filename);
  const posterHref = poster ? safeLocalMediaHref(poster, accessPrefix) : null;
  if (posterHref) video.poster = posterHref;

  const caption = element(documentObject, "figcaption", "video-actions");
  const originalLink = element(
    documentObject,
    "a",
    null,
    "Open original video",
  );
  originalLink.href = href;
  caption.append(originalLink);
  const favorite = favoriteButtonFor(
    documentObject,
    entry,
    favorites,
    registerUpdater,
  );
  if (favorite) caption.append(favorite);
  figure.append(video, caption);
  return figure;
}

export function messageDisclosureState(entries) {
  const supported = asArray(entries).filter(isAllowedMediaRecord);
  if (
    supported.some(
      (entry) =>
        entry.kind === "image" ||
        entry.kind === "video" ||
        entry.expectedMime === "video/mp4",
    )
  ) {
    return { open: true, label: "Image or video message" };
  }
  if (supported.length > 0) {
    return { open: false, label: "Message with file attachment" };
  }
  return { open: false, label: "Text message" };
}

function renderAttachments(
  documentObject,
  entries,
  favorites,
  registerUpdater,
  accessPrefix,
) {
  const supported = entries
    .map((entry) => ({
      entry,
      href: safeLocalMediaHref(entry, accessPrefix),
    }))
    .filter(({ href }) => href);
  if (supported.length === 0) {
    return null;
  }
  const container = element(documentObject, "div", "attachments");
  const imageGrid = element(documentObject, "div", "image-grid");
  const videoGrid = element(documentObject, "div", "video-grid");
  const fileList = element(documentObject, "ul", "file-list");
  const posters = new Map(
    supported
      .filter(({ entry }) => entry.role === "video-poster")
      .map(({ entry }) => [
        String(entry.mediaId).replace(/-poster$/, ""),
        entry,
      ]),
  );
  let images = 0;
  let videos = 0;
  let files = 0;
  for (const { entry, href } of supported) {
    if (entry.role === "video-poster") {
      continue;
    }
    if (entry.kind === "image") {
      const image = renderFavoriteImage(
        documentObject,
        entry,
        favorites,
        registerUpdater,
        accessPrefix,
      );
      if (image) {
        imageGrid.append(image);
        images += 1;
      }
    } else if (entry.kind === "video" || entry.expectedMime === "video/mp4") {
      const video = renderInlineVideo(documentObject, entry, accessPrefix, {
        poster: posters.get(entry.mediaId),
        favorites,
        registerUpdater,
      });
      if (video) {
        videoGrid.append(video);
        videos += 1;
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
      const favorite = favoriteButtonFor(
        documentObject,
        entry,
        favorites,
        registerUpdater,
      );
      if (favorite) item.append(" ", favorite);
      fileList.append(item);
      files += 1;
    }
  }
  if (images > 0) {
    container.append(imageGrid);
  }
  if (videos > 0) {
    container.append(videoGrid);
  }
  if (files > 0) {
    container.append(fileList);
  }
  return images + videos + files > 0 ? container : null;
}

function renderComment(
  documentObject,
  comment,
  mediaIndex,
  favorites,
  registerUpdater,
  accessPrefix,
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
  appendMetadataDetails(documentObject, article, "Comment details", {
    "Likes": comment?.likes,
    "Liked by current user": comment?.liked,
    "Recipients": comment?.receivers ?? comment?.recipients,
  });
  const attachments = renderAttachments(
    documentObject,
    mediaForOwner(mediaIndex, "comment", comment?.commentId),
    favorites,
    registerUpdater,
    accessPrefix,
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
  accessPrefix,
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
  appendHistoryLabel(documentObject, article, timelineEntry);
  const invoice = post?.embed?.invoice;
  appendMetadataDetails(documentObject, article, "Post details", {
    "Recipients": post?.receivers ?? post?.embed?.recipients,
    "Likes": post?.likes,
    "Observation": post?.embed?.observation ?? post?.embed?.observationId,
    "Associated children": post?.embed?.children ?? post?.embed?.child,
    "Event title": post?.embed?.event?.title ?? post?.embed?.title,
    "Event schedule": post?.embed?.event?.schedule ?? post?.embed?.schedule,
    "Event timezone": post?.embed?.event?.timezone ?? post?.embed?.timezone,
    "Event RSVP": post?.embed?.event?.rsvp ?? post?.embed?.rsvp,
    "Invoice status": invoice?.status,
    "Invoice date": invoice?.date,
    "Invoice due": invoice?.due,
    "Invoice exact amount": invoice?.amount,
    "Invoice payer": invoice?.payer,
    "Invoice lines": invoice?.lines,
  });
  const attachments = renderAttachments(
    documentObject,
    mediaForOwner(mediaIndex, "post", post?.feedItemId),
    favorites,
    registerUpdater,
    accessPrefix,
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
            accessPrefix,
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
  accessPrefix,
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
  const messageMedia = mediaForOwner(
    mediaIndex,
    "message",
    message?.messageId,
  );
  const disclosureState = messageDisclosureState(messageMedia);
  const disclosure = element(documentObject, "details", "message-details");
  disclosure.open = disclosureState.open;
  disclosure.append(
    element(
      documentObject,
      "summary",
      "message-summary",
      disclosureState.label,
    ),
    body,
  );
  article.append(label, header, context, disclosure);
  appendHistoryLabel(documentObject, article, timelineEntry);
  appendMetadataDetails(documentObject, disclosure, "Read and reaction details", {
    "Message read state": message?.unread === true ? "Unread at capture" : "Read",
    "Message readers": message?.loginReads,
    "Conversation readers": conversation?.loginReads,
    "Reaction details": message?.reactionSummary,
  });
  const attachments = renderAttachments(
    documentObject,
    messageMedia,
    favorites,
    registerUpdater,
    accessPrefix,
  );
  if (attachments) {
    disclosure.append(attachments);
  }
  const reactionCount = Number(message?.reactionSummary?.count ?? 0);
  if (reactionCount > 0) {
    disclosure.append(
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
    "Then open the complete tokenized URL printed by the server.",
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

  const accessToken = consumeAccessToken(windowObject);
  const accessPrefix = privateRoutePrefix(accessToken);
  if (!accessPrefix) {
    status.textContent =
      "This viewer launch is missing its private access token. Start the local server again and open the complete URL it prints.";
    status.className = "status error";
    return null;
  }

  let manifests;
  try {
    manifests = await loadManifests(
      windowObject.fetch.bind(windowObject),
      accessPrefix,
    );
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Could not load the export.";
    status.className = "status error";
    return null;
  }

  const mediaIndex = indexMedia(manifests.media);
  const favoriteIdentities = [...mediaIndex.byIdentity]
    .filter(([, entry]) => entry.role !== "video-poster")
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

  const timeline = buildTimeline(
    manifests.posts,
    manifests.conversations,
    manifests.summary.archive,
  );
  const controls = {
    query: documentObject.querySelector("#filter-search"),
    home: documentObject.querySelector("#filter-home"),
    messages: documentObject.querySelector("#filter-messages"),
    dateFrom: documentObject.querySelector("#filter-date-from"),
    dateTo: documentObject.querySelector("#filter-date-to"),
    conversationId: documentObject.querySelector("#filter-conversation"),
    image: documentObject.querySelector("#filter-image"),
    video: documentObject.querySelector("#filter-video"),
    file: documentObject.querySelector("#filter-file"),
    historyState: documentObject.querySelector("#filter-history"),
    favoritesOnly: documentObject.querySelector("#filter-favorites"),
    clear: documentObject.querySelector("#clear-filters"),
    clearFavorites: documentObject.querySelector("#clear-favorites"),
    loadMore: documentObject.querySelector("#load-more"),
    sentinel: documentObject.querySelector("#timeline-sentinel"),
    matchCount: documentObject.querySelector("#match-count"),
    health: documentObject.querySelector("#export-health"),
  };
  const filtersFromControls = () => ({
    query: controls.query?.value ?? "",
    home: controls.home?.checked ?? true,
    messages: controls.messages?.checked ?? true,
    dateFrom: controls.dateFrom?.value ?? "",
    dateTo: controls.dateTo?.value ?? "",
    conversationId: controls.conversationId?.value ?? "",
    image: controls.image?.checked ?? false,
    video: controls.video?.checked ?? false,
    file: controls.file?.checked ?? false,
    historyState: controls.historyState?.value ?? "all",
    favoritesOnly: controls.favoritesOnly?.checked ?? false,
  });
  if (controls.conversationId) {
    const conversations = manifests.conversations
      .slice()
      .sort((left, right) =>
        conversationTitle(left).localeCompare(conversationTitle(right)),
      );
    for (const conversation of conversations) {
      const option = element(
        documentObject,
        "option",
        null,
        conversationTitle(conversation),
      );
      option.value = conversation.conversationId;
      controls.conversationId.append(option);
    }
  }
  let matching = [];
  let rendered = 0;
  const renderMore = () => {
    const next = nextTimelineBatch(matching, rendered);
    for (const timelineEntry of next) {
      timelineRoot.append(
        timelineEntry.kind === "post"
          ? renderPost(
              documentObject,
              timelineEntry,
              mediaIndex,
              favorites,
              registerUpdater,
              accessPrefix,
            )
          : renderMessage(
              documentObject,
              timelineEntry,
              mediaIndex,
              favorites,
              registerUpdater,
              accessPrefix,
            ),
      );
    }
    rendered += next.length;
    if (controls.loadMore) {
      controls.loadMore.hidden = rendered >= matching.length;
      controls.loadMore.textContent = `Load more (${matching.length - rendered} remaining)`;
    }
  };
  const applyFilters = () => {
    matching = timeline.filter((entry) =>
      matchesTimelineEntry(entry, filtersFromControls(), mediaIndex, favorites),
    );
    rendered = 0;
    timelineRoot.replaceChildren();
    renderMore();
    if (controls.matchCount) {
      controls.matchCount.textContent = `${matching.length} matching entries`;
    }
  };
  const inputControls = Object.values(controls).filter(
    (control) =>
      control &&
      ["INPUT", "SELECT"].includes(String(control.tagName).toUpperCase()),
  );
  inputControls.forEach((control) => {
    control.addEventListener("input", applyFilters);
    control.addEventListener("change", applyFilters);
  });
  controls.loadMore?.addEventListener("click", renderMore);
  controls.clear?.addEventListener("click", () => {
    if (controls.query) controls.query.value = "";
    if (controls.home) controls.home.checked = true;
    if (controls.messages) controls.messages.checked = true;
    if (controls.dateFrom) controls.dateFrom.value = "";
    if (controls.dateTo) controls.dateTo.value = "";
    if (controls.conversationId) controls.conversationId.value = "";
    if (controls.image) controls.image.checked = false;
    if (controls.video) controls.video.checked = false;
    if (controls.file) controls.file.checked = false;
    if (controls.historyState) controls.historyState.value = "all";
    if (controls.favoritesOnly) controls.favoritesOnly.checked = false;
    applyFilters();
  });
  controls.clearFavorites?.addEventListener("click", () => {
    favorites.selected.clear();
    favorites.persist();
    favorites.emit();
    applyFilters();
  });
  if (controls.sentinel && typeof windowObject.IntersectionObserver === "function") {
    const observer = new windowObject.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderMore();
    });
    observer.observe(controls.sentinel);
  }
  favorites.subscribe(() => {
    if (controls.favoritesOnly?.checked) applyFilters();
  });
  if (controls.health) {
    const archiveCounts = manifests.summary.archive?.counts ?? {};
    controls.health.textContent = [
      `Captured: ${manifests.summary.capturedAt ?? "unknown"}`,
      `Date range: ${manifests.summary.archive?.dateRange?.oldest ?? manifests.summary.home?.oldestPost ?? "unknown"} to ${manifests.summary.archive?.dateRange?.newest ?? manifests.summary.home?.newestPost ?? "unknown"}`,
      `Current/preserved posts: ${archiveCounts.posts?.current ?? manifests.posts.length}/${archiveCounts.posts?.preserved ?? 0}`,
      `Current/preserved messages: ${archiveCounts.messages?.current ?? timeline.filter((entry) => entry.kind === "message").length}/${archiveCounts.messages?.preserved ?? 0}`,
      `Total bytes: ${manifests.summary.validation?.totalBytes ?? "not recorded"}`,
      `Unsupported: ${manifests.summary.media?.unsupported ?? 0}`,
      `Excluded UI assets: ${manifests.summary.media?.excludedUiAssets ?? 0}`,
      `Verification: ${manifests.summary.validation?.checksums ?? "not verified"}`,
    ].join("\n");
  }
  applyFilters();
  status.textContent = summaryText(manifests);
  status.className = "status";
  updateFooter();

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    exportStatus.textContent = "Creating ZIP…";
    exportStatus.className = "export-status";
    try {
      const response = await windowObject.fetch(
        `${accessPrefix}/api/favorites-archives`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identities: favorites.values() }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `ZIP creation failed (HTTP ${response.status}).`);
      }
      const downloadUrl = new URL(payload.downloadUrl, windowObject.location.href);
      const expectedDownloadPrefix = `${accessPrefix}/api/favorites-archives/`;
      if (
        downloadUrl.origin !== windowObject.location.origin ||
        !downloadUrl.pathname.startsWith(expectedDownloadPrefix) ||
        !new RegExp(
          `^${expectedDownloadPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]{32}$`,
        ).test(downloadUrl.pathname) ||
        downloadUrl.search ||
        downloadUrl.hash
      ) {
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

  return { favorites, manifests, timeline, accessPrefix };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  void startViewer();
}
