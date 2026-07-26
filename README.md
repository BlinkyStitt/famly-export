# Export Famly photos with Codex and Chrome DevTools

This repository contains a Codex skill that exports the signed-in Famly Home
feed and downloads its photos for private offline backup. It uses Chrome
DevTools MCP to control your existing Chrome profile; you sign in to Famly
yourself and never give the agent your password.

The export is private. Posts can include names, comments, observations, and
group photos of other people's children. Keep the output out of Git, cloud
drives, and public links unless you have deliberately chosen a suitable private
location.

## What the skill exports

- Every post returned by the Famly Home feed after scrolling to its oldest item.
- Post text and metadata as JSON.
- Each unique post photo at the dimensions Famly records for the original.
- A photo-to-post manifest and SHA-256 checksums.

It does not export Messages. Videos and non-image attachments are counted in
the post metadata but are not downloaded.

## Requirements

- macOS with a current Codex desktop app.
- Google Chrome 144 or newer.
- Node.js and `npx`.
- `jq`, `curl`, and the macOS `file`, `shasum`, and `sips` utilities.
- Enough local disk space for the original photos.

The direct Chrome DevTools MCP configuration is required. The in-app Browser
plugin is not used because it has a separate browser profile.

## 1. Make the repository skill available

Open this repository as the Codex workspace. Codex discovers repository skills
under `.agents/skills`, including:

```text
.agents/skills/famly-export/SKILL.md
```

If the skill does not appear in `/skills` or when you type `$famly-export`,
restart Codex after opening the repository.

Codex also supports user-global skills under `~/.agents/skills`, but copying
this skill there is optional.

See OpenAI's [Build skills documentation](https://developers.openai.com/codex/build-skills)
for the current skill discovery and invocation model.

## 2. Configure Chrome DevTools MCP

The known-working setup uses `chrome-devtools-mcp` 1.6.0 and a distinct MCP
server name, `famly-chrome`:

```sh
codex mcp add famly-chrome -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --autoConnect \
  --allowUnrestrictedPaths \
  --redactNetworkHeaders
```

Why each option is present:

- `--autoConnect` attaches to an already-running Chrome profile instead of
  launching a dedicated automation profile.
- `--allowUnrestrictedPaths` lets the MCP tool save the captured feed JSON into
  this workspace. It is broad filesystem authority, so use this server only
  with trusted skills and prompts.
- `--redactNetworkHeaders` reduces the chance of browser request credentials
  appearing in tool output.

Verify the server:

```sh
codex mcp get famly-chrome
codex mcp list
```

If `famly-chrome` already exists, inspect its arguments with `codex mcp get
famly-chrome`. If they do not include all four arguments from the command
above, replace the configuration:

```sh
codex mcp remove famly-chrome
codex mcp add famly-chrome -- \
  npx -y chrome-devtools-mcp@1.6.0 \
  --autoConnect \
  --allowUnrestrictedPaths \
  --redactNetworkHeaders
```

For longer scroll operations, add these settings to the generated
`[mcp_servers.famly-chrome]` table in `~/.codex/config.toml`:

```toml
startup_timeout_sec = 30
tool_timeout_sec = 120
```

You can also add the STDIO server from **Codex Settings → MCP servers**. Use:

```text
Command: npx
Arguments: -y chrome-devtools-mcp@1.6.0 --autoConnect --allowUnrestrictedPaths --redactNetworkHeaders
```

