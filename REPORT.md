# BRIEF11 리서치 패널 보고

## 요약

허브에 **리서치 탭**과 **개요 하단 패널**을 추가했고 `feat/hub-research` 브랜치에 커밋했습니다. 머지, 푸시, 배포, 재시작은 하지 않았으므로 라이브 허브에는 새 빌드를 올려야 보입니다.

- **화면:** 맨 위 글을 내러티브 색의 단색 표지로 크게 싣고, 나머지는 색 띠가 있는 카드로, 그 아래에 태그 필터와 외부 리서치 목록을 둡니다. 제목은 명조 계열 Hahmlet입니다. 그라데이션, 이모지 아이콘, 가짜 숫자는 쓰지 않았습니다.
- **데이터:** `~/.msg/research/articles.json`(글 4건)과 `sources.json`(출처 14곳)을 요청마다 읽으므로 글을 추가할 때 코드 수정이나 재시작이 필요 없습니다. 추가는 `scripts/msg-research-add`, 스키마는 `docs/research.md`에 있습니다.
- **출처:** 14곳 모두 확인했고 뺀 곳은 없습니다. 추측한 도메인도 없습니다.
- **검증:** 타입체크, 빌드, 대비 검사 통과. 전체 테스트 4,514건(신규 39건 포함)은 전부 통과한 실행도 있지만, 실행마다 다른 기존 테스트가 1~2건씩 간헐적으로 실패합니다(아래 "테스트 결과" 참고). 스크린샷은 `shots-research/`에 있습니다.

**오너가 알아둘 점**

1. 글 4건 모두 요약이 비어 있어 지금은 "요약 대기"로 보입니다. 결론은 지어내지 않았으니 `articles.json`에 채워 주세요.
2. Cursor 글 링크는 로그인 없이 열면 로그인 페이지로 넘어갑니다. Cursor에 로그인한 브라우저에서만 열릴 수 있습니다.
3. Compute Markets 글은 날짜가 없어 시드 날짜 2026-11-02로 넣었습니다. "매일 갱신" 글이라 화면에는 날짜 대신 배지가 보이고, 등록일은 툴팁에 있습니다.

## 테스트 결과

최종 커밋의 전체 테스트 3회와 깨끗한 `main` 2회 결과입니다. 측정 당시 머신 부하(load average)는 약 187이었습니다.

| 대상 | 결과 | 실패한 테스트 |
| --- | --- | --- |
| 이 브랜치 1회차 | 2건 실패 / 4,514건 | `Thinking.test.tsx` 1건, `TradingRoom.test.tsx` 1건 |
| 이 브랜치 2회차 | 전부 통과 | |
| 이 브랜치 3회차 | 1건 실패 / 4,514건 | 총사령탑 `commanderHop` 테스트 (대기 시간 초과) |
| `main` 1회차 | 전부 통과 (4,475건) | |
| `main` 2회차 | 1건 실패 / 4,475건 | `#replay` 테스트 |

실패한 테스트는 매번 달랐고 리서치 테스트는 한 번도 실패하지 않았으며, 이 변경이 없는 `main`에서도 같은 양상이 나왔습니다. `Thinking`과 `TradingRoom` 두 파일은 따로 돌리면 3회 모두 통과했습니다. 그래서 부하에 따른 기존 간헐 실패로 판단했습니다. 다만 부하가 낮을 때 돌려 본 것은 아닙니다.

## 머지 확인

| 브랜치 | 결과 |
| --- | --- |
| `feat/hub-controls` | 충돌 없음. 임시 워크트리에서 머지한 뒤 타입체크 통과. |
| `feat/hub-yap-quant` | `quant.ts`, `yapping.ts`, `yapping.test.ts`, `HubPage.tsx` 4개 파일 충돌. `main`과 머지해도 똑같이 나므로 이 커밋 때문이 아닙니다. |
| `feat/terminal-redesign` | 로컬에 브랜치가 없어 확인하지 못했습니다. |

`feat/hub-controls` 머지 트리에서 허브 테스트를 돌렸을 때 `TradingRoom.test.tsx`의 한 건이 1번 실패했습니다. 이후 그 파일만 돌리면 `feat/hub-controls` 단독과 머지 트리 모두 3회 전부 통과해서 재현되지 않았습니다. 부하에 따른 간헐 실패로 보이지만 원인을 확인한 것은 아닙니다.

## 외부 리서치 URL

2026-11-02에 다시 요청해 14곳 모두 HTTP 200을 확인했습니다.

| 이름 | 기록한 최종 URL | 비고 |
| --- | --- | --- |
| Four Pillars 포필러스 (오너 픽) | https://4pillars.io/ko | `fourpillars.io`는 연결되지 않음 |
| Tiger Research 타이거리서치 (오너 픽) | https://reports.tiger-research.com/ | |
| Citrini Research 시트리니 (오너 픽) | https://www.citriniresearch.com/ | |
| Blockworks 0xResearch | https://blockworks.com/newsletter/0xresearch | `0xresearch.co`는 연결되지 않음 |
| Delphi Digital | https://delphidigital.io/ | |
| Galaxy Research | https://www.galaxy.com/insights/research | |
| a16z Frontier | https://a16zfrontier.com/posts/ | 옛 a16z crypto. `a16zcrypto.com`에서 리디렉션되며 새 이름으로 기록 |
| DeSpread | https://despread.io/ | 리서치 조직 DeSpread Research는 2차 자료로만 확인 |
| Messari | https://app.blockworks.com/ | `messari.io`가 여기로 리디렉션됨. 페이지 제목은 Blockworks Intel. Blockworks 인수는 설명에 표기 |
| Xangle 쟁글 | https://xangle.io/ | |
| Artemis | https://about.artemis.ai/ | `artemis.xyz`에서 리디렉션 |
| Token Terminal | https://tokenterminal.com/ | |
| Kaiko | https://www.kaiko.com/ | |
| SemiAnalysis | https://semianalysis.com/ | |

제외한 곳: 없음.

## 결정한 사항

- **리서치 탭 단축키 없음:** 숫자 단축키 10개가 이미 차 있어 11번째 탭에는 주지 않았습니다. 기존 단축키는 그대로입니다.
- **기존 테스트 수정:** `App.hub.test.tsx`의 모드 목록에 리서치를 추가했습니다.
- **필터와 표지:** 태그를 고르면 첫 번째 글이 표지가 되고 표지 색도 바뀝니다. 태그가 하나뿐이면 필터를 숨깁니다.
- **의존성 추가:** `@fontsource-variable/hahmlet`(OFL). 글꼴 조각은 합쳐서 약 2 MB이고, 브라우저는 페이지에 필요한 조각만 받습니다.

## 테스트 중 고친 버그

서버가 200으로 `{}`를 돌려주면 패널이 허브 페이지 전체를 죽이는 문제가 전체 테스트에서 드러났습니다. 이제 응답 형식을 검사해 오류 안내만 표시하며, 회귀 테스트도 추가했습니다.

## 검증 범위

- 다루는 상태: 파일 없음, 형식 오류, 일부 항목 오류, 빈 요약, 구버전 서버(404), 잘못된 응답 형식.
- `shots-research/`: 1440과 390 너비, 개요와 리서치 탭, 다크 테마. 개요 상단의 허브 상태는 테스트 픽스처이고 리서치 내용은 실제 파일입니다.
- 라이트 테마, 필터 색 변경, 요약이 채워진 조판, 빈 상태와 오류 상태는 임시 데이터로 확인했고 저장소에는 넣지 않았습니다.
- 이 환경의 Node는 v22.22.2이고 `engines`는 24 이상을 요구합니다. Node 24에서는 돌려 보지 않았습니다.
- `account.txt`는 건드리지 않았고 커밋하지도 않았습니다. 라이브 서버(9377)도 건드리지 않았습니다.

