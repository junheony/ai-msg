# Quarterdeck 유료 구독 제품화 — 설계

작성 2026-10-15. 결정 주체: 사용자(제품 소유자). 작성: 이 세션. 근거 조사: 코드 감사 2건(읽기 전용), 외부 리서치(GPT-6 Astra 1건 — Claude 측 교차검증은 웹 접근 거부로 실패), 핵심 주장 4건 직접 확인(Happy 저장소·happy.engineering, Anthropic legal-and-compliance, The Register 2026-02-20, Conductor pricing, Vibe Kanban shutdown).

## 0. 결정 요약

| 항목 | 결정 | 비고 |
|---|---|---|
| 공개 범위 | **오픈코어** — 로컬 앱 Community(MIT) 공개, Pro 는 라이선스 키로 켜는 별도 모듈 + 유료 클라우드 | 사용자 결정 |
| 결제 | **판매 대행(MoR)** — 1순위 Paddle, 대안 Polar | 사용자 결정(MoR). 업체는 KYC·첫 정산으로 확정 |
| 시장 | **글로벌 영어 우선**, 한국어는 번역 | 사용자 결정 |
| 유료 가치의 중심 | **"자리를 비워도 멈추지 않는 자동화"** (병목 알림·자동 재시도·벤더 간 인계·유휴 할당량 작업·교차 검증·통합 사용량) | 리서치 결과로 "릴레이 중심"에서 수정 — §2 |
| 가격 가설 | Pro **$15/월**, 연 **$150 정가 / $120 창립 고객**, 카드 없이 **7일 체험** | 전환 실험 전 가설 |
| Claude 실행 방식 | **Agent SDK → 사용자가 설치한 공식 `claude` CLI 헤드리스**로 전환 (출시 전 필수) | 정책 — §3 |
| 같은 벤더 계정 자동 순환 | **기본 꺼짐**, 명시 동의 옵션, 문서에 "본인 소유 계정만" | 정책 회색지대 — §3 |
| Claude 사용량 소스 | 비공개 OAuth 사용량 엔드포인트 호출 **제거** → 로컬 transcript 집계 + CLI 공식 출력 | 정책 — §3. **구현됨**(2026-10-17): `DECK_USAGE_SOURCE=cli`(기본, 턴의 `rate_limit_event` 만 · 계정별 관측값 디스크 저장) / `usage-deck`(주소를 직접 설정했거나 usage-deck 이 응답한 기록이 있는 설치) |

## 1. 제품 정의

**한 줄(영어 랜딩용)**: *Quarterdeck — the cockpit for your local coding agents. Claude Code, Codex, Gemini and Grok in one place, from your desk or your phone, and they don't stop when you step away.*

**사용자**: Claude Code·Codex CLI·Gemini(Antigravity) CLI·Grok Build CLI 중 둘 이상(또는 한 벤더의 구독 둘 이상)을 쓰며, 긴 에이전트 작업을 돌려 놓고 자리를 비우는 개인 개발자. 결제력 있음(월 $100~400 의 AI 구독).

**핵심 약속**
1. 한 화면에서 여러 세션(분할 패널·떠 있는 카드), 여러 벤더, 여러 계정의 상태·사용량.
2. 폰에서 승인·질문 답·이어가기(릴레이·푸시).
3. **멈춤 없음**: 한도·권한 대기·질문 대기·실패를 감지해 알리고, 가능한 것은 스스로 이어간다(벤더 간 인계, 리셋 시각 자동 재시도).
4. 코드·자격증명은 사용자 기기를 떠나지 않는다. 각 CLI 의 공식 로그인만 쓰고 토큰을 보관·중개하지 않는다.

**하지 않는 것**: 에디터(Cursor 영역), 자체 추론 판매, 클라우드 샌드박스(Conductor 영역), 독립 AI 뉴스 피드(유휴 작업 템플릿으로만), 팀/멀티유저(Pro 반응 뒤 결정).

