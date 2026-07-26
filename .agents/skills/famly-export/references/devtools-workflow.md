# Chrome DevTools capture workflow

Use only the `famly-chrome` Chrome DevTools MCP server. Keep the same Famly tab
selected throughout the capture. Never inspect request headers, cookies,
browser storage, access tokens, or profile files.

> **Warning:** Exporting Messages opens each conversation and may mark unread
> conversations as read. The exporter records the initial unread count but
> does not restore unread state.

The exact URL
`https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch` is
prohibited during this workflow. The capture hook intercepts both Fetch and
XHR attempts before the real network call. Do not manually navigate to, fetch,
open, probe, or otherwise load it.

## 1. Select the authenticated tab

Call `list_pages`. Select the Famly page in the signed-in Chrome profile. Its
URL must begin with:

```text
https://app.famly.co/#/account/
```

If no authenticated Famly page exists, stop and ask the user to sign in
themselves, then open **Home**. Do not request credentials.

## 2. Install the capture hook on Home

Read `../scripts/capture-hook.js` completely and pass its entire contents,
verbatim, as `navigate_page.initScript`. Navigate to:

```text
https://app.famly.co/#/account/home
```

Use a 30-second navigation timeout. The hook:

- blocks the prohibited killswitch URL locally;
- captures successful JSON response bodies for Home feed pages;
- captures active and archived conversation-list response bodies;
- captures paginated conversation-detail response bodies;
- captures `MessageReactions` GraphQL response bodies;
- never records request headers, request bodies, cookies, or tokens.

Confirm the hook and first Home page:

```js
async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const capture = globalThis.__famlyExportCapture;
  return {
    pageUrl: globalThis.location.href,
    schemaVersion: capture?.schemaVersion ?? null,
    feedPages: capture?.feedPages?.length ?? 0,
    blockedKillswitchRequests: capture?.blockedKillswitchRequests ?? 0,
    scrollContainer: Boolean(document.querySelector("main#content")),
  };
}
```

Do not continue unless `schemaVersion` is `2`, `feedPages` is at least one,
and `scrollContainer` is true.

## 3. Load the complete Home feed

Run this bounded batch and wait for it to finish. Never start a second batch
while the first is running.

```js
async () => {
  const feed = document.querySelector("main#content");
  if (!feed) {
    throw new Error("Famly Home feed scroll container was not found");
  }

  let stableChecks = 0;
  let previousHeight = feed.scrollHeight;
  let totalGrowth = 0;
  let iterations = 0;

  for (; iterations < 35 && stableChecks < 8; iterations += 1) {
    feed.scrollTop = feed.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 900));

    const currentHeight = feed.scrollHeight;
    const atBottom =
      feed.scrollTop + feed.clientHeight >= currentHeight - 8;

    totalGrowth += Math.max(0, currentHeight - previousHeight);
    stableChecks =
      currentHeight === previousHeight && atBottom
        ? stableChecks + 1
        : 0;
    previousHeight = currentHeight;
  }

  return {
    iterations,
    stableChecks,
    totalGrowth,
    scrollTop: feed.scrollTop,
    scrollHeight: feed.scrollHeight,
    capturedFeedPages:
      globalThis.__famlyExportCapture?.feedPages?.length ?? 0,
  };
}
```

If `stableChecks` is less than eight, run another batch from the current
position. If a call times out, make one short state query before deciding
whether the existing batch completed. Do not launch a duplicate command.

After reaching eight stable checks, record exact DOM evidence:

```js
() => {
  const capture = globalThis.__famlyExportCapture;
  if (!capture) {
    throw new Error("Famly response capture is unavailable");
  }
  const domPostIds = [
    ...new Set(
      [...document.querySelectorAll('a[href*="/account/post/"]')]
        .map((link) =>
          link
            .getAttribute("href")
            ?.match(/\/account\/post\/([^/?#]+)/)?.[1],
        )
        .filter(Boolean),
    ),
  ];
  const apiPostIds = [
    ...new Set(
      capture.feedPages
        .flatMap((page) => page.data?.feedItems ?? [])
        .map((post) => post.feedItemId)
        .filter(Boolean),
    ),
  ];
  capture.workflow.home = {
    stableBottomChecks: 8,
    domPostIds,
    apiPostIds,
  };
  return {
    domPosts: domPostIds.length,
    apiPosts: apiPostIds.length,
    equal:
      domPostIds.length === apiPostIds.length &&
      domPostIds.every((id) => apiPostIds.includes(id)),
  };
}
```