STATUS: DONE

---

# 허브 제어 (BRIEF9): 승인함 · 다음 작업 · 실행 관리 · 바로가기

## 요약 (한국어)

- **승인함**
  - 봇·에이전트가 `scripts/msg-approve request …` 로 `~/.msg/approvals/pending/*.json` 에 요청을 올리면, 개요 상단과 각 모드 페이지에 요청 카드가 뜹니다.
  - PR 머지 요청은 base ← head, 파일 수, +/− 와 PR 링크를 보여 줍니다. 배포 요청은 대상과 버전을 보여 줍니다.
  - 메모를 적고 승인/거절을 누르면 확인 창이 한 번 더 뜹니다. 결정하면 요청 파일이 `decided/` 로 옮겨지고 `~/.msg/msg-approvals.log` 에 한 줄이 남습니다.
  - `pr-merge`·`deploy` 는 `~/.msg/approvals/hooks/<kind>` 실행 파일이 없으면 결정만 기록합니다. 화면에도 "실행 훅 없음 · 결정만 기록합니다" 로 표시됩니다.
- **다음 작업**
  - 각 카드의 버튼을 누르면 작성 창이 열립니다. 제목, 브리프, 엔진(Claude=claude-pick a/b/c, Codex, Hermes), 작업 폴더(모드 기본값이 미리 채워짐)를 정하고 → 확인 → 실행합니다.
  - 실행하면 `~/jobs/<날짜>-<slug>/BRIEF.md` 를 만들고 REPORT/STATUS 규칙을 덧붙인 뒤 엔진을 분리 실행합니다.
  - 최근 run.log 의 "hit your usage limit … try again at" 문구를 읽어, Codex·Hermes 를 한도 해제 시각(11/4 15:41 KST)까지 회색으로 막고 Claude 를 권합니다.
  - "봇에게" 탭은 `~/.msg/tasks/<bot>/` 에 큐 파일만 씁니다. 외부로는 아무것도 보내지 않습니다.
- **실행 관리**
  - 대상: `~/jobs/*`, `~/ai-msg-*` 워크트리, `~/msg-hub-design`.
  - 줄마다 엔진·계정, 살아 있는지, 경과 시간, REPORT 의 STATUS, 한도 도달 여부를 보여 줍니다.
  - 로그 끝부분 보기(마스킹), REPORT.md 마크다운 렌더(raw HTML 없음)를 지원합니다.
  - 중지는 검증된 PID 에만 SIGTERM 을 보내고 확인 창을 거칩니다. 다시 실행은 엔진을 새로 고른 뒤 새 폴더에서 돌립니다.
- **바로가기**: 카드나 실행 줄의 "터미널" 을 누르면 그 폴더의 최신 세션이 MSG 터미널에서 열립니다. 세션이 없으면 그 폴더로 새 대화 화면이 열립니다.
- **트레이딩 금지 규칙**은 `guard.ts` 의 코드로 강제합니다.
  - 트레이딩·QUANT 모드에는 버튼이 없고 "QUANT/해당 채팅에서만 승인" 만 보입니다.
  - 무장/해제, 라이브, 키, ARMED/FSD, Cont live, nexus-engine, cblabx-*, 포트 8771/8783/8792/8793/8830, ledger 를 언급하는 요청은 읽기 전용입니다. 서버도 승인과 거절을 모두 403 으로 거부하고 그 시도를 기록합니다.
  - 브리프나 봇 작업이 이 목록에 걸리면 거부합니다.
  - 중지·다시 실행은 이런 프로세스와 유닛을 대상으로 삼지 않습니다.
  - 어떤 ledger 에도 쓰지 않습니다.
- **보안**
  - 모든 변경 요청은 세션 쿠키 + same-origin + CSRF 헤더(HMAC) + `x-msg-confirm: yes` + JSON 을 거쳐야 합니다. 거부 코드는 401/403/428/415 입니다.
  - 모든 행동은 `~/.msg/msg-actions.log` 에 남습니다. 브리프 본문은 로그에 남기지 않고 길이와 sha 만 기록합니다.
  - 작업 환경 변수에서 토큰·시크릿을 제거합니다.
- **검증**
  - 새 테스트 67개(서버 52, UI 15)가 모두 통과합니다. 금지 동작 가드 테스트를 포함합니다.
  - `npm run typecheck`, `npm run build`(번들 검사 포함) 모두 통과합니다.
  - 전체 스위트는 마지막 실행에서 4518개 중 4517개가 통과했습니다. 실패한 1개(TradingRoom SR 표)는 부하 중 대기 시간 초과였고, 단독으로 다시 돌리면 9/9 통과합니다. 앞선 실행에서 시간 초과로 실패했던 Grok·AccountRouter·TradingRoom 테스트도 단독 실행에서는 191/191 통과합니다.
  - 스크린샷: `shots-controls/` 에 데스크톱·모바일 26장. 격리된 QA 호스트(포트 9386, 임시 HOME, 가짜 프로세스 표, 실제 실행 없음)에서 찍었습니다.
  - 실제 서비스(9377)는 재시작하지 않았습니다. merge·push·deploy 도 하지 않았습니다.

## 마지막에 고친 것

- 실행 id(`jobs:<name>`)의 `:` 를 브라우저가 `%3A` 로 인코딩하는데, 서버가 인코딩된 경로를 그대로 매칭하고 있었습니다. 그래서 실제 화면에서는 로그·보고서·중지·다시 실행이 모두 404 였습니다. 이제 한 세그먼트만 디코드한 뒤 검증합니다. 인코딩된 `/` 는 여전히 거부하며, 이를 확인하는 테스트를 추가했습니다.
- 확인 창과 보기 창이 `.sec` 섹션 안에서 렌더되면서 배경이 그 섹션만 어둡게 했습니다. 이제 `.hub-main` 으로 포털해 화면 전체를 덮습니다.
- 레일 하단과 모드 메뉴 하단의 "읽기 전용" 문구를 지웠습니다. 이제 허브에서 조치를 할 수 있으므로 맞지 않는 안내였습니다.
- 승인함·실행 관리로 스크롤할 때 제목이 상단 고정 헤더에 가리지 않도록 `scroll-margin-top` 을 두었습니다.

## Files

- Server: `src/server/hub/controls/{guard,approvals,engines,jobs,http,live}.ts`, wired in `src/server/http.ts` and `src/server/server.ts`. `DECK_HUB_CONTROLS=0` turns the controls off.
- CLI: `scripts/msg-approve` (`request | status | wait | list`).
- UI: `src/ui/hub/controls/` (Approvals, Composer, Runs, CardActions, Confirm, context, api, useControls, controls.css), wired into HubView, HubOverview, HubPage and App (`openTerminal`).
- Docs: `docs/hub-controls.md` covers the forbidden list, request gating, file formats, hooks, logs and engines.
- QA: `scripts/qa/controls-demo.ts` is an isolated host (QA_PORT, which refuses 9377). `scripts/qa/shoot-controls.mjs` drives the scenes through the msg-hub-design CDP harness.

## Screenshots (`shots-controls/`, each desktop + mobile)

