# Grok 엔진 설계 (2026-10-18)

> 상태: **개정 1판.** 교차 검토(Claude·Astra)는 둘 다 REVISE 였고, 지적은 전부 반영했다(§13).
> 실측이 필요한 항목은 §10 스파이크에 모았다. 사용자가 설치하고 `grok login` 을 한 뒤, 구현에 앞서 먼저 돌린다.
> 근거 소스: xai-org/grok-build 공개 저장소의 문서(`crates/codegen/xai-grok-pager/docs/user-guide/`)와 코드. 줄 번호는 조사 시점 기준이다.

## 0. 목표와 범위

deck 에서 Claude·GPT·Gemini 세션처럼 **Grok 세션**을 열고 대화한다. 엔진은 xAI 의 Grok Build CLI(`grok`)다.

v1 에서 하는 것:
- 새 세션, 이어 하기, 모델, effort.
- 스트리밍 텍스트, 생각, 도구 카드, **승인 카드**.
- ■중단, steer, 이력 다시 그리기.
- 한도·로그인 필요 안내.

v1 에서 하지 않는 것:
- 자동 라우팅에 넣기. Gemini 처럼 명시적으로 고를 때만 쓴다.
- 총사령탑(§8).
- 사용량 카드.
- 세션 분기, 백그라운드 이어 받기.

## 1. 방식 선택

| 방식 | 장점 | 단점 |
|---|---|---|
| **A. ACP `grok agent stdio`** (채택) | 승인 요청(`session/request_permission`)이 와서 deck 승인 카드로 띄울 수 있다. `session/cancel`, `x.ai/interject`(steer), 설정을 요청으로 바꾸기가 된다. 프롬프트가 argv 를 거치지 않는다 | JSON-RPC 클라이언트를 직접 써야 한다. 매 턴 `session/load` 비용(S4) |
| B. 헤드리스 `grok -p --output-format streaming-json` | Gemini 엔진과 같은 모양이라 가장 짧다 | 승인이 필요한 도구는 자동 거부된다(`22-permissions-and-safety.md:100`). 승인 카드가 없고 steer 도 없다 |

**A 로 간다.** B 로 바꾸면 deck 의 핵심 기능인 승인과 steer 를 포기하게 된다. 그래서 B 는 **기능 범위를 사용자와 다시 합의해야 하는 별도 결정**이다. 스파이크 실패로 저절로 넘어가지 않는다(§10 결정 지점).

## 2. 프로세스 수명

Gemini·Codex 엔진과 같이 **deck 턴 하나 = `grok agent stdio` 프로세스 하나**로 한다. 단계마다 시간 한도가 있다.

1. **잠금:**
   - 열쇠는 `(GROK_HOME 실경로, sessionId)` 다. 새 세션이면 `(GROK_HOME, 새 세션 임시 키)` 를 쓴다.
   - 이전 턴의 프로세스 **그룹**이 완전히 끝나야 잠금이 풀린다.
   - 잠금을 기다리는 동안 턴은 "준비 중" 상태다. 30s 를 넘기면 "이전 Grok 프로세스가 아직 끝나지 않음" 오류로 끝낸다.
2. **spawn:**
   - `grok agent --no-leader stdio` 를 `detached: true` 로 띄워 새 프로세스 그룹을 만든다.
   - cwd 는 세션의 정규 cwd(realpath, 세션 상태에 저장)다. env 는 §5.
3. **`initialize`** (15s):
   - clientCapabilities 의 `fs`·`terminal` 은 **광고하지 않는다**. 에이전트가 자기 쪽에서 파일과 셸을 다룬다(Claude·Codex 와 같은 신뢰 모델).
   - 응답의 `promptCapabilities` 를 기억한다. §7 첨부 처리에 쓴다.
4. **세션 정하기** (30s):
   - 새 세션: `session/new { cwd, mcpServers: [] }`. 받은 sessionId 는 **프롬프트를 보내기 전에** 세션 상태에 저장한다. 이렇게 해야 도중에 죽어도 이어 하기를 할 수 있다.
   - 이어 하기: `session/load { sessionId, cwd, mcpServers: [], _meta: { noReplay: true } }`(`main.rs:3366`, `mvp_agent/mod.rs:403`).
     - load 가 실패하면(세션 없음, cwd 불일치, 잠금) **턴을 오류로 끝낸다**.
     - `session/new` 로 몰래 넘어가지 않는다. 프롬프트를 자동으로 다시 보내지도 않는다.
5. **설정** (각 10s):
   - **권한 모드를 먼저 정한다**(§4). 그다음 모델(고른 경우만, §6)과 effort.
   - 응답, 또는 `current_mode_update`·`config_option_update` 알림으로 **실제 값을 확인한다**.
   - 권한 모드가 요청한 값과 다르거나 확인할 수 없으면, **프롬프트를 보내지 않고 턴을 실패시킨다**(fail-closed).
6. **`session/prompt`** (시간 한도 없음):
   - 그동안 `session/update` 를 변환한다(§3). 에이전트의 요청은 §4 규칙으로 답한다.
7. **종료:**
   - PromptResponse 가 오면 결과를 확정한다. 그 뒤에 오는 update 는 버린다.
   - stdin 을 닫고 기본 10s 를 기다린다(세션 기록 flush 시간, S4 에서 잰 값으로 조정).
   - 그래도 남아 있으면 프로세스 **그룹**에 SIGTERM, 3s 뒤 그룹에 SIGKILL.
   - 그룹이 모두 끝난 것을 확인한 뒤에 잠금을 푼다.

상주 프로세스로 가지 않는 이유: TurnRunner·재시작 대기·중단이 모두 "턴 = 프로세스"를 전제로 한다. 매 턴 load 가 2s 를 넘으면 v2 에서 다시 본다.

### 2.1 코드 구조
- **`src/server/engine/acp/AcpConnection.ts`**(새 파일): 줄 단위 JSON-RPC 2.0 클라이언트. Grok 을 모른다.
  - **받기와 처리를 분리한다.** 받는 루프는 줄을 파싱해서 넘기기만 하고 기다리지 않는다. 에이전트 요청 처리기는 비동기로 돌기 때문에, 승인 카드를 기다리는 동안에도 다른 메시지를 계속 받는다.
  - 요청 id 짝짓기와 요청별 시간 한도를 둔다. 알림 보내기(`notify`, 응답 없음)도 있다.
  - stdin 쓰기는 `drain` 을 기다린다(backpressure).
  - JSON 이 아닌 줄은 건너뛰고 개수만 센다. 한 줄 상한은 8MB 이고, 넘으면 연결 오류다.
  - 프로세스가 끝나면 대기 중인 요청을 모두 reject 하고, 처리 중인 에이전트 요청은 응답을 보내지 않는다.
- **`src/server/engine/GrokEngine.ts`**(새 파일): §2 수명, `GrokEventMapper`(§3), 승인(§4), steer·취소(§7).
- **`src/server/engine/grokTranscript.ts`**(새 파일): 이력 읽기(§7).
- **`src/server/engine/grokLock.ts`**(새 파일): §2-1 잠금. 서버 프로세스 안의 Map 이고, 터미널 grok 과의 경합은 S11 에서 확인한다.
- `GrokTurnRequest` 는 Gemini 처럼 따로 둔다. 필드는 다음과 같다:
  - `account, cwd, resumeSessionId, model, effort, permissionMode, prompt, attachments, signal`
  - `autoApprove, onPermission, onAutoApproved, onToolAudit, onLive, onSessionId`

