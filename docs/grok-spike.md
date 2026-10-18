# Grok Build CLI 스파이크 기록

설계: `docs/superpowers/specs/2026-10-18-grok-engine-design.md` §10.
대상: `grok 1.0.62 (1474f9cbdd91)`, macos-aarch64, `grok agent --no-leader stdio`.

공통 조건:
- cwd 는 항상 `mktemp -d` 임시 디렉터리다.
- env 는 허용 목록 + `GROK_DISABLE_AUTOUPDATER=1` + `GROK_CLAUDE_*_ENABLED=false` + 실험 대상 env 만 넘겼다.
- 로그인 상태 실험은 실제 `~/.grok` 을 썼다. 그 안의 설정 파일과 자격 파일은 건드리지 않았다.
- bypass·auto·dontAsk·always-approve 는 쓰지 않았고, `allow_always` 류 옵션도 고르지 않았다.
- 모델 턴은 약 45회 썼다(기본 모델 `grok-4.7`, effort low).

**중요한 전제:** 사용자 `~/.claude/settings.json` 의 권한 설정이 Grok 에 그대로 들어온다(아래 S1 참고). 그래서 승인·모드 실험(S1 허용/거부/취소, S7, S9, S13)은 `HOME` 만 빈 임시 폴더로 바꾸고 `GROK_HOME=~/.grok` 으로 돌렸다. 로그인은 그대로 유지된다.

와이어 픽스처: `src/server/engine/acp/fixtures/grok-1.0.62/`.
- 각 줄은 `{t, dir: in|out|exit, msg}` 이다.
- 홈 경로는 `<HOME>`, 임시 경로는 `<TMP>`, 호스트명·agentId·구독 등급은 자리표시자로 바꿨다. 서명은 `<SIG>` 로 바꿨다.
- `availableCommands` 는 앞 2개만 남겼다.

---

## 설계 수정 필요

1. **HOME 을 그대로 물려주면 사용자 Claude 권한 설정이 Grok 의 권한을 정한다(§4·§5).**
   - 근거: `grok inspect --json` 결과에서 `permissions.sources` 는 `<HOME>/.claude/settings.local.json (settings)` 이고 `loaded: 15` 다(`NotebookEdit` 1개는 건너뜀). Grok 문서는 `~/.claude/settings.json` 과 `settings.local.json` 을 둘 다 무조건 읽는다고 적고 있다(22-permissions §3).
   - `permissions.defaultMode` 도 읽는다. `GROK_CLAUDE_*_ENABLED=false` 로는 꺼지지 않는다(이 경로를 끄는 env 는 바이너리에 없다).
   - 결과: 실제 HOME 으로 돌리면 `session/request_permission` 이 **한 번도 오지 않는다**. write 는 allow 규칙으로 0ms 만에 허용됐고, `rm` 은 Auto 분류기가 허용하거나 차단했다(실행마다 달랐다). `set_mode default` 를 보내도 같았다.
   - HOME 만 임시로 바꾸면 default 모드에서 write·bash 모두 승인 요청이 온다.
   - 설계는 "HOME 패스스루 + 모드 확인"으로 막는다고 봤는데, 이 둘로는 막지 못한다. HOME 격리(그 경우 도구 셸의 HOME 도 바뀌어 git·ssh 설정을 잃는다)나 다른 차단 방법을 정해야 한다.
2. **모드 확인 경로가 없다. §10 결정점 "S10 에서 모드 확인 불가 → v1 중단·재설계"에 해당한다(§2-5·§4.1).**
   - `session/set_mode` 는 어떤 modeId 든(`"nonsense"` 포함) `{}` 로 답한다.
   - `current_mode_update` 는 `plan` 과 `nonsense` 에서만 오고, `default`·`acceptEdits` 와 default 로 되돌릴 때는 오지 않는다.
   - `acceptEdits` 는 받아만 놓고 **적용되지 않는다.** write 가 여전히 승인을 묻는다.
   - `set_config_option` 의 configId `mode`·`permission_mode` 는 -32602 다. `configOptions` 에도 모드 항목이 없고, session/new 응답에 `modes` 도 없다.
