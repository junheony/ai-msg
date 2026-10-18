# Grok 엔진 설계 (2026-10-18)

> 상태: 초안. 독립 검토를 받은 뒤 구현한다. 실측이 필요한 항목은 §10 스파이크에 모았다. 사용자가 설치하고 `grok login` 을 한 뒤에 확인한다.
> 근거 소스: xai-org/grok-build 공개 저장소의 문서(`crates/codegen/xai-grok-pager/docs/user-guide/`)와 코드. 아래 줄 번호는 조사 시점 기준이다.

## 0. 목표와 범위

deck 에서 Claude·GPT·Gemini 세션처럼 **Grok 세션**을 열고 대화한다. 엔진은 xAI 의 Grok Build CLI(`grok`)다.

v1 에서 할 것:
- 새 세션, 이어 하기, 모델 고르기, effort 고르기.
- 스트리밍 텍스트, 생각 표시, 도구 호출 카드, **승인 카드**.
- ■중단, 진행 중 steer(끼어들기), 이력 다시 그리기, 한도 감지와 로그인 필요 안내.

v1 에서 하지 않을 것:
- 자동 라우팅에 Grok 을 넣는 일. Gemini 처럼 사용자가 명시적으로 고를 때만 쓴다.
- 총사령탑. Grok 세션은 거부한다(§8).
- 사용량 카드. 읽는 방법이 확인되면 v2 에서 한다.
- 세션 분기(메시지 편집 갈래), 백그라운드 작업 이어 받기.

## 1. 방식 선택

| 방식 | 장점 | 단점 |
|---|---|---|
| **A. ACP `grok agent stdio`** (추천) | JSON-RPC 로 승인 요청(`session/request_permission`)이 온다 → deck 승인 카드. `session/cancel`, `x.ai/interject`(steer), 모델·effort 를 요청으로 바꾼다(`session/set_config_option`). 프롬프트가 argv 를 거치지 않는다. 표준 ACP 라 다른 ACP 에이전트에도 쓸 수 있다 | JSON-RPC 클라이언트를 직접 써야 한다. 매 턴 `session/load` 비용(§10 측정) |
| B. 헤드리스 `grok -p --output-format streaming-json` | Gemini 엔진과 거의 같은 모양이다. 구현이 가장 짧다 | 승인이 필요한 도구는 **자동 거부**되고 모델에 보고된다(`22-permissions-and-safety.md:100`). 승인 카드가 없다. steer 가 없다. 취소는 프로세스를 죽이는 것뿐이다 |

**A 를 고른다.** deck 의 핵심은 폰에서 승인하고 끼어드는 것이고, B 로는 둘 다 안 된다. B 는 A 의 스파이크가 막힐 때만 대안으로 쓴다(§10 결정 지점).

## 2. 프로세스 수명: 턴마다 한 프로세스

Gemini·Codex 엔진과 같이 **deck 턴 하나 = `grok agent stdio` 프로세스 하나**로 한다.

1. spawn `grok agent stdio`. cwd 는 세션 cwd. env 는 §5.
2. `initialize`: clientCapabilities 의 `fs`·`terminal` 은 **광고하지 않는다**. 그러면 에이전트가 파일과 셸을 자기 쪽에서 직접 다룬다(Claude·Codex 엔진과 같은 신뢰 모델).
3. 세션 정하기:
   - 새 세션이면 `session/new { cwd, mcpServers: [] }`.
   - 이어 하기면 `session/load { sessionId, cwd, mcpServers: [], _meta: { noReplay: true } }`(`main.rs:3366`, `mvp_agent/mod.rs:403`). 재생된 업데이트가 와도 `_meta["x.ai/replayed"]` 가 붙은 것은 버린다.
4. `session/set_config_option` 을 보낸다. `model`, 그리고 고른 경우 `reasoning_effort`(minimal/low/medium/high/xhigh)와 권한 모드(§4).
5. `session/prompt`. 그동안 오는 `session/update` 를 EngineEvent 로 바꾼다(§3). 에이전트가 보내는 요청 `session/request_permission` 에 답한다(§4).
6. PromptResponse 가 오면 결과를 낸다. 그다음 stdin 을 닫고, 2s 안에 안 끝나면 SIGTERM, 다시 2s 뒤 SIGKILL.

왜 상주 프로세스가 아닌가: TurnRunner·재시작 대기·중단 처리가 전부 "턴 = 프로세스"를 전제로 한다. 상주 프로세스는 별도 관리 레지스트리가 필요하다. 매 턴 load 비용이 크면(§10 S4: 2s 넘음) v2 에서 다시 본다.

