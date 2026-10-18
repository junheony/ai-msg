# Gemini(agy)·Grok 외부 대화 가져오기 설계 (2026-10-18, 개정 1판 — 적대 검토 반영)

deck 밖(터미널의 `grok`, `agy`)에서 한 대화를 사이드바에 올리고, 메시지를 보내면 deck 에서 이어가는 기능. GPT(Codex) 가져오기(`src/server/sessions/CodexImports.ts`, `SessionIndex.ts`, `ws.ts` 의 `open_session` 분기, `TurnRunner.ts:1384-1402` 의 합성 state)가 이미 있으므로 **그 모양을 그대로 따른다**: 읽기 전용 인덱스 → `SessionEntry{imported: true}` → 첫 `send` 가 TurnRunner 에서 합성 state 로 이어가기(resume) → 그 뒤는 deck 소유 세션.

개정 1판에서 바뀐 결정: 이어가기 분기 위치(TurnRunner), Gemini DB 는 `immutable` 대신 **임시 폴더 복사 후 일반 열기**, Grok 동시 쓰기는 **ps 스캔(heldBy)** 으로 막기, 임시 cwd 는 "임시이면서 폴더가 없는 것"만 숨김, Grok 본문 읽기 전용 보기를 1차로.

## 0. 목표 / 비목표

목표
- `~/.grok/sessions/**` 와 `~/.gemini/antigravity-cli/conversation_summaries.db` 에 있는 사용자의 대화를 사이드바에 Codex 가져오기와 같은 자리·같은 꼬리표로 보인다(제목·폴더·시각·엔진).
- 셋째 출처 **Grok Bot 앱**(§2.4)의 봇 목록과 대화는 **읽기 전용**으로 보이고, 주간 사용량은 Grok 카드에 보조 줄로 보인다(맥 전용, 경로 없으면 조용히 비활성).
- 그 항목을 열고 메시지를 보내면 deck 의 Grok/Gemini 엔진이 **같은 세션 id 로 이어간다**.
- 외부 저장소는 **읽기만** 한다. deck 의 가져오기 코드는 `~/.grok/**`·`~/.gemini/**` 에 파일을 만들지도 고치지도 않는다(`-shm`·lock 파일 포함). `~/.grok/auth.json`, agy 자격증명, 키체인은 열지 않는다.
- 의존성 추가 없음. 상용(공개 export) 빌드에도 들어간다.

비목표
- Gemini 대화 **본문** 복원(`steps.step_payload` 는 스키마 없는 protobuf). 1차는 제목·미리보기(`preview` 컬럼)까지만.
- Grok `session_search.sqlite`(FTS) 활용 — `summary.json` 만으로 충분하다.
- Gemini 2번 좌석(g2, `HOME=~/.agy-g2`) 이어가기 — 엔진이 좌석별 HOME 을 아직 안 준다(§6 열린 질문).
- 외부에서 **진행 중**인 대화의 실시간 반영. Codex 와 같이 "방금 밖에서 바뀜" 안내만 한다.
- Grok Bot 에서 **보내기**(클라우드 API·앱 토큰 재사용 금지). 대신 앱 안내와 "deck Grok 새 세션으로 이어가기"(발췌 프리필).

## 1. 저장 형식과 전제 (검증 완료, 2026-10-18)

### 1.1 Grok — deck 세션과 CLI 세션은 같은 곳에 산다
브리프의 전제("deck 의 Grok 세션은 shadow HOME 에 산다")는 **코드와 다르다.**
- `src/server/config.ts:221` — `grokHome: realOr(path.join(home, '.grok'))`. `main.ts:125` 가 그대로 엔진에 준다.
- `grokEnv.ts` — 그림자 폴더는 `HOME` 에만 들어가고(`~/.claude` 설정을 숨기는 용도, Grok 설계 §14.9-1 "`GROK_HOME` 은 지금처럼 좌석 값(기본 `~/.grok` 실경로)이라 로그인은 유지된다"), `GROK_HOME` 은 실제 `~/.grok` 이다.
- `GrokEngine.ts:395` `sessionUpdatesFile(grokHome, id)` 가 `GROK_HOME/sessions/*/<id>/updates.jsonl` 을 이미 읽는다(외부 변경 감지).

따라서 **CLI 가 만든 세션과 deck 이 만든 세션은 한 디렉터리(`~/.grok/sessions`)에 섞여 있고**, deck 이 자기 세션을 이어가는 `session/load` 와 외부 세션을 이어가는 `session/load` 는 같은 코드·같은 HOME 이다. "복사 vs 실제 HOME load vs 읽기 전용" 선택은 §4.1 에서 이 사실로 결정한다.

레이아웃: `~/.grok/sessions/<url-encoded cwd>/<session id>/` 아래
- `summary.json` — `info.id`, `info.cwd`, `created_at`, `updated_at`, `num_chat_messages`, `current_model_id`, `reasoning_effort`, `grok_home`, `generated_title`(28/37), `session_summary`, `agent_name`, `session_kind`(`subagent`·`headless` 일 때만 있음), `last_active_at`.
- `chat_history.jsonl` — 한 줄 한 메시지 `{type: system|user|assistant|tool, content: string | [{type:'text', text}], tool_calls?}`. 첫 user 줄들은 주입 컨텍스트(`<user_info>`, `<system-reminder>`), 실제 요청은 `<user_query>…</user_query>` 안.
- `events.jsonl`, `updates.jsonl`(ACP `session/update` 그대로), `subagents/`, `*.lock`(0 byte).
- 디렉터리 루트의 `session_search.sqlite` 는 쓰지 않는다.
- 현재 실제 HOME 의 37개는 전부 스파이크 잔재(cwd 가 `/private/var/folders/…/T/…`, 1개 `subagent`, 1개 `headless`) → §5 필터의 실측 근거.

