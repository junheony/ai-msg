# ws 프로토콜 규칙

서버와 UI 는 따로 배포된다. UI 는 빌드만으로 바뀌고 서버는 재시작해야 바뀌므로, 새 UI 가 옛 서버에 붙어 있는 시간이 늘 있다. 열려 있던 옛 탭이 새 서버에 붙는 반대 경우도 있다. 메시지 정의는 `src/shared/protocol.ts`.

## 규칙

1. **새 필드는 선택(optional)으로만 더한다.** 없으면 받는 쪽이 이전 동작을 한다. 클라이언트 메시지(zod 스키마)도 `.optional()` 로 더한다.
2. **필드를 지우지 않고, 타입을 좁히지 않는다.** 필수였던 필드를 선택으로 바꾸는 것, 값의 종류를 줄이는 것, 뜻을 바꾸는 것도 같다. 바꿔야 하면 새 이름의 필드를 더한다.
3. **새 메시지 종류는 기능 이름 뒤에서만 보낸다.** 서버는 상대가 먼저 요청했을 때만 새 종류를 보낸다(예: `catchup` 은 `open_session.after` 의 답으로만). 옛 UI 는 모르는 종류를 받으면 안 된다.
4. **서버가 무엇을 하는지는 한 곳에서만 묻는다.** UI 는 `src/ui/features.ts` 의 `has('이름')` 으로만 판단한다. 필드가 있는지 보고 추측하거나 `hello.build` 를 비교하지 않는다. "옛 서버면 …" 분기는 전부 `has()` 를 거친다.

## 기능 목록 (`hello.features`)

서버가 연결 직후 `hello.features: string[]` 로 알린다(`FEATURES`, `src/shared/protocol.ts`). 목록이 없는 서버는 빈 목록으로 본다. 모르는 이름은 무시한다.

| 이름 | 서버가 하는 일 | 없을 때 UI |
|---|---|---|
| `sessionModel` | `history.sessionModel` 로 세션 기본 모델을 알린다 | 기록의 마지막 모델로 추정 |
| `abortLabel` | 사용자 중지를 언제나 `중단됨` 으로 보낸다(실행이 예외로 끝난 경로 포함) | SDK 문구 "aborted by user" 도 중지로 봄 |
| `catchup` | 턴 이벤트에 `pos` 를 붙이고 `open_session.after` 에 답한다. `activity.heads` 에 최근 스트림 머리(deck 턴만 움직임)를 실어, 보이는 세션이 머리보다 뒤처진 채 30초 동안 아무것도 못 들으면 UI 가 다시 묻는다(아무것도 안 오면 60초부터 두 배, 최대 10분). 기록을 읽는 동안 구간이 끝나면 다시 읽고, 3번 넘게 겹치면 `pos` 없이 보낸다 | 재연결 때 전체 기록을 다시 받음 |
| `accounts` | `hello.accounts` 로 Claude 계정 목록(`{ id, label, home, retired }`, 설정 순서, 뺀 계정 포함)을 알린다 | 계정은 a/b/c, A 가 Desktop |
| `sessionSandbox` | `set_sandbox` 로 기존 GPT 세션의 샌드박스를 바꾸고, `open_session.accepts` 에 `'sandbox'` 를 넣은 소켓에만 `sandbox` 메시지로 알린다. `catchup.sandbox` 도 채운다 | 기존 GPT 세션의 샌드박스 칩은 표시만 |
| `routePreview` | `route_preview{sessionId, cwd?, model?}` 에 `route_preview{sessionId, account, reason, asOpus?}` 로 답한다(Claude 세션만; GPT·Gemini·모르는 id·뺀 계정 세션, 새 세션의 `자동` 은 답 없음). 소켓마다 마지막 요청을 기억해 사용량이 바뀌어 답이 달라지면 다시 보낸다. `sessionId: null` 에 `cwd` 가 없으면 요청 철회 | 상단 사용량 카드에 `다음` 표시 없음(요청도 보내지 않음) |
| `highlights` | `GET /api/highlights?hours=6\|12\|24`(그 밖의 값은 24)에 `{ hours, events }` 로 답한다(세션 하이라이트, `events.jsonl` 7일치) | 작업 현황의 `하이라이트 보기 →`, ⌘K `하이라이트 보기`, 설정의 `하이라이트` 를 숨김 |
| `fileRaw` | `GET /api/file?…&raw=1[&download=1]` 로 원본 바이트를 주고 `POST /api/reveal` 로 서버 Mac 의 Finder 를 연다(아래 "HTTP: 세션 폴더 파일") | 파일 칩·사이드 패널의 `다운로드`·`Finder 에서 보기`·`새 탭에서 크게`, 폴더 칩의 `Finder 에서 열기` 를 숨기고, 답장 안 이미지 경로는 썸네일 대신 칩으로 |
| `serverUpdate` | `GET /api/server-update` 에 `{ changedFiles, newestAt, supervised, draining, activeTurns }`(서버가 뜬 뒤 바뀐 `src/server`·`src/shared` 의 테스트 아닌 `.ts` 수, `activeTurns` = drain 이 기다리는 턴·백그라운드 작업 프로세스 수), `POST /api/restart` 에 SIGUSR2 와 같은 drain 으로 답한다. 관리자(relaunch 루프·launchd) 아래가 아니면 — 요청마다 부모가 relaunch 루프인지 확인 — 409, 이미 drain 중이면 아무것도 안 하고 `{ ok, draining: true }`. 본문 `{"force":true}` 는 두 번째 SIGUSR2 와 같다(작업 끊고 지금 재시작): drain 중일 때만 남은 턴·백그라운드 작업을 중단하고 바로 종료해 관리자가 다시 띄우며 `{ ok, draining: true, forced: true }`, drain 중이 아니면 400 으로 거절하고 아무것도 시작하지 않는다. 쿠키·Origin 검사와 409 는 같다 | `서버 업데이트 대기` 칩·`지금 재시작` 을 숨김 |
| `commander` | 총사령탑(아래 "총사령탑"). 설정 `commanderEnabled` 가 켜져 있을 때만 알린다 — 설정 화면 토글로 바꾸면 `settings` 방송에 새 `features` 를 실어 보낸다 | ⋯ `총사령탑 걸기…`·머리 칩·설정 토글 없음 |

