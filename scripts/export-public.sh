#!/usr/bin/env bash
# Writes the public snapshot of a commit (HEAD) into an empty directory: `git archive` (so .gitattributes
# `export-ignore` entries stay behind), then checks the extracted tree:
#   1. none of the private paths below came along;
#   2. src/hygiene.test.ts over that tree — file contents and file names — with this checkout's
#      .hygiene-private.json (the public tree's own copy of the test knows only the generic key shapes).
#   scripts/export-public.sh <empty-or-new-dir> [rev]   # rev defaults to HEAD
# Exits non-zero when the target is not empty or a check fails. It does not run git init, commit or
# push — that part is done by hand. Only committed content is exported. This script is export-ignore itself.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-}"
REV="${2:-HEAD}"
RULES="$REPO/.hygiene-private.json"
[[ -n "$OUT" ]] || { echo "usage: $0 <empty-or-new-dir> [rev]" >&2; exit 2; }
[[ -f "$RULES" ]] || { echo "export-public: $RULES 가 없습니다 — 개인 규칙 없이는 내보내지 않습니다" >&2; exit 1; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
if [[ -n "$(ls -A "$OUT")" ]]; then
  echo "export-public: $OUT 가 비어 있지 않습니다" >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
  echo "export-public: 경고 — 커밋되지 않은 변경은 내보내지 않습니다 ($REV 만)" >&2
fi

git -C "$REPO" archive --format=tar "$REV" | tar -x -C "$OUT"
echo "export-public: $(find "$OUT" -type f | wc -l | tr -d ' ') 개 파일 → $OUT"

fail=0
# Deliberately a second copy of the .gitattributes list: it catches an entry dropped from .gitattributes
# by mistake. Add a path to both.
for p in docs/HANDOFF.md docs/superpowers cloud .hygiene-private.json .gitattributes scripts/export-public.sh src/hygiene.private.test.ts; do
  if [[ -e "$OUT/$p" ]]; then
    echo "export-public: 공개본에 있으면 안 되는 경로 — $p (.gitattributes export-ignore 확인)" >&2
    fail=1
  fi
done

if ! (cd "$REPO" && DECK_HYGIENE_ROOT="$OUT" DECK_HYGIENE_RULES="$RULES" npx vitest run src/hygiene.test.ts); then
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "export-public: 검사 실패 — $OUT 를 공개하지 마세요" >&2
  exit 1
fi
echo "export-public: 완료 ($(git -C "$REPO" rev-parse --short "$REV")) — git init·commit·push 는 직접 하세요"