| file | what |
| --- | --- |
| 1-overview | Overview: inbox on top, actions on each card, runs |
| 2-inbox | Inbox: PR merge, generic and deploy requests, a locked QUANT request |
| 3-approve-confirm | Confirm before approving |
| 4-composer | Composer: Codex/Hermes greyed out until 11/4 15:41, Claude suggested |
| 5-composer-confirm | Composer review step |
| 6-runs | Runs: alive, partial, done, BLOCKED with 한도 도달 |
| 7-report | REPORT.md rendered |
| 8-stop-confirm | Stop confirm (SIGTERM, verified PID) |
| 9-rerun | Rerun with a new engine |
| 10-terminal | Shortcut into the MSG terminal |
| 11-pages | Video page with head actions; QUANT and Trading read-only |

Note: the QA host has no sessions, so 10-terminal shows the empty new-chat screen and not a resumed session. With real data, `App.tsx` resumes the folder's latest session. `controls.test.tsx` checks only that the button passes the absolute folder path; the resume step was not exercised in a test or a shot.

STATUS: DONE

---

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

## 누락 metric과 필요한 endpoint (BRIEF10c 갱신)

**BRIEF10c에서 일별 비교용 원천 API가 제공되었다.** `GET http://127.0.0.1:8095/api/metrics/daily?days=30`은 KST 일자별 `{date, followers, following, views, posts}` 배열을 오래된 날짜부터 반환한다. `days`는 1–365(기본 30), upstream 캐시는 60초다. 조회수·게시 수는 해당 날짜에 작성된 원글만 포함하고 답글·리포스트는 제외한다. 팔로워·팔로잉은 최근 14일만 기록되어 그 이전은 null이다. 이번 연결로 전일·7일 전 대비와 30일 차트를 제공한다.

조회수 차이는 **오늘 작성된 원글의 조회수 합계 − 비교일 작성 원글의 조회수 합계**다. 오늘은 집계 중이므로 완결된 하루와 동일한 조건은 아니다. 같은 게시물 집합에서 지난 24시간 동안 늘어난 조회수나 최근 7일 합계 비교를 뜻하지 않는다.

아래는 BRIEF10 당시 제안한 별도 확장이다. 같은 게시물 집합의 시간별 조회수 증가량을 계산하려면 읽기 전용 `GET /api/growth/observations?from=<ISO8601>&to=<ISO8601>&scope=own_originals` 같은 관측 API가 필요하다. **BRIEF10c의 일별 비교에는 필요하지 않다.**

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

# BRIEF10b

## :8095 진단 정정 및 재측정

X bot 담당자의 후속 보고에 따르면 BRIEF10 당시 timeout 원인은 **호스트 과부하**(16코어에서 load 134~160, swap 8/8GiB 사용)였다. 담당자는 `/api/status`, `/api/metrics`, `/api/posts`, `/api/yap`, `/api/replies`에 짧은 stale-while-revalidate 캐시를 추가했고 약 0.03~0.27초 응답을 보고했다. 이는 upstream 담당자가 전달한 원인/수정 내용이며, 이 작업에서 upstream 코드 변경이나 서비스 재시작은 하지 않았다. 앞선 BRIEF10의 “원인을 특정할 증거 없음”은 당시 관측 범위를 설명한 기록이고, 이 후속 진단으로 보완한다.

2026-11-02 02:45 KST에 같은 호스트에서 `curl` 순차 2회와 8개 동시 GET 1회를 재측정했다. 모든 24회가 HTTP 200/exit 0이고, 기존 3초 timeout을 넘지 않았다. 아래 값은 `time_total`이다. `/api/posts` 순차 첫 요청은 0.831초로 담당자가 보고한 범위보다 길었으며, 제한된 표본으로 과부하 해소나 이후 응답시간을 보장하지 않는다.

| GET 경로 | 순차 1회 | 순차 2회 | 8개 동시 | HTTP |
|---|---:|---:|---:|---:|
| `/api/status` | 0.040867s | 0.021137s | 0.010168s | 200 |
| `/api/metrics` | 0.026285s | 0.023943s | 0.144054s | 200 |
| `/api/posts` | 0.830730s | 0.335894s | 0.053931s | 200 |
| `/api/ai_news?days=3` | 0.013542s | 0.414464s | 0.174434s | 200 |
| `/api/yap` | 0.012299s | 0.019011s | 0.065779s | 200 |
| `/api/replies?status=todo` | 0.007810s | 0.026647s | 0.058109s | 200 |
| `/api/replies?status=done` | 0.103934s | 0.030331s | 0.059566s | 200 |
| `/api/rising?limit=30` | 0.072027s | 0.148220s | 0.076827s | 200 |

측정 명령(각 경로):

```bash
curl -sS --max-time 12 -o /dev/null \
  -w '%{http_code} %{time_connect} %{time_starttransfer} %{time_total} %{size_download}' \
  'http://127.0.0.1:8095/api/rising?limit=30'
uptime
free -h
nproc
```

동시 측정은 Python `ThreadPoolExecutor(max_workers=8)`에서 같은 curl을 실행했다. 접속시간·첫 바이트·전체시간·크기·종료코드 및 시각은 [측정 원본](docs/brief10b-timings.json)에 있다. Rising 실응답은 `generated_at`, `window_h`, `count`, `items`와 30개 항목을 반환했고 요청한 항목 필드들의 자료형도 확인했다.

실제 호스트 상태:

```text
02:45:03 up 52 days, 10:11, 40 users,  load average: 126.33, 148.78, 149.86
total        used        free      shared  buff/cache   available
Mem:           187Gi        52Gi        18Gi       933Mi       119Gi       135Gi
Swap:          8.0Gi       8.0Gi        48Ki
nproc: 16
02:45:36 up 52 days, 10:12, 40 users,  load average: 130.75, 147.50, 149.40
```

캐시 적용 후 이 표본에서는 응답이 빨라졌지만, load와 swap 사용량은 여전히 높다. 기존 허브의 로컬 read-only 운영 기록 수집을 유지하고 Rising만 독립된 GET으로 추가한다.

## 작업 방식

`ask-claude -b -C /home/max/ai-msg-yapquant`에 기능 단위 위임을 시도했으나 Fable 사용 한도로 실패했다. `deck-run status`도 이 호스트에는 명령이 없어 exit 127이었다. 반복 재시도 없이 Codex 작업 에이전트에 구현·fixture·캡처 준비를 맡겼으며 오케스트레이터가 실측·통합 검증·보고서를 담당했다.

## 구현 및 최종 검증

- `src/server/hub/yapping-rising.ts`, `shared.ts`, `yapping.ts`: 고정 Rising URL을 기존 `fetchJson`/`HUB_TIMEOUTS.default`(3초)로 GET한다. 성공·실패 모두 완료 시점부터 30초 캐시하며 동시 요청은 하나로 합친다. 응답 형식·게시물 링크를 검증하고 순위 정렬/중복 제거 후 상위 10개만 반환한다. 실패하면 이전 순위를 숨기고 정제된 사유를 반환한다. 기존 로컬 운영 지표와 mode 상태는 유지한다.
- `src/shared/hub-types.ts`, `yapping.ts`, `src/ui/hub/YappingHome.tsx`, `yapping.css`: Rising 카드에 순위·작성자·한 줄 본문·조회/시간·게시 경과시간·주제 chip·외부 링크를 표시한다. 모바일에서는 속도/경과시간을 다음 줄에 배치한다. 실패는 회색 `데이터 없음 · <사유>`다.
- `tests/fixtures/yapping-rising.ts`와 collector/UI 테스트: 30개 역순 fixture로 상위 10개·정렬·자료형·안전한 링크·빈 응답·timeout/HTTP/연결/JSON 오류·30초 캐시·동시 조회·복구·기존 지표 독립성을 검증한다.
- `scripts/brief10-preview.ts`, `brief10b-capture.mjs`와 캡처 안내: 별도 loopback 미리보기에서 실제 앱을 실행한다. Rising success/error fixture와 live 모드를 명시하고 이전 스크린샷을 보존한다. 기존 BRIEF10 캡처는 fixture 사용 시 거부하도록 했다. 설계와 재현 명령은 [구현 기록](docs/brief10b-rising.md)에 있다.

