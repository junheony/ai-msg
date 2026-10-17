# 총사령탑(commander) 설계 — 목표를 걸어 두면 턴이 끝날 때마다 판정해 이어 보내는 자동 지휘

> 2026-10-18. 상태: 설계 초안(구현 전). 관련: `2026-10-15-quarterdeck-paid-design.md` §3·§4, `src/server/turn/TurnRunner.ts`, `src/server/push/BottleneckWatch.ts`.
> 요금제 위치: **Pro**("자리를 비워도 멈추지 않는 자동화" 축 — 병목 알림·자동 재시도와 같은 칸). Free 는 목표 걸기 UI 는 보이되 "Pro 에서 켜집니다" 로 비활성.

## 1. 목표 · 비목표

**목표**
- 세션에 **목표 + 완료 조건**을 걸면, 턴이 끝날 때마다 가벼운 판정기(Sonnet, `claude -p`)가 결과를 읽고 **계속 / 사람 필요 / 끝** 셋 중 하나를 내린다.
- *계속* → 다음 지시를 같은 세션에 자동 전송. *사람 필요* → 푸시만 보내고 멈춘다. *끝* → 완료 푸시.
- 권한 카드·질문·결정·되돌리기 어려운 행동(배포·삭제·외부 전송·결제·force push)은 **항상 사람에게**. 모델 판정과 규칙 차단을 이중으로 둔다.
- 자동 턴 상한(기본 20)·토큰 상한·같은 실패 2회 정지·패널 표시(“사령탑 진행 중 · 7/20턴”)와 한 번 탭으로 정지.
- 서버 재시작 뒤에도 걸어 둔 목표가 이어진다(병목 알림의 `rearm` 과 같은 방식).

**비목표**
- 여러 세션을 조율하는 상위 계획기(세션 간 의존·분배)는 하지 않는다. 사령탑은 **세션 하나**만 지휘한다.
- 판정기가 코드를 읽거나 명령을 실행하지 않는다(도구 전부 거부, 입력은 턴 결과 요약만).
- `bypassPermissions` 세션에는 걸 수 없다(권한 카드가 사람 관문이므로 그 관문이 없는 세션은 대상에서 제외).
- 토큰 직접 사용·SDK+OAuth 없음. 판정기도 공식 `claude` CLI 헤드리스 + 구독 로그인(`--bare` 금지, 기존 `claudeArgs`/`claudeEnv` 규칙 그대로).

## 2. 사용자 흐름

| 입구 | 동작 |
|---|---|
| 패널 `⋯` 메뉴 → **총사령탑 걸기…** | 시트: 목표(필수, 1~2000자) · 완료 조건(필수, 1~2000자) · 턴 상한(기본 20, 1~50). "걸기" 를 누르면 `commander_set`. 세션이 idle 이면 첫 지시를 바로 보내고, 턴 중이면 그 턴이 끝난 뒤 판정부터 시작. |
| composer 명령 `/commander 목표 -- 완료 조건` | 같은 `commander_set`. `/commander stop`, `/commander resume`. 자동완성(`autocomplete.ts`)에 등록. |
| 폰 | 같은 시트(바텀시트). 탭 줄의 세션 칩에 작은 "⚑ 7/20" 배지, 길게 누르면 정지. |
| 진행 표시 | 패널 머리에 칩 **"사령탑 진행 중 · 7/20턴"** + ■ 정지 버튼(한 번 탭, 확인 없음). 상태별 문구: 판정 중 · 사람 필요 · 일시 정지 · 끝 · 상한 도달 · 정지됨. 칩을 누르면 마지막 판정(이유 한 줄·다음 지시)이 펼쳐진다. |
| 알림 | *사람 필요*: 푸시 "사령탑 · 판단이 필요합니다 — {이유}". *끝*: "사령탑 · 목표 달성 — {요약}". 상한·토큰·같은 실패 정지도 *사람 필요* 로 보낸다. 자동 턴 자체의 완료 푸시는 **내지 않는다**(사령탑이 대신 판단). |
| 사용자 메시지 우선 | 사령탑이 건 세션에 사용자가 메시지를 보내면 그 턴은 사용자 턴이고 사령탑은 **일시 정지**(`paused`). 진행 중 자동 턴은 끊지 않고 기존 규칙대로 후속(follow-up)·조향으로 합쳐진다. 사용자 턴 결과는 판정하지 않는다. 칩의 **재개** 를 누르거나 `/commander resume` 하면 다음 판정부터 다시 돈다. 목표·카운터는 그대로. |

