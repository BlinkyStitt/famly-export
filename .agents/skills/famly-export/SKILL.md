---
name: famly-export
description: Export a signed-in Famly Home feed and download its original post photos for a private offline backup through Chrome DevTools MCP. Use when a user asks to back up, archive, download, or verify Famly posts and photos from their existing Chrome session without sharing a password. Covers infinite-scroll capture, post and image manifests, expiring image URLs, full-resolution downloads, and completeness validation; excludes Famly Messages unless the user separately requests them.
---

# Famly Export

Export only data the user is authorized to access. Treat all output as private.
Never ask for or inspect the user's Famly password, cookies, local storage,
session store, or browser profile files.

## Required control surface

Use the Chrome DevTools MCP server named `famly-chrome`. It must be configured
with `--autoConnect` so it attaches to the user's existing Chrome profile.
Never substitute the in-app Browser, a dedicated automation profile, a saved
page, Playwright, or direct profile-file access.

If the server is unavailable, stop and ask the user to complete the setup in
the repository `README.md`. If the connected profile lacks an authenticated
Famly Home tab, ask the user to sign in there themselves and tell you when it
is ready.

Before browser work, read
[`references/devtools-workflow.md`](references/devtools-workflow.md) completely.
Use its exact capture and scroll snippets.

## Export workflow

1. Set the output root to the current workspace unless the user supplied a
   narrower directory. Resolve its absolute path.
2. Confirm `jq`, `curl`, `file`, `shasum`, and `sips` exist. Confirm enough
   disk space is available. Never commit or upload export output.
3. Discover `famly-chrome` tools if they are deferred. Use its `list_pages`
   tool, then select the authenticated page whose URL begins
   `https://app.famly.co/#/account/home`.
4. Reload that page with the reference's response-capture `initScript`.
   Capture only successful response bodies for `/api/feed/feed/feed`; do not
   call `get_network_request` in a way that prints request headers.
5. Scroll the `main#content` container in bounded batches. Wait for each batch
   to finish. Never start a duplicate scroll command. Continue until one batch
   reports eight consecutive stable bottom checks.
6. Save the reference's final capture object through `evaluate_script` using
   an absolute `filePath`:

   ```text
   <output-root>/metadata/captured-feed-pages.json
   ```

   The MCP server needs `--allowUnrestrictedPaths` for this operation in
   clients that do not negotiate filesystem roots.
7. Run:

   ```sh
   bash <skill-dir>/scripts/build-manifests.sh \
     <output-root>/metadata/captured-feed-pages.json \
     <output-root>
   ```

   Treat a DOM/API post-count mismatch as an incomplete capture. Return to the
   browser, refresh the capture, and do not download from an incomplete
   manifest.
8. Run:

   ```sh
   bash <skill-dir>/scripts/download-photos.sh \
     <output-root>/metadata/photos.json \
     <output-root> \
     8
   ```

   Do not weaken failures or silently fall back to thumbnail URLs. If signed
   URLs expired, recapture the feed to obtain fresh URLs and resume; completed
   files are skipped.
9. Read `metadata/export-summary.json` and compare:
   - unique captured API posts to DOM post IDs;
   - manifest photo count to downloaded file count;
   - partial count to zero;
   - decoder validation to success.
10. Scan the output for `x-famly-accesstoken` and
    `famly.session-marker`. A match is a security failure: stop, identify the
    affected generated file without printing the value, and remove the
    credential-bearing artifact.

## Completion

Report:

- output paths;
- captured post count and date range;
- unique full-resolution photo count and total size;
- checksum path;
- validation results;
- excluded scope, especially Messages, videos, and other files.

Stop the active DevTools controller if this run started one. Remind the user to
turn off Chrome remote debugging at
`chrome://inspect/#remote-debugging`. Leave private output untracked and
uncommitted.
