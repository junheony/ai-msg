#!/bin/bash
# launchd entry point for com.deck.server: load ~/.config/deck/env (KEY=value lines, e.g.
# DECK_EXTRA_HOSTS=…), then run the server as one node process (signals reach it directly).
set -euo pipefail
ENV_FILE="${DECK_ENV_FILE:-$HOME/.config/deck/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
# Started by the relaunch loop (an installed copy older than DECK_SUPERVISED included): it will start us again.
# The loop's exact command shape (serverUpdate.ts RELAUNCH_LOOP_RE), not any command that mentions relaunch.
if [[ -z "${DECK_SUPERVISED:-}" ]] && ps -o command= -p "$PPID" 2>/dev/null | grep -Eq '^(/bin/)?(ba)?sh ([^ ]*/)?relaunch\.sh( [^ ]+)*$'; then export DECK_SUPERVISED=1; fi
cd "$(dirname "$0")/../.."
echo "deck: launchd 시작 $(date '+%Y-%m-%d %H:%M:%S') · node $(node --version) · $(pwd)"
exec node --import tsx src/server/main.ts
