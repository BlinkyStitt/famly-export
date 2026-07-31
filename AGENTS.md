# Repository instructions

- Treat `metadata/`, `photos/`, `videos/`, `files/`, `message-images/`, and
  `messages/` as private generated family data. Do not inspect their contents
  unless the user explicitly requests it. Never commit, upload, log, or use
  them as test fixtures.
- Never ask for or inspect a Famly password, request header, cookie, browser
  storage value, access token, or browser profile file.
- Use `./famly-export` as the only user-facing command. Do not expose internal
  scripts as alternate workflows or subcommands.
- Preserve the isolated `famly-chrome` profile boundary. Never attach the
  exporter to the user's ordinary Chrome profile.
- Keep `famly-chrome` in the tracked project `.codex/config.toml`. Never add,
  repair, or mutate an MCP entry in the user's `~/.codex/config.toml`.
- Before changing capture, security, completeness, publication, or viewer
  behavior, read `.agents/skills/famly-export/SKILL.md` and every directly
  referenced instruction file required for that change.
- Treat the skill, its DevTools workflow, and the implementation as the
  canonical technical contracts. Keep the README parent-facing and put
  maintainer guidance in `CONTRIBUTING.md`.
- Keep tests synthetic and local. Do not add CI that claims authenticated Famly
  capture coverage.
- Before committing, run:

  ```sh
  node --test .agents/skills/famly-export/tests/*.test.mjs
  bash -n .agents/skills/famly-export/scripts/download-media.sh
  bash -n .agents/skills/famly-export/scripts/launch-famly-chrome.sh
  node --check .agents/skills/famly-export/scripts/run-export.mjs
  ```