## 3. 이벤트 변환

| ACP | EngineEvent |
|---|---|
| session/new·load 성공 + 실제 모델 확인 | `init { sessionId, model }` |
| `agent_message_chunk` (text) | `delta` |
| `agent_thought_chunk` | `thinking` |
| `tool_call` | toolCallId 별 상태를 만든다. 처음 볼 때 `tool_call { toolUseId, name, input }` |
| `tool_call_update` | 상태에 **병합**한다(부분 변경, ACP 규칙). **처음으로** terminal(`completed`/`failed`)이 되면 `tool_result` 를 한 번 낸다. 결과 본문은 지금까지 병합한 content 의 텍스트이고, 32KB 로 자른다 |
| `plan` | v1 은 무시 |
| `current_mode_update`·`config_option_update` | §2-5 확인에 쓴다. 턴 도중 권한 모드가 바뀌면 notice 를 내고, deck 이 고른 모드가 아니면 **턴을 취소한다** |
| `_meta["x.ai/replayed"]` 가 있음 | 버림 |
| 알 수 없는 kind | 버림. kind 이름만 kind 마다 서버 로그에 한 번 남긴다 |
| PromptResponse | `result`. 사용량은 `_meta.usage` 이고, 턴별인지 누적인지는 S1 에서 확인한다. 확인 전에는 표시하지 않는다 |

도구 상태를 다루는 규칙:
- `name` 은 `kind`(read/edit/execute 등)와 `title` 로 만든다. Claude 도구 이름처럼 보이게 만들지 않는다. 형식은 `grok:<kind>` 다.
- `rawInput` 이 객체가 아니면 `{ value: rawInput }` 으로 감싼다.
- 턴이 끝날 때 terminal 이 아닌 도구에는 `tool_result { isError: true, content: '(결과 없음)' }` 을 한 번 낸다.

stopReason:
- `end_turn`: 성공.
- `cancelled`: 중단(ABORTED 경로).
- `max_tokens`: 성공 + notice "출력 한도에서 멈춤".
- `max_turn_requests`: 성공 + notice "모델 요청 횟수 한도에서 멈춤".
- `refusal`: 실패, 문구 "Grok 이 거절함". 그때까지의 출력과 변경은 그대로 보존한다(되돌리지 않는다).

하위 에이전트: 와이어 모양은 S5 에서 확인한다. v1 은 부모 `tool_call` 만 보인다. 그 밖의 자식 업데이트는 버린다. 단 **승인 요청은 버리지 않는다**(§4).

## 4. 권한

### 4.1 모드
| deck | Grok |
|---|---|
| 기본(매번 묻기) | `default` |
| 편집 자동 | `acceptEdits` |
| 계획 | `plan` |
| 모두 자동 승인 | `default`. 승인 요청마다 deck 이 고른다(§4.2) |

- 모드를 바꾸는 방법은 S10 에서 확정한다. ACP 표준 `session/set_mode` 와 `set_config_option` 중 하나다.
- §2-5 의 확인을 통과하지 못하면 턴을 시작하지 않는다. `~/.grok/config.toml` 의 기본 모드가 `bypassPermissions`·`auto` 여도 deck 세션은 deck 이 고른 모드로만 돈다.
- `bypassPermissions`·`dontAsk`·`auto`·`--always-approve` 는 **쓰지 않는다**.
- "매번 묻기"여도 승인 없이 실행되는 도구가 있다(읽기 계열 등). 모드별로 그 범위를 S13 에서 기록하고, `docs/grok-spike.md` 와 모드 선택지 설명에 적는다.

### 4.2 `session/request_permission`
- **카드:**
  - `onPermission({ toolName, input, toolUseId, title, signal })` 로 넘긴다.
  - toolCallId 를 모르는 요청(하위 에이전트 등)도 카드로 띄운다. 이때 이름은 `grok:<kind>` 이고, 제목에 "하위 에이전트"를 붙인다.
  - v1 은 `suggestions` 를 넘기지 않는다. 그래서 카드에는 "한 번 허용 / 거부"만 뜬다.
- **응답 형식:** `result.outcome` 은 `{ outcome: 'selected', optionId }` 이거나 `{ outcome: 'cancelled' }` 다. optionId 는 요청에 실제로 온 값을 쓴다.
- **고르는 규칙:**
  - 'once' → kind `allow_once` 인 옵션.
  - 'deny' → kind `reject_once` 인 옵션.
  - 해당 kind 가 없으면 cancelled 로 답한다. `allow_always`·AllowAlways* 같은 넓은 옵션은 **절대 고르지 않는다**.
- **모두 자동 승인:**
  - 일반 도구는 `allow_once` 를 자동으로 고르고 `onAutoApproved` 로 감사한다.
  - **자동 승인하지 않는 것:** 계획 종료(plan 을 벗어나는 요청), 모드나 권한을 넓히는 요청, `allow_once` 가 없는 요청. 이것들은 카드로 띄운다.
  - 무엇이 이에 해당하는지는 S1·S10 에서 실제 요청 모양으로 확정한다. 확정하기 전에는 kind 가 `edit`·`execute`·`read`·`fetch`·`search` 가 아닌 요청은 모두 카드로 간다.
- **한 번만, 그리고 취소 우선:**
  - 요청마다 `answered` 플래그를 둔다. 응답은 한 번만 보낸다.
  - 턴이 중단되면 먼저 `cancelled = true` 로 고정한다.
  - **모든 응답 직전에** 이 플래그를 다시 본다. 중단된 뒤에 늦게 온 카드 답이나 자동 승인은 cancelled 로 바꿔 보낸다.
  - 중단 뒤에 새로 오는 승인 요청은 바로 cancelled 로 답한다. 열려 있던 카드는 모두 닫는다.
- **감사(`onToolAudit`):**
  - 승인 요청 없이 실행된 도구를 기록한다.
  - 판정은 `tool_call` 시점이 아니라, 도구가 `in_progress` 나 terminal 이 될 때까지 그 toolCallId 의 승인 요청이 없었을 때 한다. 그때 `source: 'cli'` 로 한 번 남긴다.
  - 감사는 사후 기록일 뿐 관문이 아니다. 관문은 §4.1 의 모드와 §5 의 설정 격리다.

## 5. 계정·환경·격리

- **좌석:**
  - `x1` 하나로 시작한다. `RESERVED_ACCOUNT_IDS` 에 `x1`·`x2`·`grok` 을 넣고, 자동 라우팅 후보에서는 뺀다.
  - x1 의 `GROK_HOME` 은 deck 이 명시적으로 준다. 기본값은 `~/.grok` 의 실경로다. 셸에서 물려받은 `GROK_HOME` 은 쓰지 않는다.
  - 두 번째 계정은 v2 에서 `~/.grok-x2` 로 둔다.
- **deck 은 로그인하지 않고 `auth.json` 을 읽지 않는다.**
  - 전용 확인 명령은 없다. 로그아웃 상태에서 `session/new` 는 `{ code: -32000, message: "Authentication required" }` 로 끝난다(실측). 그때 "Grok 로그인 필요 — 터미널에서 grok login" 을 보이고, 재시도는 하지 않는다.
  - 미리 확인은 v1 에서 하지 않는다. `grok models` 는 로그아웃 상태에서도 종료 코드 0 이고 문구로만 구분되기 때문이다(실측).