## 3. 판정기 입력 · 출력

**실행**: `claude -p --output-format json --model <sonnet> --permission-mode default --disallowedTools "*"`(도구 전부 거부; 핸드오프 턴의 `noTools` 와 같은 효과) + `--setting-sources user` + `--settings=<빈 settings>`(프로젝트 훅·MCP 비활성) · cwd 는 `configDir/commander/`(프로젝트 폴더가 아님 — 기록이 프로젝트 세션 목록에 섞이지 않고, `entrypoint: sdk-cli` 세션 숨김 규칙에 걸려 사이드바에도 안 뜬다). 타임아웃 90초, 1회 재시도. 입력은 stdin 한 건.

**입력(사용자 메시지 본문, 크기 제한)** — `TurnDigest` 로 TurnRunner 가 턴마다 만든다.

| 항목 | 출처 | 상한 |
|---|---|---|
| 목표 · 완료 조건 | `CommanderState` | 각 2,000자 |
| 지금까지 자동 턴 수 / 상한, 직전 판정 2건(이유 한 줄씩) | `CommanderState` | 300자 |
| 마지막 턴 결과 요약 | `turn_result.text` 머리 1,500자 + 꼬리 2,500자(중간 생략 표시) | 4,000자 |
| 바뀐 파일 | Edit·Write·MultiEdit·NotebookEdit `tool_use.input.file_path` 집합(cwd 기준 상대) | 40개 |
| 테스트 결과 | Bash 명령 중 테스트 러너 패턴(`vitest|jest|pytest|go test|cargo test|npm test|pnpm test`)의 마지막 실행 — 명령 1줄 + 출력 꼬리 | 1,200자 |
| 실패 표시 | `turn_result.ok`, `errorText`(있으면), `classifyFailure` 결과(limit/transient/…) | 300자 |

합계 ≈ 8,000자 이하. 첨부·대화 이력·diff 본문은 넣지 않는다.

**프롬프트 골자(시스템 메모)**
```
너는 deck 총사령탑의 판정기다. 작업 세션의 마지막 턴 결과만 보고 JSON 하나로 답한다.
- 완료 조건이 증거(테스트 결과·바뀐 파일·결과 요약)로 충족됐으면 "done".
- 다음에 할 일이 분명하고 되돌리기 쉬우면 "continue" + 한 문단 지시(명령형, 300자 이내, 새 범위 추가 금지).
- 사용자 판단이 필요하거나(선택지·설계 결정·요구 불명확), 되돌리기 어려운 행동(배포·삭제·외부 전송·결제·force push·DB 변경)이 필요하거나,
  같은 실패가 반복되거나, 결과가 질문으로 끝났으면 "human" + 이유.
- 확신이 없으면 "human". 도구를 쓰지 말고 JSON 외의 텍스트를 쓰지 않는다.
```

**출력 스키마(zod, 위반 시 `human` 으로 처리)**
```ts
{ verdict: 'continue' | 'human' | 'done';
  reason: string;            // ≤ 200자, 칩·푸시에 그대로
  next?: string;             // continue 일 때 필수, ≤ 600자 — 다음 지시
  risk?: 'none'|'deploy'|'delete'|'external'|'payment'|'force_push'|'db'|'other';
  failureKey?: string;       // 실패했을 때 짧은 서명(예 "vitest ws.bottleneck timeout") — 같은 실패 감지용
  confidence: 'high'|'medium'|'low' }  // low → human 으로 강제
```

## 4. 상태 머신

