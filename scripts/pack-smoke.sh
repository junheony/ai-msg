#!/usr/bin/env bash
# Packs the committed tree (HEAD) the way npm would publish it, installs the tarball into throwaway prefixes and runs it:
# contents and hygiene of the tarball, global install into a path with spaces and Hangul, `npx <tgz>`, a server on a free
# port behind fake CLIs, three permission round trips through the bundled child scripts, the config-folder lock, and a
# clean SIGTERM shutdown. Everything runs outside the repo under `env -i` with a temporary HOME — the real ~/.config/deck,
# the running server and the repo's dist/ are never touched. Needs the network (npm ci).
#   bash scripts/pack-smoke.sh           # SKIP_DOCTOR=1 skips the doctor step
# Only fake CLIs and node/npm/npx are on PATH: no real claude/codex/agy/grok of this machine ever runs.
# (prepack's build output shares stdout with `npm pack --json`: the JSON is the trailing array.)
# Prints `pack-smoke: 완료`, or the failed step and exit 1. The package name is read from npm pack, never assumed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
T="$(cd "$T" && pwd -P)"
STEP='준비'
SERVER_PGID=''

cleanup() {
  if [[ -n "$SERVER_PGID" ]]; then kill -KILL -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$T"
}
trap cleanup EXIT
trap 'echo "pack-smoke: 실패 — $STEP" >&2; exit 1' ERR
step() { STEP="$1"; echo "pack-smoke: $1"; }
die() { echo "pack-smoke: 실패 — $STEP: $1" >&2; exit 1; }
# Every engine CLI the server or doctor could find on PATH must be one of ours under $T: anything else is this machine's real CLI.
guard_path() {
  local n p
  for n in claude codex agy grok; do
    p=$("${E[@]}" sh -c 'command -v "$1" || true' _ "$n")
    [[ -z "$p" || "$p" == "$T/"* ]] || die "PATH 에서 임시 폴더 밖의 $n 이 잡힘: $p"
  done
}

mkdir -p "$T/src" "$T/out" "$T/x" "$T/bin" "$T/nodebin" "$T/home" "$T/npm-cache"
# Only node/npm/npx on PATH: the folder `node` lives in may also hold this machine's real claude/codex/grok.
NODE_DIR="$(dirname "$(node -p 'process.execPath')")"
for b in node npm npx; do ln -s "$NODE_DIR/$b" "$T/nodebin/$b"; done
E=(env -i "HOME=$T/home" "PATH=$T/bin:$T/nodebin:/usr/bin:/bin" "npm_config_cache=$T/npm-cache" "npm_config_update_notifier=false" DECK_LOOPBACK_ONLY=1)

step '깨끗한 환경 확인'
leaked="$("${E[@]}" env | grep -E '^(DECK_|XDG_|CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME|GEMINI_)' | grep -v '^DECK_LOOPBACK_ONLY=1$' || true)"
[[ -z "$leaked" ]] || die "상속된 변수: $leaked"
cd "$T"

step '커밋된 트리 꺼내기·npm ci'
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || echo "pack-smoke: 경고 — 커밋되지 않은 변경은 쓰지 않습니다 (HEAD 만)" >&2
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$T/src"
(cd "$T/src" && "${E[@]}" npm ci --no-audit --no-fund --loglevel=error >"$T/npm-ci.log" 2>&1) || { tail -20 "$T/npm-ci.log" >&2; die 'npm ci 실패 (네트워크 없음?)'; }