Node 24.22.2 (`PATH=/home/max/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`)에서 실행:

| 명령 | 최종 결과 |
|---|---|
| `npm test -- --maxWorkers=4` | 358파일 / 4,488테스트 PASS, 162.38초 |
| `npm test -- src/server/hub/yapping.test.ts src/server/hub/yapping-rising.test.ts src/ui/hub/YappingHome.test.tsx` | 3파일 / 36테스트 PASS |
| `npm run typecheck` | PASS (`tsc --noEmit`, exit 0) |
| `npm run build` | PASS (Vite + check-bundle, 빌드 9.36초) |
| `git diff --check` | PASS |

첫 타입 검사에서 새 테스트의 불완전한 `HubDeps` 모의 객체에 TS2352가 발생했다. 전체 필드를 가진 typed stub으로 수정한 뒤 재검사/빌드가 통과했다. 실응답 JSON에도 `parseRising`을 적용해 순위 1~10, windowH=12, reason=null을 확인했다. 운영 endpoint의 실패 상황은 인위적으로 유발하지 않고 fixture로 검증했다.

## Rising 스크린샷

실제 빌드 App을 `127.0.0.1:9411`(success fixture), `:9412`(timeout fixture), `:9413`(live)에서 실행했다. 인증/세션 셸은 빈 검증용 fixture이며 운영 인증·배포 검증은 아니다. Rising fixture 외의 운영 지표는 기존 read-only 로컬 수집을 사용한다. 캡처 명령은 각 포트에 대해 다음과 같다.

```bash
BRIEF10_PORT=9411 BRIEF10B_RISING_FIXTURE=success node --import tsx scripts/brief10-preview.ts
BRIEF10_PORT=9411 node scripts/brief10b-capture.mjs
# 9412/error, 9413/live도 동일 방식으로 실행
```

**3시나리오 × 데스크톱/모바일 = 6개 화면 / 66개 assertion PASS**, 스크롤 포함 PNG 12개. Chromium headless 153.0.8010.12 사용. 최초 캡처 검토에서 Rising 제목이 고정 헤더에 가리는 문제를 발견해 캡처 스크립트가 실제 헤더 높이를 반영하도록 수정했다. 재캡처는 제목 가림 검사도 모두 통과했다. 제품 CSS나 화면 높이를 캡처용으로 변경하지 않았다.

| 데이터 | Desktop 1440×1000 | Mobile 390×844 | 검증 |
|---|---|---|---|
| 실제 Rising | [화면](shots-yapquant/brief10b-rising-live-desktop.png) | [화면](shots-yapquant/brief10b-rising-live-mobile.png) | [18개 PASS](shots-yapquant/brief10b-rising-live-assertions.json) |
| 정상 fixture | [화면](shots-yapquant/brief10b-rising-success-desktop.png) | [화면](shots-yapquant/brief10b-rising-success-mobile.png) | [24개 PASS](shots-yapquant/brief10b-rising-success-assertions.json) |
| timeout fixture | [화면](shots-yapquant/brief10b-rising-error-desktop.png) | [화면](shots-yapquant/brief10b-rising-error-mobile.png) | [24개 PASS](shots-yapquant/brief10b-rising-error-assertions.json) |

fixture 화면에는 SYNTHETIC RISING FIXTURE 배너를 명시했다. 실제 화면은 rank 1~10, 오류 없음으로 확인했다. 본문 한 줄 말줄임·안전한 외부 링크·기존 한도 카드·소스 기본 접힘·가로 넘침 없음·브라우저 console/page 오류 없음·외부 요청 없음·제목 노출을 검사했다. 실제 데스크톱/모바일 및 timeout 모바일 PNG도 직접 검토했다. 각 assertion JSON의 `screenshots`에 하위 행을 포함한 스크롤 이미지 경로가 있다. 이전 BRIEF10 산출물은 보존했다.

작업용 미리보기 세 프로세스만 종료했고 포트 9411~9413이 닫혔음을 확인했다. 운영 서비스·upstream 소스·ledger·package lock은 변경하지 않았다. shared.ts 변경은 고정 Rising URL 상수 한 줄이며 공용 timeout/transport 동작은 유지했다. 작업 범위는 `feat/hub-yap-quant`의 코드·문서·테스트·스크린샷 커밋이다. **merge/push/deploy/restart는 수행하지 않았다. 배포에는 이곳 소유자의 별도 OK가 필요하다.**

STATUS: DONE

# BRIEF10c

## 일별 API와 변화량

`GET http://127.0.0.1:8095/api/metrics/daily?days=30`을 연결했다. 2026-11-02 02:57 KST 읽기 전용 실측에서 HTTP 200, 0.202683초, 2,278 bytes였다. 실제 배열은 2026-10-04부터 11-02까지 30개 날짜이며, 앞 16개 날짜의 팔로워·팔로잉은 null이다. 이 문서의 기존 누락 endpoint 설명도 일별 비교 API가 제공된 현재 상태로 갱신했다.

- `src/server/hub/yapping-daily.ts`, `shared.ts`, `yapping.ts`: 고정 URL에 기존 3초 timeout을 적용한다. 성공·실패 모두 완료 시점부터 60초 캐시하고 동시 요청은 합친다. 날짜·순서·중복·숫자를 검증하며 실패 시 이전 일별 값을 숨기고 정제된 사유를 반환한다. 로컬 운영 지표와 Rising의 성공 여부는 독립적이다.
- `src/shared/hub-types.ts`, `yapping.ts`: KST 오늘과 정확히 어제·7일 전 날짜를 비교한다. null이나 비교일 누락은 데이터 없음이고, 실제 0과 음수는 유지한다. 7일 비교는 오늘에서 7일 전을 뺀 값이다. 최근 7일 합계 비교가 아니다.
- `src/ui/hub/YappingHome.tsx`, `YappingDailyChart.tsx`, `yapping.css`: 성장 타일의 전일·7일 전 대비와 오늘 기준 30일 차트를 표시한다. 조회수·게시물 막대와 팔로워 선은 같은 날짜 축, 각자의 숫자 범위를 사용한다. 팔로워 null과 누락 날짜에서 선을 끊으며 실제 관측점만 표시한다. 키보드·마우스·터치로 날짜별 수치를 확인할 수 있고 `팔로워 기록은 14일치`를 흐린 안내로 표시한다.
- `tests/fixtures/yapping-daily.ts`와 서버·공유·UI 테스트: 앞 16일 null/최근 14일 팔로워 fixture, 내부 null·날짜 누락, 실제 0·음수, KST 자정, 캐시 만료·요청 병합·장애 복구, 운영 지표 독립성, 차트 선 분리와 키보드 표시를 검증한다.

