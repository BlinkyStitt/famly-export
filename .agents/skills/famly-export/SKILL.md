---
name: famly-export
description: Export a signed-in Famly Home feed and complete active and archived Messages history for a private offline backup through the isolated famly-chrome Chrome DevTools MCP server. Captures response bodies without request credentials, downloads original media without exposing signed URLs in process arguments, and builds lossless manifests plus a token-authenticated loopback viewer.
---

# Famly Export

Export only data the user is authorized to access. Treat all captured response
bodies, JSON, HTML, and media as private. Never commit or upload private export
output.

Never ask for or inspect the user's Famly password, request headers, cookies,
local storage, session store, access tokens, or browser profile files.

> **Warning:** Exporting Messages opens each conversation and may mark unread
> conversations as read. The exporter records the initial unread count but
> does not restore unread state.

State that warning prominently before browser automation and repeat it
immediately before opening Messages.

## Required isolated browser

Use only the Chrome DevTools MCP server named `famly-chrome`. It must connect
to the ordinary visible Chrome instance launched by:

```sh
bash .agents/skills/famly-export/scripts/launch-famly-chrome.sh
```

That launcher uses only:

```text
profile: /Users/bryan/Library/Application Support/Famly Export Chrome
DevTools: http://127.0.0.1:9223
profile mode: 0700
```

The user signs in to Famly manually in this dedicated profile and opens Home.
Never attach to or inspect the normal Chrome profile.

Before browser work, run `codex mcp get famly-chrome`. Require all of:

```text
chrome-devtools-mcp@1.6.0
--browserUrl=http://127.0.0.1:9223
--redactNetworkHeaders
--no-usage-statistics
--no-performance-crux
--no-category-network
--no-category-performance
--blockedUrlPattern=https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
```

Reject the configuration if it contains `--autoConnect` or
`--allowUnrestrictedPaths`. If any requirement is wrong, stop before capture,
replace the entry exactly as documented in `README.md`, and restart Codex.
Never create a secondary capture-save path.

The exact URL below is prohibited:

```text
https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

Never navigate to, fetch, probe, or otherwise load it. The MCP block is the
outer boundary, and the required capture hook also blocks Fetch and XHR locally.

If `famly-chrome` is unavailable, ask the user to complete the README setup.
Require an authenticated tab whose URL starts with
`https://app.famly.co/#/account/home`. If absent, ask the user to sign in and
open Home themselves.

Before browser work, read `references/devtools-workflow.md` and
`scripts/capture-hook.js` completely. Pass the hook contents verbatim as the
navigation `initScript`.

## Prerequisites

1. Resolve output root to this workspace unless the user supplied a narrower
   directory.
2. Confirm `node`, `jq`, `curl`, `xargs`, `file`, `shasum`, `sips`, `find`,
   `grep`, `lsof`, and native macOS `ditto` exist.
3. Confirm sufficient disk space.
4. Confirm `metadata/`, `photos/`, `message-images/`, `videos/`, `files/`, and
   `messages/` are ignored by Git.
5. Set shell/process umask to `077`.

## Capture workflow

Follow the browser reference in order:

1. Select the authenticated dedicated-profile Famly Home tab.
2. Perform a real `navigate_page` reload with `ignoreCache: true` and the exact
   capture hook as `initScript`. Require capture schema version 2, a feed page,
   the Home scroll container, and the locally blocked-attempt counter.
3. Scroll `main#content` in bounded batches until eight consecutive stable
   bottom checks. Wait for each batch; never start a duplicate.
4. Require exact equality between rendered Home post IDs and unique captured
   feed post IDs.
5. Repeat the unread warning, open Messages, and exhaust **Show More** in both
   active and archived views.
6. Record the complete initial unread-conversation count before opening any
   conversation.
7. Open every conversation. Reverse-scroll
   `#reactConversationMessages` until each returns a page shorter than 20.
   Exact multiples require the extra empty or short request. Require explicit
   `MessageReactions` evidence for every message, including zero reactions.
8. Require captured detail IDs to equal the complete active-plus-archived list.
9. Prepare the sole permitted browser-save path:

   ```sh
   node .agents/skills/famly-export/scripts/secure-capture.mjs prepare
   ```

10. Save the final exact capture object through `evaluate_script.filePath` to
    the printed OS-temporary `captured-export.json` path.
11. Finalize it:

    ```sh
    node .agents/skills/famly-export/scripts/secure-capture.mjs finalize \
      '<printed-temp-path>' \
      .
    ```

