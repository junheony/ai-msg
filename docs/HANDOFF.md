# HANDOFF — deck (갱신 2026-09-30)

> 형식은 agentic-harness 의 `session-handoff` 스킬. 이 파일을 고쳐 쓴다(날짜별 새 파일 금지). 비공개 저장소(원격 없음).

## 1. 지금 무슨 작업 중인가
**deck v1(Plan 1) 완료.** Claude Max 3계정을 공식 Agent SDK + 구독 OAuth 로만 쓰는 로컬 웹 셸. 매 턴 계정을 판단하고 캐시 비용을 따져 이득일 때만 전환(스펙 §4.1), 계정별 잔여량 패널, 턴 뱃지(계정·모델·이유), 기존 Desktop 세션 가져오기, 권한 승인 카드. 다음은 **Plan 2**: 분할보기 · 첨부 · 폰 레이아웃 · CodexEngine(gpt-6-sol/astra) · 역할 분배 표시 · AskUserQuestion 응답 UI.

- 스펙 `docs/superpowers/specs/2026-09-30-deck-design.md` · 계획 `docs/superpowers/plans/2026-09-30-deck-core.md`
- 품질 이력: 작업 1~9 리뷰(치명 1·중요 4) → 수정 · 작업 10~15 리뷰(중요 8) → 수정 · 독립 실계정 검증에서 "이 세션" 권한이 실 CLI 에서 안 이어지고 Bash 는 `settings.local.json` 에 영구 규칙을 쓰는 버그 발견 → 수정(`74d1235`) · open_session 경합 플레이크 수정(`1c1f819`). 단위 212 통과, 실계정 E2E 3/3(B 계정).

## 2. 살아있는 것 / 세션 한정
- 상시 서비스 없음. 사용자가 `npm start` 로 실행(127.0.0.1:9320 + Tailscale 주소만). 로그인 토큰 `~/.config/deck/token`(첫 실행 시 생성, 0600).
- 보호 계정 `~/.config/offload/protect` = `a`(Claude Desktop 이 A). 쿨다운은 claude-pick/offload 와 공유(`~/.cache/offload/cooldown`).

## 3. 미커밋 / 미푸시
- 작업트리 깨끗. **원격 없음 — 맥에만 있다**(백업 필요).

## 4. 다음에 할 일
1. **(사용자) A 계정 CLI 재로그인**: `env -u CLAUDE_CONFIG_DIR claude auth login` — A 의 CLI 토큰이 무효화(401)돼 있어 지금 deck 은 A 를 인증 실패로 6h 쿨다운하고 B/C 로 돈다. Desktop 로그인과는 별개 저장소.
2. 고정 프로젝트 `~/.config/deck/projects.json` 작성(형식은 `src/server/config.ts`·`SessionIndex`). Desktop 고정 세션들의 cwd 는 대부분 `~/Documents/개발` 하나라 cwd 기준 묶음이 한 덩어리가 된다 — 프로젝트별 하위 폴더로 나눌지 결정.
3. Plan 2 — `writing-plans` 로 작성 후 같은 방식(묶음별 구현 + 리뷰 + 독립 실계정 검증).

## 5. 주의사항
- **같은 세션을 Desktop 과 deck 에서 동시에 쓰지 말 것.** deck 은 대상이 따로 진행된 세션을 덮어쓰지 않고 이동을 거부(데이터 안전)하지만, 대화 자체는 두 갈래로 갈라진다. 프로젝트마다 한쪽만.
- `permission_request` 는 연결된 모든 기기로 간다(어느 기기에서나 승인 가능, 카드에 세션·cwd 표시). 다른 턴 이벤트는 그 세션을 연 소켓에만.
- "이 세션" 허용은 deck 세션 안에서만 유지 — 편집은 `acceptEdits` 모드로 이어지고, 규칙은 SDK `settings`(= CLI `--settings` 인자, 디스크에 안 씀)로 다음 턴에 전달. 프로젝트 설정 파일에 절대 쓰지 않는다(E2E 가 매번 검증).
- 헤드리스 CLI 에서 파일 편집 권한 제안은 `addRules` 가 아니라 `setMode acceptEdits` 로 온다 — 테스트 픽스처는 실측 형태를 쓸 것.
- **실한도 도달 시 SDK 반환은 아직 미실측**(리눅스 `claude-limit-probe` 포착 대기). `limitDetect.ts` 패턴은 errorKind → SDK 오류문만 본다(stderr·모델 답변 제외).
- 알려진 한계: AskUserQuestion 답 UI 없음 · 프로필 settings 의 allow 규칙(`Bash(ssh linux *)` 등)은 "매번 묻기"를 우회 · 재시도 턴은 같은 프롬프트가 기록에 두 번 · 1회 스트림 중 재접속은 `watch_turn` 으로 이어받음.
- 환경: Node v26, `npm install` 은 optional deps 유지(Agent SDK 네이티브 claude 바이너리). Bash 도구는 zsh(따옴표 없는 변수 분리 안 됨), `timeout` 없음(perl alarm).
