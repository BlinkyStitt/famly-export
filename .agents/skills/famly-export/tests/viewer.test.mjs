import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  FAVORITES_STORAGE_KEY,
  FavoriteSelection,
  buildTimeline,
  indexMedia,
  loadManifests,
  mediaIdentity,
  safeExternalUrl,
  safeLocalMediaHref,
} from "../scripts/viewer-app.mjs";

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
    ["/metadata/posts.json", []],
    ["/metadata/conversations.json", []],
    ["/metadata/media.json", []],
    ["/metadata/export-summary.json", {}],
  ]);
  const fetchOk = async (url) => ({
    ok: true,
    status: 200,
    json: async () => values.get(url),
  });
  const manifests = await loadManifests(fetchOk);
  assert.deepEqual(manifests.posts, []);

  await assert.rejects(
    loadManifests(async (url) => ({
      ok: url !== "/metadata/media.json",
      status: 404,
      json: async () => values.get(url),
    })),
    /Could not load \/metadata\/media\.json \(HTTP 404\)/,
  );
  await assert.rejects(
    loadManifests(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/metadata/posts.json" ? { unexpected: true } : values.get(url),
    })),
    /unexpected shape/,
  );
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
    safeLocalMediaHref(mediaEntry()),
    "/photos/original%20image.jpg",
  );
  assert.equal(
    safeLocalMediaHref(mediaEntry({ relativePath: "../metadata/private.json" })),
    null,
  );
  assert.equal(
    safeLocalMediaHref(mediaEntry({ relativePath: "metadata/media.json" })),
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
    ),
    null,
  );
  assert.equal(
    safeLocalMediaHref(mediaEntry({ expectedMime: "text/html" })),
    null,
  );
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
