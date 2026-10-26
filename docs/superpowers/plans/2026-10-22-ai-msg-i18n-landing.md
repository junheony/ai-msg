# AI msg 영어 기본 i18n · 랜딩 페이지 · 데모 자산 · 설치 문서 구현 계획 (계획 ③)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **작성 2026-10-22.** 제품명 **AI msg**(npm `ai-msg`, CLI `ai-msg`) 기준. 패키징 계획 ②(`2026-10-18-quarterdeck-packaging.md`)의 Task 8(설치 문서와 전체 검증)을 이 계획의 Task 8 로 흡수한다. 유료(계획 ④)와 같은 날 출시하므로, 랜딩의 가격 버튼은 계획 ④ 의 결제 링크가 꽂힐 자리와 계약만 만든다.

**Goal:** 처음 여는 사람이 영어로 쓰는 제품이 되게 한다 — UI·서버 알림·CLI 출력·모델에게 가는 프롬프트까지 영어가 기본이고 한국어는 고를 수 있다(브라우저 언어 감지 + 설정 토글). 영어 랜딩 페이지(히어로·데모·기능·가격·FAQ·보안 모델·설치 한 줄 `npx ai-msg`)를 저장소 안 `site/` 에서 정적으로 빌드해 Cloudflare Pages 에 올릴 수 있게 하고, 스크린샷은 합성 데이터로 만든 렌더 픽스처에서 뽑는다. README·`docs/install.md` 를 영어 우선으로 다시 쓴다.

**Architecture:** 라이브러리 없이 **타입 있는 자체 사전**을 쓴다. `src/shared/locale.ts` 가 런타임마다 하나인 현재 언어(`setLocale`/`getLocale`)와 감지 규칙을 갖고, 사전은 세 군데 — UI(`src/ui/i18n/{en,ko}/<화면>.ts`), 서버(`src/server/i18n/{en,ko}/<영역>.ts`), 양쪽 공용(`src/shared/messages/{en,ko}.ts`) — 에 둔다. `en` 이 원본이고 `ko` 는 `Widen<typeof en>` 타입을 만족해야 해서 **키 불일치는 `tsc` 가 잡는다**. 문구는 지금 `setupTexts.ts` 처럼 문자열 또는 `(인자) => string` 함수다. UI 언어는 기기별 설정(`Prefs.lang`, localStorage)이고 부팅 때 정해지며 바꾸면 페이지를 다시 읽는다. 서버 언어는 서버 전체 설정(`settings.json` 의 `language`, 없으면 `DECK_LANG`→`LC_ALL`→`LC_MESSAGES`→`LANG`)이고 UI 에서 언어를 명시적으로 고르면 함께 바뀐다. 모델에게 가는 프롬프트는 `ko` 에 지금 문구를 글자 그대로 옮기고 `en` 번역을 새로 쓴다. 한국어가 남은 곳은 TypeScript AST 로 문자열 리터럴·JSX 텍스트만 세는 **누출 래칫 테스트**가 파일별 상한으로 막고, 화면 단위 Task 마다 상한을 0 쪽으로 내린다. 랜딩은 `npx tsx site/build.ts` 가 `site/content/{en,ko}.ts` 를 HTML 로 찍는 프레임워크 없는 생성기다.

**Tech Stack:** TypeScript(Node 24, ESM), React 19, vitest + @testing-library/react, `typescript` 컴파일러 API(이미 devDependency — 누출 검사용), `tsx`(이미 devDependency — 사이트 빌드), 헤드리스 Chrome(`scripts/render-check.sh`, 이미 있음), Cloudflare Pages(정적 호스팅, 배포는 사용자).

**Spec:** `docs/superpowers/specs/2026-10-15-quarterdeck-paid-design.md` §0(글로벌 영어 우선), §1(제품 정의·랜딩 한 줄), §3 규칙 3·4(동의 문구·마케팅 금지어), §4(티어·가격), §5.1(i18n), §5.3(릴레이 E2EE·푸시 무해화 — 랜딩 보안 절의 근거), §6(보안 요구), §7(3~4주차: i18n·랜딩·데모 영상, 7~8주차 런칭 채널), §10-3. 화면 기준은 `docs/superpowers/specs/2026-10-21-ui-overhaul-design.md` §2(측정 가능한 원칙)·§4(토큰)·§7.2(접근성).

## Global Constraints

- **선행 조건:** 리브랜드 작업(`feat/rebrand-ai-msg`, Quarterdeck→AI msg)이 master 에 병합된 뒤 시작한다. Task 1 Step 1 에서 `git status --short` 가 비어 있고, `package.json` 의 `name` 이 `ai-msg`, `bin` 키가 `ai-msg` 인지 확인한다. 아니면 멈추고 보고한다. 리브랜드가 `src/ui/App.tsx`·`src/ui/setupTexts.ts`·`src/server/setup/texts.ts`·`README*.md` 를 바꾸므로 병합 전에 시작하면 충돌한다.
- **새 의존성 금지(런타임·dev 모두).** i18n 은 자체 사전, 누출 검사는 이미 있는 `typescript`, 사이트 빌드는 이미 있는 `tsx`. `wrangler` 는 추가하지 않는다(배포는 사용자가 `npx wrangler …`).
- **기본 언어는 영어, 테스트 기본 언어는 한국어로 고정.** 지금 UI 테스트 113개 중 91개가 한국어 문구로 단언한다. `src/test/setup.ts` 가 매 테스트 전에 `setLocale('ko')` 와 `Prefs.lang = 'ko'` 를 넣어 기존 단언을 그대로 살린다. 영어 동작은 새 테스트가 `setLocale('en')` 을 명시해서 본다.
- **`ko` 문구는 지금 문구를 글자 그대로 옮긴다.** 옮기면서 다듬지 않는다(리뷰가 "옮김"만 보면 되게). 리브랜드 뒤에도 남은 `quarterdeck` 이 옮기는 문자열 안에 있으면 그 자리에서 `ai-msg`(명령)·`AI msg`(제품명)로 고친다. `en` 문구는 아래 "용어집"을 따른다.
- **한국어 문자열이 로직의 키로 쓰이는 곳은 번역 전에 id·코드로 바꾼다**("현재 결합 지점"의 ★ 행). 디스크에 남은 옛 한국어 값(총사령탑 기록의 `note`, 세션 제목 `(제목 없음)`)은 계속 알아본다.
- **사용자 입력·CLI 출력을 해석하는 한국어 정규식은 번역 대상이 아니다**(`AutoRoute.ts` 단서, `concise.ts` 리드 줄 단서, `GeminiUsagePoller.ts`). 이미 영어 패턴이 함께 있다. 정규식 리터럴은 누출 검사가 세지 않고, 문자열 리터럴로 된 해석용 값은 `ALLOW` 에 이유와 함께 적는다.
- **모델에게 가는 프롬프트:** `ko` 는 지금 문구와 바이트 단위로 같아야 한다(이 맥의 동작 무변경 — 스냅숏 테스트로 고정). `en` 은 새 번역. 어느 쪽을 쓸지는 서버 언어로 정한다.
- **마케팅 금지어**(스펙 §3 규칙 4): "unlimited", "bypass", "circumvent", "100% quota", "무제한", "한도 우회", "할당량 100%" — 사전·랜딩·README 어디에도 쓰지 않는다(테스트). Pro 의 "계정 수 제한 없음"은 "as many accounts per vendor as you own" 식으로 쓴다. 허용 표현: "runs Claude Code", "reuses the subscriptions you already pay for".
- **상표:** 랜딩·README 에 벤더 로고(Anthropic·OpenAI·Google·xAI)를 쓰지 않는다 — 앱 안의 `EngineMark` 그림은 스크린샷 속 UI 로만 보인다. "Claude Code"·"Codex" 를 제품명처럼 쓰지 않는다.
- **동의 문구는 뜻을 바꾸지 않는다:** 같은 벤더 순환 동의(`ROTATION_CONSENT`), 자동 분배 동의(`AUTO_CONSENT_TEXT`), 빠르게 동의(`FastConsentSheet`)의 영어는 한국어의 모든 조건(본인 계정만·공유/재판매/한도 회피 목적 계정 생성은 약관 위반·코드가 Google/xAI 로 갈 수 있음·사용 크레딧 과금)을 빠짐없이 담는다. Task 리뷰에서 대조한다.
- **UI 개편 기준 유지:** 색·간격·반경은 `styles.css` 토큰만, 터치 대상 44px, 글자 대비 4.5 이상(`scripts/contrast-check.mjs`), 선택지 4개 이상이면 select(`SEG_MAX = 3`). 영어가 길어 넘치면 **문구를 줄이고** 레이아웃 기준은 그대로 둔다.
- **합성 데이터만:** 렌더 픽스처·스크린샷·데모 자산에 개인 경로·계정명·실제 세션 제목·이메일을 넣지 않는다. 새 파일은 `src/hygiene.test.ts` 를 통과해야 한다.
- 실행 중인 서버를 건드리지 않는다(`npm run restart`·서버 신호·`install-launchd.sh`·`relaunch.sh` 금지). 저장소의 `dist/` 에 쓰지 않는다 — UI 빌드 확인은 `npx vite build --outDir "$(mktemp -d)"`. 테스트는 임시 HOME·임시 configDir 로만, 실제 `~/.config/deck` 에 쓰지 않는다.
- **공통 검증 명령(모든 Task 의 통과 확인 단계):**
  - `npx tsc --noEmit -p .` → 오류 0
  - `npx vitest run src/server src/shared --maxWorkers=2` → 전부 PASS
  - `npx vitest run src/ui src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=2` → 전부 PASS
  - `npx vite build --outDir "$(mktemp -d)"` → 성공
  - `node scripts/contrast-check.mjs` → 종료 코드 0
  - Task 1 이후: `npx vitest run src/i18n.leak.test.ts --maxWorkers=2` 도 함께. Task 7 이후: `npx vitest run site --maxWorkers=2` 도 함께.

## Review Focus

1. **서버가 보낸 한국어를 UI·서버가 비교한다.** `CommanderChip.tsx:46` 이 서버 `RESTART_NOTE` 를 `startsWith('재시작으로 끊김')` 로, `BottleneckWatch.ts:209` 가 턴 실패 문구를 `includes('대안 계정 없음')` 로, `AutoModel.ts:100`·`AutoRoute.ts:193,230` 이 `why === 'Fable 여유 계정 없음'` 으로 분기한다. 문구만 번역하면 영어 서버에서 조용히 깨진다(재시도 예약이 안 걸림, 칩이 엉뚱한 상태). 기대: 구조화된 코드(`noteCode`·`errorCode`·`FableBlock`)로 바꾸고 옛 한국어 기록도 알아본다. → Task 5 `codes.test.ts`.
2. **기존 테스트의 한국어 단언.** 기본 언어를 영어로 바꾸는 순간 UI 테스트 대부분이 깨진다. 기대: `src/test/setup.ts` 의 `ko` 고정으로 기존 테스트 무변경 통과, 영어는 새 테스트가 명시. → Task 1 Step 5 에서 기존 스위트 전체 PASS 확인.
3. **영어가 길어 화면이 넘친다.** 상단 세션 칩, 사용량 띠(full→mid→min 단계), 세그먼트 버튼, 사이드바 둘째 줄, 폰 390px 시트 머리. 기대: 각 화면 Task 가 생성 픽스처를 `en` 으로 1250·720·390px 렌더해 눈으로 확인하고, 폭 판단이 글자 수 상수에 기대는 곳은 `en` 기준으로 다시 잰다. → Task 2~4 Step "화면 확인".
4. **영어 사용자에게 한국어 프롬프트가 모델로 간다.** `DECK_INTRO_NOTE`(`TurnRunner.ts:216`), `CONCISE_STYLE_PROMPT`(`concise.ts:114`), 인계 메모 지시("한국어 마크다운", `handoff.ts:7`)가 대화에 들어가면 영어 사용자도 한국어 답을 받는다. 기대: 서버 언어가 `en` 이면 모델에게 가는 텍스트에 한글 0, `ko` 면 지금과 바이트 단위 동일. → Task 6 `prompts.test.ts`(누출 + 스냅숏).
5. **언어 전환이 작업을 잃는다.** 전환은 페이지 다시 읽기다. 기대: 입력 초안(`drafts.ts`)·분할 배치(`persist.ts`)는 이미 저장되므로 그대로 돌아오고, 진행 중 턴은 서버 쪽이라 영향 없음. 전환 직전에 초안 저장을 한 번 더 부른다. → Task 1 `SettingsView` 테스트.
6. **기기마다 언어가 다를 때 서버 문구.** 서버 언어는 하나다. 기대: 마지막으로 **명시적으로** 고른 언어를 따르고('자동'은 서버를 바꾸지 않음), 이 규칙을 설정 화면 한 줄과 문서에 적는다. → Task 1, D3.
7. **랜딩의 주장이 실제 기능보다 앞선다.** Pro 기능(릴레이 E2EE·병목 알림·한 번 눌러 인계)과 7일 체험은 계획 ④ 가 만든다. 기대: 랜딩 문구마다 근거(코드·테스트·계획 ④ Task)를 `site/content/claims.ts` 에 적고, `--release` 빌드는 결제 링크·사이트 주소가 없으면 실패한다. 출시 전 주장표 대조는 사용자 몫. → Task 7.
8. **설치 한 줄이 틀린 채 나간다.** `ai-msg` 는 2026-10-22 npm 에 없지만 `aimsg`(1.0.1, AI 커밋 메시지 도구, bin `aimsg`, 2026-03-30 갱신)가 있어 npm 의 "구두점만 다른 이름" 규칙으로 publish 가 거부될 수 있다. 기대: 설치 명령은 `site/content/install.ts` 의 `INSTALL_COMMAND` 한 곳과 README 의 같은 문자열뿐이고, 이름이 바뀌면 그 두 곳만 고친다. → D13, 사용자 몫.

