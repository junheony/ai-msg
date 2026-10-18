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
| `catchup` | 턴 이벤트에 `pos` 를 붙이고 `open_session.after` 에 답한다 | 재연결 때 전체 기록을 다시 받음 |
| `accounts` | `hello.accounts` 로 Claude 계정 목록(`{ id, label, home, retired }`, 설정 순서, 뺀 계정 포함)을 알린다 | 계정은 a/b/c, A 가 Desktop |
| `sessionSandbox` | `set_sandbox` 로 기존 GPT 세션의 샌드박스를 바꾸고, `open_session.accepts` 에 `'sandbox'` 를 넣은 소켓에만 `sandbox` 메시지로 알린다. `catchup.sandbox` 도 채운다 | 기존 GPT 세션의 샌드박스 칩은 표시만 |
| `routePreview` | `route_preview{sessionId, cwd?, model?}` 에 `route_preview{sessionId, account, reason, asOpus?}` 로 답한다(Claude 세션만; GPT·Gemini·모르는 id·뺀 계정 세션, 새 세션의 `자동` 은 답 없음). 소켓마다 마지막 요청을 기억해 사용량이 바뀌어 답이 달라지면 다시 보낸다. `sessionId: null` 에 `cwd` 가 없으면 요청 철회 | 상단 사용량 카드에 `다음` 표시 없음(요청도 보내지 않음) |
| `highlights` | `GET /api/highlights?hours=6\|12\|24`(그 밖의 값은 24)에 `{ hours, events }` 로 답한다(세션 하이라이트, `events.jsonl` 7일치) | 작업 현황의 `하이라이트 보기 →`, ⌘K `하이라이트 보기`, 설정의 `하이라이트` 를 숨김 |
| `fileRaw` | `GET /api/file?…&raw=1[&download=1]` 로 원본 바이트를 주고 `POST /api/reveal` 로 서버 Mac 의 Finder 를 연다(아래 "HTTP: 세션 폴더 파일") | 파일 칩·사이드 패널의 `다운로드`·`Finder 에서 보기`·`새 탭에서 크게`, 폴더 칩의 `Finder 에서 열기` 를 숨기고, 답장 안 이미지 경로는 썸네일 대신 칩으로 |
| `serverUpdate` | `GET /api/server-update` 에 `{ changedFiles, newestAt, supervised, draining, activeTurns }`(서버가 뜬 뒤 바뀐 `src/server`·`src/shared` 의 테스트 아닌 `.ts` 수, `activeTurns` = drain 이 기다리는 턴·백그라운드 작업 프로세스 수), `POST /api/restart` 에 SIGUSR2 와 같은 drain 으로 답한다. 관리자(relaunch 루프·launchd) 아래가 아니면 — 요청마다 부모가 relaunch 루프인지 확인 — 409, 이미 drain 중이면 아무것도 안 하고 `{ ok, draining: true }`. 본문 `{"force":true}` 는 두 번째 SIGUSR2 와 같다(작업 끊고 지금 재시작): drain 중일 때만 남은 턴·백그라운드 작업을 중단하고 바로 종료해 관리자가 다시 띄우며 `{ ok, draining: true, forced: true }`, drain 중이 아니면 400 으로 거절하고 아무것도 시작하지 않는다. 쿠키·Origin 검사와 409 는 같다 | `서버 업데이트 대기` 칩·`지금 재시작` 을 숨김 |
| `commander` | 총사령탑(아래 "총사령탑"). 설정 `commanderEnabled` 가 켜져 있을 때만 알린다 — 설정 화면 토글로 바꾸면 `settings` 방송에 새 `features` 를 실어 보낸다 | ⋯ `총사령탑 걸기…`·머리 칩·설정 토글 없음 |

