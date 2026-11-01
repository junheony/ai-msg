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