step 'npm pack'
(cd "$T/src" && "${E[@]}" npm pack --json --pack-destination "$T/out" >"$T/pack.json" 2>"$T/pack.log") || { tail -20 "$T/pack.log" >&2; die 'npm pack 실패'; }
read -r PKG_NAME PKG_VERSION TGZ_NAME < <(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8"); const i=t.startsWith("[")?0:t.lastIndexOf("\n[\n")+1; const j=JSON.parse(t.slice(i))[0]; console.log(j.name, j.version, j.filename)' "$T/pack.json")
TGZ="$T/out/$TGZ_NAME"
[[ -f "$TGZ" ]] || die "tarball 없음: $TGZ"
echo "pack-smoke: $PKG_NAME@$PKG_VERSION"

step 'tarball 내용'
tar -xzf "$TGZ" -C "$T/x"
P="$T/x/package"
for f in dist/server/bin.js dist/server/app.js dist/server/hookRelay.js dist/server/permissionMcp.js dist/ui/index.html package.json; do
  [[ -f "$P/$f" ]] || die "없음: $f"
done
for d in src docs scripts .hygiene-private.json; do
  [[ ! -e "$P/$d" ]] || die "있으면 안 됨: $d"
done
bad="$(cd "$P" && find . -name '*.test.*' -o -name '*.map' | head -5)"
[[ -z "$bad" ]] || die "있으면 안 됨: $bad"
[[ "$(head -1 "$P/dist/server/bin.js")" == '#!/usr/bin/env node' ]] || die 'bin.js 첫 줄이 shebang 아님'
[[ -x "$P/dist/server/bin.js" ]] || die 'bin.js 실행 권한 없음'

step '위생 검사'
# hygiene.ts skips directories named dist, and everything shipped is under dist/: scan a copy with it renamed.
cp -R "$P" "$T/hyg" && mv "$T/hyg/dist" "$T/hyg/shipped"
(cd "$REPO" && DECK_HYGIENE_ROOT="$T/hyg" DECK_HYGIENE_RULES="$REPO/.hygiene-private.json" npx vitest run src/hygiene.test.ts >"$T/hygiene.log" 2>&1) || { tail -30 "$T/hygiene.log" >&2; die '위생 검사 실패'; }

step '가짜 CLI'
cp "$REPO/scripts/smoke/fake-claude.mjs" "$T/fake-claude.mjs"
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$T/fake-claude.mjs" >"$T/bin/claude"
cat >"$T/bin/codex" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.159.2' ;;
  login) echo 'Not logged in'; exit 1 ;;
  *) exit 1 ;;
esac
EOF
printf '#!/bin/sh\nexit 1\n' >"$T/bin/agy"
mkdir -p "$T/home/.grok/bin"
cat >"$T/home/.grok/bin/grok" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo 'grok 1.0.62' ;;
  models) echo 'You are not authenticated'; exit 1 ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$T/bin/claude" "$T/bin/codex" "$T/bin/agy" "$T/home/.grok/bin/grok"
guard_path

step '전역 설치 (공백·한글 접두사)'
G="$T/g 공백 한글"
"${E[@]}" npm i -g --no-audit --no-fund --loglevel=error --prefix "$G" "$TGZ" >"$T/install.log" 2>&1 || { tail -20 "$T/install.log" >&2; die '전역 설치 실패'; }
Q="$G/bin/quarterdeck"
[[ "$("${E[@]}" "$Q" --version)" == "$PKG_VERSION" ]] || die "--version 이 $PKG_VERSION 아님"
INSTALLED="$G/lib/node_modules/$PKG_NAME"
[[ -f "$INSTALLED/dist/server/bin.js" ]] || die "설치본 없음: $INSTALLED"
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

step 'service install --dry-run (아무것도 쓰거나 실행하지 않음)'
"${E[@]}" "$Q" service install --dry-run --port "$(free_port)" >"$T/service-dry.log" 2>&1 || { cat "$T/service-dry.log" >&2; die 'service install --dry-run 실패'; }
case "$(uname -s)" in
  Darwin) grep -q 'local.quarterdeck.server' "$T/service-dry.log" && grep -q 'AbandonProcessGroup' "$T/service-dry.log" || { cat "$T/service-dry.log" >&2; die 'dry-run 에 LaunchAgent plist 가 없음'; } ;;
  Linux) grep -q 'quarterdeck.service' "$T/service-dry.log" && grep -q 'KillMode=mixed' "$T/service-dry.log" || { cat "$T/service-dry.log" >&2; die 'dry-run 에 systemd 유닛이 없음'; } ;;
esac
grep -q "$INSTALLED/dist/server/bin.js" "$T/service-dry.log" || { cat "$T/service-dry.log" >&2; die 'dry-run 의 실행 경로가 설치본이 아님'; }
[[ ! -e "$T/home/Library" && ! -e "$T/home/.config/systemd" ]] || die '서비스 파일이 쓰였음'

step 'bin 충돌 (EEXIST)'
mkdir -p "$T/g2/bin"
printf '#!/bin/sh\necho someone-else\n' >"$T/g2/bin/quarterdeck"
chmod 755 "$T/g2/bin/quarterdeck"
if "${E[@]}" npm i -g --no-audit --no-fund --loglevel=error --prefix "$T/g2" "$TGZ" >"$T/install2.log" 2>&1; then
  echo "pack-smoke: 경고 — 기존 quarterdeck 명령이 있어도 설치가 실패하지 않음 ($(head -1 "$T/g2/bin/quarterdeck" 2>/dev/null))" >&2
else
  grep -q EEXIST "$T/install2.log" || echo "pack-smoke: 경고 — 설치는 실패했지만 EEXIST 가 아님" >&2
fi

step "npx --package <tgz> quarterdeck --version"
out="$("${E[@]}" npx --yes --package "$TGZ" -- quarterdeck --version 2>"$T/npx.log")" || true
[[ "$out" == "$PKG_VERSION" ]] || { tail -20 "$T/npx.log" >&2; die "npx --version 이 $PKG_VERSION 아님: $out"; }