### 2.1 코드 구조
- `src/server/engine/acp/AcpConnection.ts`(새 파일): 줄 단위 JSON-RPC 2.0 클라이언트.
  - 요청 id 짝짓기, 알림 받기, 에이전트가 보내는 요청을 처리기에 넘기기.
  - 한 줄 상한은 `STDERR_MAX` 와 같은 식으로 8MB. 넘으면 연결 오류로 본다.
  - 프로세스가 끝나면 대기 중인 요청을 모두 reject 한다.
  - Grok 을 모른다. 다른 ACP 에이전트를 붙일 때 재사용한다.
- `src/server/engine/GrokEngine.ts`(새 파일): 수명(§2), 이벤트 변환(`GrokEventMapper`, §3), 승인(§4), steer·취소.
- `GrokTurnRequest` 는 Gemini 처럼 따로 둔다. 필드는 `account, cwd, resumeSessionId, model, effort, permissionMode, autoApprove, prompt, signal, onPermission, onLive, onAutoApproved, onToolAudit`.

## 3. 이벤트 변환 (`session/update` → EngineEvent)

| ACP | EngineEvent |
|---|---|
| (session/new·load 성공) | `init { sessionId, model }` |
| `agent_message_chunk` (text) | `delta` |
| `agent_thought_chunk` | `thinking` |
| `tool_call` | `tool_call { toolUseId: toolCallId, name: title·kind 에서 만든 이름, input: rawInput }` |
| `tool_call_update` status `completed`/`failed` | `tool_result { content: content 의 텍스트(32KB 로 자름), isError: failed }` |
| `tool_call_update` 그 밖의 상태 | 무시(진행 표시는 `progress` 로) |
| `plan` | v1 은 무시. 필요하면 v2 에서 task 표시 |
| `_meta["x.ai/replayed"]` 있음 | 버림 |
| 알 수 없는 kind | 버림. 처음 한 번만 서버 로그에 kind 이름을 남긴다(내용은 남기지 않음) |
| PromptResponse | `result`. 사용량은 `_meta.usage` → `TurnUsage`. stopReason 처리는 아래 |

stopReason 처리:
- `end_turn`: 성공.
- `cancelled`: 중단으로 처리. deck 의 ABORTED 경로를 탄다.
- `max_tokens`·`max_turn_requests`: 성공하되 notice 를 붙인다("출력 한도에서 멈춤" / "도구 반복 한도에서 멈춤").
- `refusal`: 실패. 문구는 "Grok 이 거절함".

하위 에이전트: 와이어 모양이 확인되지 않았다(§10 S5). v1 은 부모 `tool_call` 만 보여 준다. 자식 업데이트가 별도 표시로 오면 그 kind 는 버린다.

## 4. 권한

deck 의 세션 권한 모드를 Grok 모드에 대응시킨다.

| deck | Grok |
|---|---|
| 기본(매번 묻기) | `default` |
| 편집 자동(acceptEdits) | `acceptEdits` |
| 계획(plan) | `plan` |
| 모두 자동 승인 | `default` 로 두고, 승인 요청마다 deck 이 `AllowOnce` 로 답한다(감사 `onAutoApproved`) |

`bypassPermissions`·`dontAsk`·`auto`·`--always-approve` 는 **절대 쓰지 않는다**. 이유는 둘이다. deck 의 "모두 자동 승인"도 끌 수 있는 per-call 승인이다. 그리고 Grok `auto` 는 분류기에 맡기는 모드라 deck 이 감사할 수 없다.

`session/request_permission` 처리:
- `onPermission({ toolName, input: rawInput, toolUseId: toolCallId, title, signal })` 로 넘긴다. 이 세션 동안 허용(`suggestions`)은 v1 에서 내지 않으므로 카드에는 "한 번 허용 / 거부"만 뜬다.
- 답을 고르는 규칙:
  - 'once' → 옵션 중 kind 가 `allow_once` 인 것.
  - 'deny' → `reject_once`.
  - 해당 kind 가 없으면 cancelled 로 답한다. 넓은 옵션(AllowAlways* 등)은 **고르지 않는다**.