### 1.2 Gemini(agy) — SQLite(WAL) 두 층
- `~/.gemini/antigravity-cli/conversation_summaries.db`, 테이블 `conversation_summaries`: `conversation_id`(PK), `title`, `preview`, `step_count`, `last_modified_time`(`YYYY-MM-DD HH:MM:SS.ffffff+00:00`), `workspace_uris`(JSON 배열 문자열, `["file:///…"]`), `status`(`''` 또는 `CASCADE_RUN_STATUS_*`), `parent_conversation_id`, `nesting_depth`, `killed`, `not_fully_idle`, `last_user_input_time`, `agent_name`, `source`.
- `conversations/<uuid>.db`, 테이블 `steps(idx, step_type, status, step_payload blob …)` — payload 는 protobuf. 1차 비사용.
- 저널은 `journal_mode=delete` 인데도 `-wal` 파일이 남아 있다(실측 2프레임). `file:…?mode=ro&immutable=1` 로는 열리지만 **immutable 은 WAL 을 전부 무시**하므로 최신 행을 놓친다 — 탈락. 원본을 일반 모드로 직접 열면 SQLite 가 `~/.gemini` 에 `-shm`/락을 만들 수 있다 — 쓰기 금지 제약 위반, 탈락.
- **채택: 복사 후 열기.** `conversation_summaries.db` 와 `-wal`(있으면 `-shm` 도)을 deck 의 임시 폴더(`<configDir>/tmp/gemini-import/<랜덤>/`)로 복사하고, 복사본을 `new DatabaseSync(copyPath, { readOnly: true })` 로 **일반 모드**로 연다. `~/.gemini` 에는 0 바이트도 쓰지 않는다. 복사는 원본·`-wal` 의 `mtimeMs:size` 스탬프가 바뀐 때만. 복사 도중 찢어진 파일(열기·쿼리 실패, `SQLITE_CORRUPT`/`NOTADB`)이면 그 회차는 이전 결과를 유지하고 다음 refresh 에 재시도. 열고 쿼리한 뒤 즉시 close·폴더 삭제. URI 열기를 쓰지 않으므로 `pathToFileURL`+searchParams 문제는 없다.
- 7개 대화는 전부 스파이크(`~/.agyspike.*`, hello.txt). `workspace_uris` 가 `["file://<home>"]` 인 것도 있다.

### 1.3 SQLite 의존성 판단
- `package.json` 의존성에 SQLite 계열 없음. `engines.node >= 24`. `node:sqlite` 는 Node 22.13+/24 에서 플래그 없이 쓸 수 있다(24 에서는 ExperimentalWarning 이 한 번 찍힐 수 있음). **의존성 추가 없이 `node:sqlite` 로 간다.** `await import('node:sqlite')` 를 try/catch 로 감싸 모듈이 없으면 Gemini 가져오기만 꺼지고 로그 한 줄.
- Grok 은 SQLite 를 전혀 쓰지 않는다(`summary.json`·`chat_history.jsonl` 만).

## 2. 서버 모듈

기존 `CodexRolloutIndex` 와 같은 인터페이스로 둘을 더하고, `SessionIndex` 가 셋을 같은 방식으로 다룬다.

```ts
// src/server/sessions/ImportIndex.ts (새 파일, 타입만)
export interface ImportIndex {
  refresh(): Promise<void>;             // 겹치면 한 번만, 뒤에 최대 한 번 더 (CodexRolloutIndex.refresh 와 동일)
  list(): SessionEntry[];               // imported: true 항목
  lookup(id: string): SessionEntry | null;
  /** 방금 밖에서 쓰였으면 경과 ms, 아니면 null (Codex 의 rolloutActiveAgeMs 역할) */
  activeAgeMs(id: string, nowMs?: number): Promise<number | null>;
}
```

### 2.1 `src/server/sessions/GrokImports.ts`
- `readGrokSummary(dir): Promise<GrokHead | null>` — `summary.json` 파싱. id 가 `GROK_SESSION_ID_RE`(GrokEngine 에서 export 중) 를 통과하고, `info.cwd` 가 절대경로이고, `realpath(dir)` 가 `realpath(GROK_HOME/sessions)` 아래일 때만(Grok 설계 §14.4 와 같은 규칙). `grok_home` 의 realpath 가 좌석의 `GROK_HOME` 과 다르면 null(다른 HOME 의 세션).
- `isTempCwd(cwd)` — `CodexImports.isDeckTestCwd` 를 일반화: macOS `/private/var/folders/*/*/T/**`, `/tmp`, `os.tmpdir()` 아래면 true. `isDeckTestCwd` 는 이 함수를 쓰도록 바꾸되 동작 유지(Codex 는 e2e 폴더만 걸러야 하므로 둘을 분리해 둔다).
- `class GrokSessionIndex implements ImportIndex` — 생성자 `(grokHome: string, readSummary = readGrokSummary, readFirstPrompt = readGrokFirstPrompt)`. 스캔: `sessions/*/*/summary.json` 을 stat 하고 `mtimeMs:size` 스탬프가 바뀐 것만 다시 읽는다(수백 개 수준, 작은 파일). `SessionEntry` 로 변환: `{ sessionId, account: 'x1', engine: 'grok', cwd, projectDir: dir, file: <chat_history.jsonl>, title, lastModified: Date.parse(updated_at), sizeBytes, imported: true, autoRun?: true, cwdMissing?: true }`. 제목 우선순위(1차 전부): `generated_title` → `session_summary` → `chat_history.jsonl` 첫 사용자 메시지의 `<user_query>` 첫 줄(80자, `grokHistory.readGrokFirstPrompt`, Codex `readRolloutHead` 처럼 머리 2 MiB 만) → `(제목 없음)`.
- `activeAgeMs(id)` — `updates.jsonl` mtime 이 `LIVE_ROLLOUT_MS`(2분, CodexImports 에서 export) 안이면 경과. **보조 신호**다 — 보유 판정은 §4.1 의 ps 스캔.
- `grokImportBlockReason(e, holders)` — `holders.heldBy(id)` 가 있으면 `GROK_HELD_NOTICE`(`터미널에서 grok 이 이 대화를 열고 있어 이어서 보낼 수 없음 — 그쪽 grok 을 끝낸 뒤 다시 보내세요`), 아니면 `cwdMissing` 이면 `CWD_MISSING_NOTICE` 재사용. (보관 개념 없음.)

