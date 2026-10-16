#!/usr/bin/env bash
# Graceful restart of the running deck server: SIGUSR2 → it stops taking sends that need a new process, waits for
# running turns and live background work (subagents, Monitor) until they end — or, with DECK_DRAIN_MAX_MIN set, for at
# most that many minutes — a process held open with no work left is ended at once — then exits; launchd (KeepAlive)
# starts it again. Work still running at a DECK_DRAIN_MAX_MIN deadline, or when a second signal forces the exit, is
# cut: the pane says so and the session's next turn tells the model. Without launchd the server just stops — start it
# again yourself.
# Before signalling, the server's activity file ($DECK_CONFIG_DIR/activity.json) is read: with a turn running or
# background work live, or the server already draining (a second signal skips the wait), nothing is sent (exit 2)
# unless --force. An activity file that is missing or unreadable is reported on one line and the restart goes ahead.
#   npm run restart                    # signal and return (refused while work is in progress)
#   npm run restart -- --force         # signal even then (the list is still shown)
#   npm run restart -- --wait          # also wait until a new server listens again (combines with --force)
set -euo pipefail

PORT="${DECK_PORT:-9320}"
WAIT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --wait) WAIT=1 ;;
    --force) FORCE=1 ;;
    *) echo "deck: 알 수 없는 인자: $arg (쓸 수 있는 것: --wait --force)" >&2; exit 64 ;;
  esac
done

listener() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1; }

pid="$(listener || true)"
if [[ -z "$pid" ]]; then
  echo "deck: 포트 $PORT 에서 실행 중인 서버가 없습니다" >&2
  exit 1
fi

ACTIVITY="${DECK_CONFIG_DIR:-$HOME/.config/deck}/activity.json"
# Unknown what is running: say so on one line and restart anyway (no file = a server from before activity.json: normal).
unchecked() { echo "deck: 진행 중 작업을 확인하지 못해 그대로 재시작합니다 ($1)" >&2; }
if [[ ! -f "$ACTIVITY" ]]; then
  unchecked "활동 파일 없음"
elif ! command -v node >/dev/null 2>&1; then
  unchecked "node 없음"
else
  # First line: draining=0|1 (or "!reason" when the file cannot be used); then one line per session with work in progress.
  out="$(node -e '
    const fs = require("fs"), path = require("path");
    let a; try { a = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("!" + (e instanceof SyntaxError ? "JSON 깨짐" : "읽기 실패")); process.exit(0); }
    if (!a || !Array.isArray(a.sessions)) { console.log("!형식이 다름"); process.exit(0); }
    if (String(a.pid) !== process.argv[2]) { console.log("!다른 서버의 파일 (pid " + a.pid + ")"); process.exit(0); }
    console.log("draining=" + (a.draining === true ? 1 : 0));
    for (const s of a.sessions) {
      const bg = Number(s.bg) || 0;
      if (!s.running && bg <= 0) continue;
      const tasks = Array.isArray(s.tasks) ? s.tasks.join(", ") : "";
      const what = s.running ? "실행 중" + (bg > 0 ? ` · 백그라운드 ${bg}개: ${tasks}` : "") : `백그라운드 ${bg}개: ${tasks}`;
      console.log(`  ${String(s.sessionId).slice(0, 8)}  ${path.basename(String(s.cwd || ""))}  ${what}`);
    }
  ' "$ACTIVITY" "$pid" 2>/dev/null)" || out="!node 실행 실패"
  head_line="${out%%$'\n'*}"
  if [[ "$head_line" == '!'* ]]; then
    unchecked "${head_line#!}"
  else
    busy="$(printf '%s\n' "$out" | tail -n +2)"
    if [[ "$head_line" == "draining=1" ]]; then
      [[ -n "$busy" ]] && echo "$busy" >&2
      if [[ $FORCE -eq 0 ]]; then
        echo "deck: 이미 재시작 대기 중 — 다시 보내면 기다리지 않고 즉시 끊습니다. 기다리거나 --force" >&2
        exit 2
      fi
      echo "deck: --force — 재시작 대기 중인 서버를 즉시 끊습니다" >&2
    elif [[ -n "$busy" ]]; then
      echo "$busy" >&2
      if [[ $FORCE -eq 0 ]]; then
        echo "deck: 진행 중인 작업이 있어 재시작하지 않습니다 — 끝난 뒤 다시 하거나 --force (서버는 작업이 끝날 때까지 기다림 — DECK_DRAIN_MAX_MIN 을 주면 그 시간 뒤 끊김)" >&2
        exit 2
      fi
      echo "deck: --force — 위 작업이 끝나기를 기다린 뒤 재시작합니다 (DECK_DRAIN_MAX_MIN 을 주면 최대 그 시간, 한 번 더 --force 하면 즉시)" >&2
    fi
  fi
fi

kill -USR2 "$pid"
echo "deck: 재시작 요청 보냄 (pid $pid) — 진행 중인 작업이 끝나면 종료되고 launchd 가 다시 띄웁니다"
[[ $WAIT -eq 1 ]] || exit 0

while kill -0 "$pid" 2>/dev/null; do sleep 2; done
echo "deck: 이전 서버 종료됨 (pid $pid)"
for _ in $(seq 1 30); do
  new="$(listener || true)"
  if [[ -n "$new" && "$new" != "$pid" ]]; then echo "deck: 새 서버 실행 중 (pid $new)"; exit 0; fi
  sleep 1
done
echo "deck: 30초 안에 새 서버가 뜨지 않았습니다 — launchd 로 실행 중인지 확인하세요 (launchctl print gui/$(id -u)/com.deck.server)" >&2
exit 1
