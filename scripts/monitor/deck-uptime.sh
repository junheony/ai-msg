#!/bin/bash
# External uptime monitor for deck — runs on another machine (a Linux box on the same tailnet), so a Mac whose
# server died, or whose relaunch loop is stuck, is noticed by someone within minutes instead of 47 of them (2026-10-11).
#
# Install (on the monitoring box):  copy this file to ~/bin/deck-uptime.sh, then
#   mkdir -p ~/.deck-monitor && $EDITOR ~/.deck-monitor/deck-uptime.env    # DECK_UPTIME_URL=https://<magicdns-name>/  TG_BOT_TOKEN=…  TG_CHAT_ID=…  [TG_THREAD_ID=…]
#   crontab: * * * * * /bin/bash ~/bin/deck-uptime.sh >> ~/.deck-monitor/cron.err.log 2>&1
#
# Each run probes /api/me once: 401 (not logged in) or 200 means the server is up — anything else is a failure.
# No HTTP answer at all → one retry, then two unrelated control sites: if those are silent too this box is blind,
# not deck down (log BLIND, touch nothing, say nothing). FAIL_THRESHOLD consecutive failures → one 🔴; one 🟢 when it
# returns, with how long it was down. State and log live in $DIR; secrets only in the env file (never in this repo).
set -uo pipefail

DIR="${DECK_UPTIME_DIR:-$HOME/.deck-monitor}"
mkdir -p "$DIR"
[ -r "$DIR/deck-uptime.env" ] && . "$DIR/deck-uptime.env"
URL="${DECK_UPTIME_URL:-}"
CONTROLS="${DECK_UPTIME_CONTROLS:-https://www.cloudflare.com/cdn-cgi/trace https://www.google.com/generate_204}"
RETRY_SLEEP="${DECK_UPTIME_RETRY_SLEEP:-5}"
FAIL_THRESHOLD="${DECK_UPTIME_FAIL_THRESHOLD:-2}"
STATE="$DIR/uptime.state"
LOG="$DIR/uptime.log"
[ -n "$URL" ] || { echo "deck-uptime: DECK_UPTIME_URL 이 없습니다 ($DIR/deck-uptime.env)" >&2; exit 2; }
URL="${URL%/}/api/me"

now() { date '+%Y-%m-%dT%H:%M:%S%z'; }
clock() { date '+%H:%M'; }
notify() {
  # DECK_UPTIME_NOTIFY_FILE: append instead of sending (tests, dry runs).
  if [ -n "${DECK_UPTIME_NOTIFY_FILE:-}" ]; then printf '%s\n' "$1" >> "$DECK_UPTIME_NOTIFY_FILE"; return 0; fi
  [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] || return 0
  curl -s -m 15 -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT_ID}" \
    ${TG_THREAD_ID:+--data-urlencode "message_thread_id=${TG_THREAD_ID}"} \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

prev_fails=0 prev_alerted=0 down_since=""
[ -r "$STATE" ] && read -r prev_fails prev_alerted down_since < "$STATE" 2>/dev/null || true
prev_fails=${prev_fails:-0}; prev_alerted=${prev_alerted:-0}; down_since=${down_since:-}

# One look. Sets: code (HTTP status, 000 = no answer).
probe() { code=$(curl -4 -s -o /dev/null -m 12 -w '%{http_code}' "$URL" 2>/dev/null); code=${code:-000}; }
probe
if [ "$code" = "000" ]; then
  sleep "$RETRY_SLEEP"; probe
  if [ "$code" = "000" ]; then
    seen=0
    for c in $CONTROLS; do
      cc=$(curl -4 -s -o /dev/null -m 10 -w '%{http_code}' "$c" 2>/dev/null)
      [ -n "$cc" ] && [ "$cc" != "000" ] && seen=1 && break
    done
    if [ "$seen" = 0 ]; then echo "$(now) BLIND (no HTTP anywhere — this box's uplink)" >> "$LOG"; exit 0; fi
  fi
fi

ok=0
case "$code" in 200|401) ok=1 ;; esac

if [ "$ok" = 1 ]; then
  if [ "$prev_alerted" = 1 ]; then
    mins=""
    if [ -n "$down_since" ]; then s=$(date -d "$down_since" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%S%z' "$down_since" +%s 2>/dev/null || echo ""); [ -n "$s" ] && mins=" · $(( ($(date +%s) - s) / 60 ))분 중단"; fi
    notify "🟢 deck 복구 — $(clock) 다시 응답${mins}"
    echo "$(now) RECOVERED (HTTP $code)${mins}" >> "$LOG"
  elif [ "$prev_fails" -gt 0 ]; then
    echo "$(now) OK again after $prev_fails miss(es) (HTTP $code)" >> "$LOG"
  fi
  printf '0 0 \n' > "$STATE"
  exit 0
fi

fails=$((prev_fails + 1))
[ -n "$down_since" ] || down_since=$(now)
echo "$(now) FAIL $fails (HTTP $code)" >> "$LOG"
alerted=$prev_alerted
if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ "$prev_alerted" = 0 ]; then
  if [ "$code" = "000" ]; then why="응답 없음 — 서버가 죽었거나 Mac 이 tailnet 에서 빠짐"; else why="HTTP $code"; fi
  notify "🔴 deck 서버 ${why} · $(clock)부터 (${fails}회 연속). 확인: Mac 에서 ~/.config/deck/relaunch.sh status · tail ~/.config/deck/deck.log"
  alerted=1
fi
printf '%s %s %s\n' "$fails" "$alerted" "$down_since" > "$STATE"