Finalization validates a current-user regular file, private temp containment,
JSON, and schema version 2; copies through a random `0600` metadata temp file;
fsyncs and atomically renames to `metadata/captured-export.json`; then removes
the capture directory. On failure it preserves the capture privately and
reports its retry path. `prepare` sweeps current-user captures older than 24
hours.

Never call `get_network_request` for bodies because it can expose headers.
Never use a browser download, direct repository save, chunked transfer, or
parallel capture representation.

## Build and download

Run from the workspace root:

```sh
node .agents/skills/famly-export/scripts/build-export.mjs \
  metadata/captured-export.json \
  .

bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

The transformer preserves the four authoritative manifests:

- `metadata/posts.json`
- `metadata/conversations.json`
- `metadata/media.json`
- `metadata/export-summary.json`

It also writes the fixed `messages/index.html` and
`messages/viewer-app.mjs`, which contain no exported records.

The downloader gives workers only manifest indexes. Workers read signed URLs
from `media.json`, require exactly `img.famly.co`,
`famly-de.s3.eu-central-1.amazonaws.com`, or
`famly-video-storage.s3.eu-central-1.amazonaws.com` over HTTPS with visible safe
URL characters, reject the exact killswitch locally, allow only HTTPS
redirects, and supply URLs to `curl` through stdin configuration. URLs must
never appear in `xargs`, shell, or curl arguments.

All capture/build/download paths share owner checks, canonical export-root
containment, rejection of symlinks/devices/sockets, directory `0700`, file
`0600`, and umask `077`. Downloads remain resumable through private `.part`
files and atomic rename. Preserve original media and established paths.

For an existing export, run:

```sh
node .agents/skills/famly-export/scripts/private-tree.mjs harden .
```

Verify content checksums are unchanged before and after this mode-only pass.

## Authenticated local viewer

Launch with:

```sh
node .agents/skills/famly-export/scripts/serve-export.mjs .
```

It binds only to `127.0.0.1:4173` and prints:

```text
http://127.0.0.1:4173/#access=<fresh-256-bit-token>
```

The shell validates the fragment, stores it only in `sessionStorage`, and
removes it from browser history. The token is never in argv, environment,
cookies, or tracked files. Favorites remain under the existing versioned
`localStorage` key and survive token/server restarts on the stable origin.

Only the fixed shell and browser module are public. Manifests, media, and
archive APIs require `/_private/<token>/...`; missing or incorrect tokens
return `404`. Require exact `Host: 127.0.0.1:<active-port>`, reject
absolute-form requests, retain loopback binding, no CORS, traversal rejection,
realpath containment, and same-origin archive checks. The viewer `media.json`
response must omit `sourceUrl`.

Favorites ZIPs use an additional 192-bit one-time token, `0700` directories,
`0600` ZIPs, expiry, signal cleanup, and startup deletion of current-user
`famly-favorites-*` remnants older than one hour. Archive URLs must match the
current private prefix.

Warn that ZIPs are conventional unencrypted archives and browser-controlled
destination permissions apply.

## Required validation

Do not report completion unless all checks pass:

- Home API IDs equal rendered Home IDs;
- active and archived lists each terminate below ten;
- captured detail IDs equal active plus archived IDs;
- every conversation terminates below twenty;
- post, message, reaction, and media counts agree;
- every message has explicit reaction evidence;
- every manifest media path is nonempty and safe;
- comment images use `ownerType: "comment"`, the comment ID, and flat
  `photos/<filename>` paths;
- zero `.part` files remain;
- `file` MIME/signatures match and `sips` decodes supported images;
- SHA-256 checksums cover every media path;
- unsupported attachments/media are reported;
- generated artifacts contain no `x-famly-accesstoken` or
  `famly.session-marker`;
- fixtures cover capture lifecycle, private modes/ownership/containment,
  symlink and non-regular rejection, checksum-preserving hardening, downloader
  URL/argv/resume behavior, fragment/session/token rotation, exact Host and
  token rejection, signed-URL redaction, raw-capture denial, headers,
  traversal, MIME, archive modes/cleanup/expiry/one-time/flat/checksums, and
  unchanged favorites across restarts;
- fixed viewer files contain no private names, bodies, IDs, payloads, signed
  URLs, or image bytes.

Run:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
bash -n .agents/skills/famly-export/scripts/download-media.sh
bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
```

MP4 and PDF validation is signature-level only, not a deep parse.

## Completion

Report private paths; post/comment and active/archived conversation counts;
date ranges; message/reaction/unread counts; media category counts; total size
and checksum path; validation results; blocked killswitch count; unsupported
items; viewer/server/ZIP results; and the tokenized local launch URL.

Leave all private output ignored and uncommitted. Only reusable skill code,
tests, and documentation belong in Git.
