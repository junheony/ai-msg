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
- **GPT 한계**: Codex Desktop/CLI 에서 따로 만든 스레드는 가져오지 않음(deck 이 만든 것만 목록) · Codex 승인 카드 없음 — 샌드박스만(`approval_policy=never`) · Codex 답은 토큰 스트리밍이 아니라 항목 단위 · **codex-cli ≥ 0.159 필요**(0.146 은 ChatGPT 계정에서 `gpt-6-sol` 거부; nvm 쪽 옛 바이너리는 자동으로 건너뜀) · usage-deck codex 카드가 `setup_needed` 인 동안 GPT 열은 `—`(GPT 턴 뒤 롤아웃 rate_limits 로 채워짐).
- **E2E 부산물**: GPT E2E 는 `~/.codex/sessions` 아래에 스레드(롤아웃)를 남긴다 — 기록으로 두고 지우지 않는다. 사용자 `~/.codex/config.toml` 의 oh-my-codex 알림 훅이 Codex 턴이 끝나고 몇 초 뒤(하네스가 폴더를 지운 뒤) cwd 에 `.omx/` 를 다시 만들어, GPT E2E 한 번마다 `$TMPDIR/deck-e2e-work-*/.omx/` 가 하나 남는다(무해, 수동 삭제). Claude 쪽은 E2E 임시 폴더 slug 의 프로젝트 폴더만 지운다.
- deck 은 `~/.codex/auth.json`·키체인을 읽지도 쓰지도 않는다(토큰 갱신은 CLI 만 — OpenAI 는 refresh token 재사용을 감지해 로그인을 끊는다).
- 환경: Node v26, `npm install` 은 optional deps 유지(Agent SDK 네이티브 claude 바이너리). Bash 도구는 zsh(따옴표 없는 변수 분리 안 됨), `timeout` 없음(perl alarm).