### 2.1a `src/server/engine/grokHistory.ts` (1차)
- `readGrokTranscriptTail(file, maxBytes = 16 MiB, opts): Promise<TranscriptMessage[]>` — `codexRollout.readCodexTranscriptTail` 과 같은 모양. user 줄은 `<user_query>…</user_query>` 안만 남기고 주입 컨텍스트(`<user_info>`, `<system-reminder>`) 줄은 버린다; assistant 는 `content` + `tool_calls` → `toolCalls`; `tool` 줄은 직전 toolCall 의 결과(`maxToolResultChars` 자름); `system` 줄은 버린다. `model` 은 `summary.json` 의 `current_model_id`.
- `readGrokFirstPrompt(file, maxBytes = 2 MiB): Promise<string | null>` — 제목 폴백용.
- 가져온 세션뿐 아니라 **deck 소유 Grok 세션의 `open_session` 도** 이 리더로 기록을 채운다(지금은 `messages: []`). 파일 위치는 `GrokEngine.sessionUpdatesFile` 과 같은 규칙(`GROK_HOME/sessions/*/<id>/`, realpath 봉인)으로 찾는다 → `findGrokSessionDir(grokHome, id)` 로 뽑아 둘이 공유.

### 2.2 `src/server/sessions/GeminiImports.ts`
- `snapshotSqlite(src, tmpRoot): Promise<{ dir, db } | null>` — `src`, `src-wal`, `src-shm` 중 있는 것을 `tmpRoot/<randomUUID>/` 에 `fs.copyFile` 로 복사(원본은 `O_RDONLY` 로만 열림). 복사 전후 원본 스탬프가 다르면(복사 중 바뀜) null. 호출자가 `dir` 을 지운다.
- `readSummaries(copyPath)` — `node:sqlite` 동적 import, `new DatabaseSync(copyPath, { readOnly: true })`(일반 모드 → WAL 프레임 반영). 모듈이 없거나 열기·쿼리 실패면 `null`. 쿼리 하나: `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle FROM conversation_summaries`. 읽은 뒤 바로 `close()`.
- `geminiRowToEntry(row, account): SessionEntry | null` — §5 필터 적용. cwd 는 `workspace_uris` 첫 `file://` URI 의 `fileURLToPath`. `lastModified = Date.parse(last_modified_time 을 ISO 로 정규화)`. 제목 `title || preview 첫 줄 || (제목 없음)`. `account: 'g1'`, `engine: 'gemini'`, `file: <summaries db>`, `projectDir: <antigravity-cli dir>`.
- `class GeminiConversationIndex implements ImportIndex` — 생성자 `(roots: { account: GeminiAccount; dir: string }[], tmpRoot: string)`. 1차는 `[{ account: 'g1', dir: ~/.gemini/antigravity-cli }]` 만. 스캔: `conversation_summaries.db` 와 `-wal` 의 `mtimeMs:size` 두 스탬프가 모두 같으면 복사·쿼리 생략. 스냅숏이 null 이거나 읽기 실패면 마지막 성공 목록 유지(로그 1줄, 다음 refresh 재시도).
- `activeAgeMs(id)` — 행의 `not_fully_idle` 이 참이거나 `status` 가 `*_RUNNING` 이면 0, 아니면 `last_modified_time` 이 2분 안이면 경과. (별도 파일 stat 없음.)

### 2.3 손대는 기존 파일
- `SessionIndex.ts` — `codex: CodexRolloutIndex | null` 을 `imports: ImportIndex[]` 로 일반화. `codexImport()/freshCodexImport()` 는 `importOf(id)/freshImport(id)` 의 얇은 별칭으로 남긴다(호출부 점진 교체). 일반화 대상: `projects()`(:441 — "deck 이 이미 소유한 id 는 가져오기 목록에서 제외"를 Grok/Gemini 저장소 항목까지), `codexOwned()`(:424 — `importsOwned()` 로, Grok 은 `generated_title`·`updated_at` 덧씌움, Gemini 는 `title`·`last_modified_time`), `decorate()`(:254 — `heldBy` 를 Claude 전용에서 Grok 까지, §4.1). `refresh({ codexInBackground })` → `importsInBackground` 로 이름만 일반화(기존 인자 호환 유지).
- `TurnRunner.ts:1384-1402` — **이어가기 분기의 실제 위치.** 지금은 `!state` 면 `freshCodexImport` 로 Codex 합성 state 를 만들고, 그 외 `gpt`/Gemini/Grok 좌석 항목은 :1400 에서 `세션을 찾을 수 없습니다` 로 거절한다. `runGemini`(:1584)·`runGrok`(:1651) 은 `resumeSessionId: state?.sessionId ?? null` 이라 state 없이는 **새 세션**이 된다. 변경: `freshImport(id)` 로 받은 항목의 `engine` 에 따라 합성 state 를 만든다(§3.1). route_fit(:1408) 은 합성 state 가 `isGeminiState/isGrokState` 를 만족하므로 그대로 탄다.
- `ProcessHolders.ts` — §4.1 의 `grok` 프로세스 스캔.
- `elsewhereNotice.ts` — `engine: 'claude' | 'codex' | 'grok' | 'gemini'`, `what`/`where` 문구 추가(`Grok 대화` / `grok CLI`, `Gemini 대화` / `agy CLI 또는 Antigravity`).
- `config.ts` — `geminiStateDir: path.join(home, '.gemini', 'antigravity-cli')`, `importTmpDir: path.join(configDir, 'tmp', 'gemini-import')` 추가. `grokHome` 은 이미 있다. 테스트는 생성자에 임시 경로를 직접 넣으므로 env 오버라이드는 두지 않는다.
- `main.ts` — `SessionIndex` 에 `grokImports: cfg.grokBin ? new GrokSessionIndex(cfg.grokHome) : null`, `geminiImports: cfg.geminiBin ? new GeminiConversationIndex([...], cfg.importTmpDir) : null`, `grokBotImports: new GrokBotIndex(cfg.grokBotDir)` 을 넘긴다. 바이너리가 없으면 목록도 없다(이어갈 수 없는 항목을 보이지 않기 위해); Grok Bot 은 바이너리와 무관(읽기 전용)하고 폴더 없으면 빈 목록. 시작 시 `importTmpDir` 잔재 삭제.
- `config.ts` 추가 — `grokBotDir: process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence') : null`.
- `ws.ts` — `open_session`·`duplicate_session`·`delete_session`·`handoff` 거절(§3). `send` 분기는 **바꾸지 않는다**(TurnRunner 가 맡음).