if [[ "${SKIP_DOCTOR:-}" == 1 ]]; then
  echo 'pack-smoke: doctor 단계 건너뜀 (SKIP_DOCTOR=1)'
else
  step 'doctor'
  guard_path
  out="$("${E[@]}" "$Q" doctor)" || die 'doctor 종료 코드 0 아님'
  [[ "$(grep -cE '^(claude|codex|gemini|grok) ' <<<"$out")" == 4 ]] || { echo "$out" >&2; die 'doctor 출력에 엔진 넷이 없음'; }
  grep -q '로그인 안 됨' <<<"$out" || die 'doctor 출력에 "로그인 안 됨" 없음'
  grep -q '.grok/bin/grok' <<<"$out" || die 'doctor 가 ~/.grok/bin/grok 을 찾지 못함'
fi


step '서버 시작'
guard_path
PORT="$(free_port)"
CONF="$T/home/.config/deck"
# DECK_HOOK_RELAY_DEADLINE_MS=1: a fail-closed hook relay (only the timeout turn runs one) gives up at once → deny, exit 2.
"${E[@]}" "DECK_CLAUDE_BIN=$T/bin/claude" DECK_HOOK_RELAY_DEADLINE_MS=1 perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' "$Q" start --port "$PORT" >"$T/server.log" 2>&1 &
SERVER_PGID=$!
ok=''
for _ in $(seq 60); do
  if curl -fs "http://127.0.0.1:$PORT/" -o "$T/index.html" 2>/dev/null; then ok=1; break; fi
  kill -0 "$SERVER_PGID" 2>/dev/null || break
  sleep 0.5
done
[[ -n "$ok" ]] || { tail -30 "$T/server.log" >&2; die '30초 안에 / 가 200 이 아님'; }
grep -q '<div id="root">' "$T/index.html" || die 'index.html 에 #root 없음'
assets="$(grep -oE '(src|href)="/[^"]+\.(js|css)"' "$T/index.html" | sed -E 's/^(src|href)="//; s/"$//')"
[[ -n "$assets" ]] || die 'index.html 이 참조하는 JS·CSS 없음'
while read -r a; do
  ct="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "http://127.0.0.1:$PORT$a")"
  case "$a" in
    *.js) [[ "$ct" == 200\ *javascript* ]] || die "$a → $ct" ;;
    *.css) [[ "$ct" == 200\ text/css* ]] || die "$a → $ct" ;;
  esac
done <<<"$assets"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me")" == 401 ]] || die '/api/me 가 401 아님'
[[ -f "$CONF/token" && -f "$CONF/server.lock" ]] || die "$CONF/{token,server.lock} 없음"
grep -qF "grok $T/home/.grok/bin/grok" "$T/server.log" || { grep -F 'deck: 세션' "$T/server.log" >&2; die 'grok 을 ~/.grok/bin/grok 에서 찾지 못함'; }

step '권한 왕복 (승인·거부·시간 초과)'
WORK="$T/home/작업 폴더 one"
mkdir -p "$WORK"
"${E[@]}" node "$REPO/scripts/smoke/turn.mjs" "$INSTALLED" "$PORT" "$CONF/token" "$WORK" || { tail -30 "$T/server.log" >&2; die '권한 왕복 실패'; }

step '두 번째 서버는 락으로 거부'
before="$(cat "$CONF/server.lock")"
code=0
"${E[@]}" "$Q" start --port "$(free_port)" >"$T/second.log" 2>&1 || code=$?
[[ "$code" == 78 ]] || { cat "$T/second.log" >&2; die "종료 코드 $code (78 = 영구 오류여야 함)"; }
grep -q "$CONF" "$T/second.log" || { cat "$T/second.log" >&2; die '락 문구 없음'; }
[[ "$(cat "$CONF/server.lock")" == "$before" ]] || die 'server.lock 내용이 바뀜'

step '종료 (SIGTERM)'
kill -TERM -- "-$SERVER_PGID"
gone=''
for _ in $(seq 60); do
  if ! pgrep -g "$SERVER_PGID" >/dev/null 2>&1; then gone=1; break; fi
  sleep 0.5
done
[[ -n "$gone" ]] || { pgrep -l -g "$SERVER_PGID" >&2 || true; die '30초 안에 프로세스 그룹이 비지 않음'; }
SERVER_PGID=''
node -e 'const s=require("net").createServer();s.on("error",e=>{console.error(e.message);process.exit(1)});s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close())' "$PORT" || die "포트 $PORT 가 풀리지 않음"
[[ ! -e "$CONF/server.lock" ]] || die 'server.lock 이 남음'

echo 'pack-smoke: 완료'
