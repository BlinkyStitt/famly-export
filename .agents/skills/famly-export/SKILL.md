---
name: famly-export
description: Export a signed-in Famly Home feed and complete active and archived Messages history for a private offline backup through the dedicated famly-chrome Chrome DevTools MCP server. Captures response bodies without request credentials, downloads original photos, videos, files, and Famly-hosted message attachments, validates media, and builds lossless JSON plus a static offline message viewer.
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

Use only the Chrome DevTools MCP server named `famly-chrome`. It must attach to
the user's existing signed-in Chrome profile with `--autoConnect`. Never
substitute the in-app Browser, Playwright, a dedicated automation profile,
saved pages, or direct browser-profile access.

The exact URL below is prohibited:

```text
https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

Never navigate to, fetch, probe, or otherwise load it. The required capture
hook blocks Fetch and XHR attempts locally before the network request.

If `famly-chrome` is unavailable, stop and ask the user to complete the setup
in the repository `README.md`. If the connected profile is not signed in to
Famly, ask the user to sign in themselves and open Home.

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
4. Confirm `metadata/`, `photos/`, `videos/`, `files/`, and `messages/` are
   ignored by Git.

No Python or HAR is needed for the known API.

## Capture workflow

Follow the browser reference in order:

1. Select the authenticated Famly tab through `famly-chrome`.
2. Navigate to Home with the exact response-capture hook installed. It stores
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
- `messages/index.html` and one safely escaped static page per conversation.

Ordinary message-body URLs remain clickable external links. Only explicit
Famly-hosted image and file attachment fields enter the media manifest.

Immediately run:

```sh
bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

The downloader preserves the established `photos/<year>/...` paths so valid
existing photos are skipped. It downloads into atomic resumable `.part` files,
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

## Completion

Report:

- private output paths;
- Home post count and date range;
- conversation counts split active and archived;
- message date range, message count, and reaction count;
- initial unread conversations affected;
- media counts by Home photos, Home videos, Home files, and Message
  attachments;
- total downloaded size and checksum path;
- capture, MIME, image decoder, signature, partial-file, and credential-marker
  validation results;
- every unsupported item.

Leave all private output ignored, untracked, and uncommitted. Stop the active
DevTools controller if this run started one. Remind the user to turn off Chrome
remote debugging at `chrome://inspect/#remote-debugging`.
