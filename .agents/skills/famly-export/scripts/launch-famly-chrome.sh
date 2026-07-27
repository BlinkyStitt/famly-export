#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${HOME:-}" || "$HOME" != /* ]]; then
  echo "The current user's home directory is unavailable" >&2
  exit 1
fi
profile_path="$HOME/Library/Application Support/Famly Export Chrome"
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

if listener_pid=$(lsof -nP -iTCP:"$debug_port" -sTCP:LISTEN -t 2>/dev/null); then
  if [[ "$(printf '%s\n' "$listener_pid" | wc -l | tr -d ' ')" != "1" ]]; then
    echo "Debug port $debug_port has multiple listeners" >&2
    exit 1
  fi
  listener_command=$(ps -p "$listener_pid" -o command=)
  case "$listener_command" in
    *"Google Chrome"*\
*"--user-data-dir=$profile_path"*\
*"--remote-debugging-address=127.0.0.1"*\
*"--remote-debugging-port=$debug_port"*)
      printf 'Reusing dedicated Famly Chrome profile: %s\n' "$profile_path"
      exit 0
      ;;
    *)
      echo "Debug port $debug_port is occupied by an unexpected process" >&2
      exit 1
      ;;
  esac
fi

open -na "Google Chrome" --args \
  "--user-data-dir=$profile_path" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$debug_port" \
  "https://app.famly.co/"

printf 'Dedicated Famly Chrome profile: %s\n' "$profile_path"
printf 'DevTools endpoint: http://127.0.0.1:%s\n' "$debug_port"
printf 'Sign in to Famly yourself in this Chrome window, then open Home.\n'