| `grok` | Grok 엔진(`send.engine: 'grok'`, 모델 `grok-4.7`(기본)·`grok-4.7-build-fast`·`grok-4.6`·`grok-4.5`, 자리 `x1`). 서버가 `grok` 바이너리를 찾았을 때만 알리고, `hello.grok: { bin, version?, locked? }` 에 찾았는지와 `grok --version` 첫 줄, 엔진 잠금 사유(`locked`: 문자열이면 잠김, `null`·없음이면 풀림)를 싣는다(버전을 못 읽어도 `bin: true`). 잠금이 걸리거나 풀리면 서버가 `grok_status{grok}` 를 모든 소켓에 보내고, 클라이언트는 `grok_unlock` 으로 잠금을 푼다(설정 → 권한의 `잠금 해제`). 잠긴 동안 Grok 턴은 `errorKind: 'grok_engine_locked'` 로 끝난다. 권한 모드는 즉시 적용되고(턴 도중 바꿔도 다음 승인 요청부터), `plan` 은 거절한다(`set_permission_mode` 는 `error` 로 답하고, `send` 는 엔진이 거절 문구로 끝낸다). Grok 세션은 승인 카드·자동 승인·실행 중 메시지(steer)·감사 로그를 Claude 와 같은 길로 쓰고, `open_session` 의 기록은 Gemini 처럼 비어 있다(`engine: 'grok'`, `permissionMode`). 총사령탑(`commander_engine`)·작업 폴더 바꾸기·포크·인계는 거절. 이미지 첨부는 엔진이 거절 문구로 답한다 | 엔진 선택의 Grok 을 흐리게(`Grok · 설치 필요`) |
| `setup` | 첫 실행 마법사. `hello.setup: { needed }` 가 마법사를 띄울지 알린다(`<configDir>/setup.json` 이 `pending`). `GET /api/setup` → `SetupStatus`(`src/shared/setup-types.ts`, 30초 캐시), `POST /api/setup/refresh` → 다시 점검한 `SetupStatus`, `POST /api/setup/profiles {id, label?}` → `{ ok, profile, restartNeeded: true }` 또는 400·409 `{ error }`(accounts.json 에 Claude 프로필을 더하고 다음 시작부터 적용), `POST /api/setup/done` → 마법사 완료 기록. 쿠키·Origin 검사는 다른 `/api/*` 와 같다 | 마법사 자동 열기·설정의 `설치 점검` 없음 |
| `sessionIcons` | 사이드바·머리 칩의 세션 아이콘을 직접 고른다. `hello`·`index` 에 `sessionIcons: Record<세션 id, 아이콘>`(아이콘은 `src/shared/sessionIcons.ts` 의 이모지 또는 `glyph:<이름>`)을 싣고, `POST /api/session-icon {sessionId, icon}` 이 하나를 정한다(`icon: null` 은 지움) → `{ sessionIcons }` 로 답하고 바뀌었으면 `index` 를 방송한다. 잘못된 값 `400`, 저장 상한(2000개) `409` `{ error }`. 세션을 휴지통에 넣으면 그 아이콘도 지운다. 저장은 `<configDir>/session-icons.json`. 쿠키·Origin 검사는 다른 `/api/*` 와 같다 | 아바타는 첫 글자 모노그램만, 누를 수 없음 |
| `heartbeat` | 클라이언트가 `hello` 를 받은 뒤 `{type:'heartbeat'}` 를 보내면 그 소켓에만 `HEARTBEAT_MS`(10초)마다 `{type:'heartbeat'}` 를 보낸다(규칙 3). UI 는 아무 메시지 없이 `HEARTBEAT_TIMEOUT_MS`(25초)가 지나면 소켓을 닫고 다시 연결한다(`open_session` 의 답 — history·catchup·그 세션의 error — 을 기다리는 동안은 기한 4배·보낸 뒤 최대 90초, 얼었던 탭이 늦게 깨어나면 5초 유예, 감시로 새로 연 소켓은 첫 메시지(hello)까지 감시 안 함, 열렸는데 hello 가 15초 안에 안 오면 다시 연결). drain 중 `activity` 에는 `drainReason: 'restart' \| 'stop'` 도 싣는다(SIGUSR2·`지금 재시작` = restart, SIGTERM·SIGINT = stop — stop 이면 거절 문구도 "꺼지는 중". install-launchd.sh·`ai-msg service restart` 도 SIGTERM 이라 stop 으로 분류된다: 다시 켜진다는 약속이 없다는 뜻일 뿐이라 문구는 "꺼지는 중 — 다시 켜지면 이어서 보냄" 으로 중립) | 하트비트 감시 없음(조용한 소켓은 브라우저 close 까지 그대로), 끊김 막대는 "다시 연결하는 중…" 으로만 |
| `historyImages` | `GET /api/sessions/<세션 id>/images/<n>/<k>` 가 Claude 세션 기록의 `n` 번째 사용자 메시지(기록의 `n` 과 같은 셈)에 든 `k` 번째 이미지(base64 PNG·JPEG·GIF·WebP)를 준다. 파일은 세션 색인에서만 찾고(요청 경로를 쓰지 않음), 형식은 바이트로 판별, 그 밖은 `404`. 쿠키·Origin 검사는 다른 `/api/*` 와 같다 | 대화 기록 속 이미지는 `이미지 N장` 알약으로만 |
| `olderHistory` | `history.older` 에 더 앞쪽 기록의 커서를 싣고(`null` = 처음부터 다 보냄), `load_older{sessionId, before, reqId?}` 에 `older_history` 로 답한다. `open_session.from` 을 받으면 거기부터 보낸다(아래 "앞쪽 기록 이어 불러오기") | 처음 열 때 받은 최근 200개만, 위로 올려도 더 없음 |
| `cloud` | 클라우드 연결(폰 원격). `GET /api/cloud/status` → `CloudStatus`(`src/shared/cloud/api-types.ts`: `enabled`·`linked`·`email`·`relay`·`link`·`devices`·`plan`, 클라우드 주소·토큰은 싣지 않음), `POST /api/cloud/link/start` → `{ userCode, verifyUrl, expiresAt }`(진행 중이면 같은 값; 이미 연결 `409`, 클라우드 안 닿음 `502`), `POST /api/cloud/unlink` → `{ ok: true }`(클라우드가 못 받아도 여기선 잊음), `POST /api/cloud/devices/<id>/revoke` → `{ ok: true }`(id 는 출력 가능한 ASCII 1~64자, 아니면 `400`; 그 기기의 채널을 바로 닫는다). 쿠키·Host·Origin 검사는 다른 `/api/*` 와 같다. `DECK_CLOUD=off` 면 이 기능을 알리지 않고 `/api/cloud/*` 는 `404`. 릴레이로 온 폰 요청 중 `/api/cloud/status`(GET) 말고는 아래 `mac_confirm_required` 로 막는다 | 설정에 클라우드 연결 항목 없음 |

