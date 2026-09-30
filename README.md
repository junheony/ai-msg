# deck

계정 자동 분배 Claude 셸 — 설계: `docs/superpowers/specs/2026-09-30-deck-design.md`, 구현 계획: `docs/superpowers/plans/2026-09-30-deck-core.md`.

## 준비

- Node ≥ 24 (`nvm use`), Claude Max 계정 3개가 `~/.claude`, `~/.claude-b`, `~/.claude-c` 에 로그인돼 있을 것.
  계정 a 는 `CLAUDE_CONFIG_DIR` 없이 `claude auth login`. 토큰이 취소됐다는 401 이 나오면 다시 로그인.
- usage-deck 이 떠 있고 `~/.config/claude-pick/deck_url` 에 주소가 있을 것.
- 고정 프로젝트: `~/.config/deck/projects.json` — `[{"cwd":"/Users/max/Documents/개발/agentic-harness","name":"harness"}, ...]`

## 실행

```bash
npm install          # optional deps 포함 (Claude Code 네이티브 바이너리)
npm run build        # UI → dist/ui
npm start            # 127.0.0.1:9320 + Tailscale 주소:9320
```

브라우저에서 `http://127.0.0.1:9320` (폰은 Tailscale 주소) → `~/.config/deck/token` 내용으로 로그인.

## 개발

```bash
DECK_DEV_ORIGIN=http://localhost:5173 npm run dev:server   # tsx watch
npm run dev:ui                                             # vite, /api·/ws 프록시
npm test            # 단위 테스트
npm run test:e2e    # 실제 계정(Claude B + GPT)으로 짧은 턴 몇 개 (토큰 약간 소모)
```

## 환경변수

`DECK_PORT`(9320) · `DECK_CONFIG_DIR`(~/.config/deck) · `DECK_URL`(usage-deck) · `CLAUDE_PROTECT`(a|b|c, 기본은 ~/.config/offload/protect) ·
`CLAUDE_PICK_COOLDOWN_DIR`(claude-pick 과 공유) · `DECK_LOOPBACK_ONLY=1` · `DECK_DEV_ORIGIN` · `DECK_UI_DIR` ·
`DECK_EXTRA_HOSTS`(콤마 목록, Tailscale MagicDNS 이름 등 — Host 허용 목록에 추가. deck 이 바인드하는 주소는 자동으로 허용 목록에 들어간다) ·
`DECK_CODEX_BIN`(codex 바이너리 경로; 없으면 PATH → `~/.local/bin/codex` → `~/.nvm/versions/node/*/bin/codex`, 0.159 미만은 건너뜀) · `CODEX_HOME`(Codex 의 홈; 롤아웃 위치 `$CODEX_HOME/sessions`)

## 보안 메모 (검토 I5, Task 13에서 추가)

- `SameSite=Strict` 쿠키는 포트를 구분하지 않으므로, 로그인/로그아웃과 `/api/*` 아래의 모든 state-changing 요청(POST/PUT/DELETE)은 `Origin` 이 deck 자신의 origin(포트 포함)이거나 허용된 dev origin 과 정확히 일치해야 하며, `Sec-Fetch-Site: same-origin` 도 증거로 인정한다. Origin 이 없으면 거부.
- DNS 리바인딩 방어로 Host 허용 목록을 HTTP·WS 양쪽에 적용한다: `127.0.0.1`, `localhost`, `::1`, deck 이 실제로 바인드한 주소, `DECK_EXTRA_HOSTS`. 그 외 Host(바인드하지 않은 100.64/10 주소 포함)는 421 로 거부된다.
- 모든 HTTP 응답에 CSP(`default-src 'self'` 등)·`nosniff`·`no-referrer` 를 붙이고, 모델 출력의 마크다운 이미지는 `<img>` 대신 링크로 그린다(원격 URL 자동 로드 방지).
- WS 프레임은 1 MiB 까지. 잘못된 프레임은 그 소켓만 끊는다.
- 한 세션에는 한 번에 한 턴만 돈다(두 탭·폰+맥). 턴 이벤트는 그 턴을 시작한 소켓과 그 세션을 연 소켓에만 간다. 권한 요청 카드는 모든 탭에 뜨며 세션·cwd 를 표시한다.
- 권한 "이 세션" 은 SDK 가 제안한 범위 규칙(예: `Bash(git status)`)만 저장해 같은 deck 세션의 다음 턴에 `settings.permissions.allow` 로 다시 넘긴다. SDK 가 제안이 없거나 `suppressAlwaysAllowRule` 을 켜면 버튼이 숨겨진다. 답하지 않은 권한 요청은 턴이 끝나거나 중단되면, 또는 30분 뒤 거부로 닫힌다.

