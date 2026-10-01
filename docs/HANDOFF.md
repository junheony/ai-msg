# HANDOFF — deck (갱신 2026-10-01)

> 형식은 agentic-harness 의 `session-handoff` 스킬. 이 파일을 고쳐 쓴다(날짜별 새 파일 금지). 비공개 저장소(원격 없음).

## 1. 지금 무슨 작업 중인가

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
- **PWA·웹 푸시(2026-10-01, `feat/pwa-push`)**: `tailscale serve --bg --https=443 http://127.0.0.1:9320` 설정됨(tailnet 전용, funnel 아님, 재부팅 후에도 유지 · 끄기 `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=443 off`). 폰은 **https://max-macbookpro.tail88e649.ts.net/** 로 열고 홈 화면에 추가(iOS 16.4+) → 상단 `알림` 에서 켬. deck 은 MagicDNS 이름을 자동으로 Host 허용목록에 넣고 https Origin 을 받으며, `X-Forwarded-Proto: https` 면 쿠키에 Secure. VAPID 키 `~/.config/deck/vapid.json`, 구독 `push-subscriptions.json`(둘 다 0600). 아이콘은 `node scripts/gen-icons.mjs` 로 다시 만든다. 푸시는 턴 완료·권한/질문 카드·백그라운드 작업 완료(턴 도중 settled 된 것만) — deck 창에 포커스가 있으면 SW 가 띄우지 않음(iOS 는 항상 띄움).
- 리눅스 옛 Fleet(`fleet-control.service`)은 2026-10-01 정지·비활성화(되살리기 `systemctl --user enable --now fleet-control`).
- 상시 서비스 없음. 사용자가 `npm start` 로 실행(127.0.0.1:9320 + Tailscale 주소만). 로그인 토큰 `~/.config/deck/token`(첫 실행 시 생성, 0600).
- 보호 계정 `~/.config/offload/protect` = `a`(Claude Desktop 이 A). 쿨다운은 claude-pick/offload 와 공유(`~/.cache/offload/cooldown`).

## 3. 미커밋 / 미푸시
- 작업트리 깨끗. **원격 없음 — 맥에만 있다**(백업 필요).

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
- **모델 선택기(2026-10-01, `feat/model-picker`)**: Desktop 풍 팝오버 — 정확한 버전(Opus 5.5 = `claude-opus-5-5`, Sonnet 5.5 = `claude-sonnet-5-5`, Fable 5.1 = `claude-fable-5-1`; SDK `supportedModels()` 실측, `MODEL_ARG` 가 이제 별칭 대신 이 id 를 보냄) + 추론 수준 낮음/중간/높음/엑스트라 = `low|medium|high|xhigh`. 턴마다 `send.effort`(zod 허용목록) → Claude `Options.effort`(CLI `--effort`) / Codex `-c model_reasoning_effort="…"`(config.toml 의 `low` 를 덮음). 기본: Claude 높음, GPT 중간, 패널·엔진별로 따로 기억(새로고침 시 초기화). `max`/`ultra` 는 일부러 뺌. Codex effort 는 단위 테스트만(GPT 한도 소진으로 실측 못 함).
- **GPT 한계**: Codex Desktop/CLI 에서 따로 만든 스레드는 가져오지 않음(deck 이 만든 것만 목록) · Codex 승인 카드 없음 — 샌드박스만(`approval_policy=never`) · Codex 답은 토큰 스트리밍이 아니라 항목 단위 · **codex-cli ≥ 0.159 필요**(0.146 은 ChatGPT 계정에서 `gpt-6-sol` 거부; nvm 쪽 옛 바이너리는 자동으로 건너뜀) · GPT 잔여량은 서버 시작 시·60초마다 `~/.codex/sessions` 최신 롤아웃의 rate_limits(limit_id codex)에서 읽는다(usage-deck 카드 고장과 무관). 2026-10-01 기준 ChatGPT Pro 주간 100% 소진, 10/7 15:16 KST 리셋.
- **E2E 부산물**: GPT E2E 는 `~/.codex/sessions` 아래에 스레드(롤아웃)를 남긴다 — 기록으로 두고 지우지 않는다. 사용자 `~/.codex/config.toml` 의 oh-my-codex 알림 훅이 Codex 턴이 끝나고 몇 초 뒤(하네스가 폴더를 지운 뒤) cwd 에 `.omx/` 를 다시 만들어, GPT E2E 한 번마다 `$TMPDIR/deck-e2e-work-*/.omx/` 가 하나 남는다(무해, 수동 삭제). Claude 쪽은 E2E 임시 폴더 slug 의 프로젝트 폴더만 지운다.
- deck 은 `~/.codex/auth.json`·키체인을 읽지도 쓰지도 않는다(토큰 갱신은 CLI 만 — OpenAI 는 refresh token 재사용을 감지해 로그인을 끊는다).
- 환경: Node v26, `npm install` 은 optional deps 유지(Agent SDK 네이티브 claude 바이너리). Bash 도구는 zsh(따옴표 없는 변수 분리 안 됨), `timeout` 없음(perl alarm).