```
idle ──commander_set──▶ armed ──(세션 idle)──▶ sending ──▶ running ──turn_result──▶ judging
                          ▲                                   ▲                        │
                          │                                   │ continue(검사 통과)     ├─ human / 규칙 차단 / 상한 ─▶ waiting_human
  commander_resume ───────┘                                   └────────────────────────┤
                                                                                       └─ done ─▶ done
paused   : 사용자 메시지(`onUserSend`) 가 오면 어느 상태에서든 진입(진행 중 턴은 그대로). resume → armed(세션 idle) 또는 running.
stopped  : ■ 정지 · /commander stop. 종결. 진행 중 자동 턴은 끊지 않는다(사용자가 원하면 기존 중단 버튼).
waiting_human : 사람 필요. 종결은 아니다 — 사용자가 답(권한·질문·메시지)을 보내면 paused 와 같이 "재개" 로 이어갈 수 있다.
```

전이 규칙: `judging` 에서 `continue` 라도 ①턴 상한 ②토큰 상한 ③`failureKey` 직전과 동일 ④`risk !== 'none'` ⑤규칙 차단 목록 매치 ⑥`confidence==='low'` ⑦판정기 호출 실패·JSON 위반 중 하나면 `waiting_human`. 판정기 호출 자체가 한도(limit)로 실패하면 라우터로 다른 계정 1회 재시도, 그래도 실패면 `waiting_human`("판정기 한도").

## 5. 안전장치와 위험 행동 판정(이중)

| 층 | 어디서 | 무엇을 |
|---|---|---|
| 1. 규칙(사전) | `commander/rules.ts` `screenInstruction(next)` | 판정기가 낸 다음 지시 본문을 정규식 차단 목록과 대조: `deploy|배포|release|publish|npm publish|rm -rf|삭제|drop table|truncate|migrate.*(prod|production)|git push.*(--force|-f)|force.?push|reset --hard|결제|payment|charge|send (mail|email|slack)|curl .*-X (POST|PUT|DELETE)|외부 (전송|발송)`. 매치 → `waiting_human`, 이유에 매치 토큰. |
| 2. 모델 | 판정기 `risk`/`verdict` | §3. 모델이 놓쳐도 1·3층이 받는다. |
| 3. 규칙(실행 중) | 기존 PreToolUse 릴레이(`hookRelay`·`permissions.ts`) | **자동 턴(`commanderHop` 있음)에서는** Bash 명령이 차단 목록에 걸리면 세션의 `allowRules`·`acceptEdits` 가 있어도 자동 승인하지 않고 권한 카드로 올린다. 권한·질문 카드는 어차피 사람에게 가며(`askPermission`/`askQuestion`), 이때 사령탑은 `waiting_human` 으로 전환하고 BottleneckWatch 의 10분 재알림이 그대로 붙는다. |
| 상한 | `CommanderState` 카운터 | 자동 턴 상한(기본 20, 설정 `commanderMaxTurns`), 토큰 상한(기본 2,000,000 — 자동 턴 `turn_result.usage` 입력+출력 누계, 설정 `commanderTokenCap`), 같은 `failureKey` 2회, 한 목표 벽시계 상한 12시간. |
| 중복 자동화 충돌 | TurnRunner | 기존 자동 경로(`continueAfterCap`·`failoverAfterBackground`·`bookRetry`)는 **한 턴 안의 복구**로 그대로 두고, 그 결과로 나온 최종 `turn_result` 하나만 사령탑이 판정한다. `pendingRetry` 가 예약된 세션은 그 재시도가 끝날 때까지 `running` 으로 본다. |
| 권한 모드 | `commander_set` | 세션 모드가 `bypassPermissions` 면 거절(`RefusalCode: 'commander_bypass'`). 자동 턴은 세션 모드를 그대로 쓰되 bypass 로 바뀌면 즉시 `paused`. |
| 감사 | `appendAudit` | 자동 전송마다 `{kind:'commander_send', sessionId, hop, hashInput(next)}`, 판정마다 `{kind:'commander_verdict', verdict, reason, judgeAccount}`. |

## 6. 서버 구성