기능을 더할 때: `FEATURES` 에 이름을 더하고, UI 는 `has()` 로 갈라 쓰고, 이 표에 한 줄 더한다. 배포된 이름은 지우지 않는다.

기능 이름 없이 `open_session.accepts` 로만 여는 서버 메시지(규칙 3): `'sandbox'`(위 표), `'turn_queued'` — 백그라운드 작업으로 열어 둔 프로세스에 보낸 메시지가 스트리밍 중인 구간(`백그라운드 계속` 등) 뒤에서 기다릴 때 보낸 소켓에만 `turn_queued{clientRef, behind}` 를 보낸다(옛 UI 는 `시작하는 중…` 그대로). 그 메시지의 취소는 `cancel_queued{sessionId, clientRef}` 로 서버 큐에서도 뺀다(답 없음; 이미 들어갔으면 그 ref 의 `turn_started` 가 평소처럼 온다).

계정 고정(`send.accountPin`, `set_account_pin.pin`)의 id 는 모양(`ACCOUNT_ID_RE`, `src/shared/accounts.ts`)만 스키마에서 보고, 어떤 계정이 있는지는 서버가 처리할 때 설정으로 확인한다. 설정에 없는 id 와 뺀 계정(retired)은 `error` 로 거절한다. 옛 UI 가 보내는 a/b/c 는 그대로 통과한다.

ws 메시지가 아닌 것: 하이라이트(`GET /api/highlights?hours=6|12|24`, 그 밖의 값은 24 → `{ hours, events }`)는 HTTP 로만 읽는다. 서버는 `highlights` 기능(위 표)으로 알리고, 그 기능이 없는 서버면 UI 는 들어가는 곳을 보이지 않는다.