조회수는 각 날짜에 작성된 **원글**의 현재 조회수 합계이며 답글·리포스트는 제외한다. 화면에 날짜별 원글 조회수 차이와 `오늘 집계 중`을 명시했다. 같은 게시물의 지난 24시간 조회수 증가량으로 해석하면 안 된다. 최종 캡처 시점 값은 팔로워 509명, 전일 +5·7일 전 +6, 조회수 차이 전일 -414·7일 전 -15였다. 수치는 실행 시각에 따라 변한다.

## 검증 및 캡처

Node 24.22.2 (`PATH=/home/max/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`) 사용.

| 명령 | 결과 |
|---|---|
| `npm test -- --maxWorkers=4` | 360파일 / 4,509테스트 PASS, 148.52초 |
| `npm test -- src/ui/hub/YappingHome.test.tsx` | 최종 배열 타입 수정 후 8테스트 PASS |
| `npm run typecheck` | 최종 PASS (`tsc --noEmit`, exit 0) |
| `npm run build` | 최종 PASS (Vite + check-bundle, 2.75초) |
| `git diff --check` | PASS |

첫 타입 검사에서 차트·fixture의 배열 인덱스에 undefined 가능성 오류 4개가 발생했다. 30일 슬롯 불변식을 명시하고 날짜 레이블은 배열 순회로 변경했다. 중간 재검사 프로세스가 SIGTERM(exit 143)으로 종료되어 완료로 간주하지 않고 다시 검사했다.

`scripts/brief10-preview.ts`는 별도 loopback 포트에서 실제 빌드 App을 실행하며 daily의 live/success/error를 명시한다. 이 작업에서 사용한 포트는 9414/live, 9415/success, 9416/error다. 셸 인증·세션 응답은 빈 검증 fixture이며 배포 인증 검증은 아니다. 기존 BRIEF10/10b 캡처는 보존했다. 재현은 [BRIEF10c 캡처 안내](docs/brief10c-capture.md)를 따른다.

```bash
BRIEF10_PORT=9414 node --import tsx scripts/brief10-preview.ts
BRIEF10_PORT=9414 node scripts/brief10c-capture.mjs
# 9415는 BRIEF10C_DAILY_FIXTURE=success, 9416은 error로 preview 실행
```

3시나리오 × 데스크톱/모바일의 **6뷰, 86개 assertion PASS**, 스크롤 포함 PNG 8개다. 실제 payload와 DOM의 날짜·수치, 30개 슬롯, 막대 수, null에 따른 선 분리·관측점 위치, 변화량, 제목 가림, 가로 넘침, 브라우저 오류·외부 요청을 검증했다. fixture 화면은 `SYNTHETIC DAILY FIXTURE` 표식을 넣었다. 라이브 데스크톱·모바일 및 timeout 모바일 화면을 직접 검토했다.

| 데이터 | Desktop 1440×1000 | Mobile 390×844 | 검증 |
|---|---|---|---|
| 실제 API | [화면](shots-yapquant/brief10c-daily-live-desktop.png) | [화면](shots-yapquant/brief10c-daily-live-mobile.png) | [28개 PASS](shots-yapquant/brief10c-daily-live-assertions.json) |
| 정상 fixture | [화면](shots-yapquant/brief10c-daily-success-desktop.png) | [화면](shots-yapquant/brief10c-daily-success-mobile.png) | [36개 PASS](shots-yapquant/brief10c-daily-success-assertions.json) |
| timeout fixture | [화면](shots-yapquant/brief10c-daily-error-desktop.png) | [화면](shots-yapquant/brief10c-daily-error-mobile.png) | [22개 PASS](shots-yapquant/brief10c-daily-error-assertions.json) |

## 작업 방식과 범위

`ask-claude -b -C /home/max/ai-msg-yapquant` 기능 단위 위임은 Fable 한도로 실패했다. `deck-run status`는 이 호스트에 없고, `ask-gpt`/`ask-grok`은 키 미등록으로 사용할 수 없었다. 반복 재시도 없이 Codex 에이전트에 서버·UI·캡처를 분담하고 결과를 검토했다. 결정 기록은 [backend](docs/brief10c-backend.md), [UI](docs/brief10c-ui.md), [capture](docs/brief10c-capture.md)에 있다.

최종 타입 수정 후 빌드와 세 시나리오 캡처를 다시 실행해 통과했다. Chromium headless 153.0.8010.12를 사용했다. 이 작업의 검증용 프로세스는 정리했고 포트 9414–9416 종료를 확인했다. 운영 서비스·upstream 코드·ledger·package lock은 변경하지 않았다. 공용 transport/timeout은 유지하고 `shared.ts`에는 daily URL 한 줄만 추가했다. **merge/push/deploy/restart는 수행하지 않았다.**

STATUS: DONE

# Terminal redesign (BRIEF6)

## Changes

- Created `feat/terminal-redesign` from the fetched server main, `58b88d6`. Read `terminal-owner-1102.png` before implementation. The source repository `/home/max/ai-msg` was not modified.
- `src/ui/terminalPresentation.ts`, `MessageView.tsx`, and `Chat.tsx`: combine consecutive tool/thinking records into quiet, expandable process groups, preserving original order, tool inspection, model provenance and turn boundaries. Narrative commentary remains visible. Repeated model labels appear on hover/focus; meaningful turn and role controls remain available. Explicit leading SUCCESS/PARTIAL/BLOCKED markers become small colored status tags.
- `styles.css` and `App.tsx`: scope the redesign to Terminal, widen the normal transcript lane to 960px (wide setting 1040px), retain the larger Korean type scale, improve answer rhythm, distinguish user bubbles, and reduce repeated footer space. The hamburger remains exclusive to Terminal.
- `Composer.tsx`, `Chat.tsx`, and `UsageStrip.tsx`: integrate cache state into a solid composer, clarify model/account/approval controls, enlarge send controls and simplify header quota summaries. Existing keyboard shortcuts and controls remain mounted.
- `Sidebar.tsx`: remove markdown/status prefixes from previews, display status dots, and strengthen spacing and the active row. `FindBar.tsx` excludes content hidden inside any closed process disclosure. Historical-message memoization and grouped role summaries are covered by regression tests. `src/server/ws.tasks.test.ts` waits for server closure and uses bounded temporary-directory cleanup retries, fixing a teardown race found during validation without changing production code or assertions.
- `scripts/qa/terminal-demo.ts`, `shoot-terminal.mjs`, `terminal-README.md`, `docs/terminal-redesign-plan.md`, and `shots-terminal/`: reproducible isolated real-session comparison, design decisions and browser inspection evidence.

## Validation

| Check | Final result |
|---|---|
| `npx vitest run --maxWorkers=4` | **357 files / 4,469 tests passed**, 83.24 s, exit 0 |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks; final UI asset `main-xnOjKvfr.js` |
| `node scripts/contrast-check.mjs` | All dark/light pairs passed |
| `node scripts/qa/shoot-terminal.mjs shots-terminal before` | Eight baseline captures; same frozen real session and answer anchor |
| `DIST="$PWD/dist/ui" node scripts/qa/shoot-terminal.mjs shots-terminal after` | Eight final captures; zero browser errors, failed API checks, error toasts or horizontal overflow |
| `DIST=/home/max/msg-hub-design/repo/dist/ui LAYOUT_CHECKS=1 RDP_PORT=9344 node scripts/qa/shoot-terminal.mjs /tmp/terminal-final-layout-shots layout` | Final build passed 1.35× type scale, actual 400px split pane and 390px mobile composer bounds/menu checks |
| Browser interactions | Process expand/collapse, options, model menu, usage menu and hamburger absence on home passed |
| `git diff --check` | Passed |