| `grok` | Grok 엔진(`send.engine: 'grok'`, 모델 `grok-4.7`(기본)·`grok-4.7-build-fast`·`grok-4.6`·`grok-4.5`, 자리 `x1`). 서버가 `grok` 바이너리를 찾았을 때만 알리고, `hello.grok: { bin, version?, locked? }` 에 찾았는지와 `grok --version` 첫 줄, 엔진 잠금 사유(`locked`: 문자열이면 잠김, `null`·없음이면 풀림)를 싣는다(버전을 못 읽어도 `bin: true`). 잠금이 걸리거나 풀리면 서버가 `grok_status{grok}` 를 모든 소켓에 보내고, 클라이언트는 `grok_unlock` 으로 잠금을 푼다(설정 → 권한의 `잠금 해제`). 잠긴 동안 Grok 턴은 `errorKind: 'grok_engine_locked'` 로 끝난다. 권한 모드는 즉시 적용되고(턴 도중 바꿔도 다음 승인 요청부터), `plan` 은 거절한다(`set_permission_mode` 는 `error` 로 답하고, `send` 는 엔진이 거절 문구로 끝낸다). Grok 세션은 승인 카드·자동 승인·실행 중 메시지(steer)·감사 로그를 Claude 와 같은 길로 쓰고, `open_session` 의 기록은 Gemini 처럼 비어 있다(`engine: 'grok'`, `permissionMode`). 총사령탑(`commander_engine`)·작업 폴더 바꾸기·포크·인계는 거절. 이미지 첨부는 엔진이 거절 문구로 답한다 | 엔진 선택의 Grok 을 흐리게(`Grok · 설치 필요`) |

기능을 더할 때: `FEATURES` 에 이름을 더하고, UI 는 `has()` 로 갈라 쓰고, 이 표에 한 줄 더한다. 배포된 이름은 지우지 않는다.

기능 이름 없이 `open_session.accepts` 로만 여는 서버 메시지(규칙 3): `'sandbox'`(위 표), `'turn_queued'` — 백그라운드 작업으로 열어 둔 프로세스에 보낸 메시지가 스트리밍 중인 구간(`백그라운드 계속` 등) 뒤에서 기다릴 때 보낸 소켓에만 `turn_queued{clientRef, behind}` 를 보낸다(옛 UI 는 `시작하는 중…` 그대로). 그 메시지의 취소는 `cancel_queued{sessionId, clientRef}` 로 서버 큐에서도 뺀다(답 없음; 이미 들어갔으면 그 ref 의 `turn_started` 가 평소처럼 온다).

계정 고정(`send.accountPin`, `set_account_pin.pin`)의 id 는 모양(`ACCOUNT_ID_RE`, `src/shared/accounts.ts`)만 스키마에서 보고, 어떤 계정이 있는지는 서버가 처리할 때 설정으로 확인한다. 설정에 없는 id 와 뺀 계정(retired)은 `error` 로 거절한다. 옛 UI 가 보내는 a/b/c 는 그대로 통과한다.

ws 메시지가 아닌 것: 하이라이트(`GET /api/highlights?hours=6|12|24`, 그 밖의 값은 24 → `{ hours, events }`)는 HTTP 로만 읽는다. 서버는 `highlights` 기능(위 표)으로 알리고, 그 기능이 없는 서버면 UI 는 들어가는 곳을 보이지 않는다.

기능 이름이 아닌 것(규칙 1, 선택 필드): `hello`/`history`/`catchup` 의 `usage`(`UsageSnapshot`, `src/shared/usage-types.ts`) 는 사용량 헤더 개편(`docs/superpowers/specs/2026-10-18-usage-header-design.md`)으로 `geminiSeats?: Partial<Record<'g1' | 'g2', GeminiUsage>>` 와 `grokSeats?: Partial<Record<'x1', GrokUsage>>` 를 더했다. 둘 다 없거나 그 키가 없으면 그 좌석 카드는 없다(옛 서버·agy/grok 미설치·아직 못 돌린 턴). 기존 `gemini`(단일, g1 과 같은 값)는 구버전 UI 호환을 위해 당분간 함께 보낸다 — `geminiSeats` 가 없는 UI 는 `gemini` 만 본다. `GrokUsage`(`{ status, lastTurnAt, lastError, cooldownUntil, today }`) 는 공식 한도 API 가 없어 deck 자신의 Grok 턴 결과에서만 채운다; `status` 는 Grok 엔진의 `hello.grok.bin`(위 `grok` 기능 행)이 없으면 카드 자체를 숨기는 판단에 쓰지 않는다(그건 `grok.bin` 이 정한다).

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

- 켜기·끄기: `set_settings.commanderEnabled`(선택). 답인 `settings` 방송에는 그때만 `features`(새 기능 목록)가 붙는다 — UI 는 그 목록으로 `has('commander')` 를 바꾸고, 목록에서 빠지면 캐시한 칩·거절을 비운다. 끌 때 서버는 활성 사령탑을 모두 `stopped`(사유 `설정에서 꺼짐`, epoch 증가)로 바꿔 방송한 뒤 `settings` 를 보낸다. 상한들(`commanderMaxTurns`·`commanderTokenCap`)은 설정 파일에서만.

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
