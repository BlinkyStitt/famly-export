# Export Famly Home and Messages with Codex

This repository contains a Codex skill for a private offline export of the
signed-in Famly Home feed and Messages. It controls the user's existing Chrome
profile through a dedicated Chrome DevTools MCP server; the user signs in to
Famly themselves and never gives the agent a password or browser credential.

The export includes names, message history, read state, comments, observations,
and media that may show other people's children. Keep it out of Git, public
links, and ordinary cloud drives unless you have deliberately selected a
suitable private location.

> **Warning:** Exporting Messages opens each conversation and may mark unread
> conversations as read. The exporter records the initial unread count but
> does not restore unread state.

## What is exported

- Every post returned by the complete Famly Home feed.
- Lossless Home post JSON.
- Original-size Home post and comment photos directly in `photos/`.
- Direct Home MP4 videos.
- Explicit Home file attachments.
- Every active and archived conversation after exhausting **Show More** in both
  views.
- Complete chronological message history, including exact 20-message page
  multiples, message read metadata, and `MessageReactions`.
- Explicit Famly-hosted Message images directly in `message-images/`.
- Explicit non-image Message files in
  `messages/attachments/<conversation-id>/...`.
- Lossless conversation JSON with local attachment paths.
- One dependency-free JSON-backed timeline that mixes Home posts and Messages
  newest-first, nests comments under their posts, and shows conversation
  context on each Message.
- Inline original local images with browser-local favorites and a conventional
  ZIP export containing selected originals in one `Famly Favorites/` folder.
- A consolidated SHA-256 checksum file and export summary.

Ordinary URLs in a message body, including external Google Drive links, remain
clickable in the offline HTML viewer. They are not downloaded. Only explicit
Famly attachment fields enter the media manifest.

## Safety boundary

The exporter captures selected successful response bodies in the page. It does
not deliberately capture request headers, request bodies, cookies, local
storage, access tokens, or browser profile files.

The exact URL below is prohibited:

```text
https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
```

The tracked capture hook intercepts Fetch and XHR attempts for that URL before
the real network call. Do not manually navigate to, fetch, probe, or otherwise
load it.

No Python or HAR is required for the known Famly API. A temporary ignored HAR
is allowed only as a diagnostic fallback if in-page response capture stops
working. It must be sanitized without printing credential values and deleted
immediately after diagnosis.

## Requirements

- macOS with a current Codex desktop app.
- Google Chrome with remote debugging enabled for the existing signed-in
  profile.
- Node.js.
- `npx` for the MCP server package.
- `jq`, `curl`, `xargs`, and the native macOS `file`, `shasum`, `sips`, `find`,
  `grep`, and `ditto` utilities.
- Enough local disk for all original media.

The direct `famly-chrome` Chrome DevTools MCP configuration is required. The
in-app Browser and the plugin's default Chrome profile are not used.

## 1. Make the repository skill available

Open this repository as the Codex workspace. Codex discovers:

```text
.agents/skills/famly-export/SKILL.md
```

If `$famly-export` does not appear, restart Codex after opening the repository.

## 2. Configure Chrome DevTools MCP

The known setup uses a distinct server name and an existing Chrome profile:

```sh
codex mcp add famly-chrome -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --autoConnect \
  --allowUnrestrictedPaths \
  --redactNetworkHeaders
```

- `--autoConnect` attaches to the already-running Chrome profile.
- `--allowUnrestrictedPaths` lets the tool save the private capture into this
  workspace. Use that broad filesystem permission only with trusted prompts
  and skills.
- `--redactNetworkHeaders` reduces accidental credential exposure in browser
  tool output.

Verify the server:

```sh
codex mcp get famly-chrome
codex mcp list
```

Do not begin browser capture unless `codex mcp get famly-chrome` shows the
exact package version and all three arguments above. If the existing entry
lacks any of them, replace it:

```sh
codex mcp remove famly-chrome
codex mcp add famly-chrome -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --autoConnect \
  --allowUnrestrictedPaths \
  --redactNetworkHeaders
```

Restart Codex after adding or replacing the entry. A capture made through an
older server process cannot be repaired with a secondary browser-download or
chunked-save path; restart and recapture through the configured server.

For long browser operations, add the following to the generated
`[mcp_servers.famly-chrome]` table in `~/.codex/config.toml`:

```toml
startup_timeout_sec = 30
tool_timeout_sec = 120
```

## 3. Enable the existing Chrome profile

1. Start the normal Chrome profile used for Famly.
2. Open `chrome://inspect/#remote-debugging`.
3. Enable remote debugging.
4. Accept Chrome's connection prompt.
5. Close unrelated sensitive tabs.
6. Keep Chrome and the Famly tab open.
7. Restart Codex so it loads `famly-chrome`.

Remote debugging exposes open tabs in that profile to the MCP server. Disable
it when the export finishes.

## 4. Sign in yourself

In the same Chrome profile:

1. Open <https://app.famly.co/>.
2. Sign in yourself.
3. Open **Home**.

