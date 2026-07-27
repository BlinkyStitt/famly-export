import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ACCESS_SESSION_KEY,
  FAVORITES_STORAGE_KEY,
  FavoriteSelection,
  buildTimeline,
  consumeAccessToken,
  indexMedia,
  loadManifests,
  messageDisclosureState,
  mediaIdentity,
  privateRoutePrefix,
  renderInlineVideo,
  safeExternalUrl,
  safeLocalMediaHref,
} from "../scripts/viewer-app.mjs";

const ACCESS_TOKEN = "A".repeat(43);
const ACCESS_PREFIX = `/_private/${ACCESS_TOKEN}`;

function mediaEntry(overrides = {}) {
  const entry = {
    mediaId: "image-1",
    sourceType: "home",
    ownerType: "post",
    ownerId: "post-1",
    conversationId: null,
    kind: "image",
    sourceUrl: "https://img.famly.co/original.jpg",
    relativePath: "photos/original image.jpg",
    filename: "original image.jpg",
    expectedMime: "image/jpeg",
    ...overrides,
  };
  entry.identity = mediaIdentity(entry);
  return entry;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

const fakeDocument = {
  createElement: (tagName) => new FakeElement(tagName),
};

test("timeline mixes posts and messages newest-first with deterministic ties", () => {
  const posts = [
    {
      feedItemId: "post-old",
      createdDate: "2026-01-01T00:00:00Z",
      comments: [
        {
          commentId: "nested-comment",
          createdDate: "2026-01-05T00:00:00Z",
        },
      ],
    },
    {
      feedItemId: "post-tie",
      createdDate: "2026-01-03T00:00:00Z",
    },
    {
      feedItemId: "post-malformed",
      createdDate: "not-a-date",
    },
  ];
  const conversations = [
    {
      conversationId: "conversation-1",
      title: "Context",
      participants: [{ title: "Participant" }],
      messages: [
        {
          messageId: "message-new",
          createdAt: "2026-01-04T00:00:00Z",
        },
        {
          messageId: "a-message-tie",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
    },
  ];
  const timeline = buildTimeline(posts, conversations);
  assert.deepEqual(
    timeline.map((entry) => `${entry.kind}:${entry.id}`),
    [
      "message:message-new",
      "message:a-message-tie",
      "post:post-tie",
      "post:post-old",
      "post:post-malformed",
    ],
  );
  assert.equal(timeline.filter((entry) => entry.kind === "post").length, 3);
  assert.equal(timeline[3].post.comments[0].commentId, "nested-comment");
  assert.equal(timeline.at(-1).timestamp, null);
  assert.equal(timeline[0].conversation.title, "Context");
});

test("media identities are stable and owner mapping excludes malformed records", () => {
  const first = mediaEntry();
  const sameIdentity = mediaEntry({
    sourceUrl: "https://img.famly.co/refreshed.jpg?signature=new",
    relativePath: "photos/renamed.jpg",
    filename: "renamed.jpg",
  });
  assert.equal(mediaIdentity(first), mediaIdentity(sameIdentity));

  const comment = mediaEntry({
    mediaId: "comment-image",
    ownerType: "comment",
    ownerId: "comment-1",
    relativePath: "photos/comment.jpg",
    filename: "comment.jpg",
  });
  const invalid = mediaEntry({
    mediaId: "invalid",
    relativePath: "../capture.json",
  });
  invalid.identity = "forged";
  const index = indexMedia([first, comment, invalid]);
  assert.equal(index.byIdentity.size, 2);
  assert.deepEqual(index.byOwner.get("comment:comment-1"), [comment]);
});

test("favorite restoration intersects current media and persists stale removal", () => {
  const valid = mediaEntry().identity;
  const storageValues = new Map([
    [FAVORITES_STORAGE_KEY, JSON.stringify([valid, "stale-identity"])],
  ]);
  const storage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
  };
  const favorites = new FavoriteSelection([valid], storage);
  assert.deepEqual(favorites.values(), [valid]);
  assert.equal(storageValues.get(FAVORITES_STORAGE_KEY), JSON.stringify([valid]));
  assert.equal(favorites.toggle(valid), false);
  assert.deepEqual(favorites.values(), []);
  assert.equal(favorites.toggle("stale-identity"), false);
  assert.equal(favorites.toggle(valid), true);
  assert.equal(storageValues.get(FAVORITES_STORAGE_KEY), JSON.stringify([valid]));
  const afterRestart = new FavoriteSelection([valid], storage);
  assert.deepEqual(afterRestart.values(), [valid]);
});

test("manifest loading reports missing and malformed inputs precisely", async () => {
  const values = new Map([
    [`${ACCESS_PREFIX}/metadata/posts.json`, []],
    [`${ACCESS_PREFIX}/metadata/conversations.json`, []],
    [`${ACCESS_PREFIX}/metadata/media.json`, []],
    [`${ACCESS_PREFIX}/metadata/export-summary.json`, {}],
  ]);
  const fetchOk = async (url) => ({
    ok: true,
    status: 200,
    json: async () => values.get(url),
  });
  const manifests = await loadManifests(fetchOk, ACCESS_PREFIX);
  assert.deepEqual(manifests.posts, []);

  await assert.rejects(
    loadManifests(async (url) => ({
      ok: url !== `${ACCESS_PREFIX}/metadata/media.json`,
      status: 404,
      json: async () => values.get(url),
    }), ACCESS_PREFIX),
    /Could not load \/metadata\/media\.json \(HTTP 404\)/,
  );
  await assert.rejects(
    loadManifests(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === `${ACCESS_PREFIX}/metadata/posts.json`
          ? { unexpected: true }
          : values.get(url),
    }), ACCESS_PREFIX),
    /unexpected shape/,
  );
  await assert.rejects(loadManifests(fetchOk, "/_private/not-a-token"), /access token/);
});

