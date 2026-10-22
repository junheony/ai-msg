# AI-MSG 상용 출시 준비 — 법무·브랜드 점검과 출시 체크리스트

> 2026-10-22. 코드 전수 점검(로고·색·라이선스·로컬 파일 읽기)과 벤더 공식 문서 조사를 합친 것. **법률 자문 아님** — 결제를 켜기 전 ①②⑥ 쟁점은 변호사 1회 확인 권장. 비공개 문서(공개본 제외 경로).

## 1. 결론

- 구조 자체(사용자가 직접 로그인한 **수정 안 한 공식 CLI** 를 자기 컴퓨터에서 실행)는 Anthropic 문서가 명시적으로 허용하는 쪽이다. 위험은 그 바깥 — 로고, 비공개 앱 데이터, 한도 우회처럼 보이는 기능, 그리고 Pro 가 "Claude 사용을 중개"하는 것처럼 보이는 문구다.
- 색 하나로 소송당할 가능성은 낮다(색은 저작권 대상 아님, 색 상표는 2차적 의미 입증 필요). 하지만 **#d97757(Claude 테라코타와 hex 동일) + ✳ 스파크 + "Claude Desktop-style" 자기소개**가 겹치면 혼동·트레이드 드레스 주장의 근거가 된다 → 고유색·고유 표시로 교체.

## 2. 벤더별 판정 (근거 URL 은 조사 원문 기준)

| 벤더 | 판정 | 근거 요지 | AI-MSG 조치 |
|---|---|---|---|
| Anthropic | 허용(경계 회색) | code.claude.com/docs/en/legal-and-compliance: 서드파티가 claude.ai 로그인 제공·자격증명 수집·"route requests … on behalf of users" 금지 / "end user signing in to the unmodified Claude Code binary with their own subscription" 은 허용 / "may not pay for, resell, or intermediate Claude usage" / 바이너리 수정·인증 방식 제한 금지 / 한도는 "ordinary, individual usage" 전제 | 스파크·로고 제거, 바이너리 무수정·로그인은 `claude` 자체 흐름만, 토큰 미접근 공개 선언, API 키 모드 안내, Pro 문구는 "릴레이·푸시"만(Claude 사용 판매 아님) |
| Anthropic 상표 | 로고 금지 | "plain text 로 runs Claude Code 라고 말할 수 있음", 이름·로고를 제품/기능/회사명·자체 로고에 쓰거나 보증 암시 금지, 그 외 서면 허가 | ✳ 마크 전부 제거, 기능명 "Claude Desktop 미러링" 개명 |
| OpenAI | 라이선스 허용·로그인 미확인·브랜드 제약 | Codex CLI Apache-2.0, ChatGPT 로그인 공식 지원 / openai.com/brand: GPT 를 제품명에 쓰지 말 것 | Blossom 로고(원본 path 복사 추정) 즉시 제거, 텍스트 표기만 |
| Google | 회색 | Gemini CLI FAQ: 서드파티가 OAuth 를 "harvest or piggyback" 하면 위반·정지 사유, API 키 권장 / 2026-03 대량 403 보고(2차) | 공식 `gemini` 그대로 실행 유지, Gemini 는 API 키 모드 권장 표기, 로고 제거 |
| xAI | 대부분 미확인 | Grok CLI early access(Apache-2.0 보도) | Grok Bot 앱 내부 데이터 읽기 제거/옵트인, 로고 제거 |
| Paddle | 허용 가능성 높음 | 금지 목록에 AI 래퍼 없음. 걸릴 수 있는 항목: 상표 침해, "Unauthorized data access tools", "VPNs and proxies (restricted)" | 심사 자료에 "자체 소프트웨어, AI 사용 비재판매, 릴레이는 자기 기기 간 E2EE 동기화이지 범용 프록시 아님" 명시. 한국 사업자 요건은 Paddle 에 직접 확인(미확인) |

**선례(2차 자료):** 2026-02 문서 개정 뒤 4월부터 OpenClaw 등 구독 토큰을 직접 쓰던 하네스 차단 보도. 토큰 탈취·직접 API 호출 사례라 공식 바이너리를 쓰는 AI-MSG 와 다르지만, Anthropic 이 "사전 통지 없이" 집행할 수 있다는 점은 사업 위험으로 남는다.

## 3. 코드 점검에서 나온 조치 항목