Never paste a password, session token, cookie, saved page, browser storage, or
DevTools request headers into Codex.

## 5. Run the skill

From a Codex conversation in this workspace:

```text
$famly-export Export the complete Famly Home feed, all original Home media, and every active and archived conversation with attachments and the offline HTML viewer. Use the already-signed-in Chrome profile.
```

Before browser automation, the skill repeats:

> Exporting Messages opens each conversation and may mark unread conversations
> as read. The exporter records the initial unread count but does not restore
> unread state.

The skill then:

1. Performs a real reload of the already-open Home tab with the exact
   response-capture and killswitch-blocking hook. A hash-only navigation is
   not sufficient because it does not install the initialization script.
2. Scrolls Home to eight stable bottom checks.
3. Requires rendered post IDs to equal captured API post IDs.
4. Exhausts **Show More** in active and archived Messages.
5. Records the initial unread count.
6. Opens each conversation and reverse-scrolls the column-reversed message
   pane until a page shorter than 20 messages arrives.
7. Captures an explicit `MessageReactions` entry for every message ID,
   including messages with zero reactions, before advancing.
8. Requires captured conversation IDs to equal active plus archived IDs.
9. Builds the four authoritative JSON manifests and the fixed viewer shell.
10. Immediately downloads fresh Home post/comment media and Message
    attachments while resuming around existing complete files.
11. Validates every supported media file and scans generated artifacts for
    credential markers without printing matched values.

For a large history, leave Chrome open and wait for each long-running browser
or download command to exit. Do not start duplicate operations.

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
├── <post-date>_<post-id>_<image-id>.<extension>
└── <comment-date>_<comment-id>_<image-id>.<extension>
message-images/
└── <message-date>_<message-id>_<image-id>.<extension>
videos/
└── <year>/
    └── <post-date>_<post-id>_<video-id>.mp4
files/
└── <year>/
    └── <post-date>_<post-id>_<file-id>_<safe-filename>
messages/
├── index.html
├── viewer-app.mjs
└── attachments/
    └── <conversation-id>/
        └── <message-date>_<message-id>_<file-id>_<safe-filename>
```

The two image collections are therefore directly available as `photos/` for
Home posts and comments and `message-images/` for Messages. The fixed HTML
shell and browser module contain no exported names, bodies, IDs, JSON payloads,
or image bytes. At runtime they fetch `posts.json`, `conversations.json`,
`media.json`, and `export-summary.json`, then create private content with safe
DOM APIs. Original local image paths are used directly with `loading="lazy"`;
no thumbnail files or caches are created.

`metadata/`, `photos/`, `message-images/`, `videos/`, `files/`, `messages/`,
`*.part`, and temporary HAR files are ignored. Never override that protection
for a normal family backup.

## Local tools

Build the manifests and fixed viewer application:

```sh
node .agents/skills/famly-export/scripts/build-export.mjs \
  metadata/captured-export.json \
  .
```

Download or resume all supported media with eight workers:

```sh
bash .agents/skills/famly-export/scripts/download-media.sh \
  metadata/media.json \
  . \
  8
```

Launch the private viewer:

```sh
node .agents/skills/famly-export/scripts/serve-export.mjs .
```

Open <http://127.0.0.1:4173/>. The server binds only to that loopback address
and serves only the viewer, four manifests, manifest-listed media, and the
narrow favorites archive routes. It rejects raw capture access, directory
listings, unknown roots, traversal, and cross-origin archive requests.

An optional second argument changes the port:

```sh
node .agents/skills/famly-export/scripts/serve-export.mjs . 4812
```

Favorites live in versioned browser `localStorage`. Browser storage is
origin-specific, so changing the port creates a separate selection. On load,
the viewer drops saved identities that are no longer present in `media.json`.
Opening `messages/index.html` directly with `file://` is unsupported because
browsers do not permit its JSON fetches; the page displays this launch command.

Click an image or its keyboard-accessible **Favorite** button to toggle it.
The footer exports selected original files—never thumbnails or transformed
copies—as a ZIP. The local API accepts current image identities only, stages
hard links, uses `ditto --norsrc`, assigns deterministic names if future
basenames collide, permits one creation at a time, and deletes one-time or
expired archives.

