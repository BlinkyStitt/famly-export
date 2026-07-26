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
- Original-size Home photos at the established `photos/<year>/...` paths.
- Direct Home MP4 videos.
- Explicit Home file attachments.
- Every active and archived conversation after exhausting **Show More** in both
  views.
- Complete chronological message history, including exact 20-message page
  multiples, message read metadata, and `MessageReactions`.
- Explicit Famly-hosted message image and file attachments.
- Lossless conversation JSON with local attachment paths.
- A dependency-free static HTML viewer with one safely escaped page per
  conversation.
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
  and `grep` utilities.
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

If the existing entry lacks the arguments above, replace it:

```sh
codex mcp remove famly-chrome
codex mcp add famly-chrome -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --autoConnect \
  --allowUnrestrictedPaths \
  --redactNetworkHeaders
```

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

1. Installs the exact response-capture and killswitch-blocking hook on Home.
2. Scrolls Home to eight stable bottom checks.
3. Requires rendered post IDs to equal captured API post IDs.
4. Exhausts **Show More** in active and archived Messages.
5. Records the initial unread count.
6. Opens each conversation and reverse-scrolls the column-reversed message
   pane until a page shorter than 20 messages arrives.
7. Captures an explicit `MessageReactions` entry for every message ID,
   including messages with zero reactions, before advancing.
8. Requires captured conversation IDs to equal active plus archived IDs.
9. Builds JSON and the static viewer.
10. Immediately downloads fresh Home videos, Home files, and Message
    attachments while resuming around existing photos.
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
└── <year>/
    └── <post-date>_<post-id>_<image-id>.<extension>
videos/
└── <year>/
    └── <post-date>_<post-id>_<video-id>.mp4
files/
└── <year>/
    └── <post-date>_<post-id>_<file-id>_<safe-filename>
messages/
├── index.html
├── <conversation-id>.html
└── attachments/
    └── <conversation-id>/
        └── <message-date>_<message-id>_<media-id>_<safe-filename>
```

`metadata/`, `photos/`, `videos/`, `files/`, `messages/`, `*.part`, and
temporary HAR files are ignored. Never override that protection for a normal
family backup.

## Local tools

Build manifests and the static viewer:

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

Run fixture tests:

```sh
node --test .agents/skills/famly-export/tests/export.test.mjs
```

The downloader writes to `.part` files and atomically renames completed media.
Existing nonempty paths are skipped, including the established Home photo
paths.

## Validation boundary

Native macOS validation includes:

- nonzero file size;
- successful HTTP completion;
- zero `.part` files;
- expected MIME/signature through `file`;
- image decoding and dimensions through `sips` for supported images;
- SHA-256 checksums for every manifest path;
- a credential-marker scan over generated JSON, HTML, and checksums.

MP4 and PDF validation is signature-level only. It does not perform a deep
`ffprobe` video parse or `qpdf` PDF parse.

The transformer rejects incomplete or unsafe capture state, including:

- incomplete Home DOM/API sets;
- incomplete active or archived lists;
- a list that did not explicitly exhaust **Show More**;
- missing or extra conversation detail IDs;
- message histories whose last API page contains 20 messages;
- any message ID without explicit `MessageReactions` response evidence;
- duplicate or traversal-capable media paths;
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

### Conversation export ends on 20 messages

Reverse-scroll again. An exact multiple of 20 requires one additional API
request returning fewer than 20, including an empty terminal page.

### Downloads return 403 or 404

Famly's signed media URLs expire. Repeat the complete response-body capture and
rerun the builder and downloader immediately. Existing complete files are
skipped.

### The prohibited killswitch appears as a real network request

Stop the capture. Confirm `scripts/capture-hook.js` was passed verbatim as the
navigation `initScript`. Do not load or inspect the prohibited URL.

### In-page response capture stops working

First inspect the tracked hook and known endpoint paths without retrieving
request headers. A temporary ignored HAR is the last diagnostic fallback only.
Sanitize it, do not retain headers or tokens, and delete it immediately.

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