새 모듈 `src/server/commander/` (경계: TurnRunner 는 **요약을 만들고 훅 하나를 호출**할 뿐, 판정·전송 결정은 모두 이 모듈).

| 파일 | 역할 |
|---|---|
| `types.ts` | `CommanderState { goal, done, maxTurns, hop, tokensUsed, status, startedAtMs, lastVerdicts: Verdict[≤2], lastDigest?: TurnDigest, pausedBy?: 'user'|'bypass' }`, `Verdict`, `TurnDigest`. `SessionBase.commander?: CommanderState` 로 **SessionState 에 저장**(새 파일 없음, 0600 원자 쓰기 재사용). |
| `digest.ts` | `TurnDigest` 조립 + 크기 절단(§3 표). 순수 함수, 테스트 쉬움. |
| `rules.ts` | 차단 목록·`screenInstruction`·`screenBashCommand`. 순수 함수. |
| `Judge.ts` | `judge(input, account): Promise<Verdict>` — `claude -p` 한 건 실행(`ClaudeProcess` + `claudeEnv` 재사용, 새 인자 빌더 `judgeArgs`), JSON 파싱·zod 검증, 타임아웃. 계정은 `chooseAccount({ needFable:false, policy, fixedAccount: undefined })` 로 **가장 여유 있는 계정**(home·protect 제외는 라우터 기본 그대로), 세션 계정 고정(`accountPin`)이 있으면 그 계정. 사용량 관측(`rate_limit_event`)은 기존 CLI 사용량 모드로 흘러든다. |
| `Commander.ts` | 상태 머신. 입력: `observeTurn(sessionId, digest)`, `userSent(sessionId)`, `set/stop/resume`, `rearm(states)`. 출력(deps): `send(r: {sessionId,cwd,text,hop})`, `push(payload)`, `record(event)`, `broadcast(msg)`, `store`. |

**TurnRunner 훅 지점**
- `TurnParams.commanderHop?: number`(서버 내부, `bgCapHop` 과 같은 급). turnId 접미 `:cmd<n>`(`:cap<n>` 패턴). `systemNote` 에 "deck 총사령탑 자동 지시 n/상한 — 목표: … 완료 조건: … 되돌리기 어려운 행동은 하지 말고 멈춰서 보고하세요" 를 덧붙인다(기존 `interrupted`·`DECK_INTRO_NOTE` 와 같은 자리).
- 턴 중 tool_use 를 이미 한 줄씩 기록하는 자리(현재 ~955행)에서 `digest.ts` 수집기에 파일·테스트 명령을 넘긴다.
- `followThrough` 가 `null`(진짜 종료)을 돌려주고 `turn_result` 를 emit 한 직후 새 dep `onTurnDigest?(sessionId, digest)` 호출. 실패 턴도 호출(`bookRetry` 가 예약됐으면 digest 에 `retryBooked: true`).
- `turn_result` 에 `auto?: 'commander'` 를 넣어 PushNotifier 가 완료 푸시를 건너뛰게 한다(`BottleneckWatch.observe` 는 그대로 본다).

**main.ts 배선**: `commander = new Commander({ store, judge, send: (r) => ws.submitServerSend(r), push: (p) => void push.sendAll(p), record: (e) => events.add(e), broadcast })`. `notify` 파이프라인은 그대로, `onUserSend` 에 `commander.userSent` 추가, 시작 시 `commander.rearm(store.list())`, 종료 시 `commander.stop()`. `ws.submitRetry` 는 `submitServerSend({…, kind:'retry'|'commander'})` 로 일반화(NO_DEVICE 전송 경로 공유, 거절돼도 상태는 남아 재시작 때 다시 시도).

**재시작 뒤 이어가기**: `rearm` — `sending/running/judging` 이던 세션은 `lastDigest` 가 있으면 그걸로 다시 판정, 없으면(턴이 shutdown 으로 끊김) `hop+1` 로 "이어서 진행해 주세요" 를 **한 번만** 보낸다(그 다음부터 정상 판정). `waiting_human/paused` 는 칩만 복원. 상한·시간은 계속 누적.