The fetched baseline passed 355 files / 4,446 tests. Validation exposed one fixed-pixel caret font-size violation and an existing WebSocket task fixture teardown race (`ENOTEMPTY` after all test assertions passed). The caret now uses the existing type token; the fixture awaits server closure before bounded cleanup. The font rule and all assertions were retained. The focused task suite passed all seven tests and typecheck after the fixture fix; the final full-suite result is above. Read-only review also identified and resolved historical-message rerenders, missing grouped role summaries and invisible nested search matches.

## Before / after screenshots

All screenshots use the same frozen long session and answer (normalized hash `cbc35fd3`). Desktop captures are 1440×900; mobile captures are 390×844 at device scale 1.

| View | Before | After |
|---|---|---|
| Desktop tool-heavy turn | [before](shots-terminal/before-desktop-turn.png) | [after](shots-terminal/after-desktop-turn.png) |
| Desktop long answer, top | [before](shots-terminal/before-desktop-answer-top.png) | [after](shots-terminal/after-desktop-answer-top.png) |
| Desktop long answer, bottom | [before](shots-terminal/before-desktop-answer-bottom.png) | [after](shots-terminal/after-desktop-answer-bottom.png) |
| Desktop session list | [before](shots-terminal/before-desktop-list.png) | [after](shots-terminal/after-desktop-list.png) |
| Mobile tool-heavy turn | [before](shots-terminal/before-mobile-turn.png) | [after](shots-terminal/after-mobile-turn.png) |
| Mobile long answer, top | [before](shots-terminal/before-mobile-answer-top.png) | [after](shots-terminal/after-mobile-answer-top.png) |
| Mobile long answer, bottom | [before](shots-terminal/before-mobile-answer-bottom.png) | [after](shots-terminal/after-mobile-answer-bottom.png) |
| Mobile session drawer | [before](shots-terminal/before-mobile-drawer.png) | [after](shots-terminal/after-mobile-drawer.png) |

Personally inspected the before/after images and iterated on excessive footer gaps, composer height and mobile title space. The final turn replaces repeated pill stacks with compact process rows, keeps explanatory text visible, and gives the answer more usable width. Metrics are in `shots-terminal/before-inspection.json`, `after-inspection.json` and `layout-inspection.json`.

## Reproduction and limits

The owned, read-only demo runs on `127.0.0.1:9381`; occupied 9377 was left untouched. It freezes a production-parser snapshot of 1,000 real transcript messages (35 user, 490 assistant, 421 tool calls) from the Agentic Harness session, plus seven real sidebar titles/previews. Secret-shaped strings are redacted and tool payloads withheld; no raw transcript is committed. Usage is explicitly offline/empty, demo pin selection is synthetic, and fork status is an isolated no-divergence fixture. These are not claims about live account state.

The browser uses a file-origin build and CDP bridge to the isolated host because HTTP main-frame navigation stalls in this environment. Unauthenticated reads return 401 and mutations return 405; the host cannot execute turns. Live queue/running-task controls were not exercised in the browser, although the full component suite passed. Leading bare uppercase status words followed by Korean text intentionally use the owner's report convention; ordinary prose beginning with the same pattern may also be tagged.