기능 이름이 아닌 것(규칙 1, 선택 필드): `hello`/`history`/`catchup` 의 `usage`(`UsageSnapshot`, `src/shared/usage-types.ts`) 는 사용량 헤더 개편(`docs/superpowers/specs/2026-10-18-usage-header-design.md`)으로 `geminiSeats?: Partial<Record<'g1' | 'g2', GeminiUsage>>` 와 `grokSeats?: Partial<Record<'x1', GrokUsage>>` 를 더했다. 둘 다 없거나 그 키가 없으면 그 좌석 카드는 없다(옛 서버·agy/grok 미설치·아직 못 돌린 턴). 기존 `gemini`(단일, g1 과 같은 값)는 구버전 UI 호환을 위해 당분간 함께 보낸다 — `geminiSeats` 가 없는 UI 는 `gemini` 만 본다. `GrokUsage`(`{ status, lastTurnAt, lastError, cooldownUntil, today }`) 의 이 다섯 필드는 deck 자신의 Grok 턴 결과에서 채운다. 선택 필드 `billing?: GrokBilling | null`(`{ usedPct, windowStart, windowEnd, tier, fetchedAt, periodType?, monthlyLimit?, onDemandCap?, onDemandUsed?, includedUsed?, totalUsed? }`)은 구독 사용량이다. Grok ACP 확장 `_x.ai/billing` 의 `config.creditUsagePercent` 를 **사용한 %** 로 읽는다(1.0 = 1% 사용, 99% 남음). 창은 `config.currentPeriod.start/end`, 등급은 `subscription_tier` 에서 온다. 읽는 때는 두 가지다. 하나는 Grok 턴이 끝날 때 같은 연결에서 5초 제한으로 읽는 것이고, 다른 하나는 턴이 없을 때 서버의 유휴 폴러가 읽는 것이다(시작 시 한 번, 그 뒤 15분마다, 창 `end` 가 지나면 다음 틱에). 이 키가 없으면(옛 서버, 아직 못 읽음) UI 는 이전처럼 상태 문장을 보이고, 옛 UI 는 이 키를 무시한다. 창 `end` 가 지난 값은 새 창(0%, 추정)으로 본다. AutoRoute 는 85% 이상 사용을 막힘으로 본다. `status` 는 Grok 엔진의 `hello.grok.bin`(위 `grok` 기능 행)이 없으면 카드 자체를 숨기는 판단에 쓰지 않는다(그건 `grok.bin` 이 정한다).

외부 대화 가져오기 1차(규칙 1, 선택 필드만; 설계: `docs/superpowers/specs/2026-10-18-gemini-grok-imports-design.md`): 사이드바 `SessionEntry`(`src/shared/session-types.ts`) 에 `autoRun?`(Grok 헤드리스 세션), `grokModel?`·`grokEffort?`(가져온 Grok 세션이 쓰던 값; 첫 전송의 기본값), `source?: 'grokbot'`·`readOnly?`(Grok Bot 앱 대화 — `engine: 'grok'` 그대로, `EngineKind` 는 늘리지 않는다), `grokBot?: { description?, awaitingUserResponse, unreadCount, isGroup }`, `preview?`(목록 미리보기 한 줄)를 더했다. 가져온 항목은 기존 Codex 가져오기처럼 `imported: true` 이고, Grok CLI·agy(Gemini) 대화는 메시지를 보내면 deck 세션이 된다. Grok Bot 대화(id 접두 `grokbot-`)는 보낼 수 없다 — 서버는 `error`("Grok Bot 대화는 Grok Bot 앱에서 이어가세요")로 거절하고 새 세션으로 넘기지 않는다. `open_session` 의 `history.messages` 는 Grok(가져온 것과 deck 자신의 것 모두)이면 `chat_history.jsonl` 에서 읽어 채우고, Grok Bot 이면 앱의 transcript 에서, agy 는 빈 배열이다(이전 메시지는 agy 가 기억). 터미널 grok 이 같은 세션 id 를 열고 있으면 전송을 `error` 로 거절한다. `usage` 에는 최상위 `grokBot?: GrokBotUsage`(`{ percentUsed, nextResetMs, planLabel, readAtMs }`, `src/shared/usage-types.ts`; Grok Bot 앱이 캐시한 주간 사용량, macOS 만 — 없으면 필드 자체를 뺀다, `null` 은 보내지 않는다)을 더했다. 옛 UI 는 모르는 필드를 무시한다.

## 총사령탑 (`commander`)

기존 Claude 세션에 목표를 걸어 두면 세션이 쉴 때마다 판정해 다음 지시를 보낸다(설계: `docs/superpowers/specs/2026-10-18-commander-design.md`). 모두 `commander` 기능이 있는 서버에서만 쓴다.

- 클라이언트 → 서버 (3+1)
  - `commander_set{sessionId, goal, done, maxTurns?}` — `goal`·`done` 은 앞뒤 공백을 뺀 1~2000자, `maxTurns` 는 정수 1~50(없으면 설정값, 기본 20).
  - `commander_stop{sessionId, epoch}` · `commander_pause{sessionId, epoch}` · `commander_resume{sessionId, epoch}` — `epoch` 은 기기가 마지막으로 본 값. 재개는 `paused`·`waiting_human` 일 때만 듣는다. 이미 끝난(`stopped`·`done`·없음) 사령탑의 정지는 그대로 성공.
- 서버 → 클라이언트
  - `commander{sessionId, state, lastVerdict?, note?}` — 바뀔 때마다 그 세션을 보는 소켓에 방송. `state` 는 `status`(`idle`·`armed`·`sending`·`running`·`judging`·`waiting_human`·`paused`·`stopped`·`done`)·`hop`·`maxTurns`·`epoch`·`goal`·`done`·`budget`, `lastVerdict` 는 `{verdict: continue|human|done, reason, next?, evidence?: {testRunId}, atMs}`, `note` 는 서버의 사유 한 줄(`자동 재시도 예정(HH:MM)`, `권한 카드 응답 대기`, `턴 상한 도달(n/m)`, `재시작으로 끊김 · 재개` 등).
  - `history.commander` / `catchup.commander`(SessionFacts) — 같은 모양, 사령탑이 없으면 `null`. 재연결한 기기는 여기서 칩을 되살린다. UI 는 기기에 아무것도 저장하지 않는다.
  - 자동 턴의 `turn_result.auto: 'commander'` — 그 턴은 완료 푸시를 따로 보내지 않는다.