### 2.4 세 번째 출처: Grok Bot 앱 (읽기 전용, 1차)

#### 사실
- `/Applications/Grok Bot.app`(Electron, bundle id `com.anysphere.sand`, 0.71.2). 에이전트는 클라우드 박스(`/home/box/sand-data/agents/<id>/store.db`)에서 돌고, 이 맥은 호스트로 붙어 파일·셸을 빌려준다. 로그인은 Google OAuth. **deck 은 Grok Bot 클라우드 API 를 부르지 않고 앱의 토큰도 재사용하지 않는다** → deck 에서 보내기는 비목표.
- 로컬 캐시: `~/Library/Application Support/Grok Bot/sand-client-persistence/<base32(키)>.blob`, 내용은 JSON `{ schemaVersion, value }`. 파일명을 base32 디코드하면 키:
  - `sand.client.slice.account.<계정>.roster.last-roster` — `value.rows[]`: `id, name, description, title, avatarShape, avatarColor, createdAt, updatedAt, lastActivityAt, hasUnread, unreadCount, awaitingUserResponse, isHiddenFromSidebar, isGroup, harness, origin …`
  - `…transcript.replicas.<agentId>` — `value.entries[]`: `kind: 'send-message' | 'message'`, `id`, `message{ type: 'text' | 'widget' | 'ask…', content | widget | ask }`, `timestampMs`, `requestId`, `seq`; 바깥 `persistedAt`.
  - `…weekly-usage.cache` — `value.reading.usage{ percentUsed, nextResetMs, grokPlanLabel('Grok Bot Plan'), onDemand }`, `readAtMs`.
  - 앱이 동기화할 때 갱신(mtime).
- **열지 않는 것**: `sand-secrets.json`, `box-secrets-push-state.v1.json`, `Cookies`, `Local Storage`. 모듈은 `sand-client-persistence/` 한 폴더만 `readdir` 하고 `.blob` 만 연다.

#### 모듈 `src/server/sessions/GrokBotImports.ts`
- `decodeBlobKey(fileName): string | null` — base32(RFC 4648, 패딩 유무 허용) 디코드, UTF-8 이 아니면 null.
- `readBlob(file): Promise<{ schemaVersion: number; value: unknown } | null>` — JSON 파싱; `schemaVersion` 이 **알고 있는 값**(상수 `KNOWN_SCHEMA = { roster: [..], transcript: [..], usage: [..] }`, 실측값으로 채움)이 아니면 null + 로그 1줄(키별 한 번).
- `class GrokBotIndex implements ImportIndex` — 생성자 `(dir: string | null)`. `dir` 이 null 이거나 없으면 **조용히 빈 목록**(Linux·앱 미설치: 오류·로그 없음). 스캔: 폴더 `readdir` → 키 디코드 → roster 파일들만 스탬프 비교 후 읽기. 행 → `SessionEntry{ sessionId: 'grokbot:' + id, account: 'x1', engine: 'grokbot', cwd: <home>, projectDir: dir, file: <transcript blob 경로 또는 roster 경로>, title: name || title || '(제목 없음)', lastModified: lastActivityAt ?? updatedAt, imported: true, readOnly: true, grokBot: { description, awaitingUserResponse, unreadCount, isGroup, account } }`. 제외: `isHiddenFromSidebar`. `cwd` 는 폴더 개념이 없어 home 으로 두고 사이드바 그룹은 "Grok Bot" 가상 프로젝트(§11).
- `readGrokBotTranscript(file): Promise<TranscriptMessage[]>` — `entries` 를 `seq` 순으로: `send-message` → user, `message` → assistant. `message.type === 'text'` 는 `content` 본문; `widget`/`ask…` 는 한 줄 요약 `[선택지: A · B · C]` / `[위젯: <type>]`(선택지 레이블은 `ask.options[].label` 류를 최대 5개, 없으면 타입만). `timestampMs` → `ts`.
- `readGrokBotWeeklyUsage(dir): Promise<{ percentUsed, nextResetMs, planLabel, readAtMs } | null>` — 사용량 카드용.

#### 이어가기 — 없음, 두 가지 안내
- 열면 `turn_notice`: `Grok Bot 대화는 읽기만 할 수 있어요 — 이어가려면 Grok Bot 앱에서 열어 주세요`. 작성기 `readOnly`.
- 보조: 작성기 자리에 `[deck Grok 새 세션으로 이어가기]` 버튼. GPT 잠김 인계(`src/shared/handoff.ts` `codexHandoffExcerpt`/`codexHandoffMessage`)와 같은 방식 — 기록에서 `CODEX_HANDOFF_EXCERPT_MAX` 안의 발췌를 만들어 새 Grok 세션(x1, 사용자가 폴더 선택) 첫 메시지에 프리필한다. `grokBotHandoffMessage(name, excerpt, request)` 는 `codexHandoffMessage` 와 문구만 다르다. 서버 변경 없음(기존 `send` 로 새 세션).

