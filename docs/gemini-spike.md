# Gemini 엔진 — Antigravity CLI (agy 1.3.5)

deck 의 세 번째 엔진. **명시 선택 전용** — 엔진 선택에서 "Gemini" 를 고를 때만 쓰이고, 자동(모델 자동·엔진 자동)은 절대 Gemini 로 열지 않는다.

Google 이 2026-06-18 에 개인 계정(무료·AI Pro·Ultra)용 gemini-cli 서비스를 끝냈다(`IneligibleTierError … migrate to the Antigravity suite`). 그래서 deck 은 후속인 **Antigravity CLI `agy`** 를 쓴다.

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
- 계정 전환: `agy` 안에서 `/logout` 후 다시 로그인.
- **Mac 한 대에 Google 계정 하나.** deck 의 `g1`/`g2` 두 칸 중 실제로는 `g1` 만 쓰이고 `G2` 자리는 항상 "로그인 안 됨"(세션 레코드 호환 때문에 id 만 남겨 둠).
- 로그인 판정: `agy models` 프로브(종료 코드 0 = 로그인, 비0·15초 타임아웃·실행 실패 = 아님). 서버 시작 때 한 번, 이후 상태 요청 시 캐시가 **5분**을 넘으면 백그라운드로 다시 확인. 동시 확인은 하나로 합친다. 로그인 직후엔 최대 5분 뒤(또는 서버 재시작 후) "Gemini · 로그인 필요" 가 "Gemini" 로 바뀐다.

## 동작

| 항목 | 방식 |
|---|---|
| 헤드리스 | `agy -p=<프롬프트> --output-format stream-json --model <slug> --effort <e> --mode <m> [--sandbox] --disable-slash-commands --print-timeout 0 [--conversation <id>]`. `-p` 는 값을 받는 플래그라 **반드시 `-p=` 한 argv 요소**로 붙인다. stdin 은 바로 닫는다. |
| 스트림 | 한 줄 = `{"event":"<이름>","<이름>":{…}}`. `init`(cwd, tools, permission_mode, conversation_id?) · `step_update`(step_type, state, text_delta, tool_info) · `result`(conversation_id, status, response, error, usage). 알 수 없는 이벤트는 무시. |
| 매핑 | `step_update.text_delta` → 본문 delta (step_type 이 thought/thinking/reasoning 이면 thinking). `tool_info` → id 당 한 번 tool_call, state 가 done/complete/success/error/fail 이고 output/result/error 가 있으면 tool_result. `result.status === 'SUCCESS'` 면 성공, 본문은 누적 delta(없으면 `response`). |
| 상태값 | SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING. 종료 코드 0 성공 / 1 오류 / 2 잘못된 입력. |
| 이어하기 | `--conversation <id>` (id 는 `init`/`result` 의 conversation_id). 플래그 모양 id 는 거부(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). |
| 권한 | 읽기 전용 → `--mode plan`, 파일 편집 허용 → `--mode accept-edits --sandbox`. `--dangerously-skip-permissions` 는 절대 쓰지 않는다. |
| 인증 | 키체인 로그인만. API 키/Vertex/ADC/베이스 URL 변수와 gemini-cli 잔재(`GEMINI_CLI_HOME`, `SEATBELT_PROFILE` 등)는 자식 env 에서 제거. |
| 미로그인 | stderr `authentication required. Run 'agy' to log in` + result `error: "authentication failed or timed out"` → "Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인". |
| 사용량 | `result.usage`: `input_tokens` → 입력, `output_tokens` → 출력, `cache_read_tokens` → 캐시 읽기 (`thinking_tokens` 는 쓰지 않음). |
| 한도 | 오류 문구에 quota / rate limit / RESOURCE_EXHAUSTED / 429 가 있으면 그 계정을 메모리에서 쿨다운. |
| 잔여 한도 카드 | `agy -p=/usage --output-format json` (print 모드의 `/usage` — `--disable-slash-commands` 를 붙이면 안 됨). 서버 시작 때, 5분마다, Gemini 턴이 끝난 4초 뒤. **로그인 프로브가 참일 때만 실행** — 미로그인 print 모드는 브라우저 로그인을 60초 기다리며 멈춘다. 결과는 `UsageSnapshot.gemini` (`buckets[]`: name · usedPct · resetsAt) → 사용량 헤더의 Gemini 카드. |

### `/usage` 응답 해석 (`GeminiUsagePoller.parseGeminiUsage`)

실제 응답은 아직 못 봤다(미로그인). 바이너리 심볼로 본 구조: `printmode.usageReport` → `quotaRows` → `groupJSON`/`bucketJSON`(`bucketRemaining`, `bucketReset`), JSON 태그 `groups` · `buckets` · `used_percentage` · `remaining_percentage` · `reset_time`. 그래서 해석기는 모양을 고정하지 않는다:

