# HANDOFF — deck (갱신 2026-10-10)

> 형식은 agentic-harness 의 `session-handoff` 스킬. 이 파일을 고쳐 쓴다(날짜별 새 파일 금지). 이 저장소는 비공개 원본(원격 없음)이고, 공개본은 `scripts/export-public.sh` 로 뽑아 따로 올린다.

## 다음 할 일 (2026-10-06 오후)
- **폰 세션 "권한이 없대" = macOS TCC 문서 폴더 거부 (2026-10-10 22:35, "응 다 해줘")**: deck 회귀가 아니다. 턴마다 뜨는 프로세스 트리(deck 서버 → SDK `claude` → bash/python)가 **간헐적으로** `~/Documents` 접근을 거부당한다(stat 은 되고 open/readdir/getcwd 가 EPERM; 10-08 에도 있었고 계정 A·C 모두, 같은 세션 안에서도 턴·시각에 따라 다름 — 62adebb9: 04:19 정상 → 04:34 턴 전체 EPERM, 12:38 정상 → 12:46 EPERM). 그러면 `usage-deck/bin/offload-guard` 훅이 실행조차 안 되어 `PreToolUse:Agent hook error … Operation not permitted` → Agent 도구가 `permission-rule` 거부로 보였다. TCC 기록은 root/전체 디스크 접근 없이는 못 본다(`TCC.db` authorization denied, tccd 로그 비공개). 넣은 것: ① `src/server/tccDenial.ts` — `isError` tool_result 본문에 `Operation not permitted` + (`/Users|/Volumes` 경로 또는 `getcwd: cannot access parent directories`) 면 TCC 거부로 보고, `ws.ts` sink 가 그 턴에 **한 번** `turn_notice`(`TCC_DENIAL_NOTICE`, 턴 항목의 note 로 표시, UI 변경 없음) 를 보낸다(`tccDenial.test.ts`, `ws.activity.test.ts` 마지막 케이스; 성공 결과가 그 문구를 인용한 경우·kill/chown EPERM·분류기 거부는 아님). ② 훅을 Documents 밖으로: `~/.local/bin/offload-guard`·`~/.local/bin/session-size-guard` 는 usage-deck `bin/` 의 **복사본**(심링크는 Documents 로 풀려 소용없음)이고 `~/.claude{,-b,-c}/settings.json` 의 훅 `command` 가 그쪽을 가리킨다 — **usage-deck 쪽을 고치면 `cp` 로 다시 맞춰야 한다**. offload-guard 가 부르는 `claude-pick`(`~/bin/claude-pick` → Documents 심링크)은 여전히 거부될 수 있지만 그땐 예전 판정으로 넘어간다(fail-open). **사용자 몫(근본 해결)**: 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근에 `deck/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 와 `node`(`~/.local/bin/node` → `~/.hermes/node/bin/node`) 허용. ①은 **서버 재시작해야 반영**(pid 30857, `kill -USR2`) — 아직 안 했다.
- **GPT 샌드박스 "다 붙여" ①②③ (2026-10-10 01:40, "다 해")**: ① `DEFAULT_SANDBOX = 'workspace-write'` 항상(`defaultSandbox(autoApprove)` 삭제, Gemini 는 `defaultGeminiSandbox` 로 예전 의미 유지 — 리듀서가 `set_engine` gemini 때 자동 승인 설정에 따라 plan/auto_edit 를 넣고 `applySettings` 는 Gemini pane 만 따라 바꿈; 리뷰에서 잡힌 HIGH) ② 기존 GPT 세션에서 변경: 클라 `set_sandbox{sessionId,sandbox}` → `TurnRunner.setSandbox`(store, 도는 턴은 원래 값으로 끝내고 끝날 때 새 값 안 덮음, 아직 안 이어 쓴 Codex Desktop 스레드는 메모리에 뒀다 첫 턴에 저장) → 서버 `sandbox{…}` 는 `open_session.accepts: ['sandbox']` 를 보낸 소켓에만(옛 UI 보호, `catchup.sandbox` 도), 기능명 `sessionSandbox`, Chat 칩이 피커(낙관적 반영 없이 서버 `sandbox` 방송으로만 갱신 → 거절되면 그대로), Claude·Gemini 세션은 거절, imported 스레드 경합은 `freshCodexImport` 뒤 store 재확인 ③ workspace-write 에 `-c sandbox_workspace_write.network_access=true`(읽기 전용엔 안 넘김), 라벨 "작업폴더 쓰기 · 네트워크". `danger-full-access` 는 타입·zod 모두 없음(테스트). 문서 ARCHITECTURE/protocol/README 갱신. 커밋 `77a69e2`. 공개본 `3a3e218`(e0c5862·39dcf0d·77a69e2·89ec4d5·68e93f1·c495ae2 묶음, 01:55). 재시작은 01:56 `kill -USR2 7954`(relaunch 루프 77474 가 새 서버를 띄움; 이 세션의 부모라 이 턴이 끝난 뒤 교체됨 — 다음 세션에서 `deck.log` 의 `new server healthy` 와 새 pid 확인). 테스트 160파일 1762건(`ws.outside.test.ts` 의 poll tick 1건이 전체 병렬 실행에서 한 번 간헐 실패, 재실행·단독 통과 — 타이밍 flaky). **서버 재시작 필요**.
- **폰 체감 마찰 2차 — 남은 ①~⑦ 전부 (2026-10-10 00:50, "전부 다 해야지")**: 1차의 남은 리뷰 항목을 두 묶음으로 넣었다. `e0c5862`: ① `useStartWatch`(15초 무응답 → 재접속, Activity 에 취소 버튼 → `cancel_start` 가 글·파일을 입력창에 되돌림) ② `sendFromPane` 이 `send()` 실패를 봄 → 끊긴 상태의 전송은 바로 `restart:'hold'` 큐(`requeue how 'offline'`), 중단 요청도 성공 때만 ③ 초안 `localStorage`(`drafts.ts`, TTL, NewChat 초안 `newChatDraftKey`) ⑤ NewChat 엔진·샌드박스 선택(`NewChatOptions`) ⑦a `ReplayLog.text` 로 턴 중간에 연 기기도 지금까지 텍스트를 받음 ⑦c 끊긴 상태의 중단은 '중단됨' 대신 안내(`pane_notice`) ⑦d 알림 클릭이 색인에 없는 세션이면 `openRequestStep` 으로 오류 문구. 다음 커밋(이 아래 해시): Pane↔NewChat 연결(`set_engine`/`set_sandbox`), 큐 칩 라벨이 끊김이면 "연결되면 전송"(`connected` prop Pane→Chat→QueueChips) ④ `AppState.recent`(메모리 LRU 5, `RECENT_SESSIONS_MAX`) — 다시 연 세션은 직전 내용이 바로 뜨고 `loading` 이면 스켈레톤 대신 `.chat-refreshing` "불러오는 중…", 메시지 key 는 `messageKeys()`(직전 사용자 메시지 순번 기준, 펼친 카드가 history 재도착에도 유지) ⑥ 오류 띠 → `Toasts.tsx`(info 5초·error 12초 자동 닫힘, 최대 4, `role` 구분, reduced-motion) — `state.error` 는 effect 가 토스트로 옮기고 `dismiss_error`; "이미 처리된" 응답은 토스트 없이 해당 카드만 제거(서버 error 에 `requestId`) ⑦b 새 세션 첫 턴 중 새로고침: 서버 `TurnSink.sessionKnown` → `adopt()` 가 init 시점에 `activity`·`hello.running` 에 id 를 싣고, 색인 전 세션의 `open_session` 은 빈 history(+runningTurnId) 를 돌려줌; `persist.ts` 가 id 없는 pane 의 `turnId` 를 저장하고 리듀서 `hello`/`activity` 가 자기 턴의 id 를 채택(App 은 `tracker.hello()` 전에 `latest.current` 를 갱신). 리뷰(opus)에서 잡혀 같이 고친 것: 첫 턴 중 권한 모드·고정 계정 변경이 `setPermissionMode`/`setAccountPin` 에서 거절되던 것(진행 중 턴 `bornTurnOf` 에서도 찾고, 핀은 `bornPins` 로 시도 종료 뒤 저장), hydrate 의 `myTurns` 잔존. 테스트 159파일 1751건. **알려진 한계**: `turn_started` 전 새로고침은 여전히 chip 만 남음(clientRef→세션 역방향 맵이 필요, protocol 변경이라 미착수); 색인 전 세션의 빈 history 는 그때까지의 블록·모드·핀을 안 보여 줌(다음 open 때 복구); 연속 텍스트 블록 replay 중복 가능·thinking 블록 replay 없음; 만료 초안은 읽을 때만 정리. **서버 쪽 변경(`89ec4d5`·`68e93f1`·`e0c5862` ws.ts·이번 ws.ts/TurnRunner.ts)은 재시작해야 반영** — pid 7954 `kill -USR2`, 사용자가 말할 때만. UI 는 `vite build` 로 반영됨. 공개본 푸시는 사용자 말 기다림.
- **폰 체감 마찰 1차 (2026-10-09 17:40, "매끄럽지 않다")**: 오프로드 리뷰(계정 C, `/tmp/deck-ux-review/`)가 뽑은 상위 10 중 빠른 것 5개를 `c495ae2` 로 넣었다 — ws `wake()`(visibilitychange/online 에 재접속 대기 건너뜀, `/api/me` 부팅 재시도 3초), catchup 복귀 시 5초 stall(`CATCHUP_VISIBLE_STALL_MS`), 승인·계획·질문 카드 눌림 상태(`usePending`, 8초 복구), 터치 detach 임계 10px 세로 우세(`touchDetaches`), coarse pointer 입력 ≥16px. `vite build` 로 UI 는 반영됨. 서버 쪽 `89ec4d5`(색인기 `.deck-tmp` 건너뜀·ENOENT 조용히)·`68e93f1`(폴더 정렬 로케일 고정 — 전체 테스트가 ko_KR 셸에서 1건 깨지던 것)은 **재시작해야 반영**(pid 7954, `kill -USR2`; 이 세션의 부모일 수 있어 턴 중 재시작 금지). **남은 리뷰 항목(미구현)**: ① `awaitingStart` 무한 "시작하는 중…" — 15초 무응답이면 재접속+취소 버튼(`state.ts:992`, `Activity.tsx`) ② `sendFromPane` 이 `send()` 실패를 안 봄 → 말풍선이 떴다 큐 칩으로 바뀜; 실패면 처음부터 `restart:'hold'` 큐로(`Pane.tsx:57`) ③ 초안이 sessionStorage 라 iOS 가 PWA 를 내리면 사라짐, NewChat 초안은 저장 없음(`autoReload.ts:44`, `NewChat.tsx:50`) ④ 세션 전환마다 빈 화면→스켈레톤, items LRU 캐시 없음, 메시지 `key={i}`(`state.ts:949`, `Chat.tsx:501`) ⑤ 새 대화 화면에 엔진·샌드박스 선택 없음(`NewChat.tsx:118`) ⑥ 전역 오류 띠 하나가 레이아웃을 밀고 안 사라짐, "이미 처리된" 도 오류로(`App.tsx:463`) ⑦ 상태 불일치 후보: 턴 중간에 연 세션의 응답이 문장 중간부터(`ws.ts:495` replay 에 지금까지 텍스트 없음), 새 세션 첫 턴 중 새로고침 시 id 없어 빈 창(`persist.ts:98`), 소켓 끊긴 채 중단 탭이 "중단됨" 표시(`Pane.tsx:194`), 알림 클릭이 색인에 없는 세션이면 무시(`App.tsx:251`). 부수: `offload` auto 가 주간 86% 인 C 를 80% 인 B 보다 먼저 골랐다(선택 규칙 점검 대상).
- **아이콘·알림 배지·GPT 샌드박스 칩 (2026-10-09 17:10)**: 웹앱 아이콘을 deck 전용(테라코타 칩 + `>_`, Higgsfield 생성 이미지 `scripts/assets/deck-icon-1024.png`)으로 바꿨다. `scripts/gen-icons.mjs` 가 그 원본을 잘라 192/512/maskable/apple-touch 를 만들고(의존성 없음) Android 알림 배지 `badge-96.png`(`>_` 만 흰색·투명)를 그린다 — Android 는 `badge` 를 단색 실루엣으로 그려서 배경 있는 컬러 PNG 가 흰 네모로 보였던 것. `sw.js` 는 icon=icon-192·badge=badge-96, 캐시 이름 `deck-shell-v2`(같은 이름의 옛 아이콘이 SW 캐시에 남지 않게). 상단 바·로그인 브랜드는 `DeckMark`(인라인 SVG 칩), 세션의 엔진 마크(Claude ✳·OpenAI)는 그대로. 커밋 `9bea689`, `vite build` 로 반영(서버 재시작 없음). **폰**: iOS 는 홈 화면 앱을 지우고 다시 추가해야 새 아이콘(apple-touch-icon 캐시), Android 는 새로고침 뒤 알림 하나 받아 썸네일·배지 확인. `b229134`: 새 GPT 세션 첫 턴 뒤 샌드박스 칩이 '읽기 전용' 으로 보이던 UI 버그 — `turn_started` 가 engine 만 채우고 `session.sandbox` 는 null 이라 칩이 기본값을 보여 줬다(실제 실행은 보낸 값대로; 이 맥은 자동 승인이라 새 GPT 세션은 작업폴더 쓰기). "GPT 읽기 전용" 은 세션 전체가 아니라 D2 샌드박스(읽기 전용 / 작업폴더 쓰기·네트워크 차단, 승인 카드 없음, danger-full-access 없음)이고 세션 생성 때 고정(`SessionState` D2/D3). 사용자의 "다 붙이라" 에 대한 선택지(결정 대기, 미구현): ① 기본값을 항상 작업폴더 쓰기 ② 기존 GPT 세션의 샌드박스 변경 허용(`codexArgs` 는 턴마다 `-c sandbox_mode` 를 주므로 기술적으로 가능) ③ 네트워크 허용.
- **재시작 (2026-10-09 15:17)**: drain 수정 `169867e`(held 프로세스는 즉시 끝내고 실행 중 턴만 기다림, 테스트 1663) 전의 서버(21563)는 옛 코드라 15분 상한까지 기다렸고 **62adebb9 턴이 상한에서 중단**됐다(재전송은 사용자 결정). 새 서버 pid 7954(relaunch 루프 77474 가 띄움, launchd 아님). 다음 재시작부터는 짧게 끝난다. 공개본 `3b67231`(17:10) 에 `1a36965`·`857d7c5`·`169867e`·`9bea689`·`b229134` 를 묶어 올렸다(클론 `/tmp/quarterdeck-pub`, 재부팅 전까지만 남아 있음).
- **재부팅으로 서버 꺼짐 (2026-10-07 13:40)**: 맥이 04:41 에 재부팅됐다(패닉 보고서·OS 업데이트 흔적 없음). 셸에서 띄운 서버(pid 56716)가 같이 꺼졌고 `/tmp/deck-relaunch.sh`·`/tmp/deck-migrate-fable.py` 도 지워졌다. launchd `com.deck.server` 는 `~/Documents` 아래 `run.sh` 를 못 읽어(TCC, 전체 디스크 접근 없음) 종료 코드 126 으로 10초마다 재시도 중이고 `deck.log` 에 두 줄씩 쌓인다. 13:39 에 `run.sh` 와 같은 방식(`~/.config/deck/env` 로드 + `node --import tsx src/server/main.ts`)으로 셸에서 nohup 시작(pid 9267, PPID 1). 전체 디스크 접근 권한을 주기 전까지는 재부팅할 때마다 손으로 띄워야 한다(권한은 사용자 몫).
  - **원인 (14:45 조사)**: 전원 사고다. 이전 부팅의 로그가 04:40:32 에 종료 절차 없이 뚝 끊기고 52초 뒤 04:41:24 에 콜드 부팅했다(배터리 74%·AC 상태, 패닉·스톨 보고서 없음, 셧다운 원인 코드는 이 OS 가 로그에 안 남긴다). 같은 시각 사무실 다른 컴퓨터도 전부 꺼졌다고 한다. 전원이 돌아오자 전원 연결 시 자동 시작(`nvram BootPreference` 없음 = 켜짐)으로 혼자 켜졌지만, FileVault 로그인 화면에서 12:22 콘솔 로그인 때까지 멈춰 있었다(12:22:28 "Early boot complete. Continuing system boot" 유저스페이스 재부팅, powerd pid 363). 즉 **정전 뒤에는 누가 로그인하기 전까지 맥의 어떤 launchd 작업도 돌지 않는다** — 전체 디스크 접근을 고쳐도 로그인은 필요하다. 배터리 74% 인 맥북이 AC 끊김만으로 꺼질 리는 없어서 독/충전기 경로의 서지로 추정(로그로는 확정 불가). max-linuxserver 는 무사(09-10 16:33 부팅, 26일 가동, usage-deck pid 1037602 09-26 부터, 9310 응답 200). launchd 재시도는 14:45 기준 837회, `deck.log` 에 1696줄.
  - **정전 뒤 점검 (14:55)**: 리눅스는 영향 0(유저 서비스 155개·도커 9개·타이머 정상, 실패는 전부 이전부터 있던 것 — `onchain-radar-live-universe` gate FAIL 반복, `funeral-snapshot` 간헐 타임아웃, 09-28 `bbai-*` 3개). 맥에서 자동 복귀: postgres/redis·dashboard-sync·vault-mirror-sync·laptop-watch-deploy. **안 돌아온 것**: ① 계정 C 세션 `62adebb9`(cwd `~/Documents/개발`, 친구봇 카피 표준 목표) — 밤새 ssh 로 리눅스에 v9t…v9xu 변형을 띄우다 04:40:10 `v9xu_twins_score.sh` 작성 중 끊김. 리눅스 `v9xu-ex/b2/b3/w` 는 살아 있으나 채점·다음 변형은 멈춤, 12:22 뒤 재개 흔적 없음. ② `com.max.nexus-offsite-pull`(매일 07:30) 오늘 건너뜀. 별개로 `com.user.mini-router` 도 TCC 126 으로 7월부터 실패 중(venv 없음, err 로그 130 MB), `jdj`×4·`re-daily-report`·`goldhaltprobe` 는 6월 이후 산출물 없음. 세 가지 조치(백업 kickstart / deck·mini-router bootout / 62adebb9 재개 턴)는 사용자 답 대기 — 답 없이는 하지 않는다.
  - **토큰 분배 고장 (10-08 11:10 조사, "B 많이 남았잖어")**: 10-06 16:05(B)·16:35(A) 부터 분배가 안 됐다. max-linuxserver 의 `~/.claude-b/.credentials.json`·`~/.claude/.credentials.json` 이 **로그아웃 상태**(accessToken·refreshToken 빈 문자열, expiresAt 0) → usage-deck 카드 `setup_needed` → deck 은 'down'(`잔여량 모름 B, A`) → Fable 후보에서 제외 → 모든 턴이 C 로 → C 주간/Fable 47%→84% → "Fable 여유 계정 없음 → Opus" 강등 → 10-08 에는 `route 3640bba1 → B (고정 B 전환) · 잔여량 모름 B, A · 제외 C Fable 84%`(눈 감고 B). B 마지막 정상값(10-06 16:03) 5h 23%·주간 40%·Fable 31%. **원인 사슬**: 리눅스 `claude-token-refresh.service`(30분 타이머, `CLAUDE_CONFIG_DIR=… claude -p ping`)가 액세스 토큰(8h)은 갱신해도 **refresh token 은 회전되지 않는다**(C 로 교차 확인: 10-06 이후 26회 갱신했는데 `refreshTokenExpiresAt` 10-20 11:33Z 고정). A·B 의 refresh token 은 09-22 리눅스 로그인 시 발급된 14일짜리라 10-06 10:13(B)·16:14(A) KST 에 만료됐고, 그 뒤 첫 실제 갱신 시도(16:10:03 second rc=1, 16:40:00 main rc=1)에서 claude 가 빈 자격증명을 써 버렸다. 이후 30분마다 92회 rc=1 반복 중(오늘 10:40 `~/.claude{,-b}/projects/-home-max/*.jsonl` 의 queue-operation 흔적이 그것). 부수 발견: 스크립트 전제("90분 전 선제 갱신")가 틀림 — claude 는 85분·25분 남았을 때도 갱신하지 않고 만료 후에만 갱신하므로 만료~다음 타이머 사이 최대 30분 공백은 원래 있었다. **조치(사용자)**: 리눅스에서 `CLAUDE_CONFIG_DIR=~/.claude claude /login`, `CLAUDE_CONFIG_DIR=~/.claude-b claude /login` → 5분 폴링 뒤 카드 복구, deck 다음 라우팅부터 반영. **C 도 같은 이유로 2026-10-20 20:33 KST 에 끊긴다** — 2주마다 세 계정 재로그인이 필요. 제안(승인 전 미구현): ① 리눅스 refresh 스크립트에 `refreshTokenExpiresAt` D-2 경고와 rc=1 연속 시 알림, ② deck 에 Claude 카드 down 지속(예: 30분↑) 경고 로그/UI, ③ down 카드에 last-good 숫자를 쓰는 것은 "숫자를 지어내지 않는다" 원칙과 충돌해 비추천.
  - **복구 (10-08 19:00·19:12)**: 사용자가 리눅스 tmux(`claude-login-a`·`claude-login-b`, `CLAUDE_CONFIG_DIR=… ~/.local/bin/claude /login`)에서 A·B 를 다시 로그인했다. 19:13:30 usage-deck 세 카드 모두 ok(A 0/0/0, B 5h 8%·주간 56%·Fable 52%, C 0/85/84) → deck.log `후보 B …, A …` 로 라우팅 복구. 새 refresh token 은 29일짜리(A 11-06 02:12Z, B 11-07 09:44Z 만료) — **11월 초에 A·B 재로그인, C 는 여전히 10-20 20:33 KST**. 재로그인 뒤 세션 로그에 `A(보호)` 가 떠서 아래 라우팅 변경으로 이어졌다.
- **보호 계정 = 동등 후보, 동률일 때만 마지막 (2026-10-09 00:10, "A 로 바꿔야할듯?")**: 아래 b8db453 의 "safe 안에서 보호 마지막" 도 A 를 거의 안 쓰게 만들었다(A 5h 0% 가 B 17% 뒤). 이제 보호 계정은 **순위에서도 똑같다**: balance 는 5h 최저(5%p 안이면 주간 낮은 쪽), drain 은 점수 — 보호는 그 뒤 **동률 깨기**로만 마지막. `AccountRouter.ts`: `isPreferred` 삭제, `balanceOrder` 풀 = safe 전부(동률 정렬 `weekly || protected`), `drainOrder` = safe → 점수 → 주간 → 보호 → stale → 등록 순, 콜드 히스테리시스는 `isSafe(cur)`(보호 계정 위의 콜드 세션도 5%p 넘게 낮은 곳 있어야 떠남), 이유 문구 `동률이면 마지막` 추가, 로그 라벨 `(마지막)` 제거. 모름(`unknown`) 순서·`reg.fallback` 은 그대로 보호 마지막(아무것도 모르면 동률). 테스트 1663 통과(`AccountRouter.test.ts` 기대값 전환, `TurnRunner.test.ts` 라우팅 이유 `C 0% < A 13%`). 커밋 `f875b71`(리뷰 반영: 주석·문서·`balanceWhy` 동률 분기 5h-known 조건). **재시작 (00:10:47 → 00:25:50)**: `/tmp/deck-relaunch.sh`(USR2 → drain → 깨끗한 env 로 `scripts/launchd/run.sh`, 빠른 실패 5회까지 재기동 루프)를 setsid 로 띄웠다. drain 이 15분 상한에 걸려 **남은 턴 5개가 중단됐다**(그 시간에 transcript 가 바뀐 세션: 1ecf4434·3cf08150·427264f5·62adebb9·aa198c8d — 62adebb9·aa198c8d 는 재시작 뒤 새 턴이 돌았다). 새 서버 pid 21563(부모는 relaunch 루프 pid 77474, launchd 아님). 재시작 뒤 route 로그: `→ A (Fable 88% 이상 → A 전환) · 후보 A 5h 0% · 주간 3% · 제외 B Fable 88%, C Fable 85%` — B·C 가 Fable 서브캡(80%)을 넘어서 **Fable 턴은 지금 전부 A** 로 간다(A 5h 0%→50% 를 한 시간 안에). 다음엔 drain 상한을 길게 주거나 한가할 때 재시작할 것. 공개본 `44b63a2` 로 푸시(b8db453+f875b71 묶음). `offload`/`claude-pick` 의 보호 규칙(유일 후보일 때만)은 아직 그대로 — 맞출지 사용자 결정.
- **보호 계정 = 순서만 마지막 (2026-10-08 19:30, "보호는 무슨 다 같이 쓰게 해 에이를 맨 마지막에 쓰면 되잖아")**: 전에는 보호 계정(A, Desktop 로그인)이 라우팅에서 반쯤 빠져 있었다 — 강제 전환의 대상이 되지 않고(현재 계정이 ≥95/쿨다운일 때만), 최소 주간 폴백에서 건너뛰고, Fable 여유가 보호 계정에만 있으면 거기로 가는 대신 Opus 강등. 지금은 **후보로 똑같이 쓰되 순서만 마지막**이다. `AccountRouter.ts`: `isSafe`(두 문턱 아래)·`isPreferred`(safe && !protected) 분리, `drainOrder` 가 **safe 먼저 → 그 안에서 보호 마지막 → 점수** 순(새 세션·캐시 식음·강제 전환 `roomy` 가 같은 순서를 보게 해 핑퐁 없음 — 리뷰에서 잡힘: 전엔 "안전한 A" 가 "문턱 초과 C" 뒤라 C→A→C 반복), `balanceOrder` 꼬리는 safe 보호 → 문턱 초과 순, `roomy` 의 `|| c.protected` 제거, `leastWeekly` 는 보호 포함(동률이면 보호 뒤), needFable 의 `onProtected`/'Fable 여유는 보호 계정뿐' 분기 삭제(`candidates.length === 0` 일 때만 Opus), 콜드 히스테리시스는 `isPreferred(cur)` 에만(보호 계정 위의 콜드 세션은 다른 안전 계정이 있으면 떠남), 로그 라벨 `(보호)` → `(마지막)`. 테스트 1662 통과(`AccountRouter.test.ts` 표 케이스·핑퐁 회귀·동률 추가, `TurnRunner.test.ts` 재시도 순서 b→a→c). README·ARCHITECTURE 는 당시 "ranks it last" 그대로 뒀다(위 10-09 변경에서 "동률일 때만 마지막" 으로 고침). **아직 안 한 것**: 서버 재시작(실행 중 pid 9267 은 이 세션의 부모라 턴 중 재시작 불가, launchd 는 고장이라 수동 relaunch), `offload` CLI 의 자체 보호 규칙(auto 는 보호 계정을 유일한 후보일 때만 고름)을 맞출지 결정.

- **파일 작업 카드 접기 (2026-10-06 17:00)**: 대화 안의 Edit/Write 카드가 diff 전체를 펼쳐 보여 화면을 차지했다. 이제 `DiffCard folded`(`<details>` + `<summary class="diff-head">`)로 경로·새 파일·+N −M 한 줄만 보이고 누르면 펼쳐진다. 승인 카드(PermissionCard)와 사이드 패널의 diff 는 그대로 펼쳐진 `<div>` 다. 모델 고정 수정(`868d028`)은 16:49 재시작으로 반영됐고(`new server healthy (pid 56716)`, 12개 세션 fable 전환 확인), 이 세션도 Fable 5.1 로 돈다. UI 만 바뀌어 `vite build` 뒤 새로고침으로 반영됐다(서버 재시작 없음). 공개 저장소 `junheony/quarterdeck` 에 `868d028`+`a44ae8b` 를 `df2ee08` 로 올렸다(17:25).
- **모델 고정 수정 (2026-10-06 16:40)**: Desktop 에서 가져온 세션은 기본 모델이 Opus 로 저장돼(`IMPORTED_DEFAULT_MODEL`) 피커가 늘 Opus 였고, 피커에서 고른 모델은 세션에 저장되지 않았다. 지금은 가져온 세션도 Fable 이 기본이다. 보낼 때 고른 모델이 세션의 기본값으로 저장되고, `turn_started.sessionModel` 로 다른 창·기기에 알린다. 이미 Opus 로 저장된 가져온 세션 12개(모두 첫 entrypoint `claude-desktop`)는 재시작 사이에 `/tmp/deck-migrate-fable.py` 로 fable 로 바꿨다(백업 `~/.config/deck/session-state.json.bak-*`). 재시작은 `RELAUNCH_PRESTART` 훅(마이그레이션 + `vite build`)을 붙인 `/tmp/deck-relaunch.sh`, 대체 빌드는 `/tmp/deck-fallback`(`470b11e`, dist 복사본). `deck.log` 의 `[migrate-fable …]`·`[relaunch …]` 줄로 결과를 본다. 공개 저장소에는 `df2ee08` 로 올라갔다.
- 참고: usage-deck 의 `claude:second`(B) 카드가 16:03 부터 `setup_needed`(cred_file 에 accessToken 없음)다. deck 은 마지막 값(Fable 31%)을 그대로 쓰니 라우팅은 동작하지만, 값이 갱신되지 않는다. 고치는 건 사용자 몫(B 프로필 로그인 상태 확인).
- **재시작 결과 확인 (이전 건)**: `/tmp/deck-relaunch.sh` 로 재시작했고 `new server healthy (pid 28053)` 으로 끝났다.
- **공개 저장소**: https://github.com/junheony/quarterdeck — 커밋 5개(`d676046` 첫 공개, `48f2e5b`·`237b54d` 테스트 파일 이름·타입 수정, `df2ee08` 10-06 갱신, `44b63a2` 10-09 보호 계정 동등 후보), CI 는 macOS·Linux 모두 통과(`237b54d`). 다음에 공개본을 갱신할 때: master 에 커밋 → `bash scripts/export-public.sh <빈 디렉터리>` → 그 디렉터리의 내용을 공개 저장소 클론에 덮어쓰고 커밋(저자 `hwangmc88 <hwangmc88@gmail.com>`) → `gh auth switch --user junheony` 로 푸시 후 원래 계정으로 되돌린다.
- 기기(iPad/폰)에서 백그라운드 복귀 뒤 답이 이어지는지 확인(따라잡기, `6ac9401`).
- 계정 C 를 뺄 때: 사용자가 날짜를 주면 `~/.config/deck/accounts.json` 을 만들어 `c` 를 `retired: true` 로(읽기 전용). 가장 최신 사본이 뺀 계정 프로필에 있는 세션은 재개가 거절되니, 그때 다른 계정으로 자동 이전하는 처리를 넣을지 정한다.
- 4번째 계정을 붙이려면 `claude-pick`·`offload`·usage-deck 쪽도 새 id(쿨다운 파일명·카드 id)를 받아야 한다 — 미착수.
- GPT 자동 라우팅 1/2 선택(사용자 결정 대기), launchd 자동 시작(전체 디스크 접근 권한은 사용자가 줘야 함).

## 0. 최신 상태 (2026-10-06 오후, master `89cd81c` + 이 문서, 단위 149파일 1653건 통과, 빌드 완료)

**들어간 것**
- **계정 모듈**: 계정 수가 고정 3개가 아니다. `<configDir>/accounts.json`(`{version:1, home, accounts:[{id,label,configDir,card,retired}]}`)이 있으면 그대로, 없으면 `~/.claude` → `a`, `~/.claude-<영문 한 글자>` 를 찾아 쓴다(지금 이 맥은 파일 없이 a·b·c, 이전과 같은 결과). 파일이 틀리면 시작을 거부한다. `retired: true` = 읽기 전용. 설정에서 뺀 계정은 스캔하지 않는다. 설계·구현 메모는 `docs/superpowers/specs/2026-10-06-accounts-module-and-public-refit.md`, 사용법은 README "Claude 계정 여러 개 쓰기".
- **사용량 색인 v2**: `usage-index-v2.json`(+`.seen`). v1 은 읽기만 하고 남겨 둔다(첫 시작 때 한 번 변환, 계정 자리 23개).
- **usageSource**: usage-deck 을 쓰는 설치는 엄격(`'deck'` — Fable 잔여량 모름이면 Opus), 아니면 느슨(`'none'`). 우선순위 `DECK_USAGE_STRICT` > `usage-source.json` > 대시보드 주소 명시(`DECK_URL`·`claude-pick/deck_url`) > 첫 조회 결과. 이 맥은 `deck_url` 이 있어 엄격이고 재시작 스크립트도 `DECK_USAGE_STRICT=1` 을 준다.
- **라우터**: 잔여량 모름 계정은 후순위 후보. 이유 문구와 실제 모델이 항상 일치한다("→ Opus" 면 Opus 로 실행). `reconcile` 뒤 뺀 계정을 다시 검사한다.
- **공개 정비**: MIT, README 영어/한국어, `docs/ARCHITECTURE.md`, CI, 위생 테스트(`src/hygiene.ts` — 개인 경로·호스트·키 모양), 픽스처 전부 합성값. 공개에서 빠지는 파일은 `.gitattributes` 의 `export-ignore`.
- **보안 보강**: KaTeX `maxSize: 20`(`maxExpand` 는 기본값 — 낮추면 정상 수식이 깨진다), CSP `form-action 'self'`·`object-src 'none'`, 서비스 워커는 `text/html` 응답만 `/` 로 캐시.
- **권한 기본값 변경**: 코드 기본이 "자동 승인"에서 "매번 묻기"(`DEFAULT_SETTINGS`)로 바뀌었다. 이 맥은 이전 동작을 유지하려고 `~/.config/deck/settings.json` 에 `bypassPermissions` 를 적어 두었다(설정 화면에서 바꾸면 이 파일이 갱신된다).

**달라진 동작 (알아 둘 것)**
- 엄격 모드에서 Fable 후보가 없고 usage-deck 카드가 `down`/설정 필요 상태면 이제 Opus 로 돈다(전에는 Fable). 의도한 보수적 변경.
- 새 세션에 쓸 수 없는(없는·뺀) 계정 핀을 붙이면 거절한다. 기존 세션의 쓸 수 없는 핀은 무시한다. 분기·인계는 부모의 핀을 조용히 무시한다.

**남긴 것 (전부 LOW)**
- **함정**: 같은 폴더에 대소문자만 다른 `x.test.ts` / `X.test.tsx` 를 두면 macOS 의 `tsc` 가 `.tsx` 쪽을 검사에서 뺀다(테스트는 돌지만 타입 검사는 안 됨). `Nav.test.tsx` 가 그랬고 `App.shortcuts.test.tsx` 로 바꿨다. 막는 검사는 아직 없다.
- 커밋할 때 지운 경로를 `git add` 에 같이 주면 전체가 실패한다 — 공개 푸시 전에 `git status` 가 비었는지 볼 것(이번에 수정분이 빠진 채 한 번 올라갔다).
- `ws.ts`: 핀이 없거나 쓸 수 있으면 모르는 `handoffFrom` 도 메타에 연결된다(이전부터). `fromKnown` 을 `linkHandoff` 쪽에도 쓰면 된다. `index.lookup` 에만 있는 세션의 인계 면제는 테스트가 없다.
- `ws.ts`: 기존 세션 `send` 의 `cwd` 는 검사하지 않는다(소유자 전용). CI 액션 SHA 고정 안 함. `hostnameOf` 가 `::1` 을 다루지 않는다. `deck_url` 응답 크기 제한 없음.
- e2e 테스트는 고쳤지만 돌리지 않았다(실계정 토큰 소모). `.bad` 파일은 자동으로 치우지 않는다. v1 색인이 디스크에 남는다.
- 화면: 사용량 카드 2줄 배치가 이전과 몇 px 다르다. 721–1100px 에서 카드 9개면 빡빡하다.
- 재시작하면 세션 cron(예: prediction-deepdive)은 사라진다 — 필요하면 다시 건다.

## 0-2. (이력) 2026-10-06 오전 (master c645217 + 미커밋 A·B, 빌드 완료)
무엇이 바뀌었나:
- **c645217**: 턴이 끝날 때마다 세션 목록 갱신(실행 중 세션은 15초 폴에서 빼고 턴 종료 때 한 번), UI 는 재연결·복귀·2분마다 목록 재요청 · 사이드바 행이 지금 상태(승인 대기/실행 중/백그라운드/새 응답/시각) · Claude 아이콘 SVG · 새 세션 기본 Fable(가져온 세션은 Opus), 기존 세션은 고르지 않으면 `model` 을 안 보냄 · 끊긴 턴은 오류 대신 "중단됨" · 감사 로그가 모든 도구 호출·거부를 기록(1번 남은 것 해결).
- **A(미커밋)**: 보호 계정 A 의 세션인데 A 가 쿨다운·한도면, Fable 여유가 A 에만 있어도 Opus 기준으로 다시 골라 B 로 넘김(`routing/AccountRouter.ts`). A 가 멀쩡하면 그대로 A.
- **B(미커밋)**: 서버 종료(`abortAll`)로 끊긴 턴은 숨겨지는 "중단됨" 대신 `서버가 다시 시작되어 중단됨` 오류로 보임(`SHUTDOWN_ABORT`, `turn/TurnRunner.ts`·`ws.ts`). 중지·지금 전송·재활용은 그대로 "중단됨".

재시작해야 반영되는 것: 위 전부의 서버 쪽(목록 갱신, `sessionModel`, 기본 모델, 라우팅, 감사 로그, 종료 표시). UI 는 빌드만으로 바뀐다. **서버는 아직 재시작하지 않았다.**

알아 둘 것:
- 업그레이드 전 기존 세션에서 고른 모델(sonnet·auto 등)은 첫 history 때 한 번 세션 기본값으로 돌아간다. 다시 고르면 유지.
- 옛 서버에 붙어 있는 동안 피커는 기록의 마지막 모델을 보여 주지만 실제로는 세션 기본 모델로 돈다. 재시작하면 사라진다.
- 감사 로그 `~/.config/deck/audit.log`(0600, 입력은 SHA-256 만). 5MiB 가 되면 `audit.log.1` 로 넘기고 이전 `.1` 은 덮는다. 넘기기 실패는 경고만 남기고 계속 쓴다.

## 0-1. 미커밋 (2026-10-06): 서버 기능 목록 · 끊긴 구간 따라잡기
- **기능 목록**: `hello.features`(`FEATURES`, `shared/protocol.ts`). UI 의 "옛 서버면" 분기 2곳(세션 모델 추정, "aborted by user")은 `ui/features.ts` 의 `has()` 만 본다. 규칙은 `docs/protocol.md`.
- **따라잡기**: 턴 이벤트에 `pos {sid, epoch, seq}`, 서버는 실행 중 프로세스의 최근 이벤트를 보관(`ws.ts` `emitTurn`·`catchUp`), UI 는 `ui/catchup.ts` 가 순서를 지키고 재연결·화면 복귀·번호 건너뜀 때 `open_session.after` 로 빠진 것만 받는다. 못 채우면 전체 history. TurnRunner 는 안 건드림.
- **서버 재시작 전에는 꺼져 있다**(옛 서버 = 기능 없음 = 이전 동작). 서버는 재시작하지 않았다.
- 남은 것: 전체 history 로 떨어지면 받던 중인 답의 앞부분은 기록 파일에 적힐 때까지 안 보인다(이전과 같음). `App.tsx` 의 연결(소켓 콜백·visibilitychange 리스너) 자체는 자동 테스트가 없다(로직은 `ui/catchup.test.ts`). 실시간 도구 출력은 크기 제한이 없다(history 는 8192자) — 맞추면 실시간 화면이 달라져서 손대지 않았다. 기기에서 확인 안 됨.

## 0-0. (이력) 2026-10-05 밤 (master 8de595c, 단위 133파일 통과, 빌드 완료)
10-05 에 들어간 것:
- **조용한 동기화**(2fb4801, 8de595c): Claude Desktop 등 deck 밖에서 이어진 세션을 15초 폴(`server/ws.ts`, `sessions/foreignWrites.ts`)로 따라감. "Desktop 열림" 알림·태그는 없앰(`ui/held.ts` 삭제, 서버의 `heldBy` 계산은 남음). 이어받느라 백그라운드 작업을 끊었을 때만 한 줄(`recycleNotice`). **실행 중인 서버는 10-05 13:50 기동이라 8de595c 의 서버 쪽(조용한 재활용)은 재시작 뒤에 적용된다.**
- **iPad 홈 화면 앱**: `viewport-fit=cover` 해제(`relaxViewport`), 포커스 때 상태바만큼 밀린 화면을 되돌리는 `pinShell()`(48pt 이하만 되돌림), `overscroll-behavior: none`. 진단 줄 `deck: diag`(pins·scroll·vv·app, 시각 없음). **기기 확인 안 됨** — 로그상 한 페이지에서 pins 가 80회대까지 올라 밀림이 계속 재발하고, scroll Y 66(48 초과)은 설계상 손대지 않는다.
- 고정 세션 ⌘1–⌘9 · Codex 스레드 이름·시각(62f8bbe) · 살아 있는 UI 빌드 확인과 아바타 메뉴 "새로고침" · 끼어든 메시지를 "빠짐" 대신 보류로(e103dab) · 사이드바 계정 글자 제거(d5b56c3) · iPad 작성창 캐럿(b919d86).

전체 요청 점검(10-05, 대화 기록 U1–U260 을 코드·커밋과 대조)에서 남은 것:
1. ~~**감사 로그가 거의 안 쌓임**~~ (10-06 c645217 에서 해결, 재시작 뒤 적용) — 프로필 `permissions.allow` 가 `canUseTool` 을 건너뛴다(`TurnRunner.ts:771-773`, `~/.config/deck/audit.log` 5일 63줄). PreToolUse 훅이나 `tool_call` 이벤트 기록으로 바꿔야 한다.
2. **모델 자동 라우팅 미완** — 자동 분류는 Claude 새 세션 첫 턴뿐(`routing/AutoModel.ts`), GPT 는 항상 Sol(`TurnRunner.ts:1068`), 스펙 §4.2 "어려움 → Astra" 없음. 사용자 선택 대기(1: Claude 전 계정이 한도 근처일 때 GPT / 2: 작업 종류로 분담).
3. **재부팅 자동 시작 없음** — launchd 미등록(nohup 실행). 사용자가 node 바이너리에 전체 디스크 접근 권한을 준 뒤 설치.
4. **deck → Desktop 화면 반영은 불가** — Desktop 이 다시 읽게 할 방법이 없고 `claude://resume` 로 여는 것뿐. home write-back 실패 로그 23건.
5. steer(작업 중 바로 전달): Codex·Gemini 는 턴이 끝난 뒤 전송. 중단 순간 이중 전달, 재로드 시 steer 첨부 표시 누락은 수정 여부 미확인.
6. 기기 확인 대기: iPad 띠·캐럿, Fold 7 배치, 폰 갤러리 선택기, iPad 자동 새로고침, 푸시, 권한·질문 카드, "Desktop에서 열기".
7. 최근 목록에서 세션 하나만 빼기 미구현 · Codex 하위 에이전트 스레드 약 1100개는 가져오지 않음(의도).
8. 아래 0-1 의 "다음 할 일" 1–4(Codex IPC, ⌘⇧O, 계정 C, 갈라진 사본)는 그대로 유효.

주의: deck 을 재시작하면 deck 안에서 돌던 세션의 프로세스와 세션 크론이 함께 사라진다. 다른 세션이 시간 맞춘 작업을 기다리는 동안에는 재시작하지 않는다.

## 0-1. (이력) 2026-10-04 오후 (단위 1281 통과, 워크트리 전부 정리됨)
이번 구간 병합(각각 리뷰 후 지적 수정 → 병합 → 전체 테스트·빌드):
- **pin-reorder**: 고정됨 순서 바꾸기 — 마우스 드래그(4px), 터치 길게 누르기(350ms), Alt+↑/↓. `PinStore` 위가 먼저 순서 저장, `POST /api/pins/order`, `ui/pinOrder.ts`. iPad 에서 사용자 확인 완료.
- **codex-import-all**: Codex 스레드 전부(보관함·나이 무관 exec 포함, 하위 에이전트 제외, 약 103개). 보관됨/폴더 없음은 읽기 전용(`cwdMissing`, `codexArchived`, Chat `readOnly`).
- **ipad-bottom-gap**: `.app{position:fixed;inset:0}`(iPadOS 26 PWA dvh 버그), 안전 영역 여백은 작성창·사이드바 아래로. 사용자 확인 완료.
- **desktop-parity 1차**: 자동 높이 작성창, 아무 키나 누르면 작성창으로(IME 안전), 탭 제목, 세션 ⋯ 메뉴, Esc 범위, 파일 끌어 놓기 전체 패널, 로딩 스켈레톤.
- **desktop-parity 2차**: 사이드바 아래 아바타 메뉴(설정/사용량/테마/단축키) + 떠 있는 "+ 새 세션", 가운데 제목·폴더 둘째 줄·오른쪽 위 ⋯(공유·파일 패널), 둥근 알약 작성창 컨트롤, 상태바 띠 색·theme-color, 넉넉한 사이드바 행(마우스는 메타를 hover 로).
- 작은 수정: 앱 전체 오류에도 로딩 스켈레톤이 풀림, 작성창 ResizeObserver 재측정은 다음 프레임.

다음 할 일:
1. **Codex IPC 로 ChatGPT 앱이 잡고 있는 스레드에 보내기** — 스파이크 결과(`~/.codex/ipc/ipc.sock`, 4바이트 LE 길이+JSON, `initialize` → `thread-owner-discovery` v1 → `thread-follower-start-turn` v2)는 확인, 실제 턴은 아직 안 보냄. 사용자가 ChatGPT 앱에 버려도 되는 테스트 스레드를 열어 주면 짧은 턴 1회 → 되면 CodexEngine 에 구현(버전 불일치 시 fork-on-send 로 대체). 스파이크 스크립트 /tmp/cgpt-spike/.
2. ⌘⇧O(Desktop 새 채팅) 바인딩 결정.
3. 계정 C 해지 예정(사용자가 직접) — 날짜 들으면 deck 설정에서 C 제거.
4. 알려진 틈: `(갈라진 사본)` 세션 2개(DWF QUANT 62adebb9, Crime Detector 950f92ec)는 사용자가 보관.

서버 재시작: `/tmp/deck-relaunch.sh`(USR2 → 드레인 → `tsx src/server/main.ts`, CLAUDE_CONFIG_DIR=~/.claude-b) 를 `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' nohup /tmp/deck-relaunch.sh &` 로. /tmp 라 재부팅 시 사라짐.

다음 할 일:
1. 알려진 틈: 다른 deck 상태 저장소의 Codex 스레드가 '자동 실행'으로 보일 수 있음 · `(갈라진 사본)` 세션 2개(DWF QUANT 62adebb9, Crime Detector 950f92ec)는 사용자가 보관.
2. 후보: deck 안에서 Astra 자동 자문(설계 먼저 제안).

## 1. (이력) 2026-10-01 시점

**Plan 2 완료·검증·병합(2026-10-01, `master`)** — 작업 14개 각각 리뷰 → 전 브랜치 최종 리뷰(Fable) 수정 → **독립 검증 통과**(verifier: 단위 337 · 실계정 E2E 12/12 재실행 · 실제 서버 + 헤드리스 브라우저로 UI 6항목 확인). 계획 `docs/superpowers/plans/2026-09-30-deck-plan2.md`, 진행 중 내린 판단 전부 `docs/superpowers/plans/2026-09-30-deck-plan2-rulings.md`.
Plan 2 로 들어간 것: GPT(ChatGPT Pro) 엔진 — 공식 `codex exec --json` 자식 프로세스, `gpt-6-sol`/`gpt-6-astra`, 샌드박스(읽기 전용 / 작업폴더 쓰기), 롤아웃 파일에서 기록·잔여량 · 엔진 선택(Claude/GPT/자동) · 분할보기 1–4 패널 · 첨부(이미지 → Claude image 블록·Codex `-i`, 그 밖은 경로) · 폰 레이아웃(서랍·단일 패널) · 역할 분배 표시 · AskUserQuestion 답 카드.
deck v1(Plan 1): Claude Max 3계정을 공식 Agent SDK + 구독 OAuth 로만 쓰는 로컬 웹 셸(턴마다 계정 판단, 잔여량 패널, 턴 뱃지, Desktop 세션 가져오기, 권한 카드).

- 스펙 `docs/superpowers/specs/2026-09-30-deck-design.md` · 계획 `docs/superpowers/plans/2026-09-30-deck-core.md`, `…-deck-plan2.md`
- 테스트: 단위 337 통과(경고 없음) · **실계정 E2E 12/12(2026-10-01, 독립 검증에서 재실행 통과)** — Claude 는 전부 **B**(a·c 는 E2E 자체 임시 쿨다운 폴더에서 쿨다운, D13), GPT 는 ChatGPT Pro 계정.
  - Claude B · `sonnet`: 새 세션 ok → 재개(B 유지·캐시 따뜻함) · "이 세션" 권한 3턴 · 1×1 빨강 PNG → "red"(D14 스트림 프롬프트로 image 블록 전달, 턴 정상 종료) · **5.88 MB 노이즈 PNG(1400×1400) → 수락, "Colorful random static noise…" 로 설명**(오류 없음, 축소 불필요) · 텍스트 첨부 경로 → Read 로 읽음 · AskUserQuestion 카드 → 답 `blue` 가 `updatedInput.answers` 로 돌아가 모델이 "blue" (D8).
  - GPT · codex-cli 0.159.2: `gpt-6-sol` 새 세션 ok(뱃지 `GPT 지정`, 목록에 뜨고 GPT 주간 % 가 롤아웃에서 채워짐) · 롤아웃 기록 + 재개(같은 스레드·엔진 유지, 턴마다 고른 GPT 모델이 적용 — 재개 턴에 `gpt-6-astra` 를 고르면 astra) · `gpt-6-astra` 새 세션 ok · 이미지 `-i` 새 세션 → "red", **재개(`exec resume … -i`)에서도** → "blue".

## 2. 살아있는 것 / 세션 한정
- **2026-10-01 UI 라운드 반영**(폴더 열기·고정됨·GPT 사용량 폴러·Desktop 풍 재디자인·GFM 표·NFC 경로 그룹·CSP script-src): 단위 405. 실계정 E2E 는 이번 라운드에 재실행 안 함(GPT 한도 소진). 산출 보고서는 `.superpowers/sdd/ui-round/`(gitignore).
- 지금 nohup 으로 떠 있음: `DECK_EXTRA_HOSTS=max-macbookpro.tail88e649.ts.net npm start`(로그 `~/.config/deck/deck.log`) — Tailnet `http://max-macbookpro.tail88e649.ts.net:9320`. 재부팅하면 내려감(launchd 미등록).
- `tailscale serve --bg --https=443 http://127.0.0.1:9320` 설정됨(PWA 용, tailnet 전용 — §6).
- 리눅스 옛 Fleet(`fleet-control.service`)은 2026-10-01 정지·비활성화(되살리기 `systemctl --user enable --now fleet-control`).
- 상시 서비스 없음. 사용자가 `npm start` 로 실행(127.0.0.1:9320 + Tailscale 주소만). 로그인 토큰 `~/.config/deck/token`(첫 실행 시 생성, 0600).
- 보호 계정 `~/.config/offload/protect` = `a`(Claude Desktop 이 A). 쿨다운은 claude-pick/offload 와 공유(`~/.cache/offload/cooldown`).

## 3. 미커밋 / 미푸시
- 미커밋 없음(10-06 오후). **이 저장소는 원격 없음 — 맥에만 있다**(백업 필요). 공개본 `junheony/quarterdeck` 은 이력 없는 단일 커밋이라 이 저장소의 백업이 아니다.

## 4. 다음에 할 일
1. **(사용자) A 계정 CLI 재로그인**: `env -u CLAUDE_CONFIG_DIR claude auth login` — A 의 CLI 토큰이 무효화(401)돼 deck 은 A 를 6h 쿨다운하고 B/C 로 돈다. Desktop 로그인과는 별개 저장소.
2. **(사용자) usage-deck 의 codex 카드 고치기** — 지금 `setup_needed` 라 GPT 열은 GPT 턴을 한 번 돌기 전까지 `—`.
3. 고정 프로젝트 `~/.config/deck/projects.json` 작성(형식은 `src/server/config.ts`·`SessionIndex`).
4. Plan 3 후보: 쓰기 가능한 offload · Codex Desktop/CLI 스레드 가져오기 · 패스키 로그인 · 남은 사소한 항목(판단 문서의 deferred 목록: 폰에서 리셋 남은 시간 숨김(터치로 못 봄), Codex 한도 오류문 실측 후 패턴 보강 등).

## 5. 주의사항
- **같은 세션을 Desktop 과 deck 에서 동시에 쓰지 말 것.** deck 은 대상이 따로 진행된 세션을 덮어쓰지 않고 이동을 거부(데이터 안전)하지만, 대화 자체는 두 갈래로 갈라진다. 프로젝트마다 한쪽만.
- `permission_request` 는 연결된 모든 기기로 간다(어느 기기에서나 승인 가능, 카드에 세션·cwd 표시). 다른 턴 이벤트는 그 세션을 연 소켓에만.
- "이 세션" 허용은 deck 세션 안에서만 유지 — 편집은 `acceptEdits` 모드로 이어지고, 규칙은 SDK `settings`(= CLI `--settings` 인자, 디스크에 안 씀)로 다음 턴에 전달. 프로젝트 설정 파일에 절대 쓰지 않는다(E2E 가 매번 검증).
- 헤드리스 CLI 에서 파일 편집 권한 제안은 `addRules` 가 아니라 `setMode acceptEdits` 로 온다 — 테스트 픽스처는 실측 형태를 쓸 것.
- **실한도 도달 시 SDK 반환은 아직 미실측**(리눅스 `claude-limit-probe` 포착 대기). `limitDetect.ts` 패턴은 errorKind → SDK 오류문만 본다(stderr·모델 답변 제외).
- 알려진 한계: 프로필 settings 의 allow 규칙(`Bash(ssh linux *)` 등)은 "매번 묻기"를 우회 · 재시도 턴은 같은 프롬프트가 기록에 두 번 · 1회 스트림 중 재접속은 `watch_turn` 으로 이어받음.
- **모델 선택은 턴마다**: 패널의 모델 선택기가 곧 그 턴의 모델(Claude·GPT 공통). 저장된 세션을 새 패널로 열면 선택기 기본값(Claude `opus`, GPT `gpt-6-sol`)으로 돈다 — astra/fable 로 이어가려면 다시 고른다.
- **모델 선택기(2026-10-01, `feat/model-picker`)**: Desktop 풍 팝오버 — 정확한 버전(Opus 5.5 = `claude-opus-5-5`, Sonnet 5.5 = `claude-sonnet-5-5`, Fable 5.1 = `claude-fable-5-1`; SDK `supportedModels()` 실측, `MODEL_ARG` 가 이제 별칭 대신 이 id 를 보냄) + 추론 수준 낮음/중간/높음/엑스트라 = `low|medium|high|xhigh`. 턴마다 `send.effort`(zod 허용목록) → Claude `Options.effort`(CLI `--effort`) / Codex `-c model_reasoning_effort="…"`(config.toml 의 `low` 를 덮음). 기본: Claude 높음, GPT 중간, 패널·엔진별로 따로 기억(새로고침 후에도 유지 — §6 ux-state). `max`/`ultra` 는 일부러 뺌. Codex effort 는 단위 테스트만(GPT 한도 소진으로 실측 못 함).
- **GPT 한계**: Codex Desktop/CLI 에서 따로 만든 스레드는 가져오지 않음(deck 이 만든 것만 목록) · Codex 승인 카드 없음 — 샌드박스만(`approval_policy=never`) · Codex 답은 토큰 스트리밍이 아니라 항목 단위 · **codex-cli ≥ 0.159 필요**(0.146 은 ChatGPT 계정에서 `gpt-6-sol` 거부; nvm 쪽 옛 바이너리는 자동으로 건너뜀) · GPT 잔여량은 서버 시작 시·60초마다 `~/.codex/sessions` 최신 롤아웃의 rate_limits(limit_id codex)에서 읽는다(usage-deck 카드 고장과 무관). 2026-10-01 기준 ChatGPT Pro 주간 100% 소진, 10/7 15:16 KST 리셋.
- **E2E 부산물**: GPT E2E 는 `~/.codex/sessions` 아래에 스레드(롤아웃)를 남긴다 — 기록으로 두고 지우지 않는다. 사용자 `~/.codex/config.toml` 의 oh-my-codex 알림 훅이 Codex 턴이 끝나고 몇 초 뒤(하네스가 폴더를 지운 뒤) cwd 에 `.omx/` 를 다시 만들어, GPT E2E 한 번마다 `$TMPDIR/deck-e2e-work-*/.omx/` 가 하나 남는다(무해, 수동 삭제). Claude 쪽은 E2E 임시 폴더 slug 의 프로젝트 폴더만 지운다.
- deck 은 `~/.codex/auth.json`·키체인을 읽지도 쓰지도 않는다(토큰 갱신은 CLI 만 — OpenAI 는 refresh token 재사용을 감지해 로그인을 끊는다).
- 환경: Node v26, `npm install` 은 optional deps 유지(Agent SDK 네이티브 claude 바이너리). Bash 도구는 zsh(따옴표 없는 변수 분리 안 됨), `timeout` 없음(perl alarm).

## 6. 2026-10-01 병합 5건 (`feat/lifecycle` → `ux-state` → `diff-sessions` → `pwa-push` → `automodel-gemini`)
단위 656 통과 · `npm run build` 통과. 기능 간 맞물림:
- 클라이언트 대기열은 패널이 idle(진행 턴 없음)일 때 보낸다. 백그라운드 대기 중에도 idle 이므로 대기열이 보내고, 서버는 그 send 를 열린 프로세스 입력에 써 넣으며 `clientRef` 를 turn_started 로 돌려줘 리듀서가 claim — 'sent' 가 awaitingStart 를 세우고 fired 집합이 재전송을 막아 이중 전송 없음.
- 푸시의 백그라운드 작업 완료는 턴 결과 뒤(대기 중) 끝난 작업도 포함 — TurnRunner 가 대기 중에도 `task_done` 을 내보낸다. 원래 턴·'백그라운드 계속' 턴의 결과 푸시는 각각 따로(태그 `turn-`/`task-`).
- 엔진 종류를 나열하는 곳(저장 UI 상태·효과 수준 맵·세션 엔진)에 `gemini` 포함. Gemini 세션은 기록 파일이 없어 검색에서 빠진다.

**UX 상태(`feat/ux-state`)**: localStorage `deck.ui.v1` 에 패널(세션·모델 — '자동' 포함·엔진별 effort·자동 모드 effort `autoEffort`·엔진·샌드박스)·접힌 그룹·서랍을 저장, 필드별 검증(깨진 값만 기본값). 할 일 패널(TodoWrite), 메시지 대기열(실행 중 ⌘/Ctrl+Enter 로 추가, 중지·실패 시 일시정지), 보낸 첨부 썸네일(`GET /api/attachments/:id`, `deck.sent.v1`)·라이트박스.

**Diff·세션(`feat/diff-sessions`)**: 편집 도구 호출을 diff 카드로 · 세션 이름 바꾸기/보관(`~/.config/deck/session-meta.json`) · `/api/search`(기록 전문 검색) · `/api/files`·`/api/commands` 로 입력창 `@` 파일·`/` 명령 자동완성.

**PWA·웹 푸시(`feat/pwa-push`)**: 끄기 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off`(재부팅 후에도 유지, funnel 아님). 폰은 **https://max-macbookpro.tail88e649.ts.net/** 로 열고 홈 화면에 추가(iOS 16.4+) → 상단 `알림` 에서 켬. deck 은 MagicDNS 이름을 자동으로 Host 허용목록에 넣고 https Origin 을 받으며, `X-Forwarded-Proto: https` 면 쿠키에 Secure. VAPID 키 `~/.config/deck/vapid.json`, 구독 `push-subscriptions.json`(둘 다 0600). 아이콘·알림 배지는 `node scripts/gen-icons.mjs`(원본 `scripts/assets/deck-icon-1024.png`). 푸시는 턴 완료·권한/질문 카드·백그라운드 작업 완료 — deck 창에 포커스가 있으면 SW 가 띄우지 않음(iOS 는 항상 띄움).

