#!/usr/bin/env bash
set -euo pipefail
# 현재 저장소의 Git에는 접근하지 않는다. 실제 복제는 표준 라이브러리만 사용한다.
exec python3 "$(dirname -- "$0")/new-game-from-reference.py" "$@"