- 턴이 중단되면(signal) 대기 중인 승인 요청은 모두 `{ outcome: "cancelled" }` 로 답하고 카드를 닫는다.
- `onToolAudit`: 승인 요청 없이 실행된 도구 호출을 기록한다. 대상은 `tool_call` 이 왔지만 request_permission 이 없었던 것이고, `source: 'cli'` 로 한 번씩 남긴다.

## 5. 계정·환경·격리

- **좌석:** `x1` 하나로 시작한다. `RESERVED_ACCOUNT_IDS` 에 `x1`·`x2`·`grok` 을 추가하고, 자동 라우팅 후보에서는 뺀다.
  - x1 은 기본 `~/.grok` 을 쓴다. 사용자가 터미널에서 `grok login` 을 한 그 상태다.
  - 두 번째 계정이 생기면 `GROK_HOME=~/.grok-x2` 로 나눈다(v2).
- **deck 은 로그인하지 않고, `auth.json` 을 읽지 않는다.** 로그인 여부는 턴이 실패할 때의 인증 오류로만 안다. 그때 문구는 "Grok 로그인 필요 — 터미널에서 grok login".
  - 전용 확인 명령(`auth status` 류)은 없다. ACP `initialize` 의 `authMethods` 는 항상 빈 배열이다(`leader_bridge.rs:354`).
  - 후보는 `grok models` 의 성공 여부다(`main.rs:2274`). §10 S2 에서 로그아웃 상태의 결과를 보고 쓸지 정한다. 쓰게 되면 그 결과를 `GrokStatus` 로 hello 에 싣고, 60s 캐시한다.