## 알려진 제한

- 설정 파일(`settings.json`)의 allow 규칙은 CLI 가 그대로 적용하며, deck UI 는 그 목록을 보여주거나 편집하지 않는다(정보용, 검토 M14).
- 턴 도중 재연결하면 그 뒤의 스트리밍만 이어서 보인다. 끊긴 동안 온 델타는 세션을 다시 열어 기록으로 확인한다.
- GPT 세션: 승인 카드 없음(샌드박스만) · 답이 토큰 단위로 흐르지 않고 항목 단위로 온다 · Codex Desktop/CLI 에서 따로 만든 스레드는 목록에 뜨지 않는다.

## GPT(ChatGPT Pro) 세션

- 세션을 새로 열 때 엔진을 고른다: Claude / GPT / 자동(여유 있는 쪽). 세션이 생기면 엔진은 바뀌지 않는다.
- GPT 는 공식 `codex` CLI(`codex exec --json`)를 자식 프로세스로 띄운다. deck 은 `~/.codex/auth.json` 이나 키체인을 절대 읽지 않는다 — 로그인은 `codex login` 으로만.
- 모델: `gpt-6-sol`(기본) · `gpt-6-astra`(어려운 작업). **codex-cli 0.159 이상 필요** — 0.146 은 ChatGPT 계정에서 `gpt-6-sol` 을 거부당한다(`npm i -g @openai/codex`).
- `DECK_CODEX_BIN` 으로 지정한 바이너리는 0.159 버전 검사를 건너뛴다(명시적 지정이므로 그대로 쓴다).
- 승인 카드가 없다. 대신 샌드박스: 기본 **읽기 전용**, 세션 생성 시 **작업폴더 쓰기(네트워크 차단)** 선택 가능. `approval_policy=never` 로 실행되므로 샌드박스 밖 작업은 그냥 실패한다.
- GPT 잔여량은 usage-deck `codex` 카드 + 턴마다 Codex 롤아웃의 rate_limits 로 보정. 카드가 `setup_needed` 면 `—` 로 표시.
- 히스토리는 `~/.codex/sessions/…/rollout-…-<thread>.jsonl` 에서 읽는다(deck 이 만든 세션만 목록에 뜬다).

## 첨부 · 분할보기 · 폰

- 이미지 붙여넣기/끌어놓기 → Claude 에는 image 블록, GPT 에는 `-i` 로 전달. 다른 파일은 절대 경로로 프롬프트에 적힌다.
- 첨부 파일은 `~/.config/deck/attachments/`(0700) 에 파일당 ≤ 10 MiB, 한 번에 ≤ 8개, 7일 지나면 삭제.
- `+ 분할` 로 2~4 패널. 패널마다 독립 세션(한 WebSocket).
- 폭 720px 이하: 사이드바는 ☰ 서랍, 패널 하나(상단 숫자로 전환), 버튼 44px.
- AskUserQuestion 은 카드로 뜨고 답이 모델로 돌아간다(30분 무응답 시 거부).

## 파일

`~/.config/deck/token`(0600) · `projects.json` · `session-state.json`(세션별 현재 계정·마지막 턴) · `audit.log`(권한 결정, 입력은 해시만)