Do not proceed if `equal` is false.

## 4. Open Messages and exhaust the active list

Repeat the unread-state warning to the user immediately before this step:

> Exporting Messages opens each conversation and may mark unread conversations
> as read. The exporter records the initial unread count but does not restore
> unread state.

Navigate within the existing document so the capture hook remains installed:

```js
async () => {
  globalThis.location.hash = "#/account/inbox";
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const hasInitialPage =
      globalThis.__famlyExportCapture?.conversationListPages?.some((page) => {
        const url = new URL(page.url);
        return (
          url.pathname === "/api/v2/conversations" &&
          url.searchParams.get("limit") === "10" &&
          url.searchParams.get("offset") === "0" &&
          url.searchParams.get("inbox") === "OWN" &&
          url.searchParams.get("archived") === "false"
        );
      }) ?? false;
    if (hasInitialPage) {
      return { pageUrl: globalThis.location.href };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The active conversation list did not load");
}
```

Click the visible **Show More** control until it disappears. This explicit
control is required even if the first page contains exactly ten conversations.

```js
async () => {
  const capture = globalThis.__famlyExportCapture;
  if (!capture) {
    throw new Error("Famly response capture is unavailable");
  }
  const relevantPages = () =>
    capture.conversationListPages.filter((page) => {
      const url = new URL(page.url);
      return (
        url.pathname === "/api/v2/conversations" &&
        url.searchParams.get("limit") === "10" &&
        url.searchParams.get("inbox") === "OWN" &&
        url.searchParams.get("archived") === "false"
      );
    });
  const showMore = () =>
    [...document.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 &&
        /^Show More$/i.test((element.textContent || "").trim()),
    );

  let showMoreClicks = 0;
  while (showMore()) {
    const before = relevantPages().length;
    showMore().click();
    const started = Date.now();
    while (relevantPages().length === before && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (relevantPages().length === before) {
      throw new Error("Active Show More did not produce another API page");
    }
    showMoreClicks += 1;
  }

  const conversationIds = [
    ...new Set(
      [...document.querySelectorAll('a[href*="conversationId="]')]
        .map((link) => {
          const match = link
            .getAttribute("href")
            ?.match(/[?&]conversationId=([^&#]+)/);
          return match ? decodeURIComponent(match[1]) : null;
        })
        .filter(Boolean),
    ),
  ];
  capture.workflow.lists.active = {
    showMoreClicks,
    showMoreExhausted: true,
    conversationIds,
  };
  return {
    showMoreClicks,
    conversations: conversationIds.length,
    terminalPageSize: relevantPages().at(-1)?.data?.length ?? null,
  };
}
```

The returned terminal page size must be less than ten.

## 5. Exhaust the archived list

Open the Messages-level options menu and choose **Show archived messages**:

```js
async () => {
  const menu = document.querySelector(
    'button[aria-label="More options"]',
  );
  if (!menu) {
    throw new Error("Messages More options button was not found");
  }
  menu.click();

  const started = Date.now();
  let option = null;
  while (!option && Date.now() - started < 5000) {
    const label = [...document.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 &&
        (element.textContent || "").trim() === "Show archived messages",
    );
    option = label?.closest("button") ?? null;
    if (!option) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!option) {
    throw new Error("Show archived messages option was not found");
  }
  option.click();

  const capture = globalThis.__famlyExportCapture;
  const listStarted = Date.now();
  while (Date.now() - listStarted < 15000) {
    const loaded = capture.conversationListPages.some((page) => {
      const url = new URL(page.url);
      return (
        url.pathname === "/api/v2/conversations" &&
        url.searchParams.get("limit") === "10" &&
        url.searchParams.get("offset") === "0" &&
        url.searchParams.get("inbox") === "OWN" &&
        url.searchParams.get("archived") === "true"
      );
    });
    if (loaded) {
      return { archivedLoaded: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The archived conversation list did not load");
}
```

Then exhaust archived **Show More** with the archived form of the same loop:

```js
async () => {
  const capture = globalThis.__famlyExportCapture;
  const relevantPages = () =>
    capture.conversationListPages.filter((page) => {
      const url = new URL(page.url);
      return (
        url.pathname === "/api/v2/conversations" &&
        url.searchParams.get("limit") === "10" &&
        url.searchParams.get("inbox") === "OWN" &&
        url.searchParams.get("archived") === "true"
      );
    });
  const showMore = () =>
    [...document.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 &&
        /^Show More$/i.test((element.textContent || "").trim()),
    );

  let showMoreClicks = 0;
  while (showMore()) {
    const before = relevantPages().length;
    showMore().click();
    const started = Date.now();
    while (relevantPages().length === before && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (relevantPages().length === before) {
      throw new Error("Archived Show More did not produce another API page");
    }
    showMoreClicks += 1;
  }

  const conversationIds = [
    ...new Set(
      [...document.querySelectorAll('a[href*="conversationId="]')]
        .map((link) => {
          const match = link
            .getAttribute("href")
            ?.match(/[?&]conversationId=([^&#]+)/);
          return match ? decodeURIComponent(match[1]) : null;
        })
        .filter(Boolean),
    ),
  ];
  capture.workflow.lists.archived = {
    showMoreClicks,
    showMoreExhausted: true,
    conversationIds,
  };
  return {
    showMoreClicks,
    conversations: conversationIds.length,
    terminalPageSize: relevantPages().at(-1)?.data?.length ?? null,
  };
}
```

The returned terminal page size must be less than ten. Zero archived
conversations is valid when the captured offset-zero response is empty.

## 6. Record unread state before opening conversations

This must happen after both complete lists and before the first conversation
is opened:

```js
() => {
  const capture = globalThis.__famlyExportCapture;
  const expectedIds = new Set([
    ...capture.workflow.lists.active.conversationIds,
    ...capture.workflow.lists.archived.conversationIds,
  ]);
  const records = new Map();
  for (const page of capture.conversationListPages) {
    const url = new URL(page.url);
    if (
      url.pathname !== "/api/v2/conversations" ||
      url.searchParams.get("limit") !== "10" ||
      url.searchParams.get("inbox") !== "OWN"
    ) {
      continue;
    }
    for (const conversation of page.data ?? []) {
      if (expectedIds.has(conversation.conversationId)) {
        records.set(conversation.conversationId, conversation);
      }
    }
  }
  if (records.size !== expectedIds.size) {
    throw new Error("Unread-state records do not cover every conversation");
  }
  capture.workflow.initialUnreadCount = [...records.values()].filter(
    (conversation) => Boolean(conversation.unread),
  ).length;
  return {
    conversations: expectedIds.size,
    initialUnreadCount: capture.workflow.initialUnreadCount,
  };
}
```

## 7. Open every conversation and reverse-scroll to its terminal page

If the archived view is still open, return to the active inbox first:

```js
async () => {
  const back = document.querySelector('button[aria-label="Back to inbox"]');
  if (back) {
    back.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { pageUrl: globalThis.location.href };
}
```

Run this as one long operation and wait for its exit result. Do not poll
process state or start a duplicate operation.