- **env 는 허용 목록 방식이다(`grokEnv`).**
  - 물려주는 것: `PATH HOME USER LOGNAME SHELL LANG LC_* TERM TMPDIR TZ`.
  - deck 이 넣는 것:
    - `GROK_HOME`: 좌석별 값.
    - `GROK_DISABLE_AUTOUPDATER=1`.
    - `GROK_CLAUDE_HOOKS_ENABLED`, `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CLAUDE_AGENTS_ENABLED`, `GROK_CLAUDE_RULES_ENABLED`, `GROK_CLAUDE_SKILLS_ENABLED`: 모두 거짓 값(`26-config-reference.md:120-124`, env > config.toml > 기본 켜짐).
  - 그 밖은 모두 뺀다. `XAI_*`, 다른 `GROK_*`, 다른 제공자 키(`OPENAI_*`·`ANTHROPIC_*`·`GEMINI_*` 등), 프록시 env, `CLAUDE_*`·`CODEX_*` 가 여기 해당한다.
  - 거짓 값의 철자는 S6 에서 확정하고 테스트로 고정한다. 철자가 틀리면 소리 없이 켜진 채로 남기 때문이다.
- **구독 전용:**
  - `XAI_API_KEY` 를 빼는 것만으로는 충분하지 않다. `config.toml` 의 custom provider·endpoint 설정이 다른 인증을 쓸 수 있다.
  - S2 에서 확인한다. 턴 결과의 실제 모델과 제공자가 xAI 기본 제공자가 아니면 notice 를 낸다.
- **전역 Grok 설정(`$GROK_HOME`):** 사용자가 Grok 에 직접 건 것으로 보고 그대로 쓴다. 단 권한 모드는 §4.1 에서 deck 이 덮어쓰고 확인한다.
- **프로젝트 설정(`<cwd>/.grok/`, 그리고 Grok 이 읽는 상위 폴더):** 저장소 작성자가 넣을 수 있다. 시작할 때 실행되는 훅, allow 규칙, 모드, MCP 가 승인 카드보다 먼저 적용될 수 있다.
  - S9 에서 확인할 것: 끄는 env·플래그가 있는지, ACP 에 폴더 신뢰 절차가 있는지.
  - **끄는 방법이 있으면** `grokEnv` 에 넣어 항상 끈다.
  - **없으면 fail-closed 로 막는다.** 잠금을 잡은 뒤 spawn 직전에 cwd 부터 Grok 이 읽는 범위(S9 에서 확정, 확정 전에는 git 루트까지)에서 `.grok/` 를 찾는다. 있으면 턴을 시작하지 않고 "이 폴더에 Grok 프로젝트 설정(.grok/)이 있어 시작하지 않음"을 보인다.
  - 폴더 신뢰 목록은 v2 에서 한다.
- **binary:** `DECK_GROK_BIN` → PATH 의 `grok` → `~/.grok/bin/grok` 순으로 찾는다. 없으면 Grok 선택지를 흐리게 한다. 버전(`grok --version`)은 hello 와 스파이크 문서에 남긴다.

## 6. 모델·effort

- deck 모델 id 는 `grok-4.6`(기본)과 `grok-4.5` 다. 실측 목록은 `initialize` 응답 `_meta.modelState` 에서 얻었다(`docs/grok-spike.md`).
  - Grok 기본 모델이 deck 기본과 같아도 model 설정은 항상 보낸다(`session/set_config_option` configId `model`). 실제 값은 응답이나 `config_option_update` 로 확인해서 `init.model` 과 turn_result `model` 에 싣는다.
  - 응답의 값이 요청한 값과 다르면 notice 를 낸다. 실패시키지는 않는다(권한 모드와 다른 점).
  - 구독에 따라 목록이 다를 수 있다. 로그인 뒤 `modelState.availableModels` 에 없는 deck 모델은 고를 수 없게 표시한다.
- effort(configId `reasoning_effort`): low→low, medium→medium, high→high, max→xhigh.
  - `MODEL_EFFORTS['grok-4.5']` 는 low·medium·high 셋뿐이다(xhigh 없음).
  - `DEFAULT_EFFORT.grok = 'high'`. Grok 의 기본값과 같다.
- 컨텍스트 창은 500k 다(`totalContextTokens`).

## 7. 첨부·steer·중단·이력

- **첨부:**
  - 이미지는 `promptCapabilities.image` 가 참일 때만(1.0.62 실측은 거짓) image content block 으로 보낸다. 거짓이면 턴을 시작하지 않고 "Grok 은 이미지 첨부를 받지 않음"을 보인다.
  - 그 밖의 파일은 Claude 엔진처럼 `첨부 파일:` 경로 줄로 보낸다.
- **steer:** 턴이 시작되면 `onLive({ send: async () => false, steer })` 를 넘긴다.
  - `steer(f, id)` 가 false 를 돌려주는 경우: PromptResponse 를 받은 뒤, 중단된 뒤, 첨부가 있을 때. 그러면 deck 이 일반 대기 메시지로 처리한다.
  - 보내는 요청은 `x.ai/interject { sessionId, text, interjectionId: id }` 이고 `content` 는 생략한다(`app/effects/mod.rs:5712-5731`).
  - **delivered 근거는 S7 에서 정한다.**
    - 에이전트가 소비할 때 echo(`user_message_chunk` 등에 interjectionId)를 주면 그때 `steer_delivered` 를 낸다.
    - 응답(ACK)만 있으면 ACK 시점에 낸다. 이 경우 S7 에서 "ACK 뒤 턴이 끝나 사라지는" 경우가 있는지 확인한다.
    - 사라지는 경우가 있으면, PromptResponse 때까지 echo 가 없던 steer 를 deck 이 대기 메시지로 되돌린다.
  - 같은 id 는 다시 보내지 않는다.
- **중단:**
  - signal 이 오면 §4.2 대로 취소 상태부터 고정한다.
  - `session/cancel` 은 **알림**으로 보낸다(응답 없음, ACP 규칙). PromptResponse(cancelled)를 기다리는 한도는 5s 다.
  - 시간을 넘기면 §2-7 의 그룹 종료로 간다.
  - 시작 단계(잠금 대기·initialize·load·설정)에서 중단되면 그 단계 요청을 버리고 바로 그룹 종료로 간다.
- **이력: `updates.jsonl` 을 직접 읽는다** (`grokTranscript.ts`).
  - load 재생은 프로세스를 띄워야 하고, 진행 중인 턴과 잠금 경합이 생긴다.
  - **경로:**
    - 세션 상태에 Grok 이 처음 알려 준 세션 디렉터리를 저장하지 않는다.
    - 대신 `$GROK_HOME/sessions/*/<sessionId>/updates.jsonl` 후보를 찾는다. sessionId 는 §12 정규식을 통과한 것만 쓴다.
    - realpath 가 `$GROK_HOME/sessions` 실경로 아래인 것만 받는다. symlink 로 밖을 가리키면 거부한다.
    - 후보가 여럿이면, 그룹 디렉터리 이름이 세션 정규 cwd 의 URL 인코딩과 같은 것을 고른다. 255바이트를 넘는 경우는 slug+hash 규칙을 S1 에서 확인해 구현한다. `.cwd` 파일 내용은 경로 권한의 근거로 쓰지 않는다.
  - **읽기:**
    - 열린 파일 핸들로 크기를 확인하고 64MB 상한을 둔다.
    - 마지막 줄이 개행으로 끝나지 않으면(쓰는 중) 무시한다.
    - 형식 버전은 grok 버전과 함께 S1 픽스처로 고정한다.
  - **결과를 셋으로 구분한다.**
    - 없음 → 빈 이력.
    - 손상(깨진 줄이 10% 넘음) → 빈 이력 + 서버 로그 한 번.
    - 모르는 형식 → 빈 이력 + 서버 로그 한 번 + 패널에 "이력 형식을 모름(Grok 버전 확인 필요)".

