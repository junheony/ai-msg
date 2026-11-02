# BRIEF10 QUANT 결정 기록

- `FRIENDS` / `FRIEND_KEYS` 고정 목록을 제거했다. `friends_snapshot`의 accts/equity/daily/gauge 이름과 각 snapshot tab.accounts를 합치고 snapshot_name → key → label 순서로 연결한다. snapshot 계정 키는 서버 내부에서만 사용하며 UI 모델에는 title/rows만 전달한다. 최대 60계정, 중복 alias는 한 카드다.
- `re.accounts`가 현재 없으므로 읽기 전용으로 `arbitrage-nexus/scripts/friends_snapshot.py`의 ACCTS 리터럴을 AST 분석한다. `python3 -I` 고정 프로그램은 파일 앞 128KiB 한도와 2초 timeout, 60초 cache를 사용한다. 소스를 import/실행하지 않고 name/label/exchange만 추출하며 archive 경로는 버린다. 등록은 snapshot/friends가 담당하고 ACCTS는 표시명·거래소를 보완한다. 없거나 non-literal이면 메타데이터 없는 계정도 유지하며 거래소 미보고로 표시한다.
- 모든 계정의 사용 가능한 수치를 합산하며 overview metrics/headline과 계정 섹션에 전체 개수를 표시한다. 친구 파일이 없어도 snapshot tiles 수치·계정·이유가 남는다. has_data=false는 충돌하는 숫자 타일/과거 friends 수치를 무효화한다. null을 0으로 합성하지 않는다.
- null 계정은 최대 7행과 한 번의 reason만 보여준다. `info` null 값과 reason은 QUANT 범위 CSS로 muted 처리한다. 실제 업비트2는 collector inactive / HTTP 401 서버 IP 미등록 사유를 표시한다.
- qa_dash 현재 실측은 정상(원 진단 curl 7ms, Node 39/48/647ms; 구현 후 live collector 197/577ms). 원인 재현 없이 timeout을 늘리지 않았다. 기존 3초 transport를 유지하면서 QUANT에만 60초 single-flight/last-good cache를 추가했다. 갱신 실패·잘못된 JSON schema 시 마지막 유효 snapshot을 유지하고 이전 값 시각/실패 상태를 표시한다. shared.ts/status.ts는 수정하지 않았다.

## 화면 원칙

frontend-design skill과 https://ref.theseeker.io/?category=dashboard 참고. 기존 계정 비교 작업을 유지하므로 새 장식 체계 대신 거래소 badge와 null 사유를 읽기 쉽게 보완했다. 팔레트는 기존 bg #14141c, panel #22222e, fg #efeff6, muted #b3b1c2, QUANT #8b93ff. 글꼴은 기존 Barlow Semi Condensed와 한글 system fallback, hub type scale을 그대로 쓴다. 넓은 화면은 3열 계정 비교, 작은 화면은 기존 responsive grid; label은 왼쪽, 숫자는 오른쪽, 긴 이유는 줄바꿈한다. 과도한 null 행과 반복 사유는 제거했다.

## 검증

- `npx vitest run src/server/hub/quant.test.ts src/ui/hub/HubPage.test.tsx` — 29 tests passed: 계정 동적 발견/alias 중복 제거/전체 합계/친구 파일 부재/has_data=false와 숫자 충돌/null 보존/timeout cache 동시 요청/schema 오류/메타데이터 parser의 소스 비실행/DOM muted null+reason+overview count를 검증한다.
- `collectQuant(liveHubDeps(...))` 읽기 전용 실측: 6계정, 업비트1 alias 중복 없음, 업비트2 null 사유 존재. upstream GET /api/snapshot.json 및 파일/systemd 조회만 수행.
- HubPage.tsx는 야핑봇 전용 페이지 연결 및 해당 mode의 헤더 source chip 숨김, QUANT CSS import만 추가했다. 그 외 mode 흐름은 유지했다.

남은 위험: upstream :8810 timeout은 현재 재현되지 않아 근본 원인을 확정할 수 없다. ACCTS가 동적으로 생성되는 코드로 바뀌면 표시명/거래소 보완만 미보고로 내려가며 계정 자체는 유지된다. 전체 검증·스크린샷·REPORT는 부모 작업에서 통합한다.