3. **세션의 권한 기본값은 deck 이 아니라 설정 층이 정한다.** `[ui] permission_mode`·`auto_mode.enabled`·Claude `defaultMode`·`GROK_AUTO_PERMISSION_MODE`·`GROK_DEFAULT_PERMISSION_MODE` 가 모두 영향을 준다. ACP 로 끌 수 있는 것은 `session/new` 의 `_meta.yoloMode`·`autoMode` 둘뿐이다. 실험에서 `autoMode:false` 로는 Claude 쪽에서 온 auto 를 끄지 못했다.
4. **승인을 거부하거나 취소하면 턴 전체가 끝난다(§3 stopReason).** 둘 다 PromptResponse 가 `stopReason:"cancelled"` 다. `_x.ai/session/prompt_complete` 의 `cancellationCategory` 로 구분된다.
   - 거부: `"PermissionRejected"`.
   - 승인 요청에 `cancelled` 로 답함: `"PermissionCancelled"`.
   - 사용자 cancel: `"MidTurnAbort"`.
   - 설계처럼 cancelled 를 그대로 ABORTED 로 매핑하면 "거부"가 "중단"으로 보인다.
5. **steer 메서드 이름과 echo 가 다르다(§7).**
   - 이름은 `_x.ai/interject` 다(앞에 `_`). `x.ai/interject` 는 -32601 이다.
   - 응답은 `{"result":{"status":"queued"}}` 로 한 겹 더 감싸져 온다.
   - 접수 직후(약 2ms) `_x.ai/session/interjection {sessionId,text,interjectionId}` 알림이 온다. **이것은 접수 echo 이지 소비 증거가 아니다.**
   - 실제 소비는 다음 모델 호출 경계에서 일어난다. 와이어로 오는 신호는 없고, `updates.jsonl` 에만 `user_message_chunk`("The user sent a message while you were working: <user_query>…") 로 남는다. 여기에는 interjectionId 가 없다.
6. **같은 interjectionId 를 두 번 보내도 중복 제거하지 않는다.** 두 번 다 queued 되고, echo 2회·persist 2회·`interjected` 이벤트 2회가 남는다. deck 이 직접 한 번만 보내야 한다.
7. **턴이 끝난 뒤 보낸 interject 는 요청하지 않은 새 턴을 연다.**
   - promptId 는 `interject-fallback-<uuid>` 다. `session/update`·`turn_completed` 는 오지만 PromptResponse 는 없다.
   - PromptResponse 이후 steer 를 false 로 처리하는 설계가 맞다. 다만 경합으로 이런 턴이 생기면 처리할 곳이 필요하다.
8. **재생 표식은 `params._meta.isReplay: true` 다**(`x.ai/replayed` 아님, §3). 재생 update 는 `session/load` 응답보다 먼저 온다. `updates.jsonl` 에는 재생 표식이 없다.
9. **계획 종료는 `session/request_permission` 이 아니다(§4.2·§11).**
   - 별도 요청 `_x.ai/exit_plan_mode {sessionId, toolCallId, planContent}` 로 온다.
   - "request_permission 외에는 -32601"로 답하면 계획이 늘 거부되고 턴이 cancelled 로 끝난다.
   - 응답 형식(2필드 구조체 `ExitPlanModeExtResponse`)은 확정하지 못했다.
10. **에이전트 요청 id 는 0 부터 시작한다.** id 0 을 falsy 로 다루면 안 된다.
11. **모델 목록이 다르다(§6).**
    - 로그인 상태 기본은 `grok-4.7` 이다. 목록은 `grok-4.7`·`grok-4.7-build-fast`·`grok-4.6`·`grok-4.5` 다.
    - 실제 백엔드 이름은 `usage.modelUsage` 키 `grok-4.7-build` 로만 보인다.
