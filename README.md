# Export Famly Home and Messages with Codex

This repository contains a dependency-free Codex workflow for a private offline
export of the signed-in Famly Home feed and complete active and archived
Messages history. Famly runs in a dedicated Chrome profile that contains no
unrelated browsing, and the user signs in themselves without sharing a password
or browser credential with Codex.

The export contains names, messages, read state, comments, observations, and
media that may show other people's children. Keep it out of Git, public links,
and ordinary cloud drives unless the destination is deliberately private.

> **Warning:** Exporting Messages opens every conversation and may mark unread
> conversations as read. The exporter records the initial unread count but
> does not restore unread state.

## Security boundaries

- Chrome uses only
  `/Users/bryan/Library/Application Support/Famly Export Chrome`, mode `0700`,
  with DevTools bound to `127.0.0.1:9223`. It does not attach to the normal
  Chrome profile.
- Chrome DevTools MCP has no unrestricted filesystem access. It can save the
  capture only into a private directory under the OS temporary directory.
- Capture, build, download, and viewer startup share current-user ownership,
  regular-file, canonical-containment, symlink rejection, directory `0700`,
  file `0600`, and umask `077` enforcement.
- Signed media URLs remain only in the private authoritative `media.json`.
  They are read by download workers and passed to `curl` through stdin, never
  through `xargs`, shell, or curl arguments. The viewer receives a redacted
  projection without `sourceUrl`.
- The viewer binds only to `127.0.0.1:4173`, requires an exact Host header, and
  generates a fresh 256-bit launch token every time. Only the fixed HTML shell
  and browser module are public.
- Favorites ZIPs use 192-bit one-time tokens, private temporary modes, expiry,
  startup crash-remnant cleanup, and signal cleanup.

The exact URL below is prohibited:

```text
https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

The MCP server blocks that exact URL before page control, and the tracked
capture hook separately blocks Fetch and XHR attempts in the page. Never
navigate to, fetch, probe, or otherwise load it.

## What is exported

- Every post returned by the complete Home feed, with lossless Home JSON.
- Original-size Home post and comment images directly under `photos/`.
- Direct Home MP4 videos and explicit Home file attachments.
- Every active and archived conversation after exhausting **Show More**.
- Complete chronological message history, including exact 20-message page
  multiples, read metadata, and explicit `MessageReactions` evidence.
- Famly-hosted Message images directly under `message-images/`.
- Explicit non-image Message files under
  `messages/attachments/<conversation-id>/`.
- Four authoritative manifests:
  `posts.json`, `conversations.json`, `media.json`, and `export-summary.json`.
- One fixed JSON-backed timeline with original lazy-loaded images, nested
  comments, conversation context, browser-local favorites, and selected
  original-image ZIP export.
- Consolidated SHA-256 checksums.

Ordinary HTTP(S) links in bodies remain clickable and are not downloaded.
Only explicit Famly-hosted attachment fields enter `media.json`.

## Requirements

- macOS, Google Chrome, Node.js, and `npx`.
- `jq`, `curl`, `xargs`, `file`, `shasum`, `sips`, `find`, `grep`, `lsof`, and
  native `/usr/bin/ditto`.
- Enough local disk for all original media.

No Python, dependency installation, HAR, or browser-profile inspection is
required for the known workflow.

## 1. Launch the dedicated Famly Chrome profile

From this repository:

```sh
bash .agents/skills/famly-export/scripts/launch-famly-chrome.sh
```

The launcher creates or tightens this dedicated profile to mode `0700`:

```text
/Users/bryan/Library/Application Support/Famly Export Chrome
```

It opens an ordinary visible Chrome window with remote debugging limited to:

```text
http://127.0.0.1:9223
```

Sign in to Famly yourself in that window, then open **Home**. Do not paste a
password, token, cookie, browser storage value, saved page, profile file, or
DevTools request header into Codex.

## 2. Configure the hardened Famly MCP server

Replace any existing entry:

```sh
codex mcp remove famly-chrome
codex mcp add famly-chrome \
  --env CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
  -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --browserUrl=http://127.0.0.1:9223 \
  --redactNetworkHeaders \
  --no-usage-statistics \
  --no-performance-crux \
  --no-category-network \
  --no-category-performance \
  --blockedUrlPattern=https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