- 거절은 `error{turnId: null, sessionId, code, message}` 뒤에 그 세션의 현재 `commander` 를 다시 보낸다. `code`(RefusalCode):

| code | 뜻 | UI 문구 |
|---|---|---|
| `commander_bypass` | 세션이 모두 자동 승인(bypass) 모드 | 모두 자동 승인 세션에는 걸 수 없습니다 |
| `commander_active` | 이미 걸려 있음(먼저 정지). 걸려 있는 동안 `set_permission_mode` 로 bypass 로 바꾸는 것도 이 코드로 거절 | 이미 진행 중입니다 — 먼저 정지하세요 |
| `commander_engine` | deck 이 모르는 세션이거나 Claude 세션이 아님 | deck 에서 돌린 Claude 세션에만 걸 수 있습니다 |
| `commander_disabled` | 설정에서 꺼져 있음(`commander_stop` 은 꺼져 있어도 듣는다) | 총사령탑이 꺼져 있습니다 — 설정에서 켜세요 |
| `commander_stale_epoch` | 보낸 `epoch` 이 지금 것과 다름(다른 기기가 다시 걸었음 등) | 화면이 오래됐습니다 — 다시 시도 |

`mac_confirm_required`(RefusalCode, 사령탑과 별개): 클라우드 릴레이로 온 폰 요청 중 Mac 에서 직접 해야 하는 것을 Mac 의 브리지가 답한다 — 로컬 서버에는 닿지 않는다.

| 경로 | 막는 것 | 답 |
|---|---|---|
| ws | `set_permission_mode`(acceptEdits·bypassPermissions), `set_settings`(`autoApprove: true`·`defaultPermissionMode` 올림·`commanderEnabled: true`·`experimental` 값을 `true` 로·`autoConsent` 넓히기), `send`(`permissionMode` 올림·기존 세션의 `sandbox: 'workspace-write'` — 새 세션은 Mac 기본값이라 허용), `set_sandbox`(`workspace-write`), `grok_unlock` — 조각난 메시지는 이어 붙인 뒤(최대 1MiB) 본다 | `error{turnId: null, code: 'mac_confirm_required', message, clientRef?, sessionId?}` |
| HTTP | `/api/restart`·`/api/setup*`·`/api/login`·`/api/logout`, GET 아닌 `/api/server-update*`·`/api/memory*`, `/api/cloud/status`(GET) 밖의 `/api/cloud*` — 경로는 퍼센트 디코딩·정규화한 뒤 보고, 디코딩·정규화로 바뀌는 경로는 아예 `403 forbidden` | `403 { error: 'mac_confirm_required', code: 'mac_confirm_required' }` |

- 켜기·끄기: `set_settings.commanderEnabled`(선택). 답인 `settings` 방송에는 그때만 `features`(새 기능 목록)가 붙는다 — UI 는 그 목록으로 `has('commander')` 를 바꾸고, 목록에서 빠지면 캐시한 칩·거절을 비운다. 끌 때 서버는 활성 사령탑을 모두 `stopped`(사유 `설정에서 꺼짐`, epoch 증가)로 바꿔 방송한 뒤 `settings` 를 보낸다. 상한들(`commanderMaxTurns`·`commanderTokenCap`)은 설정 파일에서만.

## 자동 분배 (`engine: 'auto'`)

새 세션 첫 턴에서 엔진·모델을 고른다(설계: `docs/superpowers/specs/2026-10-18-auto-route-design.md` §10). 별도 기능 플래그는 없다.

- `send.engine: 'auto'`(새 세션), 또는 `send.engine` 이 `codex`·`gemini`·`grok` 이고 `model: 'auto'` 이면 서버가 첫 턴 내용·남은 한도·설정으로 정한다. `engine: 'claude'`(또는 없음) + `model: 'auto'` 는 이전처럼 Claude 모델만 고른다. 고른 결과는 `turn_started.reason`(배지, `자동 · … → <엔진> <모델>`)으로 보인다. 총사령탑 턴은 Claude 만.
- 쓸 수 있는 엔진이 없으면 `error{turnId, sessionId: null, message: "자동 분배: 쓸 수 있는 엔진 없음 — Claude: …, GPT: …, Gemini: …, Grok: …"}`.
- `route_fit{turnId, sessionId, engine, need, clientRef?}` — 고른(또는 지정한) 엔진이 이 턴을 못 할 때 턴을 시작하지 않고 보낸다. `need` 는 `셸 실행`·`신뢰 폴더(HOME) 밖 파일 편집`·`설명 외 작업(셸·편집 엔진)`(Gemini), `이미지 입력`(Grok). 새 세션이면 `sessionId: null`, 기존 Gemini·Grok 세션은 매 턴 같은 검사를 받고 그 세션 id 가 실린다. `turn_started` 전에 오므로 `clientRef` 가 붙는다. UI 는 "이 작업은 ○○ 가 필요합니다" 카드와 [그래도 보내기]를 띄운다. 새 세션으로 이어가기는 Claude 세션 전용이라 카드에 없다.
- `send.ignoreFit: true` — 위 검사를 건너뛰고 그대로 보낸다([그래도 보내기]).
- 설정(`settings` / `set_settings`, 모두 선택): `autoEngines`(자동이 고를 수 있는 엔진, 기본 4개 전부), `autoConsent`(데이터 전송에 동의한 엔진, 기본 `[]` — Gemini·Grok 은 여기 있어야 후보가 된다), `grokFast`(Grok 빠른 모델, 기본 `false`). 엔진 배열은 `claude`·`codex`·`gemini`·`grok` 중에서만, 잘못된 값은 이전 값을 유지한다.

