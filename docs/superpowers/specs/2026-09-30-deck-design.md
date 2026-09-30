# deck — 계정 자동 분배 Claude 셸 설계

> 2026-09-30 · 승인된 설계 (agentic-harness 세션 brainstorming). 구현 계획은 `writing-plans` 로 별도 작성.

## 1. 목표

Claude Desktop 과 최대한 같은 화면에서 **고정 프로젝트 약 10개**를 계속 작업하되, **Claude Max 3계정(A·B·C) + ChatGPT Pro 1계정**을 사람이 로그아웃하지 않고 **자동으로 나눠 쓰고**, 토큰을 최적화한다. 9/27 부터 다른 쪽에서 만들던 "opencode 기반 계정전환 앱"은 이 앱으로 **대체**한다(사용자 결정).

**성공 기준**
- 평소 사용 7일 동안 수동 로그아웃·계정 전환 0회.
- 한 계정이 주간 95% 에 닿는 동안 다른 계정이 50% 미만으로 노는 상황이 생기지 않는다.
- 기존 Desktop 세션(10개 프로젝트)을 그대로 열어 이어서 쓸 수 있다.
- 폰에서 Tailscale 로 접속해 이어 쓸 수 있다(인증 필수).
- 매 턴 어느 계정·모델이 왜 쓰였는지 화면에서 보인다.

**하지 않는 것(v1)**: 인터넷 공개 접속, 다중 사용자, Claude Desktop 고유 기능 복제(Remote Control 은 Tailscale 웹 접속으로 대체), 쓰기 가능한 오프로드(3단계).

## 2. 정책 경계 (결정됨)

- **모든 모델 호출은 공식 클라이언트 + 구독 OAuth 로그인**으로 한다. Claude 는 공식 Claude Agent SDK(= Claude Code 엔진)를 계정별 프로필로, GPT 는 공식 Codex CLI(ChatGPT 로그인)로.
- API 키를 쓰지 않는다. 앱이 OAuth 토큰을 꺼내 API 를 직접 부르지 않는다(omo 식 토큰 교체 프록시 금지 — 하네스 OFF-POLICY).
- 계정 프로필 규칙(실측): 계정 a 는 `CLAUDE_CONFIG_DIR` **미설정**(설정하면 키체인 서비스명에 해시 접미사가 붙어 인증 실패), b·c 는 `~/.claude-b`·`~/.claude-c`. 모든 실행에서 `CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN` 제거(환경 토큰이 config dir 보다 우선 → 조용히 다른 계정 과금).

## 3. 구조

맥에서 도는 **Node + TypeScript 서버**(프로젝트 파일이 맥에 있다) + **React 웹 UI**, 실시간 전송은 **WebSocket**. 폰·다른 기기는 Tailscale 로 같은 웹 UI 에 붙는다.

```
브라우저(맥·폰) ──WS──▶ 서버
                         ├─ AccountRouter ── UsageService ── usage-deck /api/state
                         ├─ ModelPolicy
                         ├─ SessionMover (계정 간 세션 파일 이전)
                         ├─ ClaudeEngine (Agent SDK, 계정별 프로필)
                         ├─ CodexEngine  (Codex CLI JSON 모드)
                         ├─ SessionIndex (기존 세션 가져오기)
                         └─ Auth (Tailscale·localhost 바인드 + 로그인)
```

### 3.1 컴포넌트

| 컴포넌트 | 하는 일 | 입력 → 출력 | 의존 |
|---|---|---|---|
| **AccountRouter** | 매 턴 계정 결정 | 세션 상태·한도·캐시 온도 → `{account, reason}` | UsageService, `claude-pick` 점수 규칙 |
| **ModelPolicy** | 턴 모델 결정 | 세션 기본 모델·사용자 지정 → 모델 id | 난이도 표(§4.2) |
| **SessionMover** | 계정이 바뀔 때 세션 파일을 대상 프로필로 복사·검증 | 세션 id, from, to → ok/실패 | 파일 시스템 |
| **ClaudeEngine** | Agent SDK 로 한 턴 실행, 이벤트 스트리밍, 권한 요청 중계 | 프롬프트·첨부·resume id·프로필 → 이벤트 스트림 | Agent SDK |
| **CodexEngine** | Codex 세션의 한 턴 실행 | 프롬프트·resume id·모델 → 이벤트 스트림 | Codex CLI |
| **UsageService** | 계정별 잔여량 | usage-deck 폴링(60초) + 턴 사용량 보정 → 잔여 % · 리셋 시각 | usage-deck |
| **SessionIndex** | 기존 세션 목록 | `~/.claude*/projects/**.jsonl` → 프로젝트별 세션 | 파일 시스템 |
| **Auth** | 접속 인증 | 로그인 → HttpOnly 세션 쿠키, WS 출처 검사 | — |

