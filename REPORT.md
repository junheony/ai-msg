# BRIEF10 — 야핑봇·QUANT 대시보드

## 한국어 요약

야핑봇을 @cblabx 자동 성장 파이프라인 기준으로 재구성하고, QUANT 계정을 실시간 스냅샷의 계정 메타데이터와 friends 데이터에서 동적으로 구성한다. 기존 수동 게시 rotation과 반복된 timeout 표시는 제거한다.

작업 브랜치: `feat/hub-yap-quant`, 기준: `main`의 `9485947`. 작업트리는 이미 생성되어 있어 그대로 사용했다. `src/server/hub/shared.ts`와 공용 probe/timeout은 변경하지 않는다. 서비스 재시작, ledger 수정, merge, push, deploy는 하지 않는다.

## :8095 진단

2026-11-02 KST 기준 `yapping-bot.service`는 active/running, uvicorn PID 2531074, 시작 시각 11-01 23:45:08 KST, NRestarts=0이었다. `127.0.0.1:8095`가 LISTEN 중이다. 기존 허브의 일곱 GET 경로 모두 HTTP 200을 반환했다.

| GET 경로 | 동시 요청 총시간 | 순차 요청 총시간 |
|---|---:|---:|
| /api/status | 7.661s | 2.313s |
| /api/metrics | 6.390s | 0.535s |
| /api/posts | 7.811s | 0.834s |
| /api/ai_news?days=3 | 6.054s | 0.093s |
| /api/yap | 6.389s | 0.010s |
| /api/replies?status=todo | 6.056s | 0.299s |
| /api/replies?status=done | 6.108s | 0.482s |

측정 명령: 각 경로에 `curl -sS --max-time 12 -o /dev/null -w '%{http_code} %{time_connect} %{time_starttransfer} %{time_total} %{size_download}' http://127.0.0.1:8095<path>`. 7개 동시 호출은 Python ThreadPoolExecutor(7)로 기존 collector 호출 패턴을 재현했다. 연결은 0.08~0.30ms로 빨랐다.

원래 yapping.ts는 여섯 API에 3초, ai_news에만 8초를 허용한다. 동시 요청의 6.05~7.81초 지연은 6/7 timeout 현상을 설명한다. 경로 오류나 서비스 다운이 아니다. 순차 요청은 0.01~2.31초였다. 동시 실행 시 경합/처리 지연은 실측했으나 특정 DB lock·CPU 병목을 단정할 프로파일 증거는 없다. 운영 프로세스는 수정하거나 재시작하지 않았다.

`/api/autopilot`은 `ext=`가 없어도 `qt_auto.status → plan`이 계획을 갱신할 수 있으므로 새로운 read-only 수집 경로로 사용하지 않는다. watchdog 실행 스크립트도 서비스 재시작 기능이 있으므로 실행하지 않고 이미 생성된 JSON만 읽는다.

## QUANT 진단

`http://127.0.0.1:8810/api/snapshot.json`은 HTTP 200, 90,097 bytes, curl 7.241ms였다. 프로젝트의 `fetchJsonWithTimeout(url, 3000)`으로 직접 세 번 읽었을 때도 39/48/647ms에 4개 tabs를 반환했다. 따라서 현재 환경에서는 qa_dash timeout을 재현하지 못했고 공용 probe의 별도 작업 원인을 추정해 수정하지 않았다.

확인한 데이터는 sguard/choi/re/upbit이며 re.exchange=bithumb, upbit.exchange=upbit이다. 현재 re에는 accounts 배열이 없고, upbit에는 upbit-acct1/2가 있다. friends_snapshot.json의 accts는 빗썸1/빗썸2/범수3/WILL/업비트1이다. 업비트1의 snapshot_name 중복을 합치고, 업비트2의 null 계정까지 합하면 6계정이다. 업비트2는 collector inactive / HTTP 401 서버 IP 미등록 사유가 있다.

## 구현

