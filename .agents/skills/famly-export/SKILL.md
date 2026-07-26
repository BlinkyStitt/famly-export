---
name: famly-export
description: Export a signed-in Famly Home feed and complete active and archived Messages history for a private offline backup through the dedicated famly-chrome Chrome DevTools MCP server. Captures response bodies without request credentials, separates Home and Message images, downloads original media, validates it, and builds lossless JSON plus a static offline message viewer.
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

State that warning prominently before any browser automation, and repeat it
immediately before opening Messages.

## Required control surface

Use only the Chrome DevTools MCP server named `famly-chrome`. Before any
browser work, run `codex mcp get famly-chrome` and require all of:

```text
chrome-devtools-mcp@1.6.0
--autoConnect
--allowUnrestrictedPaths
--redactNetworkHeaders
```

`--autoConnect` attaches to the user's existing signed-in Chrome profile,
`--allowUnrestrictedPaths` permits the final private capture save, and
`--redactNetworkHeaders` protects browser tool output. If any argument is
missing, stop before capture, follow the repository `README.md` to replace the
entry, and restart Codex. Never create a secondary capture-save path to work
around a broken MCP configuration.

Never substitute the in-app Browser, Playwright, a dedicated automation
profile, saved pages, or direct browser-profile access.

The exact URL below is prohibited:

```text
https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

Never navigate to, fetch, probe, or otherwise load it. The required capture
hook blocks Fetch and XHR attempts locally before the network request.

If `famly-chrome` is unavailable, stop and ask the user to complete the setup
in the repository `README.md`. Require the connected profile to have an
authenticated Famly Home tab whose URL starts with
`https://app.famly.co/#/account/home`. If it does not, ask the user to sign in
and open Home themselves before continuing.

Before browser work, read
[`references/devtools-workflow.md`](references/devtools-workflow.md)
completely. Use its exact hook and browser snippets. Also read
[`scripts/capture-hook.js`](scripts/capture-hook.js) completely and pass its
contents verbatim as the navigation `initScript`.

## Prerequisites

1. Resolve the output root to the current workspace unless the user gave a
   narrower directory.
2. Confirm `node`, `jq`, `curl`, `xargs`, `file`, `shasum`, `sips`, `find`, and
   `grep` exist.
3. Confirm sufficient disk space.
4. Confirm `metadata/`, `photos/`, `message-images/`, `videos/`, `files/`, and
   `messages/` are ignored by Git.

No Python or HAR is needed for the known API.

## Capture workflow

Follow the browser reference in order:

1. Select the authenticated Famly tab through `famly-chrome`.
2. Perform a real `navigate_page` reload of the already-open Home tab with
   `ignoreCache: true` and the exact response-capture hook as `initScript`.
   A hash-only navigation does not execute `initScript` and is invalid. Verify
   capture schema version 2, at least one feed page, the Home scroll container,
   and the locally blocked-attempt counter before scrolling. The hook stores
   only successful response bodies for the Home feed, conversation lists,
   conversation detail pages, and `MessageReactions`.
3. Scroll `main#content` in bounded batches until eight consecutive stable
   bottom checks. Wait for each batch to exit; never start a duplicate
   long-running command.
4. Require exact equality between rendered Home post IDs and unique captured
   feed post IDs.
5. Repeat the unread-state warning, open Messages, and click **Show More**
   until it disappears in both active and archived views.
6. Record the complete initial unread-conversation count before opening any
   conversation.
7. Open every active and archived conversation. Reverse-scroll the
   column-reversed `#reactConversationMessages` pane until each conversation
   returns a page shorter than the 20-message API page size. Exact multiples
   require the extra empty or short request. Wait for an explicit
   `MessageReactions` entry for every captured message ID before advancing,
   including zero-reaction entries.
8. Require captured conversation IDs to equal the complete active-plus-archived
   list.
9. Save the response bodies and workflow evidence to:

   ```text
   <output-root>/metadata/captured-export.json
   ```

Never call `get_network_request` to obtain bodies because it can expose
request headers. A temporary ignored HAR is a diagnostic fallback only if
response capture stops working; sanitize it, never preserve request headers,
and delete it immediately after diagnosis.

If the final `evaluate_script.filePath` save is denied, the MCP preflight was
not satisfied. Do not use a browser download, chunked transfer, or another
parallel save channel. Correct the MCP entry, restart Codex, and recapture.

## Build and download

Run from the workspace root:

```sh
node .agents/skills/famly-export/scripts/build-export.mjs \
  metadata/captured-export.json \
  .
```

The dependency-free transformer writes:

- `metadata/posts.json`;
- `metadata/conversations.json`, with chronological deduplicated messages,
  participants, reactions, read metadata, raw attachment fields, and local
  attachment paths;
- `metadata/media.json`, with media and owner identity, kind, fresh source URL,
  safe path, filename, and expected MIME;
- `metadata/export-summary.json`;
- one safely escaped `messages/index.html` containing a conversation table of
  contents followed by every conversation and message inline.

Keep the two primary image collections directly accessible:

- Home feed images directly in `photos/`;
- Message images directly in `message-images/`.

Keep explicit non-image Message files at
`messages/attachments/<conversation-id>/...`. The static viewer must use
relative links to these local files. Render images as links only: never emit
image elements or embed image bytes in the HTML. Remove obsolete generated
per-conversation HTML pages so `index.html` is the only viewer file.
Ordinary message-body URLs remain clickable external links. Only explicit
Famly-hosted image and file attachment fields enter the media manifest.

Immediately run:

```sh
bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

The downloader preserves established Home and Message image paths so valid
existing files are skipped. It downloads into atomic resumable `.part` files,
then validates all manifest paths and writes the consolidated checksum file:

```text
metadata/media-checksums.sha256
```

If signed URLs expire, recapture and resume. Never fall back to thumbnails or
stale URLs.

## Required validation

Do not report completion unless all checks pass:

- unique Home API IDs equal rendered Home IDs;
- active and archived lists each reach a terminal page shorter than ten;
- captured detail IDs equal active plus archived IDs;
- every conversation reaches a terminal page shorter than twenty;
- post, message, reaction, and media counts agree with manifests;
- every message ID has explicit `MessageReactions` response evidence;
- every media manifest path is nonempty;
- zero `.part` files remain;
- `file` MIME/signature checks match expected MIME;
- `sips` decodes every supported image;
- consolidated SHA-256 checksums cover every media path;
- unsupported attachments or media are explicitly reported;
- generated artifacts contain no `x-famly-accesstoken` or
  `famly.session-marker` marker.

MP4 and PDF validation is signature-level through native macOS `file`. Report
plainly that it is not a deep `ffprobe` or `qpdf` parse.
macOS may identify a valid MP4 container as either `video/mp4` or
`video/x-m4v`; the downloader accepts that exact signature alias while still
requiring an MP4 manifest entry.

## Completion

Report:

- private output paths;
- Home post count and date range;
- conversation counts split active and archived;
- message date range, message count, and reaction count;
- initial unread conversations affected;
- media counts by Home photos, Home videos, Home files, Message images, and
  other Message attachments;
- total downloaded size and checksum path;
- capture, MIME, image decoder, signature, partial-file, and credential-marker
  validation results;
- the number of prohibited killswitch attempts blocked locally by the hook;
- every unsupported item.

Leave all private output ignored, untracked, and uncommitted. Stop the active
DevTools controller if this run started one. Remind the user to turn off Chrome
remote debugging at `chrome://inspect/#remote-debugging`.
