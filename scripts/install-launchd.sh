#!/usr/bin/env bash
# Installs deck as a user LaunchAgent (com.deck.server): starts at login. launchd runs node on
# ~/.config/deck/boot.mjs, which runs the relaunch loop (~/.config/deck/relaunch.sh) — that loop restarts the server
# whenever it exits, which is how `npm run restart` (graceful) comes back up. Grant Full Disk Access to the node
# binary this prints (System Settings › Privacy & Security), or macOS refuses it the checkout under ~/Documents.
#   scripts/install-launchd.sh              # install or update, then (re)start under launchd
#   scripts/install-launchd.sh --uninstall  # stop (gracefully) and remove the agent
# Run it from the checkout launchd should serve (relaunch.env points at this directory).
# A deck server already listening on the port is handed over: it drains, then the agent's loop starts the new one
# (a hand-started relaunch loop is stopped first; its server keeps running until then).
set -euo pipefail

LABEL="com.deck.server"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO/scripts/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.config/deck"
ENV_FILE="$CONF_DIR/env"
DOMAIN="gui/$(id -u)"

envval() { [[ -f "$ENV_FILE" ]] && sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1 | tr -d "\"'" || true; }
PORT="$(envval DECK_PORT)"; PORT="${PORT:-${DECK_PORT:-9320}}"
# DECK_DRAIN_MAX_MIN unset, empty or 0: the server drains until its work ends (DRAIN_S=0 here = no limit).
DRAIN_MIN="$(envval DECK_DRAIN_MAX_MIN)"
DRAIN_S="$(awk -v m="$DRAIN_MIN" 'BEGIN { s = int(m * 60); print (s > 0 ? s : 0) }')"
if (( DRAIN_S > 0 )); then DRAIN_TXT="최대 ${DRAIN_MIN}분"; else DRAIN_TXT="끝날 때까지 — Ctrl-C 로 그만 기다림"; fi
# launchd SIGKILLs a job it stops after ExitTimeOut; with no drain limit, a day (0 would mean forever and can stall logout).
EXIT_TIMEOUT=$(( DRAIN_S > 0 ? DRAIN_S + 60 : 86400 ))

listener() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# SIGTERM = graceful drain (new turns refused, running ones finish); a second SIGTERM after the window (none with no limit).
stop_listener() {
  local pid
  pid="$(listener || true)"
  [[ -z "$pid" ]] && return 0
  echo "deck: 포트 $PORT 의 서버(pid $pid)에 SIGTERM — 진행 중인 턴이 끝나길 기다립니다 (${DRAIN_TXT})"
  echo "      (이 변경 전 버전의 서버라면 기다리지 않고 바로 끝나며 진행 중인 턴도 끊깁니다)"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( DRAIN_S > 0 && waited >= DRAIN_S + 30 )); then
      echo "deck: 대기 시간 초과 — 즉시 종료 신호를 다시 보냅니다"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 3
      break
    fi
    sleep 2; waited=$((waited + 2))
    (( waited % 30 == 0 )) && echo "deck: 아직 종료 대기 중 (${waited}s)"
  done
  for _ in $(seq 1 15); do [[ -z "$(listener || true)" ]] && return 0; sleep 1; done
  echo "deck: 포트 $PORT 가 아직 사용 중입니다 — 확인 후 다시 실행하세요 (lsof -iTCP:$PORT -sTCP:LISTEN)" >&2
  exit 1
}

unload() {
  if loaded; then
    echo "deck: 기존 LaunchAgent 내림 (SIGTERM → 드레인, ${DRAIN_TXT})"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 "$EXIT_TIMEOUT"); do loaded || break; sleep 1; done
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  stop_listener
  rm -f "$PLIST_DST"
  echo "deck: LaunchAgent 제거 완료 ($PLIST_DST)"
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "deck: node 를 찾을 수 없습니다 (PATH 확인)" >&2; exit 1; }
# The real file, not a symlink: Full Disk Access is granted to (and checked against) the binary itself.
NODE="$(realpath "$NODE")"
NODE_DIR="$(dirname "$NODE")"
LAUNCH_PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[[ -e "$REPO/node_modules/tsx" ]] || { echo "deck: $REPO/node_modules 가 없습니다 — npm install 먼저" >&2; exit 1; }
[[ -f "$REPO/dist/ui/index.html" ]] || echo "deck: 경고 — dist/ui 가 없습니다. npm run build 를 먼저 하세요 (UI 가 안 뜹니다)"

mkdir -p "$CONF_DIR" "$HOME/Library/LaunchAgents"
if [[ ! -f "$ENV_FILE" ]]; then
  {
    echo "# deck 서버 환경 (launchd 가 시작할 때마다 scripts/launchd/run.sh 가 읽음). KEY=value 한 줄씩."
    echo "DECK_EXTRA_HOSTS=${DECK_EXTRA_HOSTS:-}"
    echo "# DECK_DRAIN_MAX_MIN=15   # 재시작 때 진행 중 작업을 기다리는 최대 분 (기본·0: 끝날 때까지, 다시 신호를 보내면 즉시 종료)"
    echo "# DECK_BG_MAX_MIN=120     # 턴 뒤 백그라운드 작업을 기다리는 최대 분 (기본·0: 끝날 때까지)"
    echo "# DECK_STEER=0            # 실행 중 보낸 메시지를 턴에 끼워 넣지 않고 턴 뒤로 미룸 (기본 켜짐)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "deck: $ENV_FILE 생성 (DECK_EXTRA_HOSTS=${DECK_EXTRA_HOSTS:-비어 있음})"
fi

# Stop a hand-started loop before overwriting its script (sh reads a script as it runs); its server keeps running.
[[ -x "$CONF_DIR/relaunch.sh" ]] && "$CONF_DIR/relaunch.sh" stop >/dev/null 2>&1 || true
sh "$REPO/scripts/relaunch.sh" install >/dev/null
cp "$REPO/scripts/launchd/boot.mjs" "$CONF_DIR/boot.mjs"

TMP="$(mktemp)"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$LAUNCH_PATH|g" -e "s|__EXIT_TIMEOUT__|$EXIT_TIMEOUT|g" "$PLIST_SRC" > "$TMP"
plutil -lint "$TMP" >/dev/null

unload
mv "$TMP" "$PLIST_DST"
chmod 644 "$PLIST_DST"
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "deck: 전체 디스크 접근이 필요한 node: $NODE"
for _ in $(seq 1 30); do
  if pid="$(listener)" && [[ -n "$pid" ]] && "$CONF_DIR/relaunch.sh" status >/dev/null 2>&1; then
    echo "deck: launchd 등록 완료 (서버 pid $pid, 포트 $PORT — 이전 서버였다면 진행 중 턴이 끝난 뒤 새 서버로 바뀜) · 로그 $CONF_DIR/deck.log"
    echo "      재시작: npm run restart · 상태: launchctl print $DOMAIN/$LABEL · 제거: $0 --uninstall"
    exit 0
  fi
  sleep 1
done
echo "deck: 30초 안에 포트 $PORT 가 열리지 않았습니다 — $CONF_DIR/deck.log 를 확인하세요" >&2
exit 1