- `src/server/hub/yapping.ts`, `yapping-read.ts`: :8095의 일곱 동시 poll을 제거하고 고정 Python 프로그램으로 운영 설정, watchdog JSON, SQLite를 읽는다. SQLite `mode=ro`와 `PRAGMA query_only=ON`, 고정 SELECT만 사용한다. 1.8초 실행 제한/30초 캐시/진행 중 조회 공유/실패 시 시각을 보존한 마지막 정상값을 적용했다. 오래된 날짜의 사용량은 오늘 수치로 재사용하지 않는다.
- `src/ui/hub/YappingHome.tsx`, `yapping.css`, `src/shared/yapping.ts`: 속보 5·리포트 2·전체 7·답글 40 한도를 첫 화면에 크게 표시한다. 레인은 완료+예약, 전체는 일반 QT를 포함한 완료+예약이며 실제 cap 판단식과 일치한다. 게시 운영일은 KST03시, 답글은 자정 초기화다. 팔로워는 직전 수집 대비 변화다. 조회수 변화는 회색 누락 사유다. X와 Telegram은 각각 최신3건의 독립적인 목록이다. 소스 상태는 접혀 있고 구버전6/7 timeout도 한 줄로 묶는다.
- `src/server/hub/quant.ts`: friends 파일의 동적 계정과 tabs.accounts를 snapshot_name/key/label로 합친다. 현재 6계정이며 업비트1이 중복되지 않는다. re.accounts가 없는 경우 원본 friends_snapshot.py의 ACCTS 리터럴만 AST로 읽어 표시명·거래소를 보완한다. 원본 Python을 import/실행하지 않으며 경로·자격증명은 반환하지 않는다. 계정 자체는 snapshot/friends 데이터에서만 생성한다. 128KiB/2초/60초 캐시로 제한한다.
- QUANT는 has_data=false를 우선하여 모순되는 과거 숫자도 무효화한다. snapshot만 있을 때도 타일을 표시하며 null 계정에 사유를 한 번 보여준다. 모든 계정의 사용 가능한 값과 전체 계정 수를 overview에 반영한다. QUANT 전용 snapshot 캐시는 순간 실패 때 마지막 유효값/시각/오류를 보존하며 기존3초 timeout은 유지한다.
- `HubPage.tsx`는 야핑봇 전용 화면과 source chip/footer 조건 분기, QUANT 범위 CSS만 연결했다. 다른 모드와 공용 probe는 그대로다. 디자인은 frontend-design 스킬 및 [The Seeker dashboard](https://ref.theseeker.io/?category=dashboard)를 참고하고 기존 hub 글꼴·type scale·테마 토큰을 유지했다.

구현 근거·캐시·회귀 테스트는 [야핑봇 결정 기록](docs/brief10-yapping.md), [QUANT 결정 기록](docs/brief10-quant.md)에 있다.

## 누락 metric과 필요한 endpoint

**조회수 변화만 원천 데이터가 없다.** `own_posts.impressions`와 `updated_at`은 최신 누적값 한 번만 저장한다. `/api/metrics.daily_views`는 게시 날짜별 현재 누적 조회수 합계라 기간 내 증가량이 아니다. 서로 다른 게시물 집합을 빼서 증감을 만들지 않았다.

필요한 추가 API(현재 미구현): 읽기 전용 `GET /api/growth/observations?from=<ISO8601>&to=<ISO8601>&scope=own_originals`.

```json
{
  "scope": "own_originals",
  "observations": [
    {"observed_at": "ISO8601", "followers": 508, "posts": [{"tweet_id": "...", "impressions": 1000}]}
  ]
}
```

최소 두 관측 시각에 같은 게시물 집합의 누적값, 수집 누락 여부가 필요하다. upstream에 과거 관측을 저장해야24시간 변화량을 계산할 수 있다. 이 작업은 upstream을 변경하지 않았다. 로컬 DB 대신 API로 연결하려면 순수 GET `/api/growth/snapshot`에 운영일·레인별 완료/예약/cap·답글·관측시각·X/TG 최근 링크를 노출하면 된다. 이는 확장 제안이고 현재 화면은 로컬 read-only 조회로 동작한다.

업비트2는 MSG 문제가 아니라 upstream collector inactive/HTTP401 IP 미등록 상태다. 수치를 생성하지 않고 이유를 표시한다. 서비스나 키 설정을 변경하지 않았다.

## 검증

Node24.22.2를 사용했다. 재현 시 `PATH=/home/max/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`로 실행한다.

| 명령 | 결과 |
|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | 243 packages 설치, package-lock.json 불변 |
| `npm test -- --maxWorkers=4` | 356파일 / 4,462테스트 PASS, 203.75초 |
| `npm run typecheck` | PASS (`tsc --noEmit`, exit0) |
| `npm run build` | PASS (Vite784 modules + check-bundle, 최종3.84초) |
| `git diff --check` | PASS |
| `sha256sum src/server/hub/shared.ts /home/max/ai-msg/src/server/hub/shared.ts` | 동일 `f8705487492658af29d8e07ac8b8a36a903311c1e9553a0aeb80e3b8ffd2db3c` |

계정 동적 발견·alias 중복 제거·전체 개수·snapshot fallback·null/0 구분·미수집 사유 DOM·모순되는 stale 숫자 차단·API timeout 그룹화·일자 경계·오래된 값·링크 검증을 테스트했다. 임시 SQLite reader 통합 테스트에서 조회 전후 DB SHA256/mtime이 동일했다. ACCTS parser 테스트는 소스의 파일쓰기/raise 코드를 실행하지 않고 리터럴만 읽는 것을 확인했다.

최종 수정 후 다음 대상 회귀 명령도 **6파일 / 56테스트 PASS (3.24초)**였다.

```bash
npm test -- src/server/hub/quant.test.ts src/server/hub/yapping.test.ts \
  src/server/hub/yapping-read.test.ts src/server/hub/status.test.ts \
  src/ui/hub/HubPage.test.tsx src/ui/hub/YappingHome.test.tsx --maxWorkers=4
```

최종 typecheck도 exit0이다. 모든 운영 소스는 읽기 전용이며 스냅샷 산출물에서 home/workspace 경로와 credential 표식을 확인한 결과 노출되지 않았다.

## 스크린샷과 검증 환경

`scripts/brief10-preview.ts`는 새 loopback포트9410에서 실제 빌드 App과 실제 두 collector만 실행한다. 세션·인증·usage 셸은 빈 검증 fixture이며 운영 인증을 검증한 것은 아니다. :8810 스냅샷 GET만 허용하고 :8095 및 거래 API는 차단한다. 기존 서비스는 사용/재시작하지 않는다. 재현 명령과 캡처 범위는 [캡처 안내](docs/brief10-capture.md)에 있다.

스크린샷은 `shots-yapquant/`에1440×1000 데스크톱,390×844 모바일 두 탭과 추가 실제 스크롤 화면으로 저장한다. CSS를 바꾸거나 높이를 늘리지 않고 실제 화면 배치로 캡처한다. 현재 실데이터 수집은 야핑봇 전체7/7·답글13/40·팔로워508(+3 직전 수집 대비), X/TG3건씩, QUANT6계정(빗썸4·업비트2)으로 확인했다. 수치는 실행 시각에 따라 변한다.

### 캡처 실행 결과

```bash
node --import tsx scripts/brief10-preview.ts
node scripts/brief10-capture.mjs
```

**4개 화면 / 32개 assertion PASS (exit0).** 설치된 Chromium headless 153.0.8010.12를 사용했다. API 폴링이 있으므로 networkidle 대신 DOM 및 해당 화면 준비 상태를 기다린다. 패키지/브라우저 다운로드 없이 기존 설치를 사용했다.

| 탭 | Desktop | Mobile |
|---|---|---|
| 야핑봇 | [1440×1000](shots-yapquant/yapping-desktop.png) | [390×844](shots-yapquant/yapping-mobile.png) |
| QUANT | [1440×1000](shots-yapquant/quant-desktop.png) | [390×844](shots-yapquant/quant-mobile.png) |

추가 스크롤 PNG23개까지 총27개 화면으로 전체 콘텐츠를 기록했다. 업비트2 사유는 [모바일 상세](shots-yapquant/quant-mobile-scroll-07.png)에서도 읽을 수 있다. [검증 JSON](shots-yapquant/assertions.json)에 각 viewport/scroll offset/링크/오류 결과를 기록했다. 모든 화면의 가로 넘침 없음, console/page 오류 없음, 외부 요청 없음, 야핑봇 옛 rotation 없음·X3건/TG3건·소스 기본 접힘, QUANT 업비트1/2·null 사유 렌더링을 확인했다. 상위 HTTP 조회 manifest에는 :8810 snapshot만 있다.

주 화면과 모바일 스크롤 화면을 직접 검토해 현재 글꼴 크기·한도 2열 배치·긴 사유 줄바꿈을 확인했다. preview는 이 작업에서 만든 격리 프로세스이며 검증 후 종료한다.

## 작업 방식과 운영 경계

사용자 AGENTS.md 규약대로 ask-claude에 기능 단위 위임을 시도했지만 Fable 사용 한도로 실패했다. 이 서버에 deck-run이 없어 상태를 조회하지 못했다. 반복 재시도 없이 Codex 작업 에이전트로 구현/캡처를 분담했다. 진단과 결과를 docs/brief10-*.md에 기록해 재사용했다.

shared.ts/status.ts·거래 모듈·package lock을 변경하지 않았다. 운영 API/상태는 읽기 전용이고 시스템 유닛·ledger·포트8771/8783/8792/8793/8830의 서비스에 변경하지 않았다. merge/push/deploy/restart는 수행하지 않았다.

STATUS: DONE