Run fixture tests:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
```

The downloader writes to `.part` files and atomically renames completed media.
Existing nonempty paths are skipped, including established Home and Message
image paths.

## Validation boundary

Native macOS validation includes:

- nonzero file size;
- successful HTTP completion;
- zero `.part` files;
- expected MIME/signature through `file`;
- image decoding and dimensions through `sips` for supported images;
- SHA-256 checksums for every manifest path;
- a credential-marker scan over generated JSON, HTML, and checksums.
- a real fixture ZIP check that verifies the selected source checksums, one
  flat `Famly Favorites/` folder, and no `__MACOSX` metadata.
- server allowlist, MIME, loopback, origin, size/count, concurrency, expiry,
  cleanup, and traversal tests.
- viewer ordering, timestamp-tie, nested-comment, original-path, lazy-loading,
  favorite, storage-restoration, malformed-manifest, and hostile-value tests.

MP4 and PDF validation is signature-level only. It does not perform a deep
`ffprobe` video parse or `qpdf` PDF parse. macOS may identify a valid MP4
container as `video/x-m4v`; the downloader accepts that exact signature alias
for a `video/mp4` manifest entry.

The transformer rejects incomplete or unsafe capture state, including:

- incomplete Home DOM/API sets;
- incomplete active or archived lists;
- a list that did not explicitly exhaust **Show More**;
- missing or extra conversation detail IDs;
- message histories whose last API page contains 20 messages;
- any message ID without explicit `MessageReactions` response evidence;
- duplicate or traversal-capable media paths;
- comment images without a stable comment owner or flat `photos/` path;
- unsupported media extensions, which are retained in lossless JSON and
  reported in the summary rather than silently downloaded.

Non-Famly-hosted explicit attachment fields are likewise retained in lossless
JSON and reported, but excluded from the download manifest.

## Troubleshooting

### `Could not find DevToolsActivePort`

Confirm Chrome is running, remote debugging is enabled at
`chrome://inspect/#remote-debugging`, and Chrome accepted the connection. Then
restart Codex and run `codex mcp list`.

### Famly opens at `#/login`

The MCP server attached to the wrong profile. Stop rather than asking the agent
to sign in. Ensure `famly-chrome` uses `--autoConnect`, open Famly in Chrome's
default profile, and retry.

### A separate blank Chrome profile opens

The wrong Chrome DevTools server was selected. Explicitly invoke
`$famly-export` and require the named `famly-chrome` server.

### A long browser call times out

Set `tool_timeout_sec = 120`. Make one short state query to learn whether the
existing operation completed. Do not immediately launch a duplicate scroll or
conversation export.

### Home capture and rendered post counts differ

The feed is incomplete. Continue the existing bounded scroll sequence until
eight stable bottom checks, then recapture. Do not download from a mismatched
manifest.

### Home capture reports no hook or no feed page

Make sure the signed-in tab is already open at
`https://app.famly.co/#/account/home`, then perform a real reload with the
tracked hook as `navigate_page.initScript`. Changing only the URL hash does
not execute the initialization script.

### Conversation export ends on 20 messages

Reverse-scroll again. An exact multiple of 20 requires one additional API
request returning fewer than 20, including an empty terminal page.

### Downloads return 403 or 404

Famly's signed media URLs expire. Repeat the complete response-body capture and
rerun the builder and downloader immediately. Existing complete files are
skipped. This also applies when newly discovered comment images are the only
missing files; do not substitute their `url_big` thumbnail/preview fields for
the original-media contract.

### Opening `messages/index.html` shows a server instruction

This is expected for `file://`. Run:

```sh
node .agents/skills/famly-export/scripts/serve-export.mjs .
```

Then open <http://127.0.0.1:4173/>. Use the same port on future launches if
you want the same browser-local favorites.

### The viewer reports a missing manifest

Run the builder again and confirm all four JSON files exist under `metadata/`.
The server intentionally does not infer private records from HTML or create a
parallel timeline manifest.

### Favorites ZIP creation fails

Confirm every selected media path is a nonempty current manifest-listed image,
native `/usr/bin/ditto` exists, and there is free temporary disk space. Reload
the viewer to prune stale identities. A second export request receives a
conflict response while the first is still being created.

### The prohibited killswitch appears as a real network request

Stop the capture. Confirm `scripts/capture-hook.js` was passed verbatim as the
reload `initScript`, and report the locally blocked-attempt count from the
capture. Do not load or inspect the prohibited URL.

### Saving `captured-export.json` is denied

Stop and run `codex mcp get famly-chrome`. The server must include
`--allowUnrestrictedPaths` and `--redactNetworkHeaders`; correct the entry,
restart Codex, and recapture. Do not route the private capture through a
browser download or another parallel save mechanism.

### In-page response capture stops working

First inspect the tracked hook and known endpoint paths without retrieving
request headers. A temporary ignored HAR is the last diagnostic fallback only.
Sanitize it, do not retain headers or tokens, and delete it immediately.

## Completion report

A completed run reports the private output paths; Home post/comment counts and
date range; active/archived conversation counts; Message/reaction counts and
date range; the initial unread count; media counts by Home post photos, Home
comment photos, Home videos/files, Message images, and other Message
attachments; total bytes and checksum path; unsupported items; locally blocked
prohibited requests; capture/MIME/decoder/signature/partial/credential results;
and the viewer/server/ZIP validation results.

MP4 and PDF results must remain labeled signature-level only. Private output
stays ignored and uncommitted; only the reusable skill, scripts, tests, and
documentation belong in Git.

## Disconnect after the export

Turn off remote debugging at:

```text
chrome://inspect/#remote-debugging
```

To remove the dedicated server:

```sh
codex mcp remove famly-chrome
```

Restart Codex after removing it.