- **env:** `grokEnv(base)`.
  - `GROK_DISABLE_AUTOUPDATER=1` 을 넣는다. 자동 업데이트가 턴 도중에 바이너리를 바꾸지 않게 하기 위해서다.
  - `XAI_API_KEY` 는 물려주지 않는다. 구독 로그인만 쓰고, 키가 섞여 과금되는 일을 막는다.
  - Claude·Codex 전용 env(`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `CODEX_HOME` 등)도 뺀다.
- **Claude 호환 끄기(필수):** Grok 은 기본으로 `~/.claude/settings.json` 의 훅, `~/.claude.json` 의 MCP, Claude 에이전트·규칙·스킬을 읽는다.
  - 그대로 두면 사용자의 Claude 전역 훅(OMC 등)이 Grok 턴에서 돌고, Claude 용 MCP 서버가 뜬다.
  - env 로 끈다. 우선순위는 env > `config.toml` > 기본값(켜짐)이다(`26-config-reference.md:120-124`, `05-configuration.md:411-417`). 사용자 파일은 고치지 않는다.
  - 끄는 env 는 `GROK_CLAUDE_HOOKS_ENABLED`, `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CLAUDE_AGENTS_ENABLED`, `GROK_CLAUDE_RULES_ENABLED`, `GROK_CLAUDE_SKILLS_ENABLED`. 모두 `grokEnv` 에서 거짓 값으로 둔다.
  - 확인할 것(§10 S6): 받는 거짓 값의 철자(`false`/`0`), 프로젝트 `.mcp.json` 도 꺼지는지.
  - Grok 자체 설정(`~/.grok/hooks`, `<cwd>/.grok/`)은 사용자가 Grok 에 직접 건 것이므로 그대로 둔다.
- **binary:** `config.ts` 에서 `DECK_GROK_BIN` → PATH 의 `grok` → `~/.grok/bin/grok` 순으로 찾는다. 없으면 엔진이 꺼진 것으로 보고, 새 대화 창의 Grok 선택지를 흐리게 한다.

## 6. 모델·effort

- deck id: `grok` 하나로 시작한다. CLI 에는 **모델을 보내지 않고** Grok 기본 모델을 쓴다(문서상 새 세션 기본 `grok-4.5`, `11-custom-models.md:9`).
  - `grok models` 로 구독에서 쓸 수 있는 목록을 확인하면(§10 S3) id 를 늘린다(예: `grok-4.6` → `GROK_CLI_ALIAS`).
  - deck id 는 세션 기록에 저장되므로 CLI 이름이 바뀌어도 deck id 는 그대로 둔다.
- effort: deck `EFFORTS`(low/medium/high/max)에서 Grok 값으로. low→low, medium→medium, high→high, max→xhigh.
- `DEFAULT_EFFORT.grok = 'medium'`. 모델이 `reasoning_effort` 를 받지 않으면(set_config_option 오류) notice 를 한 번 내고 계속한다.

## 7. steer·중단·이력

- **steer:** 턴이 시작되면 `onLive({ send: async () => false, steer })` 를 넘긴다.
  - `steer(f, id)` 는 `x.ai/interject { sessionId, text, interjectionId: id }` 를 보낸다(`content` 는 생략, `app/effects/mod.rs:5712-5731`). 성공 응답이 오면 `steer_delivered { id }` 를 낸다.
  - 첨부 파일이 있는 steer 는 false 를 돌려준다. 그러면 deck 이 일반 대기 메시지로 처리한다.
- **중단:** signal 이 오면 `session/cancel` 을 보낸다.
  - 5s 안에 PromptResponse(cancelled)가 오면 정상 중단이다.
  - 안 오면 §2 의 종료 순서를 따른다.
- **이력:** `$GROK_HOME/sessions/<urlencoded cwd>/<id>/updates.jsonl` 을 읽는 `grokTranscript.ts`(새 파일)를 둔다.
  - 사용자 프롬프트, 응답 텍스트, 도구 호출을 `TranscriptMessage[]` 로 만든다.
  - 읽기 전용으로, 크기 상한은 64MB 다. 경로는 deck 이 계산한 디렉터리 밖이면 거부한다(realpath).
  - 형식이 다르거나 파일이 없으면 빈 이력을 낸다. Gemini 와 같은 동작이고, 패널에는 "이력 없음(Grok)"이 뜬다.
  - cwd 가 255바이트를 넘어 slug+hash 로 바뀐 경우는 `.cwd` 파일을 대조한다.

## 8. 한도·오류·총사령탑

- **한도:**
  - 오류 type 이 `rate_limit`/`rate_limited` 이거나 메시지가 429·503·529 면 `rate_limit` 이벤트를 낸다.
  - TurnRunner 는 Gemini 처럼 x1 을 쿨다운에 넣고 "Grok 한도 — <리셋 시각 또는 잠시 뒤>"를 표시한다. 다른 엔진으로 자동 전환하지는 않는다.
- **인증 오류:** §5 문구. 재시도하지 않는다.
- **프로세스 비정상 종료:** stderr 끝 4KB 를 `redact` 를 거쳐 오류 문구에 붙인다.
- **총사령탑:** Grok 세션은 `commander_engine` 으로 거부한다(지금 Claude 가 아니면 거부하는 규칙 그대로).
  - 이유: 총사령탑의 자동 턴 게이트는 PreToolUse 훅에 기대는데, Grok 훅은 시간 초과나 오류 때 **허용**한다(`10-hooks.md:166`, `22-permissions-and-safety.md:430` "Hooks fail open").
  - 다음 버전에서 Grok 을 지원하려면 훅이 아니라 §4 의 request_permission 경로로 게이트를 걸어야 한다.

## 9. 손댈 곳 (Gemini 체크리스트 기준)

- `shared/models.ts`:
  - `GrokModel`, `GROK_MODELS`, `DEFAULT_GROK_MODEL`, `GROK_CLI_ALIAS` 를 추가한다.
  - `MODEL_LABEL`·설명·`MODEL_EFFORTS`·`DEFAULT_EFFORT` 에 grok 을 넣는다.
  - `EngineKind` 에 `'grok'`, `isGrokModel` 을 추가한다.
  - 컨텍스트 창은 기본 200k 로 둔다(확인되면 수정).
- `shared/accounts.ts`: `GrokAccount = 'x1'`, `isGrokAccount`, `GROK_LABEL`, `grokEnv`. `Seat` 에 추가하고, 예약 id 를 추가한다.
- `shared/protocol.ts`:
  - send 의 `engine` enum 에 `'grok'`.
  - `hello.grok`(binary 유무, §10 S2 결과에 따라 로그인 상태).
  - `features` 에 `'grok'`.
- `SessionState.ts`: `GrokSessionState`, `isGrokState`. 저장 필드는 `engine:'grok'`, `model`, `effort`, `permissionMode`, `grokSessionId`.
- `TurnRunner.ts`: grok 분기, 한도 정규식, 쿨다운.
- `ws.ts`: 새 세션·이어 하기·history·승인 응답·steer 분기. history 는 `grokTranscript`.
- `config.ts`·`main.ts`: binary 찾기와 엔진 연결.
- `Commander.ts`: 변경 없음. 거부 테스트만 추가한다.
- UI:
  - `EngineMark`(Grok 표시), `ModelPicker`, `NewChat`(Grok 선택), `AccountPicker`(x1).
  - `UsagePanel`: Grok 카드는 없다. 자리 표시는 "사용량 모름".
  - `ui/state.ts`.
- 문서: `docs/grok-spike.md`(새 파일, 실측 기록), `docs/protocol.md`, `README.md`(설치: `curl -fsSL https://x.ai/cli/install.sh | bash` → `grok login`).

## 10. 스파이크 (사용자 설치·로그인 뒤, 구현 전에 먼저)

`docs/grok-spike.md` 에 결과를 남긴다. 각 항목은 deck 이 아닌 임시 디렉터리에서 실행한다. 자격 파일은 열지 않는다.

- **S1. ACP 왕복:** initialize → session/new → session/prompt("pwd 출력해") → update 순서, 승인 요청 모양, PromptResponse 의 `_meta.usage`. 원문 로그를 테스트 픽스처로 저장한다. 픽스처에서 자격·개인 경로는 지운다.
- **S2. 로그인 확인:** 빈 임시 `GROK_HOME` 으로 로그아웃 상태를 흉내 낸다(실제 로그인은 건드리지 않는다). 그 상태에서 session/new 의 오류(`auth_required` 의 JSON-RPC code·message)와 `grok models` 의 종료 코드를 본다.
- **S3. 모델 목록:** session/new 응답의 configOptions, `grok models` 같은 명령.
- **S4. load 비용:** 대화 20턴 세션의 `session/load`(noReplay) 시간. 2s 를 넘으면 §2 를 다시 본다.
- **S5. 하위 에이전트:** Agent 도구를 쓰게 하는 프롬프트로 자식 업데이트의 와이어 모양을 본다.
- **S6. Claude 호환 끄기:** `GROK_CLAUDE_*_ENABLED` 를 거짓으로 준 채, 임시 cwd 에 `.mcp.json` 과 표식 훅을 두고 Grok 이 읽지 않는지 확인한다. 거짓 값 철자도 확인한다.
- **S7. steer·cancel:** 긴 작업 도중 interject 와 cancel 을 보내고 응답과 stopReason 을 본다.
- **S8. 한도 오류 모양:** 일부러 일으키지 않는다. 문서와 소스에서 문자열을 확인하고, 실제 관측은 생기면 기록한다.

**결정 지점:** S1 에서 승인 요청이 오지 않는 경우(예: 구독 모드에서 ACP 가 막힘)에는 §1 의 B 로 바꾸고 이 문서를 고친다. 이때 B 는 모드 plan/acceptEdits 만 쓰고, 승인 카드는 없다.

## 11. 테스트

- `AcpConnection.test.ts`:
  - 가짜 에이전트(node 스크립트, 임시 디렉터리)로 요청과 응답의 짝짓기를 본다.
  - 에이전트 요청 처리, 줄 상한 초과, 프로세스 종료 때 대기 요청 reject 를 본다.
- `GrokEngine.test.ts`:
  - S1 픽스처를 재생하는 가짜 에이전트로 이벤트 변환을 본다.
  - 승인 'once'·'deny'·중단, 넓은 옵션만 있을 때 cancelled 로 답하는지 본다.
  - 재생된 업데이트를 버리는지, stopReason 별 결과, 인증·한도 오류를 본다.
  - steer → interject → steer_delivered 와 중단 → session/cancel → 종료 순서를 본다.
- `grokTranscript.test.ts`: 픽스처 `updates.jsonl`, 경로 밖 거부, 크기 상한, 깨진 줄.
- 기존 테스트 확장:
  - `ws` 의 grok 세션 생성·이어 하기·history·승인 응답.
  - `Commander` 의 grok 거부.
  - UI 의 Grok 선택과 표시.
- 실제 `grok` 이나 실제 `~/.grok` 을 쓰는 테스트는 없다. 위생 테스트는 그대로 통과해야 한다.

## 12. 보안 메모

- 프롬프트는 JSON-RPC 본문으로만 간다. argv 에 들어가지 않는다.
- 이어 하기 sessionId 는 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` 로 검사한다. history 경로를 만들 때도 같은 검사를 거친다.
- 에이전트가 보내는 요청 가운데 deck 이 처리하는 것은 `session/request_permission` 뿐이다. 다른 메서드(`fs/*`, `terminal/*` 등)에는 "method not found" 로 답한다. capability 를 광고하지 않았으므로 오지 않아야 정상이다.
- bypass 계열 모드와 넓은 허용 옵션을 쓰지 않는다(§4).
