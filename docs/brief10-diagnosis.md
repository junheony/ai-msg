# BRIEF10 실측 진단 (2026-11-02 KST)

## :8095
- yapping-bot.service active/running, PID 2531074, 시작 2026-11-01 23:45:08 KST, NRestarts=0. uvicorn이 127.0.0.1:8095 LISTEN. 재시작하지 않음.
- 기존 허브와 동일한 7개 GET을 동시에 curl --max-time 12로 측정, 모두 200. 연결시간 0.08~0.30ms.

| endpoint | 동시 요청 total (s) | 순차 요청 total (s) |
|---|---:|---:|
| /api/status | 7.661304 | 2.312675 |
| /api/metrics | 6.390093 | 0.534639 |
| /api/posts | 7.810832 | 0.834372 |
| /api/ai_news?days=3 | 6.053696 | 0.093218 |
| /api/yap | 6.389457 | 0.010223 |
| /api/replies?status=todo | 6.056274 | 0.298751 |
| /api/replies?status=done | 6.107808 | 0.481596 |

- 경로 오류나 다운이 아님. 기존 yapping.ts는 6개 요청 3초/ai_news만 8초여서 동시 부하 시 6/7 timeout과 일치. 동시 요청의 contention은 실측으로 확인; 특정 lock/DB 병목 원인은 프로파일 없이 단정하지 않는다. app/config.py는 env를 getter마다 읽고 config lock, DB는 매 연결 WAL/busy_timeout=30s 설정. 모두 추론 단서이며 서비스 수정 금지.
- 기존 status/posts는 구 수동 rotation. 실제 pipeline 후보: GET /api/autopilot (ext/auto query 없이), data/watchdog.json, data/follower_history.jsonl, data/yb.db mode=ro. app/main.py:503 이후에 autopilot 응답 조립.
- watchdog 최근 01:47:18: replies done_today=11, daily_cap=40; followers=505, following=903, delta_since_last_run=0. watchdog를 실행하면 재시작 로직이 있으므로 절대 실행 금지, JSON만 읽기.

## :8810 / QUANT
- GET /api/snapshot.json: HTTP 200, 0.007241s, 90097 bytes. python PID 1794724 LISTEN.
- tabs: sguard, choi, re(exchange=bithumb), upbit(exchange=upbit).
- 현재 re.accounts 없음. upbit.accounts에는 upbit-acct1/2, snapshot_name=업비트1/2. acct1 active/has_data=true, acct2 inactive/has_data=false, reason에 HTTP 401 서버 IP 미등록.
- ~/.local/state/friends_snapshot.json accts는 이름 문자열 배열: 빗썸1, 빗썸2, 범수3, WILL, 업비트1. 하드코딩 없이 전체를 다루고 upbit snapshot_name alias로 dedup 필요.
- 기존 quant.ts는 3초 default probe 사용. shared.ts probe를 건드리지 않고 quant 자체 transport/cache를 점검할 것. 빠른 curl만으로 Node probe 가짜 timeout의 정확한 원인은 아직 미확정.

## 디자인
- frontend-design SKILL.md 읽음. The Seeker dashboard 갤러리 확인: https://ref.theseeker.io/?category=dashboard
- 운영 현황은 현재 type scale로 cap 숫자/레인 의미를 먼저, 링크 목록은 아래, 소스 진단은 접어서 반복 빨간 chips 제거.

### 추가 확인
- Node fetchJsonWithTimeout(quant, 3000) 3회 직접 호출: 39ms, 48ms, 647ms, 모두 4 tabs 성공. 현재 로컬에서는 qa_dash timeout 재현 안 됨. 장애라고 단정하지 말 것.
- **주의:** /api/autopilot은 ext 없이도 qt_auto.status -> plan(now)가 상태를 쓰는 경로를 포함한다. 엄격한 read-only를 위해 이 endpoint 호출 대신 기존 watchdog/DB mode=ro와 targets YAML 제한 필드 읽기가 낫다. watchdog.py 자체 실행 금지.
- watchdog.qt.posts_today=8은 lane별 cap usage와 다른 집계이므로 7 cap과 직접 비교해 추정하지 말 것.