---

## 현재 결합 지점 (master 기준 2026-10-22, 리브랜드 병합 뒤 줄 번호가 조금 밀릴 수 있음)

★ = 한국어 문자열이 로직의 키 — 번역 전에 id·코드로 바꾼다.

| 위치 | 결합 | 처리 |
|---|---|---|
| `src/ui/index.html:2` | `<html lang="ko">` 고정 | Task 1: `lang="en"`, 부팅 때 `initUiLocale` 이 실제 언어로 덮음 |
| `src/ui/prefs.ts:8`, `:14-20` | `Prefs` 에 언어 없음, `ALLOWED` 표 | Task 1: `lang: LangPref`(기본 `'auto'`) 추가 |
| `src/test/setup.ts` | 매 테스트 전 prefs 를 localStorage 에 넣음(`conciseMode: false`) | Task 1: `lang: 'ko'` + `setLocale('ko')` |
| `src/ui/setupTexts.ts`, `src/server/setup/texts.ts` | 계획 ② 가 "plan ③ 용"으로 한 파일에 모아 둔 마법사·CLI·doctor·서비스 문구 | Task 1: 사전으로 옮기는 첫 예. 두 파일은 사전을 다시 내보내는 얇은 모듈로 |
| `src/ui/dateGroups.ts:2` ★ | `DATE_GROUPS = ['오늘', …]` 가 타입이자 표시 문구 | Task 2: id(`today`·`yesterday`·`week`·`month`·`older`) + 사전 라벨 |
| `src/ui/components/SettingsView.tsx:62` ★ | `SETTINGS_GROUPS` 의 두 번째 값이 화면 문구이자 머리글 | Task 2: id 만 남기고 라벨은 사전 |
| `src/ui/components/SidePanel.tsx:215-222` ★ | 탭 선택을 `active === '변경 사항'`·`'원문'`·`'보기'`·`'미리보기'` 로 분기 | Task 4: 탭 id |
| `src/ui/components/usageSeats.tsx:515`, `UsageStrip.tsx:101` ★ | `text = '가능'` 을 만들고 `st.text === '가능'` 으로 비교 | Task 4: `kind === 'ok'` 로 비교 |
| `src/ui/components/CommanderChip.tsx:35-56` ★ | `commanderPhase` 가 한국어를 돌려주고 `phase === '진행 중'` 비교 | Task 4: phase id + 사전 라벨 |
| `src/ui/components/CommanderChip.tsx:46` ★, `src/server/commander/Commander.ts:26` | 서버 `RESTART_NOTE` 를 UI 가 `startsWith` 로 판별. note 는 디스크 기록에도 남음 | Task 5: `noteCode: 'restart' \| 'disabled'` 추가, UI 는 코드 우선 + 옛 한국어 접두 호환 |
| `src/server/push/BottleneckWatch.ts:209` ★, `src/server/turn/TurnRunner.ts:2207` | 재시도 예약을 실패 문구의 `'대안 계정 없음'` 포함 여부로 판단 | Task 5: `turn_result.errorCode`(`'no_alternative_account'` 등) |
| `src/server/routing/AccountRouter.ts:108-109` ★, `AutoModel.ts:100`, `AutoRoute.ts:193,230` | Fable 차단 이유를 문자열로 돌려주고 같은 문자열과 비교 | Task 5: `FableBlock = 'exhausted' \| 'unknown'` 코드 → 표시할 때 문구 |
| `src/server/turn/TurnRunner.ts:321`, `:1512`, `:1525`, `src/server/ws.ts:1320` ★ | 제목 없음을 `'(제목 없음)'` 문자열로 만들고 비교 | Task 5: `isUntitled(t)`(빈 문자열 + 옛 `'(제목 없음)'`), 표시는 사전 |
| `src/server/main.ts:11` ★ | 시작 실패를 `line.startsWith('deck: 시작 실패')` 로 판별 | Task 5: `StartFailure` 표식(오류 클래스)로 |
| `src/server/usage/GeminiUsagePoller.ts:122-127` | agy `/usage` 출력의 한국어(`소진`·`남음`·`사용`·`리셋`) 해석 | 유지 — 정규식 + `kind === '사용'` 은 `ALLOW` |
| `src/server/routing/AutoRoute.ts:36-62`, `src/shared/concise.ts:43-46` | 사용자 첫 메시지 분류 단서(한국어 + 영어 정규식) | 유지(정규식이라 누출 검사 대상 아님). 리드 줄 표시 문구(`'원인부터 찾을게요'`)만 Task 3 |
| `src/server/turn/TurnRunner.ts:216` `DECK_INTRO_NOTE`, `src/shared/concise.ts:114` `CONCISE_STYLE_PROMPT`, `src/shared/handoff.ts:7-15`, `src/server/engine/claudeCli/texts.ts:6-12`, `src/server/commander/Judge.ts` | 모델에게 가는 한국어 지시 | Task 6: `src/server/prompts/{en,ko}.ts` |
| `src/server/push/PushNotifier.ts:44-58` | 푸시 본문 `완료`·`실패`·`권한 요청`·`질문` | Task 5: 서버 언어 |
| `src/shared/protocol.ts:165` `DeckSettings`, `:121` `set_settings`, `:270` hello `settings`, `:317` `turn_notice.message` | 서버 설정·알림 문구는 문자열 그대로 전송 | Task 1: `language` 설정 추가. 알림은 서버가 현지화한 문자열을 그대로 보냄(D4) |
| `src/server/settings.ts:14` | `DEFAULT_SETTINGS: Required<DeckSettings>` | Task 1: `language: null`(= 환경 변수에서) |
| `src/ui/public/sw.js:8-10` | 오프라인 페이지가 한국어 고정 | Task 4: `self.navigator.languages` 로 en/ko |
| `src/ui/public/manifest.webmanifest` | `description: "Claude · GPT 세션 셸"` | Task 4: 영어 한 줄(매니페스트는 하나뿐이라 영어) |
| `src/ui/components/UsageView.tsx:237` | `toLocaleString('ko-KR')` 고정 | Task 4: `intlTag(getLocale())` |
| `scripts/render/*.html`(11개) | 손으로 뽑은 정적 한국어 마크업(`sidebar-clean.html` 머리 주석: renderToStaticMarkup 결과를 붙여 넣음) | 유지. 새 생성 픽스처 `scripts/render/gen/*.{en,ko}.html` 을 Task 2~4 에서 만들고 Task 7 이 랜딩 스크린샷에 재사용 |
| `vitest.config.ts:9`, `tsconfig.json` `include` | 테스트·타입 검사가 `src`(+`tests`)만 | Task 7: `site` 추가 |
| `.gitignore` `dist/` | 어느 깊이의 `dist` 든 무시 | `site/dist` 도 자동으로 무시됨 — 손대지 않음 |
| `scripts/contrast-check.mjs` | `src/ui/styles.css` 토큰만 검사 | Task 7: `site/styles.css` 블록 추가 |
| `README.md`(329줄), `README.ko.md` | 리브랜드 뒤에도: "Claude Agent SDK 로 구동"(계획 ① 이후 틀림), `git clone` 빠른 시작, 이 맥 전용 `install-launchd.sh` 서비스 절, 한국어 UI 라벨(자동·자동 분배·모두 자동 승인), Grok "No usage card"(지금은 있음), 스크린샷 자리 주석 | Task 8: 영어 우선으로 다시 쓰고 저장소 실행은 `CONTRIBUTING.md` 로 |
| `.gitattributes` export-ignore, `scripts/export-public.sh:38` | `docs/superpowers`·`docs/HANDOFF.md` 는 공개본 제외 | `site/`·`docs/install*.md` 는 공개본에 들어감(의도). 개인 정보 없음을 위생 검사로 |

## 용어집 (en 사전·랜딩·README 공통, D6)

| 한국어(지금 UI) | English | 비고 |
|---|---|---|
| 자동 (엔진·모델) | Auto | |
| 자동 분배 | Auto routing | |
| 총사령탑 / 사령탑 | Commander | |
| ↯ 빠르게 · 사용 크레딧 | ↯ Fast · usage credits | |
| 간결 모드 | Concise mode | |
| 새 세션으로 이어가기 / 인계 | Continue in a new session / Handoff | |
| 계정 / 좌석 | account | UI 는 account, 코드 식별자 `Seat` 는 유지 |
| 갈라짐 | Diverged | |
| 승인 · 권한 요청 | Approval · Permission request | |
| 모두 자동 승인 / 편집 자동 승인 / 계획 모드 | Auto-approve all / Auto-approve edits / Plan mode | |
| 사용량 띠 · 남음 · 리셋 | usage bar · left · resets | "N% left" — 공식 앱과 같은 방향 |
| 활동 / 하이라이트 | Activity / Highlights | |
| 설치 점검 | Setup check | |
| 배치 | Layouts | |
| 백그라운드 작업 | Background tasks | |
| 쿨다운 | cooldown | |
| 재시작 대기 / 지금 재시작 | Restart pending / Restart now | |
| 대기열에 추가 / 작업으로 | Queue / Run as task | |
| 고정 | Pinned | |

## File Structure

새 파일:

| 파일 | 책임 |
|---|---|
| `src/shared/locale.ts` | `LOCALES`, `Locale`, `LangPref`, `isLocale`, `localeFromLanguages`, `localeFromEnv`, `setLocale`/`getLocale`, `pick`, `intlTag`, `Widen` |
| `src/shared/messages/en.ts`, `src/shared/messages/ko.ts`, `src/shared/messages/index.ts` | UI·서버 공용 문구(`concise` 리드 줄, 모델·권한 모드 라벨, 계정 라벨) + `shared()` |
| `src/ui/i18n/index.ts` | `ui()`, `initUiLocale`, `formatDateTime`, `formatNumber` |
| `src/ui/i18n/en/*.ts`, `src/ui/i18n/ko/*.ts` | 화면별 UI 문구(`common`·`setup`·`login`·`settings`·`app`·`sidebar`·`time`·`session`·`dialogs`·`palette`·`shortcuts`·`toasts`·`notify`·`layouts`·`folder`·`newChat`·`share`·`chat`·`composer`·`message`·`permission`·`question`·`tools`·`turn`·`tasks`·`find`·`image`·`diff`·`fast`·`picker`·`upload`·`usage`·`activity`·`highlights`·`commander`·`sidePanel`·`files`·`memory`·`roles`) + 각 폴더의 `index.ts`(합본) |
| `src/server/i18n/index.ts`, `src/server/i18n/{en,ko}/*.ts` | 서버 문구(`setup`·`cli`·`service`·`http`·`notices`·`errors`·`routing`·`commander`·`engines`·`sessions`·`usage`·`files`·`push`) + `sm()`, `resolveServerLocale` |
| `src/server/prompts/en.ts`, `src/server/prompts/ko.ts`, `src/server/prompts/index.ts` | 모델에게 가는 지시문 + `prompts()` |
| `src/i18nScan.ts` | `hangulLiterals(file, text)` — AST 의 문자열 리터럴·템플릿 조각·JSX 텍스트 중 한글을 담은 것 |
| `src/i18n.leak.test.ts` | 누출 래칫(`BASELINE`·`ALLOW`), en 사전 한글 0, 금지어 |
| `src/ui/i18n/parity.test.ts`, `src/server/i18n/parity.test.ts`, `src/shared/locale.test.ts` | 사전 모양 일치, 감지 규칙 |
| `src/ui/i18n.render.test.tsx` | `en` 으로 App 을 그려 화면 텍스트·속성에 한글 0 |
| `src/ui/fixtures.gen.test.tsx` | `DECK_GEN_FIXTURES=1` 일 때만 도는 픽스처 생성기 → `scripts/render/gen/<이름>.<언어>.html` |
| `src/server/i18n/codes.test.ts` | ★ 코드화 회귀 |
| `src/server/prompts/prompts.test.ts`, `src/server/prompts/__snapshots__/prompts.test.ts.snap` | 프롬프트 누출·`ko` 스냅숏 |
| `scripts/render/gen/*.html` | 생성 픽스처(커밋) |
| `site/build.ts` | 사이트 빌드(`--release`, `--out`) |
| `site/render.ts` | `renderPage`, `escapeHtml`, 섹션 렌더러 |
| `site/content/types.ts`, `site/content/en.ts`, `site/content/ko.ts` | 랜딩 문구 |
| `site/content/install.ts` | `INSTALL_COMMAND`, `GLOBAL_INSTALL_COMMAND` |
| `site/content/pricing.ts` | `PRICING`(Free/Pro 숫자), 결제 링크 읽기 |
| `site/content/claims.ts` | 랜딩 주장 → 근거 표 |
| `site/styles.css` | 랜딩 스타일(앱 토큰 값 재사용) |
| `site/static/_headers`, `site/static/robots.txt` | Cloudflare Pages 헤더(CSP)·크롤러 |
| `site/assets/shots/{en,ko}/*.png`, `site/assets/og.{en,ko}.png`, `site/assets/icon.png` | 스크린샷·OG 이미지·아이콘 |
| `site/demo/shotlist.md` | 데모 영상 촬영 대본(영어)·데모 프로필 준비 |
| `site/site.test.ts` | 사이트 빌드 결과 검사 |
| `docs/install.md`, `docs/install.ko.md` | 설치 문서 |

수정: `src/ui/index.html`, `src/ui/main.tsx`, `src/ui/prefs.ts`, `src/test/setup.ts`, `src/shared/protocol.ts`, `src/server/settings.ts`, `src/server/ws.ts`, `src/server/server.ts`, `src/server/cli/app.ts`, `src/ui/setupTexts.ts`, `src/server/setup/texts.ts`, `src/ui/**`(Task 2~4 의 파일 목록), `src/server/**`·`src/shared/**`(Task 5~6 의 파일 목록), `src/ui/public/sw.js`, `src/ui/public/manifest.webmanifest`, `vitest.config.ts`, `tsconfig.json`, `scripts/contrast-check.mjs`, `package.json`(Task 8, D15 일 때만 `private` 제거·`description`), `src/server/packaging.test.ts`(같은 조건), `README.md`, `README.ko.md`, `CONTRIBUTING.md`.

---

### Task 1: 언어 기반 — 현재 언어·감지·사전 골격·언어 선택·테스트 고정·누출 래칫

**Files:**
- Create: `src/shared/locale.ts`, `src/shared/messages/{en,ko,index}.ts`, `src/ui/i18n/index.ts`, `src/ui/i18n/{en,ko}/{index,common,setup,login,settings}.ts`, `src/server/i18n/index.ts`, `src/server/i18n/{en,ko}/{index,setup}.ts`, `src/i18nScan.ts`
- Modify: `src/ui/index.html:2`, `src/ui/main.tsx`(렌더 전 `initUiLocale`), `src/ui/prefs.ts`, `src/ui/components/SettingsView.tsx`(화면 묶음 첫 줄에 언어), `src/ui/setupTexts.ts`·`src/ui/components/SetupWizard.tsx`·`src/ui/components/Login.tsx`(사전으로), `src/server/setup/texts.ts`·`src/server/cli/app.ts`·`src/server/cli/doctor.ts`(사전으로, CLI 시작 때 `setLocale(localeFromEnv(process.env))`), `src/shared/protocol.ts:121,165`, `src/server/settings.ts`, `src/server/ws.ts`(`set_settings` 의 `language`), `src/server/server.ts`(설정 로드 뒤 `setLocale`), `src/test/setup.ts`
- Test: `src/shared/locale.test.ts`, `src/ui/i18n/parity.test.ts`, `src/server/i18n/parity.test.ts`, `src/i18n.leak.test.ts`, `src/ui/prefs.test.ts`(추가), `src/ui/components/SettingsView.test.tsx`(추가), `src/server/settings.test.ts`(추가), `src/server/cli/app.test.ts`(추가)

**Interfaces:**
- Produces (`src/shared/locale.ts`):
  - `LOCALES = ['en', 'ko'] as const`, `type Locale`, `type LangPref = 'auto' | Locale`, `isLocale(v: unknown): v is Locale`.
  - `localeFromLanguages(langs: readonly string[]): Locale` — 목록을 앞에서부터 보며 주 하위 태그(`ko-KR` → `ko`, 대소문자 무시)가 `LOCALES` 에 있는 첫 항목. 없으면 `'en'`.
  - `localeFromEnv(env: Record<string, string | undefined>): Locale` — `DECK_LANG`(`en`|`ko` 만, 그 밖의 값은 무시) → `LC_ALL` → `LC_MESSAGES` → `LANG` 순으로 비지 않고 `C`·`POSIX` 가 아닌 첫 값의 앞 두 글자(`ko_KR.UTF-8` → `ko`). 없거나 모르는 언어면 `'en'`. 이 맥은 `relaunch.sh` 가 `LANG=ko_KR.UTF-8` 을 넣으므로 계속 `ko`.
  - `setLocale(l: Locale): void`, `getLocale(): Locale`(초기값 `'en'`), `pick<T>(byLocale: Record<Locale, T>): T`, `intlTag(l: Locale): 'en-US' | 'ko-KR'`.
  - `type Widen<T>` — 문자열 리터럴은 `string`, `(...a: A) => string` 은 그대로, 객체는 재귀. `ko` 사전은 `const ko: Widen<typeof en> = { … }` 로 선언해 키 누락·초과를 `tsc` 가 잡는다.
- Produces (UI):
  - `ui(): UiMessages`(= `pick({ en, ko })`), `type UiMessages = Widen<typeof en>`.
  - `initUiLocale(pref: LangPref, languages: readonly string[] = navigator.languages, root: HTMLElement = document.documentElement): Locale` — `pref === 'auto'` 면 `localeFromLanguages`, 아니면 그대로. `setLocale` + `root.lang` 설정 후 반환.
  - `formatDateTime(ms: number, o?: Intl.DateTimeFormatOptions): string`, `formatNumber(n: number): string` — `intlTag(getLocale())`.
  - `Prefs.lang: LangPref`, `DEFAULT_PREFS.lang = 'auto'`, `ALLOWED.lang = ['auto', 'en', 'ko']`.
  - `SettingsView` 화면 묶음 맨 위 행 "Language / 언어": 세그먼트 `Auto` · `English` · `한국어`(언어 이름은 늘 그 언어로 — 사전 밖 상수 `LANGUAGE_NAMES`, `ALLOW` 대상). 아래 한 줄 설명: "Notifications and server messages use the language you last picked on any device." 고르면 ① 초안 저장(`drafts` 의 저장 함수) ② `savePrefs` ③ `'auto'` 가 아니면 `send({ type: 'set_settings', language })` ④ 실제 언어가 바뀌면 `reload()`(prop 주입, 기본 `() => location.reload()`).
  - `setupTexts.ts` 는 `export const setupTexts = () => ui().setup` 등 사전을 다시 내보내는 모듈로. `ENGINE_NAME` 은 고유명사라 사전 밖 상수로 남긴다.
- Produces (서버):
  - `DeckSettings.language?: Locale | null`(없음·null = 환경 변수에서), `set_settings` 의 `language: z.enum(LOCALES).optional()`, `DEFAULT_SETTINGS.language = null`, `SettingsStore` 가 파일의 `language` 를 `isLocale` 로 검증해 읽고 쓴다.
  - `resolveServerLocale(settings: Pick<DeckSettings, 'language'>, env: Record<string, string | undefined>): Locale` — `settings.language ?? localeFromEnv(env)`. `server.ts` 가 설정 로드 직후, `ws.ts` 가 `set_settings` 처리 뒤 `setLocale(resolveServerLocale(…))`.
  - `sm(): ServerMessages`. `setup/texts.ts` 의 `TEXTS` 는 `export const texts = () => sm().setup` 로 바뀌고 호출처는 `texts().portInUse(…)`. `loginCommandFor` 는 명령 문자열이라 그대로, `loginHint` 는 사전으로.
  - `runCli` 맨 앞에서 `setLocale(localeFromEnv(process.env))` — `--help`·`doctor`·`service` 출력이 터미널 언어를 따른다. `start` 는 서버가 설정을 읽은 뒤 다시 정한다.
- Produces (누출 검사, `src/i18nScan.ts`):
  - `HANGUL = /[ㄱ-ㆎ가-힣]/`
  - `hangulLiterals(file: string, text: string): { line: number; text: string }[]` — `ts.createSourceFile(file, text, ES2023, true, file.endsWith('x') ? TSX : TS)` 를 돌며 `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TemplateHead`/`TemplateMiddle`/`TemplateTail`, `JsxText` 중 `HANGUL` 을 담은 것. 주석·정규식 리터럴은 대상 아님.
  - `scanTargets(root: string): string[]` — `git ls-files 'src/*.ts' 'src/*.tsx'`(git 이 없으면 걷기)에서 `*.test.*`, `src/test/**`, 한국어 사전(`/(^|\/)(i18n|messages|prompts)\/(ko\/|ko\.ts$)/`)을 뺀 것.
- `src/i18n.leak.test.ts`: `ALLOW: Record<string, string>`(키 = `"<파일>::<문자열>"`, 값 = 이유), `BASELINE: Record<string, number>`(파일 → 허용 개수). 처음 값은 Step 4 에서 실제 스캔으로 채운다.

- [ ] **Step 1: 선행 조건 확인** — `git status --short` 비어 있음, `node -e "const p=require('./package.json');process.exit(p.name==='ai-msg'&&p.bin&&p.bin['ai-msg']?0:1)"` 종료 코드 0. 아니면 멈추고 보고.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/shared/locale.test.ts
it('browser languages: first supported primary tag wins, else en', () => {
  expect(localeFromLanguages(['ko-KR', 'en-US'])).toBe('ko');
  expect(localeFromLanguages(['en-GB', 'ko'])).toBe('en');
  expect(localeFromLanguages(['fr-FR', 'KO'])).toBe('ko');
  expect(localeFromLanguages([])).toBe('en');
});
it('env: DECK_LANG > LC_ALL > LC_MESSAGES > LANG, C/POSIX skipped, unknown → en', () => {
  expect(localeFromEnv({ LANG: 'ko_KR.UTF-8' })).toBe('ko');
  expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', LC_ALL: 'C' })).toBe('ko');
  expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', DECK_LANG: 'en' })).toBe('en');
  expect(localeFromEnv({ DECK_LANG: 'fr', LANG: 'de_DE.UTF-8' })).toBe('en');
  expect(localeFromEnv({})).toBe('en');
});

// src/ui/i18n/parity.test.ts (서버 쪽도 같은 모양)
const shape = (o: unknown): unknown => typeof o === 'function' ? `fn/${(o as Function).length}` : typeof o === 'string' ? 'str' : Object.fromEntries(Object.entries(o as object).sort().map(([k, v]) => [k, shape(v)]));
it('ko has exactly the keys and function arities of en', () => expect(shape(ko)).toEqual(shape(en)));
it('no empty strings in either locale', () => { /* 모든 잎 문자열 length > 0 */ });

// src/ui/prefs.test.ts
it('lang defaults to auto and rejects unknown values', () => {
  expect(parsePrefs(null).lang).toBe('auto');
  expect(parsePrefs('{"lang":"fr"}').lang).toBe('auto');
  expect(parsePrefs('{"lang":"ko"}').lang).toBe('ko');
});
it('initUiLocale: auto follows the browser and sets <html lang>', () => {
  const root = document.createElement('html');
  expect(initUiLocale('auto', ['ko-KR'], root)).toBe('ko');
  expect(root.lang).toBe('ko');
  expect(initUiLocale('en', ['ko-KR'], root)).toBe('en');
});