test("fragment access is validated, session-restored, and removed from history", () => {
  const storage = new Map();
  const historyCalls = [];
  const windowObject = {
    location: {
      hash: `#access=${ACCESS_TOKEN}`,
      pathname: "/",
      search: "?view=all",
    },
    history: {
      replaceState: (...args) => historyCalls.push(args),
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  assert.equal(consumeAccessToken(windowObject), ACCESS_TOKEN);
  assert.equal(storage.get(ACCESS_SESSION_KEY), ACCESS_TOKEN);
  assert.deepEqual(historyCalls[0], [null, "", "/?view=all"]);
  assert.equal(privateRoutePrefix(ACCESS_TOKEN), ACCESS_PREFIX);
  assert.equal(privateRoutePrefix("short"), null);

  windowObject.location.hash = "";
  assert.equal(consumeAccessToken(windowObject), ACCESS_TOKEN);
  windowObject.location.hash = "#access=unsafe";
  assert.equal(consumeAccessToken(windowObject), ACCESS_TOKEN);
  assert.equal(historyCalls.length, 2);
});

test("only HTTP(S) external links and safe manifest media paths are accepted", () => {
  assert.equal(
    safeExternalUrl("https://example.com/a?b=1"),
    "https://example.com/a?b=1",
  );
  assert.equal(safeExternalUrl("http://example.com/"), "http://example.com/");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,unsafe"), null);
  assert.equal(safeExternalUrl("not a URL"), null);

  assert.equal(
    safeLocalMediaHref(mediaEntry(), ACCESS_PREFIX),
    `${ACCESS_PREFIX}/photos/original%20image.jpg`,
  );
  assert.equal(
    safeLocalMediaHref(
      mediaEntry({ relativePath: "../metadata/private.json" }),
      ACCESS_PREFIX,
    ),
    null,
  );
  assert.equal(
    safeLocalMediaHref(
      mediaEntry({ relativePath: "metadata/media.json" }),
      ACCESS_PREFIX,
    ),
    null,
  );
  assert.equal(
    safeLocalMediaHref(
      mediaEntry({
        sourceType: "home",
        ownerType: "post",
        kind: "image",
        relativePath: "message-images/wrong-root.jpg",
      }),
      ACCESS_PREFIX,
    ),
    null,
  );
  assert.equal(
    safeLocalMediaHref(
      mediaEntry({ expectedMime: "text/html" }),
      ACCESS_PREFIX,
    ),
    null,
  );
  assert.equal(safeLocalMediaHref(mediaEntry(), "/_private/wrong"), null);
});

test("browser rendering uses original lazy images and accessible favorite controls", () => {
  const source = fs.readFileSync(
    new URL("../scripts/viewer-app.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /image\.src = href/);
  assert.match(source, /image\.loading = "lazy"/);
  assert.match(source, /favoriteButton\.setAttribute\("aria-pressed"/);
  assert.match(source, /imageLink\.addEventListener\("click"/);
  assert.match(source, /favoriteButton\.addEventListener\("click"/);
  assert.doesNotMatch(
    source,
    /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/,
  );
});

test("videos render inline with native browser controls and an original link", () => {
  const entry = mediaEntry({
    mediaId: "video-1",
    kind: "video",
    expectedMime: "video/mp4",
    relativePath: "videos/2026/original video.mp4",
    filename: "original video.mp4",
  });
  const figure = renderInlineVideo(fakeDocument, entry, ACCESS_PREFIX);
  assert.equal(figure.tagName, "figure");
  assert.equal(figure.className, "video-card");
  assert.equal(figure.children.length, 2);

  const [video, caption] = figure.children;
  assert.equal(video.tagName, "video");
  assert.equal(
    video.src,
    `${ACCESS_PREFIX}/videos/2026/original%20video.mp4`,
  );
  assert.equal(video.controls, true);
  assert.equal(video.preload, "metadata");
  assert.equal(video.playsInline, true);
  assert.equal(video.attributes.get("aria-label"), "original video.mp4");

  assert.equal(caption.tagName, "figcaption");
  assert.equal(caption.className, "video-actions");
  assert.equal(caption.children[0].tagName, "a");
  assert.equal(caption.children[0].textContent, "Open original video");
  assert.equal(caption.children[0].href, video.src);
  assert.equal(renderInlineVideo(fakeDocument, mediaEntry(), ACCESS_PREFIX), null);
  assert.equal(renderInlineVideo(fakeDocument, entry, "/_private/wrong"), null);
});

test("only messages with image or video media start expanded", () => {
  const image = mediaEntry({
    sourceType: "message",
    ownerType: "message",
    ownerId: "message-1",
    conversationId: "conversation-1",
    relativePath: "message-images/message-image.jpg",
  });
  const videoFile = mediaEntry({
    mediaId: "message-video",
    sourceType: "message",
    ownerType: "message",
    ownerId: "message-1",
    conversationId: "conversation-1",
    kind: "file",
    expectedMime: "video/mp4",
    relativePath:
      "messages/attachments/conversation-1/message-video.mp4",
    filename: "message-video.mp4",
  });
  const documentFile = mediaEntry({
    mediaId: "message-file",
    sourceType: "message",
    ownerType: "message",
    ownerId: "message-1",
    conversationId: "conversation-1",
    kind: "file",
    expectedMime: "application/pdf",
    relativePath:
      "messages/attachments/conversation-1/message-file.pdf",
    filename: "message-file.pdf",
  });

  assert.deepEqual(messageDisclosureState([]), {
    open: false,
    label: "Text message",
  });
  assert.deepEqual(messageDisclosureState([documentFile]), {
    open: false,
    label: "Message with file attachment",
  });
  assert.deepEqual(messageDisclosureState([image]), {
    open: true,
    label: "Image or video message",
  });
  assert.deepEqual(messageDisclosureState([videoFile]), {
    open: true,
    label: "Image or video message",
  });
  assert.deepEqual(
    messageDisclosureState([
      mediaEntry({
        mediaId: "unsafe",
        relativePath: "../unsafe.jpg",
      }),
    ]),
    { open: false, label: "Text message" },
  );
});