## 7. 프로토콜 · UI 변경

- `FEATURES` 에 `'commander'`. 클라이언트: `commander_set {sessionId, goal, done, maxTurns?}`, `commander_stop {sessionId}`, `commander_resume {sessionId}`. 서버: `commander {sessionId, state: Pick<CommanderState, status|hop|maxTurns|tokensUsed|goal|done>, lastVerdict?: {verdict, reason, next?, atMs}}` 브로드캐스트(`activity` 와 같은 뷰어 범위) + `SessionFacts.commander`(목록·재접속 복원).
- `RefusalCode` 추가: `commander_bypass`, `commander_busy_engine`(Codex·Gemini 세션은 1차 범위 밖 — 판정기는 Claude 지만 작업 세션 엔진은 상관없으므로 2차에서 열 수 있다), `commander_pro`.
- `DeckSettings`: `commanderMaxTurns: 20`, `commanderTokenCap: 2_000_000`(설정 화면 "자동화" 묶음).
- `HighlightKind` 에 `'commander'`(판정마다 한 줄: "계속 · 테스트 2개 실패 → 수정 지시" / "사람 필요 · 배포 필요"). `PushKind` 에 `'commander'`, tag `commander:<sessionId>` 로 같은 세션 알림 갈아끼움.
- UI: `⋯` 메뉴 항목, 시트 컴포넌트 `CommanderSheet.tsx`, 패널 칩 `CommanderChip.tsx`(정지·재개·펼침), 폰 탭 배지, composer `/commander`. 상태 저장은 서버 메시지만 믿고 로컬 저장 없음.
- `docs/protocol.md` 에 메시지 3+1 추가.

## 8. 비용 추정

| 항목 | 토큰(판정 1회) |
|---|---|
| 시스템 메모 + 스키마 설명 | ≈ 700 |
| 목표·조건·직전 판정 | ≈ 300~800 |
| 결과 요약 4,000자 + 파일 목록 + 테스트 꼬리 | ≈ 1,500~2,500 |
| 출력 JSON | ≈ 100~250 |
| **합** | **≈ 3,000~4,500 (Sonnet)** |

20턴 상한을 다 쓰면 판정 누계 ≈ 60~90k Sonnet 토큰. 작업 턴 하나(Opus/Fable, 보통 20k~150k)에 비해 턴당 5% 미만. 판정기는 캐시가 식어도 입력이 작아 계정 5h 창에 미치는 영향이 작고, 가장 여유 있는 계정으로 가므로 작업 세션 계정을 더 조이지 않는다. 비용 상한은 **작업 턴** 토큰 누계(§5)로 건다 — 판정 비용은 거기 넣지 않는다.

## 9. 테스트 전략

- **단위**(vitest, 소스 옆): `digest.test.ts`(절단·파일 집합·테스트 러너 매칭), `rules.test.ts`(차단 목록 양성·음성 — "삭제" 가 들어간 일반 문장 오탐 사례 포함), `Commander.test.ts`(상태 전이 표 전부: 상한·같은 실패·low confidence·JSON 위반·paused·resume·stop), `Judge.test.ts`(`fakeClaudeCli` 로 정상 JSON·깨진 JSON·타임아웃·limit 실패 → 계정 재시도).
- **통합**: `ws.commander.test.ts`(`commander_set` → 자동 전송 turnId `:cmd1` → 사용자 메시지 → paused → resume), `TurnRunner.commander.test.ts`(digest 훅이 `followThrough` 뒤 정확히 1회, cap/failover 중간에는 호출 안 됨, `auto:'commander'` 로 완료 푸시 억제), `main` 수준 `rearm` 테스트(상태 파일에서 running 복원 → 한 번만 "이어서").
- **보안/정책**: `noSdk.test.ts` 와 같은 방식으로 `judgeArgs` 에 `--bare`·`--dangerously-skip-permissions` 가 없고 `--disallowedTools "*"` 가 있음을 고정. bypass 세션 거절 테스트.
- **UI**: `App.commander.test.tsx`(시트 유효성·칩 상태 문구·정지 한 번 탭), 폰 폭 스냅샷.
- **수동 1회**: 실제 `claude -p` 로 판정 JSON 이 스키마에 맞는지, 사이드바에 판정 세션이 숨겨지는지 확인(재시작은 사용자 지시 때만).

