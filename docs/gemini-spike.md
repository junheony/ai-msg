# Gemini 엔진 — Antigravity CLI (agy 1.4.2)

deck 의 세 번째 엔진. **명시 선택 전용** — 엔진 선택에서 "Gemini" 를 고를 때만 쓰이고, 자동(모델 자동·엔진 자동)은 절대 Gemini 로 열지 않는다.

Google 이 2026-06-18 에 개인 계정(무료·AI Pro·Ultra)용 gemini-cli 서비스를 끝냈다(`IneligibleTierError … migrate to the Antigravity suite`). 그래서 deck 은 후속인 **Antigravity CLI `agy`** 를 쓴다. 처음엔 1.3.5 바이너리 심볼로 설계했고, **2026-10-18 에 1.4.2 로그인 상태에서 실측**했다(아래 "실측" 절, 픽스처 `src/server/engine/fixtures/agy-1.4.2/`).

## 설치

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash   # → ~/.local/bin/agy
```

deck 은 `DECK_GEMINI_BIN` → `PATH` 의 `agy` → `~/.local/bin/agy` 순으로 찾는다(`gemini` 는 더 찾지 않는다). 없으면 Gemini 선택지 자체가 숨겨진다.

## 로그인 (사용자가 직접 — deck 은 로그인하지 않는다)

```sh
unset GEMINI_API_KEY GOOGLE_API_KEY   # 키가 있으면 키를 쓴다 (deck 은 자식 env 에서 지운다)
agy                                   # 인자 없이 → 브라우저에서 Google 로그인 → 종료
```

- 자격은 **OS 키체인**(macOS Keychain)에 저장된다 — 파일이 없다. 설정·상태는 `~/.gemini/antigravity-cli/`.
- 첫 로그인 때 `~/.gemini/antigravity-cli/settings.json` 에 `trustedWorkspaces: [<HOME>]` 가 생긴다(실측). **신뢰 폴더 밖에서는 accept-edits 여도 파일 쓰기가 거부된다**(아래 4).
- 계정 전환: `agy` 안에서 `/logout` 후 다시 로그인.
- **Mac 한 대에 Google 계정 하나.** deck 의 `g1`/`g2` 두 칸 중 실제로는 `g1` 만 쓰이고 `G2` 자리는 항상 "로그인 안 됨"(세션 레코드 호환 때문에 id 만 남겨 둠).
- 로그인 판정: `agy models` 프로브(종료 코드 0 = 로그인). **로그인 상태에서 종료 0 실측 확인.** "Fetching available models..." 는 stderr, 목록은 stdout(`models.txt`).

## 동작 (현재 코드 기준)

| 항목 | 방식 |
|---|---|
| 헤드리스 | `agy -p=<프롬프트> --output-format stream-json --model <alias> --effort <low\|medium\|high> [--mode accept-edits --sandbox] --disable-slash-commands --print-timeout 0 [--conversation <id>]`. `-p` 는 **반드시 `-p=` 한 argv 요소**. stdin 은 바로 닫는다. |
| 스트림 | 한 줄 = `{"event":"<이름>",…,"<이름>":{…}}`. 실제 필드는 아래 "실측 1". |
| 이어하기 | `--conversation <id>` — 실측 동작 확인(같은 id 로 `init`, `step_index` 가 이어짐, 이전 턴 기억함). |
| 권한 | 읽기 전용 → `--mode` 없음(헤드리스 기본 거부가 쓰기·셸을 막는다), 파일 편집 허용 → `--mode accept-edits --sandbox`. 거부는 턴 알림(`Gemini가 거부함: 파일 쓰기` 등)으로 보인다. `--dangerously-skip-permissions` 는 절대 쓰지 않는다. 실제 효과는 "실측 4". |
| 인증 | 키체인 로그인만. API 키/Vertex/ADC/베이스 URL 변수와 gemini-cli 잔재는 자식 env 에서 제거. |
| 미로그인 | stderr `authentication required. Run 'agy' to log in` + result `error: "authentication failed or timed out"`(1.3.5 실측). print 모드는 브라우저 로그인을 60초 기다리며 멈춘다 → 턴·`/usage` 모두 로그인 프로브가 참일 때만. |
| 한도 | 오류 문구에 quota / rate limit / RESOURCE_EXHAUSTED / 429 가 있으면 그 계정을 메모리에서 쿨다운. (한도 초과 실물은 아직 못 봄.) |
| 잔여 한도 카드 | `agy -p=/usage --output-format json` — 서버 시작 때, 5분마다, Gemini 턴이 끝난 4초 뒤. 실제 응답은 "실측 2". |

## 실측 (2026-10-18, agy 1.4.2, 로그인 상태)

픽스처는 모두 `src/server/engine/fixtures/agy-1.4.2/`. 홈 경로는 `<HOME>`, 임시 폴더는 `<HOME>/work`·`<TMP>/work` 로 치환했다(경로가 걸친 `text_delta` 조각은 합쳐서 치환 — 조각을 이으면 `result.response` 와 같다). 각 턴은 deck 이 넘기는 인자 그대로, cwd 는 `mktemp -d`.

| 픽스처 | 인자 요약 | cwd |
|---|---|---|
| `01-plan-simple.jsonl` | `gemini-4-argon` medium, `--mode plan --disable-slash-commands`, "2+2?" | /var/folders 임시 |
| `02-accept-edits-untrusted-denied.jsonl` | `gemini-4-argon` medium, `--mode accept-edits --sandbox --disable-slash-commands`, hello.txt 쓰기 | /var/folders 임시(신뢰 밖) |
| `03-accept-edits-write.jsonl` | 위와 같음 | `$HOME` 아래 임시(신뢰 안) |
| `04-plan-write-denied.jsonl` | `gemini-4-argon` high, `--mode plan --disable-slash-commands`, 파일 읽고 쓰기 시도 | `$HOME` 아래 임시 |
| `05-error-effort-xhigh.jsonl` | `gemini-3.8-flash` **xhigh**, `--conversation <03의 id>` | 〃 |
| `06-resume-shell-denied.jsonl` | `gemini-3.8-flash` high, accept-edits, `--conversation <03의 id>`, `ls -1` 실행 요청 | 〃 |
| `07-error-invalid-model.jsonl` | `--model gemini-pro` (deck id 를 그대로) | /var/folders 임시 |
| `08-plan-mode-no-slash-flag.jsonl` | 04 와 같되 `--disable-slash-commands` **없이**, effort low | `$HOME` 아래 임시 |
| `usage.json` | `agy -p=/usage --output-format json` (stdout 원문 한 줄) | 임시 |
| `models.txt` | `agy models` stdout | 임시 |

(+ 각 `.stderr.txt`. 같은 조건에서 `--disable-slash-commands` 만 뺀 accept-edits 쓰기도 신뢰 밖에선 똑같이 거부 — 픽스처 생략.)

### 1. 스트림 이벤트

**관측**
- `init` — `{"event":"init","conversation_id":"<uuid>","init":{"model":"gemini-4-argon","cwd":"…","tools":[…60개],"permission_mode":"request-review"}}`. **`conversation_id` 는 `init` 페이로드 안이 아니라 최상위**에 있다. 항상 첫 줄, 이어하기 때도 같은 id 로 온다. `init.model` 은 `--model` 에 준 alias 그대로(실제 해석 `gemini-4-argon-medium` 은 로그에만). 인자 오류(05·07)일 땐 `init` 없이 `result` 한 줄만.
- `step_update` — 페이로드 `{conversation_id, step_index, state, step_type, text_delta?, duration_seconds?, usage?, tool_name?, tool_info?}`.
  - `state`: `ACTIVE` · `DONE` · `ERROR`. 한 step 이 `ACTIVE` → `DONE`/`ERROR` 로 **두 번 이상** 온다(본문은 ACTIVE 마다 조각, 마지막 DONE 에도 조각이 붙을 수 있음).
  - `step_type`: `user_input`(본문 없음) · `agent_response`(본문 `text_delta`) · `tool` · `system_message`(이어하기 때, 본문 없음). **thinking 계열 step 은 한 번도 안 옴** — effort high 에서도 `thinking_tokens` 만 늘고 생각 텍스트는 스트림에 없다.
  - `usage` 는 `agent_response` 의 DONE 줄에 **그 step 몫**으로 붙는다(`input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens`).
  - 도구: `tool_name` 이 페이로드 최상위에, `tool_info = {name, parameters, output?, error?}`. **도구 id 필드가 없다** — `step_index` 가 유일한 식별자. `parameters` 는 `{"TargetFile":…}`·`{"AbsolutePath":…}`·`{"CommandLine":"ls -1"}` 처럼 PascalCase. `output` 은 요약 문자열(`view_file` → `"2 lines, 5 bytes"`), `write_to_file` 성공 DONE 에는 `output` 이 **없다**. 실패는 `state:"ERROR"` + `error:{type:"TOOL_ERROR",message:"…"}`.
- `result` — `{conversation_id, status, response, duration_seconds, num_turns, usage, denied_actions?, error?}`. `response` = 모든 `text_delta` 를 이은 것(8개 픽스처 전부 일치). `denied_actions: [{action:"write_file"|"command", display_name:"WriteToFile"|"RunCommand"}]` 가 거부가 있을 때 붙는다.
  - **이어하기 턴의 `usage`·`num_turns`·`duration_seconds` 는 대화 누적값이다**: 06 의 `input_tokens 28129` = 03 의 14879 + 06 step 의 13250, `output 361 = 195 + 166`, `num_turns 2`, `duration 93s`(프로세스는 12초). 새 대화 턴에선 step `usage` 합 = result `usage`(03: 12557+2322 = 14879).
- 종료 코드: 성공·권한 거부 모두 0, 인자 오류 1.

**코드에 주는 결론** — 수정 전 `GeminiEventMapper` 를 이 픽스처에 돌린 결과(`npx tsx` 로 확인, 아래 "코드 수정 필요" 1~5 로 반영 완료):
- `init` 이 안 나간다(페이로드에서 `conversation_id` 를 찾음) → `result` 때 뒤늦게 init 을 낸다. 본문 delta 가 init 보다 먼저 나간다(01·03).
- 도구 하나에 `tool_call` 이 **두 번**(id `step-3`, `step-4` — step_update 줄 수로 id 를 만들어서), `write_to_file` 은 `output` 이 없어 `tool_result` 가 영영 안 나간다(03·04) → UI 에 도구가 진행 중으로 남는다.
- 이어하기 턴 사용량이 누적으로 잡혀 **중복 집계**된다(06).
- 권한 거부만 있고 본문이 비면 `ok:true, text:""` — 빈 답장(02·04·06).
- 오류 텍스트(`tool_info.error.message`)는 `textOf` 가 맞게 읽는다. `step_type` thinking 분기는 죽은 코드(해롭진 않음).

### 2. `/usage` 응답 (`parseGeminiUsage`)

**관측**(`usage.json`, 종료 0, 약 6초): 한 줄 JSON.
```text
{conversation_id:"", status:"SUCCESS", response:"<탭 구분 텍스트>", usage:{…0}, command:{name:"usage", data:{description, groups:[
  {name:"Gemini Models", description:"Models within this group: Gemini Flash, Gemini Pro", buckets:[
     {id:"gemini-weekly", name:"Weekly Limit Remaining", window:"weekly", remaining_fraction:0.9999, reset_time:"2026-10-25T08:28:03Z", description?},
     {id:"gemini-5h", name:"Five Hour Limit Remaining", window:"5h", remaining_fraction:0.9996, reset_time:"…"}]},
  {name:"Claude and GPT models", buckets:[{id:"3p-weekly",…},{id:"3p-5h",…}]},
  {name:"Gemini 4 Argon", buckets:[{id:"gemini-argon-wtu-weekly", name:"Gemini 4 Argon Weekly Limit", window:"weekly", remaining_fraction:0.9798, reset_time:"…"}]}]}}}