Then verify:

```sh
codex mcp get famly-chrome
codex mcp list
```

The entry must show the pinned package, browser URL, header redaction, both
telemetry/CrUX opt-outs, both disabled tool categories, the exact blocked URL,
and `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`. It must not contain
`--autoConnect` or `--allowUnrestrictedPaths`.

For long browser operations, add these values to the generated
`[mcp_servers.famly-chrome]` table in `~/.codex/config.toml`:

```toml
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Restart Codex after adding or replacing the entry.

## 3. Run the skill

Open this repository as the Codex workspace and invoke:

```text
$famly-export Export the complete Famly Home feed, all original Home media, and every active and archived conversation with attachments and the offline viewer.
```

The browser workflow:

1. Requires the authenticated dedicated-profile Home tab.
2. Reloads it with the exact tracked capture and killswitch hook.
3. Scrolls Home to eight stable bottom checks and requires exact equality
   between rendered and captured Home post IDs.
4. Exhausts active and archived **Show More**, then records initial unread
   conversations.
5. Opens every conversation and reverse-scrolls until a page shorter than 20
   arrives. Exact multiples require the extra empty or short page.
6. Requires explicit `MessageReactions` evidence for every message ID.
7. Requires captured detail IDs to equal the active-plus-archived list.

### Sole capture save path

Before the final browser save, prepare a private OS-temporary destination:

```sh
node .agents/skills/famly-export/scripts/secure-capture.mjs prepare
```

Pass the printed absolute `captured-export.json` path as the final
`evaluate_script.filePath`. Then finalize it:

```sh
node .agents/skills/famly-export/scripts/secure-capture.mjs finalize \
  '<printed-temp-path>' \
  .
```

Finalization requires a current-user regular file in its private
`famly-capture-*` directory, validates JSON and capture schema version 2,
copies through a random `0600` metadata temporary file, fsyncs it, atomically
renames it to `metadata/captured-export.json`, and removes the temporary
capture. On failure, it preserves the capture at `0600` inside its `0700`
directory and reports the retry path. `prepare` removes current-user capture
directories older than 24 hours.

Do not save directly to the repository, use a browser download, split the
capture into chunks, or create another capture channel.

## Output

```text
metadata/
├── captured-export.json
├── conversations.json
├── export-summary.json
├── media-checksums.sha256
├── media.json
└── posts.json
photos/
└── <date>_<owner-id>_<image-id>.<extension>
message-images/
└── <date>_<message-id>_<image-id>.<extension>
videos/
└── <year>/<date>_<post-id>_<video-id>.mp4
files/
└── <year>/<date>_<post-id>_<file-id>_<safe-filename>
messages/
├── index.html
├── viewer-app.mjs
└── attachments/<conversation-id>/<date>_<message-id>_<file-id>_<safe-filename>
```

All private output roots and temporary artifacts are ignored by Git.

## Local commands

Build the four manifests and fixed viewer:

```sh
node .agents/skills/famly-export/scripts/build-export.mjs \
  metadata/captured-export.json \
  .
```

Download or resume supported media with eight workers:

```sh
bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

Workers receive only manifest indexes. Each worker reads its own signed URL,
requires one of the exact approved hosts `img.famly.co`,
`famly-de.s3.eu-central-1.amazonaws.com`, or
`famly-video-storage.s3.eu-central-1.amazonaws.com` plus visible safe URL
characters, rejects the killswitch locally, permits only HTTPS redirects, and
gives the URL to `curl` through stdin configuration. Downloads use private
resumable `.part` files and atomic final renames. Existing nonempty originals
are skipped.

Explicitly harden an existing export tree:

```sh
node .agents/skills/famly-export/scripts/private-tree.mjs harden .
```

This changes modes only. It rejects paths not owned by the current user,
symlinks, devices, sockets, and other non-regular entries.

