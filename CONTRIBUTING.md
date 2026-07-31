# Contributing

Famly exports contain private information about children and families. Never
commit generated export data, copy it into fixtures, include it in logs, or
upload it for debugging. Tests must use synthetic records only.

## Project boundaries

`./famly-export` is the only supported user-facing command. The scripts under
`.agents/skills/famly-export/scripts/` are internal implementation phases, not
separate user commands.

The exporter uses an isolated Chrome profile:

```text
${HOME}/Library/Application Support/Famly Export Chrome
```

Do not attach it to the user's ordinary Chrome profile. Famly authentication is
always performed manually by the user in the visible dedicated window.

The canonical implementation contracts live in:

- [the Famly export skill](.agents/skills/famly-export/SKILL.md);
- [the Chrome DevTools capture workflow](.agents/skills/famly-export/references/devtools-workflow.md);
- [the tracked page capture hook](.agents/skills/famly-export/scripts/capture-hook.js);
- [the unified runner](.agents/skills/famly-export/scripts/run-export.mjs); and
- [the local test suite](.agents/skills/famly-export/tests/).

Read those sources before changing capture, security, completeness,
publication, or viewer behavior. Do not duplicate their exact protocols in
another document.

## Local setup and validation

Install the project tools with:

```sh
brew bundle
```

Run the complete local test suite and syntax checks:

```sh
node --test .agents/skills/famly-export/tests/*.test.mjs
bash -n .agents/skills/famly-export/scripts/download-media.sh
bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
node --check .agents/skills/famly-export/scripts/run-export.mjs
```

Set `FAMLY_REAL_CHROME_E2E=1` on macOS to include the isolated real-Chrome
fixture. The fixture uses a local test server and synthetic data. Authenticated
Famly capture remains an interactive local operation and must not be presented
as CI coverage.

## Troubleshooting

Run the MCP check from the repository. It shows the tracked project
configuration and the local
listeners:

```sh
codex mcp get famly-chrome
lsof -nP -iTCP:9223 -sTCP:LISTEN
lsof -nP -iTCP:4173 -sTCP:LISTEN
```

The pinned, hardened `famly-chrome` configuration lives only in the tracked
`.codex/config.toml`. The exporter validates that file and never installs or
modifies a user-level MCP entry. When diagnosing a failure, report the exact
failed phase and preserve the previous verified export and any valid partial
capture checkpoint.

## Before committing

- Keep private output ignored and untracked.
- Run the validation commands appropriate to the change.
- Inspect the complete diff for private records, credentials, signed URLs, and
  machine-specific paths.
- Commit one coherent, task-scoped change set.
