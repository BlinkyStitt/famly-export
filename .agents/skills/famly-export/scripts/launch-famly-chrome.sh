#!/usr/bin/env bash
set -euo pipefail
umask 077

profile_path="/Users/bryan/Library/Application Support/Famly Export Chrome"
chrome_app="/Applications/Google Chrome.app"
debug_port=9223

if [[ ! -d "$chrome_app" ]]; then
  echo "Google Chrome is not installed at $chrome_app" >&2
  exit 1
fi

if [[ -L "$profile_path" ]]; then
  echo "Refusing symbolic-link Chrome profile: $profile_path" >&2
  exit 1
fi

mkdir -p "$profile_path"
if [[ "$(stat -f '%u' "$profile_path")" != "$(id -u)" ]]; then
  echo "Chrome profile is not owned by the current user: $profile_path" >&2
  exit 1
fi
chmod 700 "$profile_path"

if lsof -nP -iTCP:"$debug_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Debug port $debug_port is already in use" >&2
  exit 1
fi

open -na "Google Chrome" --args \
  "--user-data-dir=$profile_path" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$debug_port" \
  "https://app.famly.co/"

printf 'Dedicated Famly Chrome profile: %s\n' "$profile_path"
printf 'DevTools endpoint: http://127.0.0.1:%s\n' "$debug_port"
printf 'Sign in to Famly yourself in this Chrome window, then open Home.\n'
