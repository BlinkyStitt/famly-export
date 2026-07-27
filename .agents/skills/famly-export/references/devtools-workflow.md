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

## 1. Verify the dedicated server

Before calling a browser tool, run:

```sh
codex mcp get famly-chrome
```

Require `chrome-devtools-mcp@1.6.0`,
`--browserUrl=http://127.0.0.1:9223`, `--redactNetworkHeaders`,
`--no-usage-statistics`, `--no-performance-crux`,
`--no-category-network`, `--no-category-performance`, the exact
`--blockedUrlPattern=https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch`,
and `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`. Reject `--autoConnect` and
`--allowUnrestrictedPaths`. If any item is wrong, stop before capture, replace
the entry as documented in `README.md`, and restart Codex.

## 2. Select the authenticated Home tab

Call `list_pages`. Select the Famly page in the manually signed-in dedicated
Famly Chrome profile. Its URL must begin with:

```text
https://app.famly.co/#/account/home
```

If no authenticated Famly page exists, stop and ask the user to sign in
themselves, then open **Home**. Do not request credentials.

## 3. Install the capture hook with a real reload

Read `../scripts/capture-hook.js` completely and pass its entire contents,
verbatim, as `navigate_page.initScript`. Call `navigate_page` with
`type: "reload"`, `ignoreCache: true`, and a 30-second navigation timeout.
Changing the URL or hash is not a substitute: a hash-only navigation does not
execute the initialization script. The hook:

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

## 4. Load the complete Home feed

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

## 5. Open Messages and exhaust the active list

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

## 6. Exhaust the archived list

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

## 7. Record unread state before opening conversations

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

## 8. Open every conversation and reverse-scroll to its terminal page

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

## 9. Save response bodies, checkpoints, and workflow evidence

The one-command runner supplies the only permitted absolute OS-temporary save
path. Do not prepare a second path. After Home, after both conversation lists,
and after each five completed conversations, wait one second for cloned
response bodies and save this exact object with `evaluate_script.filePath` set
to that path:

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

After each save, record its validated phase:

```sh
node .agents/skills/famly-export/scripts/secure-capture.mjs checkpoint \
  '<runner-provided-temp-path>' \
  '<home|conversation-lists|conversations|complete>'
```

This file contains the selected response bodies and browser-completeness
evidence only. It contains no deliberately captured request headers, request
bodies, cookies, or access tokens. Never use `get_network_request` to retrieve
body data because that can expose request headers.

The runner validates the final contract, stages the completed capture, and
keeps the newest valid checkpoint after a failed phase. A later
`./famly-export` resumes a valid checkpoint younger than 24 hours.

If `evaluate_script.filePath` is denied, stop. Correct the `famly-chrome`
configuration, restart Codex, and repeat the capture. Do not save through a
browser download, direct repository path, chunked transfer, or parallel
mechanism.

## 10. Return the capture contract

Return only the JSON success/failure contract required by the runner. The
runner immediately builds, merges, downloads, validates, and transactionally
publishes because signed media URLs expire. Verified existing files are reused;
missing or corrupt content is replaced from fresh URLs.

The runner verifies:

- Home API and DOM post IDs match;
- active-plus-archived IDs equal the captured detail IDs;
- both list views ended on a page shorter than ten;
- every conversation ended on a page shorter than twenty;
- unique post, message, and media counts match their manifests;
- every Home post/comment image is directly under `photos/`, comment image
  records use `ownerType: "comment"` plus the comment ID, every Message image
  is directly under `message-images/`, and non-image Message files use
  `messages/attachments/`;
- every captured message ID has explicit `MessageReactions` response evidence;
- every media path is a nonempty file;
- no `.part` files remain;
- MIME and supported-image decoder validation passed;
- consolidated SHA-256 checksums exist;
- unsupported recognized content is zero and excluded UI assets are counted;
- no credential marker file was reported.
- the fixed viewer shell and module contain no exported private values, load
  the four manifests through the loopback server, and pass the timeline,
  safe-DOM, original-image, favorites, storage, server, and real ZIP fixture
  tests.

After successful publication the runner starts and opens the complete
`http://127.0.0.1:4173/#access=<token>` URL. The fixed shell and module are
public; manifests, redacted media,
original files, and archive APIs require the current
`/_private/<token>/...` prefix. Missing or wrong tokens, raw capture data,
directory listings, traversal, absolute-form requests, arbitrary Host values,
and cross-origin archive requests must remain inaccessible. The stable port
preserves browser-local favorites across token and server restarts.

MP4 and PDF validation is intentionally signature-level through `file`; it is
not a deep `ffprobe` or `qpdf` parse. macOS `file` may report a valid MP4 as
`video/x-m4v`; that exact alias is accepted for `video/mp4` manifest entries.
Report the number of prohibited killswitch attempts blocked locally by the
hook.

## Diagnostic fallback only

No HAR is required for the known API. If in-page response capture stops
working, a temporary ignored HAR may be used only to diagnose the capture
breakage. It must never be the normal export path. Sanitize it without printing
credential values, extract no request headers into permanent output, and
delete the HAR immediately after diagnosis.
