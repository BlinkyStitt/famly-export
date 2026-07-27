# Famly Export

`famly-export` creates a private, verifiable offline backup of Famly Home and
Messages on macOS. It keeps the original JSON shapes, original attachments,
historical records that disappear from later refreshes, checksums, and a
filterable authenticated viewer.

The export can contain sensitive information about children and families. Keep
the repository and generated backup private. Generated data is ignored by Git.

> **Messages warning:** the export opens every active and archived
> conversation. Famly may mark unread conversations as read. The exporter
> records the initial unread count but cannot restore unread state.

## Setup once

From this repository:

```sh
brew bundle
codex login
```

Homebrew installs Google Chrome, Codex, Node.js, and `jq`. Famly credentials are
never requested by this tool.

## Export

Run the only supported operational command:

```sh
./famly-export
```

The command:

1. checks tools, disk space, private ownership, and concurrent-run safety;
2. installs or repairs the pinned, hardened `famly-chrome` integration;
3. opens a visible Chrome window using a dedicated profile under the current
   user's home directory;
4. waits while you sign in to Famly yourself and open **Home**;
5. captures or resumes Home and complete active and archived Messages;
6. preserves records no longer visible in the latest refresh;
7. downloads or repairs missing media and verifies every attachment;
8. publishes all manifests, media, checksums, and viewer files as one
   recoverable transaction; and
9. starts the authenticated viewer on `127.0.0.1:4173` and opens it.

Press **Control-C** in Terminal to stop the managed viewer.

If capture, download, integrity validation, or publication fails, the command
exits nonzero, reports the failed phase, leaves the previous authoritative
export untouched, preserves a private capture checkpoint for a retry, and does
not open the viewer.

## Scope

The export covers:

- every Home post returned by the fully exhausted feed;
- comments, observations, events, invoices, likes, recipients, and captured
  read metadata embedded in Home;
- original post and comment images, MP4 videos, video poster frames, explicit
  files, and invoice PDFs;
- every active and archived conversation after exhausting list pagination;
- every message through a terminal short history page, including exact
  20-message multiples;
- explicit Message images and files; and
- explicit reaction evidence, including messages with zero reactions.

Dedicated Calendar, Documents, Attendance, Profiles, and other areas outside
Home and Messages are not exported. Ordinary links in bodies remain links.
Avatars, profile imagery, liker/reader images, and redundant image derivatives
are deliberately excluded and counted as excluded UI assets.

The exporter fails rather than silently omitting a recognized content
attachment with an unsupported type, host, missing identifier, or failed
download.

## Archival behavior

The capture format remains schema 2. The four authoritative manifests are:

```text
metadata/posts.json
metadata/conversations.json
metadata/media.json
metadata/export-summary.json
```

Manifest schema 3 adds archive state maps and current, preserved, and total
counts. A current record replaces the same post, conversation, message, or
media identity. A record missing from a later refresh remains available and is
labelled **Not seen in latest refresh**. If it reappears, it becomes current
again. Earlier versions of an edited record are not retained.

The first successful run migrates an existing schema-2 export. Verified media
is retained indefinitely, so storage grows over time.

## Viewer

The viewer presents one newest-first timeline with:

- case- and diacritic-insensitive AND-token search;
- Home and Messages toggles;
- inclusive start and end dates;
- conversation, image, video, file, current/history, and favorites filters;
- progressive 100-entry batches with automatic and keyboard-accessible loading;
- expandable observation, event, invoice, like, recipient, reaction, and read
  metadata;
- native MP4 controls, metadata preload, poster frames, byte-range seeking, and
  original-file links; and
- favorites for every real attachment, including images, videos, PDFs, invoice
  PDFs, and other supported files.

Generated video posters are not attachments and cannot be favorited. Favorites
export once into one flat collision-safe ZIP.

> Favorites ZIPs are conventional unencrypted archives. The browser controls
> the destination and its permissions.

The viewer binds only to loopback, enforces an exact Host header, and requires a
fresh 256-bit fragment token. The token is sent to macOS through standard input,
never argv, environment variables, cookies, or files. It is moved to
`sessionStorage` and removed from browser history. Signed media URLs are omitted
from viewer responses.

## Private output

```text
metadata/
├── captured-export.json
├── conversations.json
├── export-summary.json
├── media-checksums.sha256
├── media.json
└── posts.json
photos/
message-images/
videos/
files/
messages/
├── index.html
├── viewer-app.mjs
└── attachments/
```

Directories are mode `0700`; files are mode `0600`. Media URLs are approved
HTTPS Famly hosts only and are passed to `curl` through standard input. The
exact killswitch URL is blocked both by the browser integration and the page
capture hook and is never loaded.

## Advanced troubleshooting and development

The root command is the supported interface. The scripts under
`.agents/skills/famly-export/scripts/` are internal phases used for development
and diagnosis.

Useful read-only checks:

```sh
codex mcp get famly-chrome
lsof -nP -iTCP:9223 -sTCP:LISTEN
lsof -nP -iTCP:4173 -sTCP:LISTEN
```

The MCP entry must use `chrome-devtools-mcp@1.6.0`, the loopback browser URL,
header redaction, telemetry/CrUX exclusions, disabled network/performance
categories, the exact blocked URL, update-check exclusion, and 30/120-second
runtime timeouts. `./famly-export` repairs drift automatically.

Checkpoints live in current-user `famly-capture-*` directories under the macOS
temporary directory and expire after 24 hours. Publication uses a private
transaction journal; the next run deterministically restores an interrupted
publication before doing new work.

Run the complete suite:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
bash -n .agents/skills/famly-export/scripts/download-media.sh
bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
```

Set `FAMLY_REAL_CHROME_E2E=1` on macOS to include the real-Chrome fixture.
Tests and fixtures contain no private export records or credentials.

## License

Copyright © 2026 Famly Export contributors.

This project is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License or (at your option) any later
version. See [LICENSE](LICENSE).

SPDX license expression: `GPL-3.0-or-later`.