12. **세션 디렉터리의 긴 경로 규칙은 계산할 수 없다(§7).** `dir-<slug>-<16hex>` 의 해시는 sha1/sha256/md5/sha512/fnv1a64 어느 것과도 맞지 않았다. `sessions/*/<sessionId>/` 를 glob 으로 찾고 realpath 로 검증하는 방식만 쓴다.
13. **그룹 SIGKILL 뒤에도 도구 셸의 자식이 살아남는다(§2 정리).** 도구 셸은 다른 프로세스 그룹에서 돈다.
    - 실험에서 foreground `sleep` 이 그룹 kill 뒤에도 남았다(직접 정리했다).
    - `session/cancel` 을 먼저 보내면 정리된다. 순서는 cancel → PromptResponse 대기 → 그룹 종료여야 한다.
14. **취소 뒤 열려 있던 도구 호출에는 종료 status 가 오지 않는다.** 승인 직후 cancel 하면 `in_progress` 에서 끝나고, 승인 대기 중 cancel 하면 status 없이 끝난다. deck 이 턴 종료 때 열린 tool 카드를 닫아야 한다.
15. **같은 세션을 두 프로세스가 동시에 로드할 수 있다(S11).** 둘 다 성공한다. 서로의 턴을 보지 못하고 한 파일(`updates.jsonl`)에 이어 쓴다. 대화가 갈라지므로 deck 이 소유자를 하나로 강제해야 한다.
16. **하위 에이전트 update 는 자식 sessionId 로 온다.** 자식의 승인 요청은 부모 sessionId 로 오고, `toolCall._meta["x.ai/requestingSessionId"]` 에 자식 id 가 실린다. deck 은 sessionId 로 걸러야 한다. 거르지 않으면 자식 텍스트가 부모 답변에 섞인다.
17. **tool_call 의 모양이 다르다.** 처음 `tool_call` 에는 `kind`·`status` 가 없다. `kind`·제목·diff 는 뒤따르는 `tool_call_update` 로 온다. 원래 도구 이름은 `_meta["x.ai/tool"].name` 에 있다.
18. **세션 시작 응답 뒤에도 setup 알림이 온다.** 요청하지 않은 id 의 응답(`id:"skills-reload"`)도 온다. 모르는 id 는 무시해야 한다.

---

## S1. 기본 흐름·승인·세션 디렉터리

**관측 (승인 없는 턴, `s1-no-approval-turn.jsonl`):**
- initialize 응답은 약 0.36s 에 온다.
- session/new 는 약 1.0s 걸린다.
  - 그동안 `_x.ai/session/setup` phase 가 `auth → resolve_workspace → folder_trust → plugin_registry → mcp_merge → persistence_init → spawn_session_actor → agent_build → model_switch` 순으로 오고, `available_commands_update` 가 여러 번 온다.
  - 응답 뒤에도 `git_discovery·finalize_response·tool_overrides·response_ready` 가 더 온다.
- prompt 한 턴의 흐름:
  - `_x.ai/queue/changed` → `agent_thought_chunk` → `agent_message_chunk` 들.
  - → `_x.ai/session_notification{response_completed}`(모델 호출마다 한 번) → `turn_completed`.
  - → `_x.ai/session/prompt_complete` → PromptResponse `{stopReason:"end_turn", _meta:{modelId, usage:{…, modelCalls, modelUsage, numTurns}}}`.
- 연속 턴의 outputTokens 는 72, 그다음 31 이었다.

**→ 결론:**
- `_meta.usage` 는 **턴별**이다. 한 턴 안의 모델 호출은 합산된다.
- `_meta` 최상위의 inputTokens 등은 마지막 모델 호출 값이다. 표시는 `usage` 를 쓴다.

**관측 (승인, HOME 격리):**
- write 요청 (`permission-allow.jsonl` 첫 요청):
  - `toolCall.kind` 는 `"edit"`, `rawInput.variant` 는 `"Write"`.
  - options 는 `allow-edits-session`(allow_always) · `allow-once`(allow_once) · `reject-once`(reject_once) 셋이다.