각 컴포넌트는 인터페이스만 보고 쓸 수 있게 분리하고, 엔진은 스텁으로 바꿔 끼워 테스트한다.

## 4. 분배 정책

### 4.1 계정 — 매 턴 판단, 이득이 있을 때만 전환

사용자는 "매 턴 자동"을 골랐다. 그런데 턴마다 **실제로** 계정을 바꾸면 새 계정이 전체 문맥을 캐시에 다시 써야 한다(입력 단가 ×1.25, 같은 계정 유지 시 ×0.1 — 최대 12배). 그래서 **판단은 매 턴, 전환은 조건부**로 한다.

1. 현재 계정이 문턱(5h ≥ 80% 또는 주간 ≥ 85%)을 넘었거나 쿨다운 중 → **즉시 전환**.
2. 캐시가 식었다(그 계정 마지막 턴 후 55분 이상, 또는 방금 압축됨) → 점수가 더 좋은 계정으로 **전환**(전환 비용 ≈ 0).
3. 그 외 → **유지**.

점수는 `claude-pick` 과 같은 규칙: `(100 − 주간%) / 리셋까지 남은 시간(h)`, 5h·주간 95% 이상 제외, 데이터가 600초보다 오래되면 신뢰 낮춤. `~/.config/offload/protect` 의 계정(Claude Desktop 을 병행할 때)은 마지막 후보. 결정과 이유를 턴 뱃지로 표시한다(예: "C 유지 · 캐시 따뜻함").

### 4.2 모델 — 난이도 × 제공자 (Haiku·Luna 는 쓰지 않는다)

| 난이도 | Claude | GPT |
|---|---|---|
| 쉬움·조회 | Sonnet | gpt-6-sol |
| 보통 | Opus | gpt-6-sol |
| 어려움·깊은 단발 | Fable | gpt-6-astra |

- 주 턴 모델은 세션 설정(기본 Opus). 서브에이전트 모델은 하네스 에이전트 정의를 따른다.
- Haiku 제외 근거: 비용 비중 0.5%(9/27 실측) + 헤드리스 Haiku 는 편집·셸을 전부 거부(9/29 실측). **하네스 전역 라우팅도 explore·writer·git-master 를 Haiku → Sonnet 으로 맞춘다**(구현 계획 0단계).
- Fable 은 계정별 Fable 서브캡 80% 이상이면 그 계정에서 쓰지 않는다.

### 4.3 역할

- 세션의 엔진(Claude/GPT)은 **세션 단위**로 정한다 — 두 엔진은 세션 형식이 달라 대화 도중 넘길 수 없다. "자동"은 여유 있는 쪽으로 연다.
- 세션 안의 무거운 읽기 작업·교차검증은 기존 `offload-guard` 훅 + `offload`(Claude 여유 계정 / GPT) 가 맡는다. Agent SDK 가 사용자 설정(훅·에이전트·CLAUDE.md)을 읽도록 한다.
- 문맥 관리: `autoCompactWindow` 200000(3프로필 적용 완료) + 프로젝트별 `docs/HANDOFF.md` 규약.

## 5. 화면

- **사이드바**: 고정 프로젝트(설정 파일 `~/.config/deck/projects.json`) → 세션 목록(최근 활동순).
- **채팅**: 스트리밍 마크다운, 도구 호출 접기/펼치기, diff 보기, **권한 승인 카드**(허용 1회 / 이 세션 동안 / 거부), 중단 버튼.
- **턴 뱃지**: 계정 · 모델 · 입력/출력 토큰 · 계정 결정 이유.
- **잔여량 패널(상단 고정)**: 계정마다 5h·주간·Fable **남은 %** 와 리셋까지 남은 시간, ChatGPT Pro 주간. 80% 주의 / 95% 위험 색, 현재 세션 계정 강조. 폴링 사이는 턴 사용량으로 보정.
- **분할보기**: 2~4 패널, 각 패널이 독립 세션.
- **첨부**: 이미지 붙여넣기·끌어놓기(이미지 블록으로 전달), 파일 끌어놓기(경로 참조).
- **폰**: 같은 앱의 반응형 레이아웃(사이드바 서랍, 한 패널).