## 2. 시장·경쟁 (2026-10 확인분)

| 제품 | 가격 | 다벤더 | 같은 벤더 다계정 전환 | 폰 | 비고 |
|---|---|---|---|---|---|
| **Happy** (slopus/happy) | 무료, MIT, 24k★ | Claude·Codex·Grok(+Bedrock) | **있음** — "auth or quota-exhaustion error moves it to the next one" | 폰 앱, E2EE 릴레이(릴레이 서버 공개·자체 호스팅) | "harness 를 더하지 청구서를 더하지 않는다" — 직접 경쟁 |
| Conductor | 로컬 무료 / Pro $50 / Teams $60 | 여러 모델·BYO 구독 | 미확인 | iOS(Pro) | 유료는 클라우드 워크스페이스(Vercel 샌드박스) |
| Claude Code Remote Control | Pro/Max 포함 | Anthropic만 | — | 폰·웹(Anthropic 서버 경유) | 공식 |
| Codex 웹/앱 | ChatGPT 플랜 포함 | OpenAI만 | — | 공식 릴레이 | 공식 |
| Vibe Kanban | 2026-04-10 회사 종료, OSS 존속 | 지원 | 미확인 | 관리형 종료 | "무료 사용자가 대다수, 수익 모델 못 찾음" |
| Terragon | 종료(Astra 보고, **미확인**) | — | — | — | |
| Claude Squad | 무료 OSS | 여러 CLI | 미확인 | 없음 | tmux 기반 |
| **Hermes Agent** (Nous Research) | 에이전트 무료 OSS / Nous Portal Free·Plus $20(크레딧 $22)·Super $100·Ultra $200 | 모델 선택형 | — | 포털 | 2026-10-07 시리즈 B $90M(기업가치 $1.5B), ARR ~$36M(9월) — **돈은 에이전트가 아니라 추론 크레딧에서** 번다. 기업판 "Hermes for Businesses" |

**시사점**
- "다계정 전환 + 다벤더 + 폰 원격"은 **무료로 이미 존재**(Happy). 릴레이를 단독 판매 포인트로 삼지 않는다.
- 무료 사용자만 모으면 Vibe Kanban 의 길. **첫날부터 Pro 가 있어야** 한다.
- 우리에게 있고 Happy 에 없는 것: 병목 감지·재알림·자동 재시도, 벤더 간 인계(컨텍스트 요약 전달), 계정·벤더 통합 사용량 대시보드, 멀티세션 데스크톱 UI(패널·카드·배치 프리셋), 유휴 할당량 작업(계획), 교차 검증(계획). **이 층이 Pro.**
- 가격 비교점: Raycast Pro $10, Termius $10, Cursor Pro $20, Conductor Pro $50. $15 는 "기존 구독에 더하는 도구"로 합리적 출발점. freemium 전환 벤치마크 3~5%(양호)·8~12%(우수), 6개월 기준(ChartMogul 2026 — 저가 개발자 도구 한정치는 미확인).

## 3. 정책 제약 → 설계 규칙

### 확인된 사실
- **Anthropic** (code.claude.com/docs/en/legal-and-compliance, 2026-10-15 열람):
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. … developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
  - "Developers building products … including those using the Agent SDK, should use API key authentication."
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
  - 제품 내 Claude Code 실행 조건: 바이너리 미변조, 인증 방식 제거·제한 금지, 사용자 본인 자격증명으로 본인에게 과금, 사용량 재판매·중개 금지. 이름·로고 사용 제한("runs Claude Code" 라고 평문으로 말할 수 있음).
  - 2026-02 문서 갱신(The Register): "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted." 2026-04-04 집행(OpenClaw 등 차단).
  - 다계정 **보유**는 위반이 아님; 정지 사유는 서드파티 도구에 토큰 사용, 계정 공유·재판매, **한도 회피용 계정 생성**.