Save it as `famly-chrome`, then select **Restart**. Codex's
[MCP documentation](https://developers.openai.com/codex/mcp) describes both
the Settings and CLI configuration routes.

### Optional Chrome DevTools plugin

No plugin is required. If you also want the **Chrome DevTools MCP** plugin's
companion debugging skills, open **Plugins** in the ChatGPT desktop app's
Codex surface, search for the plugin, select **+**, and start a new chat. In
Codex CLI, run `/plugins`, install it from the available marketplace, and
start a new session.

The plugin does not replace the `famly-chrome` configuration above. Its
default server may launch a separate Chrome profile and may not have the
filesystem option this export needs. The skill deliberately requires the
named `famly-chrome` server. See OpenAI's
[plugin installation guide](https://developers.openai.com/codex/plugins).

## 3. Enable access to the existing Chrome profile

1. Start the normal Chrome profile that is already signed in to Famly.
2. Open `chrome://inspect/#remote-debugging`.
3. Enable remote debugging.
4. Accept Chrome's incoming debugging connection prompt.
5. Keep Chrome and the Famly tab open.
6. Restart Codex so it loads the `famly-chrome` MCP server.

Chrome DevTools MCP's
[existing-browser instructions](https://github.com/ChromeDevTools/chrome-devtools-mcp#automatically-connecting-to-a-running-chrome-instance)
document the `--autoConnect` flow. If several Chrome profiles are running,
Chrome chooses its default profile. The skill verifies that the connected
profile contains the signed-in Famly tab before it proceeds.

Remote debugging exposes every open tab in that Chrome profile to the MCP
server. Close unrelated sensitive tabs first, and disable remote debugging
when the export is finished.

## 4. Sign in to Famly yourself

In the same Chrome profile:

1. Open <https://app.famly.co/>.
2. Sign in yourself.
3. Open the **Home** tab.

Do not paste a password, session token, cookie, saved page, or DevTools request
headers into Codex.

## 5. Run the skill

From a Codex conversation whose workspace is this repository, invoke:

```text
$famly-export Export the Famly Home feed and download all original photos into this workspace. Use the already-signed-in Chrome profile.
```

The skill will:

1. Verify the `famly-chrome` connection and select the signed-in Famly Home tab.
2. Install an in-page response capture before reloading the feed.
3. Scroll in bounded batches until the feed has stopped growing.
4. Compare DOM post IDs with the unique captured API post IDs.
5. Save response bodies only; it never deliberately saves request headers.
6. Build manifests, download original photos, validate every file, and write
   checksums.

Leave Chrome open while it runs. A large history can take several minutes and
more than a gigabyte of disk space.

## Output

```text
metadata/
├── captured-feed-pages.json
├── export-summary.json
├── photo-checksums.sha256
├── photos.json
└── posts.json
photos/
└── <year>/
    └── <post-date>_<post-id>_<image-id>.<extension>
```

The repository `.gitignore` excludes `metadata/`, `photos/`, and partial
downloads. Do not override that protection for a normal family backup.

## Troubleshooting

### `Could not find DevToolsActivePort`

Confirm that Chrome 144+ is already running, remote debugging is enabled at
`chrome://inspect/#remote-debugging`, and Chrome has accepted the connection.
Then restart Codex and run `codex mcp list`.

### Famly opens at `#/login`

The MCP server is attached to the wrong Chrome profile. Stop rather than asking
the agent to sign in. Ensure `famly-chrome` uses `--autoConnect`, open Famly in
Chrome's default profile, and retry.

### A separate blank Chrome profile opens

The agent selected a plugin's default Chrome DevTools server instead of
`famly-chrome`. Explicitly invoke `$famly-export` and require the
`famly-chrome` server.

### The scroll command times out

Set `tool_timeout_sec = 120` and rerun the skill. The skill uses short,
continuable batches and must not start a duplicate scroll while one is still
running.

### Feed replay returns HTTP 403

Do not copy an access token from DevTools or inspect browser storage. Famly
adds an application authorization header to its own requests. The skill
captures successful response bodies from the site's normal reload instead of
replaying the endpoint manually.

### Photo downloads return 403 or 404

Famly's signed image URLs expire. Rerun the capture stage to refresh
`metadata/photos.json`, then resume the downloader; already-complete files are
skipped.

## Disconnect after the export

Turn off remote debugging at `chrome://inspect/#remote-debugging`.

To remove the dedicated MCP server:

```sh
codex mcp remove famly-chrome
```

Restart Codex after removing it.