## 8. 한도·오류·총사령탑

- **분류는 구조화된 오류를 우선한다.** JSON-RPC error 의 code·data, 그리고 문서의 오류 type(`rate_limit`/`rate_limited`, `authentication_failed`)으로 나눈다. 도구 출력 본문의 숫자는 보지 않는다.
  - **할당량 한도:** `rate_limit` 이면서 429 이거나 할당량 문구가 있으면 `rate_limit` 이벤트를 낸다. 좌석 x1 은 쿨다운에 들어가고 "Grok 한도 — <리셋 시각 또는 잠시 뒤>"를 표시한다. 다른 엔진으로 자동 전환하지 않는다.
  - **일시 장애(503·529 과부하):** notice "Grok 서버 혼잡 — 잠시 뒤 다시"만 낸다. 쿨다운도 자동 재시도도 하지 않는다.
  - **인증:** §5 문구. 재시도하지 않는다.
  - **프로세스 비정상 종료:** stderr 끝 4KB 를 `redact` 를 거쳐 붙인다.
- 실패한 턴의 부분 출력과 파일 변경은 보존한다. 자동 재시도는 하지 않는다.
- **총사령탑:** Grok 세션은 `commander_engine` 으로 거부한다(지금 규칙 그대로).
  - 이유: 자동 턴 게이트가 PreToolUse 훅에 기대는데, Grok 훅은 fail-open 이다(`10-hooks.md:166`, `22-permissions-and-safety.md:430`).
  - 다음 버전에서 쓰려면 §4.2 경로로 게이트를 건다. 그 전에 S13 에서 승인 없이 실행되는 범위를 확정해야 한다.

## 9. 손댈 곳

- `shared/models.ts`:
  - `GrokModel`(`'grok'`), `GROK_MODELS`, `DEFAULT_GROK_MODEL`, `GROK_CLI_ALIAS`(빈 매핑으로 시작).
  - `MODEL_LABEL`·설명·`MODEL_EFFORTS`·`DEFAULT_EFFORT`.
  - `EngineKind` 에 `'grok'`, 그리고 `isGrokModel`.
- `shared/accounts.ts`: `GrokAccount = 'x1'`, `isGrokAccount`, `GROK_LABEL`, `grokEnv`(허용 목록), `Seat`, 예약 id.
- `shared/protocol.ts`:
  - send 의 `engine` enum 에 `'grok'`.
  - `hello.grok { bin: boolean; version?: string; loggedIn?: boolean | null }`.
  - `features` 에 `'grok'`. binary 가 있을 때만 넣는다.
- `SessionState.ts`: `GrokSessionState`, `isGrokState`.
  - 저장 필드: `engine:'grok'`, `model`, `effort`, `permissionMode`, `grokSessionId`, `canonicalCwd`.
- `TurnRunner.ts`: grok 분기, §8 분류, 쿨다운.
- `ws.ts`: 새 세션·이어 하기·history·승인 응답·steer 분기.
- `config.ts`·`main.ts`: binary 를 찾고 엔진을 연결한다.
- `Commander.ts`: 변경 없음. grok 거부 테스트만 추가한다.
- UI:
  - `EngineMark`, `ModelPicker`, `NewChat`, `AccountPicker`(x1).
  - `UsagePanel`: "사용량 모름".
  - 모드 설명에 S13 결과를 넣는다.
  - `ui/state.ts`.
- 문서:
  - `docs/grok-spike.md`(새 파일).
  - `docs/protocol.md`.
  - `README.md`: 설치(`curl -fsSL https://x.ai/cli/install.sh | bash` → `grok login`)와 보안 메모(프로젝트 `.grok/` 정책).

## 10. 스파이크 (설치·로그인 뒤, 구현 전에 먼저)

진행 방식:
- `docs/grok-spike.md` 에 grok 버전과 함께 기록한다. 원문 로그는 테스트 픽스처로 저장하되, 자격 정보와 개인 경로는 지운다.
- 모두 임시 디렉터리에서 하고, 자격 파일은 열지 않는다.
- 로그아웃 상태 실험은 빈 임시 `GROK_HOME` 으로 한다. 실제 로그인 상태는 건드리지 않는다.

항목:
- **S1. ACP 왕복:**
  - 승인 없이 끝나는 질문 하나로 initialize → new → prompt → update 순서를 본다. `_meta.usage` 가 턴별인지 누적인지도 본다.
  - **승인이 필요한 무해한 동작**(임시 디렉터리에 파일 쓰기, default 모드)으로 허용·거부·취소를 각각 본다. 요청의 options(optionId·kind) 모양을 기록한다.
  - 세션 디렉터리 이름 규칙(URL 인코딩, 255바이트 초과 시 slug+hash)을 확인한다.
- **S2. 로그인·제공자:**
  - 빈 `GROK_HOME` 에서 session/new 의 오류(`auth_required` 의 code·message)와 `grok models` 종료 코드를 본다.
  - 응답에서 실제 제공자와 모델을 읽을 수 있는지 본다.
- **S3. 모델 목록:** `grok models` 출력, session/new 응답의 configOptions.
- **S4. 비용·종료:**
  - 20턴 세션의 `session/load`(noReplay) 시간.
  - stdin 을 닫은 뒤 스스로 끝나기까지의 시간. 끝나기 전에 죽였을 때 `updates.jsonl` 의 꼬리가 어떤지.
- **S5. 하위 에이전트:** 자식 업데이트와 자식의 승인 요청이 와이어에 어떻게 보이는지.
- **S6. Claude 호환 끄기:**
  - 거짓 값 철자(`false`/`0`)를 확인한다.
  - 임시 cwd 에 `.mcp.json` 과 표식 훅을 두고, `~/.claude/settings.json` 훅이 돌지 않는지 본다. 표식 훅은 임시 파일에 한 줄 쓰는 것이다.
- **S7. steer·cancel:**
  - interject 의 ACK 의미와 소비 시점, echo 가 있는지, 같은 interjectionId 를 두 번 보내면 어떻게 되는지.
  - 턴이 끝나기 직전에 보낸 steer 가 어떻게 되는지.
  - cancel 뒤의 stopReason 과 늦게 오는 승인 요청.
- **S8. 한도 오류 모양:** 일부러 일으키지 않는다. 소스의 문자열만 기록하고, 실제 관측은 생기면 추가한다.
- **S9. 프로젝트 `.grok/`:**
  - 임시 저장소에 표식 훅(SessionStart·PreToolUse), allow 규칙, 모드 설정을 둔다. ACP 모드에서 적용되는지, 신뢰를 묻는지, 끄는 env·플래그가 있는지 본다.
  - Grok 이 어느 상위 폴더까지 읽는지도 본다.