- **OpenAI**: 복수 계정 전환 공식 지원, "circumvent any rate limits" 금지; Codex app-server·`codex exec` 공식 통합 경로. **Google**: 보호조치 우회 금지, 헤드리스 자동화 공식 지원; 개인 quota 순환 승인은 미확인.

### deck 의 현재 위치 (코드 감사)
- Claude 엔진은 `@anthropic-ai/claude-agent-sdk` 0.3.285 로 구독 계정을 돌린다. SDK 는 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION` 을 붙여 서버 쪽에서 SDK 호출로 식별 가능 → **금지 문구에 해당하는 조합**.
- Claude 사용량 카드는 별도 로컬 서비스(usage-deck)가 `api.anthropic.com/api/oauth/usage` 를 구독 OAuth 토큰으로 직접 호출 → **가장 민감**.
- Codex(`codex exec --json`)·Gemini(`agy -p --output-format stream-json`)는 공식 CLI 서브프로세스 → 문제 없음.
- Grok(2026-10-18 추가): 공식 Grok Build CLI 를 `grok agent --no-leader stdio`(ACP)로 띄운다. 로그인은 사용자가 `grok login` 으로 직접 하고, deck 은 `~/.grok/auth.json` 을 읽지 않는다. 같은 구조라 정책상 Codex·Gemini 와 같은 자리로 보지만, xAI 약관의 서드파티 래핑 조항은 미확인(§11).
  - **권한 보장 수준(실측 2026-10-18):** Grok CLI 는 사용자 HOME 의 `~/.claude/settings*.json` 권한 규칙을 끌 수 없이 읽고, ACP 모드 설정을 확인할 방법이 없다. 그래서 deck 은 Grok 을 턴별 그림자 HOME 으로 돌리고, 권한 모드는 deck 이 승인 요청에 답하는 방식으로만 구현한다. 약속은 "Grok 이 묻는 동작은 모두 deck 모드대로, 묻지 않는 범위는 Grok 의 읽기 목록뿐, 그 밖의 무승인 쓰기는 감지 즉시 정지"까지다. OS 샌드박스(Seatbelt·bubblewrap)는 v1.1. 제품 문서·온보딩에 이 한계를 그대로 적는다.

### 설계 규칙 (출시 전 필수)
1. **Claude 는 사용자가 설치한 공식 `claude` 바이너리만** 띄운다(`-p --output-format stream-json --input-format stream-json --include-partial-messages --permission-prompts host` 등). SDK 패키지·번들 바이너리 제거. 로그인은 사용자가 터미널에서 `claude` 로 직접 한다. deck 은 `CLAUDE_CONFIG_DIR` 로 프로필을 고를 뿐 토큰 파일을 읽지 않는다.
2. **사용량은 공식 출력·로컬 데이터만**: transcript 집계(`UsageIndex` 이미 있음) + CLI 가 공식으로 노출하는 사용량(statusline 입력·`/usage`·Codex `rateLimits`·Gemini `/usage`). 비공개 엔드포인트 호출 금지. 폴링은 이벤트 우선, 조회는 60~300초 캐시.
3. **같은 벤더 계정 자동 순환은 기본 꺼짐.** 설정에서 켤 때 "본인이 결제하는 본인 계정에만 쓰며, 공유·재판매·한도 회피 목적 계정 생성은 각 제공자 약관 위반" 문구에 동의. **벤더 간 인계**(Claude→Codex/Gemini)는 기본 켜짐. 단 Gemini·Grok 을 자동 분배 후보에 처음 넣을 때 "자동 세션의 코드·대화가 Google/xAI 로 갈 수 있음" 확인을 한 번 받는다(자동 분배 설계 §10-9).
4. 마케팅 금지어: "한도 우회", "무제한", "할당량 100%". 허용: "runs Claude Code", "reuses the subscriptions you already pay for".
5. 벤더 전환은 **체크포인트 기반 인계**로 표시(실행 중 도구 호출의 무손실 재개를 약속하지 않음 — 중복 실행 위험).
6. **사용자가 할 일**: Anthropic 영업/법무에 이 구조(미변조 CLI, 사용자 직접 로그인, 토큰 비접촉, 선택적 다계정)로 서면 확인 요청. OpenAI·xAI 도 동일 문의.

## 4. 티어

| | Community (MIT) | Pro ($15/월) |
|---|---|---|
| 세션·패널·카드·배치 프리셋 | ✓ | ✓ |
| 벤더 | Claude·Codex·Gemini·Grok 각 **1계정** | **계정 무제한**(벤더당 N) + 통합 사용량 대시보드 |
| 같은 벤더 다계정 방식 | — | Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Grok `GROK_HOME`, Gemini(agy)는 자격이 macOS 키체인에 있어 **좌석별 그림자 HOME**(키체인 접근 차단 → 파일 저장소)으로 분리. 그림자 HOME 엔 `.gitconfig`·`.ssh` 만 링크하고 `Library` 는 절대 링크하지 않는다 |
| 자동 분배(첫 턴의 작업 종류·난이도 + 남은 한도 → 엔진·세부 모델) | 후보 1·2순위까지 | 4순위까지 전부 + 곧 리셋되는 여유 우선 사용 |
| 벤더 간 인계(한도·능력 부족 시) | 수동(안내만) | **한 번 눌러 이어가기**(요약 + git 상태 + 결과 불명 명령 전달). 무인 자동 인계는 v1.1 — 권한 관문이 같거나 강한 엔진으로만, 연쇄 1회 |
| 병목 알림(권한·질문·실패 재알림), 리셋 시각 자동 재시도 | ✗ | ✓ |
| 원격 접속 | 같은 네트워크(LAN)·사용자 자체 Tailscale | **릴레이 + 웹 푸시**, 기기 3대 |
| 유휴 할당량 작업(템플릿: 의존성 점검·플레이키 테스트·저장소 관련 브리핑·HANDOFF 갱신) | ✗ | ✓ (출시 뒤) |
| 교차 검증("두 번째 의견": 다른 벤더가 리뷰) | ✗ | ✓ (출시 뒤) |
| 체험 | — | 7일, 카드 없음 |

**두 번째 수익원(Hermes 교훈, 출시 뒤 검토): 메터드 크레딧 폴백.** 모든 구독이 한도에 걸리면 deck 의 Anthropic/OpenAI **API 키**(종량제, 정책상 명시 허용)로 턴을 이어가고 사용한 만큼 크레딧에서 차감 — "멈추지 않는다"는 약속을 끝까지 지키는 장치이자 Hermes 식 크레딧 마진. 기본 꺼짐, 턴 단위 상한, 월 상한, 잔액 카드. 마진은 10~20% 가 현실적이라 주 수익원이 아니라 Pro 의 완성도 장치로 본다. 선불 크레딧은 MoR 가 처리.

Team(공유 계정 풀·관리자)은 Pro 지표 확인 뒤. 라이선스 우회(오픈소스 로컬 검사 제거)는 감수 — 릴레이·푸시·기기 등록은 서버가 entitlement 를 검증하므로 우회해도 클라우드 이용권은 생기지 않는다.

## 5. 아키텍처

```
[폰 브라우저/PWA] ──TLS──▶ [Relay: Cloudflare Durable Objects] ◀──outbound WS── [사용자 Mac: quarterdeck 로컬 서버]
                                   │                                                   │
                                   ▼                                                   ▼
                           [Cloud API: 계정·entitlement·푸시·기기]            [claude / codex / agy / grok CLI 서브프로세스]
                                   ▲
                                   │ webhooks
                              [Paddle (MoR)]