```js
async () => {
  const capture = globalThis.__famlyExportCapture;
  if (!capture) {
    throw new Error("Famly response capture is unavailable");
  }
  const conversationIds = [
    ...capture.workflow.lists.active.conversationIds,
    ...capture.workflow.lists.archived.conversationIds,
  ];
  const waitFor = async (predicate, message, timeout = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = predicate();
      if (value) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  const pagesFor = (conversationId) =>
    capture.conversationPages.filter(
      (page) => page.data?.conversationId === conversationId,
    );

  for (const conversationId of conversationIds) {
    const beforeOpen = pagesFor(conversationId).length;
    globalThis.location.hash =
      `#/account/inbox?conversationId=${encodeURIComponent(conversationId)}`;
    await waitFor(
      () => pagesFor(conversationId).length > beforeOpen,
      `Conversation ${conversationId} did not load`,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    let reverseScrolls = 0;
    while (
      pagesFor(conversationId).at(-1)?.data?.messages?.length === 20
    ) {
      const pane = await waitFor(
        () => document.querySelector("#reactConversationMessages"),
        `Message pane ${conversationId} was not found`,
      );
      const beforePage = pagesFor(conversationId).length;
      pane.scrollTop = -pane.scrollHeight;
      pane.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitFor(
        () => pagesFor(conversationId).length > beforePage,
        `Reverse scroll did not load older messages for ${conversationId}`,
      );
      reverseScrolls += 1;
      if (reverseScrolls > 1000) {
        throw new Error(
          `Conversation ${conversationId} exceeded the history-page guard`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    const terminalSize =
      pagesFor(conversationId).at(-1)?.data?.messages?.length;
    if (!Number.isInteger(terminalSize) || terminalSize >= 20) {
      throw new Error(
        `Conversation ${conversationId} lacks a terminal short page`,
      );
    }
    const expectedMessageIds = [
      ...new Set(
        pagesFor(conversationId)
          .flatMap((page) => page.data?.messages ?? [])
          .map((message) => message.messageId)
          .filter(Boolean),
      ),
    ];
    await waitFor(
      () => {
        const coveredMessageIds = new Set(
          capture.reactionPages.flatMap(
            (page) =>
              page.data?.data?.conversations?.messageReactions?.map(
                (reaction) => reaction.messageId,
              ) ?? [],
          ),
        );
        return expectedMessageIds.every((id) => coveredMessageIds.has(id));
      },
      `MessageReactions evidence is incomplete for ${conversationId}`,
    );
    capture.workflow.conversations[conversationId] = {
      reverseScrolls,
      terminalShortPage: true,
      terminalPageSize: terminalSize,
      messagePages: pagesFor(conversationId).length,
    };
  }

  const capturedIds = [
    ...new Set(
      capture.conversationPages
        .map((page) => page.data?.conversationId)
        .filter(Boolean),
    ),
  ];
  if (
    capturedIds.length !== conversationIds.length ||
    conversationIds.some((id) => !capturedIds.includes(id))
  ) {
    throw new Error(
      "Captured conversation IDs do not equal active plus archived IDs",
    );
  }
  return {
    conversations: conversationIds.length,
    capturedConversations: capturedIds.length,
    messagePages: capture.conversationPages.length,
    reactionPages: capture.reactionPages.length,
  };
}
```

The extra empty or short request after an exact multiple of 20 messages is
intentional and required completeness evidence. Do not advance to the next
conversation until `MessageReactions` contains an explicit entry for every
captured message ID, including zero-reaction entries.

## 8. Save response bodies and workflow evidence

Wait one second for cloned response bodies, then save this exact object with
`evaluate_script.filePath` set to the absolute path:

```text
<output-root>/metadata/captured-export.json
```

```js
async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const capture = globalThis.__famlyExportCapture;
  if (!capture) {
    throw new Error("Famly response capture is unavailable");
  }
  return {
    schemaVersion: capture.schemaVersion,
    capturedAt: new Date().toISOString(),
    captureStartedAt: capture.startedAt,
    pageUrl: globalThis.location.href,
    blockedKillswitchRequests: capture.blockedKillswitchRequests,
    feedPages: capture.feedPages,
    conversationListPages: capture.conversationListPages,
    conversationPages: capture.conversationPages,
    reactionPages: capture.reactionPages,
    workflow: capture.workflow,
  };
}
```

This file contains the selected response bodies and browser-completeness
evidence only. It contains no deliberately captured request headers, request
bodies, cookies, or access tokens. Never use `get_network_request` to retrieve
body data because that can expose request headers.

## 9. Build, download, and validate

From the workspace root:

```sh
node .agents/skills/famly-export/scripts/build-export.mjs \
  metadata/captured-export.json \
  .

bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

Run the downloader immediately because the Home video and file URLs expire.
Completed photo paths are preserved and skipped. If a signed URL expires,
recapture and rerun; completed files remain in place.

Read `metadata/export-summary.json` and verify:

- Home API and DOM post IDs match;
- active-plus-archived IDs equal the captured detail IDs;
- both list views ended on a page shorter than ten;
- every conversation ended on a page shorter than twenty;
- unique post, message, and media counts match their manifests;
- every media path is a nonempty file;
- no `.part` files remain;
- MIME and supported-image decoder validation passed;
- consolidated SHA-256 checksums exist;
- unsupported media is explicitly reported;
- no credential marker file was reported.

MP4 and PDF validation is intentionally signature-level through `file`; it is
not a deep `ffprobe` or `qpdf` parse.

## Diagnostic fallback only

No HAR is required for the known API. If in-page response capture stops
working, a temporary ignored HAR may be used only to diagnose the capture
breakage. It must never be the normal export path. Sanitize it without printing
credential values, extract no request headers into permanent output, and
delete the HAR immediately after diagnosis.