- **S10. 모드 설정:**
  - 모드를 바꾸는 메서드와 응답 모양을 본다.
  - 임시 `GROK_HOME` 의 config.toml 기본 모드를 bypass 로 두고, deck 의 모드 설정이 이기는지 본다.
  - 계획 종료 요청의 모양을 본다.
- **S11. 동시성:** 같은 세션을 두 프로세스가 load 할 때 잠금과 오류. 터미널 grok 이 같은 세션을 열고 있을 때.
- **S12. 정리:** cancel 과 그룹 kill 뒤 자식 프로세스(bash, MCP, 하위 에이전트)가 남는지.
- **S13. 승인 없이 실행되는 범위:** default·acceptEdits·plan 각각에서 승인 요청 없이 실행되는 도구.
- **실패 주입:**
  - 각 단계에서 강제 종료한다(initialize·load·prompt 중, 기록 중).
  - 승인 직후 바로 취소한다.
  - 개행 없이 큰 stdout 을 보낸다(가짜 에이전트로).

**결정 지점:**
- S1 에서 승인 요청 흐름이 안 되면, 원인을 구분해 기록한다(모드, 구독 제한, 프로토콜 차이). 그리고 **사용자에게 기능 범위를 다시 물은 뒤** B 를 검토한다.
- S9 에서 프로젝트 설정을 끄는 방법이 없으면 §5 의 fail-closed 막기를 그대로 구현한다.
- S10 에서 모드 확인이 불가능하면 v1 을 멈추고 다시 설계한다.

## 11. 테스트

- **`AcpConnection.test.ts`** (가짜 에이전트 node 스크립트, 임시 디렉터리):
  - 짝짓기, 알림, 요청별 시간 한도, backpressure.
  - 승인 처리기가 기다리는 동안 다른 메시지를 계속 받는지.
  - JSON 아닌 줄을 건너뛰는지, 8MB 를 넘으면 연결 오류인지, 종료 때 정리되는지.
- **`GrokEngine.test.ts`** (S1 픽스처를 재생하는 가짜 에이전트):
  - 변환: 도구 상태 병합, 결과를 한 번만 내는지, 끝까지 terminal 이 안 된 도구, 재생분 버리기.
  - stopReason 별 결과.
  - 권한 모드 확인 실패 시 프롬프트를 보내지 않는지, 턴 도중 모드가 바뀌면 취소하는지.
  - 승인:
    - once·deny·넓은 옵션만 있음·모르는 toolCallId.
    - 자동 승인이 예외(계획 종료 등)를 카드로 보내는지.
    - 취소 뒤 늦은 답·늦은 요청이 cancelled 로 가는지, 응답을 한 번만 보내는지.
  - load 실패가 오류로 끝나는지(new 로 넘어가지 않는지). 새 세션 id 가 프롬프트 전에 저장되는지.
  - steer 의 각 경로와 PromptResponse 뒤 false. 중단 → cancel 알림 → 그룹 종료 순서.
  - 시작 단계 중단. 잠금 직렬화. 그룹 kill 뒤 가짜 자식 프로세스가 남지 않는지.
  - §8 분류(429 한도·503 혼잡·인증·도구 출력의 숫자 무시).
  - 첨부 이미지 capability.
- **`grokEnv` 테스트:** 허용 목록 밖의 env 가 빠지는지, 셸 `GROK_HOME`·`XAI_*` 를 무시하는지, 호환 끄기 값.
- **프로젝트 `.grok/` 막기 테스트:** cwd·상위·git 루트 경계.
- **`grokTranscript.test.ts`:** 픽스처, 후보 선택, symlink 거부, 64MB 상한, 쓰는 중인 마지막 줄, 없음·손상·모르는 형식 구분.
- **기존 테스트 확장:** ws 의 grok 생성·이어 하기·history·승인·steer, Commander 의 grok 거부, UI.
- 실제 `grok` 이나 실제 `~/.grok` 을 쓰는 테스트는 없다. 위생 테스트는 그대로 통과해야 한다.

## 12. 보안 메모