// SettingsView.test.tsx
it('picking English saves the pref, tells the server, and reloads', async () => { /* send 에 { type:'set_settings', language:'en' }, reload 1회 */ });
it('picking Auto does not change the server language', async () => { /* send 에 language 없음 */ });
it('the language row is a 3-way segment (SEG_MAX)', () => { /* 버튼 3개 */ });

// settings.test.ts
it('language: null by default, persisted when set, invalid value ignored', async () => { /* … */ });
it('resolveServerLocale: explicit setting wins over env', () => {
  expect(resolveServerLocale({ language: null }, { LANG: 'ko_KR.UTF-8' })).toBe('ko');
  expect(resolveServerLocale({ language: 'en' }, { LANG: 'ko_KR.UTF-8' })).toBe('en');
});

// cli/app.test.ts
it('--help follows the terminal language', async () => { /* env LANG=en_US.UTF-8 → 'Usage: ai-msg', LANG=ko_KR.UTF-8 → '사용법: ai-msg' */ });

// src/i18n.leak.test.ts
it('no file has more Hangul literals than its baseline, and no new file has any', () => { /* scanTargets → hangulLiterals − ALLOW → 파일별 개수 ≤ BASELINE[file] ?? 0 */ });
it('the baseline is tight (lower it when you translate)', () => { /* 개수 === BASELINE[file] — 줄였으면 BASELINE 도 줄여야 통과 */ });
it('every ALLOW entry still matches a literal', () => { /* 낡은 허용 항목 제거 강제 */ });
it('en dictionaries carry no Hangul and no banned marketing words', () => {
  const BANNED = /\bunlimited\b|\bbypass|\bcircumvent|100%\s*quota|무제한|한도\s*우회|할당량\s*100%/i;
  /* src/ui/i18n/en, src/server/i18n/en, src/shared/messages/en.ts 의 모든 잎(함수는 샘플 인자로 호출) */
});
it.skipIf(!process.env.DECK_I18N_BASELINE)('prints the current counts', () => { console.log(JSON.stringify(counts, null, 2)); });
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/shared/locale.test.ts src/ui/i18n src/server/i18n src/i18n.leak.test.ts src/ui/prefs.test.ts src/ui/components/SettingsView.test.tsx src/server/settings.test.ts src/server/cli/app.test.ts --maxWorkers=2` → 모듈 없음으로 FAIL.
- [ ] **Step 4: 구현** — 위 Interfaces. `setupTexts.ts`·`setup/texts.ts` 의 문구를 `ko` 사전에 글자 그대로 옮기고 `en` 을 쓴다(CLI 도움말 첫 줄 `Usage: ai-msg [command] [options]`). `src/test/setup.ts` 에 `setLocale('ko')` 와 prefs `lang: 'ko'`. `index.html` 은 `lang="en"`. 그다음 `DECK_I18N_BASELINE=1 npx vitest run src/i18n.leak.test.ts -t 'prints'` 출력으로 `BASELINE` 을 채우고, 해석용 문자열(`GeminiUsagePoller` 의 `'사용'` 등, `LANGUAGE_NAMES.ko`)을 `ALLOW` 에 이유와 함께 넣는다.
- [ ] **Step 5: 통과 확인** — Step 3 명령 PASS. 이어서 공통 검증 명령 전부 — **기존 UI·서버 테스트가 한 줄도 고치지 않고 통과**해야 한다(Review Focus 2).
- [ ] **Step 6: 커밋** — `git commit -m "feat(i18n): 언어 기반 — 감지·기기별 언어·서버 언어 설정, 자체 사전, 마법사·CLI 문구 이전, 누출 래칫"`

---

### Task 2: UI 화면 A — 골격·사이드바·세션 머리·설정·대화상자 + 픽스처 생성기

**Files:**
- Create: `src/ui/i18n/{en,ko}/{app,sidebar,time,session,dialogs,palette,shortcuts,toasts,notify,layouts,folder,newChat,share}.ts`, `src/ui/fixtures.gen.test.tsx`, `scripts/render/gen/{sidebar,settings,new-chat}.{en,ko}.html`(생성물)
- Modify: `src/ui/App.tsx`, `src/ui/dateGroups.ts`(id 화), `src/ui/tabTitle.ts`(`APP_TITLE` 은 제품명이라 그대로 — 다른 문구가 있으면 사전), `src/ui/components/Sidebar.tsx`, `SessionChip.tsx`, `SessionChipHead.tsx`, `SessionMenu.tsx`, `ForkMenu.tsx`, `SettingsView.tsx`(`SETTINGS_GROUPS` id 화, 동의 문구 `AUTO_CONSENT_TEXT`·`ROTATION_CONSENT` 포함 전부), `Dialogs.tsx`, `CommandPalette.tsx`, `src/ui/shortcuts.ts`, `Toasts.tsx`, `NotifyMenu.tsx`, `LayoutsDialog.tsx`, `src/ui/layouts.ts`, `FolderPicker.tsx`, `NewChat.tsx`, `SessionCwdDialog.tsx`, `OpenInDesktop.tsx`, `ShareMenu.tsx`, `src/i18n.leak.test.ts`(`BASELINE` 에서 이 파일들 제거)
- Test: 각 컴포넌트의 기존 테스트(ko 고정으로 무변경 통과) + `src/ui/components/Sidebar.test.tsx`·`SettingsView.test.tsx`·`NewChat.test.tsx`·`src/ui/dateGroups.test.ts` 에 영어 테스트 추가

**Interfaces:**
- Produces: `DATE_GROUP_IDS = ['today', 'yesterday', 'week', 'month', 'older'] as const`, `type DateGroup = (typeof DATE_GROUP_IDS)[number]`, `groupByDate` 는 `{ id: DateGroup; label: string; items }[]`(라벨은 `ui().time.group[id]`). `SETTINGS_GROUPS = ['screen', 'input', 'perm', 'account'] as const`, 라벨은 `ui().settings.groups[id]`.
- Produces (`fixtures.gen.test.tsx`): `it.skipIf(!process.env.DECK_GEN_FIXTURES)` 묶음. 각 픽스처마다 `setLocale(locale)` → 컴포넌트를 기존 테스트와 같은 방식의 합성 props 로 `renderToStaticMarkup` → `fixtureHtml({ name, locale, body, width })` 로 감싸 `scripts/render/gen/<name>.<locale>.html` 에 쓴다. `fixtureHtml` 은 기존 픽스처 틀을 따른다: `<link rel="stylesheet" href="../../../src/ui/styles.css">`, 전환 끄기, `?light`·`?phone` 쿼리로 테마·폭, 최상위 창이면 다크 데스크톱·라이트 폰 iframe 두 칸. 합성 데이터: 프로젝트 `acme-web`·`billing-api`·`docs-site`, 세션 제목 "Fix flaky checkout test" 류, 계정 라벨 `Work`·`Personal` — 실제 이름·경로 금지.
- Consumes: Task 1 의 `ui()`, `formatDateTime`.

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
it('date groups render in English', () => {
  setLocale('en');
  expect(groupByDate([{ lastModified: now }, { lastModified: now - 86_400_000 }], now).map((g) => g.label)).toEqual(['Today', 'Yesterday']);
});
it('sidebar in English: no Hangul in text or labels', () => {
  setLocale('en');
  const { container } = render(<Sidebar {...sampleSidebarProps()} />);
  expect(hangulIn(container)).toEqual([]);   // textContent + title/aria-label/placeholder/alt
});
it('settings in English: group nav and consent texts', () => { /* nav 버튼 'Screen'·'Input'·'Permissions & alerts'·'Accounts', 순환 동의에 'own'·'resell'·'terms' 포함 */ });
```

  `hangulIn(el)` 은 `src/test/hangul.ts`(테스트 도우미, 이 Task 에서 생성)로 두고 Task 3·4·7 이 재사용한다.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/ui/dateGroups.test.ts src/ui/components/Sidebar.test.tsx src/ui/components/SettingsView.test.tsx src/ui/components/NewChat.test.tsx --maxWorkers=2` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — 파일 목록의 문구를 사전으로 옮긴다. 순서: ★ id 화(`dateGroups`, `SETTINGS_GROUPS`) → 문구 이전. 날짜·시각은 `formatDateTime`, 숫자는 `formatNumber`. 단축키 표기(⌘·⌃)는 기호라 그대로. `BASELINE` 에서 이 Task 의 파일을 지운다(남은 한글이 있으면 테스트가 알려 줌).
- [ ] **Step 4: 통과 확인** — Step 2 명령 PASS, 공통 검증 명령 전부 PASS.
- [ ] **Step 5: 화면 확인** — `DECK_GEN_FIXTURES=1 npx vitest run src/ui/fixtures.gen.test.tsx --maxWorkers=2` → `RENDER_HEIGHT=1100 RENDER_OUT=/tmp/aimsg-render scripts/render-check.sh gen/sidebar.en 1250 390`(settings·new-chat 도). 영어에서 사이드바 둘째 줄·설정 세그먼트·시트 머리(390px)가 넘치거나 두 줄로 깨지면 `en` 문구를 줄인다. `ko` 픽스처는 기존 정적 픽스처와 눈으로 비교해 회귀가 없는지 본다.
- [ ] **Step 6: 커밋** — `feat(i18n): UI 골격·사이드바·세션 머리·설정·대화상자 영어, 날짜 묶음·설정 묶음 id 화, 픽스처 생성기`

---

### Task 3: UI 화면 B — 대화·입력창·승인·도구 표시·공용 라벨

**Files:**
- Create: `src/ui/i18n/{en,ko}/{chat,composer,message,permission,question,tools,turn,tasks,find,image,diff,fast,picker,upload}.ts`, `scripts/render/gen/{chat,composer,permission}.{en,ko}.html`
- Modify: `src/ui/components/Chat.tsx`, `Pane.tsx`, `MessageView.tsx`, `Composer.tsx`, `ComposerSuggest.tsx`, `AttachmentBar.tsx`, `PermissionCard.tsx`, `QuestionCard.tsx`, `QueueChips.tsx`, `ToolCallView.tsx`, `TurnBadge.tsx`, `TaskCards.tsx`, `TodoPanel.tsx`, `FindBar.tsx`, `ImageEditor.tsx`, `Lightbox.tsx`, `DiffView.tsx`, `CopyButton.tsx`, `DictationButton.tsx`, `FastConsentSheet.tsx`, `ModelPicker.tsx`, `AccountPicker.tsx`, `src/ui/toolLabel.ts`, `todos.ts`, `imageEdit.ts`, `diff.ts`, `context.ts`, `upload.ts`, `injected.ts`, `sessionApi.ts`, `state.ts`, `catchup.ts`, `exportMarkdown.ts`, `replyTurn.ts`, `autocomplete.ts`, `clipboard.ts`; 공용: `src/shared/concise.ts`(표시 문구만 — 리드 줄 `'원인부터 찾을게요'` 등, `CONCISE_ENGINE_LABEL`, `'모델'`), `src/shared/models.ts`, `src/shared/permission.ts`, `src/shared/choices.ts`, `src/shared/messages/{en,ko}.ts`, `src/i18n.leak.test.ts`, `src/ui/fixtures.gen.test.tsx`(픽스처 3개 추가)
- Test: 기존 테스트 무변경 통과 + `MessageView.test.tsx`·`PermissionCard.test.tsx`·`Chat.test.tsx`·`src/shared/concise.test.ts`·`src/ui/toolLabel.test.ts`(있으면 추가, 없으면 생성)에 영어 테스트

**Interfaces:**
- Produces: `shared(): SharedMessages`(`src/shared/messages/index.ts`). `concise.ts` 의 리드 줄 표는 `[RegExp, keyof SharedMessages['concise']['lead']][]` 로 바뀐다 — 정규식(입력 분류)은 그대로, 표시 문구만 키로.
- `exportMarkdown` 의 머리글(사용자·모델 이름 줄)은 내보내는 순간의 UI 언어를 따른다.
- `state.ts` 리듀서가 만드는 문구는 `ui()` 를 리듀서 안에서 부른다(언어는 부팅 때 고정이라 리듀서 순수성에 영향 없음 — D2).

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
it('permission card in English: tool, Allow / Deny, always-allow wording', () => {
  setLocale('en');
  render(<PermissionCard {...samplePermission()} />);
  expect(screen.getByRole('button', { name: /^Allow/ })).toBeTruthy();
  expect(hangulIn(document.body)).toEqual([]);
});
it('concise lead line in English for a bug report', () => {
  setLocale('en');
  expect(conciseLead({ text: 'why does the build fail', engine: 'claude' })).toBe(shared().concise.lead.rootCause);
});
it('fast consent sheet keeps every condition in English', () => { /* 'usage credits', 'subscription', 기본 포커스 Cancel */ });
it('tool labels in English', () => { setLocale('en'); expect(toolLabel({ name: 'Bash', input: { command: 'ls' } })).not.toMatch(HANGUL); });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/ui/components/MessageView.test.tsx src/ui/components/PermissionCard.test.tsx src/ui/components/Chat.test.tsx src/shared/concise.test.ts src/ui/toolLabel.test.ts --maxWorkers=2` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — 위 파일들. `concise.ts` 는 정규식 배열을 건드리지 않는다(해석 규칙 무변경). `BASELINE` 에서 이 Task 파일 제거.
- [ ] **Step 4: 통과 확인** — Step 2 명령 PASS, 공통 검증 명령 전부 PASS.
- [ ] **Step 5: 화면 확인** — 생성기로 `chat`·`composer`·`permission` 을 만들고 `RENDER_HEIGHT=1400 scripts/render-check.sh gen/chat.en 1250 720 390`. 입력창의 둥근 버튼 줄(대기열에 추가 / 작업으로 → Queue / Run as task), 턴 배지, 승인 카드 버튼 폭을 본다.
- [ ] **Step 6: 커밋** — `feat(i18n): 대화·입력창·승인·도구 표시 영어, 공용 라벨 사전`