Run fixtures:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
```

## Authenticated local viewer

Launch on the stable favorites origin:

```sh
node .agents/skills/famly-export/scripts/serve-export.mjs .
```

The server prints a URL shaped like:

```text
http://127.0.0.1:4173/#access=<fresh-token>
```

Open the complete printed URL. The fixed shell validates the fragment, stores
the token in `sessionStorage`, and removes the fragment from browser history.
Favorites remain in the existing `localStorage` origin and survive token and
server restarts. Changing the port changes the storage origin.

Only `/`, the fixed shell aliases, and `/messages/viewer-app.mjs` are public.
Manifests, media, and archive APIs require the current
`/_private/<token>/...` prefix. Missing or incorrect tokens return `404`.
`media.json` is projected without `sourceUrl`; raw capture data, checksums,
directory listings, traversal, absolute-form requests, arbitrary Host values,
and cross-origin archive requests are denied.

The server uses no cookies or CORS and sends restrictive CSP, frame, referrer,
permissions, opener, resource, cache, and MIME-sniffing headers.

Favorites export stages hard links to originals in one flat
`Famly Favorites/` directory, uses `ditto --norsrc`, issues a one-time
192-bit URL, and cleans on download, expiry, signal, or a later startup after
one hour. The source files are not transformed.

> **ZIP warning:** Exported ZIPs are conventional unencrypted archives. The
> browser controls the final destination and its permissions; move the ZIP to
> an appropriately private location.

Direct `file://` opening is unsupported.

## Validation boundary

Required validation includes:

- exact Home API/DOM post-set equality;
- terminal short active, archived, and per-conversation pages;
- exact active-plus-archived/detail conversation equality;
- explicit reaction evidence for every message;
- matching post, message, reaction, media, and manifest counts;
- correct flat Home/comment and Message image paths;
- no unsupported silent drops;
- zero `.part` files;
- expected `file` MIME/signatures and successful `sips` image decoding;
- SHA-256 coverage for every media path;
- no `x-famly-accesstoken` or `famly.session-marker` in generated artifacts;
- fixed shell/module content independence from private exported records;
- capture, private-tree, downloader, viewer, server, and ZIP fixtures.

MP4 and PDF checks are signature-level through native `file`; they are not
deep `ffprobe` or `qpdf` parses. A valid MP4 may be reported as
`video/mp4`, `video/x-m4v`, or `application/mp4`.

## Troubleshooting

### No authenticated Famly Home tab

Make sure the dedicated Chrome window from `launch-famly-chrome.sh` is open.
Sign in yourself and open `https://app.famly.co/#/account/home`. Do not use the
normal Chrome profile as a fallback.

### DevTools endpoint is unavailable

Check that port `9223` is free, run the launcher once, and verify:

```sh
curl http://127.0.0.1:9223/json/version
```

### Capture save is denied

Run `secure-capture.mjs prepare` again and use its printed OS-temporary path.
Confirm the MCP entry does not contain `--allowUnrestrictedPaths`. Do not route
the capture through another mechanism.

### Downloads return 403 or 404

Signed URLs expired. Repeat the complete response-body capture, finalize it,
rebuild, and rerun the downloader. Existing complete originals are skipped.
Never substitute thumbnails or preview URLs.

### Viewer reports no valid access token

Restart the server and open the complete URL it prints, including the fragment.
The token rotates on every launch.

### Viewer reports a missing manifest

Rebuild and confirm all four authoritative JSON files exist under `metadata/`.
The server never infers private records from HTML.

### Favorites ZIP creation fails

Confirm all selected identities still exist as current image records, native
`/usr/bin/ditto` exists, and temporary disk space is available. A concurrent
creation receives `409`.

## Completion report

A completed export reports private paths; Home post/comment counts and date
range; active/archived conversation counts; Message/reaction counts and date
range; initial unread count; media counts by category; total bytes and checksum
path; unsupported items; blocked killswitch attempts; capture, MIME, decoder,
signature, partial, credential, server, and ZIP results; and the tokenized
local launch URL.

Private output stays ignored and uncommitted. Only reusable code, tests, and
documentation belong in Git.
