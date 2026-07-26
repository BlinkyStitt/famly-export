import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

import {
  buildExport,
  safeFilename,
  transformCapture,
} from "../scripts/build-export.mjs";

const ACTIVE_COUNT = 11;
const ARCHIVED_COUNT = 1;

function listConversation(conversationId, archived = false, unread = false) {
  return {
    conversationId,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-03T00:00:00Z",
    participants: [
      {
        id: `participant-${conversationId}`,
        title: `Participant ${conversationId}`,
      },
    ],
    loginReads: [],
    title: `Conversation ${conversationId}`,
    archived,
    unread,
  };
}

function message(conversationId, index, overrides = {}) {
  return {
    messageId: `${conversationId}-message-${index}`,
    conversationId,
    createdAt: `2026-01-02T${String(index % 24).padStart(2, "0")}:00:00Z`,
    unread: false,
    behaviors: [],
    loginReads: [{ name: "Reader", image: null }],
    body: `Message ${index}`,
    author: {
      id: "author-1",
      title: "Author",
      me: index % 2 === 0,
    },
    files: [],
    images: [],
    smsIdentifier: null,
    ...overrides,
  };
}

function conversationPage(conversation, messages, cursor = null) {
  const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return {
    url: `https://app.famly.co/api/v2/conversations/${conversation.conversationId}?limit=20${suffix}`,
    data: {
      ...conversation,
      messages,
      cursor,
    },
  };
}

function fixtureCapture() {
  const active = Array.from({ length: ACTIVE_COUNT }, (_, index) =>
    listConversation(`active-${index}`, false, index === 0),
  );
  const archived = [
    listConversation("archived-0", true, false),
  ];
  const homePost = {
    feedItemId: "post-home",
    createdDate: "2026-01-02T12:00:00Z",
    body: "Home post",
    images: [
      {
        imageId: "image-home",
        prefix: "https://img.famly.co",
        width: 1600,
        height: 1200,
        key: "original/photo.jpg?signature=fresh",
      },
    ],
    videos: [
      {
        videoId: "video-home",
        persistenceId: "video-persistence",
        videoUrl:
          "https://famly-video-storage.s3.eu-central-1.amazonaws.com/2026/video/family.mp4?signature=fresh",
      },
    ],
    files: [
      {
        fileId: "file-home",
        filename: "notice.pdf",
        url: "https://famly-de.s3.eu-central-1.amazonaws.com/archive/notice.pdf?signature=fresh",
      },
    ],
  };
  const capture = {
    schemaVersion: 2,
    captureStartedAt: "2026-01-04T00:00:00Z",
    capturedAt: "2026-01-04T00:10:00Z",
    pageUrl: "https://app.famly.co/#/account/inbox",
    feedPages: [
      {
        url: "https://app.famly.co/api/feed/feed/feed?limit=20",
        data: { feedItems: [homePost] },
      },
      {
        url: "https://app.famly.co/api/feed/feed/feed?limit=20&cursor=next",
        data: { feedItems: [structuredClone(homePost)] },
      },
    ],
    conversationListPages: [
      {
        url: "https://app.famly.co/api/v2/conversations?limit=10&offset=0&inbox=OWN&inbox2=1&archived=false",
        data: active.slice(0, 10),
      },
      {
        url: "https://app.famly.co/api/v2/conversations?limit=10&offset=10&inbox=OWN&inbox2=1&archived=false",
        data: active.slice(10),
      },
      {
        url: "https://app.famly.co/api/v2/conversations?limit=10&offset=0&inbox=OWN&inbox2=1&archived=true",
        data: archived,
      },
    ],
    conversationPages: [],
    reactionPages: [],
    workflow: {
      initialUnreadCount: 1,
      home: {
        stableBottomChecks: 8,
        domPostIds: ["post-home"],
      },
      lists: {
        active: {
          showMoreClicks: 1,
          showMoreExhausted: true,
          conversationIds: active.map((conversation) => conversation.conversationId),
        },
        archived: {
          showMoreClicks: 0,
          showMoreExhausted: true,
          conversationIds: archived.map(
            (conversation) => conversation.conversationId,
          ),
        },
      },
      conversations: {},
    },
  };

  for (const conversation of [...active, ...archived]) {
    const run = {
      reverseScrolls: 0,
      terminalShortPage: true,
    };
    if (conversation.conversationId === "active-0") {
      capture.conversationPages.push(
        conversationPage(
          conversation,
          Array.from({ length: 20 }, (_, index) =>
            message(conversation.conversationId, index + 1),
          ),
          "page-2",
        ),
        conversationPage(conversation, [], "terminal-empty"),
      );
      run.reverseScrolls = 1;
    } else if (conversation.conversationId === "active-1") {
      const firstPage = Array.from({ length: 20 }, (_, index) =>
        message(conversation.conversationId, index + 1),
      );
      capture.conversationPages.push(
        conversationPage(conversation, firstPage, "page-2"),
        conversationPage(
          conversation,
          [
            structuredClone(firstPage[0]),
            message(conversation.conversationId, 0),
          ],
          "terminal-short",
        ),
      );
      run.reverseScrolls = 1;
    } else {
      const overrides =
        conversation.conversationId === "active-2"
          ? {
              body: '<script>alert("unsafe")</script> https://drive.google.com/example',
              images: [
                {
                  imageId: "message-image",
                  prefix: "https://img.famly.co",
                  width: 1200,
                  height: 900,
                  key: "messages/original.jpg?signature=fresh",
                },
              ],
              files: [
                {
                  fileId: "message-file",
                  filename: "../../evil.pdf",
                  url: "https://famly-de.s3.eu-central-1.amazonaws.com/archive/evil.pdf?signature=fresh",
                },
              ],
            }
          : {};
      capture.conversationPages.push(
        conversationPage(conversation, [
          message(conversation.conversationId, 1, overrides),
        ]),
      );
    }
    const capturedPages = capture.conversationPages.filter(
      (page) => page.data.conversationId === conversation.conversationId,
    );
    run.messagePages = capturedPages.length;
    run.terminalPageSize = capturedPages.at(-1).data.messages.length;
    capture.workflow.conversations[conversation.conversationId] = run;
  }

  const uniqueMessages = new Map(
    capture.conversationPages.flatMap((page) =>
      page.data.messages.map((item) => [item.messageId, item]),
    ),
  );
  capture.reactionPages.push({
    url: "https://app.famly.co/graphql?MessageReactions",
    data: {
      data: {
        conversations: {
          messageReactions: [...uniqueMessages.keys()].map((messageId) =>
            messageId === "active-2-message-1"
              ? {
                  messageId,
                  count: 2,
                  reactedByMe: { reaction: "HEART" },
                  reactions: [
                    { reaction: "HEART", name: "<Unsafe name>" },
                    { reaction: "LIKE", name: "Another person" },
                  ],
                  __typename: "MessageReactionSummary",
                }
              : {
                  messageId,
                  count: 0,
                  reactedByMe: null,
                  reactions: [],
                  __typename: "MessageReactionSummary",
                },
          ),
        },
      },
    },
  });
  return capture;
}