## HTTP: 세션 폴더 파일

HTTP 는 새 경로·쿼리만 더하고 기존 응답 모양은 바꾸지 않는다. 아래는 모두 로그인 쿠키가 필요하고(없으면 `401`), POST 는 같은 출처(`Origin` 또는 `Sec-Fetch-Site: same-origin`)여야 한다(아니면 `403`). 세 경로 모두 `GET /api/file` 미리보기와 같은 검사(`openSessionPath`, `src/server/files.ts`)를 거친다: `cwd` 가 허용 루트 안의 실제 폴더, 대상의 실제 경로(심볼릭 링크 해제)가 그 안, 비밀 파일 deny list, O_NOFOLLOW 로 열기, 연 파일과 검사한 파일의 inode 일치, 하드링크 거부. 에러는 언제나 `{ error: string }`(한국어 문구) JSON.

- `GET /api/file?cwd=<절대경로|~/…>&path=<cwd 기준 상대·절대·~/ 경로>[&session=<id>]` — 미리보기(기존). `{ path, size, kind: 'text', text }` 또는 `{ path, size, kind: 'image', mediaType, base64 }`. 2MB 초과 `413`, 바이너리·UTF-8 아님 `415`.
- `GET /api/file?cwd=…&path=…[&session=…]&raw=1[&download=1]` — 원본 바이트를 그대로 스트리밍(50MB 까지). 헤더: `Content-Type` 은 PNG/JPEG/GIF/WebP 를 내용으로 판별한 타입, 그 밖엔 확장자 기준(텍스트·코드·`svg`·`html`·`htm`·`xml` 은 모두 `text/plain; charset=utf-8`, `pdf` → `application/pdf`, 몇몇 오디오·비디오), 모르면 `application/octet-stream`. `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Disposition: inline; filename*=UTF-8''<RFC 5987 인코딩 파일명>`(`download=1` 이면 `attachment; …`). 에러: cwd 문제 `400`, 경로 없음·폴더 `400`, 폴더 밖·deny list·하드링크 `403`, 없는 파일 `404`, 50MB 초과 `413`.
- `POST /api/reveal` body `{ cwd: string, file: string }` — 서버 Mac 의 Finder 에서 보여 준다(파일도 폴더도 언제나 `open -R` 로 선택해 보여 준다 — 폴더를 `open` 으로 열면 `.app` 같은 번들이 실행되므로 쓰지 않는다). **서버 Mac 화면에 열리므로 원격 기기의 사용자에게는 보이지 않는다.** 성공 `204`(본문 없음). 에러: body 형식·cwd `400`, 폴더 밖·deny list `403`, 없는 경로 `404`, Finder 실행 실패 `500`, 서버가 macOS 가 아니면 `501` `{ error: '서버가 macOS 가 아니라 Finder 를 열 수 없습니다' }`.

옛 서버는 `raw=1` 을 무시하고 미리보기 JSON 을 돌려주고, `/api/reveal` 에는 `404` 로 답한다. 그래서 UI 는 두 경로를 `fileRaw` 기능(위 표)이 있는 서버에서만 부른다.

기능 이름이 아닌 것: 턴 뒤 목록 갱신. 서버는 실행이 끝날 때 목록이 달라졌으면 `index` 를 보내지만, 백그라운드 작업으로 프로세스가 열려 있으면 턴 결과 뒤에도 보내지 않는다. 그래서 UI 는 서버 버전과 상관없이 턴 결과 3초 안에 `index` 가 없으면 `refresh_index` 를 보낸다(`ui/indexRefresh.ts`).

## 끊긴 구간 따라잡기 (`catchup`)

