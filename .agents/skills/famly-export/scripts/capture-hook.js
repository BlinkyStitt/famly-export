(() => {
  const FORBIDDEN_KILLSWITCH =
    "https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch";
  const state = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    feedPages: [],
    conversationListPages: [],
    conversationPages: [],
    reactionPages: [],
    blockedKillswitchRequests: 0,
    seenResponseUrls: Object.create(null),
    workflow: {
      home: null,
      lists: {
        active: null,
        archived: null,
      },
      conversations: Object.create(null),
    },
  };
  globalThis.__famlyExportCapture = state;

  const absoluteUrl = (input) => {
    const value =
      typeof input === "string" || input instanceof URL ? input : input?.url;
    return new URL(String(value), globalThis.location.href);
  };

  const isForbiddenKillswitch = (input) => {
    try {
      return absoluteUrl(input).href === FORBIDDEN_KILLSWITCH;
    } catch {
      return false;
    }
  };

  const captureJson = (urlValue, status, data, transport) => {
    try {
      const url = absoluteUrl(urlValue);
      if (
        url.origin !== globalThis.location.origin ||
        status < 200 ||
        status >= 300
      ) {
        return;
      }

      let collection = null;
      let deduplicate = true;
      if (
        url.pathname === "/api/feed/feed/feed" &&
        Array.isArray(data?.feedItems)
      ) {
        collection = state.feedPages;
      } else if (
        url.pathname === "/api/v2/conversations" &&
        Array.isArray(data)
      ) {
        collection = state.conversationListPages;
      } else if (
        /^\/api\/v2\/conversations\/[^/]+$/.test(url.pathname) &&
        Array.isArray(data?.messages)
      ) {
        collection = state.conversationPages;
      } else if (
        url.pathname === "/graphql" &&
        url.searchParams.has("MessageReactions") &&
        Array.isArray(data?.data?.conversations?.messageReactions)
      ) {
        collection = state.reactionPages;
        deduplicate = false;
      }

      if (!collection) {
        return;
      }
      const responseKey = `${collection === state.feedPages ? "feed" : collection === state.conversationListPages ? "list" : collection === state.conversationPages ? "conversation" : "reaction"}:${url.href}`;
      if (deduplicate && state.seenResponseUrls[responseKey]) {
        return;
      }
      state.seenResponseUrls[responseKey] = true;
      collection.push({
        capturedAt: new Date().toISOString(),
        url: url.href,
        transport,
        data,
      });
    } catch {
      // Capture must never interfere with Famly's own successful response.
    }
  };

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    if (isForbiddenKillswitch(args[0])) {
      state.blockedKillswitchRequests += 1;
      return new Response("", {
        status: 403,
        statusText: "Blocked by private Famly export",
      });
    }

    const response = await originalFetch(...args);
    try {
      const responseCopy = response.clone();
      void responseCopy
        .json()
        .then((data) =>
          captureJson(
            response.url || absoluteUrl(args[0]).href,
            response.status,
            data,
            "fetch",
          ),
        )
        .catch(() => {});
    } catch {
      // Non-JSON responses are outside this export.
    }
    return response;
  };

  const OriginalXMLHttpRequest = globalThis.XMLHttpRequest;
  class CapturingXMLHttpRequest extends OriginalXMLHttpRequest {
    constructor() {
      super();
      this.addEventListener("load", () => {
        try {
          const data =
            this.responseType === "json"
              ? this.response
              : JSON.parse(this.responseText);
          captureJson(this.responseURL, this.status, data, "xhr");
        } catch {
          // Non-JSON responses are outside this export.
        }
      });
    }

    open(method, url, ...rest) {
      if (isForbiddenKillswitch(url)) {
        state.blockedKillswitchRequests += 1;
        return super.open(
          "GET",
          "data:application/json,%7B%7D",
          rest[0] ?? true,
        );
      }
      return super.open(method, url, ...rest);
    }
  }
  globalThis.XMLHttpRequest = CapturingXMLHttpRequest;
})();