- bash 요청:
  - `kind` 는 `"execute"`.
  - options 는 `always-allow`(allow_always) · `allow-once`(allow_once) · `reject-once`(reject_once) · `reject-always`(reject_always) 넷이다.
- 요청 직전에 `_x.ai/session_notification{pending_interaction, kind:"permission"}` 이 오고, 답한 직후 `interaction_resolved` 가 온다.
- 허용하면 `tool_call_update` 가 `in_progress → completed` 로 간다(rawOutput 포함).
- 거부하면(`permission-reject.jsonl`):
  - `tool_call_update{status:"failed", content:"User rejected the execution for tool \`write\`", _meta:{toolNotRun:"rejected"}}` 가 온다.
  - 이어서 턴이 `cancelled`(PermissionRejected) 로 끝난다.
- `{outcome:"cancelled"}` 로 답해도(`permission-cancel.jsonl`) 같은 모양이다. category 만 `PermissionCancelled` 로 다르다.

**→ 결론:**
- 설계 §4.2 의 kind 기준 선택(allow_once / reject_once)은 그대로 된다.
- 거부와 취소는 턴을 끝낸다(수정 4).
- 실제 HOME 에서는 승인 요청이 오지 않는다(수정 1). `auto-mode-from-claude-settings-no-request.jsonl` 에 그 모습이 있다.

**관측 (세션 디렉터리):**
- 디렉터리는 `~/.grok/sessions/<그룹>/<sessionId>/` 이다.
- 그룹은 **보낸 cwd 문자열 그대로의 `encodeURIComponent`** 다(realpath 아님). `/var/...` 로 보내면 `%2Fvar...` 가 된다.
- 긴 경로(인코딩 745바이트)는 `dir-<마지막 경로 조각 slug>-<16hex>` 가 된다. slug 에서 비ASCII 문자와 `_` 는 `-` 가 된다.
- 그룹 폴더에는 `prompt_history.jsonl` 도 있다.
- 세션 폴더의 파일: `updates.jsonl`(+.lock), `chat_history.jsonl`(+.lock), `events.jsonl`, `rewind_points.jsonl`, `summary.json`, `usage.json`, `signals.json`, `system_prompt.txt`, `prompt_context.json`, `tool_definitions.json` 등.

**관측 (`updates.jsonl` 형식, `updates.6-turns.jsonl`·`updates.interject.jsonl`):**
- 한 줄 모양: `{"timestamp":<unix초>,"method":"session/update"|"_x.ai/session/update","params":{sessionId, update, _meta:{eventId, agentTimestampMs, …}}}`.
- 와이어에는 오지 않는 `user_message_chunk`(`_meta.promptIndex`) 가 있다.
- `turn_completed` 는 `_x.ai/session/update` 로 들어 있다.
- agent 텍스트는 합쳐서 저장된다(6턴에 35줄).

**→ 결론:**
- 이력 복원은 `user_message_chunk`/`agent_message_chunk`/tool 계열을 읽으면 된다.
- 경로 규칙은 수정 12 대로 처리한다.

## S2. 로그인 상태 인증·제공자

**관측:**
- `authMethods` 는 다음 둘이다. `_meta.defaultAuthMethodId` 는 `"cached_token"`.
  - `{id:"cached_token", description:"Cached token from ~/.grok/auth.json"}`.
  - `{id:"grok.com", name:"Grok"}`.
- 응답에 제공자(provider) 필드는 없다. 모델은 PromptResponse `_meta.modelId`(`grok-4.7`)와 `usage.modelUsage` 키(`grok-4.7-build`)에서 읽힌다.
- initialize `_meta` 에는 hostname·agentId·agentInstanceId·cwd 가 있다.
- `_x.ai/settings/update` 에는 구독 등급 표시 필드가 있다(값은 기록하지 않았다).