- 서버는 세션 id 가 정해진 뒤의 모든 턴 이벤트에 `pos: { sid, epoch, seq }` 를 붙인다. `seq` 는 세션마다 1 씩 늘고(서버 재시작 전까지), `epoch` 은 그 이벤트를 낸 프로세스(첫 턴 id)다. `history.pos` 는 그 시점의 마지막 위치.
- 서버는 실행 중인 프로세스마다 최근 이벤트를 보관한다(5000개 · UTF-8 4MiB, `CATCHUP_KEEP_*`; 가장 새 이벤트 하나는 크기와 상관없이 남긴다). 턴이 끝난 뒤 10분 동안 아무 이벤트가 없는 프로세스의 보관분은 비운다(`CATCHUP_IDLE_MS`) — 그 뒤 뒤처진 기기는 전체 `history` 를 받는다.
- UI(`src/ui/catchup.ts`)는 화면에 열린 세션마다 마지막으로 적용한 `pos` 를 기억한다. 이미 적용한 번호는 버리고, 번호가 건너뛰면 적용하지 않고 `open_session { after: { epoch, seq } }` 를 보낸다. 재연결(`hello`)과 화면 복귀 때도 같은 요청을 보낸다.
- 서버의 답은 둘 중 하나다.
  - `catchup`(기록 없이 실행 상태·`acceptedRefs` 만) 뒤에 `after` 다음 이벤트들을 원래 모습 그대로. 조건: `after` 가 그 세션의 가장 새 프로세스 위에 있고, 뒤처졌다면 그 프로세스가 살아 있으며 빠진 구간 전체가 보관돼 있을 것. 뒤처지지 않았다면 프로세스가 살아 있거나 그 소켓이 세션을 계속 보고 있었을 것.
  - 그 밖에는 지금처럼 전체 `history`. 일부만 보내는 일은 없다.
- 요청에 오류가 오면 1초 뒤 다시 묻고, 실패할 때마다 두 배로 늘려 30초까지 간다. 답을 받거나 재연결·화면 복귀 때 1초로 돌아간다. 같은 오류는 한 번만 보여 준다. `code: 'not_found'`(없는 세션)는 다시 묻지 않는다.
- 답이 아예 없으면 같은 소켓에 다시 보내지 않는다. 30초 동안 답이 없으면 그 소켓을 버리고 새로 연결한다(새 `hello` 에서 다시 묻는다).
- `history.acceptedRefs` 에 이 패널이 보내고 기다리던 `clientRef` 가 있으면, 그 `turn_started` 는 이미 지나간 것이다(순번이 건너뛰어 적용되지 않았을 수 있다). 패널은 기다림을 풀고 실행 중인 턴을 자기 것으로 삼는다.

## 앞쪽 기록 이어 불러오기 (`olderHistory`)