## 6. 보안

이 앱은 맥에서 명령을 실행할 수 있다 — 보안이 1순위다.
- 바인드: `127.0.0.1` + Tailscale 주소(100.64.0.0/10)만. 공개 인터페이스 금지.
- 인증: 첫 실행 시 생성한 긴 무작위 토큰으로 로그인 → HttpOnly·SameSite=Strict 쿠키. (패스키는 이후.)
- WebSocket: `Origin` 이 앱 자신일 때만 수락, 쿠키 검증.
- 권한: 기본 "매번 묻기". 승인·거부는 감사 로그로 남긴다. 비밀값은 UI·로그에 출력하지 않는다.

## 7. 기존 세션 가져오기

`~/.claude/projects`, `~/.claude-b/projects`, `~/.claude-c/projects` 의 `.jsonl` 을 읽어 `cwd` 로 프로젝트에 묶는다. 제목은 세션 요약 줄 또는 첫 사용자 메시지. 열면 `resume` 으로 이어간다(필요하면 SessionMover 가 현재 계정 프로필로 이전). 원본 파일은 수정하지 않는다(복사).

## 8. 오류 처리

| 상황 | 처리 |
|---|---|
| 턴 도중 계정 한도 도달 | 계정 쿨다운 기록(`claude-pick` 과 공유) → 세션 이전 → 다음 계정으로 같은 턴 재시도(최대 2회). **실제 한도 도달 시 SDK 반환값은 미실측** — `claude-limit-probe` 포착으로 확인 전까지 오류 문구 패턴도 함께 본다 |
| usage-deck 응답 없음 | 현재 계정 유지, 잔여량 패널에 "오래된 값" 표시 |
| 세션 이전 실패 | 전환 취소, 현재 계정 유지, 경고 표시 |
| 엔진 프로세스 비정상 종료 | 턴 실패 표시 + 재시도 버튼, 세션 파일은 보존 |
| 브라우저 연결 끊김 | 서버는 턴을 끝까지 실행, 재접속 시 이어서 표시 |

## 9. 테스트

- 단위: AccountRouter(한도·캐시 온도·쿨다운 조합 픽스처), ModelPolicy, SessionMover(임시 디렉터리), SessionIndex, Auth(출처 거부·미인증 거부).
- 엔진: 스텁 엔진으로 이벤트·권한 흐름 검증 + 계정별 실제 최소 호출(`ok` 응답) E2E.
- UI: 컴포넌트 테스트 + 폰 폭 스냅샷.
- 과금 검증: 전환 후 대상 계정의 5h 창이 움직이는지(usage-deck).

## 10. 단계

0. **준비**: 하네스 라우팅 Haiku → Sonnet(`scripts/apply-model-routing.sh` 템플릿 + 전역 CLAUDE.md + 에이전트, `CODEX_CFG=/nonexistent/skip`). Agent SDK·Codex CLI JSON 모드 기능을 공식 문서로 확인(resume, 계정별 env, 권한 콜백, 사용자 설정 로드, 이미지 입력).
1. **핵심**: 서버·Auth·ClaudeEngine·AccountRouter·SessionMover·UsageService·SessionIndex, 단일 패널 채팅 + 사이드바 + 잔여량 패널.
2. **v1 완성**: 분할보기, 첨부, 폰 레이아웃, CodexEngine, 역할 분배 표시.
3. **이후**: 쓰기 가능한 오프로드(워크트리 + 패치), 데스크톱 창 래핑, 패스키.

## 11. 착수 전 확인 목록

- Agent SDK 가 턴마다 다른 `CLAUDE_CONFIG_DIR`(env) 로 실행·resume 되는지, 권한 콜백으로 UI 승인이 되는지 — 문서 + 실측.
- 세션 이전 시 함께 옮겨야 할 부속 파일(서브에이전트 사이드체인 등).
- Codex CLI 의 JSON 모드와 resume 방식.
- 구현은 **Desktop 을 A(0%)로 옮긴 뒤 새 세션**에서(이 설계를 쓴 세션은 문맥 50만).