**→ 결론:**
- 로그인 여부는 `authMethods` 에 `cached_token` 이 있는지로 미리 볼 수 있다.
- 로그 출력에서는 initialize `_meta` 와 `settings/update` 를 걸러야 한다.

## S3. 모델·설정 모양

**관측:**
- `models.availableModels` 와 `initialize._meta.modelState` 내용:

  | modelId | 설명 | effort |
  |---|---|---|
  | `grok-4.7` (기본) | latest frontier | xhigh/high/medium/low |
  | `grok-4.7-build-fast` | Fast variant, 2x price | xhigh/high/medium/low |
  | `grok-4.6` | | xhigh/high/medium/low |
  | `grok-4.5` | | high/medium/low |

  - 컨텍스트는 `totalContextTokens` 256000, contextWindows `[256000, 500000]` 이다. 기본 effort 는 high.
- session/new 결과 키는 `sessionId, models, configOptions, _meta` 다. **`modes` 는 없다.**
- configOptions:
  - `{id:"model", category:"model", type:"select", currentValue, options[{value,name}]}`.
  - `{id:"reasoning_effort", category:"thought_level", …}`.
- `set_config_option` 은 `value:"low"` 같은 문자열로도 된다(문서 예시는 `{value:"high"}`). 응답은 전체 `{configOptions}` 이고, 뒤이어 `config_option_update` 와 `_x.ai/session_notification{model_changed}` 가 온다.

**→ 결론:** 모델·effort 는 설계대로 set_config_option 으로 바꾸고 응답으로 확인한다. 모델 표는 수정 11 대로 고친다.

## S4. load·종료·kill

**관측:**
- 6턴 세션의 측정값 (HOME 격리 상태):
  - initialize: 1.3–1.8s.
  - `session/load` + `_meta.noReplay:true`: 0.55s. 재생 update 0개.
  - 재생 load: 0.82s. update 12개.
- stdin 을 닫으면 3.25s 뒤 code 0 으로 끝난다.
- prompt 스트리밍 중에 그룹 SIGKILL 을 보내도 `updates.jsonl` 은 줄 단위로 온전했다. 끝이 개행이고, 마지막 줄은 `user_message_chunk` 다.
  - `.lock` 파일 5개가 남지만, 다시 load 하면 0.55s 에 성공하고 다음 prompt 도 정상이다.

**→ 결론:**
- 마지막 줄이 깨질 가능성에 대비한 관용 파싱은 유지한다.
- lock 파일은 무시해도 된다.
- 종료 대기는 5s 이상으로 잡는다.

## S5. 하위 에이전트

**관측 (`subagent.jsonl`):**
- `spawn_subagent` 자체가 승인을 묻는다(`kind:"other"`, `variant:"Task"`).
- 진행 알림: `_x.ai/session_notification{subagent_spawned → subagent_progress → subagent_finished}`.
- 자식의 update(`user_message_chunk` 포함)는 **자식 sessionId** 로 온다.
- 자식 도구의 승인 요청은 부모 sessionId 로 오고, `x.ai/requestingSessionId` 에 자식 id 가 실린다.

**→ 결론:** 수정 16.

## S6. Claude 호환 끄기 값

**관측 (실제 HOME):**
- 끄지 않았을 때 들어온 것:
  - `~/.claude` 의 Claude.md 가 프롬프트에 들어왔다.
  - Claude MCP 에 연결을 시도했다.
  - 전역 UserPromptSubmit 훅이 실행됐다.
  - 명령이 96개였다(Claude skills 포함).
- `false` 와 `0` 둘 다 MCP·훅·rules 를 막았다. 명령은 51개로 줄었다.
- **권한 규칙과 defaultMode 는 어느 값으로도 막히지 않는다**(수정 1).
- 남은 skills 는 Grok 자체 플러그인에서 온다.

**→ 결론:**
- `GROK_COMPAT_OFF='false'` 는 맞는 철자다(`0` 도 된다).
- 이것만으로 격리는 끝나지 않는다.

## S7. steer·cancel