test("fixture covers list pagination, reverse history, deduplication, reactions, and attachments", () => {
  const result = transformCapture(fixtureCapture());
  assert.equal(result.summary.messages.activeConversations, 11);
  assert.equal(result.summary.messages.archivedConversations, 1);
  assert.deepEqual(result.summary.messages.showMoreClicks, {
    active: 1,
    archived: 0,
  });
  assert.equal(result.conversations.length, 12);
  assert.equal(
    result.conversations.find(
      (conversation) => conversation.conversationId === "active-0",
    ).messages.length,
    20,
  );
  assert.equal(
    result.conversations.find(
      (conversation) => conversation.conversationId === "active-1",
    ).messages.length,
    21,
  );

  const attachmentConversation = result.conversations.find(
    (conversation) => conversation.conversationId === "active-2",
  );
  const attachmentMessage = attachmentConversation.messages[0];
  assert.equal(attachmentMessage.reactionSummary.count, 2);
  assert.equal(attachmentMessage.reactionSummary.reactions.length, 2);
  assert.equal(attachmentMessage.localAttachments.length, 2);
  const imageAttachment = attachmentMessage.localAttachments.find(
    (attachment) => attachment.kind === "image",
  );
  const fileAttachment = attachmentMessage.localAttachments.find(
    (attachment) => attachment.kind === "file",
  );
  assert.ok(
    imageAttachment.localPath.startsWith("message-images/"),
  );
  assert.equal(imageAttachment.localPath.split("/").length, 2);
  assert.ok(
    fileAttachment.localPath.startsWith("messages/attachments/active-2/"),
  );
  assert.ok(
    attachmentMessage.localAttachments.every(
      (attachment) => !attachment.localPath.includes(".."),
    ),
  );

  assert.equal(result.media.length, 5);
  assert.equal(result.summary.media.homeImages, 1);
  assert.equal(result.summary.media.homeVideos, 1);
  assert.equal(result.summary.media.homeFiles, 1);
  assert.equal(result.summary.media.messageImages, 1);
  assert.equal(result.summary.media.messageFiles, 1);
  assert.ok(
    result.media.some(
      (entry) =>
        entry.relativePath ===
        "photos/2026-01-02_post-home_image-home.jpg",
    ),
  );
  assert.ok(
    result.media.every(
      (entry) => !entry.sourceUrl.includes("drive.google.com"),
    ),
  );
});

