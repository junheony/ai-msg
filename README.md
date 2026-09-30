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
`DECK_EXTRA_HOSTS`(콤마 목록, Tailscale MagicDNS 이름 등 — Host 허용 목록에 추가. 보안 검토 I5 항목: deck 이 바인드하는 loopback/CGNAT 주소는 자동으로 허용 목록에 들어간다)

## 보안 메모 (검토 I5, Task 13에서 추가)

- `SameSite=Strict` 쿠키는 포트를 구분하지 않으므로, 로그인/로그아웃과 `/api/*` 아래의 모든 state-changing 요청(POST/PUT/DELETE)은 `Origin` 이 deck 자신의 origin(포트 포함)이거나 허용된 dev origin 과 정확히 일치해야 하며, `Sec-Fetch-Site: same-origin` 도 증거로 인정한다. Origin 이 없으면 거부.
- DNS 리바인딩 방어로 Host 허용 목록을 HTTP·WS 양쪽에 적용한다: `127.0.0.1`, `localhost`, deck 이 바인드한 Tailscale(CGNAT) 주소, `DECK_EXTRA_HOSTS`. 그 외 Host 는 421 로 거부된다.

## 파일

`~/.config/deck/token`(0600) · `projects.json` · `session-state.json`(세션별 현재 계정·마지막 턴) · `audit.log`(권한 결정, 입력은 해시만)