#### 프로토콜·UI
- `EngineKind` 에 `'grokbot'` 추가(표시 전용 — `send.engine` 으로는 거절: `Grok Bot 대화는 deck 에서 보낼 수 없어요`). `SessionEntry.grokBot?: { description?: string; awaitingUserResponse: boolean; unreadCount: number; isGroup: boolean }`, `readOnly?: true`(선택 필드).
- `open_session` → `history{ engine: 'grokbot', account: 'x1', cwd, messages: readGrokBotTranscript(...) }` + 위 `turn_notice`. `duplicate_session`·`delete_session`·`handoff` 는 거절(문구 엔진별).
- 사이드바: "Grok Bot" 가상 프로젝트 아래 봇 이름, 엔진 배지 `Grok Bot`, `awaitingUserResponse` → `답장 대기` 꼬리표(강조), `unreadCount > 0` → `안 읽음 n`, `isGroup` → `그룹`. 툴팁 `Grok Bot 앱의 대화 — 읽기만, 이어가기는 앱에서`.
- 사용량: `UsageSnapshot.grokSeats.x1` 에 `grokBot?: { percentUsed, nextResetMs, planLabel, readAtMs }` 선택 필드. Grok 카드 팝오버 보조 줄 `Grok Bot 플랜 n% · 리셋 <상대시각>`; 캐시가 24시간 넘게 오래됐으면 `(앱 동기화 <n>시간 전)` 덧붙임. 없으면 줄 없음.

#### 폴링·실패
- `SessionIndex.refresh()` 때 roster 블롭 stat(파일 2~3개). transcript 는 열 때만 읽는다(캐시 없음, 크기 작음).
- 블롭이 JSON 이 아님/스키마 모름/파일 반쯤 쓰임 → 그 키만 건너뜀, 이전 결과 유지. 폴더 권한 오류(macOS TCC 프롬프트 가능성) → 비활성 + 로그 1줄; 다시 묻지 않음.
- 테스트: 임시 폴더에 base32 파일명으로 roster/transcript/usage 블롭 픽스처(계정·id 는 가짜), `isHiddenFromSidebar`·모르는 `schemaVersion`·깨진 JSON·금지 파일명(`sand-secrets.json`)이 있어도 **열리지 않음**(fs 스파이로 확인)·폴더 없음(빈 목록, 로그 없음)·위젯/ask 요약·handoff 발췌 길이.

## 3. 프로토콜 변화 (`docs/protocol.md` 규칙 1: 선택 필드만 추가)

- `SessionEntry.autoRun?: true` — 비대화형 실행(Grok `session_kind: 'headless'`). Codex 의 `codexExec` 는 그대로 두고 UI 는 `s.codexExec || s.autoRun` 을 `자동 실행` 꼬리표로 본다. (엔진은 기존 `engine`·`account` 로 구분 — 새 필드 없음.)
- `SessionEntry.grokModel?: string`, `grokEffort?: Effort` — 가져온 Grok 항목의 마지막 모델·effort(TurnRunner 합성 state 의 기본값). UI 는 쓰지 않아도 된다.
- `SessionEntry.heldBy?: SessionHolder` — 기존 필드를 Grok 항목에도 채운다(§4.1).
- `open_session` — 가져온 Grok: `history{ engine: 'grok', account: 'x1', cwd, permissionMode, sessionModel: current_model_id 가 isGrokModel 이면 그것, sessionEffort: reasoning_effort, messages: readGrokTranscriptTail(...) }`(1차부터 본문 포함; deck 소유 Grok 세션도 같은 리더로 채움). 가져온 Gemini: `history{ engine: 'gemini', account: 'g1', cwd, sandbox: null, messages: [] }`. 둘 다 Codex 와 같이 `turn_notice` 를 앞서 보낸다: 보유 중이면 `GROK_HELD_NOTICE`, 밖에서 2분 안에 쓰였으면 `elsewhereNotice`, 폴더 없으면 `CWD_MISSING_NOTICE`. `SessionEntry.heldBy` 는 Grok 가져오기/소유 항목에도 실린다(기존 필드).
- `send` 에 가져온 id — ws.ts 는 그대로 통과시키고 **TurnRunner 가 합성 state 를 만든다**(§3.1). `handoff`(이어서 새 세션) 거절 조건(`ws.ts:723`)에 `index.importOf(id)` 포함.

### 3.1 TurnRunner 합성 state (Codex 분기 :1389-1394 와 대칭)
`const imported = state ? null : await deps.index.freshImport(p.sessionId)` 뒤, `imported.engine` 으로 분기. 공통 선행 검사: `importBlockReason(imported, deps.holders)` 가 문구를 주면 `error` 로 끝(폴더 없음, Grok 보유 중). 통과하면:
```ts
// grok
state = {
  engine: 'grok', sessionId: imported.sessionId, grokSessionId: imported.sessionId, account: 'x1',
  cwd: imported.cwd, canonicalCwd: await fs.realpath(imported.cwd),
  model: isGrokModel(p.model) ? p.model : (isGrokModel(imported.grokModel) ? imported.grokModel : DEFAULT_GROK_MODEL),
  effort: p.effort ?? imported.grokEffort ?? DEFAULT_EFFORT.grok,
  permissionMode: this.permissionModeOf(imported.sessionId) /* 없으면 서버 기본 */,
  lastTurnAtMs: null, justCompacted: false, createdAtMs: this.now(), title: imported.title,
};
// gemini
state = {
  engine: 'gemini', sessionId: imported.sessionId, account: 'g1', cwd: imported.cwd,
  defaultModel: isGeminiModel(p.model) ? p.model : DEFAULT_GEMINI_MODEL, sandbox: p.sandbox ?? DEFAULT_SANDBOX,
  lastTurnAtMs: null, justCompacted: false, createdAtMs: this.now(), title: imported.title,
};
```
`imported.grokModel`·`grokEffort` 는 `GrokSessionIndex` 가 `summary.json` 의 `current_model_id`·`reasoning_effort` 를 `SessionEntry` 의 선택 필드로 실은 것(§3 필드 목록). `notice` 는 `activeAgeMs` 가 있으면 `elsewhereNotice`. 이어서 :1405(총사령탑 거절)·:1408(route_fit — `turnFits(engine, classifyTask(...), { cwdInsideHome })`, 실패 시 `route_fit{sessionId: imported.sessionId}` 로 턴 시작 전 종료)·`runGrok`/`runGemini` 가 `resumeSessionId: state.sessionId` 로 `session/load` / `--conversation` 을 탄다. 턴이 끝나면 기존 경로가 저장소에 state 를 쓴다(Codex 와 동일) → 다음 턴부터 소유 세션. :1400 의 `isGeminiAccount/isGrokAccount` 거절은 가져오기 항목이 아닌(인덱스에도 없는) id 에만 남는다.
- `duplicate_session` — 가져온 항목도 `cwd`·`engine`·모델로 `session_duplicate` 를 만든다(Codex 분기와 대칭).
- `delete_session` — 가져온 항목은 거절(기존과 같음). 문구를 엔진별로: `Grok CLI 기록은 deck에서 지울 수 없어요` 등.
- 새 메시지 타입 없음. `hello` 기능표에 행 하나(`imports: ['codex','grok','gemini']` 같은 배열은 두지 않고, 가져오기는 서버가 켜져 있으면 목록에 그냥 나타나는 것으로 정의).