```
`response` 텍스트: 줄마다 `<그룹>\t<버킷 이름>\t<남은 %>%\t<ISO>` (예 `Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-18T13:28:03Z`). 퍼센트는 **남은 양**, 정수 반올림.

**코드에 주는 결론**(반영 완료, 아래 8): 수정 전 `parseGeminiUsage(usage.json)` → **`[]`** (실행 확인) → 카드가 "불명". 이유 셋:
1. 잔여가 `remaining_fraction`(0–1)이다 — `used_percentage`/`remaining_percentage` 키가 없다.
2. 텍스트 대체 경로는 `:`·`|`·`·` 구분만 받는데 실제는 **탭**.
3. 버킷 이름이 그룹 간에 겹친다(`Weekly Limit Remaining` 이 두 그룹에) → 버킷 자기 `name` 만 쓰면 이름 중복 제거에서 두 번째 그룹이 사라진다. 이름은 `그룹 + window`(예 `Gemini · 5h`, `Gemini · 주간`, `Argon · 주간`, `Claude/GPT · 5h`)로 만들어야 한다. `Claude and GPT models` 그룹(agy 안의 Claude/GPT 모델 몫)은 deck 이 쓰지 않으니 숨기거나 맨 뒤.

### 3. 모델

**관측**(`models.txt`): `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`. 1.3.5 때 보이던 `gemini-3.1-pro`·`gemini-3-flash` 는 목록에 없다. 로그: `model alias "gemini-4-argon" resolved to "gemini-4-argon-medium"`(effort medium), `…-high`(effort high), `gemini-3.8-flash` → `gemini-3.8-flash-high`(06). 즉 **alias + `--effort` 조합이 유효**. 그러나 `--effort xhigh` 는 거부(05: `gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)`, 종료 1). `--model gemini-pro`(deck id) 는 `--effort is not supported for model "gemini-pro"` 로 거부(07).

**코드에 주는 결론**: `GEMINI_CLI_ALIAS`(`gemini-pro → gemini-4-argon`, `gemini-flash → gemini-3.8-flash`)는 **그대로 유효**. 바꿔야 할 것은 effort: `MODEL_EFFORTS['gemini-pro'|'gemini-flash']` 가 `EFFORTS`(xhigh 포함)라 피커에서 "엑스트라"를 고르면 턴이 즉시 실패한다 → `['low','medium','high']`. (`--help` 는 `low|medium|high|xhigh|max` 라고 하지만 모델별로 다시 거른다.)

### 4. 권한

**관측**
- `init.permission_mode` 는 `--mode` 와 무관하게 늘 `"request-review"`. 헤드리스는 승인을 물을 수 없어 **승인이 필요한 도구를 조용히 거부**한다(로그 `soft-denying tool confirmation "WriteToFile"`). **승인 요청 이벤트는 stdout 에 오지 않는다.** 흔적은 셋: 도구 step(`write_to_file` 은 거부돼도 `state:"DONE"`·output 없음 — 성공과 구별 불가 / `run_command` 는 `state:"ERROR"` + `error.message: permission check failed … user denied permission …`), `result.denied_actions`, stderr `jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json …`. 거부 뒤 모델은 대개 **마무리 답 없이** 끝난다(`response:""`, `status:"SUCCESS"`).
- **`--mode plan` + `--disable-slash-commands` = plan 무효**: stderr `warning: --mode plan has no effect while slash command expansion is disabled.`(01·04). plan 모드는 `/plan` 슬래시 확장으로 구현돼 있다. 그래도 04 에서 쓰기는 거부됐다 — 기본 request-review 덕에 읽기(`view_file`)만 되고 쓰기·셸은 막힌다. 즉 **deck 의 "읽기 전용"은 plan 이 아니라 헤드리스 기본 거부로 지켜지고 있다.**
- `--disable-slash-commands` 없이 plan(08): 에이전트가 `implementation_plan.md` 를 `<HOME>/.gemini/antigravity-cli/brain/<대화id>/` 에 쓰고 "계획을 승인해 주세요" 로 끝난다. 작업 폴더는 그대로. 헤드리스 deck 흐름엔 맞지 않는다(승인 경로 없음, 프롬프트 `/…` 가 슬래시로 확장됨).
- accept-edits: **신뢰 폴더(`trustedWorkspaces`, 로그인 때 `<HOME>`) 안에서만** 파일 쓰기가 자동 승인된다(03 성공, 02 는 /var/folders 라 거부). 셸(`run_command`)은 accept-edits 에서도 항상 거부(06). `--disable-slash-commands` 는 accept-edits 에 경고를 내지 않는다(효과 있음).

**코드에 주는 결론**: `GEMINI_SANDBOX_LABEL` 의 "파일 편집 허용(셸 거부)" 는 맞다. 다만 ① 거부를 사용자에게 보여야 한다(지금은 빈 답장), ② 신뢰 폴더 밖 세션(예: `/tmp`, 외장 볼륨)에선 "파일 편집 허용"이어도 쓰기가 막힌다는 안내가 필요, ③ 읽기 전용에 `--mode plan` 을 계속 넘길 이유가 없다(무효 + 경고) — 빼도 동작 동일.

### 5. 오류 모양

**관측**(07): 종료 1, stdout 은 `result` 한 줄 `{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \"gemini-pro\" --effort \"medium\"): --effort is not supported for model \"gemini-pro\"",…,"usage":{…0}}`, stderr `error: <같은 문구>`. 05 도 같은 모양. `init` 없음.

**코드에 주는 결론**: 현재 매퍼·`GeminiEngine` 이 그대로 `ok:false, errorText:<error>` 로 처리한다 — 수정 불필요.

## 코드 수정 필요 (근거 픽스처) — 1~8 반영 완료 (2026-10-18)

테스트: `GeminiEngine.test.ts` 의 "agy 1.4.2 fixtures" 묶음(01·02·03·04·05·06·07 픽스처를 매퍼에 그대로 돌림)과 stderr 만 있는 거부, `GeminiUsagePoller.test.ts` 첫 케이스(`usage.json` 실물), `models.test.ts` 의 Gemini effort.

1. **[반영 완료] `GeminiEventMapper.map` `init`** — `conversation_id` 를 최상위 `e.conversation_id` 에서(페이로드 것도 계속 허용), 모델은 `p.model`. 근거 `01`, `03`, `06`.
2. **[반영 완료] `GeminiEventMapper.map` `step_update` 도구 id** — `step-${this.steps}` 대신 `step_index`(예 `step-${p.step_index}`; 이어하기 때도 대화 안에서 유일). 이름은 `tool_info.name` ?? `p.tool_name`. 근거 `03`, `04`, `06`.
3. **[반영 완료] `tool_result` 조건** — `state` 가 `DONE`/`ERROR` 면 payload 가 없어도 결과를 낸다(내용 `''` 또는 "완료"), `isError` = `state==='ERROR'` 또는 `tool_info.error`. 근거 `03`(write_to_file DONE·output 없음), `06`(ERROR + error 객체).
4. **[반영 완료] 턴 사용량** — `result.usage` 대신 `step_update.usage` 를 합산(이어하기 턴에선 result 가 대화 누적). step usage 가 하나도 없으면 result 로 대체. 근거 `06`(누적), `03`(새 대화에선 합 = result).
5. **[반영 완료] 권한 거부 표시** — `result.denied_actions` 가 있으면 결과에 알림을 붙인다(예: 본문 끝 또는 별도 이벤트로 "Gemini 가 파일 쓰기/셸 실행을 요청했지만 헤드리스라 거부됨"). 본문이 비고 거부만 있으면 빈 답장 대신 이 문구. 신뢰 폴더 밖 cwd 이면 `trustedWorkspaces` 안내. 근거 `02`, `04`, `06` 과 각 `.stderr.txt`.
   → 반영: `result.denied_actions` 의 `action` 을 동작 종류로만 옮긴 `notice`(`Gemini가 거부함: 파일 쓰기, 셸 명령 실행 — 헤드리스 agy 는 승인을 물을 수 없어 자동 거부됩니다`). 경로·명령줄·`display_name` 은 싣지 않는다. `denied_actions` 가 없으면 stderr 의 `required the "<x>" permission` 으로 대신 판단(그래서 성공 결과도 프로세스 종료까지 기다렸다 낸다). 빈 본문은 그대로 두고 알림만 붙인다. 신뢰 폴더 안내 문구는 아직 없음.
6. **[반영 완료 — 유지 쪽] `geminiArgs`** — 읽기 전용은 `--mode plan` 을 **유지**하고 무효임을 주석으로 남김(읽기 전용 픽스처가 모두 이 인자로 찍혔고, 빼는 쪽은 실측 없음 — 리뷰 지적). `--disable-slash-commands` 는 유지(빼면 `/…` 프롬프트가 확장되고 plan 이 brain 폴더에 계획서를 쓰고 승인을 기다림). 근거 `01`/`04` stderr, `08`.
   → 반영: 읽기 전용은 `--mode` 를 아예 넘기지 않는다. `--disable-slash-commands` 유지.
7. **[반영 완료] `src/shared/models.ts` `MODEL_EFFORTS`** — `gemini-pro`·`gemini-flash` 를 `['low','medium','high']` 로. `GEMINI_CLI_ALIAS` 는 유지. 주석의 "1.3.5" 를 1.4.2 로. 근거 `05`, `models.txt`.
   → 반영. 저장된 `xhigh` 는 새 정규화 없이 기존 `effortFor` 경로를 탄다 — Gemini 가 받지 않는 값이라 null → `DEFAULT_EFFORT.gemini`(`medium`) 로 보낸다(high 로 올려 주는 기존 경로는 없음). 피커엔 엑스트라가 안 보인다.
8. **[반영 완료] `GeminiUsagePoller.parseGeminiUsage`** — `remaining_fraction`(0–1, ×100 → `usedPct = 100 − x`) 인식, 경로 `command.data.groups[].buckets[]`, 이름 = 그룹 + `window`(이름 중복 제거 전에), 텍스트 대체 경로에 탭 구분(`그룹\t이름\tNN%\tISO`, NN = 남은 %) 추가. `Claude and GPT models` 그룹은 숨김/후순위 결정. 테스트 `GeminiUsagePoller.test.ts` 첫 케이스를 `usage.json` 실물로 교체. 근거 `usage.json`.
   → 반영: 이름 `Gemini · 주간`, `Gemini · 5h`, `Argon · 주간`(그룹 이름에서 ` Models`·`Gemini <버전> ` 을 떼고 window 를 `주간`/`5h` 로). `Claude and GPT models` 그룹은 숨긴다. `GeminiBucket` 모양(`name, usedPct, resetsAt`)은 그대로라 프로토콜 변경 없음. UI `bucketLabel` 은 ` · ` 가 든 이름을 그대로 쓴다.
9. (선택) **thinking** — 스트림에 생각 텍스트가 없으므로 `THINKING_RE` 분기는 실물 근거가 없다. 남겨도 무해.

## 한계 (남은 미확인)

- **한도 초과 응답 모양**: 실물 미관측. 쿨다운 정규식(quota/429/RESOURCE_EXHAUSTED)은 추정.
- **미로그인 문구**는 1.3.5 실측 그대로 — 1.4.2 에서 다시 보진 않았다(로그아웃 금지).
- **`--input-format stream-json`**: `--help` 상 "stdin NDJSON 한 줄당 한 턴, `--output-format stream-json` 필요"로 존재 확인. 메시지 줄 형식은 미확인 → 프롬프트는 여전히 argv(`ps` 에 보임).
- **기록 없음**: Gemini 세션을 다시 열면 이전 메시지가 보이지 않는다. 이어하기 자체는 된다(실측). 대화는 `~/.gemini/antigravity-cli/conversations/` 에 남는다.
- **계정 하나**: 키체인 로그인이 하나뿐이라 g1/g2 분산·쿨다운 우회는 사실상 없다.
- **승인 경로 없음**: 헤드리스는 승인을 물을 수 없다. 셸을 허용하려면 사용자가 `settings.json` 의 `permissions.allow` 에 규칙을 넣어야 한다(deck 은 이 파일을 건드리지 않는다).

## 코드

- `src/server/engine/GeminiEngine.ts` — `geminiArgs`, `GeminiEventMapper`, `GeminiEngine`(프로세스 실행), `resolveGeminiBin`, `GeminiLogin`(프로브+캐시)
- `src/server/engine/fixtures/agy-1.4.2/` — 실측 픽스처(위 표)
- `src/shared/accounts.ts` — `GeminiAccount`, `geminiEnv`
- `src/shared/models.ts` — `GEMINI_CLI_ALIAS`, 라벨, effort
- `src/server/usage/GeminiUsagePoller.ts` — `/usage` 폴링·해석(`parseGeminiUsage`), `UsageService.applyGemini` 로 발행
- `src/ui/components/UsagePanel.tsx` — `GeminiCard` (버킷당 한 줄, 최저 잔여 % 요약, 미로그인 힌트)
- `src/server/turn/TurnRunner.ts` — `runGemini` (계정 선택·고정·쿨다운·effort; 끝나면 `geminiUsage.bump()`)
- `src/server/main.ts` — `GeminiLogin` 연결
- 테스트: `GeminiEngine.test.ts` (가짜 agy 바이너리), `TurnRunner.test.ts` 의 "Gemini sessions", `GeminiUsagePoller.test.ts`
