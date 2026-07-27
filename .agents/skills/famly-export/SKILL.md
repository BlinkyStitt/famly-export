---
name: famly-export
description: Export a signed-in Famly Home feed and complete active and archived Messages history for a private offline backup through the isolated famly-chrome Chrome DevTools MCP server. Captures response bodies without request credentials, downloads original media without exposing signed URLs in process arguments, preserves historical records, and builds a token-authenticated filterable viewer.
---

# Famly Export

Export only data the user is authorized to access. Treat every capture,
manifest, viewer response, and media file as private. Never commit or upload
private export output.

Never ask for or inspect a Famly password, request header, cookie, local or
session storage, access token, browser profile file, or any browser other than
the isolated `famly-chrome` server.

> **Warning:** Exporting Messages opens each conversation and may mark unread
> conversations as read. Record the initial unread count; do not claim unread
> state can be restored.

## Supported operation

For an interactive export, use only:

```sh
./famly-export
```

The runner owns dependency/disk checks, locking, portable profile selection,
MCP configuration, Chrome startup/reuse, checkpoint selection, Codex capture,
historical merge, download validation, transactional publication, and the
managed viewer. Internal scripts are not user-facing subcommands.

If this skill is invoked by that runner through `codex exec`, perform only the
browser-capture phase described below and return the exact JSON contract
requested by the runner. The prompt supplies the prepared capture/checkpoint
path and any valid resume path.

## Required browser boundary

Use only the Chrome DevTools MCP server named `famly-chrome`. It connects to the
ordinary visible Chrome process on `127.0.0.1:9223` using the dedicated profile:

```text
${HOME}/Library/Application Support/Famly Export Chrome
```

The runner requires the exact pinned MCP command:

```text
npx -y chrome-devtools-mcp@1.6.0
--browserUrl=http://127.0.0.1:9223
--redactNetworkHeaders
--no-usage-statistics
--no-performance-crux
--no-category-network
--no-category-performance
--blockedUrlPattern=https://famly-killswitch.s3.eu-central-1.amazonaws.com/killswitch
CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
startup_timeout_sec=30
tool_timeout_sec=120
```

Reject `--autoConnect` and `--allowUnrestrictedPaths`.

The exact killswitch URL is prohibited. Never navigate to, fetch, probe, or
otherwise load it. The MCP block is the outer boundary; the tracked hook also
blocks Fetch and XHR locally.

Require an authenticated tab whose URL begins:

```text
https://app.famly.co/#/account/home
```

If it is absent, fail the capture contract. Never use the normal Chrome profile
or another capture channel.

Before browser work, read `references/devtools-workflow.md` and
`scripts/capture-hook.js` completely. Pass the hook verbatim as the reload
`initScript`.

## Capture and checkpoints

Keep capture schema version 2.

1. Reload Home with `ignoreCache: true` and the exact hook. Require schema 2,
   at least one feed page, `main#content`, and a local blocked-attempt counter.
2. Scroll Home in bounded batches until eight consecutive stable bottom checks.
   Require exact equality between unique rendered post IDs and unique captured
   feed post IDs.
3. Save the whole capture object to the runner-provided private path and run
   `secure-capture.mjs checkpoint <path> home`.
4. Repeat the unread warning, open Messages, exhaust **Show More** in active and
   archived views, and record the complete initial unread-conversation count
   before opening a conversation.
5. Save and record checkpoint phase `conversation-lists`.
6. Open every conversation. Reverse-scroll
   `#reactConversationMessages` until a page shorter than 20 arrives. Exact
   multiples require the extra empty or short request. Require explicit
   `MessageReactions` evidence for every message, including zero reactions.
7. After every five completed conversations, save the whole capture and record
   checkpoint phase `conversations`.
8. Require captured detail IDs to equal active plus archived list IDs. Set
   `capturedAt` and save the finalized exact capture; record checkpoint phase
   `complete`.

When the runner supplies a resume capture, validate schema/phase and merge its
already captured response pages and workflow evidence into the newly installed
page hook. Continue the next unfinished phase or conversation. Do not redo
completed conversations merely to produce a fresh representation.

Save only through Chrome DevTools `evaluate_script.filePath` to the exact
runner-provided OS-temporary path. Never use a browser download, repository
save, chunked transfer, or parallel capture representation.

Never call `get_network_request` for response bodies because it can expose
headers. Capture only successful JSON response bodies and sanitized response
metadata.

Return only the runner's small validated success/failure contract. A failure
must include the exact phase and error while leaving the newest valid checkpoint
in place.

## Completeness invariants

Do not report capture success unless:

- Home API IDs equal rendered Home IDs;
- active and archived conversation lists each end below ten;
- captured detail IDs equal active plus archived IDs;
- every conversation ends below twenty;
- every message has explicit reaction evidence;
- capture post, conversation, message, reaction, and content-reference counts
  reconcile; and
- the capture contains no credential markers.

## Build, history, and media boundary

The runner transforms a successful capture into manifest schema 3 while
preserving raw post and conversation shapes. Current IDs replace the same prior
IDs; missing prior posts, conversations, messages, and media remain preserved.
Archive state maps record `firstSeen`, `lastSeen`, and `presentInLatest`.

Content includes original post/comment images, MP4 video, video poster frames,
explicit files, invoice PDFs, Message images, and Message files. The runner
counts excluded avatars, profile imagery, liker/reader images, and redundant
derivatives. Any recognized content URL missing from `media.json`, on an
unsupported host/type, or failing download/validation fails the run.

Workers accept only approved Famly HTTPS hosts, reject the killswitch, permit
HTTPS redirects only, and pass signed URLs to `curl` through stdin. URLs must
never enter argv, the shell, `xargs`, viewer responses, or logs.

The previous checksum baseline is verified before reuse. Verified files are
hard-linked into owner-only staging; missing or corrupt media is downloaded
using fresh capture URLs. The complete overlay must pass MIME/signature,
`sips`, path, partial-file, checksum, and credential scans before publication.

Publication is journaled and recoverable. No partial manifest, checksum,
viewer, or media set becomes authoritative, and the viewer never opens after a
failed phase.

## Viewer boundary

The viewer binds only to `127.0.0.1:4173`, enforces the exact Host, requires a
fresh private prefix, omits signed URLs, and denies raw capture/checksum access,
traversal, CORS, and cross-origin archives.

The launch token is passed to macOS through stdin only, never argv,
environment, cookies, or files. Ctrl-C stops the managed server.

Render one chronological filterable timeline. Preserve native MP4 controls,
metadata preload, byte ranges, original links, and collapsed text/file-only
Message disclosures. Every real manifest attachment can be favorited; generated
video posters cannot. ZIPs are conventional unencrypted one-time archives.

## Validation

Before reusable code is delivered, run:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
bash -n .agents/skills/famly-export/scripts/download-media.sh
bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
node --check .agents/skills/famly-export/scripts/run-export.mjs
```

Private output remains ignored and uncommitted. Only the runner, skill code,
tests, CI, and documentation belong in Git.