1. stdout 전체 또는 `{`/`[` 로 시작하는 줄을 JSON 으로 읽고, 트리를 재귀로 훑어 `used_percentage`/`remaining_percentage`(또는 `used`·`remaining` + `limit`)가 있는 객체마다 버킷 하나. 이름은 그 객체의 `name|label|display_name|model|…`, 없으면 상위 그룹 이름. 리셋은 `reset_time|resets_at|…`(ISO · epoch 초/ms · "2h 10m" 같은 상대값) 또는 `reset_in_seconds`. 턴 토큰 `usage{input_tokens…}` 는 건너뜀.
2. 버킷이 없으면 `response` 의 텍스트 보고서를 줄 단위로 — `이름: 73% remaining (resets in 2h 10m)` / `이름 · 12% used · resets at <ISO>`.
3. 그래도 없으면 stdout 자체를 2 와 같이. 전부 실패하면 카드가 "불명" 이 되고 서버 로그에 응답 앞 600자를 한 번 남긴다 → 그걸 보고 해석기를 고친다.

같은 이름은 첫 것만, 퍼센트는 0–100 으로 자른다.

확인된 실제 한 줄(미로그인):

```json
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
```

## 모델

deck id 는 저장된 세션 호환을 위해 그대로 둔다.

| deck id | 이름 | `--model` |
|---|---|---|
| `gemini-pro` | Gemini 4 Argon | `gemini-4-argon` |
| `gemini-flash` | Gemini Flash | `gemini-3.8-flash` |

바이너리에 있는 다른 슬러그: `gemini-4-argon-low/-medium/-high`, `gemini-3.8-flash-*` 변형, `gemini-3.1-pro`, `gemini-3-flash`. effort 는 슬러그 변형 대신 `--effort` 플래그로 보낸다 — 피커에서 낮음·중간·높음·엑스트라 선택 가능(기본 중간).

## 한계

- **`step_update` 세부 형식 미확인**: 필드 이름은 문서 기준이고 실제 줄은 아직 못 봤다(로그인 후 첫 실행에서 확인 필요). 특히 `tool_info` 의 id/name/input/output 키, `step_type`·`state` 값.
- **`init` 의 conversation_id 미확인**: 없으면 `result` 의 conversation_id 로 세션을 잡는다.
- **프롬프트가 argv 에 보인다**: 프로세스 목록(`ps`)에서 프롬프트가 보일 수 있다(`--input-format stream-json` 은 메시지 형식이 미확인이라 쓰지 않음).
- **기록 없음**: Gemini 세션을 다시 열면 이전 메시지가 보이지 않는다. 이어하기 자체는 된다.
- **계정 하나**: 키체인 로그인이 하나뿐이라 g1/g2 분산·쿨다운 우회는 사실상 없다.
- **쿼터 응답 형식 미확인**: 카드는 `/usage` JSON 을 관대하게 해석한다(위). 로그인 후 첫 폴링에서 숫자가 안 보이면 서버 로그의 "agy /usage 응답을 해석하지 못했습니다 — 앞부분: …" 줄을 보고 `parseGeminiUsage` 를 맞춘다. 버킷이 모델별인지 묶음별인지, 리셋이 절대 시각인지 상대값인지도 그때 확정.
- **미로그인 print 모드는 60초 블로킹**: 턴·`/usage` 모두. deck 은 `agy models` 프로브가 참일 때만 둘을 실행한다.

## 코드

- `src/server/engine/GeminiEngine.ts` — `geminiArgs`, `GeminiEventMapper`, `GeminiEngine`(프로세스 실행), `resolveGeminiBin`, `GeminiLogin`(프로브+캐시)
- `src/shared/accounts.ts` — `GeminiAccount`, `geminiEnv`
- `src/shared/models.ts` — `GEMINI_CLI_ALIAS`, 라벨, effort
- `src/server/usage/GeminiUsagePoller.ts` — `/usage` 폴링·해석(`parseGeminiUsage`), `UsageService.applyGemini` 로 발행
- `src/ui/components/UsagePanel.tsx` — `GeminiCard` (버킷당 한 줄, 최저 잔여 % 요약, 미로그인 힌트)
- `src/server/turn/TurnRunner.ts` — `runGemini` (계정 선택·고정·쿨다운·effort; 끝나면 `geminiUsage.bump()`)
- `src/server/main.ts` — `GeminiLogin` 연결
- 테스트: `GeminiEngine.test.ts` (가짜 agy 바이너리), `TurnRunner.test.ts` 의 "Gemini sessions"
