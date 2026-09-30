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
npm run test:e2e    # 실제 계정으로 한 턴 (토큰 약간 소모)
```

## 환경변수

`DECK_PORT`(9320) · `DECK_CONFIG_DIR`(~/.config/deck) · `DECK_URL`(usage-deck) · `CLAUDE_PROTECT`(a|b|c, 기본은 ~/.config/offload/protect) ·
`CLAUDE_PICK_COOLDOWN_DIR`(claude-pick 과 공유) · `DECK_LOOPBACK_ONLY=1` · `DECK_DEV_ORIGIN` · `DECK_UI_DIR` ·
`DECK_EXTRA_HOSTS`(콤마 목록, Tailscale MagicDNS 이름 등 — Host 허용 목록에 추가. deck 이 바인드하는 주소는 자동으로 허용 목록에 들어간다)

## 보안 메모 (검토 I5, Task 13에서 추가)

- `SameSite=Strict` 쿠키는 포트를 구분하지 않으므로, 로그인/로그아웃과 `/api/*` 아래의 모든 state-changing 요청(POST/PUT/DELETE)은 `Origin` 이 deck 자신의 origin(포트 포함)이거나 허용된 dev origin 과 정확히 일치해야 하며, `Sec-Fetch-Site: same-origin` 도 증거로 인정한다. Origin 이 없으면 거부.
- DNS 리바인딩 방어로 Host 허용 목록을 HTTP·WS 양쪽에 적용한다: `127.0.0.1`, `localhost`, `::1`, deck 이 실제로 바인드한 주소, `DECK_EXTRA_HOSTS`. 그 외 Host(바인드하지 않은 100.64/10 주소 포함)는 421 로 거부된다.
- 모든 HTTP 응답에 CSP(`default-src 'self'` 등)·`nosniff`·`no-referrer` 를 붙이고, 모델 출력의 마크다운 이미지는 `<img>` 대신 링크로 그린다(원격 URL 자동 로드 방지).
- WS 프레임은 1 MiB 까지. 잘못된 프레임은 그 소켓만 끊는다.
- 한 세션에는 한 번에 한 턴만 돈다(두 탭·폰+맥). 턴 이벤트는 그 턴을 시작한 소켓과 그 세션을 연 소켓에만 간다. 권한 요청 카드는 모든 탭에 뜨며 세션·cwd 를 표시한다.
- 권한 "이 세션" 은 SDK 가 제안한 범위 규칙(예: `Bash(git status)`)만 저장해 같은 deck 세션의 다음 턴에 `settings.permissions.allow` 로 다시 넘긴다. SDK 가 제안이 없거나 `suppressAlwaysAllowRule` 을 켜면 버튼이 숨겨진다. 답하지 않은 권한 요청은 턴이 끝나거나 중단되면, 또는 30분 뒤 거부로 닫힌다.

## 알려진 제한

- `AskUserQuestion` 도구에 답하는 UI 가 없다(Phase 2, 검토 M13). 지금은 일반 권한 카드로만 뜬다.
- 설정 파일(`settings.json`)의 allow 규칙은 CLI 가 그대로 적용하며, deck UI 는 그 목록을 보여주거나 편집하지 않는다(정보용, 검토 M14).
- 새 세션 턴이 도는 중에 연결이 끊겼다 다시 붙으면, 그 턴의 남은 스트리밍은 결과(`turn_result`)가 색인 갱신 뒤 세션을 열 때 기록으로만 보인다.

## 파일

`~/.config/deck/token`(0600) · `projects.json` · `session-state.json`(세션별 현재 계정·마지막 턴) · `audit.log`(권한 결정, 입력은 해시만)