| # | 항목 | 위치 | 위험 | 조치 |
|---|---|---|---|---|
| L1 | OpenAI 로고 path(원본 복사 추정) | `src/ui/components/EngineMark.tsx:8` | 높음 | 제거 → 중립 엔진 배지 |
| L2 | Claude 스파크 `ClaudeMark`(#D97757) — 인사말·진행 스피너·사이드바·세션 칩·명령 팔레트 | `EngineMark.tsx:19-27`, `NewChat.tsx:160`, `Activity.tsx:112,164` 등 | 높음 | 제거 → AI-MSG 고유 표시 |
| L3 | Gemini 4점 별·Grok 마크 | `EngineMark.tsx:33,41-46` | 중간 | 제거 → 중립 배지 |
| L4 | 강조색 `#d97757`/`#c96442`, 웜 베이지 배경 | `src/ui/styles.css:19,61-76` | 중~높음(조합) | 고유 팔레트로 교체(대비 검사 유지) |
| L5 | README "Claude Desktop-style web shell", 기능명 "Claude Desktop mirroring" | `README.md:10,26` | 중간 | 문구 교체 |
| L6 | Grok Bot 앱 내부 캐시 파싱(세션·주간 사용량) | `src/server/sessions/GrokBotImports.ts`, `UsageService.ts:352` | 높음 | 상용판 기본 꺼짐(옵트인·읽는 범위 고지) 또는 제거 |
| L7 | Claude Desktop 세션 파일 읽기·**쓰기**(미러링) | `src/server/sessions/DesktopSessions.ts` | 높음 | 기본 꺼짐, "실험적·비공식" 고지 |
| L8 | 여러 계정 순환·한도 자동 이어가기·failover | 엔진/라우팅 | 높음(미확인) | "개인 사용 한도" 전제와 충돌 소지 → 공개판은 같은 벤더 계정 순환 끄고 숨김, 단일 계정 기준 문구 |
| L9 | 라이선스 MIT, NOTICE 없음 | `LICENSE`, `package.json` | 중간 | 결정 D1 + 의존성 고지 파일 자동 생성(web-push MPL-2.0 포함) |
| L10 | 앱 안 비제휴 고지 없음(README 에만) | — | 중간 | 설정 "정보"·랜딩·결제 페이지에 고지 |
| L11 | Gemini/Codex 로컬 DB·rollout 읽기 | `GeminiImports.ts`, Codex 파서 | 중간 | 읽는 파일·목적을 문서에 공개, 설정에서 끌 수 있게 |
| L12 | 매니페스트 이름 "deck", 설명 "Claude · GPT 세션 셸" | `src/ui/public/manifest.webmanifest` | 낮음 | AI-MSG 로, 벤더명 빼기 |

의존성: prod 직접 3개(web-push MPL-2.0, ws, zod), 전이 ~120 중 GPL 계열 없음. 폰트 번들 없음. `@anthropic-ai/claude-agent-sdk` 는 package.json·lock 에 없는 잔여물(배포 안 됨).

## 4. 출시 체크리스트

### 제품(진행 중)
- [x] 질문 카드 재디자인(병합, 재시작 대기)
- [ ] 상단 세션 머리 재디자인 · 대화 본문 정리(모델 칩·작업 기록 한 줄·상태 칩) · 입력창/사이드바 정리
- [ ] 브랜드 교체: L1–L5, L12 — 고유 팔레트·엔진 배지·AI-MSG 마크(결정 D2)
- [ ] 위험 기능 정리: L6–L8, L11(결정 D3)
- [ ] 계획 ③ i18n(Task 1 리뷰 중) → 랜딩(en/ko)
- [ ] 계획 ④ 클라우드 Pro·결제(착수 전 Fable 보안 검토)

### 법무·고지
- [ ] 라이선스 결정(D1), LICENSE·NOTICE·THIRD_PARTY 생성
- [ ] 비제휴 고지(앱·랜딩·결제), 이용약관·개인정보처리방침(릴레이 메타데이터·결제 정보·푸시 구독), 환불 정책(Paddle 요구)
- [ ] "공식 바이너리·자기 로그인만, 자격증명 미접근" 원칙 문서 공개
- [ ] AI-MSG 상표 선행조사(KIPRIS·USPTO) — 사용자 몫
- [ ] 변호사 1회 검토: 구독 로그인 경계, Pro 문구, 로컬 데이터 읽기 — 사용자 몫

### 배포·운영(사용자 몫 포함)
- [ ] 도메인 aimsg.app, npm `ai-msg`(거부 시 `@ai-msg/cli`), Paddle KYC, Cloudflare 계정
- [ ] 지원 채널(이메일/GitHub Issues), 상태 페이지 여부, 오류 리포트 수집 정책(옵트인)

## 5. 결정 지점

**확정(2026-10-22):** D1 Apache-2.0 코어 + 클라우드 비공개 · D2 딥 인디고 + 고유 글자 엔진 배지(C·G·Gm·X, 벤더 로고·닮은꼴 없음) · D3 기본 꺼짐·설정에서 직접 켜기(기존 설치는 유지) · 로고 컨셉 "AI 의 조미료(MSG)" — 주인공은 AI, AI-MSG 는 맛을 살리는 조연.

- **D1 라이선스:** (a) Apache-2.0 코어 + 클라우드 비공개(권장 — 특허 조항·상표 비부여 명시, 가치가 호스팅 릴레이에 있으므로 코어 복제 위험 낮음) / (b) MIT 유지 / (c) FSL·BUSL(소스 공개, 경쟁 상용 금지, 2년 뒤 오픈소스 전환).
- **D2 고유 색:** 테라코타 대체 팔레트 방향.
- **D3 위험 기능:** Grok Bot 읽기·Desktop 미러링·계정 순환 — 공개판에서 제거 / 기본 꺼짐 옵트인.
- **확정 (2026-10-22) 토큰(한도) 자동 분배:** 벤더 간(Claude·GPT·Gemini·Grok) 자동 분배는 모두에게 기본 켜짐, 같은 벤더 여러 계정 순환은 설정에서 직접 켜기(켜면 그 뒤로는 자동) — 약관에 걸릴 수 있는 것은 사용자가 고른다.
- **확정 (2026-10-22) 엔진 간 이어가기·기본 엔진:** 세션 도중 한도 → 다른 AI 로 무인 자동 이어가기(기본 켜짐, 동의 없는 외부 엔진 제외)·새 설치 기본 엔진 자동.