## 4. 이어가기 전략

### 4.1 Grok — 실제 `GROK_HOME` 으로 `session/load` (선택)
세 안 비교:
| 안 | 판정 | 근거 |
|---|---|---|
| (a) 세션 디렉터리를 그림자 HOME 으로 복제 | 탈락 | 그림자 폴더는 `HOME` 용이고 턴마다 새로 만들어 지운다(`shadowHome.ts`). 세션 저장소는 `GROK_HOME` 이며 그림자가 아니다. 복제하면 같은 id 가 두 저장소에 생겨 `(GROK_HOME 실경로, sessionId)` 잠금 키(Grok 설계 §2)·외부 변경 감지가 깨진다. |
| (b) 실제 `GROK_HOME` 에서 `session/load` | **채택** | deck 이 **자기 Grok 세션을 이어가는 방식 그대로**다(`GrokEngine.ts:663`, `noReplay: true`). 새 코드 경로가 없고, id 정규식·realpath 봉인·엔진 잠금·inspect fail-closed 가 그대로 적용된다. deck 의 가져오기 코드는 여전히 읽기만 하고, 세션 파일에 쓰는 주체는 사용자가 띄운 `grok` 자식 프로세스다 — 오늘 deck 의 모든 Grok 턴과 같다. |
| (c) 읽기 전용 보기 + 요약 프리필로 새 세션 | 보류(폴백) | 맥락이 끊기고 사용자가 "이어가기"로 기대한 것과 다르다. `session/load` 가 실패하는 세션(`headless` 가 load 를 거부하면)에만 안내 문구로 권한다. |

(b) 의 동시 쓰기 방지 — **ps 스캔으로 보유 판정(heldBy), 보유 중이면 거절.** 세션 폴더의 `*.lock` 은 파일별 0 byte 라 프로세스 보유 신호가 아니다(닫힘). 대신 `ProcessHolders.ts` 의 `claude` 스캔(`ps -axww -o pid=,ppid=,command=`)을 확장한다:
- `isGrokCommand(command)` — 실행 파일 basename 이 `grok`(인터프리터 뒤, `node …/grok` 포함). deck 자식은 제외: `ppid` 가 deck 의 pid 이거나 조상 사슬에 deck 이 있는 행, 그리고 deck 이 띄운 턴의 pid 집합(`GrokEngine` 이 `holders.ownPid(pid)` 로 등록).
- 매칭: 인자에 세션 id(`--resume <id>`/`-r <id>` 등 어떤 위치든 `GROK_SESSION_ID_RE` 통과 토큰이 가져오기 id 와 같음) → 그 세션 `heldBy: 'other'`. id 가 없는 대화형 `grok` 은 **같은 cwd**(`lsof` 는 쓰지 않고 `ps -o cwd` 가 없으므로 macOS 는 `lsof -p` 대신 `/proc` 도 없음 → `ps -axww -o pid=,ppid=,command=` 에 더해 `lsof -a -d cwd -p <pids> -Fn` 한 번) 인 모든 Grok 가져오기/소유 세션에 `heldBy: 'other'` 를 건다(보수적: 그 폴더의 어느 세션을 열었는지 모르므로 전부).
- 결과: `SessionIndex.decorate` 가 Grok 항목에 `heldBy` 를 싣고, 사이드바는 Claude 의 `heldBy` 표시를 재사용. `open_session` 은 `GROK_HELD_NOTICE` 를 보내고 Pane 작성기를 `readOnly` 로; TurnRunner 는 `importBlockReason` 에서 같은 문구로 `error`. 스캔 실패는 이전 답 유지(기존 ProcessHolders 규칙).
- `activeAgeMs`(2분 mtime) 는 **보조 신호**: ps 에 안 잡히는데 방금 쓰였으면(원격 셸, 스캔 지연) `elsewhereNotice` 로 안내만 하고 막지 않는다(Codex 와 동일).

### 4.2 Gemini — `--conversation <id>`
`GeminiEngine.geminiArgs` 가 이미 `--conversation` 을 붙인다(스파이크 "이어하기 실측 확인"). 과거 메시지는 재생되지 않으므로 deck 소유 Gemini 세션처럼 `messages: []` 로 열리고, 사이드바 제목·미리보기(`preview`)로 어떤 대화인지 알린다. 좌석은 g1 고정(`geminiEnv` 가 HOME 을 그대로 두므로 g1 의 저장소만 이어갈 수 있다).