## 10. 단계별 구현 순서(각각 독립 검증)

1. **요약·규칙·상태 타입**: `types.ts`·`digest.ts`·`rules.ts` + 단위 테스트. TurnRunner 에 수집기·`onTurnDigest` 훅만 추가(아무도 구독 안 함 → 동작 변화 0). 검증: 기존 테스트 전부 통과 + 새 단위 테스트.
2. **판정기**: `Judge.ts`·`judgeArgs` + fakeClaudeCli 테스트 + 정책 고정 테스트. 환경변수 `DECK_COMMANDER=1` 뒤에 숨김. 검증: 수동으로 digest 샘플 1건 판정.
3. **상태 머신 + 자동 전송**: `Commander.ts`, `submitServerSend` 일반화, `commanderHop`·`:cmd<n>`·systemNote, 상한·같은 실패·paused, SessionState 저장, 프로토콜 메시지. 검증: `ws.commander.test`·`Commander.test`.
4. **UI**: 시트·칩·composer 명령·폰 배지·설정 2개. 검증: UI 테스트 + 라이트/다크·폰 스냅샷.
5. **알림·기록·재시작**: PushKind/HighlightKind 추가, 완료 푸시 억제, `rearm`, 감사 기록, 실행 중 Bash 차단(3층). 검증: rearm 테스트·PushNotifier 테스트.
6. **요금제 게이팅·문서**: Pro 체크(`commander_pro`), `docs/protocol.md`·HANDOFF 갱신, 공개본 반영. 환경변수 제거.

## 11. 리스크

| 리스크 | 완화 |
|---|---|
| 판정기가 "계속" 을 남발해 범위를 넓힌다 | 지시 300자·"새 범위 추가 금지"·상한 20·토큰 상한·칩에 다음 지시 노출. |
| 차단 목록 오탐(일반 문장의 "삭제")으로 자주 멈춘다 | 사람 필요는 안전한 방향의 실패. 오탐 사례를 테스트에 쌓아 패턴을 좁힌다. |
| 자동 턴과 기존 자동 경로(cap·failover·retry)가 겹쳐 턴이 두 번 간다 | 사령탑은 최종 `turn_result` 1회만 보고, `pendingRetry` 중엔 running 으로 본다. `busy` 세션엔 `startTurn` 이 후속으로 합친다. |
| 사용자가 끼어들었는데 사령탑이 덮어쓴다 | `onUserSend` 즉시 paused, 사용자 턴은 판정 안 함, 재개는 명시적 탭. |
| 판정기 세션 기록이 쌓인다(턴마다 `claude -p` 1회) | cwd 를 `configDir/commander/` 로 고정, 사이드바 숨김 규칙 적용, 기록 보존은 CLI 기본 정리에 맡김. |
| 재시작 중 턴이 끊겨 상태가 애매하다 | `lastDigest` 우선 재판정, 없으면 "이어서" 1회만, 상한 누적 유지. |

## 12. 열린 질문

1. 사용자 메시지 뒤 **재개를 수동(탭)으로 둘지, 사용자 턴이 끝나면 자동 재개**할지 — 지금 기본은 수동(덮어쓰기 위험 우선). 자동이면 "사용자 턴 결과도 판정" 규칙이 추가로 필요.
2. 판정기 계정을 **라우터가 고르는 가장 여유 있는 계정**(기본)으로 둘지, 설정으로 **전용 계정 지정**(예: 작업에 안 쓰는 계정)을 열어 둘지.
3. 1차 범위를 **Claude 작업 세션으로 한정**(기본)할지, Codex·Gemini 세션도 처음부터 지휘 대상에 넣을지 — 판정기는 어느 쪽이든 Claude 라 기술적 장벽은 digest 수집기 쪽만이다.
