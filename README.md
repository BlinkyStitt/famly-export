# Famly Export

The [Famly app](https://app.famly.co/) can contain years of school posts,
observations, messages, photos, videos, and documents. This project is for
families who want to download their own copy for safekeeping.

`famly-export` uses an AI agent and a dedicated browser profile to make a
private, verifiable offline backup of Famly Home and Messages on macOS. It saves
the original attachments, keeps records that disappear from later refreshes,
checks that the download is complete, and opens everything in a searchable
viewer.

This is an independent community project, not an official Famly product.

> **A note on privacy:** This download is for your family's private backup. It
> will include group photos with other people's children, along with names,
> conversations, observations, invoices, and other sensitive information. Be
> thoughtful about where you put the data. Do not publish the backup or share
> photos containing other people's children without their permission.

> **Do not give the AI your password.** You sign in to Famly yourself in a
> dedicated Chrome window. The exporter never asks for your password and does
> not intentionally capture cookies, request headers, or access tokens. The
> saved data does contain private records and temporary signed media URLs, so
> do not share the generated files or repository directory publicly.

## Credit

This project grew out of
[How to Download Your Photos from Famly with an AI Agent](https://docs.google.com/document/d/10_1RsFVVsqwLkbDy4xWT9g8zSkjzXb8nlRKLdK6sSlg/edit?pli=1&tab=t.0)
by **Chris Cartland**, last updated July 24, 2026.

Chris documented the important practical lessons behind this tool: saved Famly
pages contain image links that expire, AI tools can miss content, Messages are
harder to capture than Home, and a useful backup must download the real files
and check the result. `famly-export` turns those lessons into one repeatable
command.

## What you need

You need a Mac, a Famly account, and some comfort using Terminal. The setup is
only required once:

```sh
brew bundle
codex login
```

Homebrew installs Google Chrome, Codex, Node.js, and `jq`. `codex login` signs
you in to Codex; it does not give Codex your Famly password.

## Make a backup

Run:

```sh
./famly-export
```

A dedicated Chrome window opens. Sign in to Famly yourself if needed, open
**Home**, return to Terminal, and press **Return**.

The exporter then:

1. scrolls through Home until it has reached the beginning of the available
   history;
2. captures posts, comments, observations, events, invoices, and their
   attachments;
3. opens active and archived Messages and follows each conversation to its
   oldest available message;
4. downloads every recognized photo, video, file, and invoice PDF;
5. compares the captured pages, records, and attachments so missing content
   causes a failure instead of a misleading "successful" backup;
6. preserves older records that are no longer visible in the latest refresh;
7. verifies the downloaded files with checksums; and
8. opens the finished backup in a private local viewer.

Press **Control-C** in Terminal when you are finished to stop the viewer.

> **Messages warning:** Opening Messages may cause Famly to mark unread
> conversations as read. The exporter records the initial unread count, but it
> cannot restore unread state.

## Why it does more than save the page

Using **Save Page As…** can look successful while leaving you with a backup that
stops working a few days later. Famly pages use temporary image and file URLs,
so the actual attachments must be downloaded before those URLs expire.

Famly also loads older material as you scroll. Home, archived conversations,
message history, and reactions have separate completeness rules. The website
can change, too. For those reasons, this project uses scripts to collect the
data and then checks the output against what the browser observed. If a
recognized attachment is unsupported, missing, corrupt, or cannot be
downloaded, the export fails.

A zero-entry media list also fails. In a real family account that almost always
means the capture missed something.

## What is included

The backup covers:

- every Home post returned after fully scrolling the feed;
- comments, observations, events, invoices, likes, recipients, and captured
  read information embedded in Home;
- original post and comment images, MP4 videos, video poster frames, files, and
  invoice PDFs;
- active and archived conversation lists;
- every captured message through the oldest available history page;
- Message images and files; and
- reaction evidence, including messages with no reactions.

The backup deliberately excludes avatars, profile pictures, liker and reader
profile images, and redundant image sizes. Those are counted as excluded
interface assets rather than silently ignored.

Dedicated Calendar, Documents, Attendance, Profiles, and other areas outside
Home and Messages are not included. Ordinary links written inside posts or
messages remain links.

## If something goes wrong

The exporter reports the phase that failed and exits without publishing a
partial replacement or opening the viewer. Your previous verified backup stays
untouched.

If capture stops partway through, a private checkpoint is kept for up to 24
hours. The next run resumes from the latest safe point. If capture finished but
a later download or verification step failed—often because a signed URL
expired—the completed checkpoint is discarded so the next run fetches fresh
URLs.

Running `./famly-export` again is the supported retry.

## The offline viewer

After a successful export, the viewer opens a newest-first timeline. You can:

- search names, text, comments, conversation titles, participants, attachment
  names, event details, observation details, and invoice information;
- filter Home and Messages, dates, conversations, media types, current or
  preserved history, and favorites;
- expand observations, events, invoices, likes, recipients, reactions, and
  read information;
- play videos and open original attachments; and
- collect favorite images, videos, PDFs, and files into one ZIP.

Records retained from an older capture are labelled **Not seen in latest
refresh**. They remain visible unless you filter them out.

Favorites ZIP files are ordinary unencrypted archives. They may contain photos
of other people's children and the same private information as the main backup.
Store and share them with the same care.

The viewer runs only on your Mac at `127.0.0.1:4173`. It requires a fresh
private token, removes that token from browser history, and does not expose
signed Famly URLs in its responses.

## Where the backup is stored

The generated data stays inside this repository and is ignored by Git:

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

Directories are readable only by your macOS user (`0700`), and files are
owner-only (`0600`). Ignored does not mean encrypted: do not use `git add -f`,
do not make the repository public with generated files included, and do not
upload the whole directory to a public file-sharing service.

Verified media and historical records are retained across refreshes, so the
backup grows over time. A newer record with the same Famly identifier replaces
the older version; separate revisions of edited records are not kept.

## Advanced troubleshooting and development

`./famly-export` is the supported command. The scripts under
`.agents/skills/famly-export/scripts/` are internal implementation phases.

Useful read-only checks:

```sh
codex mcp get famly-chrome
lsof -nP -iTCP:9223 -sTCP:LISTEN
lsof -nP -iTCP:4173 -sTCP:LISTEN
```

The exporter installs or repairs its own pinned, hardened `famly-chrome`
configuration. It uses a dedicated browser profile at:

```text
${HOME}/Library/Application Support/Famly Export Chrome
```

It never attaches to your ordinary Chrome profile.

Run the complete local test suite:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
bash -n .agents/skills/famly-export/scripts/download-media.sh
bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
node --check .agents/skills/famly-export/scripts/run-export.mjs
```

Set `FAMLY_REAL_CHROME_E2E=1` on macOS to include the real-Chrome fixture. Tests
and fixtures contain no private export records or credentials.

## License

Copyright © 2026 Famly Export contributors.

This project is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License or (at your option) any later
version. See [LICENSE](LICENSE).

SPDX license expression: `GPL-3.0-or-later`.