**자동 모델·Gemini(`feat/automodel-gemini`)**: 모델 선택기의 '자동' = 새 Claude 세션 첫 턴에 분류기가 모델·effort 를 고름(`AutoModel.ts`, `AUTO_EFFORT`); 자동일 때 고른 effort 는 `autoEffort` 로 따로 기억. Gemini 엔진은 명시 선택만(자동 라우팅 대상 아님), 계정 g1/g2, 로그인 절차 `docs/gemini-spike.md`, 바이너리 `DECK_GEMINI_BIN`. 상태는 hello 의 geminiStatus.

**서버 수명주기(`feat/lifecycle`)**:
- **백그라운드 서브에이전트가 턴 뒤에도 산다.** 턴은 이제 전부 SDK streaming-input(입력 `AsyncIterable`)으로 돈다. 단발 문자열 prompt 는 결과 직후 프로세스가 끝나 백그라운드 작업이 함께 죽었다(sdk.d.ts `SDKResultMessage`). 결과 뒤에 `system/background_tasks_changed`(없으면 `task_started`/`task_notification`)로 본 작업이 남아 있으면 입력을 열어 둔다. 작업이 끝나 CLI 가 스스로 이어 가는 턴은 같은 패널에 **'백그라운드 계속'** 세그먼트(turnId `<원래>:bgN`, 자체 뱃지)로 뜬다. 대기 중에는 "백그라운드 작업 N개 진행 중" + 중지(= interrupt, 프로세스와 작업 전부 종료).
- 대기 중 같은 세션으로 보낸 메시지는 **같은 프로세스 입력에 다음 사용자 턴으로 써 넣는다**(SDK 의 multi-turn streaming input; 계정·모델은 그 프로세스 그대로, 다르면 뱃지에 표시). '백그라운드 계속'이 흐르는 중이면 그 결과 뒤로 줄 세운다. 본 턴이 아직 스트리밍 중이면 예전처럼 "이미 실행 중".
- 상한: 턴 뒤 대기 최대 `DECK_BG_MAX_MIN`(기본 120분), 작업 집합이 빈 뒤 60초 동안 이어지는 턴이 없으면 정리.
- **우아한 재시작**: `npm run restart`(9320 리스너에 SIGUSR2; `-- --wait` 면 새 서버가 뜰 때까지 대기). SIGTERM 도 같다(launchd stop·`kickstart -k`). 새 send 거절 → 진행 중 턴·백그라운드 대기를 최대 `DECK_DRAIN_MAX_MIN`(기본 15분) 기다림 → 남은 것 중단 → 종료. 신호를 한 번 더 보내거나 Ctrl-C(SIGINT)면 즉시.
- **launchd**: 메인 체크아웃에서 `npm run build && scripts/install-launchd.sh`. `~/Library/LaunchAgents/com.deck.server.plist`(KeepAlive·RunAtLoad, PATH = 지금 `which node` 의 폴더 + `~/.local/bin`(codex) + 시스템 경로, 로그 `~/.config/deck/deck.log`, ExitTimeOut = 드레인 + 60초). 환경은 `~/.config/deck/env`(KEY=value; 없으면 현재 셸의 `DECK_EXTRA_HOSTS` 로 생성) — `scripts/launchd/run.sh` 가 시작마다 읽는다. 설치 스크립트는 9320 에 떠 있는 수동 서버를 SIGTERM 으로 내리고(드레인을 기다림; 이 변경 전 버전 서버는 즉시 끊김) 로드한다. 제거 `scripts/install-launchd.sh --uninstall`, 상태 `launchctl print gui/$(id -u)/com.deck.server`. env 를 고친 뒤엔 `npm run restart`.