---

### Task 4: UI 화면 C — 사용량·활동·총사령탑·사이드 패널, UI 누출 0, 오프라인 페이지·매니페스트

**Files:**
- Create: `src/ui/i18n/{en,ko}/{usage,activity,highlights,commander,sidePanel,files,memory,roles}.ts`, `src/ui/i18n.render.test.tsx`, `scripts/render/gen/{usage-strip,usage-sheet,activity,landing-hero}.{en,ko}.html`
- Modify: `src/ui/components/usageSeats.tsx`(★ `'가능'`), `UsageStrip.tsx`(★ 비교를 `kind === 'ok'` 로), `UsageView.tsx`(`ko-KR` 고정 제거), `UsageSheet.tsx`, `ContextGauge.tsx`, `Activity.tsx`, `ActivityButton.tsx`, `ActivitySheet.tsx`, `Highlights.tsx`, `highlightSections.ts`, `CommanderChip.tsx`(★ phase id), `CommanderSheet.tsx`, `SidePanel.tsx`(★ 탭 id), `src/ui/sideTabs.ts`, `FileMenu.tsx`, `MemoryEditor.tsx`, `RoleBadge.tsx`, `src/ui/roles.ts`, `EngineMark.tsx`(제목·aria 문구), 그 밖에 `BASELINE` 에 남은 `src/ui/**` 파일 전부, `src/ui/public/sw.js`, `src/ui/public/manifest.webmanifest`, `src/i18n.leak.test.ts`(`src/ui/**` 항목 0), `src/ui/fixtures.gen.test.tsx`
- Test: 기존 테스트 무변경 통과 + `usageSeats.test.tsx`·`UsageStrip.test.tsx`·`SidePanel.test.tsx` 영어 테스트, `src/ui/i18n.render.test.tsx`, `src/ui/sw.test.ts`(생성)

**Interfaces:**
- Produces: `CommanderPhase = 'running' | 'judging' | 'paused' | 'done' | 'stopped' | 'restartCut' | 'off'`, `commanderPhase(v): CommanderPhase`, 라벨은 `ui().commander.phase[p]`. 사이드 패널 탭 `SideTab = 'changes' | 'source' | 'view' | 'preview'`.
- `UsageStrip` 의 full→mid→min 판단이 측정 기반이면 그대로, 글자 수·고정 폭 상수 기반이면 `en` 문구로 다시 잰 값으로 바꾼다(코드를 열어 확인하고 테스트에 기준 폭을 적는다).
- `sw.js`: `const KO = (self.navigator.languages || [self.navigator.language || '']).some((l) => /^ko\b/i.test(l))` 로 오프라인 HTML 두 벌 중 하나(`lang` 속성 포함). 명시 설정(`Prefs.lang`)은 서비스 워커가 모르므로 브라우저 언어만 따른다(문서화).
- `manifest.webmanifest` 의 `description`: `"Run your coding CLIs from any device."`(이름 필드는 리브랜드가 정한 값 유지).
- `src/ui/i18n.render.test.tsx`: `App.test.tsx` 의 WS·fetch 가짜를 재사용해 hello(세션 3개·계정 2개·사용량·승인 대기 1·총사령탑 1) → 메인 화면, 설정 시트, 사용량 시트, 활동 시트를 차례로 연다. 각 상태에서 `hangulIn(document.body)` 가 비어야 한다(`en`). 같은 흐름을 `ko` 로 돌리면 한글이 있어야 한다(전환이 실제로 먹는지).

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
it('usage strip compares by kind, not by text', () => { /* text 를 무엇으로 바꿔도 ok 좌석은 'Available'(en) / '사용 가능'(ko) */ });
it('commander chip shows the phase label for each status', () => { setLocale('en'); /* running → 'Commander running · 3' */ });
it('side panel switches tabs by id', () => { /* 'Changes' 탭 클릭 → DiffList */ });
it('App in English shows no Hangul across main, settings, usage and activity', async () => { /* 위 Interfaces */ });
it('App in Korean still shows Korean', async () => { /* 같은 흐름, hangulIn 비어 있지 않음 */ });
it('offline page follows the browser language', () => { /* sw.js 를 vm 으로 읽어 navigator.languages ['ko-KR'] → lang="ko", ['en-US'] → lang="en" 이고 한글 없음 */ });
it('no src/ui file is left in the leak baseline', () => expect(Object.keys(BASELINE).filter((f) => f.startsWith('src/ui/'))).toEqual([]));
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/ui/components/usageSeats.test.tsx src/ui/components/UsageStrip.test.tsx src/ui/components/SidePanel.test.tsx src/ui/i18n.render.test.tsx src/ui/sw.test.ts src/i18n.leak.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — ★ id 화 → 문구 이전 → `src/ui/**` 의 남은 파일을 `BASELINE` 이 빌 때까지. `landing-hero` 픽스처는 분할 보기(사이드바 + 대화 + 사용량 띠 + 승인 카드)를 한 장에 담는 1440×900 구성으로 만든다(Task 7 히어로 스크린샷).
- [ ] **Step 4: 통과 확인** — Step 2 명령 PASS, 공통 검증 명령 전부 PASS.
- [ ] **Step 5: 화면 확인** — `usage-strip.en` 을 1250·1000·720·390 에서 렌더해 full→mid→min→아래 줄 전환이 기존 한국어와 비슷한 폭에서 일어나는지, 남은 % 와 리셋 표기가 잘리지 않는지 본다. `landing-hero.en` 1440 렌더.
- [ ] **Step 6: 커밋** — `feat(i18n): 사용량·활동·총사령탑·사이드 패널 영어, UI 한국어 누출 0, 오프라인 페이지·매니페스트`

---

### Task 5: 서버 사용자 문구 — 로직 키 코드화, 알림·오류·푸시·CLI·doctor·서비스

**Files:**
- Create: `src/server/i18n/{en,ko}/{cli,service,http,notices,errors,routing,commander,engines,sessions,usage,files,push}.ts`, `src/server/i18n/codes.test.ts`
- Modify: `src/shared/protocol.ts`(`turn_result.errorCode?`, 총사령탑 상태 `noteCode?`), `src/server/commander/Commander.ts`, `src/server/push/BottleneckWatch.ts`, `src/server/push/PushNotifier.ts`, `src/server/routing/AccountRouter.ts`, `AutoRoute.ts`(표시 문구·`KIND_LABEL`·notes 만, 정규식 무변경), `AutoModel.ts`, `EngineChoice.ts`, `src/server/turn/TurnRunner.ts`(알림·오류 — 모델 지시문은 Task 6), `src/server/ws.ts`, `src/server/http.ts`, `src/server/server.ts`, `src/server/main.ts`(★ 시작 실패 판별), `src/server/engine/GrokEngine.ts`·`GeminiEngine.ts`·`grokInspect.ts`·`grokBilling.ts`·`shadowHome.ts`(사용자 문구), `src/server/sessions/SessionFork.ts`·`SessionMover.ts`·`SessionTrash.ts`·`transcript.ts`·`GrokBotImports.ts`, `src/server/usage/UsageIndex.ts`·`ClaudeUsagePoller.ts`·`GeminiUsagePoller.ts`(표시 문구만), `src/server/files.ts`, `src/server/cli/args.ts`·`doctor.ts`·`service/*.ts`, `src/shared/accounts.ts`, `src/shared/handoff.ts`(표시 라벨만), `src/ui/components/CommanderChip.tsx`(`noteCode` 우선 + 옛 접두 호환), `src/i18n.leak.test.ts`
- Test: 기존 서버 테스트 무변경 통과(ko 고정) + `src/server/i18n/codes.test.ts`, `src/server/push/PushNotifier.test.ts`·`src/server/cli/doctor.test.ts`·`src/server/http.test.ts` 에 영어 테스트

**Interfaces:**
- Produces (코드):
  - `turn_result.errorCode?: 'no_alternative_account' | 'session_move_failed' | 'auth' | 'fast_credits'` — 문구(`errorText`)는 서버 언어로 그대로 두고, 판단은 코드로. `BottleneckWatch` 는 `errorCode === 'no_alternative_account'` 로 재시도 예약(옛 서버의 `errorText` 를 읽을 일은 없다 — 같은 프로세스 안).
  - 총사령탑 기록·상태 `noteCode?: 'restart' | 'disabled'`. UI: `noteCode === 'restart' || note.startsWith('재시작으로 끊김')`(디스크의 옛 기록 호환).
  - `type FableBlock = 'exhausted' | 'unknown'`; `AccountRouter` 의 Fable 판단은 `FableBlock | null` 을 돌려주고 `AutoModel`·`AutoRoute` 는 코드로 비교, 문구는 `sm().routing.fable[block]`.
  - `isUntitled(t: string | null | undefined): boolean` — 빈 값, `'(제목 없음)'`(옛 값), `sm().sessions.untitled`(현재 언어) 모두 참. 제목을 만드는 쪽은 빈 문자열을 내고 표시 때만 문구를 쓴다.
  - `class StartFailure extends Error` — `main.ts` 는 `err instanceof StartFailure` 로 판별.
- 서버 문구는 전부 `sm().<영역>.<키>` — 알림(`turn_notice.message`), 오류 응답(`{ ok:false, error }`, HTTP JSON `error`), 푸시(`title` 은 세션 제목, `body` 는 `sm().push`), CLI·doctor·서비스 출력(Task 1 에서 정한 `localeFromEnv`). 서버는 현지화된 문자열을 그대로 보낸다(D4).
- 라우팅 배제 이유(`excluded[account]`)도 서버 언어(턴 배지 툴팁에 보임).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// codes.test.ts
it('a no-alternative-account failure schedules a retry in English too', async () => {
  setLocale('en');
  /* TurnRunner 가짜 라우터가 모든 계정 쿨다운 → turn_result.errorCode === 'no_alternative_account', errorText 에 한글 없음,
     BottleneckWatch 가 pendingRetry 를 예약 */
});
it('Fable block is a code; the note text follows the locale', () => {
  setLocale('en'); expect(chooseModelNotes(fableExhaustedInput)).toContain(sm().routing.fable.exhausted);
  setLocale('ko'); expect(chooseModelNotes(fableExhaustedInput)).toContain('Fable 20% 이하 남음 → Opus');
});
it('commander restart note carries noteCode; the chip reads both the code and an old Korean note', () => { /* … */ });
it('untitled: new sessions get an empty title, old "(제목 없음)" still counts', () => { /* isUntitled */ });
it('start failure is detected by class, not by text', () => { /* en 로캘에서도 main 의 오류 출력 분기 */ });