## 6. 서버 수명주기 (2026-10-01, `feat/lifecycle`)
- **백그라운드 서브에이전트가 턴 뒤에도 산다.** 턴은 이제 전부 SDK streaming-input(입력 `AsyncIterable`)으로 돈다. 단발 문자열 prompt 는 결과 직후 프로세스가 끝나 백그라운드 작업이 함께 죽었다(sdk.d.ts `SDKResultMessage`). 결과 뒤에 `system/background_tasks_changed`(없으면 `task_started`/`task_notification`)로 본 작업이 남아 있으면 입력을 열어 둔다. 작업이 끝나 CLI 가 스스로 이어 가는 턴은 같은 패널에 **'백그라운드 계속'** 세그먼트(turnId `<원래>:bgN`, 자체 뱃지)로 뜬다. 대기 중에는 "백그라운드 작업 N개 진행 중" + 중지(= interrupt, 프로세스와 작업 전부 종료).
- 대기 중 같은 세션으로 보낸 메시지는 **같은 프로세스 입력에 다음 사용자 턴으로 써 넣는다**(SDK 의 multi-turn streaming input; 계정·모델은 그 프로세스 그대로, 다르면 뱃지에 표시). '백그라운드 계속'이 흐르는 중이면 그 결과 뒤로 줄 세운다. 본 턴이 아직 스트리밍 중이면 예전처럼 "이미 실행 중".
- 상한: 턴 뒤 대기 최대 `DECK_BG_MAX_MIN`(기본 120분), 작업 집합이 빈 뒤 60초 동안 이어지는 턴이 없으면 정리.
- **우아한 재시작**: `npm run restart`(9320 리스너에 SIGUSR2; `-- --wait` 면 새 서버가 뜰 때까지 대기). SIGTERM 도 같다(launchd stop·`kickstart -k`). 새 send 거절 → 진행 중 턴·백그라운드 대기를 최대 `DECK_DRAIN_MAX_MIN`(기본 15분) 기다림 → 남은 것 중단 → 종료. 신호를 한 번 더 보내거나 Ctrl-C(SIGINT)면 즉시.
- **launchd**: 메인 체크아웃에서 `npm run build && scripts/install-launchd.sh`. `~/Library/LaunchAgents/com.deck.server.plist`(KeepAlive·RunAtLoad, PATH = 지금 `which node` 의 폴더 + `~/.local/bin`(codex) + 시스템 경로, 로그 `~/.config/deck/deck.log`, ExitTimeOut = 드레인 + 60초). 환경은 `~/.config/deck/env`(KEY=value; 없으면 현재 셸의 `DECK_EXTRA_HOSTS` 로 생성) — `scripts/launchd/run.sh` 가 시작마다 읽는다. 설치 스크립트는 9320 에 떠 있는 수동 서버를 SIGTERM 으로 내리고(드레인을 기다림; 이 변경 전 버전 서버는 즉시 끊김) 로드한다. 제거 `scripts/install-launchd.sh --uninstall`, 상태 `launchctl print gui/$(id -u)/com.deck.server`. env 를 고친 뒤엔 `npm run restart`.