### 4.3 소유권 전환
첫 턴이 성공하면 상태 저장소에 Grok/Gemini 세션 항목이 생기고(오늘과 동일), `SessionIndex.grouped()` 가 같은 id 의 가져오기 항목을 숨긴다. 제목은 deck 저장소 값 우선; Grok 은 `generated_title` 을 `codexOwned` 처럼 덧씌우는 것을 2차에 둔다.

## 5. 필터링

공통: `imported` 항목은 **`cwd` 가 임시 폴더(`isTempCwd`)이면서 그 폴더가 지금 없을 때만** 목록에서 제외한다 — 끝난 스파이크·스크립트 잔재. 임시 폴더라도 아직 있으면 Codex 처럼 보인다. 임시가 아닌데 폴더가 없으면 **보이되 `cwdMissing`(읽기 전용)**. 숨긴 개수는 refresh 당 로그 한 줄(`grok imports: 35 hidden (temp cwd gone)`), 수가 바뀔 때만. 소유 세션(상태 저장소에 있는 id)은 제외.

Grok 제외: `session_kind === 'subagent'`(또는 `agent_name !== 'grok-build-plan'` 인데 kind 가 없음 — 보수적으로 kind 만 본다), `num_chat_messages === 0`, `grok_home` 불일치, id/realpath 검사 실패, `summary.json` 파싱 실패. `session_kind === 'headless'` 는 `autoRun` 으로 표시.

Gemini 제외: `nesting_depth > 0` 또는 `parent_conversation_id !== ''`(서브에이전트), `killed`, `step_count === 0`, `workspace_uris` 가 비었거나 `file://` 가 아님. `status === ''` 는 제외하지 않는다(실측 11개가 빈 값이고 의미가 불명 — 열린 질문).

## 6. 폴링·캐시

`SessionIndex.refresh()` 가 부르는 때(접속·`refresh_index`·턴 종료·파일 변화)에만 돌고, 자체 타이머는 두지 않는다 — Codex 와 같다. 비용:
- Grok: `readdir` 2단 + `summary.json` stat N개, 바뀐 것만 읽기. 37개 기준 수 ms.
- Gemini: stat 2개(db, `-wal`)로 끝나는 것이 대부분; 바뀌면 복사(수 MB 이하)·쿼리 1회·행 수 수십·임시 폴더 삭제.
- Grok 보유 스캔: `ProcessHolders` 의 기존 ps 주기(열기/보내기 때 질의, 캐시)에 `grok` 매칭을 얹는다 — 추가 프로세스 호출은 cwd 매칭용 `lsof` 1회(대화형 grok 이 있을 때만).
- 최초 스캔은 Codex 와 같이 백그라운드(`importsInBackground`) 로 돌리고 끝나면 `onChange` → `index` 푸시.

## 7. 2차 범위 (별 PR)
1. Gemini g2: `~/.agy-g2/.gemini/antigravity-cli` 를 둘째 루트로 — 엔진이 좌석별 HOME 을 주는 변경이 선행.
2. Gemini 본문: `conversations/<id>.db` 도 같은 복사 방식으로 열어 `steps.step_payload` 의 문자열 필드를 휴리스틱으로 뽑기. 실익이 작으면 하지 않는다.
3. Grok 세션 폴더의 `subagents/` 를 부모 항목의 하위 도구 호출로 접어 보이기(지금은 제외만).

## 8. 실패 처리
| 상황 | 동작 |
|---|---|
| `~/.grok/sessions`·summaries db 없음 | 목록 없음, 오류 아님 |
| `summary.json` 깨짐/반쯤 쓰임 | 그 세션만 건너뜀, 스탬프 바뀌면 재시도 |
| `node:sqlite` 없음 / 스키마 다름 | Gemini 가져오기만 비활성, 서버 로그 1줄 |
| 복사 중 원본이 바뀜 / 복사본 열기·쿼리 실패(찢어진 파일) | 그 회차는 이전 목록 유지, 다음 refresh 재시도, 임시 폴더 삭제 |
| 임시 폴더 생성 실패(디스크·권한) | 위와 같음(이전 목록 유지) |
| `chat_history.jsonl` 반쯤 쓰인 마지막 줄 | 그 줄만 버림(Codex 꼬리 리더와 같음) |
| 터미널 `grok` 이 세션/같은 cwd 를 보유 | `heldBy` 표시 + 열 때 `GROK_HELD_NOTICE`, 보내기는 `error` 로 거절; 끝나면 다음 스캔에서 풀림 |
| `session/load` 실패(Grok) | 기존 턴 오류 경로(`errorKind` 그대로), 항목은 가져오기 상태로 남음 |
| agy `--conversation` 실패 | 기존 `agy 종료 코드 …` 결과, 동일 |
| cwd 없음 | 열 때 `CWD_MISSING_NOTICE`, 작성기 비활성(Pane 의 `readOnly`) |
| 밖에서 2분 안에 쓰임 | `elsewhereNotice` 로 안내, 막지 않음 |
| Grok 엔진 잠금·프로젝트 `.grok` | 기존 거절 그대로 |