```

### 5.1 로컬 앱 (`quarterdeck` npm 패키지)
- `npx quarterdeck` → 첫 실행 마법사: 설치된 CLI 감지·로그인 상태 확인(각 CLI 의 공식 명령으로) → 계정 프로필 추가(`CLAUDE_CONFIG_DIR` 생성 후 "터미널에서 `claude` 로 로그인하세요" 안내, deck 은 로그인 완료만 감지) → 폰 페어링 QR.
- 패키지: `bin` 추가, `private` 해제, 서버 **빌드 산출물**(esbuild → `dist/server`) 또는 tsx 를 dependencies 로, `files`, `prepack` 에서 UI 빌드. `dist/ui` 경로를 패키지 기준으로 해석. Node 최소 버전은 현행 `>=24` 유지(낮추는 것은 §10 확인 뒤).
- Pro 모듈: `@quarterdeck/pro`(비공개 npm 또는 서버가 내려 주는 서명된 번들). 로컬 서버가 entitlement 토큰(서명 JWT, 24시간 갱신, **7일 오프라인 유예**)을 확인해 로드. Community 빌드는 모듈 없이도 완전 동작.
- 제거·격리: `claude-pick`/`offload`/a·b·c `LEGACY_*` 결합, usage-deck 의존, launchd 전제(Linux systemd 유닛 추가, Windows 는 2차).
- i18n: UI 문자열 추출(react-i18next 또는 경량 자체 사전), 영어 기본·한국어 번역. 서버 메시지(turn_notice·오류)도 키 기반으로.

### 5.2 Claude 엔진 전환 (SDK → CLI)
- 현재 819줄 `ClaudeEngine.ts`, 사용 옵션: cwd, env, model, effort, resume, forkSession+resumeSessionAt, permissionMode, settingSources, includePartialMessages, replay-user-messages, abort, settings(permissions.allow), additionalDirectories, canUseTool, hooks(PreToolUse·UserPromptSubmit·PostToolUse·PostToolUseFailure·PermissionDenied). 받는 메시지: system(init·compact·task_*·permission_denied), stream_event, assistant, user, result.
- 전환 요건(2026-10-15 CLI 2.1.283 `--help` + 공식 CLI 레퍼런스로 확인): stream-json 입출력은 그대로(파서 재사용). **권한·AskUserQuestion** 은 문서화된 경로인 `--permission-prompt-tool <mcp 도구>` 로 받는다 — deck 이 프로세스마다 작은 stdio MCP 서버를 `--mcp-config` 로 붙이고, 그 도구가 `tool_name`·`input`·`tool_use_id` 를 deck 서버로 전달해 사용자의 답을 기다린 뒤 `{"behavior":"allow","updatedInput":…}` / `{"behavior":"deny","message":…}` 를 JSON 문자열로 돌려준다. AskUserQuestion 도 같은 경로(`updatedInput.answers`). stdin 의 `control_request/response` 프로토콜은 SDK 내부용으로 비문서화 → 쓰지 않는다. 훅은 `--settings` 의 `hooks` 명령으로(스트림 이벤트로 대체 가능한 것은 제거). abort 는 SIGINT(턴 종료·결과 기록), 강제 종료는 SIGTERM. fork 는 `--resume <id> --fork-session`(확인됨). **`resumeSessionAt`(특정 메시지에서 fork)은 SDK 전용 — CLI 에 없음 → 기능 상실 또는 재설계.** `--session-id <uuid>` 로 deck 이 세션 ID 를 직접 정할 수 있어 외부 쓰기 식별(`foreignWrites.ts`, 현재 `entrypoint === 'sdk-ts'`)은 "deck 이 만든 세션 ID 집합" 기준으로 재설계. **`--bare` 는 쓰지 않는다**(구독 로그인을 읽지 않음).
- 작업 크기 **중~대**. 출시 전 필수. **최소 지원 버전 2.1.259**(`--permission-prompts` 도입) 이상, 권장 2.1.283 — 시작 시 `claude --version` 검사. 구현 계획: `docs/superpowers/plans/2026-10-15-claude-engine-cli.md`.

### 5.3 클라우드
- **계정·entitlement API** (Cloudflare Workers + D1 또는 Supabase — 운영 단순성 기준으로 Workers 통일): 이메일 매직링크 로그인, 기기 등록(최대 3), entitlement 발급(Ed25519 서명, 24h), Paddle 웹훅(서명 검증, 멱등 처리, 순서 역전 처리; 환불·해지·결제 실패 구분 — 결제 실패는 유예 7일, 실행 중 작업은 끊지 않음).
- **릴레이** (Durable Objects, 사용자당 1 객체, Hibernation): Mac 이 outbound WS 로 상주, 폰이 접속하면 프레임 중계. 릴레이는 **암호문만** 본다 — QR 일회용 페어링 → 기기 공개키 교환 → 방향별 대칭키, 순번·재전송 방지. 기존 토큰 인증은 Mac 쪽 두 번째 벽으로 유지. 푸시 본문에는 코드·명령을 넣지 않는다(제목·세션명·종류만).
- **푸시**: VAPID 는 클라우드가 보유, Mac 이 릴레이를 통해 발송 요청(현재 Mac 의 web-push 직접 발송은 LAN 모드에서만).
- 비용 추정(Astra, 미검증): 1,000 사용자·2,000 WS 상시 기준 DO $25~65/월(Hibernation 가정; 상시 활성화 시 최대 ~$4,150 — 부하 테스트로 확인), Fly $120+, Railway $145+.
- 가치 보호: 릴레이·푸시·기기 등록은 서버에서 entitlement 를 검증.

### 5.4 결제
- Paddle Billing: Pro 월·연 2개 가격, 7일 체험(카드 없음 — Paddle 체험 설정 확인), 창립 고객 쿠폰. 세금·환불·분쟁은 MoR 가 처리.
- 사용자가 할 일: Paddle 가입·KYC(한국 개인/개인사업자), USD 수취 계좌·SWIFT 비용 확인, 첫 정산으로 확정. 대안 Polar.

## 6. 보안 요구
- 로컬 서버: 로그인 레이트리밋 추가, 세션 쿠키 회전, cwd 루트 기본값을 홈 전체 → 사용자가 고른 폴더들로.
- 릴레이: E2EE(§5.3), 서버는 메타데이터(사용자 id·기기 id·바이트 수)만 로그.
- 자격증명 비접촉: 토큰 파일·키체인·`~/.codex/auth.json` 을 읽는 코드가 없음을 테스트로 고정(기존 hygiene 테스트 확장).
- 공개 저장소 위생: 현행 export 검사 유지.

## 7. 일정 (주 단위, 1인 + 에이전트)

| 주 | 내용 | 산출 |
|---|---|---|
| 1~2 | **정책 준수**: Claude 엔진 CLI 전환, usage-deck 의존 제거(로컬 집계), 같은 벤더 순환 기본 꺼짐+동의, 금지어 점검 | 기존 기능 동일 동작, 테스트 통과 |
| 2~3 | **설치**: npm 패키지화, 첫 실행 마법사, 계정 프로필 UI, Linux 서비스, 개인 도구 결합 제거 | `npx quarterdeck` 로 타 기기 설치 성공 |
| 3~4 | **i18n** 영어 기본, 랜딩 초안, 데모 영상 | 영어 UI |
| 4~6 | **클라우드**: 계정·entitlement·Paddle 웹훅·릴레이 DO·푸시, 페어링 QR, Pro 모듈 로딩·7일 체험 | 폰에서 릴레이 경유 승인 성공 |
| 6~7 | 부하·재연결·인계 실패 테스트, 보안 점검(외부 1인 리뷰), 문서(약관·개인정보·보안 모델) | 베타 |
| 7~8 | **런칭**: Show HN("Open-source cockpit for local coding agents"), r/ClaudeAI(자리 비운 사이 폰에서 승인 사례), r/ChatGPTCoding(Claude↔Codex 인계 데모), X 20초 영상, Product Hunt, GeekNews(제작기) | 창립 고객 |
| 런칭 뒤 | 유휴 할당량 작업, 교차 검증 버튼, Team 검토 | |

병행(사용자): Anthropic·OpenAI 서면 확인, Paddle KYC, 도메인·회사명(상표: "Claude Code"·"Codex" 를 제품명에 쓰지 않음).

## 8. 지표
- 설치 → 첫 원격 승인 성공 → 7일 재사용 → 유료 전환(목표 6개월 3~5%) → 3개월 유지.
- Pro 기능별 사용 빈도(병목 알림 해소 수, 자동 재시도 성공률, 벤더 간 인계 수).

## 9. 리스크
1. **정책 집행**: Anthropic 이 CLI 래퍼까지 막으면 Claude 축이 무너짐 → 서면 확인, Codex·Gemini·Grok 축 유지, 공식 Remote Control 과의 공존 설계.
2. **무료 대체재(Happy·공식 원격)**: 릴레이는 포함 기능일 뿐, 자동화 층으로 차별화. 사용자 10명 비교 테스트.
3. **인계 중 중복 실행·원격 명령 보안**: 체크포인트 인계, E2EE, 푸시 무해화.
4. **1인 운영 부담**: Workers/DO 로 서버 운영 최소화, MoR 로 세무 제거.

## 10. 구현 계획 분할
이 스펙은 독립 하위 시스템 넷을 담으므로 계획은 넷으로 나눈다. 각 계획은 단독으로 동작·검증 가능해야 한다.
1. **정책 준수** (§3 규칙 1~3, 7장 1~2주): Claude 엔진 CLI 전환, usage-deck 의존 제거, 순환 기본 꺼짐·동의. 가격·클라우드와 무관하게 선행.
2. **설치·패키징·계정 UI** (§5.1, 2~3주).
3. **i18n·랜딩** (3~4주).
4. **클라우드·Pro 모듈·결제** (§5.3~5.4, 4~6주).

## 11. 미확인 (구현 전 확인)
- ~~`--permission-prompt-tool`·`--fork-session`·`--permission-prompts` 존재~~ → 확인됨(§5.2). 남은 것: `--permission-prompt-tool` 이 `permission_suggestions`(항상 허용 규칙 제안)를 넘기는지, `tool_use_id` 로 중복 요청을 걸러도 되는지 — 첫 스파이크에서 실제 호출을 기록해 확인.
- CLI 가 `CLAUDE_CODE_ENTRYPOINT` 환경변수를 transcript `entrypoint` 에 그대로 쓰는지(쓴다면 식별 재설계가 쉬워지지만, SDK 흉내로 보일 수 있어 **쓰지 않는 쪽**이 안전).
- Node 최소 버전을 22 로 낮출 수 있는지(의존성 확인).
- Paddle 한국 개인 판매자 KYC·KRW/USD 정산 비용, 카드 없는 체험 지원.
- Terragon 종료 여부(랜딩 비교표에 넣지 않음).
- DO Hibernation 하의 실제 비용(부하 테스트).
- Happy 의 Gemini 지원 여부.
- xAI(Grok) 약관: 구독 로그인한 공식 CLI 를 다른 제품이 서브프로세스로 띄우는 것이 허용되는지, 같은 벤더 다계정(`~/.grok-x2`) 조항. 서면 확인 대상에 xAI 추가.
- Grok 구독 사용량을 공식으로 읽는 경로(`grok usage` 는 세션별 토큰·비용만). 없으면 Grok 카드는 로그인 상태·턴 토큰·관측된 한도 오류만 보인다.
- agy 그림자 HOME 다계정이 키체인의 1번 계정 항목을 덮어쓰지 않는지(실측 예정, 두 HOME 의 `/usage` 비교). Google 약관의 같은 사람 다계정 조항.
- ~~벤더 간 분배 순서~~ → 확정(2026-10-18, 사용자가 분배를 맡김): `2026-10-18-auto-route-design.md`. 남은 미확인: Gemini 버킷의 리셋 주기(실측 뒤 "곧 리셋" 규칙에 넣음), 동시 세션 쏠림의 실제 크기.