test("build writes one safely escaped all-messages viewer with attachment links", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "famly-export-test-"));
  const capturePath = path.join(outputRoot, "captured.json");
  const messagesRoot = path.join(outputRoot, "messages");
  fs.mkdirSync(messagesRoot);
  fs.writeFileSync(
    path.join(messagesRoot, "obsolete-conversation.html"),
    "obsolete",
  );
  fs.writeFileSync(capturePath, JSON.stringify(fixtureCapture()));
  const summary = buildExport(capturePath, outputRoot);

  assert.equal(summary.messages.conversations, 12);
  const conversations = JSON.parse(
    fs.readFileSync(path.join(outputRoot, "metadata/conversations.json"), "utf8"),
  );
  const message = conversations
    .find((conversation) => conversation.conversationId === "active-2")
    .messages[0];
  assert.equal(
    message.body,
    '<script>alert("unsafe")</script> https://drive.google.com/example',
  );
  assert.equal(message.files[0].filename, "../../evil.pdf");
  assert.ok(message.localAttachments[1].localPath.endsWith("_evil.pdf"));
  const imageAttachment = message.localAttachments.find(
    (attachment) => attachment.kind === "image",
  );
  const fileAttachment = message.localAttachments.find(
    (attachment) => attachment.kind === "file",
  );

  const html = fs.readFileSync(
    path.join(messagesRoot, "index.html"),
    "utf8",
  );
  assert.equal(
    (html.match(/<section class="conversation"/g) ?? []).length,
    summary.messages.conversations,
  );
  assert.equal(
    (html.match(/<article class="message"/g) ?? []).length,
    summary.messages.messages,
  );
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('<script>alert("unsafe")</script>'));
  assert.ok(
    html.includes(
      'href="https://drive.google.com/example" rel="noreferrer"',
    ),
  );
  assert.ok(!html.includes("<Unsafe name>"));
  assert.ok(
    html.includes(
      `href="../${imageAttachment.localPath}"`,
    ),
  );
  assert.ok(!html.includes("<img"));
  assert.ok(
    html.includes(
      `href="${fileAttachment.localPath.replace(/^messages\//, "")}"`,
    ),
  );
  assert.deepEqual(
    fs.readdirSync(messagesRoot).filter((filename) => filename.endsWith(".html")),
    ["index.html"],
  );
});

test("capture validation requires explicit Show More exhaustion", () => {
  const capture = fixtureCapture();
  capture.workflow.lists.active.showMoreExhausted = false;
  assert.throws(
    () => transformCapture(capture),
    /active Show More was not exhausted/,
  );
});

test("exact message-page multiples require a reverse-scroll terminal page", () => {
  const capture = fixtureCapture();
  capture.conversationPages = capture.conversationPages.filter(
    (page) =>
      !(
        page.data.conversationId === "active-0" &&
        page.data.messages.length === 0
      ),
  );
  assert.throws(
    () => transformCapture(capture),
    /active-0 ended on a full 20-message page/,
  );
});

test("every message requires explicit MessageReactions response evidence", () => {
  const capture = fixtureCapture();
  capture.reactionPages[0].data.data.conversations.messageReactions.pop();
  assert.throws(
    () => transformCapture(capture),
    /Missing MessageReactions evidence for message/,
  );
});

test("safeFilename removes traversal and control characters", () => {
  assert.equal(safeFilename("../../bad\u0000 name.pdf"), "bad name.pdf");
  assert.equal(safeFilename(".."), "attachment");
  assert.equal(safeFilename("folder\\nested\\safe.pdf"), "safe.pdf");
});

test("capture hook blocks the exact Famly killswitch without calling fetch", async () => {
  const hookPath = new URL("../scripts/capture-hook.js", import.meta.url);
  const hook = fs.readFileSync(hookPath, "utf8");
  let realFetchCalls = 0;

  class FakeXMLHttpRequest {
    addEventListener() {}
    open(...args) {
      this.openArguments = args;
    }
  }

  const sandbox = {
    URL,
    Response,
    location: {
      href: "https://app.famly.co/#/account/inbox",
      origin: "https://app.famly.co",
    },
    fetch: async () => {
      realFetchCalls += 1;
      return new Response("{}");
    },
    XMLHttpRequest: FakeXMLHttpRequest,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(hook, sandbox);

  const response = await sandbox.fetch(
    "https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch",
  );
  assert.equal(response.status, 403);
  assert.equal(realFetchCalls, 0);
  assert.equal(sandbox.__famlyExportCapture.blockedKillswitchRequests, 1);

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open(
    "GET",
    "https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch",
    true,
  );
  assert.equal(xhr.openArguments[1], "data:application/json,%7B%7D");
  assert.equal(sandbox.__famlyExportCapture.blockedKillswitchRequests, 2);
});