- `history` 는 지금처럼 기록의 마지막 200개(`messages`)를 보낸다. `older` 는 선택 필드다. 문자열이면 그 앞이 더 있고 그 값이 다음 요청의 커서다. `null` 이면 `messages` 가 기록의 처음부터다. 없으면 모름(옛 서버, Gemini·Grok Bot 처럼 앞쪽을 읽을 수 없는 세션, 테스트가 주입한 읽기 함수) — UI 는 버튼도 끝 표시도 내지 않는다.
- 커서는 UI 에게 불투명한 문자열이다(최대 `OLDER_CURSOR_MAX` = 64자). 서버 안에서는 `<종류><위치>.<표지>` 꼴이다. 종류·위치는 Claude 가 `i<절대 순번>`(그 창 첫 메시지가 기록 전체에서 몇 번째인지), Codex·Grok 이 `b<바이트 오프셋>`(첫 메시지를 만든 줄이 시작하는 바이트)이다. 표지는 그 파일의 dev:ino 와 첫 1KB 를 sha1 한 앞 8자(16진)다 — 다른 파일(다른 사본, 다시 쓰인 기록)의 커서는 읽지 않고 `bad_cursor` 로 거절한다. 표지 없는 옛 꼴(`i250`)도 거절한다.
- `history.at`·`older_history.at`(선택): `messages` 가 시작하는 곳을 같은 꼴의 커서로 준다(`older` 가 없으면 없음). UI 는 패널 항목이 시작하는 곳으로 기억해 두었다가 같은 세션을 다시 열 때(`open_session` — 재연결·catchup 실패·다시 열기) `from` 으로 보낸다. 서버는 `from` 이 지금 파일의 커서이고 거기서 끝까지가 `HISTORY_FROM_MAX`(2000개) 이하면 거기부터 끝까지를 `history` 로 보낸다(불러온 앞쪽 페이지가 그대로 남는다). 넘거나 다른 파일의 커서면 평소 창(마지막 200개)이다. Codex·Grok 은 `from` 부터 한 번만 읽는다 — 200개 미만이면 평소 창, 2000개를 넘으면 같은 읽기의 마지막 200개다. Claude 는 앞쪽까지 거슬러 읽는 것(표지 확인 포함)도 한 번의 읽기에 들어가서, 그동안 끝난 백그라운드 구간이 있으면 통째로 다시 읽는다. 재시작 직후처럼 표지(mark)가 없으면 파일 처음부터 훑게 되는데, `HISTORY_FROM_SCAN_BYTES`(32MB)를 넘게 훑어야 하면 거기서 멈추고 평소 창을 보낸다(남긴 표지는 다음 열기에 쓴다).
- 클라이언트: `load_older { sessionId, before, reqId? }`. 서버: `older_history { sessionId, before, reqId?, messages, older, at?, error? }` — `messages` 는 `before` 바로 앞의 최대 200개(오래된 것 먼저, 이미 가진 것과 겹치지 않음), `older` 는 `history.older` 와 같은 뜻. 요청한 소켓에만 답한다(규칙 3: 요청이 있을 때만).
- `error`(빈 `messages`, `older: null`): `'not_found'` 없는 세션, `'bad_cursor'` 이 세션의 커서가 아님(앞쪽을 읽을 수 없는 세션 포함 — 기록이 다시 쓰였거나 만든 값. 다시 물어도 같으니 UI 는 앞쪽 상태를 버리고 `from` 없이 `open_session` 으로 세션을 새로 연다 — 세션마다 10초에 한 번까지, 그렇게 받은 첫 `history` 에서는 위로 올려 자동으로 불러오지 않고 버튼으로만 한 페이지를 받는다), `'read_failed'` 파일을 읽지 못함(다시 시도 가능). 사람이 읽을 문장은 싣지 않는다 — UI 가 자기 언어로 보인다.
- 앞쪽 페이지는 머리(최근 창)·`pos`·`catchup` 과 따로 논다. 서버는 `load_older` 를 받아도 보기 상태·스트림 위치를 건드리지 않고, UI 는 받은 페이지를 항목 앞에 붙이기만 한다. 새 `history`(다시 열기·밖에서 바뀐 기록)가 오면 앞쪽 상태는 그 `history` 의 `older`·`at` 으로 다시 시작한다. 불러온 페이지가 남는 것은 `from` 덕이다: 서버는 소켓·세션마다 그 소켓이 불러온 가장 앞 페이지의 `at`(또는 받은 `from`)을 기억해 두고 — 이어지는 페이지만 센다: 보낸 창의 맨 앞(`at`)을 `before` 로 한 페이지만 그 값을 옮기므로, UI 가 버린 늦은 답이나 다른 커서의 페이지는 세지 않는다 — 밖에서 바뀐 기록을 다시 보낼 때(15초 폴링) 그 값을 `from` 으로 써서 읽는다(같은 `from` 끼리 한 번만 읽는다). 앞쪽 페이지가 붙을 때(새 항목의 꼬리가 이전 항목 배열 그대로) UI 는 렌더 중에 읽어 둔 `scrollHeight`·`scrollTop` 으로 `scrollTop = 이전 scrollTop + (새 높이 − 이전 높이)` 를 맞춘다 — 번호 없는 Codex·Grok 항목이나 첫 프롬프트 앞 항목은 키가 자리값이라 DOM 노드로는 기준을 잡을 수 없기 때문이다. 기록이 통째로 바뀌어 화면 위쪽에 보던 항목이 DOM 에 그대로 남으면(같은 messageKeys), UI 는 그 항목이 움직인 만큼만 `scrollTop` 에 더해 보던 자리를 지킨다(불러오는 중 줄·시각 줄처럼 함께 나타나고 사라지는 줄은 기준으로 삼지 않는다).
- UI 는 패널마다 진행 중 요청 하나(`reqId`)만 둔다. 답의 `sessionId`·`reqId`·`before` 가 그 패널이 지금 보는 세션·진행 중 요청·커서와 모두 같을 때만 붙인다 — 세션을 바꾸거나 다시 연 뒤 늦게 온 답은 버린다. 재연결(`hello`)하면 진행 중 요청을 잊고 다시 물을 수 있게 한다. 페이지 경계에서 호출이 앞 페이지에 있는 도구 결과는 들고 있다가 그 페이지가 오면 붙인다.
- 서버 비용: Claude 는 첫 요청 때 기록을 `before` 까지 한 번 훑으며 약 1MB 마다 표시(빌더 상태)를 남기고(메모리, 파일 8개까지, 파일이 커지기만 하면 유지), 다음 페이지부터는 가까운 표시에서 이어 읽는다. 표시는 파일당 64개까지다 — 넘으면 하나 걸러 버리고 간격을 두 배로 늘린다. Codex·Grok 은 커서 앞 1MB 부터 읽어 페이지가 찰 때까지 두 배씩(최대 64MB) 넓힌다. 처음 여는 창은 메시지를 200개 남짓만 들고 읽는다(빌더가 앞쪽을 잘라 냄 — 긴 rollout 도 전체를 메모리에 올리지 않는다). 한 줄이 읽는 구간보다 길어 구간에 메시지가 하나도 없어도, 파일 처음이 아니면 커서를 준다(`null` 로 "처음" 이라 하지 않는다). Codex 는 구간 첫 메시지가 더 앞에서 시작된 것일 수 있어 다음 페이지로 넘기고, 구간 안 첫 `turn_context` 이전 assistant 의 `model` 은 알 수 없어 `null` 이다.

## 잠긴 GPT 스레드 (`turn_result.errorCode`)

- `turn_result.errorCode?: 'thread_locked'` — GPT 턴이 "already has an active writer"(ChatGPT 데스크톱 앱이 같은 스레드를 열어 둠)로 실패했을 때만 붙는다. 옛 클라이언트는 무시한다. 기능 이름이 아니다: UI 는 이 값이 있거나, 옛 서버 대비로 `errorText` 가 `THREAD_LOCKED_MESSAGE`(`src/shared/handoff.ts`)로 시작하면 잠김으로 본다(`isThreadLocked`).
- 잠김으로 실패한 턴 아래에 [deck 에서 새 GPT 세션으로 이어가기]가 뜬다. 서버 왕복 없이 클라이언트가 같은 폴더·모델·샌드박스의 새 GPT 세션을 열고, 이전 대화 발췌(메시지당 2,000자, 전체 12,000자 — 오래된 것부터 버림)와 실패한 요청을 입력창에 채운다(`codexHandoffMessage`). 첫 전송의 `send.handoffFrom` 으로 두 세션이 이어진다.
