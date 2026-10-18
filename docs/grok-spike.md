# Grok Build CLI 스파이크 기록

설계: `docs/superpowers/specs/2026-10-18-grok-engine-design.md` §10. 모든 실험은 임시 디렉터리와 빈 임시 `GROK_HOME` 에서 했다. 자격 파일은 열지 않았다.

## 버전

`grok 1.0.62 (1474f9cbdd91)`, macos-aarch64. 설치는 공식 스크립트(`curl -fsSL https://x.ai/cli/install.sh | bash`)로 했다.

설치 스크립트가 하는 일:
- `~/.grok/bin` 에 설치한다(`grok`·`agent` 두 이름).
- `~/.local/bin` 에 symlink 를 만든다.
- `~/.zshrc` 에 PATH 블록을 추가한다.
- `~/.grok/config.toml` 에 `[cli] installer` 를 기록한다.
- sudo 는 쓰지 않는다.

## 로그아웃 상태 (S2 일부)

### `grok models`
- 종료 코드는 **0** 이다. 출력 첫 줄이 `You are not authenticated.` 다.
- 그래서 종료 코드로는 로그인 여부를 판별할 수 없다. 미리 확인하려면 이 문구를 봐야 한다(문구 의존이라 깨지기 쉽다).

### ACP `initialize { protocolVersion: 1, clientCapabilities: {} }`
- **`authMethods`:** `[{ id: "grok.com", name: "Grok" }]`. 소스 조사에서 "항상 빈 배열"이라고 본 것과 다르다. 로그인된 상태의 값은 아직 보지 못했다.
- **`agentCapabilities`:**
  - `loadSession: true`.
  - `promptCapabilities: { image: false, audio: false, embeddedContext: true }`. **이미지 첨부는 받지 않는다.**
  - `sessionCapabilities: { list, resume, close }`.
- **`_meta.modelState`:** 모델 목록이 여기 실린다(S3). 아래 표 참고.
- `_meta` 에는 hostname·agentId 도 들어 있다. 픽스처로 쓸 때는 지운다.

### 그 밖에 알게 된 것
- **세션 열기 도중 알림:** `session/new` 도중 `_x.ai/session/setup { method, phase, sessionId }` 알림이 온다. phase 순서는 `auth → resolve_workspace → folder_trust → plugin_registry → mcp_merge → persistence_init → spawn_session_actor` 다. **`folder_trust` 단계가 있다.** S9 의 실마리다.
- **로그아웃 상태의 `session/new` 오류:** `{ code: -32000, message: "Authentication required", data: "no auth method id provided" }`.
- **알 수 없는 알림:** 시작 때 `_x.ai/mcp/servers_updated` 알림이 온다.
- **leader 모드:** `grok agent` 에는 `--leader`/`--no-leader` 가 있다. config 의 `[cli] use_leader` 가 켜져 있으면 여러 클라이언트가 백엔드 하나를 공유한다. **deck 은 항상 `--no-leader` 를 준다.**
- **플러그인:** `--plugin-dir` 의 설명은 "always trusted: hooks and MCP servers activate without a prompt" 다. 다른 출처의 플러그인과 훅은 신뢰 확인을 거친다는 뜻으로 보인다. S9 에서 확인한다.

## 모델 (S3)

| modelId | 이름 | 컨텍스트 | effort | 기본 effort |
|---|---|---|---|---|
| `grok-4.6` (기본) | Grok 4.6 | 500k | xhigh / high / medium / low | high |
| `grok-4.5` | Grok 4.5 | 500k | high / medium / low | high |

- 이 목록은 로그아웃 상태에서 본 것이다. 구독에 따라 달라지는지는 로그인 뒤에 다시 본다.
- 설계서 §6 의 "기본 grok-4.5" 는 문서가 옛 내용이었다. 실제 기본은 **grok-4.6** 이다.

## 남은 항목 (로그인 뒤)

S1, S2 나머지(로그인 상태의 authMethods·제공자), S4~S13, 실패 주입.