The `frontend-design` skill was applied, with calibration from [The Seeker](https://ref.theseeker.io/?category=dashboard), [Refero](https://styles.refero.design/), [glass.samasante.com](https://glass.samasante.com/), [Navbar Gallery](https://navbar.gallery/), [Cursor Agent](https://cursor.com/docs/agent/overview), [Warp](https://www.warp.dev/ai) and [Raycast AI](https://www.raycast.com/core-features/ai). Existing hub tokens take precedence. Claude delegation was quota-blocked and the other external providers were unavailable; native delegated implementation, QA and review completed the work.

No push, merge into main, deployment, unit restart, protected-service access or ledger change occurred. No required work remains blocked.

STATUS: DONE

# Terminal Hermes + polish (BRIEF7)

## Changes

- `HermesEngine.ts`, `hermesAcpBootstrap.py`, `TurnRunner.ts`, `SessionState.ts`, and `ws.ts`: Hermes is a peer engine with explicit new-session selection, ACP streaming, tool/thought events, native session resume, persisted model/title/permission mode and a bounded display transcript. The model picker shows `gpt-6-astra`; automatic routing does not silently select Hermes.
- Installed Hermes 0.18.2 reloads dotenv and had native approval bypass enabled. The version-guarded bootstrap forces manual native requests inside the child process, preserving native auth/history and modifying no global configuration. MSG resolves each permission using the current user-selected mode; default does not use YOLO, explicit auto-approve permits once, edit-only checks paths, and unsupported plan/commander modes refuse safely. No secret values or raw native stderr reach the client.
- `ModelPicker.tsx`, `NewChat.tsx`, `Pane.tsx`, `SessionChip.tsx`, `EngineMark.tsx`, and sidebar/state files: complete Hermes account identity, model selection and session reopening; five-engine accents, restrained empty-state treatment and keyboard/focus affordances. Unsupported effort/cwd actions are hidden for Hermes.
- `Chat.tsx`, `MessageView.tsx`, `stickToBottom.ts`, and `styles.css`: streaming caret, process disclosure motion, user-controlled smooth bottom scrolling with upward-scroll cancellation, code-block treatment/copy affordances and reduced-motion support. Existing theme tokens and type-scale invariants remain intact.
- CLI mocks, permission-policy fixtures, runner/socket integration tests and packaging tests cover streaming, resume, images, cancellation, live permission changes, secret-safe errors and the bundled Python resource. `scripts/qa/*` adds an isolated read-only synthetic Hermes fixture; design, runtime and independent-review notes are in `docs/terminal-brief7-*.md` and `docs/terminal-hermes-engine.md`.

## Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 360 files / 4,497 tests passed; 365.01 s |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks |
| `npm run build:server` | Passed, including Python bootstrap resource |
| `node scripts/contrast-check.mjs` | All dark/light pairs passed |
| Installed Python `-I src/server/engine/hermesAcpBootstrap.py --check-policy` | `{"msgPolicySafe": true}`; no provider turn |
| `DIST=/tmp/msg-brief7-before-header/ui node scripts/qa/shoot-terminal.mjs shots-terminal-v2 hermes` | 16 captures, desktop/mobile interaction checks passed |
| `git diff --check` | Passed |

An earlier full run exposed theme-token placement, an outdated engine-icon expectation and the packaging path allowlist; these were fixed with existing invariants retained. An unchanged Grok termination timing assertion exceeded its wall-time budget under host load; its isolated 74-test suite passed, followed by the final complete run above.

## Screenshots and review

Desktop is 1440×900, mobile 390×844. `shots-terminal-v2/hermes-inspection.json` records zero horizontal overflow, browser errors and error toasts, an editable Hermes composer, and reachable model/engine selection. Personally inspected final desktop/mobile captures and iterated after the first browser run revealed an unknown-account banner for the new Hermes seat; the account classification and regression test were corrected before final capture.

| View | Desktop | Mobile |
|---|---|---|
| Hermes session/header | [desktop](shots-terminal-v2/hermes-desktop-header.png) | [mobile](shots-terminal-v2/hermes-mobile-header.png) |
| Existing-session model picker | [desktop](shots-terminal-v2/hermes-desktop-model-picker.png) | [mobile](shots-terminal-v2/hermes-mobile-model-picker.png) |
| New-session Hermes selection | [desktop](shots-terminal-v2/hermes-desktop-new-hermes-picker.png) | [mobile](shots-terminal-v2/hermes-mobile-new-hermes-picker.png) |
| Empty state | [desktop](shots-terminal-v2/hermes-desktop-empty-state.png) | [mobile](shots-terminal-v2/hermes-mobile-empty-state.png) |

The fixture is synthetic and cannot execute turns. `header-before-*` captures retain the BRIEF6 real-session comparison. The double identity, red approval chip and misleading SUCCESS marker are retained here specifically for the separately requested BRIEF7b follow-up.

The `frontend-design` skill was applied with [The Seeker dashboard](https://ref.theseeker.io/?category=dashboard), [Refero](https://styles.refero.design/), [glass.samasante.com](https://glass.samasante.com/) and [Scrolltide](https://www.scrolltide.co/) references. No new image asset was needed. External delegation was unavailable because of quota/credentials; native delegated implementation and review completed the work.

## Limits

No paid/live provider turn was run: adapter behavior is verified with CLI mocks, installed-runtime offline policy checks, and synthetic browser evidence. The policy bridge intentionally supports Hermes 0.18.2 only; a Hermes upgrade requires a reviewed adapter update. MSG retains the last 200 display records while Hermes keeps its native full conversation. Existing non-ACP CLI sessions are not imported.

No push, deployment, unit restart, protected-port access, ledger change or modification of `/home/max/ai-msg` occurred.

STATUS: DONE

# Header fix (BRIEF7b)

## Changes

- Continued after BRIEF7 was recorded DONE and committed as `b21f4ab`. Read `header-owner-1102.png` and used the same synthetic Hermes conversation for before/after comparisons.
- `SessionChipHead.tsx` and `styles.css`: a single engine mark (or chosen custom avatar), title, small engine/model chip and aligned caret form one row. Equivalent title/folder slugs are no longer repeated; differing paths remain in the tooltip and folder actions remain in the menu. Rename, switcher, custom icon, focus and drag behavior are retained.
- `Chat.tsx` and styles: automatic approval stays visibly labeled `자동 승인` with a small amber icon and explanatory tooltip. Composer approval text follows the same quieter color. No permission semantics changed.
- `terminalPresentation.ts`, `MessageView.tsx`, and `Chat.tsx`: completed turns containing a failed tool show PARTIAL even when the answer says SUCCESS. Errors are collected across commentary and model changes, explicit turn IDs survive in-turn steering, historical null IDs reset at user boundaries, busy gaps remain unfinished, and BLOCKED stays authoritative. Original message text is preserved.
- `App.tsx`: Terminal phone layout reserves space for the session title by using existing bottom navigation for mode switching and moving quota access to the sidebar account menu's `사용량 보기`. Usage history, limits, global search/activity and focus restoration remain available. Screenshot inspection prompted this iteration when the first mobile draft left only two title characters.
- Regression tests cover failed/clean turns, cross-group errors, previous-turn isolation, steering and busy gaps, single/custom identity, path normalization, and the real phone drawer-to-usage interaction. `scripts/qa/shoot-terminal.mjs` now checks visible controls, title space, partial status and the reachable mobile usage route.

## Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 360 files / 4,506 tests passed; 311.55 s |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle checks; final asset `main--AzAaDYi.js` |
| `RDP_PORT=9345 HEADER_CHECKS=1 DIST=/home/max/msg-hub-design/repo/dist/ui node scripts/qa/shoot-terminal.mjs shots-terminal-v2 header-after` | 16 captures and both-width header/interaction checks passed |
| `node --check scripts/qa/shoot-terminal.mjs` | Passed |
| `git diff --check` | Passed |

## Before / after

| View | Before | After |
|---|---|---|
| Desktop header and failed-tool turn, 1440×900 | [before](shots-terminal-v2/header-before-hermes-desktop-turn.png) | [after](shots-terminal-v2/header-after-desktop-header.png) |
| Mobile header and failed-tool turn, 390×844 | [before](shots-terminal-v2/header-before-hermes-mobile-turn.png) | [after](shots-terminal-v2/header-after-mobile-header.png) |
| Desktop model picker | [before](shots-terminal-v2/hermes-desktop-model-picker.png) | [after](shots-terminal-v2/header-after-desktop-model-picker.png) |
| Mobile model picker | [before](shots-terminal-v2/hermes-mobile-model-picker.png) | [after](shots-terminal-v2/header-after-mobile-model-picker.png) |

Final capture contains sixteen views. Root personally inspected desktop/mobile header and picker images. `header-after-inspection.json` records the same source/answer hash as BRIEF7, exactly one identity, visible amber automatic approval, discoverable full Hermes model, PARTIAL with one tool error, reachable usage and no page overflow or browser errors. The final mobile title has 105.28px of visible width. Mobile usage was opened through the visible drawer account menu and closed successfully. A separate task occupied the usual CDP port during capture; only our own stalled browser was stopped, and final capture used 9345. The owned read-only QA host was stopped after completion.

The frontend-design references and design direction are documented in `docs/terminal-brief7-design.md`; independent status/header review is in `docs/terminal-brief7b-review.md`. Screenshots are synthetic UI evidence, not a live provider turn. BRIEF7's Hermes 0.18.2 runtime restriction and no-live-model verification limit still apply.

No push, merge into `/home/max/ai-msg`, deployment, unit restart, protected-port access or ledger change occurred. No required work remains.

STATUS: DONE

# Usage panel (BRIEF7c)

## Changes

- `UsageStrip.tsx`, `UsageSheet.tsx`, `usageSeats.tsx`, and `styles.css`: shared provider identity and account badges, one thin remaining-capacity bar, aligned weekly/5h/Fable rows, calm exhaustion chips containing relative reset times, exact KST tooltips, and one muted login action per logged-out account. GPT explicitly identifies Codex and the quota shared with Hermes. Fixed the inherited flex-wrap rule that pushed Grok into a clipped second column.
- `EngineMark.tsx`: local inline Claude, OpenAI, Gemini, and Grok identifiers; published Claude/Grok paths include source attribution and MIT notice in `docs/usage-brand-assets-LICENSE.txt`. No hotlinked image asset or new raster artwork.
- `codexLiveUsage.ts`, `CodexUsagePoller.ts`, HTTP/server wiring and `App.tsx`: authenticated usage refresh on open/focus, using Codex's non-inference `account/rateLimits/read` before timestamped rollout fallback. Requests coalesce and are throttled; CLI owns authentication. Complete live readings clear absent windows, while malformed readings retain fallback data.
- `UsageService.ts`, `TurnRunner.ts`, and `engineLimits.ts`: preserve original observation times, prevent older/equal/undated dashboard data from reviving old limits, clear pre-turn exhaustion/cooldown after Codex or Hermes success, persist the success timestamp against restart replay, and preserve measured new limits, credits, and newer concurrent failures. Missing or expired quota remains unknown rather than an invented remaining percentage.
- Regression tests cover live RPC/auth/timeout, source precedence, missing windows, short-interval reset/success, restart replay, concurrent failures, dynamic account labels/order, KST times, single-bar layout, login actions, and open/focus refresh. Design, implementation, QA and independent-review notes are in `docs/usage-brief7c-*.md`.

## Freshness evidence

The owner crop showed GPT exhausted until November 4. The previous poller read historical rollout records only; successful turns retained a cooldown and could re-date an old record as current. A read-only query through the new helper against the installed Codex CLI succeeded at **2026-11-02 02:48:20 KST**: **weekly used 7%, remaining 93%**. The response contained no five-hour window. This is point-in-time live evidence; no inference turn, login, credit reset, or account mutation was sent. The existing running application was not restarted or deployed, so it will receive the fix only through a later deployment.

## Screenshots and review

`shots-terminal-v2/usage-before-*` and `usage-after-*` contain 18 PNGs per revision plus inspection JSON, covering dark/light desktop popover, desktop sheet and mobile sheet. The same synthetic seven-account fixture and frozen **November 2, 02:00 KST** clock are used throughout; GPT intentionally remains exhausted in these images to compare the exhausted design. These screenshots are visual evidence, separate from the live quota observation above.

Root personally inspected dark/light popovers, the dark phone sheet and the light phone sheet's scrolled lower rows. All six after views pass strict bounds/overflow checks, display all seven accounts, use one bar for each known account and no bar for logged-out accounts, contain exactly two login buttons, and expose Grok after scrolling. No browser/API errors or external image requests were observed. The before desktop popover records the clipped Grok defect; the final layout fixes it. A later account-badge title attribute adds full-name discovery without changing the captured layout.

| View | Before | After |
|---|---|---|
| Dark desktop popover | [before](shots-terminal-v2/usage-before-dark-desktop-popover-crop.png) | [after](shots-terminal-v2/usage-after-dark-desktop-popover-crop.png) |
| Light desktop popover | [before](shots-terminal-v2/usage-before-light-desktop-popover-crop.png) | [after](shots-terminal-v2/usage-after-light-desktop-popover-crop.png) |
| Dark mobile sheet | [before](shots-terminal-v2/usage-before-dark-mobile-sheet-crop.png) | [after](shots-terminal-v2/usage-after-dark-mobile-sheet-crop.png) |
| Light mobile lower rows | [before](shots-terminal-v2/usage-before-light-mobile-sheet-bottom.png) | [after](shots-terminal-v2/usage-after-light-mobile-sheet-bottom.png) |

The `frontend-design` skill informed the plan and critique, with [The Seeker](https://ref.theseeker.io/r/5649) and [glass.samasante.com](https://glass.samasante.com/) references. Existing hub typography and surface tokens are retained. External delegation was unavailable (Claude Fable quota, missing GPT/Grok API credentials); native agents handled UI, freshness and QA, followed by independent freshness review. Its source-precedence, malformed-input and concurrent-cooldown findings were fixed and regression-tested.

## Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 361 files / 4,526 tests passed; 238.81 s |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, including bundle check |
| `npm run build:server` | Passed |
| `node scripts/contrast-check.mjs` | All dark/light token pairs passed |
| `node --check scripts/qa/shoot-terminal.mjs` and `node --check scripts/qa/usage-capture.mjs` | Passed |
| `QA_STATE=/tmp/msg-usage-brief7c-qa-state.json DIST=/home/max/msg-hub-design/repo/dist/ui CAPTURE=usage RDP_PORT=9345 node scripts/qa/shoot-terminal.mjs shots-terminal-v2 usage-after` | Passed, six surfaces / 18 PNGs, no errors |
| `git diff --check` | Passed |

An initial suite overlapped review edits and was stopped because its transform cache mixed old source with new tests. The subsequent settled-source suite passed 4,525 tests and found one old Grok reset-text expectation missing the now-explicit KST suffix. That expectation now asserts the exact KST timestamp; its focused nine-test suite passed before the final whole-suite run above. Dynamic account tests were also updated for the new badge structure while preserving ordering, custom names and retired-account coverage.

The owned synthetic QA host and browser were stopped after capture. No push, deployment, production restart, protected-service access or modification of `/home/max/ai-msg` occurred. Live quota fallback remains best-effort when Codex is unauthenticated, unsupported or offline; no inference test was run. No required work remains.

STATUS: DONE


## BRIEF7d

Claude's 5-hour window is gone from every display and routing decision. Claude shows Weekly (7d) and Fable when known; Codex/GPT, Grok and Antigravity keep their own displays, including GPT's 5h row.

### Changed files

- Usage intake: `src/server/usage/UsageService.ts` (single chokepoint — Claude `fiveHour` is dropped from deck cards, CLI reads and turn events, persisted values are ignored and removed on the next write; lift/stale no longer need 5h), `src/server/usage/ClaudeUsagePoller.ts` (comment).
- Routing: `src/server/routing/AccountRouter.ts`, `src/server/routing/AutoModel.ts` (comment).
- Other surfaces: `src/server/hub/self.ts`, `src/server/mini/status.ts`, `src/shared/mini-types.ts`, `src/shared/protocol.ts`, `src/ui/components/usageSeats.tsx`, `src/ui/components/AccountPicker.tsx`, `src/ui/components/SettingsView.tsx`, `src/ui/mini/render.ts`, `src/ui/styles.css` (comment), `scripts/widget/msg-widget.js`.
- Docs: `README.md`, `README.ko.md`, `docs/widget.ko.md`.
- Tests: `src/server/routing/{AccountRouter,AutoModel,AutoRoute}.test.ts`, `src/server/usage/{UsageService,ClaudeUsagePoller}.test.ts`, `src/server/hub/self.test.ts`, `src/server/mini/status.test.ts`, `src/server/ws.status.test.ts`, `src/server/turn/TurnRunner{,.accounts,.pin}.test.ts`, `src/ui/App.test.tsx`, `src/ui/mini/{main,render}.test.ts`, `src/ui/components/{UsageStrip,usageSeats,AccountPicker,Accounts}.test.tsx`.

### Behaviour that changes as a result

- Balance routing: lowest weekly use first. Within 5 points, the protected account goes last, then the drain score decides.
- A cold session moves only for a weekly gap of 25 points or more, so B 22 vs C 0 now stays. Previously a cold session could also move on a 5h difference; with no 5h data it never moved.
- Residual Claude 5h data is ignored everywhere in the router, not only in balance ordering: exclude, force-move, pin at limit, stale at-limit and the drain policy's safety check. Real rejections still go through the existing cooldown path.
- A down card with a fresh weekly observation now lifts to ok even when its old 5h row is present, so such an account becomes routable sooner.
- The hub seat table keeps its 5시간 column for GPT; Claude rows show "—". The mini API keeps `left5h` / `resets5h`, null for Claude.

### Validation

| Check | Result |
|---|---|
| `npx vitest run --maxWorkers=2` | 361 files / 4,550 tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm run build:server` | Passed |
| `git diff --check` | Passed |

Screenshot: `shots-terminal-v2/usage-no5h-desktop.png` (usage popover, dark desktop, synthetic `USAGE_FIXTURE=brief7c` data that still carries a Claude 5h value, showing it is not displayed). Inspected: Claude rows 주간/Fable only, GPT 주간/5h intact, no layout gap.

Not verified: `scripts/widget/msg-widget.js` was edited and its mini-render counterpart tested, but the widget was not run on a Scriptable device. Not changed: mockups under `scripts/render/` and `scripts/qa/usage-fixture.ts`. No live quota was read. No push, merge, deployment or restart occurred.

STATUS: DONE
