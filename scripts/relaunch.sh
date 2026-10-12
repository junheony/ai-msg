#!/bin/sh
# deck relaunch — keeps the server up, where launchd no longer can (macOS TCC refuses launchd's bash a repo under ~/Documents).
#
#   scripts/relaunch.sh install        copy this script to <config>/relaunch.sh (outside Documents) and remember the repo path
#   relaunch.sh [OLD_SERVER_PID]       run the loop; with a pid: USR2 it first (drain, then exit) and take over
#   relaunch.sh stop | status          stop the loop (the server keeps running) / show whether it runs
#
# Start it detached, so it outlives the shell that typed it:
#   perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' nohup "$HOME/.config/deck/relaunch.sh" >/dev/null 2>&1 &
#
# Never gives up. The 2026-10-11 outage (47 min, nobody noticed) was a loop that quit after five failures whose cause —
# rc=126, bash could not even read run.sh — went away by itself an hour later. Instead: backoff 5 s → 5 min between
# attempts; a server that lived ≥ 60 s resets it. One loop at a time (pidfile). Log rotation at 50 MiB.
set -u
CONF="${DECK_CONFIG_DIR:-$HOME/.config/deck}"
LOG="${DECK_RELAUNCH_LOG:-$CONF/deck.log}"
PIDFILE="$CONF/relaunch.pid"
ENVFILE="$CONF/relaunch.env"      # DECK_DIR=<repo>, written by `install`
BASE="${DECK_RELAUNCH_BASE:-5}"; CAP="${DECK_RELAUNCH_CAP:-300}"; HEALTHY="${DECK_RELAUNCH_HEALTHY:-60}"
ROTATE_BYTES="${DECK_RELAUNCH_ROTATE:-52428800}"

here="$(cd "$(dirname "$0")" && pwd)"
[ -r "$ENVFILE" ] && . "$ENVFILE"
DECK_DIR="${DECK_DIR:-$(cd "$here/.." 2>/dev/null && pwd)}"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "deck: relaunch $(stamp) · $*" >> "$LOG"; }
alive() { kill -0 "$1" 2>/dev/null; }
# The loop's pid from the pidfile, when that process is alive and is a relaunch loop (a reused pid is not).
running_pid() {
  [ -r "$PIDFILE" ] || return 1
  read -r p < "$PIDFILE" || return 1
  [ -n "$p" ] && alive "$p" && ps -o command= -p "$p" 2>/dev/null | grep -q relaunch && echo "$p"
}

case "${1:-}" in
  install)
    mkdir -p "$CONF"
    cp "$0" "$CONF/relaunch.sh" && chmod 755 "$CONF/relaunch.sh"
    printf 'DECK_DIR=%s\n' "$DECK_DIR" > "$ENVFILE"
    echo "설치됨: $CONF/relaunch.sh (DECK_DIR=$DECK_DIR)"
    echo "시작: perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' nohup $CONF/relaunch.sh >/dev/null 2>&1 &"
    exit 0 ;;
  stop)
    p=$(running_pid) || { echo "relaunch 루프가 돌고 있지 않습니다"; exit 1; }
    kill "$p" && echo "루프 중지 (pid $p) — 서버는 그대로 둡니다"
    exit 0 ;;
  status)
    p=$(running_pid) && { echo "relaunch 루프 실행 중 (pid $p, DECK_DIR=$DECK_DIR)"; exit 0; }
    echo "relaunch 루프 없음"; exit 1 ;;
esac

OLD="${1:-}"
mkdir -p "$CONF"
if p=$(running_pid); then
  echo "이미 돌고 있습니다 (pid $p) — 두 번째 루프는 띄우지 않습니다"
  log "두 번째 루프 시도 거부 (이미 pid $p)"
  exit 1
fi
echo $$ > "$PIDFILE"
child=""
# A TERM/INT to the loop stops the loop only: the server (started in the background below) keeps running.
trap 'rm -f "$PIDFILE"; log "루프 종료 (signal) — 서버는 그대로"; exit 0' INT TERM
trap 'rm -f "$PIDFILE"' EXIT

rotate() {
  s=$(stat -f %z "$LOG" 2>/dev/null || stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$s" -gt "$ROTATE_BYTES" ]; then mv "$LOG" "$LOG.1" && log "로그 회전 ($s bytes → $(basename "$LOG").1)"; fi
}

if [ -n "$OLD" ]; then
  log "이전 서버(pid $OLD)에 USR2 — 진행 중인 턴이 끝나면 종료 (DECK_DIR=$DECK_DIR)"
  kill -USR2 "$OLD" 2>/dev/null
  while alive "$OLD"; do sleep 2 & wait $!; done
  log "이전 서버 종료됨 → 새 서버 시작"
else
  log "루프 시작 (pid $$, DECK_DIR=$DECK_DIR)"
fi

fails=0
while :; do
  rotate
  start=$(date +%s)
  # A clean environment: no CLAUDECODE/CLAUDE_* leftovers from whichever session started this loop.
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" SHELL=/bin/zsh TMPDIR="${TMPDIR:-/tmp}" LANG=ko_KR.UTF-8 \
    PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    DECK_ENV_FILE="$CONF/env" \
    /bin/bash "$DECK_DIR/scripts/launchd/run.sh" >> "$LOG" 2>&1 &
  child=$!
  wait "$child"; rc=$?
  ran=$(( $(date +%s) - start ))
  if [ "$ran" -ge "$HEALTHY" ]; then fails=0; else fails=$((fails + 1)); fi
  # Wait BASE · 2^(fails-1), capped: 5 s, 10 s, 20 s, … 5 min. A healthy run goes straight back to BASE.
  pause=$BASE; i=1
  while [ "$i" -lt "$fails" ] && [ "$pause" -lt "$CAP" ]; do pause=$((pause * 2)); i=$((i + 1)); done
  [ "$pause" -gt "$CAP" ] && pause=$CAP
  case $rc in
    0)   why="정상 종료 (재시작 요청)" ;;
    126) why="환경 거부(126) — run.sh 를 읽거나 실행할 수 없음: macOS 가 ~/Documents 접근을 막은 상태일 수 있음 (시스템 설정 › 개인정보 보호 › 전체 디스크 접근 권한)" ;;
    127) why="명령 없음(127) — node 또는 bash 경로 확인" ;;
    *)   why="rc=$rc" ;;
  esac
  log "서버 종료: $why · ${ran}s 실행 · 연속 빠른 실패 $fails → ${pause}s 뒤 재시작 (포기하지 않음)"
  sleep "$pause" & wait $!
done