## 9. 테스트 계획 (전부 임시 디렉터리, 실제 `~/.config/deck`·`~/.grok`·`~/.gemini` 불가침)
- `grokFixtures.ts` — `writeGrokFixtures(root, work)`: 정상(제목 있음), `generated_title` 없이 `<user_query>` 만 있는 것(제목 폴백), `headless`, `subagent`, 임시 cwd 두 종(**아직 있는 것**은 보여야 함 / **지워진 것**은 숨겨야 함 — 둘 다 `path.join(os.tmpdir(), 'deck-fixture-…')` 처럼 **런타임 tmpdir 로 생성**, 리터럴 경로 금지), 임시 아닌 cwd 삭제됨(`cwdMissing`), `grok_home` 불일치, 깨진 summary, 반쯤 쓰인 마지막 jsonl 줄. 경로는 모두 `work`·tmpdir 아래 — `.hygiene-private.json` 이 `/Users/<name>` 류를 잡는다.
- `geminiFixtures.ts` — `node:sqlite` 로 임시 `conversation_summaries.db` 생성(WAL 모드로 만들고 **체크포인트 없이** 닫아 `-wal` 에만 있는 행 포함 — 복사 방식이 그 행을 보는지 확인). 행: 정상, 서브에이전트(`nesting_depth: 1`), `killed`, `step_count: 0`, 빈 `workspace_uris`, 임시 cwd(있음/없음), 사라진 cwd.
- `GrokImports.test.ts` / `GeminiImports.test.ts` — 필터·제목·`lastModified`·`autoRun`·`cwdMissing`·`grokModel/grokEffort`; 스탬프 캐시(두 번째 refresh 가 읽지/복사하지 않음, 파일 바뀌면 함); realpath 탈출(세션 폴더가 밖을 가리키는 심링크) 거부; **읽은 뒤 원본 픽스처 디렉터리에 새 파일(`-shm`, `-journal`)이 없고 mtime 이 그대로**; 복사본 임시 폴더가 지워짐; 복사 중 원본 변경(스탬프 불일치 주입) 시 이전 목록 유지; `node:sqlite` 부재 주입 시 빈 목록 + 오류 없음; 숨긴 개수 로그 1줄.
- `grokHistory.test.ts` — `<user_query>` 추출, 주입 컨텍스트 제거, `tool_calls`→toolCalls, tool 결과 자름, 첫 프롬프트 제목.
- `ProcessHolders.test.ts` 추가 — `isGrokCommand`(basename·`node …/grok`·다른 프로그램의 인자 `vim /x/grok` 는 아님), deck 자식 pid 제외, 세션 id 토큰 매칭, cwd 매칭(lsof 출력 주입).
- `SessionIndex.test.ts` 추가 — 세 인덱스 합치기, 소유 세션과 중복 제거, `importsOwned` 제목 덧씌움, `decorate` 의 Grok `heldBy`, 백그라운드 `onChange`.
- `TurnRunner.test.ts` 추가 — 가져온 Grok/Gemini id 로 `send`: 합성 state 의 필드(모델·effort·cwd·canonicalCwd), `resumeSessionId` 가 엔진 stub 에 전달, route_fit 실패 시 턴 미시작, 보유 중/폴더 없음은 `error`, 턴 뒤 저장소에 state 생성.
- `ws.grokImport.test.ts` / `ws.geminiImport.test.ts`(기존 `ws.codexImport.test.ts` 복제) — `open_session` 의 `history` 모양(Grok 은 본문 포함)과 `turn_notice`; `duplicate_session`; `delete_session` 거절; `handoff` 거절.
- UI: `Sidebar.test.tsx` 에 엔진별 툴팁·`자동 실행`·`폴더 없음` 꼬리표, `SessionMenu.test.ts` 삭제 문구.
- e2e 없음(실 CLI 불필요). 하이진 테스트(`hygiene.private.test.ts`)는 그대로 통과해야 한다.

## 10. 단계
1차(이 설계 범위, 한 PR): §2 모듈(`GrokImports`·`GeminiImports`·`GrokBotImports`(§2.4)·`grokHistory`·`ImportIndex`) + `SessionIndex` 일반화(`projects`·`importsOwned`·`decorate`) + `TurnRunner` 합성 state(§3.1) + `ProcessHolders` grok 스캔(§4.1) + §3 프로토콜 필드 + ws `open_session`(Grok 본문 포함, 소유 세션도) + UI 문구 일반화 + §9 테스트 + `docs/protocol.md` 갱신(`autoRun`·`grokModel`·`grokEffort`, Grok `history.messages` 가 비어 있지 않게 된 점, 가져오기 행).
2차: §7.

## 11. UI 변화
- 사이드바: 항목은 기존 `session-meta` 꼬리표 자리에 `자동 실행`·`폴더 없음` 과 툴팁(`Grok CLI 에서 만든 대화 — 메시지를 보내면 deck 에서 이어갑니다` / `agy 에서 만든 대화 — …`). 엔진 배지는 기존 `engine`/`account`(x1·G1) 표시를 그대로 탄다 — 새 배지 없음.
- Pane: `readOnly` 사유 문구를 엔진 무관으로(`폴더가 없어 이어서 보낼 수 없어요`).
- 작성기 하단에 Gemini 가져오기만 "이전 메시지는 보이지 않지만 agy 가 기억합니다" 한 줄(deck 소유 Gemini 세션과 같은 문구가 있으면 재사용).
- Grok 항목이 보유 중(`heldBy`)이면 Claude 와 같은 표시 + 작성기 `readOnly` 사유 `GROK_HELD_NOTICE`.

## 12. 열린 질문
닫힘(개정 1판): 이어가기 분기 위치(TurnRunner), Gemini WAL 읽기(복사), Grok `*.lock`(보유 신호 아님 → ps 스캔), 임시 cwd 처리(없는 것만 숨김), Grok 본문 시점(1차).

남은 것:
- Grok `session_kind: 'headless'` 세션에 `session/load` 가 되는가(스파이크로 확인, 안 되면 §4.1(c) 안내 문구).
- 대화형 `grok` 의 cwd 매칭에 `lsof` 를 써도 되는가(macOS 기본 탑재, 권한 프롬프트 없음 확인 필요). 안 되면 id 매칭만 하고 cwd 는 `elsewhereNotice` 로 격하.
- Gemini `status === ''`(실측 11/18) 의 의미 — 미완/크래시면 제외 후보.
- 임시 아닌 `cwdMissing` 가져오기가 많을 때 보관됨 섹션으로 접을지(사용자 결정, 1차는 Codex 와 같이 그대로 보임).
- `~/.agy-g2` 좌석 지원 시점(§7.1).
- Grok Bot: 실측 `schemaVersion` 값 확정(구현 첫 단계에서 읽어 상수에 박음), `ask…` 타입의 정확한 철자와 선택지 필드명, 계정이 둘 이상일 때 roster 를 합칠지(1차는 전부 합치고 `grokBot.account` 로 구분).