**관측:**
- interject 의 ACK·echo·중복·턴 뒤 동작은 수정 5–7 에 적었다. 픽스처는 `interject-midturn-dup-and-postturn.jsonl` 이다.
- 턴 도중 보낸 steer 는 같은 턴 안에서 반영됐다(modelCalls 2, end_turn 한 번).
- 스트리밍 중 `session/cancel` 알림을 보내면 7–125ms 뒤 PromptResponse `cancelled`(MidTurnAbort) 가 온다.
- 승인 대기 중에 cancel 하면(`permission-pending-then-session-cancel.jsonl`):
  - Grok 이 스스로 `interaction_resolved` 를 내고 턴을 끝낸다.
  - 1.5s 뒤 보낸 늦은 allow 답은 무시됐고, 파일은 생기지 않았다.
- 승인 직후 cancel 하면(`allow-then-session-cancel.jsonl`): 실행 중이던 셸이 죽고 결과 파일이 생기지 않았다.
- cancel 뒤에 새 승인 요청은 오지 않았다.

**→ 결론:**
- 설계 §4.2 의 "취소 우선 고정"은 유지한다.
- Grok 쪽도 늦은 답을 버린다.
- 열린 tool 카드 정리가 필요하다(수정 14).

## S8. 한도 오류

**관측:** 실험 중에 한도 오류는 나오지 않았다. → 기록할 것이 없다.

## S9. 프로젝트 `.grok/`

방법: `mktemp -d` 안에 git 저장소를 만들었다. 넣은 것은 `.grok/hooks/marker.json`(SessionStart·PreToolUse 가 표식 파일을 만든다), `.grok/config.toml [permission] allow=["Bash(printf *)"]`, `AGENTS.md` 이고, cwd 는 `repo/a/b` 로 했다.

**관측:**
- 기본(신뢰 안 됨) 상태에서는 아무것도 로드되지 않았다. `inspect` 결과는 `projectTrusted:false`, hooks 0, permission sources 0, 지시문 0 이었다.
  - ACP 에서도 표식 파일이 생기지 않았고, bash 는 승인을 물었다.
  - **`folder_trust` 요청은 클라이언트로 오지 않았다**(setup phase 만 있다).
- `GROK_FOLDER_TRUST=0` 이면 저장소 루트(2단계 위)의 훅·allow 규칙·AGENTS.md 가 모두 로드됐다. SessionStart·PreToolUse 표식이 둘 다 생겼다.
  - `printf hi > c.txt` 는 리다이렉트 때문에 여전히 승인을 물었다.
- 문서상 읽는 범위는 저장소 루트부터 cwd 까지 모든 폴더다. 저장소 밖이면 실행 폴더만 읽는다.
- `grok agent` 에는 `--trust` 가 없다.
- 저장소가 아닌 임시 폴더는 `inspect` 에서 `projectTrusted:true` 로 나왔다.

**→ 결론:**
- deck 은 `GROK_FOLDER_TRUST` 를 넘기지 않아야 한다. 허용 목록에서 빠지므로 지금 설계로 충족된다.
- 신뢰 여부는 `~/.grok/trusted_folders.toml` 에 달려 있다. 사용자가 TUI 에서 신뢰를 준 저장소는 ACP 에서도 훅이 돈다(미검증, 문서 근거).

## S10. 모드 설정

**관측:**
- set_mode 와 set_config_option 의 동작은 수정 2 에 적었다. 픽스처는 `set-mode-probe.jsonl` 이다.
- plan 에서는 `current_mode_update{currentModeId:"plan"}` 가 오고, 모델이 세션 폴더의 계획 파일을 `search_replace` 로 쓴다.
  - 그다음 `exit_plan_mode` 도구가 `pending_interaction{kind:"plan_approval"}` 와 `_x.ai/exit_plan_mode` 요청을 낸다. -32601 로 답하면 턴이 cancelled 로 끝난다(`plan-mode-exit-request.jsonl`).