// PushNotifier.test.ts
it('push body follows the server language', () => { setLocale('en'); expect(selectPush(permissionMsg, titleOf)!.body).toMatch(/^Permission request · /); });
// doctor.test.ts
it('doctor prints English with LANG=en_US.UTF-8', () => { /* formatDoctor 결과에 한글 없음 */ });
// http.test.ts
it('a bad token answers in the server language', async () => { setLocale('en'); /* 401 { error: 'Invalid token' } */ });
// i18n.leak.test.ts
it('src/server and src/shared are down to ALLOW entries and model prompts only', () => { /* BASELINE 의 남은 키 ⊆ Task 6 대상 파일 */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/i18n src/server/push src/server/cli src/server/http.test.ts src/i18n.leak.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — 순서: ① 코드화(★ 5곳)와 그 테스트를 먼저 통과시킨다(ko 로캘에서 기존 테스트 무변경) ② 영역별로 문구 이전 ③ `BASELINE` 에서 이 Task 파일 제거. 모델에게 가는 지시문(`DECK_INTRO_NOTE`, `CONCISE_STYLE_PROMPT`, 인계 프롬프트, `claudeCli/texts.ts`, `Judge.ts`, 총사령탑 지시)은 건드리지 않는다 — Task 6.
- [ ] **Step 4: 통과 확인** — Step 2 명령 PASS, 공통 검증 명령 전부 PASS.
- [ ] **Step 5: 커밋** — `feat(i18n): 서버 알림·오류·푸시·CLI 영어, 한국어 문자열 비교를 코드로`

---

### Task 6: 모델에게 가는 프롬프트 — ko 원문 고정, en 번역, 서버 언어로 선택

**Files:**
- Create: `src/server/prompts/{en,ko,index}.ts`, `src/server/prompts/prompts.test.ts`, `src/server/prompts/__snapshots__/prompts.test.ts.snap`(Step 1 이 만듦)
- Modify: `src/server/turn/TurnRunner.ts`(`DECK_INTRO_NOTE`), `src/shared/concise.ts`(`CONCISE_STYLE_PROMPT`·`conciseSystemPrompt` 를 서버 프롬프트로 — 공용 모듈은 UI 번들에 프롬프트를 싣지 않게 `src/server/prompts` 에서만 import), `src/shared/handoff.ts`(인계 지시문), `src/server/engine/claudeCli/texts.ts`(모델에게 돌려주는 `NO_TOOLS_MESSAGE`·`KEEP_PLANNING_MESSAGE`·`DENIED_MESSAGE`·`QUESTION_*`·`SELF_CALL_MESSAGE`), `src/server/commander/Judge.ts`·`Commander.ts`(지시문), `src/server/engine/GrokEngine.ts`(모델에게 가는 문구가 있으면), `src/i18n.leak.test.ts`(`BASELINE` 비움 — 남는 것은 `ALLOW` 뿐)
- Test: `src/server/prompts/prompts.test.ts`, 기존 `concise.test.ts`·`handoff.test.ts`·`Judge` 테스트 무변경 통과

**Interfaces:**
- Produces: `prompts(): Prompts`(= `pick({ en, ko })`), `type Prompts = Widen<typeof en>`. 항목: `deckIntroNote: string`, `conciseStyle(o: { engine: EngineKind; task: boolean }): string`, `handoffMemo: string`, `judge*`(지금 `Judge.ts` 의 지시문 수만큼), `claudeCli.{noTools, keepPlanning, denied, questionMalformed, questionUnanswered, selfCall}`.
- `ko.ts` 의 값은 지금 상수와 **바이트 단위로 같다**(스냅숏). `en.ts` 는 같은 지시를 영어로 — 인계 메모는 "Write the memo in English Markdown", 간결 모드는 지금 한국어 규칙("첫 문장에 답, 이어서 근거·숫자·원인·다음 할 일을 질문 무게만큼")의 뜻을 그대로.
- 기존 export 이름(`DECK_INTRO_NOTE` 등)을 다른 모듈·테스트가 쓰면 같은 이름의 getter 함수로 바꾸고 호출처를 고친다.

- [ ] **Step 1: 스냅숏 먼저(옮기기 전)** — `prompts.test.ts` 에 지금 상수들을 그대로 `toMatchSnapshot()` 하는 테스트를 쓰고 `npx vitest run src/server/prompts --maxWorkers=2` 로 스냅숏 파일을 만든다. 이 커밋 전 상태가 기준이다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
it('ko prompts are byte-identical to the pre-move snapshot', () => {
  setLocale('ko');
  expect(prompts().deckIntroNote).toMatchSnapshot('deckIntroNote');      // Step 1 과 같은 스냅숏 이름
  expect(prompts().conciseStyle({ engine: 'claude', task: false })).toMatchSnapshot('conciseStyle.claude');
  expect(prompts().handoffMemo).toMatchSnapshot('handoffMemo');
  /* judge·claudeCli 항목 전부 */
});
it('en prompts carry no Hangul', () => {
  setLocale('en');
  for (const s of allPromptStrings(prompts())) expect(s).not.toMatch(HANGUL);
});
it('an English server sends no Hangul to the model on a first Claude turn', async () => {
  setLocale('en');
  /* 가짜 claude CLI 로 첫 턴 → stdin 으로 간 사용자 메시지·--append-system-prompt 인자 전체에 한글 없음 (기존 ClaudeEngine 테스트의 가짜 spawn 재사용) */
});
it('the UI bundle does not include prompt text', () => { /* src/ui 아래 어떤 파일도 src/server/prompts 를 import 하지 않음 (import 그래프를 정적으로 검사) */ });
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/server/prompts --maxWorkers=2` → 새 테스트 FAIL(스냅숏 테스트는 PASS).
- [ ] **Step 4: 구현** — 상수를 `ko.ts` 로 옮기고 `en.ts` 를 쓴 뒤 호출처를 `prompts()` 로. `BASELINE` 이 빈 객체가 될 때까지(남는 한글은 `ALLOW` 의 해석용 값뿐).
- [ ] **Step 5: 통과 확인** — `npx vitest run src/server/prompts src/i18n.leak.test.ts --maxWorkers=2` PASS, 공통 검증 명령 전부 PASS.
- [ ] **Step 6: 커밋** — `feat(i18n): 모델 지시문 언어 선택 — ko 원문 고정(스냅숏), en 번역, 한국어 누출 0`

---

### Task 7: 랜딩 사이트 — 정적 빌드, en·ko, 스크린샷·OG·데모 자산, 결제 버튼 자리

**Files:**
- Create: `site/build.ts`, `site/render.ts`, `site/content/{types,en,ko,install,pricing,claims}.ts`, `site/styles.css`, `site/static/_headers`, `site/static/robots.txt`, `site/assets/shots/{en,ko}/{hero,split,usage,approval,phone,setup}.png`, `site/assets/og.{en,ko}.png`, `site/assets/icon.png`, `site/demo/shotlist.md`, `site/site.test.ts`, `scripts/render/gen/{landing-split,landing-usage,landing-approval,landing-phone,landing-setup,landing-og}.{en,ko}.html`
- Modify: `vitest.config.ts`(include 에 `'site/**/*.test.ts'`), `tsconfig.json`(include 에 `"site"`), `scripts/contrast-check.mjs`(`site/styles.css` 의 `:root` 블록 검사 추가), `src/ui/fixtures.gen.test.tsx`(landing 픽스처)
- Test: `site/site.test.ts`

**Interfaces:**
- `site/content/install.ts`: `INSTALL_COMMAND = 'npx ai-msg'`, `GLOBAL_INSTALL_COMMAND = 'npm i -g ai-msg'`(D13 결과에 따라 이 두 줄만 바뀜).
- `site/content/pricing.ts`: `PRICING = { pro: { monthlyUsd: 10, yearlyUsd: 100, foundingYearlyUsd: 80, trialDays: 7, cardRequiredForTrial: false } } as const`(스펙 §0·§4·§5.4). `checkoutUrls(env): { proMonthly: string | null; proYearly: string | null }` — `AIMSG_CHECKOUT_PRO_MONTHLY`·`AIMSG_CHECKOUT_PRO_YEARLY`(https 만, 아니면 null).
- `site/content/types.ts`: `SiteContent = { meta: { title; description; ogAlt }; nav: {...}; hero: { headline; sub; installLabel; copied; secondaryCta }; demo: { heading; caption; videoLabel; stills: { file; alt; caption }[] }; features: { heading; items: { title; body; shot?: string; pro?: boolean }[] }; pricing: { heading; free: Plan; pro: Plan; monthly; yearly; founding; trial; buyMonthly; buyYearly; unavailable }; faq: { heading; items: { q; a }[] }; security: { heading; points: { title; body; claim: ClaimId }[] }; install: { heading; steps: { title; body; command?: string }[]; docsLink }; footer: {...}; langSwitch: string }`. `ko: SiteContent` 로 키 일치를 `tsc` 가.
  - 히어로 문장(en): 스펙 §1 한 줄을 AI msg 로 — "AI msg — the cockpit for your local coding agents. Claude Code, Codex, Gemini and Grok in one place, from your desk or your phone, and they keep going when you step away."
  - 기능(스펙 §4 Community 열 + Pro 열, Pro 항목은 배지): 한 화면 여러 세션·분할·배치, 다벤더·통합 사용량 띠, 자동 분배, 폰에서 승인·답, 다른 앱 대화 가져오기, 빠르게(사용 크레딧), Pro: 계정 수 제한 없음("as many accounts per vendor as you own"), 병목 알림·리셋 시각 자동 재시도, 한 번 눌러 벤더 간 인계, 릴레이 + 웹 푸시(기기 3대). "출시 뒤" 항목(유휴 할당량 작업·교차 검증)은 넣지 않는다.
  - FAQ(en): Is this allowed by the vendors' terms?(미변조 공식 CLI·본인 로그인·토큰 비접촉, 같은 벤더 순환은 기본 꺼짐·본인 계정만) / Does my code or login leave my machine? / Do I need API keys?(No — reuses the subscriptions you already pay for) / What happens when I hit a limit? / Which platforms?(macOS·Linux, Node 24, Windows not yet) / What does Pro add? / Trial and refunds(7일·카드 없음, 결제·환불은 판매 대행이 처리 — 업체명은 계획 ④ 확정 뒤 문구에 넣음) / Is it open source?(Community MIT).
  - 보안 모델(en): 로컬 우선(코드·자격증명은 기기에 남음), 공식 CLI 로그인만·토큰 파일/키체인 비접촉, 릴레이는 암호문만(Pro), 푸시 본문에 코드·명령 없음, 같은 벤더 순환 기본 꺼짐 + 동의, 공개 저장소 위생. 각 항목의 `claim` 은 `claims.ts` 키.
  - 할 일(계획 ④ 보안 리뷰 반영): 릴레이 보안 문구는 "폰은 새 세션을 Mac 기본값으로 쓰고, 기존 세션 권한 상향·권한을 넓히는 영속 설정·안전 스위치·외부 전송 동의·전역 지시는 Mac 에서만" 으로 쓴다("폰은 권한을 바꿀 수 없다" 처럼 넓게 쓰지 않는다; 근거 계획 ④ D19·`docs/security-model.md`).
- `site/content/claims.ts`: `CLAIMS: Record<ClaimId, { text: string; evidence: string; owner: 'shipped' | 'plan4' }>` — 예: `noCredentialReads → 'src/server/setup/noCredentialReads.test.ts'`(shipped), `relayCiphertext → '계획 ④ 릴레이 Task'`(plan4), `pushNoCode → '계획 ④ 푸시 Task'`(plan4), `rotationOffByDefault → 'src/server/settings.ts DEFAULT_SETTINGS.sameVendorRotation'`(shipped).
- `site/render.ts`: `escapeHtml(s: string): string`; `renderPage(c: SiteContent, ctx: { locale: Locale; origin: string | null; checkout: { proMonthly: string | null; proYearly: string | null }; hasVideo: boolean; analyticsToken: string | null }): string` — 섹션 `id` 는 `hero`·`demo`·`features`·`pricing`·`faq`·`security`·`install`. 결제 버튼: `<a class="buy" data-plan="pro-monthly" href="<url>">`; url 이 null 이면 `href="#pricing" aria-disabled="true"` + `unavailable` 문구(미리보기 빌드 전용). 설치 한 줄은 `<code>` + 복사 버튼(인라인 스크립트 없이 `site/static/copy.js` 한 파일, CSP `script-src 'self'`). `hreflang` 대체 링크, `og:*`(origin 이 있을 때 절대 주소), 언어 전환 링크(`/` ↔ `/ko/`). 외부 글꼴·외부 스크립트 없음. `analyticsToken` 이 있으면 Cloudflare Web Analytics 비콘 한 줄(D14) — 이때만 CSP 에 그 출처 추가.
- `site/build.ts`: `npx tsx site/build.ts [--release] [--out <dir>]`(기본 `site/dist`). 출력: `index.html`(en), `ko/index.html`, `styles.css`, `copy.js`, `assets/**`, `_headers`, `robots.txt`, `sitemap.xml`(origin 이 있을 때). 환경 변수: `SITE_ORIGIN`(https), `AIMSG_CHECKOUT_PRO_MONTHLY`, `AIMSG_CHECKOUT_PRO_YEARLY`, `CF_ANALYTICS_TOKEN`(선택). `--release` 는 `SITE_ORIGIN`·결제 링크 둘 중 하나라도 없으면, 금지어가 있으면, 스크린샷 파일이 빠졌으면 종료 코드 1. 데모 영상(`site/assets/demo/demo.mp4`, 선택)이 있으면 `<video controls preload="none" poster>` 로, 없으면 스틸 3장 띠로(영상 없이도 출시 가능, D11). 영상은 20 MB 이하(Pages 파일당 25 MiB 한도).
- `site/static/_headers`: `/*` 에 `Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. 계획 ④ 가 결제 오버레이 스크립트를 쓰면 그때 출처를 더한다.
- 스크린샷: `DECK_GEN_FIXTURES=1 npx vitest run src/ui/fixtures.gen.test.tsx` 로 `landing-*` 픽스처를 만들고 `RENDER_OUT=/tmp/aimsg-shots RENDER_HEIGHT=900 scripts/render-check.sh gen/landing-split.en 1440`(폰 컷은 390×844, OG 는 `RENDER_HEIGHT=630` 1200) → `site/assets/shots/<locale>/<이름>.png` 로 복사해 커밋. 아이콘은 리브랜드가 정한 앱 아이콘(`scripts/assets/` 의 1024px)을 512px 로 줄여 `site/assets/icon.png`(`sips -Z 512`, macOS 기본 도구).
- `site/demo/shotlist.md`(영어): 35~45초, 6컷 — ① 데스크톱 분할 보기에서 두 세션이 도는 모습 ② 한 Claude 계정이 한도에 걸리고 다른 계정으로 이어지는 배지 ③ 폰 화면에서 승인 카드를 눌러 허용 ④ Claude → Codex 한 번 눌러 인계(Pro) ⑤ 사용량 띠 시트 ⑥ 터미널 `npx ai-msg` 한 줄과 첫 실행 마법사. 촬영 준비: 임시 `DECK_CONFIG_DIR` + `accounts.json` 으로 **데모 전용 프로필 폴더만** 보이게(실제 `~/.claude` 세션 목록이 사이드바에 나오지 않게), 합성 저장소 하나, 알림·메뉴 막대 숨김, 1440×900 녹화 → H.264 mp4(≤ 20 MB) + 포스터. 촬영·편집은 사용자 몫.

- [ ] **Step 1: 실패하는 테스트 작성** (`site/site.test.ts`, 빌드는 `--out` 임시 폴더로)

```ts
const build = (env: Record<string, string> = {}, release = false) => runBuild({ out: tmp(), release, env });
it('en and ko pages with all sections and the right lang', async () => {
  const out = await build();
  const en = read(out, 'index.html'), ko = read(out, 'ko/index.html');
  expect(en).toContain('<html lang="en"'); expect(ko).toContain('<html lang="ko"');
  for (const id of ['hero', 'demo', 'features', 'pricing', 'faq', 'security', 'install']) { expect(en).toContain(`id="${id}"`); expect(ko).toContain(`id="${id}"`); }
});
it('English page has no Hangul except the language switch', async () => {
  const en = read(await build(), 'index.html').replace(enContent.langSwitch, '');
  expect(textOf(en)).not.toMatch(HANGUL);
});
it('install line is INSTALL_COMMAND verbatim on both pages', async () => { /* … */ });
it('prices come from PRICING', async () => { /* '$10', '$100', '$80', '7-day' (ko: '7일') */ });
it('no banned marketing words in either locale', async () => { /* unlimited|bypass|circumvent|100% quota|무제한|한도 우회|할당량 100% */ });
it('buy buttons: data-plan + checkout URL; preview build marks them unavailable', async () => {
  const pre = read(await build(), 'index.html');
  expect(pre).toMatch(/data-plan="pro-monthly"[^>]*href="#pricing"[^>]*aria-disabled="true"/);
  const rel = read(await build({ SITE_ORIGIN: 'https://example.com', AIMSG_CHECKOUT_PRO_MONTHLY: 'https://pay.example.com/m', AIMSG_CHECKOUT_PRO_YEARLY: 'https://pay.example.com/y' }, true), 'index.html');
  expect(rel).toContain('href="https://pay.example.com/m"');
});
it('--release fails without SITE_ORIGIN or checkout URLs', async () => { await expect(build({}, true)).rejects.toThrow(/SITE_ORIGIN|checkout/); });
it('no external scripts, styles, fonts or images', async () => { /* <script src>, <link href>, <img src>, <video src|poster> 가 모두 상대 경로 */ });
it('every image has alt, width and height, and the file exists', async () => { /* … */ });
it('_headers carries the CSP', async () => { /* "default-src 'self'" */ });
it('without a demo video the demo section shows stills, not a <video>', async () => { /* … */ });
it('every security point maps to a claim with evidence', () => { /* en/ko security.points[].claim ∈ CLAIMS, evidence 비어 있지 않음 */ });
it('escapeHtml', () => expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;'));
```

- [ ] **Step 2: 실패 확인** — `npx vitest run site --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces. `site/styles.css` 는 앱 토큰의 색 값(`--bg`·`--fg`·`--accent`·`--muted` 등, 다크·라이트 둘 다)을 그대로 쓰고 `prefers-color-scheme` 로 전환, 반응형 3단(≤720·721–1100·≥1100), 터치 44px. `contrast-check.mjs` 에 `site/styles.css` 블록 검사 추가.
- [ ] **Step 4: 스크린샷·OG·아이콘 생성** — 위 "스크린샷" 절차. 각 PNG 800 KB 이하(넘으면 `sips -s formatOptions` 로 줄이거나 폭을 낮춘다 — 테스트에 상한).
- [ ] **Step 5: 통과 확인** — `npx vitest run site --maxWorkers=2` PASS, `npx tsx site/build.ts --out "$(mktemp -d)"` 성공, 공통 검증 명령 전부 PASS(`node scripts/contrast-check.mjs` 가 사이트 블록 포함 0).
- [ ] **Step 6: 화면 확인** — `D=$(mktemp -d); npx tsx site/build.ts --out "$D"` 뒤 헤드리스 Chrome 으로 `file://$D/index.html` 과 `file://$D/ko/index.html` 을 1440·390 에서 찍어(`--screenshot`, `render-check.sh` 와 같은 옵션) 섹션 순서·가격 카드·FAQ·폰 레이아웃을 본다.
- [ ] **Step 7: 커밋** — `feat(site): 랜딩 — en·ko 정적 빌드, 합성 픽스처 스크린샷, 가격·결제 버튼 자리, 보안 모델·주장표, 데모 촬영 대본`

---

### Task 8: 설치 문서(영어 우선)와 전체 검증 — 패키징 계획 ② Task 8 흡수

**Files:**
- Create: `docs/install.md`, `docs/install.ko.md`
- Modify: `README.md`, `README.ko.md`, `CONTRIBUTING.md`(저장소에서 실행·이 맥 전용 launchd 를 개발 절로), `package.json`(`description`; D15 가 확정됐을 때만 `private` 제거), `src/server/packaging.test.ts`(같은 조건 — `pkg.private` 기대 변경)
- Test: 문서 검사는 `site/site.test.ts` 에 한 묶음 추가(README·install 문서의 설치 명령 = `INSTALL_COMMAND`, 금지어 없음, 한글 없음(en 문서))

**Interfaces:**
- `docs/install.md`(영어) 절: Requirements(Node ≥ 24, macOS·Linux, 쓸 CLI 중 하나 이상: `claude` ≥ 2.1.259 권장 2.1.283, `codex`, `agy`, `grok`) · Quick start(`npx ai-msg` → 터미널에 나온 로그인 주소 → 첫 실행 마법사) · Log in to each CLI(마법사가 보여 주는 명령, AI msg 는 대신 로그인하지 않음) · Language(설정 › Screen › Language, 서버 문구는 마지막 명시 선택, CLI 는 `LANG`/`DECK_LANG`) · Open it from your phone(같은 네트워크·자체 Tailscale; 릴레이는 Pro) · `ai-msg doctor [--json]` · `ai-msg login-url` · Run as a service(`npm i -g ai-msg` → `ai-msg service install [--dry-run] [--node <path>] [--drain-max-min N]`; npx 캐시 경로는 거부됨; nvm·fnm·volta·asdf·mise 의 node 는 쓰지 말 것; macOS 는 GUI 로그인 세션에서, 전체 디스크 접근은 서비스의 node 경로에; Linux 는 로그아웃 뒤에도 돌게 `loginctl enable-linger` 안내) · Upgrade(`npm i -g ai-msg@latest` → `ai-msg service restart`; 실행 중 서버는 재시작 전까지 옛 버전, UI 에 Restart pending) · Stop and uninstall(`service uninstall` 은 데이터 폴더를 지우지 않음; 정지는 진행 중 턴을 drain 상한(기본 25분)까지 기다림) · One server per config folder(별도 인스턴스는 `DECK_CONFIG_DIR` + `--port`) · Config folder and environment variables(`~/.config/deck`, `DECK_*`) · Troubleshooting(포트 사용 중, 설정 폴더 잠김, SSH 의 macOS, systemd 사용자 세션 없음) · Windows(아직 미지원).
- `README.md`: 첫머리(제품 한 줄·스크린샷 `site/assets/shots/en/hero.png`) → Features(영어 UI 라벨, 용어집) → Install(`npx ai-msg` 세 줄 + `docs/install.md` 링크) → Multiple accounts(지금 절 유지, 용어 영어로) → Engines(Claude 는 **공식 `claude` CLI 헤드리스**로 — "Agent SDK" 문구 삭제, Grok 사용량 카드 있음으로 고침) → Security model → Configuration → Development(→ `CONTRIBUTING.md`) → License. 저장소 실행(`git clone`·`npm start`)과 `install-launchd.sh` 서비스 절은 `CONTRIBUTING.md` 로 옮긴다. `README.ko.md`·`docs/install.ko.md` 는 같은 구조의 한국어.
- 개인 경로·작업 폴더명 금지(위생 검사), 예시 경로는 `~/projects/acme-web` 식.

- [ ] **Step 1: 실패하는 문서 검사 작성** — `site/site.test.ts` 에: README.md·docs/install.md 에 `INSTALL_COMMAND` 가 있고, 금지어·한글이 없고(언어 전환 링크 `[한국어](README.ko.md)` 제외), `quarterdeck`·`Agent SDK`·`install-launchd.sh` 가 없다. README.ko.md·docs/install.ko.md 에도 `INSTALL_COMMAND` 가 있다.
- [ ] **Step 2: 실패 확인** — `npx vitest run site --maxWorkers=2` → 새 테스트 FAIL.
- [ ] **Step 3: 문서 작성** — 위 Interfaces. 각 명령·플래그는 `src/server/cli/args.ts` 의 실제 정의와 대조한다(없는 옵션을 쓰지 않음). D15 가 확정됐으면 `package.json` 의 `private` 를 지우고 `packaging.test.ts` 의 기대를 바꾼다. 아니면 그대로 두고 보고에 적는다.
- [ ] **Step 4: 전체 검증**
  - 공통 검증 명령 5종 + `npx vitest run src/i18n.leak.test.ts site --maxWorkers=2` → 전부 PASS
  - `npx tsx site/build.ts --out "$(mktemp -d)"` → 성공
  - 커밋 후 `bash scripts/pack-smoke.sh` → `pack-smoke: 완료`(패키지에 `site/` 가 들어가지 않는지 — `files` 목록 무변경 확인)
  - `scripts/export-public.sh "$(mktemp -d)"` → `export-public: 완료`(공개본에 `site/`·`docs/install*.md` 포함, 위생 통과)
  - `ls -1A ~/.config/deck` 의 이름 목록이 작업 시작 때와 같다(테스트가 실제 설정 폴더에 쓰지 않았음)
- [ ] **Step 5: 영어 모드 실기 확인(임시 인스턴스, 선택)** — 임시 HOME·임시 `DECK_CONFIG_DIR`·임시 포트(예 9411)·`LANG=en_US.UTF-8` 로 `npx vite build --outDir "$D"` 결과를 `DECK_UI_DIR="$D"` 로 물려 서버를 띄우고, 로그인 주소로 들어가 마법사·설정·언어 전환(한국어 → 다시 영어)·`ai-msg doctor` 출력이 영어인지 본다. 끝나면 그 프로세스만 끈다. 9320 의 서버는 건드리지 않는다.
- [ ] **Step 6: 계획 ② 의 실기 항목 이관** — 패키징 계획 Task 8 Step 3(Linux 실기: systemd 설치·S1~S7 계약 확인)·Step 4(다른 맥: `kill -9` 뒤 자식 정리, `brew upgrade node` 뒤 서비스·전체 디스크 접근 유지)는 그대로 이 Task 의 선택 확인 항목이다. 결과를 `docs/install.md` 의 해당 절과 패키징 계획 D8 아래 메모에 적는다.
- [ ] **Step 7: 커밋** — `docs: 영어 우선 설치 문서(README·docs/install), 저장소 실행은 CONTRIBUTING 으로` (D15 확정 시 `, package private 해제` 덧붙임)

---

## 결정 지점

| # | 질문 | 권고 | 대안 | 권고 이유 |
|---|---|---|---|---|
| D1 | i18n 방식 | **타입 있는 자체 사전**(`en` 원본, `ko: Widen<typeof en>`, 문자열·함수 값, 런타임당 현재 언어 하나) | react-i18next + i18next / Lingui·FormatJS(ICU) | 언어 둘, UI 한글 약 1,100줄·서버 약 1,000줄, 이미 `setupTexts.ts` 가 같은 모양(함수 값)이다. 키 불일치를 `tsc` 가 공짜로 잡고, 서버·UI·CLI 가 같은 방식을 쓴다. 영어 복수형은 함수 안 삼항으로 충분해 ICU 가 필요 없다. 새 의존성 0, `state.ts` 리듀서·`toolLabel.ts` 같은 비 React 모듈에서도 훅 없이 부를 수 있다. 언어가 셋 이상이 되거나 번역 플랫폼을 쓰게 되면 그때 JSON 내보내기를 붙인다 |
| D2 | 언어 전환 반영 | **부팅 때 고정, 바꾸면 페이지 다시 읽기**(초안은 저장 뒤) | 즉시 전환(컨텍스트 + 모든 컴포넌트 재렌더) | 즉시 전환은 1,717줄 `state.ts` 의 리듀서 문구·메모된 값까지 언어를 흘려야 해서 손댈 곳이 크다. 전환은 드물고, 초안·배치·진행 중 턴은 이미 저장되거나 서버 쪽이라 잃는 것이 없다 |
| D3 | 서버 문구를 범위에 넣나, 서버 언어는 무엇을 따르나 | **넣는다**(알림·오류·푸시·CLI·doctor·서비스 + 모델 지시문). 서버 언어 = `settings.json` `language`(UI 에서 명시적으로 고른 마지막 값) → 없으면 `DECK_LANG`→`LC_ALL`→`LC_MESSAGES`→`LANG` → 영어 | UI 만 / 서버는 영어 고정 | 영어 UI 에 한국어 알림·오류가 섞이면 "영어 기본"이 아니다. 특히 모델 지시문이 한국어면 영어 사용자가 한국어 답을 받는다(Review Focus 4). 환경 변수 기본값 덕에 이 맥(`LANG=ko_KR`)은 아무것도 바꾸지 않아도 지금처럼 한국어 |
| D4 | 서버 문구 전달 방식 | **서버가 현지화한 문자열을 그대로 보낸다**(로직은 코드로 — Task 5) | 코드 + 인자를 보내고 UI 가 현지화 | 알림을 만드는 곳이 서버에 100곳 넘게 흩어져 있고 프로토콜 변경이 크다. 기기별 언어가 다른 경우는 드물다. 대신 로직 분기는 전부 코드로 바꿔 두므로(★) 나중에 코드 기반 전달로 옮기기 쉽다 |
| D5 | 모델 지시문 | **ko = 지금 문구 바이트 동일(스냅숏 고정), en = 번역, 서버 언어로 선택** | 영어 한 벌 + "사용자 언어로 답하라" 한 줄 | 간결 모드 지시문은 사용자가 피드백으로 다듬은 한국어다(HANDOFF 10-22 ④). 영어로 갈아 끼우면 이 맥의 답 품질이 바뀔 위험이 있다. 두 벌 유지 비용은 지시문 6~10개 수준 |
| D6 | 영어 용어 | **위 "용어집"**(Auto, Auto routing, Commander, Fast · usage credits, Concise mode, Handoff, Diverged …) | 다른 이름(예: Commander → Autopilot) | 기능을 그대로 설명하는 짧은 말. 바꾸고 싶으면 `en` 사전·랜딩·README 만 고치면 된다(코드 식별자 무관). Autopilot 은 다른 도구들이 흔히 써서 피함 |
| D7 | 랜딩 구현 | **프레임워크 없는 TS→HTML 생성기**(`npx tsx site/build.ts`, 결과는 순수 정적 파일) | Astro / Vite 다중 페이지 / Next 정적 내보내기 | 페이지 둘(en·ko), 동적 요소는 복사 버튼 하나. 새 의존성 0, 빌드 1초, CSP `script-src 'self'` 를 지키기 쉽다. 블로그·문서 사이트가 필요해지면 그때 옮긴다 |
| D8 | 랜딩 언어 경로 | **`/` = 영어, `/ko/` = 한국어, 자동 리디렉트 없음**(상단에 "한국어" 링크, `hreflang`) | Accept-Language 로 리디렉트(Pages Functions) | 정적 호스팅 그대로, 크롤러·공유 링크가 예측 가능. 시장이 글로벌 영어 우선(스펙 §0) |
| D9 | 배포 경로 | **사용자가 `npx wrangler pages deploy site/dist --project-name ai-msg` 로 직접 업로드**(빌드는 `--release` + 환경 변수) | Pages Git 연동(공개 저장소) | 이 저장소는 원격 없는 비공개 원본이고 공개본은 손으로 내보낸다 — Git 연동은 공개본 동기화 시점에 묶인다. 직접 업로드는 결제 링크·사이트 주소를 빌드 시점에 넣기도 쉽다 |
| D10 | 스크린샷 원천 | **합성 데이터로 생성한 렌더 픽스처**(`scripts/render/gen/landing-*`) | 실제 앱 화면 캡처 | 실제 화면에는 이 맥의 세션 제목·경로·계정이 보인다(공개 위생). 픽스처는 언어별로 다시 뽑을 수 있고 UI 가 바뀌면 같은 명령으로 갱신된다. 단 픽스처는 실제 동작이 아니라 정적 화면이므로 "실제 동작"은 데모 영상이 맡는다 |
| D11 | 데모 영상 | **사용자가 데모 전용 프로필로 실제 동작을 녹화**(`site/demo/shotlist.md`), 랜딩은 영상 없이도 완결(스틸 띠) — 영상이 생기면 파일만 넣고 다시 빌드 | 픽스처를 이어 붙인 애니메이션 / 출시를 영상에 묶음 | 경쟁 제품과의 차이(한도에서 이어가기·폰 승인·인계)는 움직이는 실제 화면이어야 설득된다. 녹화에는 실제 로그인이 필요해 자동화할 수 없다. 출시 일정이 영상에 막히지 않게 분리 |
| D12 | 결제 버튼 계약 | **`<a data-plan="pro-monthly|pro-yearly" href=<결제 URL>>`, URL 은 빌드 환경 변수, `--release` 는 둘 다 있어야 통과** | 랜딩이 직접 결제 SDK 를 싣기 | 계획 ④ 가 판매 대행 업체(1순위 Paddle)와 방식(호스팅 결제 링크 / 오버레이)을 정한다. 링크면 그대로, 오버레이면 `data-plan` 에 스크립트를 걸고 CSP 출처만 더한다. 결제 링크 없는 랜딩이 출시되는 사고를 빌드가 막는다 |
| D13 | npm 이름·설치 한 줄 | **`ai-msg` 를 쓰되, 랜딩·README 확정 전에 사용자가 이름 확보를 실제로 시도**(예: `0.0.0` 자리 패키지 publish). 거부되면 **`@ai-msg/cli`(bin 은 `ai-msg`, 실행은 `npx @ai-msg/cli`)** 로 바꾸고 `INSTALL_COMMAND`·README 두 곳만 고친다 | 처음부터 스코프 패키지 | `ai-msg` 는 2026-10-22 npm 에 없다. 그러나 `aimsg`(1.0.1, AI 커밋 메시지 도구, bin `aimsg`)가 있어 npm 의 "구두점만 다른 새 이름 거부" 규칙에 걸릴 수 있다 — publish 해 봐야 확정된다. bin 이름은 `aimsg` 와 달라 전역 설치 충돌(EEXIST)은 없다 |
| D14 | 랜딩 방문 분석 | **Cloudflare Web Analytics(쿠키 없음, 동의 배너 불필요) — `CF_ANALYTICS_TOKEN` 이 있을 때만** | 분석 없음 / 쿠키 기반 분석 | 스펙 §8 지표(설치 → 전환)의 첫 칸이 랜딩 방문이다. 쿠키가 없어 개인정보 고지 부담이 작고, 토큰이 없으면 아무것도 싣지 않는다 |
| D15 | `package.json` 의 `private: true` 해제 시점 | **D13 으로 이름이 확보된 뒤 Task 8 에서**. 확보 전이면 그대로 두고 보고 | Task 8 에서 무조건 해제 | 계획 ② 구현 메모대로 실수 publish 를 막는 장치다. 이름이 바뀔 수 있는 동안 남겨 두는 비용은 없다(`npm pack`·pack 스모크는 `private` 와 무관) |
| D16 | 서비스 워커 오프라인 페이지 언어 | **브라우저 언어(`navigator.languages`)만 따른다** | UI 가 고른 언어를 서비스 워커에 전달·저장 | 오프라인 페이지는 서버에 닿지 못할 때만 보이는 한 화면이다. 서비스 워커 저장소까지 엮을 만큼의 가치가 없다 |

## 사용자 몫 (이 계획의 작업이 아님)

- **npm 이름 확보 시도(D13)** — 랜딩·README 확정(Task 7·8) 전에. 결과에 따라 `INSTALL_COMMAND` 를 그대로 두거나 `@ai-msg/cli` 로.
- 도메인 확보 → 빌드의 `SITE_ORIGIN`, `package.json` 의 `homepage`(계획 ④ 와 함께).
- Cloudflare 계정·Pages 프로젝트 생성과 배포(`npx wrangler pages deploy …`, D9), 필요하면 Web Analytics 토큰(D14).
- 결제 링크 두 개(월·연) — 계획 ④ 에서 판매 대행 업체 확정 뒤.
- 데모 영상 촬영·편집(`site/demo/shotlist.md`): 데모 전용 Claude·Codex 프로필 로그인(`CLAUDE_CONFIG_DIR=<데모 폴더> claude auth login` 등), 녹화, 20 MB 이하 mp4 를 `site/assets/demo/demo.mp4` 로.
- 출시 전 랜딩 주장표(`site/content/claims.ts`) 중 `owner: 'plan4'` 항목이 실제로 구현됐는지 대조 — 아니면 그 문구를 빼고 다시 빌드.
- 영어 문구 최종 감수(원어민 또는 외부 검토 권장) — 특히 동의 문구 세 개와 랜딩 히어로·FAQ.
- Linux·다른 맥 실기 확인(Task 8 Step 6, 계획 ② 에서 이관).
- 실제 `npm publish`(이 계획은 pack 까지).

## 범위 밖

- Pro 기능 잠금·라이선스·entitlement·결제·체험 처리, 릴레이·페어링 QR — 계획 ④.
- 약관·개인정보 처리방침·환불 정책 페이지(스펙 §7 6~7주차 문서) — 랜딩 바닥글은 GitHub·`SECURITY.md` 링크만.
- 세 번째 언어, RTL, 번역 플랫폼 연동.
- 서버 문구의 코드 기반 전달(D4 대안) — 기기별로 다른 언어가 실제로 필요해질 때.
- `docs/ARCHITECTURE.md`·`docs/protocol.md`·`docs/gemini-spike.md`·스펙·계획 문서 번역.
- 개발용 스크립트(`scripts/*.sh`·`*.mjs`)의 한국어 출력 번역.
- 기존 정적 한국어 픽스처(`scripts/render/*.html` 11개)를 생성식으로 바꾸는 일 — 새 생성 픽스처와 공존.
- 런칭 게시물(Show HN·Reddit·X·Product Hunt·GeekNews) 작성, 블로그.
- Windows 지원.
