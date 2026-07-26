# Chrome DevTools capture workflow

Use these snippets with the `famly-chrome` Chrome DevTools MCP server. Keep the
Famly tab selected throughout the capture.

## 1. Select the authenticated Home tab

Call `list_pages`. Select the page whose URL starts with:

```text
https://app.famly.co/#/account/home
```

If no such page exists, ask the user to sign in to Famly in that Chrome profile
and open **Home**. Do not navigate to a search engine, switch profiles, or
request credentials.

## 2. Reload with response capture installed

Call `navigate_page` with `type: "reload"`, `ignoreCache: true`, and the exact
script below as `initScript`.

```js
(() => {
  const state = {
    startedAt: new Date().toISOString(),
    feedPages: [],
    seenUrls: Object.create(null),
  };
  globalThis.__famlyExportCapture = state;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);

    try {
      const requestUrl = new URL(
        response.url || String(args[0]),
        globalThis.location.href,
      );

      if (
        requestUrl.origin === globalThis.location.origin &&
        requestUrl.pathname === "/api/feed/feed/feed" &&
        response.ok
      ) {
        const responseCopy = response.clone();

        void responseCopy
          .json()
          .then((data) => {
            if (
              data &&
              Array.isArray(data.feedItems) &&
              !state.seenUrls[requestUrl.href]
            ) {
              state.seenUrls[requestUrl.href] = true;
              state.feedPages.push({
                url: requestUrl.href,
                data,
              });
            }
          })
          .catch(() => {});
      }
    } catch {
      // Never interfere with Famly's own request.
    }

    return response;
  };
})();
```

Wait for the Home page to render. Confirm the hook and initial response exist:

```js
() => ({
  pageUrl: globalThis.location.href,
  hookInstalled: Boolean(globalThis.__famlyExportCapture),
  feedPages: globalThis.__famlyExportCapture?.feedPages.length ?? 0,
  scrollContainer: Boolean(document.querySelector("main#content")),
})
```

Do not continue unless `hookInstalled` and `scrollContainer` are true and
`feedPages` becomes at least one.

## 3. Load the complete infinite feed

Run the following `evaluate_script` call as one batch. A batch lasts at most
about 32 seconds. Wait for it to finish before deciding whether another batch
is needed.

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

  const postIds = new Set(
    [...document.querySelectorAll('a[href*="/account/post/"]')]
      .map((link) =>
        link.getAttribute("href")?.match(/\/account\/post\/([^/?#]+)/)?.[1],
      )
      .filter(Boolean),
  );

  return {
    iterations,
    stableChecks,
    totalGrowth,
    scrollTop: feed.scrollTop,
    scrollHeight: feed.scrollHeight,
    domPostLinks: postIds.size,
    capturedFeedPages:
      globalThis.__famlyExportCapture?.feedPages.length ?? 0,
  };
}
```

If `stableChecks` is less than eight, run another batch from the current
position. If a call exceeds its client timeout, do not immediately repeat it:
first make one short state query to determine whether the browser completed
the batch.

## 4. Save response bodies and capture evidence

After the stable-end batch, wait two seconds and call `evaluate_script` with
the absolute output path as `filePath` and the function below:

```js
() => {
  const capture = globalThis.__famlyExportCapture;
  if (!capture || !Array.isArray(capture.feedPages)) {
    throw new Error("Famly feed response capture is unavailable");
  }

  const domPostIds = new Set(
    [...document.querySelectorAll('a[href*="/account/post/"]')]
      .map((link) =>
        link.getAttribute("href")?.match(/\/account\/post\/([^/?#]+)/)?.[1],
      )
      .filter(Boolean),
  );

  const capturedItems = capture.feedPages.flatMap(
    (page) => page.data?.feedItems ?? [],
  );
  const capturedIds = new Set(
    capturedItems.map((item) => item.feedItemId).filter(Boolean),
  );

  return {
    capturedAt: new Date().toISOString(),
    captureStartedAt: capture.startedAt,
    pageUrl: globalThis.location.href,
    domPostLinks: domPostIds.size,
    capturedFeedPages: capture.feedPages.length,
    capturedFeedItems: capturedItems.length,
    uniqueFeedItems: capturedIds.size,
    feedPages: capture.feedPages,
  };
}
```

The saved file contains response bodies only. Do not use
`get_network_request` to obtain these pages: depending on MCP configuration,
that tool can print Famly request headers and access tokens.