- 설정 기본값이 bypass 일 때 deck 모드가 이기는지는 **미검증**이다. bypass 를 쓰지 않는다는 규칙 때문이다.
  - 같은 모양의 근거는 있다. 실제 HOME 에서는 Claude `defaultMode:"auto"` 가 기본이 되는데, `set_mode default` 를 보내도 auto 판정이 계속됐다.

**→ 결론:** 수정 2·3·9.

## S11. 동시 load

**관측:**
- 두 프로세스가 같은 세션을 `noReplay` 로 동시에 load 했고, 둘 다 성공했다.
- A 의 턴 update 는 B 에 오지 않았다.
- B 에게 직전 답을 물으니 A 의 답(ALPHA) 대신 자기 기억의 "6" 을 말했다.
- `updates.jsonl` 은 두 프로세스의 기록이 섞였지만 줄은 모두 유효한 JSON 이었다.

**→ 결론:** 수정 15. 같은 세션에는 deck 프로세스가 하나만 붙도록 열쇠 잠금이 필요하다.

## S12. 남는 자식 프로세스

**관측:**
- foreground `sleep` 실행 중에 `session/cancel` 을 보내면 1.5s 안에 sleep 이 사라졌다.
- 같은 상황에서 `process.kill(-pgid, SIGKILL)` 을 보내면 **sleep 이 남았다**.

**→ 결론:** 수정 13.

## S13. 모드별 무승인 범위 (HOME 격리)

**관측:**
- `default`: write·bash(`printf > file`)·`rm` 모두 승인을 물었다.
- `acceptEdits`(set_mode): write 도 물었다. 모드가 적용되지 않았다.
- `plan`: 쓰기 대신 계획 파일만 썼고, 종료할 때 plan_approval 이 나왔다.
- 문서상 모든 모드에서 승인 없이 도는 것:
  - 도구: `read_file`·`list_dir`·`grep`·`web_search`·`todo_write`·skill 호출.
  - 셸: `ls`·`cat`·`git status/log/diff` 같은 읽기 셸, 그리고 `mkdir`·`touch`.
- 실제 HOME(auto)에서는 write 0ms 자동 허용, `rm` 은 분류기 판정이었다.

**→ 결론:**
- 모드 선택지 설명에 위의 읽기 목록을 넣는다.
- `acceptEdits` 는 지금 상태로 제공할 수 없다.

## 실패 주입

**관측:**
- initialize 도중 SIGKILL: 메시지 0개, `sig:SIGKILL`.
- load 도중 SIGKILL: 즉시 종료.
- prompt 도중 SIGKILL: S4 와 같다(파일 온전, 다시 load 가능).
- 승인 직후 cancel: S7 과 같다(셸 종료, 결과 없음, tool 은 in_progress 로 남는다).

**→ 결론:** 시작 단계 실패는 exit 이벤트로 잡으면 된다. 세션 파일은 kill 에 강하다.

## 그 밖에

- headless `grok -p` 에서도 파일이 만들어졌다. 실제 HOME 의 Claude allow 규칙 때문으로 보인다. 설계의 "headless 는 자동 거부"는 이 환경에서 성립하지 않았다.
- 로그아웃 상태(빈 임시 `GROK_HOME`)의 관측은 이전과 같다.
  - `grok models` 는 종료 코드 0 에 `You are not authenticated.` 를 출력한다.
  - session/new 는 `-32000 Authentication required` 다.
  - `promptCapabilities.image:false` 다.
- 설치 스크립트는 `~/.grok/bin`, `~/.local/bin` symlink, `~/.zshrc` PATH 블록을 만들고, `[cli] installer` 를 기록한다.

## 못 한 것

- plan 종료 요청 `_x.ai/exit_plan_mode` 의 응답 형식.
- bypass 기본값에서의 모드 우선순위. 규칙상 하지 않았다.
- 한도 오류(S8).
- TUI 로 신뢰를 준 저장소에서 ACP 가 어떻게 동작하는지(S9). 실제 신뢰 저장소를 만들지 않았다.