- 프롬프트는 JSON-RPC 본문으로만 간다. argv 에는 들어가지 않는다.
- sessionId 는 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` 를 통과해야 쓴다. load 할 때와 이력 경로를 만들 때 모두 검사한다.
- 에이전트 요청 가운데 처리하는 것은 `session/request_permission` 뿐이다. 나머지(`fs/*`, `terminal/*` 등)는 "method not found" 로 답한다.
- bypass 계열 모드와 넓은 허용 옵션은 쓰지 않는다. 권한 모드를 확인할 수 없으면 시작하지 않는다.
- env 는 허용 목록 방식이다. 프로젝트 `.grok/` 는 끄거나 막는다.

## 13. 검토 반영 기록 (개정 1판)

| 지적 (출처) | 반영 |
|---|---|
| 같은 세션 동시 실행·저장 경계 (둘 다) | §2-1 잠금, §2-7 그룹 종료 후 해제, §2-4 id 선저장, S11 |
| 권한 모드 미확인 (둘 다) | §2-5 fail-closed, §3 모드 변경 감시, S10 |
| 프로젝트 `.grok/` (둘 다) | §5 끄기 또는 fail-closed 막기, S9 |
| 프로세스 트리 정리 (둘 다) | §2-2 detached 그룹, §2-7 그룹 kill, S12 |
| 취소·승인 경합 (Astra) | §4.2 취소 우선 고정·응답 직전 재검사·응답은 한 번만, §7 cancel 은 알림 |
| RPC 교착 (Astra) | §2.1 받기와 처리 분리, 시간 한도, backpressure |
| S1 전환 조건 (Astra) | §10 승인이 필요한 동작으로 검증, B 는 사용자 재합의 |
| env 블랙리스트 (Claude) | §5 허용 목록 |
| 감사 시점 (Claude) | §4.2 in_progress·terminal 시점에 판정 |
| 하위 에이전트 승인·계획 종료 (Claude) | §4.2 모르는 id 도 카드, 자동 승인 예외 |
| steer 경합 (둘 다) | §7 delivered 근거를 S7 로, PromptResponse 뒤 false, 되돌리기 |
| load 실패 (둘 다) | §2-4 오류로 끝냄, new 로 넘어가지 않음 |
| 503 과잉 해석 (둘 다) | §8 혼잡 notice, 쿨다운 없음 |
| JSON 아닌 줄 (Claude) | §2.1 건너뛰고 개수만 셈 |
| 이력 방식·경로 (둘 다) | §7 직접 파싱, realpath 경계, `.cwd` 불신, 쓰는 중인 줄, 결과 셋 구분 |
| 종료가 빠름 (Claude) | §2-7 10s, S4 에서 조정 |
| 도구 업데이트 병합 (Astra) | §3 상태 병합, 처음 terminal 에서 한 번, rawInput 정규화 |
| 모델·첨부·사용량 (Astra) | §6 실제 모델 확인, §7 첨부 capability, §3 usage 의미 확인 전 미표시 |
| 구독 전용 보장 (Astra) | §5 custom provider 확인 notice, S2 |
| 실패 주입 (Astra) | §10 실패 주입 목록 |

## 14. 개정 2판 — 스파이크 반영 (2026-10-18)

근거: `docs/grok-spike.md` "설계 수정 필요" 1–18. §10 결정 지점 "S10 에서 모드 확인 불가 → 재설계"에 해당해 권한 구조를 바꾼다. 이 절이 앞 절과 다르면 이 절이 이긴다.

### 14.1 권한 관문을 deck 쪽으로 옮긴다 (§4.1·§5 대체)

**원칙:** Grok 세션 모드는 언제나 Grok `default`(모든 쓰기·셸에 승인 요청)로 둔다. deck 의 네 모드는 **deck 이 승인 요청에 어떻게 답하느냐**로만 구현한다. 그래서 `set_mode` 확인이 필요 없다(계획 모드 제외).

1. **HOME 격리(필수).** 실제 HOME 을 넘기면 `~/.claude/settings*.json` 의 allow 규칙과 `defaultMode` 가 들어와 승인 요청이 아예 오지 않는다(스파이크 수정 1). 끄는 env 는 없다.
   - grok 자식의 `HOME` 은 deck 이 만든 그림자 폴더 `<configDir>/homes/grok/` 다. `GROK_HOME` 은 지금처럼 좌석 값(기본 `~/.grok` 실경로)이라 로그인은 유지된다.
   - 그림자 폴더에는 **허용 목록의 심링크만** 둔다: `.gitconfig`, `.config/git`, `.ssh`, `.gnupg`, `.npmrc` (실제 HOME 에 있을 때만). `.claude`·`Library`·`.codex`·`.gemini`·`.grok`·`.config/deck` 은 절대 두지 않는다.
   - 매 spawn 전에 그림자 폴더를 점검한다: 허용 목록 밖 항목이 있으면(Grok 이 만든 캐시 폴더 제외 — 아래) 그 항목이 `.claude` 이거나 심링크면 지우고, 허용 목록 심링크의 대상이 바뀌었으면 다시 건다. 그림자 폴더가 심링크이거나 소유자가 다르면 턴을 시작하지 않는다.
   - Grok 이 그림자 HOME 에 쓰는 파일(`.cache` 등)은 그대로 둔다. `.claude` 라는 이름만은 매번 지운다.
   - 공용 모듈 `src/server/engine/shadowHome.ts` 로 만든다. Gemini 두 번째 계정(g2)도 같은 모듈을 쓴다(링크 목록만 다름, `Library` 는 거기서도 금지).
   - 대가: 도구 셸의 `~` 가 그림자 폴더를 가리킨다. macOS 키체인 기반 git https 자격(osxkeychain)은 실패할 수 있다(ssh 는 `.ssh` 링크와 `SSH_AUTH_SOCK` 으로 동작). README 와 Grok 모드 설명에 적는다. `SSH_AUTH_SOCK` 을 env 허용 목록에 더한다.
2. **설정 층 점검(fail-closed).** `GROK_HOME/config.toml` 의 `[ui] permission_mode`·`auto_mode.enabled` 등이 기본값을 auto 로 만들 수 있다.
   - spawn 할 때와 같은 env·cwd 로 `grok inspect --json` 을 돌려(서버 프로세스 시작 뒤 첫 Grok 턴, 그리고 `config.toml` mtime 이 바뀔 때마다; 결과는 캐시) 다음을 확인한다: 권한 규칙 출처 0개, defaultMode 가 없거나 `default`, auto 모드 꺼짐.
   - 하나라도 아니면 턴을 시작하지 않고 "Grok 설정(~/.grok/config.toml)의 권한 기본값이 자동이라 deck 승인을 보장할 수 없음 — <항목>" 을 보인다.
   - `inspect` JSON 의 정확한 필드 이름은 구현 첫 단계에서 그림자 HOME·임시 cwd 로 한 번 실측해 픽스처로 고정한다. 필드를 찾지 못하면 fail-closed.
   - `session/new`·`session/load` 에 `_meta: { yoloMode: false, autoMode: false }` 를 함께 보낸다(보조 수단, 관문 아님).
3. **모드 구현:**
   | deck | Grok 세션 모드 | 승인 요청에 deck 이 답하는 방식 |
   |---|---|---|
   | 기본(매번 묻기) | default | 모두 카드 |
   | 편집 자동 | default | kind `edit` 이고 대상 경로가 모두 세션 cwd(realpath) 안이면 `allow_once` 자동, 나머지는 카드 |
   | 모두 자동 승인 | default | `isGrokAutoApprovable` 가 참이면 `allow_once` 자동, 나머지는 카드 |
   | 계획 | plan | 아래 14.2 |
   - deck 모드는 deck 이 답할 때 보므로 **턴 도중 바꿔도 다음 승인 요청부터 바로 적용**된다. 개정 1판의 "턴 도중 모드 변경 → 취소"와 "다음 턴부터" 안내는 없앤다(계획 모드로 들어가거나 나오는 변경만 다음 턴부터).
   - `acceptEdits`·`bypassPermissions`·`auto`·`dontAsk` 는 Grok 에 보내지 않는다.
   - 모든 모드에서 승인 없이 도는 범위(읽기 도구, 읽기 셸, `mkdir`·`touch`)를 모드 설명에 적는다(S13).
4. **감사:** `onToolAudit` 은 그대로 둔다. 다만 첫 `tool_call` 에는 kind 가 없으므로(수정 17) kind 는 뒤따르는 `tool_call_update` 에서 채우고, 도구 이름은 `_meta["x.ai/tool"].name` 을 쓴다.

### 14.2 계획 모드
- 들어가기: `session/set_mode { modeId: "plan" }` 뒤 `current_mode_update{currentModeId:"plan"}` 를 10s 안에 받아야 프롬프트를 보낸다. 못 받으면 fail-closed.
- 나오기: Grok 은 `_x.ai/exit_plan_mode { sessionId, toolCallId, planContent }` **요청**을 보낸다(수정 9). deck 은 이것을 "계획 승인" 카드로 띄우고 절대 자동 승인하지 않는다.
- 응답 형식(`ExitPlanModeExtResponse`, 2필드)이 확정되기 전에는 **계획 모드를 deck 선택지에서 숨긴다.** 확정 방법: 그림자 HOME·임시 cwd 에서 후보 응답을 보내 보는 추가 스파이크 S14. 확정되면 픽스처로 고정하고 선택지를 연다.

### 14.3 턴 끝 분류 (§3 stopReason 보완)
`stopReason:"cancelled"` 는 `_x.ai/session/prompt_complete.cancellationCategory` 로 나눈다(수정 4).
- `MidTurnAbort` 또는 deck 이 취소한 경우: ABORTED(지금과 같음).
- `PermissionRejected`: 성공으로 끝내고 notice "승인 거부로 Grok 이 멈춤". 출력은 보존.
- `PermissionCancelled` 이면서 deck 이 취소하지 않음: 위와 같음, 문구 "승인 요청이 취소되어 멈춤".
- category 를 못 받으면 deck 취소 여부로 판정한다.

### 14.4 프로토콜 세부 (§2.1·§3·§7 보완)
- **steer:** 메서드 `_x.ai/interject { sessionId, text, interjectionId }`. 응답은 `result.status === "queued"` 일 때만 성공. echo 알림 `_x.ai/session/interjection` 은 접수 증거일 뿐이다 — deck 은 "전달됨(다음 모델 호출 때 반영)"으로 보인다. 같은 id 는 한 번만 보낸다(Grok 은 중복 제거 안 함). PromptResponse 뒤에는 보내지 않고 false 를 돌려준다.
- **요청하지 않은 턴:** promptId 가 `interject-fallback-` 로 시작하는 턴 알림이 deck 턴 밖에서 오면 즉시 `session/cancel` 을 보내고 로그만 남긴다.
- **재생 표식:** `params._meta.isReplay === true` 인 update 는 버린다. load 응답 전에 온다.
- **id:** 에이전트 요청 id 는 0 부터 온다(falsy 검사 금지). 모르는 id 의 응답(`"skills-reload"` 등)은 버린다.
- **하위 에이전트:** `session/update` 는 `sessionId` 가 부모와 같을 때만 변환한다. 승인 요청은 부모 sessionId 로 오며 `toolCall._meta["x.ai/requestingSessionId"]` 가 부모와 다르면 카드 제목에 "하위 에이전트"를 붙인다. 자동 승인 규칙은 부모와 같다.
- **열린 도구 닫기:** 턴이 끝날 때 terminal 상태를 받지 못한 tool 은 deck 이 닫는다(취소면 cancelled, 그 밖은 failed + "결과 없음").
- **세션 폴더:** 이름을 계산하지 않는다. `GROK_HOME/sessions/*/<sessionId>/` 를 glob 하고 realpath 가 `GROK_HOME/sessions` 안인지 확인한다(이력 읽기).
- **usage:** 턴 단위다. 그대로 쓴다.

### 14.5 종료 순서 (§2-7 보완)
- deck 이 중단할 때: `session/cancel` 알림 → PromptResponse 를 최대 5s 기다림 → stdin 닫기 → 그룹 SIGTERM → 3s → 그룹 SIGKILL. 그룹 kill 만으로는 도구 셸의 자식이 남는다(수정 13).
- 정상 종료는 지금과 같다.

### 14.6 동시 load (§2-1 보완)
- 서버 안 잠금은 그대로다. 터미널의 `grok` 이 같은 세션을 동시에 열면 Grok 은 막지 않고 기록이 섞인다(수정 15). deck 이 막을 수 없으므로 README 에 "deck 이 쓰는 Grok 세션을 터미널에서 동시에 열지 말 것"을 적는다.

### 14.7 그대로 둘 것
- 모델 목록은 `GROK_MODELS`(기본 `grok-4.7`, `grok-4.7-build-fast`·`grok-4.6`·`grok-4.5`)로 이미 반영했다.
- 프로젝트 `.grok/` 는 신뢰 전 무시된다(S9). deck 은 `GROK_FOLDER_TRUST` 를 넘기지 않으므로 §5 의 fail-closed 막기는 **유지**한다(신뢰 상태를 deck 이 알 수 없음). 구현: cwd(realpath)부터 HOME 바로 아래 폴더까지(HOME 밖이면 파일시스템 루트까지), git 루트와 상관없이 위로 올라가며 `.grok`·`.cursor` 를 종류 불문(파일·깨진 심링크 포함) 찾는다. 좌석의 `GROK_HOME` 자체인 `.grok` 만 예외다. 하위 폴더는 보지 않는다.
- 호환 끄기 값 `false` 는 맞다(S6). 유지한다.

### 14.8 테스트 추가
- `shadowHome.test.ts`: 허용 목록 링크만 생김, `.claude` 제거, 심링크 그림자 폴더 거부, 링크 대상 변경 재연결, 실제 HOME 에 없는 항목은 만들지 않음.
- inspect 점검: 픽스처 3종(깨끗함·Claude 규칙 있음·auto 기본) → 앞의 것만 통과, 필드 없음 → fail-closed.
- 편집 자동: cwd 안 edit 자동, cwd 밖·symlink 탈출·경로 없음 → 카드.
- cancellationCategory 3종, interject queued/중복/턴 뒤, interject-fallback 취소, isReplay 버림, id 0, 모르는 응답 id, 자식 sessionId 거르기, 열린 도구 닫기, 중단 순서(cancel → 대기 → kill).
- 스파이크 픽스처 `acp/fixtures/grok-1.0.62/` 로 합성 픽스처를 바꾼다.

### 14.9 교차 검토 반영 (개정 2판 검토: Claude·Astra)

**보장 수준을 정직하게 정한다.** 두 검토 모두 "OS 수준 제한 없이는 절대 보장 불가"로 일치했다(Grok 이 스스로 무승인으로 돌리는 읽기 셸·`mkdir`·`touch` 가 있기 때문). v1 의 약속은 다음으로 한정한다: **Grok 이 승인을 묻는 모든 동작은 deck 모드대로 처리되고, Grok 이 묻지 않고 돌리는 범위는 Grok 의 읽기 목록뿐이며, 그 밖의 무승인 쓰기를 감지하면 즉시 멈춘다.** 이것은 deck 의 Claude 엔진(Claude Code 의 읽기 전용 자동 허용)과 같은 신뢰 수준이다. OS 샌드박스(macOS Seatbelt `sandbox-exec`, Linux bubblewrap)는 v1.1 별도 설계로 둔다. 모드 설명과 README 에 이 한계를 적는다.

앞 절을 다음과 같이 바꾼다(이 소절이 이긴다):

1. **그림자 HOME 은 턴마다 새로 만든다**(14.1-1 대체). `<deck 설정 폴더>/homes/grok/<턴 id>/` 를 0700 으로 만들고 허용 목록 심링크만 건다. 부모 경로까지 lstat·소유자·0700 을 확인한다. 턴이 끝나고 그룹 정리가 끝나면 지운다. 서버 시작 때 남은 턴 폴더를 지운다. 정리 규칙(지우기·재링크)은 없앤다. 링크 목록은 `.gitconfig`·`.config/git`·`.ssh` 만 두고 `.gnupg`·`.npmrc` 는 뺀다(필요해지면 추가). `SSH_AUTH_SOCK` 은 허용한다.
2. **inspect 점검은 매 spawn 마다** 같은 env·cwd·그림자 HOME 으로 돌린다(14.1-2 의 캐시 삭제). 출처 0개·기본 모드 default·auto 꺼짐을 확인하지 못하면 fail-closed.
   - 더해서 거부: `hooks`·`mcpServers`·`plugins` 가 비어 있지 않거나 배열이 아님(없음 포함), `permissions.managedSettingsActive` 가 `false` 가 아님, `configSources.layers` 가 비었음, `externalCompat.remoteSettingsLoaded` 가 `false` 가 아님. `config.toml` 의 인라인 테이블(`ui = { permission_mode = "auto" }`)은 안까지 읽고, 읽지 못하면 거부.
   - **외부 호환(`externalCompat.cells`)**: Claude 셀은 deck env(`GROK_CLAUDE_*_ENABLED=false`)로 꺼지므로 Claude hooks·mcps 가 켜져 있으면 env 가 안 먹은 것 — 거부. Cursor 셀을 끄는 env·플래그는 확인된 것이 없고 기본 켜짐(`source: "default"`, 픽스처 clean)이다. 이것은 **먹일 것이 없을 때만** 허용한다: 그림자 HOME 에 `~/.cursor` 가 없고(금지 목록), 프로젝트 가드가 `.cursor/` 를 막고, inspect 의 `hooks`·`mcpServers` 가 비어 있음. Cursor hooks·mcps 가 다른 출처(config·env·remote)로 켜졌거나, 다른 vendor 의 hooks·mcps 가 켜졌거나, 읽을 수 없는 셀이면 거부. rules 셀은 기존 규칙 판정(출처·규칙 수 0)으로 본다.
3. **tripwire(신규).** Grok 세션 모드는 언제나 default(계획 모드 제외)이므로, 같은 toolCallId 의 승인 요청 없이 `in_progress`·terminal 이 된 tool 가운데 kind 가 `edit`·`delete`·`move`·`execute` 이면서 Grok 읽기 목록(S13)에 들지 않는 것은 관문이 샌 증거다. 감지하면 즉시 `session/cancel` → 턴 종료(오류 "Grok 이 승인 없이 쓰기를 실행해 멈춤") → 이 서버 프로세스에서 Grok 엔진을 잠근다(재시작 또는 설정 화면에서 해제). `current_mode_update` 가 deck 이 기대한 모드와 다를 때도 같다(모델이 스스로 plan 으로 들어가는 경우 포함). tripwire 는 **모든 sessionId**(하위 에이전트 포함)에 적용한다.
   - deck 이 `allow_once` 로 답한 toolCallId 집합을 따로 둔다. 승인 요청은 있었지만 허용되지 않은(거부·취소·턴 밖 reject·아직 미응답) id 가 `in_progress`·`completed` 가 되면 kind 와 상관없이 울린다.
   - 읽기 셸 판정: 따옴표·`\`·`$` 가 단어 안에 섞이면(따옴표로 통째로 감싼 단어 하나는 제외) 읽기 전용이 아니다. 실행·출력 플래그(`find -exec` 등, `fd -x/-X/--exec`, `rg --pre`, `ag --pager`, `tree -o`, `sort -o/--output/--compress-program`, `git grep -O/--open-files-in-pager`, `uniq IN OUT`, `file -C`)도 아니다.
   - 울리면 그룹 정리는 graceful 대기 없이 바로 SIGTERM 부터 한다.
4. **편집 자동 거부 목록(신규).** 대상이 다음에 걸리면 항상 카드: `.git/` 아래 전부, `.gitmodules`, `.envrc`, `.env*`, `.claude/`, `.grok/`, `.cursor/`, `.mcp.json`, `.vscode/`, `.idea/`, `.husky/`, `.githooks/`, `node_modules/.bin/`. 비교는 대소문자·NFC 정규화 후 한다. 경로는 요청의 locations 와 rawInput(patch 본문의 모든 파일, 이동의 양쪽)을 모두 모아 판정하고, 하나라도 해석 못 하면 카드. 새 파일은 존재하는 가장 가까운 조상을 realpath 한다. 경계 비교는 경로 구분자 기준. cwd 가 HOME·`/`·HOME 의 조상이면 편집 자동을 끈다. nlink>1 인 기존 파일은 카드. `~` 로 시작, `$` 포함, `scheme:` 형태(`file:`, 드라이브 문자 포함)인 경로와, rawInput 이 읽는 깊이보다 깊게 중첩된 요청도 카드.
5. **턴 밖·모르는 곳의 요청.** 활성 deck 턴이 아니거나(종료 중·interject-fallback·PromptResponse 뒤), sessionId 가 이 턴의 부모·알려진 자식이 아니면 승인 요청은 카드 없이 reject_once(없으면 cancelled)로 답한다. `fs/*`·`terminal/*` 는 광고하지 않고 -32601(기존).
6. **취소와 대기 중 승인.** deck 이 취소하면 열린 승인 요청에 모두 `{outcome:"cancelled"}` 로 답한다(ACP 규약, "allow_once/reject_once 만" 원칙의 유일한 예외). 카드 클릭·자동 승인과 취소는 기존 `answered`·`cancelled` 플래그로 원자 처리하고, 응답 직전에 최신 deck 모드와 턴 상태를 다시 본다. 이미 보낸 승인은 소급하지 않는다.
7. **턴 끝 분류**(14.3 대체). deck 취소가 언제나 이긴다(ABORTED). 그 밖에 `PermissionRejected`·`PermissionCancelled` 는 성공도 사용자 중단도 아닌 **"멈춤: 승인 거부"/"멈춤: 승인 취소"** 상태로 끝낸다(기존 실패 경로에 사유 문구, 출력 보존). category 를 못 받으면 "멈춤: 원인 미확인". category 는 PromptResponse 전후 어느 쪽에 와도 턴 종료 처리 전까지 모은다(PromptResponse 뒤 1s 대기).
8. **steer 표시.** `queued` 는 "접수됨"으로 보인다. "반영됨"은 쓰지 않는다. 턴이 끝날 때까지 반영 근거가 없으면 그대로 둔다. 자동 재전송은 하지 않는다.
9. **자식 프로세스 회수**(14.5 보완). 턴 동안 2s 마다 `ps -A -o pid=,ppid=,pgid=` 로 grok 자손의 pid·pgid 를 모아 둔다. 모든 종료 경로(정상·취소·크래시)에서 그룹 정리 뒤 모은 pgid 마다 SIGKILL 을 보내고, 모은 pid 가 남았는지 확인해 로그한다. kill 직전에 프로세스 표를 새로 읽어, 그 pgid 에 우리가 본 자손 pid 가 아직 있을 때만 보낸다(표를 못 읽으면 그룹 kill 생략·로그). 서버 시작 때의 남은 그림자 HOME 정리는 끝난 뒤에야 턴을 받는다(await).
10. **외부 수정 감지**(14.6 보완). 턴이 끝날 때 세션 `updates.jsonl` 의 크기·mtime 을 저장하고, 다음 턴 시작 때 다르면 notice "이 Grok 세션이 deck 밖에서 수정됨 — 대화가 갈라졌을 수 있음".
11. **계획 모드 재노출 조건**(14.2 보완). S14 에서 응답 형식과 함께 "계획 종료 뒤 `current_mode_update` 가 default 인지"를 확인한다. 계획 모드 중 오는 쓰기 승인 요청은 언제나 카드. 둘 다 확정되기 전에는 숨긴다.

| 지적 (출처) | 반영 |
|---|---|
| 편집 자동이 .git 훅·설정으로 관문을 연다 (둘 다) | 14.9-4 거부 목록 |
| inspect 캐시 우회 (둘 다) | 14.9-2 매 spawn |
| 관문 누수 감지 장치 없음 (Claude) / inspect 는 실행 중 관문 아님 (Astra) | 14.9-3 tripwire |
| 읽기 셸 분류·mkdir 무승인으로 절대 보장 불가 (둘 다) | 보장 수준 한정, OS 샌드박스 v1.1 |
| 공유 그림자 HOME 경쟁·잔존 (둘 다) | 14.9-1 턴별 새 폴더 |
| 경로 판정 누락 (둘 다) | 14.9-4 |
| 턴 밖 요청 (둘 다) | 14.9-5 |
| 취소 시 대기 승인 cancelled 응답 (Astra) | 14.9-6 |
| 거부를 성공으로 처리 (Astra) / 판정 순서 (Claude) | 14.9-7 |
| queued ≠ 반영 (둘 다) | 14.9-8 |
| 자식 회수 (둘 다) | 14.9-9 |
| 동시 load (둘 다) | 14.9-10 감지 + README |
| 계획 종료 뒤 모드 (Claude) | 14.9-11 |
| `.gnupg`·`.npmrc` 노출 (Astra) | 14.9-1 링크 축소 |
| 하위 에이전트 쓰기 감사 (Claude) | 14.9-3 모든 sessionId |
