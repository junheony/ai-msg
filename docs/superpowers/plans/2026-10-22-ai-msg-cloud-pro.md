# AI msg 클라우드·Pro·결제·체험 구현 계획 (계획 ④)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **작성 2026-10-22.** 제품명 **AI msg** 기준이다(npm `ai-msg`, CLI `ai-msg`). 스펙에 나오는 Quarterdeck 은 옛 이름이다. 무료(Community)와 Pro 를 **같은 날** 출시한다. 계획 ①(정책 준수)은 끝났고, 계획 ②(패키징)는 Task 1–7 이 끝났다. 계획 ③(i18n·랜딩, `2026-10-22-ai-msg-i18n-landing.md`)은 이 계획과 나란히 진행한다. 이 계획에서 쓰는 Cloudflare·Paddle API 가운데 공식 문서로 확인한 것과 확인하지 못한 것은 맨 끝 "근거·미확인" 절에 나눠 적었다. 본문에 **(미확인)** 이 붙은 형태는 구현하는 Task 의 첫 단계에서 실제로 확인한 뒤에 쓴다.

**Goal:** 집 밖의 폰에서 클라우드 릴레이를 거쳐 Mac 의 AI msg 세션을 보고 승인한다. 이때 클라우드는 내용을 읽을 수 없다(종단간 암호화). Pro 기능은 클라우드가 서명한 entitlement 로만 켜지고, 결제는 Paddle 구독(월·연)으로 받으며 7일 체험은 카드 없이 준다. 오프라인이거나 클라우드가 장애일 때도 무료 기능은 지금과 똑같이 동작하고, 유료 기능은 마지막으로 받은 유효한 entitlement 의 유예 기간(7일) 동안 유지된다.

**Architecture:**

저장소에 독립 패키지 `cloud/`(Cloudflare Worker 하나)를 새로 둔다. 이 Worker 가 맡는 일은 다섯 가지다.
- 계정: 이메일 매직링크 로그인.
- 호스트 연결: Mac 을 계정에 묶는 장치 코드 흐름.
- 페어링·기기: 폰 등록, 사용자당 최대 3대.
- entitlement 발급: Ed25519 서명 JWS.
- 웹 푸시 VAPID 서명 대행과 Paddle 웹훅.

데이터는 D1 에 저장한다. 릴레이는 **Mac(호스트)마다 Durable Object 하나**(`RelayRoom`, Hibernation WebSocket)를 둔다. Mac 은 바깥으로 WS 를 열어 상주하고, 폰은 일회용 티켓으로 접속한다. 종단간 암호화는 이렇게 한다.
- Mac 과 폰이 페어링 때 QR 로 정적 공개키를 교환한다.
- 접속할 때마다 임시 키를 더한 ECDH P-256 → HKDF-SHA256 으로 방향별 AES-256-GCM 키를 만든다.
- 카운터로 재전송과 순서 바꿈을 막는다.

순수 암호·프레임 코드는 `src/shared/cloud/` 하나를 Mac·폰 UI·Worker 가 함께 쓴다.

Mac 쪽 `RelayBridge` 는 복호화한 요청을 **자기 서버의 루프백**(`http://127.0.0.1:<port>`, `ws://127.0.0.1:<port>/ws`)으로 프록시한다. 그래서 기존 인증·라우트·ws 처리기를 한 줄도 바꾸지 않고 그대로 쓴다. 폰 UI 는 같은 React 앱을 클라우드 주소의 `/v/<버전>/` 에서 연다. 이때 `src/ui/transport.ts` 가 `fetch`·WebSocket 을 터널로 바꿔 끼운다.

Pro 는 이렇게 막는다.
- 로컬: `src/server/pro/` 의 `ProGate` 가 entitlement 를 검증하고 기능별로 연다.
- 클라우드: 릴레이·푸시·기기 등록은 클라우드가 이용권을 직접 확인한다. 로컬 검사를 지워도 클라우드 기능은 생기지 않는다(스펙 §4).

Paddle 은 웹훅(서명 검증, `event_id` 로 멱등, `occurred_at` 으로 순서 판정)으로 구독 상태만 받는다. 체험은 Paddle 이 아니라 클라우드가 자체 행으로 관리한다.

**Tech Stack:**
- 로컬: TypeScript(Node 24, ESM), `ws`·`zod`·`web-push`(기존 런타임 의존성 셋 그대로), WebCrypto(`globalThis.crypto.subtle` — Node·브라우저·Workers 공통), React 19, vitest + @testing-library/react.
- 클라우드(`cloud/` 자체 `package.json`): Cloudflare Workers + Durable Objects(Hibernation WebSocket API) + D1 + R2, `wrangler`, `@cloudflare/vitest-plugin`(로컬 workerd/miniflare 테스트, vitest `^4.1`). 런타임 의존성은 없다.
- 결제: Paddle Billing(웹훅 + Paddle.js 오버레이 체크아웃 + 고객 포털 API).
- 메일: Resend HTTP API, `EmailSender` 인터페이스 뒤에 둔다(D9).
- QR: `qrcode-generator`(UI devDependency, D10).

**Spec:**
- `docs/superpowers/specs/2026-10-15-quarterdeck-paid-design.md` 의 §1(핵심 약속 2·4), §4(티어), §5.1(Pro 모듈·entitlement 24시간·7일 유예), §5.3(클라우드), §5.4(결제), §6(보안), §7(4~6주차: "폰에서 릴레이 경유 승인 성공"), §10-4, §11.
- UI 기준: `docs/superpowers/specs/2026-10-21-ui-overhaul-design.md`(설정 4묶음의 **계정**, 시트·SheetHead, 토큰, 터치 44px, 대비 4.5).
- ws 호환 규칙: `docs/protocol.md`.
- 형식 기준: `docs/superpowers/plans/2026-10-18-quarterdeck-packaging.md`.

## Global Constraints

- **선행 조건:** 리네임(`ai-msg`) 작업이 master 에 병합된 뒤 시작한다. Task 1 Step 0 에서 `node -p "require('./package.json').name"` 이 `ai-msg` 이고 `git status --short` 가 깨끗한지 확인하고, 아니면 멈추고 보고한다. 환경 변수 접두사·설정 폴더는 병합된 코드를 따른다. 이 문서는 지금 코드 기준인 `DECK_*`·`<configDir>`(=`resolveConfigDir`)로 쓴다. 리네임이 접두사를 바꿨으면 `DECK_CLOUD_URL` 같은 새 이름도 같은 규칙으로 바꾼다(D16).
- **무료 기능은 클라우드와 무관하게 동작한다.**
  - `startServer` 는 클라우드 호출을 기다리지 않는다. `CloudService.start()` 는 listen 과 `attachWebSocket` 이 끝난 **뒤에** 시작하고, 그 안의 오류는 모두 잡아 상태(`relay: 'down'`)와 로그 한 줄로만 남긴다.
  - 클라우드에 연결하지 않은 설치는 클라우드로 요청을 하나도 보내지 않는다(테스트로 고정).
  - `DECK_CLOUD=off` 면 `/api/cloud/*` 가 404 이고 기능 이름 `cloud` 도 알리지 않는다.
- **유료 기능의 오프라인 유예:** 로컬은 마지막으로 검증한 entitlement 의 `exp`(최대 발급 후 7일)까지 Pro 를 유지한다. 클라우드가 이용권을 직접 확인하는 기능(릴레이·클라우드 푸시·기기 등록)은 클라우드가 판단한다.
- **클라우드는 평문을 보지 않는다.** Worker·DO 코드는 터널 프레임을 해석하지 않는다. 봉투의 머리(종류·기기 id)만 읽는다. 로그에는 메타데이터(사용자 id·호스트 id·기기 id·바이트 수·종료 코드)만 남긴다(스펙 §6). 이것은 Task 3 테스트로 고정한다.
- **자격증명 비접촉 유지:** 클라우드로 CLI 토큰·`auth.json`·키체인 내용을 보내지 않는다. D1 에는 이메일, 토큰의 **sha256 해시**, 공개키만 저장한다. 비밀 토큰은 모두 32바이트 난수를 base64url 로 만들고, 발급 응답에 딱 한 번만 싣는다.
- **런타임 의존성:**
  - 루트는 `ws`·`zod`·`web-push` 셋에서 늘리지 않는다. 새 devDependency 는 `qrcode-generator` 하나뿐이다(D10).
  - `cloud/` 는 런타임 의존성 0. devDependency 는 `wrangler`·`@cloudflare/vitest-plugin`·`vitest`·`typescript`·`@cloudflare/workers-types` 다.
  - `cloud/` 는 루트 npm 패키지(`files: dist`)에 들어가지 않는다.
- **공유 코드 규칙:** `src/shared/cloud/*.ts` 는 `node:` import 와 DOM 전용 API 를 쓰지 않는다. `globalThis.crypto`·`TextEncoder`·`Uint8Array` 만 쓴다(Workers·Node·브라우저 공통). `cloud/` 는 이 파일들을 상대 경로로 import 한다(`cloud/tsconfig.json` 의 `include` 에 `../src/shared/cloud`).
- **검증 명령:**
  - 모든 Task 공통:
    - `npx tsc --noEmit -p .`
    - `npx vitest run src/server src/shared --maxWorkers=2`
    - `npx vitest run src/ui src/hygiene.test.ts src/hygiene.private.test.ts --maxWorkers=2`
    - `npx vite build --outDir "$(mktemp -d)"`
    - `node scripts/contrast-check.mjs`
  - `cloud/` 를 건드린 Task 는 추가로 `npm --prefix cloud ci`, `npm --prefix cloud run typecheck`, `npm --prefix cloud test` 까지 돌린다. 루트 tsconfig 의 `include` 는 `src` 라서 `cloud/` 는 루트 tsc·vitest 범위 밖이다.
- **테스트 범위:**
  - 실제 네트워크·실제 Paddle·실제 배포·`wrangler login`·`wrangler deploy` 를 쓰지 않는다. 워커는 `@cloudflare/vitest-plugin`(로컬 workerd)과 `wrangler dev --local` 로만 돌린다.
  - 서버 테스트는 `fs.mkdtemp` 임시 configDir 과 가짜 릴레이(`src/server/cloud/testkit.ts` 의 `FakeRelay`, `ws` WebSocketServer)로만 돌린다.
- **실행 중인 서버를 건드리지 않는다.** `npm run restart`·서버 신호·`scripts/launchd/*`·`relaunch.sh` 를 실행하지 않는다. 저장소의 `dist/` 에 쓰지 않는다(UI 빌드 확인은 `--outDir "$(mktemp -d)"`).
- **설정 폴더 쓰기 순서(계획 ② 규칙):** `<configDir>/cloud/` 는 listen 이 성공한 뒤에만 만든다. 파일은 0600, 폴더는 0700, 쓰기는 임시 파일 → rename 순서로 한다.
- **ws 프로토콜 규칙(`docs/protocol.md`):**
  - 새 필드는 선택 필드로만 더한다. 새 메시지 종류는 만들지 않는다. Pro 상태는 기존 `hello`·`settings` 메시지의 선택 필드 `pro` 로 싣는다.
  - 기능 이름 `cloud`·`pro` 를 `FEATURES` 에 더하고 표에 한 줄씩 적는다. UI 는 `has()` 로만 판단한다.
  - 거절은 기존 `error` 메시지에 새 `code: 'pro_required'` 를 붙여 보낸다.
- **UI 개편 기준(2026-10-21):**
  - 시트는 `src/ui/components/Dialogs.tsx` 의 `Sheet`·`SheetHead` 를 쓴다(포커스 가두기, 닫으면 연 버튼으로 복귀).
  - 색·간격·반경은 `styles.css` 토큰만 쓴다. 터치 대상은 44px, 글자 대비는 4.5 이상이다. 새 색 쌍은 `scripts/contrast-check.mjs` 에 넣는다.
  - 클라우드·구독 화면은 설정 **계정** 묶음(`SETTINGS_GROUPS` 의 `'account'`)에 둔다.
  - 화면 확인은 `scripts/render/` 픽스처 + `scripts/render-check.sh` 로 한다.
- **문자열:** 계획 ③ Task 1 이 병합돼 있으면(`src/ui/i18n/index.ts` 가 있으면) 새 문구는 사전에 넣는다. UI 는 `src/ui/i18n/{en,ko}/cloud.ts`, 서버는 `src/server/i18n/{en,ko}/cloud.ts`, en 이 원본이고 누출 래칫 상한을 올리지 않는다. 병합 전이면 `src/ui/cloudTexts.ts`·`src/server/cloud/texts.ts` 두 파일에 한국어로 모아 두고, 계획 ③ 이 키로 옮긴다. 클라우드 웹 페이지(`cloud/src/pages/*`)는 영어로 쓴다(글로벌 영어 우선, 스펙 §0).
- **공개 위생:** 새 파일은 `src/hygiene.test.ts` 를 통과해야 한다. 이 검사는 `git ls-files` 전체라서 `cloud/` 도 포함된다.
  - 개인 경로·계정명·실제 이메일 주소를 넣지 않는다.
  - 테스트 키는 **실행 중에 생성**한다. PEM·JWK 개인키 문자열을 저장소에 넣지 않는다.
  - `cloud/.dev.vars`·`cloud/.wrangler/`·`cloud/node_modules/` 는 `.gitignore` 에 넣는다.
- 테스트 실행은 `--maxWorkers=2` 로 한다.

## Review Focus

1. **페어링 때 클라우드가 폰 공개키를 바꿔치기한다(MITM).** 기대: QR 에만 있는 `authSecret` 으로 만든 HMAC(`pairingMac`)이 Mac 에서 맞지 않으면 기기를 거절·해제한다. 클라우드는 `claimSecret` 의 해시만 받고 `authSecret` 은 받지 않는다. → Task 1 `pairing.test.ts`, Task 5 `Pairing.test.ts`.
2. **재전송·순서 바꿈·방향 혼동 프레임.** 기대: 카운터가 기대값이 아니거나, 다른 방향 키로 봉인됐거나, 비트가 바뀌었으면 세션을 닫는다. 평문은 한 바이트도 처리하지 않는다. → Task 1 `e2ee.test.ts`, Task 4 `RelayBridge.test.ts`.
3. **폰이 다른 기기 id 를 사칭한다.** 기대: DO 가 봉투의 출처 id 를 소켓 태그(`dev:<id>`)로 덮어쓴다. Mac 은 로컬 신뢰 목록(`<configDir>/cloud/state.json` 의 `devices`)에 있는 공개키로만 핸드셰이크를 받는다. → Task 3 `relay.test.ts`, Task 4.
4. **클라우드 장애·미연결 상태로 시작한다.** 기대: 서버가 정상으로 뜨고, 무료 기능(세션·승인·LAN 접속·로컬 푸시)이 그대로이며, 클라우드 요청은 0건(미연결) 또는 백오프 재시도(연결됨)다. → Task 4 `CloudService.test.ts`, Task 11 장애 테스트.
5. **오프라인 유예와 만료.** 기대: 검증된 토큰의 `exp` 까지만 Pro 를 유지한다. 키 불일치·변조·상태 파일 손상이면 Community 로 내려간다. 진행 중인 턴은 끊지 않고 다음 동작부터 게이트를 적용한다. → Task 7 `Entitlement.test.ts`.
6. **Paddle 웹훅 중복·순서 역전·서명 위조.** 기대: 같은 `event_id` 는 한 번만 반영한다. 더 오래된 `occurred_at` 은 상태를 되돌리지 못한다. 서명 오차가 5초를 넘거나 원문이 바뀌었으면 401 이다. → Task 9.
7. **클라우드 푸시가 SSRF·스팸 통로가 된다.** 기대: endpoint 호스트 허용 목록 + 그 호스트(Mac)가 등록한 endpoint 만 + 이용권 + 속도 제한. → Task 6 `push.test.ts`.
8. **터널로 위험 경로를 친다.** 폰이 `/api/login`·`/api/logout`·`/api/cloud/unlink`·`/api/cloud/pair/start` 를 터널로 부르는 경우다. 기대: `relayPathAllowed` 가 403 으로 막고 루프백에는 닿지 않는다. 폰이 보낸 `cookie`·`authorization`·`origin`·`host` 머리는 버린다. → Task 4 `pathPolicy.test.ts`.
9. **Mac 을 업데이트하지 않은 채 폰 UI 가 더 새것(또는 더 옛것)이다.** 기대: 핸드셰이크 응답의 `hostVersion` 과 UI 버전이 다르면 `/v/<hostVersion>/` 로 옮긴다. → Task 5.
10. **DO 가 잠들지 못해 비용이 폭증한다.** 기대: DO 안에 `setInterval`·`setTimeout` 상주 타이머가 없다. 핑은 `setWebSocketAutoResponse` 로 깨우지 않고 답하고, 이용권 만료는 alarm 으로 처리한다. → Task 3 코드 검사 테스트, Task 11 부하 스크립트.

---

## 현재 결합 지점 (master 기준 2026-10-22, 리네임 병합 뒤 줄 번호가 조금 밀릴 수 있음)

| 위치 | 결합 | 처리 |
|---|---|---|
| `src/server/server.ts:350` | `attachWebSocket(servers, {...})` — 모든 서버 쪽 조립의 끝 | Task 4: 그 뒤에 `CloudService` 를 만들고 `start()`(대기 없음), `cleanup` 에 `stop()` |
| `src/server/server.ts:273`, `:326` | `sameVendorRotation: () => settings.get().sameVendorRotation` | Task 8: `pro.has('accounts') &&` 를 앞에 붙인다 |
| `src/server/server.ts:303-311` | `new BottleneckWatch({ sendPush, retry, … })` | Task 8: `allow: (what) => pro.has(what === 'retry' ? 'autoRetry' : 'bottleneck')` |
| `src/server/server.ts:337` | Commander `enabled: () => settings.get().commanderEnabled === true` | Task 8: `&& pro.has('commander')`(D7) |
| `src/server/http.ts:32-66` | `HttpDeps` — 기능별 선택 의존성 | Task 4: `cloud?: CloudHttpDeps`(없으면 `/api/cloud/*` 없음) |
| `src/server/http.ts:580-598` | `/api/push/{key,subscribe,unsubscribe,status,test}` | Task 6: `key` 응답에 `relayPublicKey?`, `subscribe` 에 `vapid?: 'cloud'` |
| `src/server/push/PushNotifier.ts:126-129`, `:176-191` | 기본 `send` = `webpush.sendNotification`, `deliver` 의 404/410 정리 | Task 6: `sub.vapid === 'cloud'` 면 `cloudSend` + 최소 본문 |
| `src/server/push/SubscriptionStore.ts:4`, `:26` | `PushSub = { endpoint, keys }`, `parseSubscription` | Task 6: 선택 필드 `vapid?: 'local' \| 'cloud'` |
| `src/server/auth.ts` | `COOKIE_NAME = 'deck_session'`, `cookieValueFor(token)`, `checkUpgrade`(Host·Origin 루프백 허용) | Task 4: `RelayBridge` 가 루프백 요청에 이 쿠키·Origin 을 붙인다(코드 변경 없음) |
| `src/server/bind.ts` | 바인드 주소에 항상 `127.0.0.1` 포함 | Task 4: 루프백 프록시의 전제(변경 없음, 테스트로 고정) |
| `src/server/routing/AutoRoute.ts:295`, `:485`, `:522` | `RouteInput`, `const cell = cellOf(...)`, 리셋 승격 | Task 8: `candidateLimit?`(셀 앞 N개), `resetPromotion?`(false 면 :522 블록 건너뜀) |
| `src/server/turn/TurnRunner.ts:1603`, `:1609`, `:1613`, `:1951` | `claudeAccounts`(순환/고정), Gemini `loggedIn: { g1, g2 }`, `chooseRoute(...)`, `previewRoute` | Task 8: `routeTier` 의존성, Community 면 `g2: false` |
| `src/server/ws.ts` `send` 처리(`msg.handoff`), `:1653`(commander), 계정 고정 검사 | 인계·총사령탑·계정 고정 | Task 8: `pro_required` 거절 |
| `src/shared/protocol.ts:239`, `:270`, `:272` | `FEATURES`, `hello`, `settings` | Task 4: `'cloud'` / Task 7: `'pro'`, `hello.pro?`, `settings.pro?` |
| `src/ui/ws.ts:25`, `:36` | `${proto}://${location.host}/ws`, 닫힐 때 `fetch('/api/me')` | Task 5: 릴레이 모드면 `openTunnelSocket()`·`apiFetch` |
| `src/ui/push.ts` | SW `/sw.js` scope `/` 등록, `/api/push/*` 호출 | Task 5: `apiFetch` / Task 6: `relayPublicKey`·`vapid: 'cloud'` |
| `src/ui/components/Lightbox.tsx:4`, `src/ui/sessionApi.ts:143`, `src/ui/components/FileMenu.tsx:246`, `src/ui/components/ShareMenu.tsx:13` | 브라우저가 직접 여는 `/api/attachments/:id`·`/api/file?…raw=1` 주소, `window.open` | Task 5: 릴레이 모드는 터널로 받아 blob URL(`useApiUrl`) |
| `src/ui/` 의 `fetchFn = fetch` 기본값과 직접 `fetch(` 호출(`sessionApi.ts`·`pins.ts`·`upload.ts`·`ActivityButton.tsx`·`FolderPicker.tsx`·`ComposerSuggest.tsx`·`MemoryEditor.tsx`·`SessionCwdDialog.tsx`·`Sidebar.tsx`·`ActivitySheet.tsx`·`UsageSheet.tsx`·`Highlights.tsx`·`UsageView.tsx` 등) | 같은 출처 HTTP 가정 | Task 5: 기본값을 `apiFetch` 로 바꾸고 `transport.guard.test.ts` 로 고정 |
| `src/ui/components/SettingsView.tsx` `SETTINGS_GROUPS` | `['account','계정']` 묶음 | Task 5: `CloudSection` / Task 10: 구독 행 |
| `src/ui/components/Pane.tsx:120-122`, `src/ui/components/ContextGauge.tsx`(ContextHint) | 원클릭 인계 `send{handoff:true}` | Task 8: Community 면 안내만 |
| `vite.config.ts` | root `src/ui`, base 기본값, `__DECK_VERSION__` | Task 5: `--mode relay` 면 `__AIMSG_RELAY__ = true`(base 는 `--base /v/<ver>/`) |
| `src/ui/public/sw.js`, `manifest.webmanifest` | 루트 scope SW | Task 5: 클라우드가 `/sw.js`·`/manifest.webmanifest` 를 루트에서 내보낸다 |
| `src/server/paths.ts` `resolveConfigDir` | 설정 폴더 | Task 4: `<configDir>/cloud/state.json` |

## 프로토콜 계약 (Task 1·3·4·5 가 지키는 기준)

**식별자와 토큰** — 모두 32바이트 난수를 base64url 로 만들고, D1 에는 sha256 base64url 만 저장한다.
- `hostToken`: Mac 이 클라우드 API·릴레이에 쓴다. `Authorization: Bearer`.
- `deviceToken`: 폰이 티켓 발급에 쓴다.
- `ticket`: 60초 일회용. 폰 WS 주소의 `?ticket=` 에 싣는다. 브라우저 WebSocket 은 머리를 지정할 수 없어서다.
- `claimSecret`·`authSecret`: 페어링 QR 에만 있다. 클라우드에는 `sha256(claimSecret)` 만 간다.

**페어링 (QR 일회용, 5분)**
1. Mac 이 `POST /v1/pair/start {claimHash}` 를 보내 `{pairingId, expiresAt}` 를 받는다.
2. Mac 이 QR 을 띄운다. 주소는 `https://<cloud>/v/<hostVersion>/#pair=1.<pairingId>.<claimSecret>.<authSecret>.<hostPub>` 이고, 조각(#)이라 서버 로그에 남지 않는다.
3. 폰이 기기 정적 키를 만든다. 개인키는 추출 불가 `CryptoKey` 로 IndexedDB 에 둔다. 그다음 `POST /v1/pair/claim {pairingId, claim, devicePub, deviceName, mac}` 을 보내 `{deviceId, deviceToken, hostId}` 를 받는다. 여기서 `mac = HMAC-SHA256(authSecret, "aimsg-pair-v1" ‖ pairingId ‖ devicePub ‖ hostPub)` 이다.
4. Mac 이 `GET /v1/pair/:id` 를 폴링해 `devicePub`·`mac` 을 받고, 자기 `authSecret` 으로 검증한다. 맞으면 `POST /v1/pair/:id/confirm` 후 로컬 신뢰 목록에 추가하고, 틀리면 `POST /v1/pair/:id/reject` 를 보낸다(클라우드가 기기 해제).
5. 기기는 confirm 뒤에만 티켓을 받을 수 있다(`devices.state = 'active'`).

**세션 핸드셰이크 (폰 WS 연결마다)**
- 폰 → Mac 은 `hs_init {v:1, dev, e, n, uiVersion}`, Mac → 폰은 `hs_ack {v:1, e, n, hostVersion}` 이다. `e` 는 임시 P-256 공개키(65바이트 비압축, base64url), `n` 은 16바이트 난수다.
- 키 유도는 아래와 같다. 64바이트를 만들어 앞 32바이트가 `k_d2h`, 뒤 32바이트가 `k_h2d` 다.
  ```
  ikm  = ECDH(s_dev, s_host) ‖ ECDH(e_dev, e_host) ‖ ECDH(s_dev, e_host) ‖ ECDH(e_dev, s_host)
  salt = n_dev ‖ n_host
  info = "aimsg-relay-v1" ‖ deviceId ‖ devicePub ‖ hostPub ‖ e_dev ‖ e_host
  ```
- 양쪽은 첫 봉인 프레임으로 `{t:'ready'}` 를 보낸다(키 확인). 이게 5초 안에 오지 않거나 열리지 않으면 4408 로 닫는다.
- 정적-정적 항이 상호 인증을, 임시 키 항이 전방 비밀성을 준다(Noise KK 와 같은 구성. 공식 검증된 구현은 아니다 → D3).

**암호 프레임**

| 위치(바이트) | 내용 |
|---|---|
| `[0]` | 버전 `0x01` |
| `[1]` | 방향(`0x01` d2h, `0x02` h2d) |
| `[2..10)` | 카운터 u64 BE |
| `[10..)` | AES-256-GCM 암호문 + 태그 16바이트 |

- IV(12바이트) = 방향 4바이트(`0,0,0,dir`) ‖ 카운터 8바이트. AAD = 프레임 앞 10바이트.
- 받는 쪽은 카운터가 정확히 `expected` 일 때만 연다(WS 는 순서를 보장한다). 그다음 `expected++` 한다.
- 2^32 프레임을 넘으면 재연결로 키를 새로 만든다(`RekeyNeeded`).

**봉투 (DO 가 보는 것 전부)** — 바이너리다.

| 위치 | 내용 |
|---|---|
| `[0]` | 종류: 1 data · 2 hs_init · 3 hs_ack · 4 close |
| `[1]` | `peer` 길이(≤64) |
| `[2..2+len)` | `peer`(ASCII. 호스트가 보낼 때는 대상 기기 id, DO 가 호스트에게 넘길 때는 출처 기기 id, 폰 쪽은 `host`) |
| 나머지 | payload(암호 프레임 또는 핸드셰이크 JSON) |

- DO 는 폰이 보낸 `peer` 를 무시하고 태그의 기기 id 로 덮어쓴다.
- DO 제어 메시지는 텍스트 JSON 이다: `{t:'peer', dev, up}`(호스트에게), `{t:'host', up}`(폰에게). 핑은 텍스트 `ping` → `pong`(auto-response)이다.

**터널 프레임 (봉인 안의 평문 JSON, zod 로 검증)**
- `ready`
- `ws.open{s}` · `ws.msg{s,d}` · `ws.close{s,code?}`
- `http.req{id,m,p,h,b?,more}` · `http.res{id,st,h,b?,more}` · `http.chunk{id,b,more}` · `http.abort{id}`

본문 `b` 는 base64 이고 조각마다 원본 64KiB 이하다(`TUNNEL_CHUNK = 65536`). 기기당 동시 `ws` 스트림은 8개, 진행 중 `http` 는 32개까지다.

**종료 코드**

| 코드 | 뜻 |
|---|---|
| 4401 | 인증 실패·호스트 연결 해제 |
| 4402 | 이용권 없음 |
| 4403 | 기기 해제 |
| 4408 | 핸드셰이크 시간 초과 |
| 4409 | 같은 호스트·기기의 새 연결로 대체됨 |
| 4413 | 프레임 1MiB 초과 |

**entitlement (Ed25519 compact JWS)**
- 머리 `{alg:'EdDSA', kid}`, 내용 `{sub: userId, hid: hostId, plan: 'pro'|'trial'|'comp'|'none', st: 'active'|'trialing'|'past_due'|'canceled'|'none', until, iat, exp}`(초 단위).
- `exp` 규칙(`entitlementExp`): `st === 'active'` 면 `iat + 7일`(갱신 예정이라 `until` 을 넘어도 됨), 그 밖은 `min(until, iat + 7일)`. `plan: 'none'` 이면 `exp = iat`.
- 로컬은 24시간마다(±1시간 흔들림) 갱신한다. 시작할 때, 연결 직후, 설정의 "새로고침" 을 누를 때도 갱신한다.

---

## File Structure

새 파일 — 공유:

| 파일 | 책임 |
|---|---|
| `src/shared/cloud/b64.ts` | base64url 인코드·디코드, `randomToken(bytes)` |
| `src/shared/cloud/e2ee.ts` | P-256 정적 키, 핸드셰이크(`deviceHandshake`·`hostHandshake`), `Channel`(seal/open·카운터), 오류 클래스 |
| `src/shared/cloud/frames.ts` | 봉투 encode/decode, 터널 프레임 zod 스키마, `chunkBytes`, 상수(`TUNNEL_CHUNK`, 종료 코드) |
| `src/shared/cloud/pairing.ts` | QR 주소 encode/parse, `pairingMac`, `claimHash` |
| `src/shared/cloud/entitlement.ts` | `EntitlementClaims`, `signEntitlement`, `verifyEntitlement`, `entitlementExp` |
| `src/shared/cloud/api-types.ts` | 클라우드 HTTP API 요청·응답 타입(Worker 와 로컬 클라이언트가 공유) |
| `src/shared/pro.ts` | `PRO_FEATURES`, `ProFeature`, `ProStatus`, `communityStatus()` |

새 파일 — 클라우드(`cloud/`):

| 파일 | 책임 |
|---|---|
| `cloud/package.json`, `cloud/package-lock.json`, `cloud/tsconfig.json`, `cloud/vitest.config.ts`, `cloud/wrangler.jsonc` | 패키지·빌드·테스트·배포 설정(D1 `DB`, DO `RELAY`, R2 `UI`) |
| `cloud/migrations/0001_init.sql` … `0004_billing.sql` | D1 스키마(Task 2·3·6·9) |
| `cloud/src/index.ts` | `export default { fetch }`, `export { RelayRoom }` |
| `cloud/src/env.ts` | `Env` 타입(바인딩·비밀·변수) |
| `cloud/src/router.ts`, `cloud/src/http.ts` | 작은 라우터, `json()`·`problem()`·Origin 검사·CSP 머리 |
| `cloud/src/auth/tokens.ts`, `cloud/src/auth/magic.ts`, `cloud/src/auth/session.ts` | 토큰·해시, 매직링크, 웹 세션 쿠키 |
| `cloud/src/email.ts` | `EmailSender`(`log`·`resend`) |
| `cloud/src/rate.ts` | D1 고정 창 속도 제한 |
| `cloud/src/hosts.ts`, `cloud/src/pairing.ts`, `cloud/src/devices.ts` | 호스트 연결(장치 코드), 페어링, 기기 목록·해제 |
| `cloud/src/entitled.ts` | `entitledState(db, userId, nowMs)` — 체험·comp·구독을 합친 `{plan, st, untilMs}` |
| `cloud/src/relay/RelayRoom.ts`, `cloud/src/relay/routes.ts`, `cloud/src/relay/tickets.ts` | 릴레이 DO, 업그레이드 라우트, 티켓 |
| `cloud/src/push/vapid.ts`, `cloud/src/push/send.ts` | VAPID JWT(ES256), 푸시 중계·endpoint 등록 |
| `cloud/src/entitlement.ts` | `GET /v1/entitlement` |
| `cloud/src/paddle/signature.ts`, `cloud/src/paddle/webhook.ts`, `cloud/src/paddle/apply.ts`, `cloud/src/paddle/api.ts` | 서명 검증, 웹훅 수신, 상태 반영, 포털 세션(`PaddleApi` 인터페이스) |
| `cloud/src/ui.ts` | `/`(부트스트랩)·`/v/*`·`/sw.js`·`/manifest.webmanifest`·아이콘을 R2 에서 |
| `cloud/src/pages/{login,verify,link,account,checkout}.ts` | 서버 렌더 HTML(영어, 인라인 스크립트 없음) |
| `cloud/static/{account.js,checkout.js,pages.css}` | 페이지 스크립트·스타일(Worker 가 R2 `static/` 에서) |
| `cloud/scripts/gen-entitlement-key.mjs`, `cloud/scripts/gen-vapid.mjs` | 배포용 키 생성(공개키만 stdout, 개인키는 지정 파일 0600) |
| `cloud/scripts/publish-ui.sh` | `vite build --mode relay --base /v/<ver>/` → R2 업로드 |
| `cloud/scripts/load-relay.mjs` | 로컬 부하 스크립트 |
| `cloud/test/helpers.ts`, `cloud/test/*.test.ts`, `cloud/test/fixtures/paddle/*.json` | 워커 테스트 |
| `cloud/README.md` | 배포·운영 절차(사용자용) |

새 파일 — 로컬 서버:

| 파일 | 책임 |
|---|---|
| `src/server/cloud/config.ts` | `cloudConfig(env)` — 주소(`DECK_CLOUD_URL`), 끄기(`DECK_CLOUD=off`) |
| `src/server/cloud/CloudState.ts` | `<configDir>/cloud/state.json`(호스트 id·토큰·호스트 키·신뢰 기기·entitlement) |
| `src/server/cloud/CloudApi.ts` | 클라우드 HTTP 클라이언트(시간 제한 10초, `fetch` 주입) |
| `src/server/cloud/HostLink.ts` | 장치 코드 연결 시작·폴링 |
| `src/server/cloud/RelayClient.ts` | 바깥으로 여는 WS, 백오프, 종료 코드 처리 |
| `src/server/cloud/RelayBridge.ts` | 기기별 핸드셰이크·채널·터널 → 루프백 |
| `src/server/cloud/loopback.ts`, `src/server/cloud/pathPolicy.ts` | 루프백 대상·머리, 터널 허용 경로 |
| `src/server/cloud/Pairing.ts` | QR 만들기·폴링·검증·확정 |
| `src/server/cloud/Entitlement.ts` | 검증·저장·갱신 루프 |
| `src/server/cloud/entitlement-keys.json` | 신뢰하는 entitlement 공개키(JWK 목록, 공개키만) |
| `src/server/cloud/pushRelay.ts` | 클라우드 푸시 발송기(`generateRequestDetails` → `/v1/push/send`) |
| `src/server/cloud/CloudService.ts` | 조립·상태·시작/정지 |
| `src/server/cloud/testkit.ts` | `FakeRelay`(DO 흉내), `fakeCloudFetch` |
| `src/server/pro/features.ts`, `src/server/pro/gate.ts` | `PRO_ENFORCE`, `ProGate` |
| `src/server/cloud/texts.ts` 또는 `src/server/i18n/{en,ko}/cloud.ts` | 서버 문구 |

새 파일 — UI:

| 파일 | 책임 |
|---|---|
| `src/ui/transport.ts` | `isRelayMode()`, `apiFetch`, `openSocketUrl`/`openTunnelSocket`, `setRelayConnection` |
| `src/ui/relay/keystore.ts` | `KeyStore` 인터페이스 + IndexedDB 구현 + 메모리 구현(테스트) |
| `src/ui/relay/pairing.ts` | `#pair=` 처리, claim, 저장, 조각 지우기 |
| `src/ui/relay/RelayConnection.ts` | 티켓 → WS → 핸드셰이크 → 채널 → 다중화, 재연결 |
| `src/ui/relay/tunnelFetch.ts`, `src/ui/relay/tunnelSocket.ts` | 터널 위 `fetch`·WebSocket 흉내 |
| `src/ui/relay/blobUrl.ts` | `useApiUrl(path)` — 릴레이 모드면 blob URL |
| `src/ui/relay/RelayGate.tsx` | 릴레이 모드의 연결 상태 화면(로그인 화면 대신) |
| `src/ui/qr.ts` | `qrSvgPath(text)` — `qrcode-generator` 래퍼 |
| `src/ui/cloudApi.ts` | `/api/cloud/*` 호출 |
| `src/ui/pro.ts` | `proHas(feature)`(`has('pro')` + `ProStatus`) |
| `src/ui/components/CloudSection.tsx`, `src/ui/components/PairSheet.tsx` | 설정 › 계정의 클라우드·구독 행, 폰 연결 시트 |
| `src/ui/cloudTexts.ts` 또는 `src/ui/i18n/{en,ko}/cloud.ts` | UI 문구 |
| `src/ui/transport.guard.test.ts` | `fetch(`·`= fetch` 직접 사용 금지 검사 |

새 파일 — 스크립트·문서: `scripts/smoke/relay-e2e.sh`, `scripts/smoke/relay-phone.ts`, `scripts/render/cloud-section.html`, `scripts/render/pair-sheet.html`, `docs/security-model.md`, `docs/privacy-data-inventory.md`.

수정하는 파일은 다음과 같다.
- 서버: `src/server/server.ts`, `src/server/http.ts`, `src/server/ws.ts`, `src/server/push/PushNotifier.ts`, `src/server/push/SubscriptionStore.ts`, `src/server/push/BottleneckWatch.ts`, `src/server/routing/AutoRoute.ts`, `src/server/turn/TurnRunner.ts`, `src/shared/protocol.ts`
- UI: `src/ui/ws.ts`, `src/ui/push.ts`, `src/ui/App.tsx`, `src/ui/sessionApi.ts`, `src/ui/components/{SettingsView,Lightbox,FileMenu,ShareMenu,Pane,ContextGauge,AccountPicker,UsageSheet}.tsx`, Task 5 표의 `fetchFn` 기본값 파일들
- 설정·문서·검사: `vite.config.ts`, `package.json`, `package-lock.json`, `.gitignore`, `docs/protocol.md`, `src/hygiene.ts`, `scripts/contrast-check.mjs`, `scripts/export-public.sh`(D11), `README.md`

---

### Task 1: 공유 릴레이 프로토콜과 E2EE 모듈

**Files:**
- Create: `src/shared/cloud/b64.ts`, `src/shared/cloud/e2ee.ts`, `src/shared/cloud/frames.ts`, `src/shared/cloud/pairing.ts`, `src/shared/cloud/entitlement.ts`, `src/shared/cloud/api-types.ts`
- Test: `src/shared/cloud/e2ee.test.ts`, `src/shared/cloud/frames.test.ts`, `src/shared/cloud/pairing.test.ts`, `src/shared/cloud/entitlement.test.ts`

**Interfaces:**
- `b64.ts`: `toB64u(u8: Uint8Array): string`, `fromB64u(s: string): Uint8Array`(잘못된 글자면 `TypeError`), `randomToken(bytes = 32): string`, `sha256B64u(s: string | Uint8Array): Promise<string>`, `timingSafeEqual(a: string, b: string): boolean`.
- `e2ee.ts`:
  - `type StaticKeyPair = { publicRaw: Uint8Array /* 65B */; privateKey: CryptoKey }`
  - `generateStaticKeyPair(extractable: boolean): Promise<StaticKeyPair>` — `{name:'ECDH', namedCurve:'P-256'}`.
  - `exportStaticPrivate(k: StaticKeyPair): Promise<JsonWebKey>`, `importStaticPrivate(jwk: JsonWebKey): Promise<StaticKeyPair>` — 호스트 저장용(폰은 추출 불가 키를 IndexedDB 에 그대로 둔다).
  - `type HsInit = { v: 1; dev: string; e: string; n: string; uiVersion: string }`, `type HsAck = { v: 1; e: string; n: string; hostVersion: string }`
  - `deviceHandshake(o: { self: StaticKeyPair; hostPublic: Uint8Array; deviceId: string; uiVersion: string }): Promise<{ init: HsInit; finish(ack: HsAck): Promise<Channel> }>`
  - `hostHandshake(o: { self: StaticKeyPair; devicePublic: Uint8Array; deviceId: string; init: HsInit; hostVersion: string }): Promise<{ ack: HsAck; channel: Channel }>`
  - `class Channel { readonly role: 'device' | 'host'; seal(plain: Uint8Array): Promise<Uint8Array>; open(frame: Uint8Array): Promise<Uint8Array> }` — 내부 카운터(보낼 때·받을 때 따로).
  - `class DecryptError`, `class ReplayError`(카운터 불일치), `class RekeyNeeded`(2^32 도달).
- `frames.ts`:
  - `enum EnvKind { Data = 1, HsInit = 2, HsAck = 3, Close = 4 }`
  - `encodeEnvelope(e: { kind: EnvKind; peer: string; payload: Uint8Array }): Uint8Array`, `decodeEnvelope(u8: Uint8Array): { kind; peer; payload } | null`(peer 가 64자를 넘거나 ASCII 가 아니면 null)
  - `TunnelFrame`(zod 판별 유니온, 위 계약), `parseTunnelFrame(json: unknown): TunnelFrame | null`, `encodeTunnel(f: TunnelFrame): Uint8Array`
  - `chunkBytes(u8: Uint8Array, size = TUNNEL_CHUNK): Uint8Array[]`
  - `const CLOSE = { unauthorized: 4401, notEntitled: 4402, revoked: 4403, hsTimeout: 4408, replaced: 4409, tooLarge: 4413 } as const`, `const MAX_FRAME = 1 << 20`
- `pairing.ts`:
  - `type PairQr = { v: 1; pairingId: string; claim: string; auth: string; hostPub: string; hostVersion: string; origin: string }`
  - `encodePairUrl(q: PairQr): string`, `parsePairHash(hash: string): Omit<PairQr, 'origin' | 'hostVersion'> | null`
  - `claimHash(claim: string): Promise<string>`, `pairingMac(auth: string, o: { pairingId: string; devicePub: string; hostPub: string }): Promise<string>`, `verifyPairingMac(...)`: `Promise<boolean>`(상수 시간 비교)
- `entitlement.ts`:
  - `type EntitlementClaims = { sub: string; hid: string; plan: 'pro' | 'trial' | 'comp' | 'none'; st: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'; until: number; iat: number; exp: number }`
  - `entitlementExp(o: { st: EntitlementClaims['st']; plan: EntitlementClaims['plan']; until: number; iat: number }): number`
  - `signEntitlement(c: EntitlementClaims, kid: string, key: CryptoKey): Promise<string>` — `{name:'Ed25519'}`
  - `verifyEntitlement(jws: string, keys: Record<string, JsonWebKey>, o: { nowSec: number; hostId: string }): Promise<{ ok: true; claims: EntitlementClaims } | { ok: false; reason: 'format' | 'kid' | 'sig' | 'expired' | 'host' }>`
- `api-types.ts`: Task 2·3·6·7 의 요청·응답 타입(`LinkStartRes`, `LinkPollRes`, `PairStartRes`, `PairClaimReq`, `PairClaimRes`, `PairStatusRes`, `TicketRes`, `DeviceInfo`, `PushSendReq`, `EntitlementRes`)과 `ApiError = { error: string; code?: string }`.

- [ ] **Step 0: 선행 확인** — `git status --short` 가 비어 있고 `node -p "require('./package.json').name"` 이 `ai-msg` 인지 확인한다. 아니면 멈추고 보고한다.
- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/shared/cloud/e2ee.test.ts
import { describe, expect, it } from 'vitest';
import { DecryptError, ReplayError, deviceHandshake, generateStaticKeyPair, hostHandshake } from './e2ee';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

async function pair() {
  const host = await generateStaticKeyPair(true);
  const dev = await generateStaticKeyPair(false);
  const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', uiVersion: '1.0.0' });
  const h = await hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', init: d.init, hostVersion: '1.0.0' });
  return { devCh: await d.finish(h.ack), hostCh: h.channel };
}

describe('e2ee', () => {
  it('seals and opens both ways', async () => {
    const { devCh, hostCh } = await pair();
    expect(dec(await hostCh.open(await devCh.seal(enc('hi'))))).toBe('hi');
    expect(dec(await devCh.open(await hostCh.seal(enc('yo'))))).toBe('yo');
  });
  it('rejects a replayed frame and a skipped one', async () => {
    const { devCh, hostCh } = await pair();
    const f1 = await devCh.seal(enc('1')); const f2 = await devCh.seal(enc('2'));
    await hostCh.open(f1);
    await expect(hostCh.open(f1)).rejects.toBeInstanceOf(ReplayError);
    const { devCh: d2, hostCh: h2 } = await pair();
    await d2.seal(enc('a')); const b = await d2.seal(enc('b'));
    await expect(h2.open(b)).rejects.toBeInstanceOf(ReplayError);
  });
  it('rejects a flipped bit in header or body', async () => {
    const { devCh, hostCh } = await pair();
    const f = await devCh.seal(enc('x')); f[f.length - 1] ^= 1;
    await expect(hostCh.open(f)).rejects.toBeInstanceOf(DecryptError);
  });
  it('a frame never opens in the direction it was not sealed for', async () => {
    const { devCh } = await pair();
    const f = await devCh.seal(enc('x'));
    await expect(devCh.open(f)).rejects.toThrow();
  });
  it('a host without the paired static key cannot talk (cloud in the middle)', async () => {
    const host = await generateStaticKeyPair(true); const evil = await generateStaticKeyPair(true); const dev = await generateStaticKeyPair(false);
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', uiVersion: '1' });
    const h = await hostHandshake({ self: evil, devicePublic: dev.publicRaw, deviceId: 'd1', init: d.init, hostVersion: '1' });
    const devCh = await d.finish(h.ack);
    await expect(devCh.open(await h.channel.seal(enc('{"t":"ready"}')))).rejects.toBeInstanceOf(DecryptError);
  });
  it('a different deviceId in the handshake yields different keys', async () => { /* hostHandshake 에 deviceId 'd2' → open 실패 */ });
});

// src/shared/cloud/frames.test.ts
it('envelope round trip and peer limits', () => {
  const p = new Uint8Array([1, 2, 3]);
  expect(decodeEnvelope(encodeEnvelope({ kind: EnvKind.Data, peer: 'dev_abc', payload: p }))).toEqual({ kind: EnvKind.Data, peer: 'dev_abc', payload: p });
  expect(() => encodeEnvelope({ kind: EnvKind.Data, peer: 'x'.repeat(65), payload: p })).toThrow();
  expect(decodeEnvelope(new Uint8Array([9]))).toBeNull();
});
it('tunnel frames are validated', () => {
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'GET', p: '/api/me', h: {}, more: false })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'TRACE', p: '/api/me', h: {}, more: false })).toBeNull();
  expect(parseTunnelFrame({ t: 'eval', code: '1' })).toBeNull();
});
it('chunks at 64 KiB', () => expect(chunkBytes(new Uint8Array(65536 * 2 + 1)).map((c) => c.length)).toEqual([65536, 65536, 1]));

// src/shared/cloud/pairing.test.ts
it('QR url round trip, hash only', () => {
  const url = encodePairUrl({ v: 1, pairingId: 'p1', claim: 'c', auth: 'a', hostPub: 'h', hostVersion: '1.2.3', origin: 'https://app.example' });
  expect(url).toBe('https://app.example/v/1.2.3/#pair=1.p1.c.a.h');
  expect(parsePairHash(new URL(url).hash)).toEqual({ v: 1, pairingId: 'p1', claim: 'c', auth: 'a', hostPub: 'h' });
});
it('mac fails when the cloud swaps the device key', async () => {
  const mac = await pairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' });
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' }, mac)).toBe(true);
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'swapped', hostPub: 'h' }, mac)).toBe(false);
});

// src/shared/cloud/entitlement.test.ts — 키는 실행 중 생성
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const base = { sub: 'u1', hid: 'h1', plan: 'pro', st: 'active', until: 2_000_000_000, iat: 1_900_000_000 } as const;
it('verifies, then rejects expiry, wrong host, unknown kid, tampering', async () => {
  const jws = await signEntitlement({ ...base, exp: entitlementExp(base) }, 'k1', kp.privateKey);
  expect(await verifyEntitlement(jws, { k1: pub }, { nowSec: base.iat + 10, hostId: 'h1' })).toMatchObject({ ok: true });
  expect(await verifyEntitlement(jws, { k1: pub }, { nowSec: base.iat + 8 * 86400, hostId: 'h1' })).toEqual({ ok: false, reason: 'expired' });
  expect(await verifyEntitlement(jws, { k1: pub }, { nowSec: base.iat, hostId: 'h2' })).toEqual({ ok: false, reason: 'host' });
  expect(await verifyEntitlement(jws, { k2: pub }, { nowSec: base.iat, hostId: 'h1' })).toEqual({ ok: false, reason: 'kid' });
  const [h, p, s] = jws.split('.'); const forged = `${h}.${toB64u(enc(JSON.stringify({ ...base, plan: 'pro', until: 4e9, exp: 4e9 })))}.${s}`;
  expect(await verifyEntitlement(forged, { k1: pub }, { nowSec: base.iat, hostId: 'h1' })).toEqual({ ok: false, reason: 'sig' });
});
it('exp rule', () => {
  expect(entitlementExp({ st: 'active', plan: 'pro', until: 100, iat: 0 })).toBe(7 * 86400);
  expect(entitlementExp({ st: 'trialing', plan: 'trial', until: 100, iat: 0 })).toBe(100);
  expect(entitlementExp({ st: 'none', plan: 'none', until: 0, iat: 50 })).toBe(50);
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/shared/cloud --maxWorkers=2` 가 모듈 없음으로 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위 계약대로 만든다.
  - ECDH 결과는 `deriveBits(256)` 로 얻고, HKDF 는 `importKey('raw', ikm, 'HKDF')` → `deriveBits(512)` 로 한다. 두 AES 키는 `importKey('raw', …, 'AES-GCM', false, ['encrypt','decrypt'])` 로 만든다.
  - 잘못된 공개키(곡선 밖)는 `importKey` 가 던지는 오류를 `DecryptError` 로 감싼다.
  - JWS 는 `base64url(JSON 머리).base64url(JSON 내용).base64url(서명)` 이다.
- [ ] **Step 4: 통과 확인** — 위 명령이 PASS 하는지 본다. 공통 검증 명령 다섯 개도 돌린다.
- [ ] **Step 5: 커밋** — `feat(cloud): 공유 릴레이 프로토콜 — P-256 핸드셰이크·방향별 AES-GCM·봉투·터널 프레임·페어링 MAC·entitlement JWS`

---

### Task 2: 클라우드 패키지 뼈대 — 계정·호스트 연결·페어링·기기 API

**Files:**
- Create:
  - 패키지 설정: `cloud/package.json`, `cloud/package-lock.json`, `cloud/tsconfig.json`, `cloud/vitest.config.ts`, `cloud/wrangler.jsonc`, `cloud/migrations/0001_init.sql`
  - 진입·공통: `cloud/src/index.ts`, `cloud/src/env.ts`, `cloud/src/router.ts`, `cloud/src/http.ts`
  - 인증·메일·제한: `cloud/src/auth/tokens.ts`, `cloud/src/auth/magic.ts`, `cloud/src/auth/session.ts`, `cloud/src/email.ts`, `cloud/src/rate.ts`
  - 도메인: `cloud/src/hosts.ts`, `cloud/src/pairing.ts`, `cloud/src/devices.ts`, `cloud/src/entitled.ts`
  - 페이지: `cloud/src/pages/login.ts`, `cloud/src/pages/verify.ts`, `cloud/src/pages/link.ts`
- Modify: `.gitignore`(`cloud/node_modules/`, `cloud/.wrangler/`, `cloud/.dev.vars`)
- Test: `cloud/test/helpers.ts`, `cloud/test/auth.test.ts`, `cloud/test/hosts.test.ts`, `cloud/test/pairing.test.ts`, `cloud/test/entitled.test.ts`

**Interfaces:**
- `cloud/package.json` scripts: `"typecheck": "tsc --noEmit -p ."`, `"test": "vitest run --maxWorkers=2"`, `"dev": "wrangler dev --local"`. devDependencies 는 Global Constraints 의 다섯 개로 버전을 고정한다(`npm i -D --save-exact`).
- `cloud/vitest.config.ts`: `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })` 플러그인을 쓴다. 마이그레이션은 `readD1Migrations('./migrations')` → 테스트 setup 에서 `applyD1Migrations(env.DB, migrations)` 로 적용한다(`readD1Migrations` 시그니처 **(미확인)** — Step 1 에서 플러그인 README 로 확인).
- `cloud/wrangler.jsonc`: `name: "ai-msg-cloud"`, `main: "src/index.ts"`, `compatibility_date: "2026-10-15"`, `d1_databases: [{ binding: "DB", database_name: "ai-msg", migrations_dir: "migrations" }]`, `vars: { PUBLIC_ORIGIN, EMAIL_MODE: "log", EMAIL_FROM, DEV_ROUTES: "0", MAX_DEVICES: "3", MAX_HOSTS: "3", TRIAL_DAYS: "7" }`. `database_id` 는 배포 때 사용자가 넣는다(`cloud/README.md`).
- `Env`: `DB: D1Database; RELAY: DurableObjectNamespace; UI: R2Bucket; PUBLIC_ORIGIN: string; EMAIL_MODE: 'log' | 'resend'; EMAIL_FROM: string; RESEND_API_KEY?: string; SESSION_SECRET: string; DEV_ROUTES: '0' | '1'; MAX_DEVICES: string; MAX_HOSTS: string; TRIAL_DAYS: string` — 뒤 Task 가 늘린다.
- `0001_init.sql`:

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, paddle_customer_id TEXT UNIQUE);
CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE web_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE host_links (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, host_name TEXT NOT NULL, host_pub TEXT NOT NULL, ui_version TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed')), user_id TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE hosts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, host_pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ui_version TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), host_id TEXT NOT NULL REFERENCES hosts(id), name TEXT NOT NULL, pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('claimed','active','revoked')), created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE pairings (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), claim_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','claimed','confirmed','rejected','expired')), device_id TEXT, mac TEXT, bad_claims INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE trials (user_id TEXT PRIMARY KEY REFERENCES users(id), started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);
CREATE TABLE grants (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL CHECK (plan IN ('comp')), until INTEGER NOT NULL, note TEXT);
CREATE TABLE rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX devices_user ON devices(user_id, state);
CREATE INDEX hosts_user ON hosts(user_id);
```

- 라우트(`api-types.ts` 타입 사용). 상태를 바꾸는 웹 라우트는 `Origin === PUBLIC_ORIGIN` 을 검사한다. API 라우트는 Bearer 를 쓰고 쿠키는 보지 않는다.
  - `POST /v1/auth/magic {email, next?}`
    - 항상 200 `{ok:true}` 를 돌려준다(가입 여부를 드러내지 않음).
    - 속도 제한: 이메일당 시간당 5회, IP(`CF-Connecting-IP`)당 시간당 20회.
    - 토큰 유효 15분, 한 번만 쓸 수 있다.
    - 메일 본문의 주소: `${PUBLIC_ORIGIN}/auth/verify?t=<token>`.
  - `GET /auth/verify?t=` 는 "Sign in" 버튼 하나만 있는 페이지를 보여 준다. 메일 스캐너가 미리 열어도 토큰이 소모되지 않게 하려는 것이다. `POST /auth/verify {t}` 가 토큰을 소모하고, 사용자를 upsert 한 뒤 쿠키 `aimsg_web=<id>.<HMAC(SESSION_SECRET,id)>`(`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`)를 심고 `next` 로 303 보낸다(같은 출처 경로만, 아니면 `/account`).
  - `POST /v1/host/link/start {hostName, hostPub, uiVersion}` → `{deviceCode, userCode, verifyUrl, interval: 3, expiresIn: 600}`. `userCode` 는 `XXXX-XXXX`(헷갈리는 글자 0/O/1/I 없음)이고, `verifyUrl = ${PUBLIC_ORIGIN}/link?code=<userCode>` 다.
  - `GET /link?code=` 는 로그인하지 않았으면 `/login?next=/link?code=…` 로 보내고, 로그인했으면 호스트 이름과 공개키 지문(sha256 앞 8바이트를 16진 4묶음)을 보여 준다. 버튼은 "Link this Mac".
  - `POST /v1/host/link/approve {userCode}`(웹 세션 + Origin)
    - 호스트 수가 `MAX_HOSTS` 를 넘으면 409.
    - 체험 행이 없으면 `trials` 를 만든다(`TRIAL_DAYS`일, 이메일당 1회, D8).
    - 상태를 `approved` 로 바꾼다.
  - `POST /v1/host/link/poll {deviceCode}`
    - 아직이면 202 `{state:'pending'}`.
    - 승인됐으면 200 `{state:'linked', hostId, hostToken, email}` 를 주고 상태를 `consumed` 로 바꾼다. `hosts` 행이 만들어지고 토큰은 이 응답에만 실린다.
    - 만료·거절이면 410.
  - `POST /v1/host/unlink`(host) → 호스트 `revoked_at` 을 기록하고, 그 호스트의 기기를 모두 `revoked` 로 바꾼다. Task 3 이 DO 종료를 더한다.
  - `POST /v1/pair/start {claimHash}`(host) → `{pairingId, expiresAt}`(5분). 호스트당 열린 페어링은 3개까지다.
  - `POST /v1/pair/claim {pairingId, claim, devicePub, deviceName, mac}`(인증 없음, IP당 분당 10회)
    - `sha256(claim)` 를 상수 시간으로 비교한다. 틀리면 `bad_claims++` 하고, 5회가 되면 `expired` 로 바꾼다.
    - 활성·claimed 기기 수가 `MAX_DEVICES` 이상이면 409 `{code:'device_limit'}`.
    - 맞으면 `devices(state='claimed')` 를 만들고 `{deviceId, deviceToken, hostId}` 를 준다.
  - `GET /v1/pair/:id`(host, 자기 호스트 것만) → `{state, deviceId?, devicePub?, deviceName?, mac?}`.
  - `POST /v1/pair/:id/confirm`(host) → 기기를 `active` 로, `POST /v1/pair/:id/reject`(host) → 기기를 `revoked` 로 바꾼다.
  - `GET /v1/devices`(host) → `DeviceInfo[]`(자기 호스트의 활성 기기). `POST /v1/devices/:id/revoke` 는 host 토큰이나 웹 세션으로 부른다.
  - `GET /dev/outbox?to=` 는 `DEV_ROUTES === '1'` 이고 `EMAIL_MODE === 'log'` 일 때만 열린다(Task 5 e2e 용). 그 밖에는 404 다.
- `entitled.ts`: `entitledState(db, userId, nowMs): Promise<{ plan: 'trial' | 'comp' | 'pro' | 'none'; st: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none'; untilMs: number }>`. 이 Task 에서는 `trials`·`grants` 만 본다. 둘 다 유효하면 `until` 이 큰 쪽을 쓰고, 둘 다 없거나 지났으면 `none`/0 이다. Task 9 가 구독을 더한다.
- `email.ts`: `interface EmailSender { send(m: { to: string; subject: string; text: string }): Promise<void> }`.
  - `log` 모드는 `outbox` 테이블에 쓴다.
  - `resend` 모드는 `POST https://api.resend.com/emails`(`Authorization: Bearer`, 본문 `{from, to, subject, text}`)로 보낸다. 이 형태는 **(미확인)** 이라 Step 1 에서 Resend 문서로 확인하고, 다르면 이 파일만 고친다.

- [ ] **Step 1: 도구·API 확인** — 다음을 확인하고, 확인한 것을 `cloud/README.md` 의 "확인한 버전" 절에 적는다.
  - `npm --prefix cloud i -D --save-exact wrangler @cloudflare/vitest-plugin vitest typescript @cloudflare/workers-types` 로 설치한다.
  - `node_modules/@cloudflare/vitest-plugin/README.md` 에서 `cloudflareTest`·`readD1Migrations`·`applyD1Migrations` 의 형태와, vitest 지원 범위(`^4.1` 이상, 5 지원 여부)를 확인한다.
  - Resend `POST /emails` 의 형태를 확인한다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/helpers.ts
import { env, exports } from 'cloudflare:workers';
export const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(`https://app.test${path}`, init));
export const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.test', ...headers }, body: JSON.stringify(body) });
export async function loginAs(email: string): Promise<string> {
  await post('/v1/auth/magic', { email });
  const row = await env.DB.prepare('SELECT body FROM outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 1').bind(email).first<{ body: string }>();
  const t = /t=([A-Za-z0-9_-]+)/.exec(row!.body)![1]!;
  const res = await post('/auth/verify', { t });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
export async function linkHost(email = 'user@example.test'): Promise<{ hostId: string; hostToken: string; cookie: string }> { /* start → approve(cookie) → poll */ }

// cloud/test/auth.test.ts
it('magic link: same answer for any email, single use, 15 minutes', async () => {
  expect((await post('/v1/auth/magic', { email: 'a@example.test' })).status).toBe(200);
  const cookie = await loginAs('a@example.test');
  expect(cookie).toMatch(/^aimsg_web=/);
  // 같은 토큰 재사용 → 400
});
it('GET /auth/verify does not consume the token (link scanners)', async () => { /* GET 후에도 POST 가 성공 */ });
it('rate limits per email', async () => { /* 6번째 → 여전히 200 이지만 outbox 에 5건만 */ });
it('rejects cross-origin state changes', async () => { /* origin: https://evil.test → 403 */ });

// cloud/test/hosts.test.ts
it('device-code link: pending → approved → token once', async () => {
  const s = await (await post('/v1/host/link/start', { hostName: 'Test Mac', hostPub: 'pub', uiVersion: '1.0.0' })).json() as LinkStartRes;
  expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(202);
  const cookie = await loginAs('u@example.test');
  expect((await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie })).status).toBe(200);
  const p = await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json() as LinkPollRes;
  expect(p).toMatchObject({ state: 'linked' });
  expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(410);
  const stored = await env.DB.prepare('SELECT token_hash FROM hosts').first<{ token_hash: string }>();
  expect(stored!.token_hash).not.toContain((p as { hostToken: string }).hostToken);
});
it('first link starts the 7-day trial once per email', async () => { /* 두 번째 호스트 연결에도 trials 행 그대로 */ });
it('MAX_HOSTS', async () => { /* 4번째 approve → 409 */ });

// cloud/test/pairing.test.ts
it('claim with the right secret; device limit 3; wrong secret burns the pairing after 5', async () => { /* … */ });
it('host sees devicePub+mac, confirm activates, reject revokes', async () => { /* … */ });
it('a host cannot read another host’s pairing', async () => { /* 404 */ });

// cloud/test/entitled.test.ts
it('trial and comp: larger until wins; expired → none', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 라우터는 `[method, pattern, handler]` 배열 하나로 둔다(의존성 없음). 모든 응답에 `cache-control: no-store` 를 붙이고, HTML 에는 `content-security-policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` 를 붙인다. 토큰 비교는 `timingSafeEqual` 로 한다. 시각은 모두 ms 정수다.
- [ ] **Step 5: 통과 확인** — `npm --prefix cloud ci && npm --prefix cloud run typecheck && npm --prefix cloud test` 가 PASS 하는지 본다. 공통 검증 명령 다섯 개도 돌린다.
- [ ] **Step 6: 커밋** — `feat(cloud): Workers 패키지 — 매직링크 로그인·호스트 장치 코드 연결·QR 페어링·기기 API·체험 행`

---

### Task 3: 릴레이 Durable Object (`RelayRoom`)

**Files:**
- Create: `cloud/src/relay/RelayRoom.ts`, `cloud/src/relay/routes.ts`, `cloud/src/relay/tickets.ts`, `cloud/migrations/0002_relay.sql`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`, `cloud/wrangler.jsonc`(DO 바인딩·마이그레이션·호환성 플래그), `cloud/src/devices.ts`·`cloud/src/hosts.ts`(해제 시 DO 에 알림)
- Test: `cloud/test/relay.test.ts`, `cloud/test/relay.static.test.ts`

**Interfaces:**
- `wrangler.jsonc`:
  - `durable_objects.bindings: [{ name: "RELAY", class_name: "RelayRoom" }]`
  - `migrations: [{ tag: "v1", new_sqlite_classes: ["RelayRoom"] }]` — 키 이름 **(미확인)**, Step 1 에서 확인.
  - `compatibility_flags: ["web_socket_auto_reply_to_close"]`
- `0002_relay.sql`: `CREATE TABLE relay_tickets (ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, host_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);`
- `POST /v1/relay/ticket`(device Bearer)
  - 기기가 `active` 이고, 호스트가 해제되지 않았고, `entitledState(...).untilMs > now` 여야 한다. 아니면 402 `{code:'not_entitled'}`.
  - 통과하면 `{ticket, hostId, expiresIn: 60}` 를 준다.
- `GET /relay/host`(Upgrade, host Bearer)
  - 클라이언트가 보낸 `x-relay-*` 머리는 지운다.
  - 이용권이 없으면 업그레이드 전에 402 로 거절한다.
  - 통과하면 `env.RELAY.get(env.RELAY.idFromName(hostId)).fetch(req2)` 로 넘긴다. `req2` 에는 `x-relay-role: host`, `x-relay-host`, `x-relay-user`, `x-relay-until` 을 싣는다.
- `GET /relay/device?ticket=`
  - 티켓은 `UPDATE … SET used_at=? WHERE ticket_hash=? AND used_at IS NULL AND expires_at>?` 의 `changes === 1` 일 때만 받는다.
  - 받으면 `x-relay-role: device`, `x-relay-device` 를 실어 같은 DO 로 넘긴다. 기기의 `last_seen` 을 갱신한다.
- `RelayRoom implements DurableObject`:
  - 생성자: `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`.
  - `fetch(req)`
    - `/internal/revoke {dev}` 이면 그 기기 소켓을 4403 으로 닫는다.
    - `/internal/unlink` 이면 전부 4401 로 닫는다.
    - `/internal/recheck` 이면 alarm 을 즉시 건다.
    - 그 밖에는 업그레이드다. `new WebSocketPair()` → `ctx.acceptWebSocket(server, [role === 'host' ? 'host' : `dev:${id}`])` → `server.serializeAttachment({ role, dev?, user, until })` 순서로 처리한다.
    - 같은 태그의 옛 소켓은 4409 로 닫는다.
    - 호스트가 붙으면 모든 기기에 `{t:'host',up:true}` 를 보낸다. 기기가 붙으면 호스트에게 `{t:'peer',dev,up:true}` 를, 그 기기에게 `{t:'host',up:<호스트 있음>}` 을 보낸다.
    - alarm 을 `min(until)` 로 건다.
  - `webSocketMessage(ws, msg)`
    - 문자열은 무시한다(`ping` 은 auto-response 가 처리).
    - `ArrayBuffer` 가 `MAX_FRAME` 을 넘으면 4413 으로 닫는다.
    - `decodeEnvelope` 가 실패하면 버린다.
    - 호스트가 보낸 것은 `getWebSockets('dev:'+peer)[0]` 에게 `peer='host'` 로 바꿔 보낸다. 대상이 없으면 호스트에게 `{t:'peer',dev:peer,up:false}` 를 보낸다.
    - 기기가 보낸 것은 `peer` 를 첨부의 기기 id 로 덮어써 호스트에게 보낸다. 호스트가 없으면 `{t:'host',up:false}` 를 보낸다.
  - `webSocketClose(ws, code, reason, wasClean)` — 상대에게 알린다(호스트가 닫히면 기기들에 `host up:false`).
  - `alarm()`
    - 첨부의 `user` 로 D1 의 `entitledState` 를 다시 읽는다.
    - 지났으면 모두 4402 로 닫는다. 아니면 첨부의 `until` 을 갱신하고 alarm 을 다시 건다.
  - 로그는 `console.log(JSON.stringify({ ev, host, dev, bytes, code }))` 형태로만 남기고 payload 는 기록하지 않는다.
- `webSocketError` 처리기는 쓰지 않는다. 문서에서 확인하지 못했기 때문이다 **(미확인)**. 오류는 close 로 수렴한다고 본다.

- [ ] **Step 1: API 확인** — `wrangler.jsonc` 의 DO 마이그레이션 키(`new_sqlite_classes` / `new_classes`)를 wrangler 설정 스키마(`node_modules/wrangler/config-schema.json`)에서 확인한다. 테스트에서 클라이언트 WS 를 얻는 방법(`res.webSocket` + `accept()`)과 `evictDurableObject` 시그니처를 플러그인 README 에서 확인한다. 확인한 형태를 README "확인한 버전" 에 적는다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/relay.test.ts
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { EnvKind, decodeEnvelope, encodeEnvelope, CLOSE } from '../../src/shared/cloud/frames';

async function openWs(path: string, headers: Record<string, string> = {}) {
  const res = await call(path, { headers: { upgrade: 'websocket', ...headers } });
  if (res.status !== 101) return { status: res.status, ws: null };
  const ws = res.webSocket!; ws.accept();
  const inbox: (string | ArrayBuffer)[] = []; const closes: number[] = [];
  ws.addEventListener('message', (e) => inbox.push(e.data as string | ArrayBuffer));
  ws.addEventListener('close', (e) => closes.push(e.code));
  return { status: 101, ws, inbox, closes };
}
async function pairedDevice(h: { hostToken: string; hostId: string }): Promise<{ deviceId: string; deviceToken: string }> { /* pair/start → claim → confirm */ }
async function ticketFor(deviceToken: string) { return (await (await post('/v1/relay/ticket', {}, { authorization: `Bearer ${deviceToken}` })).json() as TicketRes).ticket; }

it('host needs a valid token and an entitlement', async () => {
  expect((await openWs('/relay/host', { authorization: 'Bearer nope' })).status).toBe(401);
  const h = await linkHost();
  expect((await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` })).status).toBe(101);
  await env.DB.prepare('UPDATE trials SET ends_at = 0').run();
  expect((await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` })).status).toBe(402);
});
it('ticket is single use and expires in 60 s', async () => { /* 같은 ticket 두 번째 → 401 */ });
it('routes host→device and device→host; device cannot spoof its id', async () => {
  const h = await linkHost(); const d1 = await pairedDevice(h); const d2 = await pairedDevice(h);
  const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
  const p1 = await openWs(`/relay/device?ticket=${await ticketFor(d1.deviceToken)}`);
  const p2 = await openWs(`/relay/device?ticket=${await ticketFor(d2.deviceToken)}`);
  p2.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: new Uint8Array([7]) }));
  await waitFor(() => host.inbox!.some((m) => m instanceof ArrayBuffer));
  const got = decodeEnvelope(new Uint8Array(host.inbox!.find((m) => m instanceof ArrayBuffer) as ArrayBuffer))!;
  expect(got.peer).toBe(d2.deviceId);
  host.ws!.send(encodeEnvelope({ kind: EnvKind.Data, peer: d1.deviceId, payload: new Uint8Array([9]) }));
  await waitFor(() => p1.inbox!.some((m) => m instanceof ArrayBuffer));
  expect(p2.inbox!.filter((m) => m instanceof ArrayBuffer)).toHaveLength(0);
});
it('payload bytes pass through untouched (no decoding)', async () => { /* 임의 바이트 1000개 → 동일 */ });
it('a second host connection replaces the first with 4409', async () => { /* … */ });
it('revoking a device closes it with 4403; unlink closes all with 4401', async () => { /* … */ });
it('alarm closes everyone with 4402 once the entitlement is over', async () => {
  /* trials.ends_at = now+50ms 로 연결 → ends_at 과거로 → runDurableObjectAlarm(stub) → closes 에 4402 */
});
it('survives hibernation: attachment keeps routing after eviction', async () => { /* evictDurableObject(stub, { webSockets: true }) 뒤 기기→호스트 전달 */ });
it('oversized frame closes with 4413', async () => { /* 1 MiB + 1 */ });

// cloud/test/relay.static.test.ts — 잠들기 방해 금지
import src from '../src/relay/RelayRoom.ts?raw';
it('RelayRoom keeps no resident timers', () => {
  expect(src).not.toMatch(/setInterval|setTimeout/);
  expect(src).toMatch(/setWebSocketAutoResponse/);
  expect(src).toMatch(/acceptWebSocket/);
});
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위 Interfaces 대로 만든다. 해제·연결 끊기 라우트(Task 2)는 `ctx.waitUntil(stub.fetch('https://relay/internal/…'))` 로 DO 에 알린다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 6: 커밋** — `feat(cloud): 호스트별 릴레이 DO — Hibernation WS·일회용 티켓·출처 덮어쓰기·이용권 alarm·해제 시 종료`

---

### Task 4: 로컬 클라우드 클라이언트 — 호스트 연결·RelayClient·RelayBridge

**Files:**
- Create:
  - 설정·상태·API: `src/server/cloud/config.ts`, `src/server/cloud/CloudState.ts`, `src/server/cloud/CloudApi.ts`, `src/server/cloud/HostLink.ts`
  - 릴레이: `src/server/cloud/RelayClient.ts`, `src/server/cloud/RelayBridge.ts`, `src/server/cloud/loopback.ts`, `src/server/cloud/pathPolicy.ts`
  - 조립·도구: `src/server/cloud/CloudService.ts`, `src/server/cloud/testkit.ts`, `src/server/cloud/texts.ts`(또는 i18n 사전)
- Modify: `src/server/server.ts`, `src/server/http.ts`, `src/shared/protocol.ts`(`FEATURES` 에 `'cloud'`), `docs/protocol.md`(표에 `cloud` 행)
- Test: `src/server/cloud/config.test.ts`, `src/server/cloud/CloudState.test.ts`, `src/server/cloud/HostLink.test.ts`, `src/server/cloud/RelayClient.test.ts`, `src/server/cloud/RelayBridge.test.ts`, `src/server/cloud/pathPolicy.test.ts`, `src/server/cloud/CloudService.test.ts`, `src/server/http-cloud.test.ts`

**Interfaces:**
- `config.ts`: `cloudConfig(env: NodeJS.ProcessEnv): { enabled: boolean; baseUrl: string }`.
  - `DECK_CLOUD=off` 면 꺼진다.
  - `DECK_CLOUD_URL` 의 기본값은 `https://app.aimsg.app` 이다(D16).
  - https 만 받는다. http 는 호스트가 `127.0.0.1`·`localhost`·`[::1]` 일 때만 받고, 그 밖은 `enabled:false` 로 두고 로그 한 줄을 남긴다.
- `CloudState.ts`:
  - `type TrustedDevice = { id: string; name: string; pub: string; addedAt: number }`
  - `type CloudStateData = { v: 1; hostId: string | null; hostToken: string | null; email: string | null; hostKey: JsonWebKey; devices: TrustedDevice[]; entitlement: string | null }`
  - `class CloudState { static load(configDir: string): Promise<CloudState>; get(): CloudStateData; update(p: Partial<CloudStateData>): Promise<void>; reset(): Promise<void> }`
    - 파일은 `<configDir>/cloud/state.json`(0600, 폴더 0700, 임시 파일 → rename)이다.
    - `hostKey` 는 처음 `load` 할 때 만든다(`generateStaticKeyPair(true)` → `exportStaticPrivate`). 파일 쓰기는 첫 `update` 때 한다.
    - 깨진 파일은 `state.json.broken-<ms>` 로 옮기고 새로 시작한다.
- `CloudApi.ts`: `class CloudApi { constructor(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }); linkStart(…); linkPoll(…); unlink(token); pairStart(token, claimHash); pairStatus(token, id); pairConfirm(token, id); pairReject(token, id); devices(token); revokeDevice(token, id); entitlement(token); pushKey(); pushRegister(token, endpoint); pushUnregister(token, endpoint); pushSend(token, req) }`. 오류는 `CloudError { status: number; code?: string }` 로 던진다.
- `HostLink.ts`: `startLink(o: { api; state; hostName: string; uiVersion: string; now?; sleep? }): { info: LinkStartRes; done: Promise<'linked' | 'expired' | 'cancelled'>; cancel(): void }`. `interval` 초마다 폴링하고, 연결되면 `state.update({ hostId, hostToken, email })` 한다.
- `RelayClient.ts`: `class RelayClient extends EventEmitter`
  - 생성자: `constructor(o: { url: string /* wss://…/relay/host */; token: () => string | null; WebSocketImpl?: typeof WebSocket; backoff?: { minMs: 1000; maxMs: 60000 }; now?; random? })`
  - 메서드: `start(); stop(); send(env: Uint8Array): boolean`
  - 이벤트: `'envelope'(env)`, `'control'(json)`, `'state'(s: 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced')`
  - 연결: `ws` 라이브러리의 `new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })` 로 연다.
  - 핑: 25초마다 텍스트 `ping` 을 보내고, 60초 동안 아무 수신이 없으면 끊고 재연결한다.
  - 업그레이드 응답 처리: 401 이면 `unlinked` 로 두고 멈춘다. 402 면 `not_entitled` 로 두고, 6시간 뒤나 entitlement 가 바뀔 때 다시 시도한다.
  - 종료 코드 처리: 4401 은 `unlinked`, 4402 는 `not_entitled`, 4409 는 `replaced`(같은 호스트가 다른 곳에서 붙음 — 10분 뒤 재시도)다. 그 밖에는 지수 백오프에 ±20% 흔들림을 더해 재시도한다.
- `RelayBridge.ts`: `class RelayBridge`
  - 생성자: `constructor(o: { relay: Pick<RelayClient, 'send' | 'on'>; state: CloudState; loopback: LoopbackTarget; hostVersion: string; fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket; now? })`
  - 기기별 세션 `Map<deviceId, { channel; streams: Map<number, WebSocket>; http: Map<number, AbortController> }>`
  - 핸드셰이크
    - `hs_init` 를 받으면 `state.devices` 에서 공개키를 찾는다. 없으면 무시하고 로그 한 줄을 남긴다.
    - 찾으면 `hostHandshake` 를 하고 `hs_ack` 를 보낸 뒤 5초 안에 `ready` 를 기다린다.
  - 프레임 처리
    - `ws.open` → 루프백 WS 를 연다. 상한 8개다.
    - `http.req` → `relayPathAllowed` 가 거부하면 `http.res{st:403}` 를 돌려준다. 통과하면 `fetch(loopback + p)` 로 보내고, 응답 본문을 64KiB 조각으로 스트리밍한다. 시간 제한은 60초다.
  - 오류 처리: `DecryptError`·`ReplayError` 면 그 기기 세션을 끝내고 열린 루프백 연결을 모두 닫는다.
  - 기기 해제: `{t:'peer',dev,up:false}` 를 받으면 그 세션을 정리한다.
- `loopback.ts`: `type LoopbackTarget = { port: number; token: () => string }`, `loopbackHeaders(t): Record<string,string>`. 결과는 `{ cookie: `${COOKIE_NAME}=${cookieValueFor(token)}`, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }` 다.
- `pathPolicy.ts`: `relayPathAllowed(method: string, path: string): boolean`.
  - 허용: `/api/` 로 시작하는 경로.
  - 거부: `/api/login`, `/api/logout`, `/api/cloud/` 아래 전부. 단 `GET /api/cloud/status` 는 허용한다.
  - 거부: `..`·`%2e%2e`·`//` 가 들어간 경로, 프로토콜이 있는 절대 주소.
  - 머리는 `content-type`·`accept`·`range`·`if-none-match` 만 넘기고, 나머지는 버린다.
- `CloudService.ts`: `class CloudService`
  - 생성자: `constructor(o: { cfg: { enabled; baseUrl }; configDir: string; port: number; token: () => string; hostVersion: string; hostName: string; log: (s: string) => void; fetch?; WebSocketImpl? })`
  - 메서드: `start(): void`(대기 없음. 연결된 상태면 RelayClient 를 시작), `stop(): Promise<void>`, `status(): CloudStatus`, `startLink()`, `unlink()`, `onChange(cb)`
  - 연결하지 않은 상태면 네트워크 호출이 0건이다.
- `http.ts`: `HttpDeps.cloud?: { service: CloudService }`. 라우트는 다음과 같고, 쿠키·Origin 검사는 기존 `/api/*` 와 같다.
  - `GET /api/cloud/status` → `CloudStatus`
  - `POST /api/cloud/link/start` → `{userCode, verifyUrl, expiresAt}`. 이미 진행 중이면 같은 값을 준다.
  - `POST /api/cloud/unlink` → `{ok}`
- `CloudStatus = { enabled: boolean; linked: boolean; email: string | null; relay: 'off' | 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced'; link: { userCode: string; verifyUrl: string; expiresAt: number } | null; devices: { id: string; name: string; addedAt: number }[] }`. 이 타입은 `src/shared/cloud/api-types.ts` 에 둔다.
- `server.ts`
  - `attachWebSocket` 다음 줄에서 `cloudConfig(process.env)` 가 켜져 있을 때만 `new CloudService({...})` 를 만든다.
  - `hostVersion` 은 `packageVersion()`, `hostName` 은 `os.hostname()` 을 앞 40자로 자른 값이다. 이 값은 클라우드에만 보내고 로그에는 쓰지 않는다.
  - `start()` 후 `cleanup.push(() => cloud.stop())`. 요청 처리기 deps 에 `cloud: { service }` 를 넣는다.
  - `FEATURES` 의 `'cloud'` 는 서비스가 있을 때만 알린다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/cloud/pathPolicy.test.ts
it.each([
  ['GET', '/api/me', true], ['POST', '/api/push/subscribe', true], ['GET', '/api/cloud/status', true],
  ['POST', '/api/login', false], ['POST', '/api/logout', false], ['POST', '/api/cloud/unlink', false],
  ['POST', '/api/cloud/pair/start', false], ['GET', '/api/../etc', false], ['GET', '/api/%2e%2e/x', false],
  ['GET', '//evil.test/api/me', false], ['GET', '/index.html', false],
])('%s %s → %s', (m, p, ok) => expect(relayPathAllowed(m, p)).toBe(ok));

// src/server/cloud/RelayBridge.test.ts — FakeRelay + 루프백 흉내(쿠키 검사하는 작은 http/ws 서버)
it('a trusted device reaches the loopback with the server cookie; the phone never sees it', async () => {
  const { bridge, relay, loop, device } = await setup(); // device: shared e2ee 로 핸드셰이크하는 가짜 폰
  const res = await device.http('GET', '/api/me');
  expect(res.status).toBe(200);
  expect(loop.lastCookie).toBe(`deck_session=${cookieValueFor('tok')}`);
  expect(JSON.stringify(relay.sentPlain)).not.toContain('deck_session'); // FakeRelay 는 암호문만 봄
});
it('untrusted device key: no ack', async () => { /* state.devices 에 없는 pub → hs_ack 없음 */ });
it('blocked path never touches the loopback', async () => { /* POST /api/cloud/unlink → 403, loop.hits 0 */ });
it('phone-supplied cookie/origin headers are dropped', async () => { /* h: { cookie: 'x', origin: 'https://evil' } → loop 는 bridge 값만 */ });
it('ws stream proxied both ways and closed with the session', async () => { /* ws.open → ws.msg 왕복 → 기기 peer down → 루프백 ws 닫힘 */ });
it('large response comes back in 64 KiB chunks', async () => { /* 200 KiB → http.res + http.chunk ×3 */ });
it('replayed frame ends the device session', async () => { /* 같은 암호 프레임 재전송 → 세션 정리 */ });

// src/server/cloud/RelayClient.test.ts
it('backs off 1s→2s→4s… capped at 60s with jitter; resets after a good connection', async () => { /* 가짜 시계 */ });
it('401 upgrade → unlinked and stops; 402 → not_entitled; 4409 → replaced and waits 10 min', async () => { /* FakeRelay 응답 지정 */ });
it('pings every 25 s and reconnects after 60 s of silence', async () => { /* … */ });

// src/server/cloud/CloudService.test.ts
it('not linked: zero requests to the cloud', async () => {
  const calls: string[] = [];
  const svc = new CloudService({ ...opts, fetch: async (u) => { calls.push(String(u)); return new Response('{}'); } });
  svc.start(); await sleep(50);
  expect(calls).toEqual([]);
  expect(svc.status()).toMatchObject({ linked: false, relay: 'off' });
});
it('cloud unreachable while linked: status down, start() never throws', async () => { /* 닫힌 포트 → relay 'down' */ });

// src/server/http-cloud.test.ts
it('/api/cloud/* needs the cookie and a same-origin Origin', async () => { /* 401 / 403 */ });
it('DECK_CLOUD=off: no routes, no cloud feature', async () => { /* 404, hello.features 에 cloud 없음 */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cloud src/server/http-cloud.test.ts --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다. `FakeRelay` 는 Task 3 DO 의 라우팅 규칙(출처 덮어쓰기·제어 메시지·종료 코드)을 같은 상수(`frames.ts`)로 흉내 낸다.
- [ ] **Step 4: 통과 확인** — 위 명령과 공통 검증 명령 다섯 개를 돌린다.
- [ ] **Step 5: 커밋** — `feat(cloud): 로컬 클라우드 클라이언트 — 장치 코드 연결·바깥 WS 상주·E2EE 브리지(루프백 프록시)·/api/cloud`

---

### Task 5: 페어링 QR과 폰 UI 전송 계층 — 이정표 "폰에서 릴레이 경유 승인 성공"

**Files:**
- Create:
  - 서버: `src/server/cloud/Pairing.ts`
  - 클라우드: `cloud/src/ui.ts`
  - UI 전송·릴레이: `src/ui/transport.ts`, `src/ui/relay/keystore.ts`, `src/ui/relay/pairing.ts`, `src/ui/relay/RelayConnection.ts`, `src/ui/relay/tunnelFetch.ts`, `src/ui/relay/tunnelSocket.ts`, `src/ui/relay/blobUrl.ts`, `src/ui/relay/RelayGate.tsx`
  - UI 화면·문구: `src/ui/qr.ts`, `src/ui/cloudApi.ts`, `src/ui/components/CloudSection.tsx`, `src/ui/components/PairSheet.tsx`, `src/ui/cloudTexts.ts`(또는 i18n 사전)
  - 스모크·렌더: `scripts/smoke/relay-e2e.sh`, `scripts/smoke/relay-phone.ts`, `scripts/render/cloud-section.html`, `scripts/render/pair-sheet.html`
- Modify:
  - 서버: `src/server/http.ts`(`/api/cloud/pair/start`, `/api/cloud/pair/:id`, `/api/cloud/devices`, `/api/cloud/devices/:id/revoke`), `src/server/cloud/CloudService.ts`
  - 클라우드: `cloud/src/index.ts`, `cloud/wrangler.jsonc`(R2 `UI`)
  - UI: `src/ui/ws.ts`, `src/ui/push.ts`, `src/ui/App.tsx`, `src/ui/sessionApi.ts`, `src/ui/components/{SettingsView,Lightbox,FileMenu,ShareMenu}.tsx`, `fetchFn = fetch` 기본값을 가진 파일 전부(`sessionApi.ts`·`pins.ts`·`upload.ts`·`components/{ActivityButton,FolderPicker,ComposerSuggest,MemoryEditor,SessionCwdDialog,Sidebar,ActivitySheet,UsageSheet,Highlights,UsageView}.tsx` 와 가드 테스트가 찾는 나머지)
  - 빌드·의존성: `vite.config.ts`, `package.json`·`package-lock.json`(devDependency `qrcode-generator`)
- Test: `src/server/cloud/Pairing.test.ts`, `src/ui/transport.test.ts`, `src/ui/transport.guard.test.ts`, `src/ui/relay/pairing.test.ts`, `src/ui/relay/RelayConnection.test.ts`, `src/ui/relay/tunnelFetch.test.ts`, `src/ui/components/CloudSection.test.tsx`, `src/ui/components/PairSheet.test.tsx`, `cloud/test/ui.test.ts`

**Interfaces:**
- `Pairing.ts`: `startPairing(o: { api; state; hostVersion: string; origin: string; now?; sleep? }): Promise<{ pairingId: string; qrUrl: string; expiresAt: number; done: Promise<{ result: 'paired'; device: TrustedDevice } | { result: 'rejected' | 'expired' } > }>`
  - `claim`·`auth` 를 `randomToken(16)` 으로 만든다.
  - 2초마다 폴링한다. `verifyPairingMac` 가 실패하면 `pairReject` 후 `rejected`, 성공하면 `pairConfirm` 후 `state.devices` 에 추가하고 `paired` 다.
- http 라우트(쿠키·Origin 검사, 터널로는 `pathPolicy` 가 막음):
  - `POST /api/cloud/pair/start` → `{pairingId, qrUrl, expiresAt}`
  - `GET /api/cloud/pair/:id` → `{state: 'open' | 'paired' | 'rejected' | 'expired', deviceName?}`
  - `GET /api/cloud/devices` → 로컬 신뢰 목록과 클라우드 목록을 합친다(클라우드 실패 시 로컬만).
  - `POST /api/cloud/devices/:id/revoke` → 클라우드에서 해제하고 로컬 목록에서 지운다. 클라우드 해제가 실패해도 로컬에서는 지운다. Mac 이 핸드셰이크를 거부하므로 그것으로 충분하다.
- `cloud/src/ui.ts` — R2 바인딩 `UI`(`get(key)` → 본문·`httpMetadata`. R2 Workers API 형태 **(미확인)**, Step 1 에서 확인):
  - `GET /` → 부트스트랩 HTML. 인라인 스크립트 없이 `/static/boot.js` 를 쓴다. 이 스크립트는 `localStorage['aimsg.hostVersion']` 이 있으면 `/v/<ver>/` + 기존 search·hash 로 옮기고, 없으면 "Open Settings › Account › Connect phone on your Mac and scan the QR." 를 보여 준다.
  - `GET /v/<ver>/*` → R2 `v/<ver>/…`. 없으면 404. 해시가 붙은 자산은 `cache-control: public, max-age=31536000, immutable` 이고, `index.html` 은 `no-store` 다.
  - `GET /sw.js`·`/manifest.webmanifest`·`/icons/*` → R2 `latest/…` 를 `no-cache` 로 준다.
  - CSP: `default-src 'self'; connect-src 'self' wss://<host>; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`. `style-src` 는 기존 UI 의 인라인 스타일 사용 여부를 Step 1 에서 확인하고, 필요 없으면 `'unsafe-inline'` 을 뺀다.
- `vite.config.ts`: `mode === 'relay'` 면 `define.__AIMSG_RELAY__ = 'true'`, 아니면 `'false'` 다. base 는 CLI `--base` 를 그대로 쓴다. `src/ui/vite-env.d.ts` 에 `declare const __AIMSG_RELAY__: boolean` 을 더한다.
- `transport.ts`:
  - `isRelayMode(): boolean`(= `__AIMSG_RELAY__`)
  - `apiFetch(input: string, init?: RequestInit): Promise<Response>` — 릴레이 모드면 `tunnelFetch`, 아니면 `fetch(input, { credentials: 'same-origin', ...init })`.
  - `openSocket(): WebSocketLike` — 릴레이 모드면 `connection.openStream()`, 아니면 `new WebSocket(`${proto}://${location.host}/ws`)`.
  - `setRelayConnection(c: RelayConnection | null): void`
- `keystore.ts`:
  - `type RelayIdentity = { deviceId: string; deviceToken: string; hostId: string; hostPub: string; hostVersion: string; key: StaticKeyPair }`
  - `interface KeyStore { load(): Promise<RelayIdentity | null>; save(i: RelayIdentity): Promise<void>; clear(): Promise<void> }`
  - 구현은 `indexedDbKeyStore()`(DB `aimsg-relay`, 저장소 `identity`, `CryptoKey` 를 구조화 복제로 저장)와 `memoryKeyStore()` 둘이다.
- `relay/pairing.ts`: `handlePairHash(o: { hash: string; store: KeyStore; fetch?: typeof fetch; deviceName: string; hostVersion: string }): Promise<'paired' | 'none' | { error: string }>` — `history.replaceState` 로 조각을 지운다. `deviceName` 은 `navigator.userAgentData?.platform ?? 'Phone'` 에서 만든 짧은 이름이다.
- `RelayConnection.ts`: `class RelayConnection`
  - 생성자: `constructor(o: { store: KeyStore; origin: string; uiVersion: string; WebSocketImpl?; fetch? })`
  - 상태: `'pairing_needed' | 'connecting' | 'host_offline' | 'up' | 'not_entitled' | 'revoked'`
  - 메서드: `start(); stop(); onState(cb); http(req): Promise<Response>; openStream(): WebSocketLike`
  - 흐름: `POST /v1/relay/ticket` → `wss://<origin>/relay/device?ticket=` → `hs_init` → `hs_ack` → `ready` 순서다.
  - 버전: `hostVersion !== uiVersion` 이면 `localStorage['aimsg.hostVersion'] = hostVersion` 후 `location.replace('/v/<hostVersion>/' + location.search)` 한다.
  - 재연결: 1→30초 백오프. 앱이 보이게 될 때(`visibilitychange`)는 즉시 시도한다.
- `tunnelSocket.ts`: `WebSocketLike` 는 `readyState`·`send`·`close`·`onopen`·`onmessage`·`onclose`·`onerror` 만 갖는다. `src/ui/ws.ts` 가 쓰는 것이 이것뿐인지 Step 3 에서 확인하고, 더 있으면 같이 흉내 낸다.
- `blobUrl.ts`: `useApiUrl(path: string | null): string | null` — 일반 모드는 그대로 돌려준다. 릴레이 모드는 `apiFetch` → `URL.createObjectURL` 하고, 언마운트 때 `revokeObjectURL` 한다. `openApiUrl(path)` 는 릴레이 모드에서 blob 을 새 탭으로 연다(`FileMenu.tsx:246`).
- `ShareMenu.tsx:13`: 릴레이 모드의 세션 링크는 `${location.origin}/v/<ver>/?session=<id>` 다.
- `RelayGate.tsx`: 릴레이 모드에서 `App.tsx` 가 `Login` 대신 그린다. 상태별 문구와 동작(QR 다시 찍기 안내, Mac 오프라인, 구독 필요 → 계정 페이지 링크, 기기 해제됨 → 다시 연결)을 맡는다. `up` 이면 앱을 그대로 보여 준다.
- `CloudSection.tsx`(설정 › 계정)
  - 행 1 "클라우드 연결": 미연결이면 [연결하기] → 코드·주소를 보여 주고 상태를 폴링한다. 연결되면 이메일·[끊기]다.
  - 행 2 "폰 연결": [QR 보기] → `PairSheet` 를 연다.
  - 행 3 "연결된 기기": 이름·추가일·[해제].
  - 릴레이 모드(폰 자신)에서는 행 1·2 를 숨긴다. 그 경로는 `pathPolicy` 가 막는다.
- `PairSheet.tsx`
  - `Sheet` + `SheetHead`.
  - QR 은 `qrSvgPath` 로 그린 SVG `<path>` 다. 흰 바탕에 4모듈 여백을 둔다(다크 테마에서도 흰 바탕이라 대비가 확보된다).
  - 남은 시간을 보여 주고, 만료되면 [새 QR] 을 띄운다. 상태 문구는 "폰 카메라로 찍으세요" → "확인 중" → "연결됨: <기기>" / "확인 실패 — 다시 시도" 순서다.
- `transport.guard.test.ts`: `src/ui/**/*.{ts,tsx}` 가운데 테스트가 아니고, `transport.ts`·`relay/` 도 아닌 파일에서 `/\bfetch\(/`·`/=\s*fetch\b/`·`/new WebSocket\(/` 이 나오면 실패한다.
- `scripts/smoke/relay-e2e.sh`(로컬만, 저장소 `dist/` 무변경)
  1. 임시 디렉터리 `T` 를 만든다. 테스트용 Ed25519·VAPID·세션 비밀을 생성해 `cloud/.dev.vars` 를 쓴다(gitignore, 끝나면 `trap` 으로 지움).
  2. `npx --prefix cloud wrangler dev --local --port $CP --persist-to "$T/wr" --var DEV_ROUTES:1` 를 띄운다. `--persist-to`·`--var` 플래그는 **(미확인)** 이라 Step 1 에서 `wrangler dev --help` 로 확인하고, 없으면 `.dev.vars` 로 대신한다.
  3. 계획 ② 의 `scripts/smoke/fake-claude.mjs` 를 `"$T/bin/claude"` 로 감싸 PATH 앞에 둔다.
  4. 저장소 서버를 띄운다: `DECK_CONFIG_DIR="$T/conf" HOME="$T/home" DECK_LOOPBACK_ONLY=1 DECK_PORT=$DP DECK_CLOUD_URL=http://127.0.0.1:$CP npx tsx src/server/main.ts`
  5. `npx tsx scripts/smoke/relay-phone.ts $DP $CP "$T/conf/token" "$T/work"` 를 실행한다.
- `scripts/smoke/relay-phone.ts`
  1. 로컬 API 에 로그인한다(`turn.mjs` 와 같은 방식).
  2. `POST /api/cloud/link/start` 를 보낸다.
  3. 클라우드 `/v1/auth/magic` 을 보내고 `/dev/outbox` 에서 토큰을 꺼내 `POST /auth/verify` 로 로그인한다.
  4. `POST /v1/host/link/approve` 를 보내고, `/api/cloud/status` 가 `linked`·`relay:'up'` 이 될 때까지 기다린다.
  5. `POST /api/cloud/pair/start` → QR 주소를 파싱한다.
  6. **가상 폰**이 공유 e2ee 로 claim → Mac 확정을 기다린다 → 티켓 → `wss` → 핸드셰이크 → `ws.open` 순서로 진행한다.
  7. 터널 WS 로 `send`(프롬프트 "approve") → `permission_request` 를 받는다 → `permission_response{allow}` 를 보낸다 → `turn_result` 를 받는다.
  8. `relay-e2e: 승인 → allow hook=… mcp=…` 를 출력하고 0 으로 끝난다. 60초 안에 끝나지 않으면 마지막 메시지 12개와 함께 1 로 끝난다.

- [ ] **Step 1: 확인** — 다음 셋을 확인한다.
  - R2 바인딩 API(`get`·`put`·`httpMetadata`)를 Workers 타입 정의와 플러그인 README 로 확인한다.
  - `wrangler dev` 의 `--persist-to`·`--var` 플래그를 확인한다.
  - `src/ui/ws.ts` 가 쓰는 WebSocket 멤버를 확인한다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/ui/transport.guard.test.ts
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.join(__dirname);
const files = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('transport.ts') && !f.includes(`${path.sep}relay${path.sep}`));
it('no direct fetch / WebSocket outside the transport', () => {
  const bad = files.flatMap((f) => { const s = fs.readFileSync(f, 'utf8'); return [/\bfetch\(/, /=\s*fetch\b/, /new WebSocket\(/].filter((r) => r.test(s)).map(() => path.relative(ROOT, f)); });
  expect(bad).toEqual([]);
});

// src/ui/relay/RelayConnection.test.ts — @vitest-environment node, memoryKeyStore, 가짜 WS 위에 가짜 호스트(shared e2ee)
it('ticket → handshake → up; http() returns the host response', async () => { /* … expect(res.status).toBe(200) */ });
it('host version differs → stores it and moves to /v/<ver>/', async () => { /* location.replace 스파이 */ });
it('402 on ticket → not_entitled; 4403 → revoked and identity cleared', async () => { /* … */ });
it('streams: ws.open/ws.msg map to a WebSocketLike the app can use', async () => { /* … */ });

// src/ui/relay/pairing.test.ts
it('#pair= → claim with mac over devicePub, saves identity, clears the hash', async () => { /* fetch 스파이로 본문 검사: claim, devicePub, mac; auth 는 본문에 없음 */ });

// src/server/cloud/Pairing.test.ts
it('mac ok → confirm + trusted; mac bad → reject, not trusted', async () => { /* fakeCloudFetch */ });
it('expires after 5 minutes', async () => { /* … */ });

// src/ui/components/PairSheet.test.tsx
it('shows the QR, counts down, offers a new QR when expired; close returns focus', async () => { /* … */ });
it('touch targets are 44px on phone', () => { /* .sheet-head 버튼 min-height */ });

// src/ui/components/CloudSection.test.tsx
it('not linked → 연결하기 → code shown → linked (email)', async () => { /* … */ });
it('relay mode hides link and pair rows', () => { /* … */ });

// cloud/test/ui.test.ts — R2 에 테스트 객체를 put 한 뒤
it('/v/<ver>/ serves the versioned build, / boots, /sw.js from latest', async () => { /* … CSP 머리 확인 */ });
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/server/cloud src/ui/relay src/ui/transport.test.ts src/ui/transport.guard.test.ts src/ui/components/CloudSection.test.tsx src/ui/components/PairSheet.test.tsx --maxWorkers=2` 와 `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
  - `fetchFn = fetch` 기본값을 모두 `fetchFn = apiFetch` 로 바꾼다. 테스트가 `fetchFn` 을 주입하는 방식은 그대로다.
  - `Lightbox.tsx` 의 `attachmentUrl` 을 쓰는 곳은 `useApiUrl(attachmentUrl(id))` 로, `sessionApi.ts:143` 의 `rawFileUrl` 을 쓰는 이미지·다운로드는 `useApiUrl`/`openApiUrl` 로 바꾼다.
  - `App.tsx` 는 `isRelayMode()` 면 `RelayGate` 로 감싸고 `Login` 을 그리지 않는다.
  - `push.ts` 의 `post` 는 `apiFetch` 를 쓴다.
- [ ] **Step 5: 통과 확인** — 위 명령, cloud 검증 세 개, 공통 검증 명령 다섯 개를 돌린다. `npx vite build --mode relay --base /v/0.0.0-test/ --outDir "$(mktemp -d)"` 도 성공하는지 본다.
- [ ] **Step 6: 이정표 확인** — `bash scripts/smoke/relay-e2e.sh` 가 `relay-e2e: 승인 → allow …` 를 출력하고 0 으로 끝나는지 본다. 실행 중인 9320 서버에는 아무것도 보내지 않는다.
- [ ] **Step 7: 화면 확인** — `scripts/render/cloud-section.html`·`pair-sheet.html` 픽스처(합성 이메일 `user@example.test`, 기기 이름 `Phone`)로 `scripts/render-check.sh` 를 360·412·1440 폭에서 돌린다.
- [ ] **Step 8: 커밋** — `feat(cloud): QR 페어링·폰 UI 터널 전송(apiFetch·터널 WS·blob 자산)·클라우드의 버전별 UI — 폰에서 릴레이 경유 승인 e2e`

---

### Task 6: 클라우드 경유 웹 푸시

**Files:**
- Create: `cloud/src/push/vapid.ts`, `cloud/src/push/send.ts`, `cloud/migrations/0003_push.sql`, `cloud/scripts/gen-vapid.mjs`, `src/server/cloud/pushRelay.ts`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`VAPID_PUBLIC`, `VAPID_PRIVATE_JWK`, `VAPID_SUBJECT`), `src/server/push/SubscriptionStore.ts`, `src/server/push/PushNotifier.ts`, `src/server/http.ts`, `src/server/server.ts`, `src/server/cloud/CloudService.ts`(VAPID 공개키 캐시), `src/ui/push.ts`
- Test: `cloud/test/push.test.ts`, `src/server/cloud/pushRelay.test.ts`, `src/server/push/PushNotifier.test.ts`(추가), `src/server/push/SubscriptionStore.test.ts`(추가), `src/server/http.test.ts`(추가), `src/ui/push.test.ts`(있으면 추가, 없으면 생성)

**Interfaces:**
- `0003_push.sql`: `CREATE TABLE push_endpoints (host_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (host_id, endpoint_hash));`
- `GET /v1/push/key` → `{publicKey}`(VAPID 공개키, base64url 65바이트).
- `POST /v1/push/register {endpoint}` / `POST /v1/push/unregister {endpoint}`(host Bearer + 이용권) — endpoint 하나당 해시 하나를 저장한다.
- `POST /v1/push/send`(host Bearer + 이용권, 호스트당 시간당 600회)
  - 요청 본문: `PushSendReq = { endpoint: string; ttl: number; urgency: 'normal' | 'high'; encoding: 'aes128gcm'; body: string /* base64, ≤ 4096 B */ }`
  - 검사:
    - endpoint 는 https 여야 한다.
    - 호스트가 허용 목록 `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com` 에 있어야 한다. 접미사는 점 경계로 비교한다.
    - `(host_id, sha256(endpoint))` 가 등록돼 있어야 한다. 아니면 403 이다.
  - 전달: `fetch(endpoint, { method: 'POST', headers: { TTL, Urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: `vapid t=<jwt>, k=<VAPID_PUBLIC>` }, body })`
  - 응답은 `{status}` 로 push 서비스 상태를 그대로 전한다. 404/410 이면 등록 행을 지운다.
- `vapid.ts`: `vapidJwt(o: { aud: string; sub: string; privateJwk: JsonWebKey; nowSec: number }): Promise<string>`
  - ES256 이다(`{name:'ECDSA', namedCurve:'P-256'}`, `sign({name:'ECDSA', hash:'SHA-256'})`). WebCrypto 서명은 r‖s 64바이트라 JWS 형식에 그대로 맞는다.
  - `exp = nowSec + 12h`.
- `pushRelay.ts`: `makeCloudPushSender(o: { api: CloudApi; token: () => string | null }): PushSender`
  - `web-push` 의 `generateRequestDetails(sub, payload, { TTL, urgency, vapidDetails: null })` 로 암호문 본문과 머리를 만든다. 3.6.7 소스에서 `vapidDetails` 가 없으면 `Authorization` 을 붙이지 않는 것을 확인했다.
  - 본문을 base64 로 바꿔 `api.pushSend` 로 보낸다.
  - 클라우드가 `{status: 404 | 410}` 을 돌려주면 `statusCode` 를 가진 오류를 던져, 기존 `deliver` 의 정리 경로를 그대로 탄다.
- `SubscriptionStore.ts`: `PushSub = { endpoint; keys; vapid?: 'local' | 'cloud' }`. `parseSubscription` 은 `vapid` 를 `'cloud'` 일 때만 보존한다.
- `PushNotifier.ts` 생성자 옵션에 `cloudSend?: PushSender` 를 더한다. `deliver` 는 이렇게 바뀐다.
  - `sub.vapid === 'cloud'` 면 `cloudSend` 가 없을 때(미연결·꺼짐) `'fail'` 이고 구독은 지우지 않는다. 있으면 본문을 `relayPayload(payload)` 로 줄여 보낸다.
  - 그 밖에는 기존 경로를 탄다.
  - `relayPayload(p)` 는 `{ ...p, body: KIND_LABEL[p.kind] }` 다. 제목(세션 제목)·종류·태그·sessionId 는 유지하고, 본문에서 명령·코드 줄을 뺀다(스펙 §5.3).
- `http.ts`
  - `GET /api/push/key` → `{ publicKey, relayPublicKey? }`. `relayPublicKey` 는 클라우드에 연결돼 있고 마지막 `pushKey()` 가 성공했을 때만 싣는다.
  - `POST /api/push/subscribe` 본문의 `vapid: 'cloud'` 를 받는다. 이때 `cloud.service.registerPush(endpoint)` 가 실패하면 503 이다.
  - `unsubscribe` 는 cloud 구독이면 클라우드 등록도 지운다.
- `push.ts`(UI): 릴레이 모드면 `applicationServerKey = relayPublicKey` 이고 `subscribe` 본문에 `vapid: 'cloud'` 를 싣는다. `relayPublicKey` 가 없으면 "Pro 구독이 필요하거나 Mac 이 클라우드에 연결돼 있지 않습니다" 를 보여 준다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// cloud/test/push.test.ts
it('SSRF: private hosts, http, unlisted hosts are refused', async () => {
  const h = await linkHost();
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/x', 'https://evil.test/x', 'https://fcm.googleapis.com.evil.test/x'])
    expect((await post('/v1/push/send', { endpoint, ttl: 60, urgency: 'normal', encoding: 'aes128gcm', body: 'AA==' }, { authorization: `Bearer ${h.hostToken}` })).status).toBe(400);
});
it('unregistered endpoint → 403; not entitled → 402', async () => { /* … */ });
it('adds a verifiable VAPID JWT and forwards bytes unchanged', async () => {
  /* outbound fetch 를 env 주입 `PUSH_FETCH`(테스트 전용 바인딩 아님 — send.ts 가 `deps.fetch` 를 받게 하고 index 에서 globalThis.fetch 로 묶음) 로 가로채
     Authorization 의 jwt 를 VAPID_PUBLIC 으로 crypto.subtle.verify → true, aud = 'https://fcm.googleapis.com', body 바이트 동일 */
});
it('404/410 from the push service unregisters the endpoint', async () => { /* … */ });

// src/server/cloud/pushRelay.test.ts
it('encrypts on the Mac: the cloud request has ciphertext only', async () => {
  const sent: PushSendReq[] = [];
  const send = makeCloudPushSender({ api: { pushSend: async (_t, r) => { sent.push(r); return { status: 201 }; } } as never, token: () => 't' });
  await send(sub, JSON.stringify({ kind: 'permission', title: 'S', body: 'rm -rf build', sessionId: 's', tag: 'x' }), { TTL: 60, urgency: 'high' });
  expect(Buffer.from(sent[0]!.body, 'base64').toString('latin1')).not.toContain('rm -rf');
  expect(sent[0]).toMatchObject({ encoding: 'aes128gcm', urgency: 'high', ttl: 60 });
});

// src/server/push/PushNotifier.test.ts (추가)
it('cloud subscriptions get the kind label only, local ones keep the body', async () => { /* sends 스파이 2개 */ });
it('cloud subscription without a cloud sender: fail, not removed', async () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — `npm --prefix cloud test` 와 `npx vitest run src/server/push src/server/cloud src/server/http.test.ts --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다. `gen-vapid.mjs` 는 `crypto.subtle.generateKey(ECDSA P-256)` 로 키를 만든다. 공개키(raw base64url)는 stdout 에, 개인 JWK 는 `--out <파일>`(0600, 저장소 밖 경로만 허용 — 저장소 안이면 거부)에 쓴다.
- [ ] **Step 4: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 5: 커밋** — `feat(push): 클라우드 경유 웹 푸시 — Mac 이 암호화·클라우드는 VAPID 서명만, endpoint 허용 목록·등록 확인, 최소 본문`

---

### Task 7: entitlement 서명·검증과 7일 체험 상태

**Files:**
- Create: `cloud/src/entitlement.ts`, `cloud/scripts/gen-entitlement-key.mjs`, `src/shared/pro.ts`, `src/server/cloud/Entitlement.ts`, `src/server/cloud/entitlement-keys.json`, `src/server/pro/features.ts`, `src/server/pro/gate.ts`, `src/ui/pro.ts`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`ENTITLEMENT_SIGNING_JWK`, `ENTITLEMENT_KID`), `src/server/cloud/CloudService.ts`, `src/server/server.ts`, `src/server/http.ts`(`POST /api/cloud/entitlement/refresh`, `status.pro`), `src/server/ws.ts`(`hello.pro`, `settings.pro`), `src/shared/protocol.ts`(`FEATURES` 에 `'pro'`, `hello.pro?`, `settings.pro?`), `docs/protocol.md`(`pro` 행), `src/ui/components/CloudSection.tsx`(요금제 행)
- Test: `cloud/test/entitlement.test.ts`, `src/server/cloud/Entitlement.test.ts`, `src/server/pro/gate.test.ts`, `src/server/ws.pro.test.ts`, `src/ui/components/CloudSection.test.tsx`(추가)

**Interfaces:**
- `GET /v1/entitlement`(host Bearer) → `{ jws, claims }`.
  - `entitledState` 결과를 클레임으로 바꾼다. `plan` 은 trial/comp/pro/none, `st` 는 `trialing`/`active`/`past_due`/`canceled`/`none`, `until = untilMs/1000` 이다.
  - `exp = entitlementExp(...)` 로 정한다.
  - 개인키는 `importKey('jwk', ENTITLEMENT_SIGNING_JWK, {name:'Ed25519'}, false, ['sign'])` 로 읽는다. Workers 에서 Ed25519 를 `jwk` 형식으로 가져오는지는 **(미확인)** 이라 Step 1 에서 확인한다. 안 되면 `pkcs8` 로 하고 `gen-entitlement-key.mjs` 출력도 그에 맞춘다.
  - `plan: 'none'` 이어도 서명한 토큰을 준다. 로컬이 "만료됨" 을 확정할 수 있게 하려는 것이다.
- `gen-entitlement-key.mjs --kid <kid> --out <저장소 밖 경로>`: 공개 JWK 를 `{kid, jwk}` JSON 으로 stdout 에 쓰고, 개인 JWK 는 파일(0600)에 쓴다. 출력 경로가 저장소 안이면 거부한다.
- `entitlement-keys.json`: `{ "keys": { "<kid>": { "kty": "OKP", "crv": "Ed25519", "x": "…" } } }`.
  - 처음에는 `{ "keys": {} }` 로 커밋한다. 이 상태에서는 어떤 토큰도 통과하지 못한다(검증 실패 → Community).
  - 실제 키는 사용자가 생성해 넣는다(사용자 몫). Task 11 의 출시 검사가 비어 있지 않음을 요구한다.
- `src/shared/pro.ts`:
  - `PRO_FEATURES = ['accounts', 'routeFull', 'handoff', 'bottleneck', 'autoRetry', 'commander', 'relay'] as const`, `type ProFeature = typeof PRO_FEATURES[number]`
  - `type ProStatus = { tier: 'community' | 'trial' | 'pro'; until: string | null /* ISO */; offlineUntil: string | null; features: ProFeature[]; reason: 'not_linked' | 'no_plan' | 'expired' | 'verify_failed' | null }`
- `features.ts`: `export const PRO_ENFORCE = false`. 출시 스위치다. Task 11 의 마지막 단계에서 `true` 로 바꾸고, 그 전까지는 게이트가 판정만 하고 막지 않는다(D6).
- `gate.ts`: `class ProGate`
  - 생성자: `constructor(o: { enforce?: boolean /* 기본 PRO_ENFORCE */; now?: () => number })`
  - 메서드: `set(claims: EntitlementClaims | null, reason: ProStatus['reason']): void; status(): ProStatus; has(f: ProFeature): boolean; onChange(cb): () => void`
  - `has` 는 `!enforce || (claims && now < exp && plan !== 'none')` 다.
  - 진행 중인 턴은 호출 지점이 판단 시점에만 `has` 를 묻기 때문에 영향받지 않는다.
- `Entitlement.ts`: `class EntitlementManager`
  - 생성자: `constructor(o: { api: CloudApi; state: CloudState; gate: ProGate; keys?: Record<string, JsonWebKey>; hostId: () => string | null; now?; setTimer? })`
  - 메서드: `start()`(저장된 토큰을 검증해 `gate.set` → 연결돼 있으면 즉시 갱신 → 24시간 ±1시간마다), `refresh(): Promise<ProStatus>`, `stop()`
  - 갱신이 실패(네트워크·5xx)하면 저장된 토큰을 유지한다. 서명 검증에 실패한 새 토큰은 버린다(저장하지 않음).
- protocol·ws
  - `hello.pro?: ProStatus` 는 `FEATURES` 에 `'pro'` 가 있을 때 싣는다. 클라우드가 꺼져 있어도 `'pro'` 는 알린다(Community 상태 표시).
  - `ProGate.onChange` 가 불리면 서버는 기존 `settings` 방송에 `pro` 필드를 함께 싣는다. 새 메시지 종류는 없다.
  - `RelayClient` 는 `gate.onChange` 에서 `not_entitled` 상태면 즉시 재시도한다.
- `ui/pro.ts`: `proHas(f: ProFeature, s: { features: Features; pro?: ProStatus }): boolean` — `!has('pro')` 면 `true` 다(옛 서버 = 게이트 없음).
- `CloudSection.tsx` 요금제 행에 보일 문구:
  - "Community"
  - "체험 중 · N일 남음"
  - "Pro · <날짜>까지"
  - "오프라인 — <날짜>까지 Pro 유지"
  - "만료됨"
  - 버튼은 [새로고침], 그리고 Task 10 이 더하는 [구독 관리]다.

- [ ] **Step 1: 확인** — Workers 의 Ed25519 `importKey` 형식(`jwk`/`pkcs8`)을 테스트 하나로 확인한다. 형식을 결정하고 README 에 적는다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/entitlement.test.ts — 실행 중 생성한 키를 env 에 넣는 helper(withSigningKey)
it('trial user gets a signed trial token whose exp ≤ trial end', async () => { /* verifyEntitlement(공유 모듈)로 검증 */ });
it('comp grant → plan comp, st active, exp = iat + 7d', async () => { /* … */ });
it('no plan → signed none token with exp = iat', async () => { /* … */ });
it('token is bound to the calling host (hid)', async () => { /* … */ });

// src/server/cloud/Entitlement.test.ts — 실행 중 생성한 키를 keys 로 주입
it('online: refresh stores and opens Pro', async () => { /* gate.status().tier === 'pro' */ });
it('offline within exp keeps Pro (offlineUntil set); past exp drops to community/expired', async () => { /* now 주입 */ });
it('a token signed by an unknown key is ignored and not stored', async () => { /* … */ });
it('a corrupted stored token → community/verify_failed, server keeps running', async () => { /* … */ });
it('empty entitlement-keys.json → nothing verifies', async () => { /* 실제 파일 import → keys {} */ });

// src/server/pro/gate.test.ts
it('enforce=false: has() is always true but status() still reports the tier', () => { /* … */ });
it('enforce=true: community has nothing; trial/pro have every feature', () => { /* … */ });

// src/server/ws.pro.test.ts
it('hello carries pro; a gate change rides on the settings broadcast', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — 위 테스트 파일들이 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 6: 커밋** — `feat(pro): Ed25519 entitlement 발급·로컬 검증·24시간 갱신·7일 오프라인 유예, ProGate(출시 스위치 꺼짐), hello/settings.pro`

---

### Task 8: Pro 기능 게이트 — 오픈코어 경계

**Files:**
- Modify:
  - 서버: `src/server/server.ts`(`:273`·`:326` 순환, `:303-311` BottleneckWatch, `:337` Commander, `routeTier` 주입), `src/server/push/BottleneckWatch.ts`(`allow?`), `src/server/routing/AutoRoute.ts`(`RouteInput.candidateLimit?`·`resetPromotion?`, `:485`, `:522`), `src/server/turn/TurnRunner.ts`(`routeTier?` 의존성, `:1609` g2, `:1613` 호출, `:1951` `previewRoute`), `src/server/ws.ts`(계정 고정·`msg.handoff`·`retryDue`·commander 문구)
  - 공유: `src/shared/protocol.ts`(`error.code` 에 `'pro_required'` 설명)
  - UI: `src/ui/components/Pane.tsx`(`:120-122`), `src/ui/components/ContextGauge.tsx`(ContextHint), `src/ui/components/AccountPicker.tsx`, `src/ui/components/SettingsView.tsx`(순환·총사령탑 토글 잠금 표시), `src/ui/components/UsageSheet.tsx`(Community 는 벤더당 홈 좌석만)
  - 문서: `docs/protocol.md`(`pro_required`)
- Test: `src/server/routing/AutoRoute.test.ts`(추가), `src/server/push/BottleneckWatch.test.ts`(추가), `src/server/ws.pro.test.ts`(추가), `src/server/turn/TurnRunner` 관련 기존 테스트 파일(추가), `src/ui/components/AccountPicker.test.tsx`(추가), `src/ui/components/ContextGauge.test.tsx`(추가)

**Interfaces:**

| ProFeature | 게이트 지점 | Community 동작 |
|---|---|---|
| `accounts` | `server.ts:273`·`:326` 의 순환을 `pro.has('accounts') && …`. `ws.ts` 계정 고정에서 홈이 아닌 id 는 `error{code:'pro_required'}`. `TurnRunner.ts:1609` 에서 `g2: pro.has('accounts') && …` | 벤더당 홈 계정 1개. 다른 계정의 기록 보기·가져오기·사용량 숫자는 그대로(D13) |
| `routeFull` | `TurnRunner` 가 `chooseRoute`·`previewRoute` 에 `candidateLimit: has ? Infinity : 2`, `resetPromotion: has` 를 넘김. `AutoRoute.ts:485` `cellOf(...).slice(0, input.candidateLimit ?? Infinity)`, `:522` 블록은 `input.resetPromotion !== false` 일 때만 | 후보 1·2순위, 리셋 승격 없음(스펙 §4) |
| `handoff` | `ws.ts` 의 `send` 처리에서 `msg.handoff === true && !pro.has('handoff')` → `pro_required`. UI `Pane.tsx:120` 은 보내기 전에 `proHas('handoff')` 확인 | ContextHint 는 "새 세션으로 이어가기: 요약을 복사해 새 세션에 붙여 넣으세요" 안내 + "Pro 로 한 번에" 링크(설정 › 계정) |
| `bottleneck` | `BottleneckWatch` `allow('renotify')` | 첫 푸시만, 재알림 없음 |
| `autoRetry` | `BottleneckWatch` `allow('retry')`, `ws.ts` 의 `retryDue` | 리셋 시각 자동 재시도 없음(실패 카드에 "다시 보내기" 그대로) |
| `commander` | `server.ts:337` `enabled: () => settings.get().commanderEnabled === true && pro.has('commander')` | 총사령탑 꺼짐(D7). 설정 토글은 잠금 표시 |
| `relay` | 클라우드가 판단(Task 3·6) | LAN·사용자 Tailscale |

- `BottleneckWatch` 생성자 옵션: `allow?: (what: 'renotify' | 'retry') => boolean`(기본 항상 true).
- `RouteInput` 추가: `candidateLimit?: number; resetPromotion?: boolean`(둘 다 없으면 지금 동작).
- `TurnRunner` deps 추가: `routeTier?: () => { candidateLimit: number; resetPromotion: boolean }`.
- `ws.ts` 거절 문구: "Pro 기능입니다 — 설정 › 계정에서 체험을 시작하거나 구독하세요" 형태로, `code: 'pro_required'` 와 `feature` 이름을 싣는다. `error` 메시지에 선택 필드 `feature?: ProFeature` 를 더한다. UI 는 이 코드면 토스트에 [설정 열기] 를 붙인다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/routing/AutoRoute.test.ts (추가)
it('candidateLimit 2 never picks the 3rd candidate even when 1·2 are blocked', () => {
  const d = chooseRoute({ ...base, limits: blocked(['first', 'second']), candidateLimit: 2 });
  expect(d.kind).toBe('no_route');
});
it('resetPromotion false skips 리셋 승격', () => {
  const d = chooseRoute({ ...promoCase, resetPromotion: false });
  expect(d.kind === 'route' && d.why.some((w) => w.startsWith('리셋 승격'))).toBe(false);
});
it('defaults keep today’s behaviour', () => { /* 기존 기대값 그대로 */ });

// src/server/push/BottleneckWatch.test.ts (추가)
it('allow(renotify)=false: no reminder pushes; allow(retry)=false: booked retry not fired', () => { /* … */ });

// src/server/ws.pro.test.ts (추가) — ProGate({ enforce: true }) community
it('pin to a non-home account → error pro_required (feature accounts)', async () => { /* … */ });
it('send with handoff → error pro_required (feature handoff), no turn started', async () => { /* … */ });
it('commander_set while community → commander_disabled', async () => { /* … */ });
it('same flows succeed with a trial claim', async () => { /* … */ });
it('enforce=false (PRO_ENFORCE default): nothing is refused', async () => { /* … */ });

// src/ui/components/ContextGauge.test.tsx (추가)
it('community: hint shows guidance and a Pro link instead of the one-click button', () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — 해당 테스트들이 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 표대로 만든다. 게이트는 모두 `ProGate.has` 하나를 거친다. 호출 지점에서 `PRO_ENFORCE` 를 직접 보지 않는다.
- [ ] **Step 4: 통과 확인** — 공통 검증 명령 다섯 개를 돌린다. 기존 라우팅·병목·총사령탑 테스트가 무변경으로 통과해야 한다(enforce 기본값 false).
- [ ] **Step 5: 커밋** — `feat(pro): 오픈코어 경계 — 계정 수·자동 분배 후보·원클릭 인계·병목 재알림·자동 재시도·총사령탑을 ProGate 로`

---

### Task 9: Paddle 웹훅과 구독 상태

**Files:**
- Create: `cloud/src/paddle/signature.ts`, `cloud/src/paddle/webhook.ts`, `cloud/src/paddle/apply.ts`, `cloud/migrations/0004_billing.sql`, `cloud/test/fixtures/paddle/{subscription.created,subscription.activated,subscription.updated,subscription.past_due,subscription.canceled,transaction.completed,adjustment.created}.json`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV: 'sandbox' | 'production'`, `PADDLE_IP_CHECK: '0' | '1'`), `cloud/src/entitled.ts`(구독 반영)
- Test: `cloud/test/paddle.signature.test.ts`, `cloud/test/paddle.webhook.test.ts`, `cloud/test/entitled.test.ts`(추가)

**Interfaces:**
- `0004_billing.sql`:

```sql
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), customer_id TEXT, status TEXT NOT NULL, price_id TEXT, period_end INTEGER, canceled_at INTEGER, scheduled_cancel INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE paddle_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE refunds (adjustment_id TEXT PRIMARY KEY, transaction_id TEXT, subscription_id TEXT, status TEXT NOT NULL, occurred_at INTEGER NOT NULL);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
```

- `signature.ts`: `verifyPaddleSignature(header: string | null, rawBody: string, secret: string, nowSec: number, toleranceSec = 5): Promise<boolean>`
  - 머리 형식은 `ts=<unix>;h1=<hex>` 이고 `h1` 이 여럿일 수 있다(비밀 교체 대비, 하나만 맞으면 통과).
  - 서명 대상은 `${ts}:${rawBody}` 이고 HMAC-SHA256 hex 로 계산한다. 비교는 상수 시간으로 한다.
  - `|now - ts| > tolerance` 면 false 다.
- `webhook.ts`: `POST /v1/paddle/webhook`
  1. `await req.text()` 로 원문을 그대로 읽는다(JSON 으로 다시 직렬화하지 않음).
  2. 서명을 검증한다. 실패하면 401 이다.
  3. `PADDLE_IP_CHECK === '1'` 이면 `CF-Connecting-IP` 가 환경별 Paddle IP 목록에 있어야 한다(아래 근거 절의 6개씩). 아니면 403 이다.
  4. JSON 을 파싱하고 `event_id`·`event_type`·`occurred_at`·`data` 를 꺼낸다.
  5. 같은 D1 `batch` 안에서 `INSERT OR IGNORE INTO paddle_events` 와 `apply` 를 함께 처리한다. 이미 있는 `event_id` 면 바로 200 이다.
  6. 처리에 성공하면 200 이다. 실패하면 500 을 돌려줘 Paddle 이 재시도하게 한다. 같은 batch 라서 이벤트 행도 남지 않는다(D14).
  7. 응답은 5초 안에 낸다(D1 몇 줄이라 충분하다).
- `apply.ts`: `applyEvent(db, ev): Promise<D1PreparedStatement[]>`
  - `subscription.*` → `subscriptions` 를 upsert 한다. **`occurred_at` 이 저장된 `last_event_at` 보다 이르면 무시**한다(`WHERE excluded.last_event_at >= subscriptions.last_event_at`).
  - `user_id` 는 `data.custom_data.user_id` 에서 찾는다. 없으면 `customer_id` → `users.paddle_customer_id` 로 찾고, 둘 다 없으면 `user_id NULL` 로 저장하고 `outcome='unmatched'` 로 남긴다(운영 확인용).
  - 상태 매핑: `active`/`trialing` → until = `period_end`, `past_due` → until = `period_end + 7일`(스펙 §5.3 결제 실패 유예), `paused`·`canceled` → until = `canceled_at ?? occurred_at`. 다만 해지 예약(`scheduled_change.action = 'cancel'`)으로 상태가 `active` 인 동안은 `period_end` 까지다.
  - `transaction.completed` → `custom_data.user_id` 가 있으면 `users.paddle_customer_id` 를 채운다.
  - `adjustment.created|updated`(환불) → `refunds` 에 기록만 한다. 이용권은 구독 이벤트가 정한다(D15).
  - 상태가 바뀐 사용자의 호스트 DO 마다 `/internal/recheck` 를 보낸다(`ctx.waitUntil`).
- **Paddle 엔터티 필드 이름은 (미확인)** 이다: `data.status`, `data.customer_id`, `data.custom_data`, `data.current_billing_period.ends_at`, `data.scheduled_change.action`, `data.canceled_at`, `data.items[0].price.id`. Step 1 에서 Paddle 문서의 이벤트 예시 페이로드와 맞춰 보고, 픽스처를 문서 예시 모양 그대로 만든다. 확인한 것은 웹훅 머리·서명 방식·이벤트 이름·`custom_data` 전달·`event_id`·`occurred_at`(근거 절)이다.
- `entitled.ts` 추가: `subscriptions` 의 until 도 후보에 넣는다. `plan: 'pro'` 이고, `st` 는 `active`·`trialing`(Paddle 쪽 체험을 쓸 경우)·`past_due`·`canceled` 다. 여러 출처 가운데 until 이 가장 큰 것을 쓴다. 출처 우선순위는 pro > comp > trial 이고, until 이 같을 때 표시에만 영향을 준다.

- [ ] **Step 1: Paddle 페이로드 확인** — Paddle 개발자 문서의 `subscription.created`·`subscription.updated`·`subscription.canceled`·`transaction.completed`·`adjustment.created` 예시를 읽고 위 필드 경로를 확정한다. 픽스처의 이메일·이름은 합성값으로 바꾼다. 다른 경로가 나오면 `apply.ts` 와 이 문서의 Interfaces 를 고친다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/paddle.signature.test.ts
const secret = 'test_' + 'secret_value';
async function sign(body: string, ts: number, key = secret) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}:${body}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
it('valid', async () => { const b = '{"a":1}'; expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 102)).toBe(true); });
it('tampered body', async () => { const h = `ts=100;h1=${await sign('{"a":1}', 100)}`; expect(await verifyPaddleSignature(h, '{"a":2}', secret, 100)).toBe(false); });
it('re-serialized body fails (raw body required)', async () => { const raw = '{ "a": 1 }'; const h = `ts=100;h1=${await sign(raw, 100)}`; expect(await verifyPaddleSignature(h, JSON.stringify(JSON.parse(raw)), secret, 100)).toBe(false); });
it('outside 5 s', async () => { const b = 'x'; expect(await verifyPaddleSignature(`ts=100;h1=${await sign(b, 100)}`, b, secret, 106)).toBe(false); });
it('one of several h1 matches', async () => { const b = 'x'; expect(await verifyPaddleSignature(`ts=100;h1=${'0'.repeat(64)};h1=${await sign(b, 100)}`, b, secret, 100)).toBe(true); });
it('wrong secret / malformed header / missing header', async () => { /* false ×3 */ });

// cloud/test/paddle.webhook.test.ts — 픽스처 + 서명 helper
it('duplicate event_id is applied once', async () => { /* 같은 이벤트 2번 → 200 ×2, paddle_events 1행 */ });
it('older occurred_at cannot undo a newer state', async () => { /* canceled(10:00) 뒤 updated(09:00, active) → 여전히 canceled */ });
it('past_due keeps entitlement 7 days past period end', async () => { /* entitledState.untilMs = period_end + 7d */ });
it('canceled closes relay at recheck', async () => { /* 호스트 WS 연결 → canceled → runDurableObjectAlarm → 4402 */ });
it('custom_data.user_id links the subscription; unknown user is kept as unmatched', async () => { /* … */ });
it('bad signature → 401, nothing stored', async () => { /* … */ });
it('IP check on: non-Paddle IP → 403', async () => { /* CF-Connecting-IP 머리 */ });
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 6: 커밋** — `feat(billing): Paddle 웹훅 — 원문 HMAC 서명·event_id 멱등·occurred_at 순서·결제 실패 7일 유예·환불 기록·릴레이 재확인`

---

### Task 10: 결제·계정 화면 (클라우드 웹 + 로컬 설정)

**Files:**
- Create: `cloud/src/paddle/api.ts`, `cloud/src/pages/account.ts`, `cloud/src/pages/checkout.ts`, `cloud/static/account.js`, `cloud/static/checkout.js`, `cloud/static/pages.css`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_MONTHLY`, `PADDLE_PRICE_YEARLY`, `PADDLE_DISCOUNT_FOUNDING?`), `cloud/src/ui.ts`(`/static/*`), `src/ui/components/CloudSection.tsx`, `src/ui/cloudTexts.ts`(또는 사전), `scripts/render/cloud-section.html`
- Test: `cloud/test/billing.test.ts`, `src/ui/components/CloudSection.test.tsx`(추가)

**Interfaces:**
- `GET /account`(웹 세션 필요, 없으면 `/login?next=/account`)
  - 보여 주는 것: 이메일, 요금제(체험 N일 남음 / Pro 월·연 · 다음 결제일 / 결제 실패 유예 중 / 만료), 연결된 Mac 목록(이름·연결일·[Unlink]), 기기 목록([Revoke]).
  - 버튼: [Subscribe monthly]·[Subscribe yearly](또는 [Manage billing]), [Sign out].
- `GET /checkout?plan=pro-monthly|pro-yearly` — 계획 ③ 랜딩의 결제 버튼이 가리키는 **고정 주소**다.
  - 로그인하지 않았으면 매직링크로 보낸다.
  - 로그인했으면 Paddle.js 오버레이를 연다. 이미 활성 구독이면 `/account` 로 보낸다.
  - 이 주소는 계획 ③ D12 의 `AIMSG_CHECKOUT_PRO_MONTHLY`·`AIMSG_CHECKOUT_PRO_YEARLY` 값이 된다(`https://app.aimsg.app/checkout?plan=pro-monthly` 등). 랜딩 CSP 는 바뀌지 않는다.
- `checkout.js`
  - `Paddle.Initialize({ token: <data-client-token> })`, 샌드박스면 `Paddle.Environment.set('sandbox')`.
  - `Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customer: { email }, customData: { user_id }, discountCode? })`.
  - 확인한 것은 `customData` → 웹훅 `custom_data` 전달이다. `Initialize`·`Environment.set`·`items`·`customer.email`·`discountCode` 의 정확한 형태와 Paddle.js 스크립트 주소는 **(미확인)** 이라 Step 1 에서 Paddle.js 문서로 확인한다.
  - 값(토큰·가격 id·user_id·email)은 페이지의 `data-*` 속성으로 넘긴다. 인라인 스크립트는 쓰지 않는다.
- CSP(`/checkout`·`/account`): `script-src 'self' <Paddle.js 출처>; frame-src <Paddle 체크아웃 출처>; connect-src 'self' <Paddle 출처>`. 출처 목록은 **(미확인)** 이라 Step 1 에서 확정한다.
- `POST /v1/billing/portal`(웹 세션 + Origin) → `{url}`.
  - `PaddleApi.portalSession(customerId, subscriptionIds)` 가 `POST https://api.paddle.com/customers/{customer_id}/portal-sessions` 로 요청한다. 샌드박스 기본 주소는 **(미확인)** 이다. 본문은 `{ subscription_ids?: string[] }`(최대 25), 머리는 `Authorization: Bearer <PADDLE_API_KEY>` 다. 이 엔드포인트와 권한 `customer_portal_session.write`, "캐시 금지" 는 확인했다.
  - 응답의 `data.urls.general` 아래 개요 링크를 돌려준다. 하위 키 이름은 **(미확인)** 이다. 응답을 캐시하지 않는다.
- `PaddleApi` 는 인터페이스이고, 테스트에는 가짜를 주입한다(외부 호출 없음).
- 로컬 `CloudSection.tsx`
  - 요금제 행에 [구독 관리] 를 더한다. 사용자 기기에서 `window.open('<cloud>/account', '_blank', 'noopener')` 로 연다.
  - 체험이 아니고 Pro 도 아니면 [7일 체험 시작] 을 보여 준다. 미연결이면 연결 흐름을 시작하고, 첫 연결 때 체험이 시작된다(D8). 이미 체험을 썼으면 [Pro 구독] 이다.
  - `pro_required` 토스트의 [설정 열기] 는 이 행으로 스크롤한다.

- [ ] **Step 1: Paddle.js·포털 응답 확인** — 다음을 확인하고 `cloud/README.md` 에 적는다.
  - Paddle.js v2 의 스크립트 주소·`Initialize`·`Environment`·`Checkout.open` 인자, CSP 에 넣을 출처.
  - 포털 세션 응답의 `urls` 구조, 샌드박스 API 주소.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/billing.test.ts
it('/checkout without a session → login with next', async () => { /* 302 Location /login?next=%2Fcheckout%3Fplan%3Dpro-monthly */ });
it('/checkout with a session renders data-* only, no inline script, CSP allows Paddle only', async () => { /* … */ });
it('/checkout with an active subscription → /account', async () => { /* … */ });
it('portal: needs session + Origin, returns url from PaddleApi, no-store', async () => { /* 가짜 PaddleApi */ });
it('account page lists hosts and devices; revoke works', async () => { /* … */ });

// src/ui/components/CloudSection.test.tsx (추가)
it('trial row: N days left + 구독 관리 opens the cloud account page on this device', async () => { /* window.open 스파이 */ });
it('community after trial: Pro 구독 button; pro_required toast scrolls here', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — 해당 테스트들이 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다. 페이지 HTML 은 영어이고 `escapeHtml` 을 거친다. 스타일은 `pages.css` 한 파일이다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다. 렌더 픽스처를 확인한다(체험·Pro·만료 세 상태).
- [ ] **Step 6: 커밋** — `feat(billing): 계정·결제 페이지(Paddle.js 오버레이·포털)·랜딩용 고정 결제 주소·설정의 구독 행`

---

### Task 11: 보안·장애·부하·문서·출시 스위치

**Files:**
- Create: `cloud/scripts/load-relay.mjs`, `cloud/scripts/publish-ui.sh`, `cloud/README.md`(완성), `docs/security-model.md`, `docs/privacy-data-inventory.md`, `src/server/cloud/faults.test.ts`, `src/server/pro/release.test.ts`, `cloud/test/security.test.ts`
- Modify: `src/hygiene.ts`(`GENERIC_RULES` 추가), `src/hygiene.test.ts`(규칙 확인 케이스), `src/server/pro/features.ts`(`PRO_ENFORCE = true` — 마지막 단계), `scripts/export-public.sh`(D11), `README.md`(Pro·클라우드 절), `docs/protocol.md`(최종 점검)

**Interfaces:**
- 위생 규칙 추가(`GENERIC_RULES`) — 테스트 문자열은 기존처럼 쪼개 쓴다.
  - 개인 JWK: `"kty"\s*:\s*"(OKP|EC)"` 와 같은 객체 안의 `"d"\s*:\s*"[A-Za-z0-9_-]{40,}"`
  - PEM 개인키 일반형: `BEGIN (EC |RSA )?PRIVATE KEY`
  - Paddle API 키 접두사는 **(미확인)** 이라 규칙에 넣지 않는다. 확인되면 따로 더한다.
- `faults.test.ts`(로컬, 실제 `startServer` + 임시 configDir)
  - 클라우드 주소가 닫힌 포트일 때 서버가 뜨고 `/api/me`·ws `hello`·세션 목록·로컬 푸시 구독이 정상인지 본다.
  - 연결 상태에서 클라우드가 5xx 일 때 `relay: 'down'`, entitlement 유지(exp 전), 로컬 VAPID 푸시 무영향인지 본다.
  - 잠자기·깨어남(시계 점프 2시간)에 RelayClient 가 즉시 재연결하는지 본다.
- `cloud/test/security.test.ts`
  - 모든 HTML 응답에 CSP·`frame-ancestors 'none'`·`no-store` 가 붙는지 본다.
  - 상태를 바꾸는 웹 라우트에 교차 출처를 보내면 403 인지 본다.
  - 토큰·티켓·claim 이 로그(`console.log` 스파이)에 나오지 않는지 본다.
  - D1 에 평문 토큰이 없는지 본다(모든 `*_hash` 열이 해시 모양).
  - 속도 제한(매직링크·claim·push send)이 걸리는지 본다.
- `load-relay.mjs --hosts 50 --devices 2 --rate 5 --seconds 60 --url http://127.0.0.1:<port>` — `wrangler dev --local` 대상이다. 지연 p50/p95, 끊김 수, DO 별 메시지 수를 출력한다. 실제 비용 측정(배포본)은 사용자 몫이다.
- `publish-ui.sh <version>`
  1. `npx vite build --mode relay --base /v/<version>/ --outDir "$T"` 로 빌드한다.
  2. `wrangler r2 object put ai-msg-ui/v/<version>/<파일> --file …` 로 올린다. 명령 형태는 **(미확인)** 이라 `wrangler r2 object put --help` 로 확인한다.
  3. `latest/sw.js`·`latest/manifest.webmanifest`·`latest/icons/*` 를 갱신한다.
  4. `--dry-run` 이면 목록만 출력한다. 실제 실행은 사용자가 한다.
- `release.test.ts`: `expect(PRO_ENFORCE).toBe(true)` 와 `Object.keys(entitlementKeys.keys).length >= 1`. 이 파일은 마지막 단계에서 `PRO_ENFORCE` 를 바꿀 때 함께 커밋한다.
- 문서
  - `docs/security-model.md`(영어): 클라우드가 보는 것(이메일·호스트/기기 id·공개키·바이트 수·시각)과 못 보는 것(대화·코드·명령·승인 내용·푸시 본문), 페어링 MITM 방어, 키 저장 위치, 기기 해제, 위협 모델의 한계(자체 프로토콜, 브라우저 XSS 시 기기 키 사용 가능 — 추출 불가 키라도 그 탭 안에서는 사용 가능).
  - `docs/privacy-data-inventory.md`: 약관·개인정보 검토용 데이터 목록이다. 항목·목적·보관 기간·처리자(Cloudflare·Paddle·Resend)를 적는다.
  - `cloud/README.md`: 사용자 배포 절차(아래 "사용자 몫" 순서와 같게)와 comp 부여 SQL(`INSERT INTO grants (user_id, plan, until, note) VALUES (?, 'comp', ?, 'owner')`).

- [ ] **Step 1: 실패하는 테스트 작성** — `faults.test.ts`, `cloud/test/security.test.ts`, 위생 규칙 케이스를 작성한다.
- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인** — 공통 검증 명령 다섯 개와 cloud 검증 세 개를 돌린다.
- [ ] **Step 3: 부하 스크립트 로컬 실행** — `wrangler dev --local` 대상으로 `--hosts 50 --devices 2 --seconds 60` 을 돌리고 결과 한 줄을 커밋 메시지 본문에 적는다.
- [ ] **Step 4: 문서 커밋** — `docs(cloud): 보안 모델·데이터 목록·배포 절차, 위생 규칙(개인 JWK·PEM), 장애·보안 테스트`
- [ ] **Step 5: 출시 스위치(사용자 확인 뒤)** — 아래 셋이 모두 참일 때만 진행하고, 아니면 멈추고 보고한다. 그다음 `PRO_ENFORCE = true` 로 바꾸고 `release.test.ts` 를 추가해 공통 검증 명령을 돌린다.
  - ① `entitlement-keys.json` 에 사용자가 생성한 공개키가 있다.
  - ② 클라우드 배포가 끝났다.
  - ③ 이 Mac 소유자 계정에 comp 부여가 끝났다는 사용자 확인이 있다.

  이 스위치를 켠 버전이 실행 중인 서버에 반영되는 것은 사용자의 재시작 지시 때다.
- [ ] **Step 6: 커밋** — `feat(pro): 출시 스위치 — Pro 게이트 적용 시작`

---

## 결정 지점

| # | 질문 | 추천 | 대안 | 추천 이유 |
|---|---|---|---|---|
| D1 | 릴레이를 종단간 암호화하나 | **한다(필수).** 클라우드는 봉투 머리와 암호문만 본다 | TLS 종단까지만 암호화(클라우드가 평문 중계) | 스펙 §5.3·§6 이 "암호문만" 을 요구한다. 핵심 약속 4("코드는 기기를 떠나지 않는다")와 계획 ③ 랜딩 주장 `relayCiphertext` 의 근거다. 승인 버튼이 원격 명령 실행이라 클라우드가 털렸을 때의 피해 범위를 줄이는 장치다. 비용은 UI 전송 계층(Task 5)인데, 루프백 프록시 구조라 서버 코드는 바뀌지 않는다 |
| D2 | DO 단위 | **호스트(Mac)당 1개**(`idFromName(hostId)`) | 스펙대로 사용자당 1개 | 한 사용자가 Mac 을 둘 연결하면 사용자당 DO 는 호스트 구분 라우팅과 호스트별 교체(4409) 규칙을 따로 짜야 한다. 호스트당 DO 는 격리·장애 범위·이용권 alarm 이 단순하다. Hibernation 이라 DO 수가 늘어도 유휴 비용은 거의 없다고 본다(비용 실측은 사용자 몫). **스펙과 다르므로 스펙 §5.3 을 갱신할 것** |
| D3 | E2EE 구현 방식 | **WebCrypto 만으로 만든 최소 핸드셰이크**(P-256 정적+임시 ECDH 4항 → HKDF → 방향별 AES-GCM, 카운터). 프로토콜 문서와 테스트 벡터를 남기고 외부 보안 리뷰(스펙 §7)에서 우선 점검한다 | Noise 라이브러리(X25519/ChaCha) 도입 / MLS 류 | 런타임 의존성 금지와 세 런타임(Node·브라우저·Workers) 공통이라는 조건 때문이다. 브라우저 WebCrypto 의 X25519 지원 범위는 이번에 확인하지 못했고, P-256 ECDH 는 모든 런타임이 지원한다. 구성은 Noise KK 와 같은 4항이지만 공식 검증 구현이 아니라는 위험은 남는다 → `docs/security-model.md` 에 한계로 적는다 |
| D4 | 폰 UI 를 어떻게 내보내나 | **R2 에 버전별(`/v/<ver>/`)로 영구 보관 + 루트 부트스트랩**. 폰은 핸드셰이크의 `hostVersion` 과 같은 UI 로 옮긴다 | 최신 UI 하나만 + 프로토콜 호환 범위 / Mac 이 터널로 UI 를 서빙(SW 가 가로챔) | UI·서버 따로 배포 문제(`docs/protocol.md`)가 원격에서는 더 크다. 사용자마다 Mac 버전이 다르기 때문이다. 버전을 맞추면 지금의 `has()` 규칙만으로 충분하다. Workers 정적 자산은 배포 때 옛 파일을 지우므로(확인) 버전별 보관에는 R2 가 맞다. 터널 서빙은 SW 수명·첫 로드 지연 때문에 복잡하다 |
| D5 | Mac 쪽 "두 번째 벽" | **Mac 로컬 신뢰 목록(페어링 때 HMAC 으로 확인한 기기 공개키)**. 루프백 토큰 쿠키는 Mac 의 `RelayBridge` 가 붙이고, 폰은 로그인 토큰을 모른다 | 스펙 문구대로 폰이 기존 로그인 토큰을 한 번 입력 | 클라우드가 뚫려도 Mac 이 모르는 키로는 핸드셰이크가 안 된다(Review Focus 1·3). 토큰을 폰에 두면 클라우드 출처의 XSS 에 토큰까지 노출된다. 스펙 §5.3 "기존 토큰 인증은 두 번째 벽으로 유지" 를 "기기 키 신뢰 목록" 으로 갱신할 것 |
| D6 | Pro 모듈 형태 | **저장소 안의 게이트(`ProGate`) + 출시 스위치 `PRO_ENFORCE`**. 클라우드 기능은 클라우드가 이용권을 직접 확인한다 | 스펙대로 비공개 `@ai-msg/pro` 모듈(서명 번들)에 Pro 구현을 옮기기 | Pro 기능(인계·병목·재시도·총사령탑·다계정)이 이미 공개 코드에 있다. 비공개 모듈로 옮기면 큰 리팩터링과 이중 배포 경로가 생긴다. 스펙 §4 가 로컬 우회를 "감수" 로 정했고 가치 보호는 클라우드 쪽이다. 출시 스위치는 이 Mac 의 지금 사용(다계정·순환·총사령탑)을 comp 부여 전까지 끊지 않기 위한 것이다. 나중에 비공개 모듈이 필요하면 `ProGate.has` 하나가 끼울 자리다 |
| D7 | 총사령탑의 티어 | **Pro** | Community | 스펙 §4 표에는 없지만 "자리를 비워도 멈추지 않는 자동화"(스펙 §0 유료 가치의 중심) 그 자체다. 무인 자동 턴이라 엔진 사용량을 많이 쓰는 기능이기도 하다. 무료 사용자는 아직 없어서 빼앗기는 사람이 없다 |
| D8 | 7일 체험을 누가 관리하나 | **클라우드 자체 `trials` 행 — 첫 호스트 연결 때 자동 시작, 이메일당 1회, 카드 없음** | Paddle 구독 체험(카드 필요) / [체험 시작] 버튼으로 명시 시작 | Paddle 의 카드 없는 체험(`requires_payment_method:false`)은 문서상 개발자 미리보기·조기 접근이고 Checkout 에서 쓸 수 없다(확인). 스펙의 "카드 없이 7일" 을 지키려면 자체 관리가 필요하다. 연결이 곧 릴레이를 쓰려는 의사라 자동 시작이 마찰이 가장 적다. 남용(새 이메일)은 감수하고 지표로 본다 |
| D9 | 매직링크 메일 제공자 | **Resend**(HTTP API 하나, `EmailSender` 뒤) | Postmark / Cloudflare Email 기능 / AWS SES | Workers 에서 `fetch` 한 번이면 되고, 도메인 인증(SPF/DKIM)만 하면 된다. API 형태는 미확인이라 Task 2 Step 1 에서 확인한다. 인터페이스 뒤에 있어 바꾸기 쉽다 |
| D10 | QR 생성 | **`qrcode-generator`(UI devDependency, 번들에 포함)** | 자체 QR 인코더 | QR 인코딩(리드-솔로몬·마스크)은 직접 짜면 버그가 나기 쉽고 테스트 비용이 크다. 런타임 의존성이 아니라 UI 번들에 들어가는 devDependency 라 "런타임 의존성 금지" 에 걸리지 않는다. 라이선스(MIT)는 설치 때 확인한다 |
| D11 | `cloud/` 를 공개하나 | **공개(Community 저장소 export 에 포함)**. 비밀은 전부 `wrangler secret` 에 둔다 | 비공개 유지(`export-ignore`) | E2EE 주장("클라우드는 못 본다")의 근거가 서버 코드 공개다. 비밀이 코드에 없으므로 공개해도 위험이 늘지 않는다. 남이 자체 호스팅할 수 있다는 점은 Pro 가치(편의)에 큰 영향이 없다고 본다 |
| D12 | 클라우드 푸시 경로 | **Mac 이 aes128gcm 으로 암호화 → 클라우드 HTTPS API(`/v1/push/send`)가 VAPID 서명만 붙여 전달** | 스펙 문구대로 릴레이 WS 로 발송 요청 / 클라우드가 평문을 받아 암호화 | 클라우드가 푸시 본문을 못 본다. 릴레이 WS 를 쓰면 DO 가 HTTP 를 대신 쳐야 해서 깨어 있는 시간이 늘고, 호스트 WS 가 없을 때 보낼 수 없다. 본문 최소화(종류 라벨만, 스펙 §5.3)는 잠금 화면 노출 때문에 그대로 지킨다 |
| D13 | Community "벤더당 1계정" 을 어디서 막나 | **실행 시점**: 순환 끔, 홈 이외 계정 고정 거절, Gemini `g2` 미사용. 다른 계정 세션의 보기·가져오기·사용량 숫자는 유지 | 계정 레지스트리 자체를 홈 하나로 축소 | 레지스트리를 줄이면 세션 색인·기록·사용량 화면이 함께 깨진다. 데이터는 사용자 것이고, 유료 가치는 "여러 계정으로 **돌리는**" 데 있다 |
| D14 | 웹훅 처리 시점 | **동기 처리(D1 batch) 후 200, 실패면 500 → Paddle 재시도** | 200 먼저 + `waitUntil` 로 처리 | 200 뒤 처리가 실패하면 Paddle 이 재시도하지 않아 상태를 잃는다. D1 몇 줄은 5초 안에 충분하다. 이벤트 행과 상태 변경이 같은 batch 라 부분 반영도 없다 |
| D15 | 환불·결제 실패 | **결제 실패(`past_due`)는 `period_end + 7일` 까지 유지. 환불은 기록만 하고, 이용권은 구독 이벤트(`canceled`)가 정한다** | 환불 즉시 이용권 회수 | 스펙 §5.3("결제 실패는 유예 7일, 실행 중 작업은 끊지 않음")을 따른다. Paddle 에서 환불과 해지는 별개 이벤트로 오고, 전액 환불이면 보통 해지가 따른다. 부분 환불로 이용권을 끊으면 오판한다 |
| D16 | 클라우드 주소·환경 변수 이름 | **`https://app.aimsg.app`(도메인 확보 뒤 확정), `DECK_CLOUD_URL`·`DECK_CLOUD`(리네임이 접두사를 바꾸면 따라감)** | 랜딩과 같은 호스트(`aimsg.app`) | 랜딩(Pages, 정적)과 앱(Worker, 쿠키·CSP 다름)을 서브도메인으로 나누면 쿠키·CSP 가 섞이지 않는다. 도메인은 사용자 몫이고, 바뀌면 상수 하나와 `wrangler.jsonc` 의 `PUBLIC_ORIGIN` 만 고치면 된다 |
| D17 | 사용자당 Mac 수 | **3대(`MAX_HOSTS`)**, 기기 3대(스펙)와 별도 | 무제한 / 1대 | 개인 개발자 기준으로 집·회사·서버 정도면 충분하다. 계정 공유 남용을 막는다. 변수라서 바꾸기 쉽다 |

## 사용자 몫 (이 계획의 작업이 아님)

- **Paddle**
  - 판매자 가입·KYC(한국 개인/개인사업자), USD 수취 계좌·정산 비용 확인(스펙 §5.4).
  - 상품 "AI msg Pro" 와 가격 둘(월 $15, 연 $150), 창립 고객 할인 코드(연 $120 상당).
  - 샌드박스·라이브 각각 알림 대상(웹훅 주소 `https://app.aimsg.app/v1/paddle/webhook`, 구독·거래·조정 이벤트 선택)을 만들고, 그 비밀을 `wrangler secret put PADDLE_WEBHOOK_SECRET` 로 넣는다.
  - API 키(`customer_portal_session.write` 권한)는 `PADDLE_API_KEY` 로, client-side token 과 가격 id 는 `wrangler.jsonc` vars 로 넣는다.
  - 기본 결제 링크·승인 도메인 설정(Paddle.js 체크아웃 요구사항, 정확한 항목은 Task 10 Step 1 에서 확인)을 한다.
- **Cloudflare**
  - 계정과 플랜(DO 사용 가능 여부는 플랜별로 확인), 도메인 `aimsg.app`(후보) 확보·연결.
  - `wrangler d1 create ai-msg` → `database_id` 기입, `wrangler d1 migrations apply`, R2 버킷 `ai-msg-ui` 생성.
  - 비밀 넣기: `SESSION_SECRET`, `ENTITLEMENT_SIGNING_JWK`, `VAPID_PRIVATE_JWK`, `RESEND_API_KEY`, `PADDLE_*`.
  - `wrangler deploy`, `cloud/scripts/publish-ui.sh <버전>`.
- **키 생성**
  - `node cloud/scripts/gen-entitlement-key.mjs --kid <kid> --out <저장소 밖 경로>` 로 만든 공개 JWK 를 `src/server/cloud/entitlement-keys.json` 에 넣는다(Task 11 Step 5 전에).
  - `gen-vapid.mjs` 도 같은 방식이다. 개인키 파일은 비밀 저장소에만 둔다.
- **메일:** Resend 가입, 발신 도메인 SPF/DKIM 인증.
- **서면 확인:** Anthropic·OpenAI·xAI 에 구독 로그인한 공식 CLI 를 서브프로세스로 띄우는 것과 원격 승인이 허용되는지 확인한다(스펙 §3 규칙 7, §11).
- **약관·개인정보처리방침·환불 정책 검토:** `docs/privacy-data-inventory.md`·`docs/security-model.md` 를 근거로 한다. Paddle 판매자 심사가 요구하는 페이지 주소도 준비한다.
- **이 Mac 소유자 계정 comp 부여**(`cloud/README.md` 의 SQL)와 출시 스위치 승인(Task 11 Step 5), 그리고 그 버전을 반영할 서버 재시작 지시.
- **실기 확인:** iOS Safari(홈 화면 PWA 푸시 포함)·Android Chrome 에서 QR 페어링 → 승인 → 푸시. 실제 결제 1건(샌드박스 → 라이브), 환불 1건.
- **운영 검증:** 배포본 대상 부하 테스트와 DO 비용 실측(스펙 §11), 외부 1인 보안 리뷰(스펙 §7, D3 우선).

## 범위 밖

- Team(공유 계정 풀·관리자), 메터드 크레딧 폴백(스펙 §4 두 번째 수익원).
- 유휴 할당량 작업·교차 검증 버튼(출시 뒤), 무인 자동 인계(v1.1).
- 폰 하나로 여러 Mac 을 오가는 화면. v1 은 기기 하나가 Mac 하나에 페어링한다. 다른 Mac 은 새 기기 등록으로 처리한다.
- 네이티브 모바일 앱, Windows 호스트.
- Polar 등 대체 판매 대행 구현(Paddle 심사 실패 시 별도 계획).
- entitlement·VAPID 키 자동 교체(`kid` 목록 구조만 준비).
- i18n·랜딩·설치 문서 — 계획 ③. 이 계획은 결제 고정 주소(`/checkout?plan=…`)만 제공한다.
- 비공개 Pro 모듈(D6 대안).

## 근거·미확인

**공식 문서로 확인한 것 (2026-10-22)**
- Cloudflare Durable Objects WebSocket Hibernation 의 메서드와 한도:
  - 메서드: `ctx.acceptWebSocket(ws, tags?)`(태그 10개·각 256자), `ctx.getWebSockets(tag?)`, `ctx.getTags(ws)`, `webSocketMessage(ws, message)`, `webSocketClose(ws, code, reason, wasClean)`, `ws.serializeAttachment`/`deserializeAttachment`(16,384바이트), `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res))`(요청·응답 각 2,048자), `setHibernatableWebSocketEventTimeout`(최대 7일).
  - 한도·플래그: DO 하나당 WebSocket 32,768개. 호환성 플래그 `web_socket_auto_reply_to_close`(호환 날짜 2026-04-07 이상에서 기본).
- `@cloudflare/vitest-plugin`:
  - 설정: `cloudflareTest({ wrangler: { configPath } })`, vitest `^4.1` 이상.
  - import: `env`·`exports` 는 `cloudflare:workers` 에서, `runInDurableObject`·`runDurableObjectAlarm`·`listDurableObjectIds`·`applyD1Migrations`·`evictDurableObject` 는 `cloudflare:test` 에서 가져온다.
- Workers WebCrypto: Ed25519 sign/verify/generate, ECDH, HKDF, AES-GCM, HMAC, ECDSA 를 지원한다.
- Workers 정적 자산: `assets.directory`·`binding`·`run_worker_first`·`not_found_handling: "single-page-application"`. 배포 때 옛 자산을 지운다.
- Paddle 웹훅 서명과 전달:
  - 서명: 머리 `Paddle-Signature: ts=…;h1=…`, 서명 대상 `ts:원문`, HMAC-SHA256, 알림 대상별 비밀, SDK 기본 허용 오차 5초, `h1` 여럿 가능.
  - 응답·재시도: 200 을 5초 안에. 재시도는 샌드박스 3회, 라이브 최대 60회(약 2일).
  - 순서·중복: 순서를 보장하지 않으니 `occurred_at` 으로 판단하고, 중복은 `event_id` 로 거른다.
- Paddle 웹훅 출발 IP:
  - 샌드박스: 34.194.127.46, 54.234.237.108, 3.208.120.145, 44.226.236.210, 44.241.183.62, 100.20.172.113
  - 라이브: 34.232.58.13, 34.195.105.136, 34.237.3.244, 35.155.119.135, 52.11.166.252, 34.212.5.7
- Paddle 이벤트 이름: `subscription.{activated,canceled,created,imported,past_due,paused,resumed,trialing,updated}`, `transaction.{billed,canceled,completed,created,paid,past_due,payment_failed,ready,revised,updated}`, `adjustment.{created,updated}`.
- Paddle 고객 포털: `POST /customers/{customer_id}/portal-sessions`(선택 `subscription_ids` ≤ 25, 권한 `customer_portal_session.write`, 응답 캐시 금지, `urls.general` 과 구독별 링크).
- Paddle.js `Checkout.open` 의 `customData` 는 웹훅 `custom_data` 로 전달되고, 거래 → 구독 → 이후 거래로 복사된다.
- Paddle 카드 없는 체험(`requires_payment_method: false`)은 개발자 미리보기·조기 접근 전용이고 Checkout 에서 쓸 수 없다.
- `web-push` 3.6.7 소스: `generateRequestDetails` 는 `vapidDetails` 가 없으면 `Authorization` 없이 aes128gcm 본문과 머리를 만든다.

**미확인 (해당 Task 첫 단계에서 확인)**

| 항목 | 어디서 쓰나 |
|---|---|
| `webSocketError` 처리기, DO WebSocket 메시지 크기 한도 | Task 3 — 64KiB 조각·1MiB 상한으로 피해 감 |
| wrangler DO 마이그레이션 키(`new_sqlite_classes`/`new_classes`) | Task 3 |
| 테스트 안 클라이언트 WS 획득 형태(`res.webSocket`+`accept()`) | Task 3 |
| `readD1Migrations` 시그니처, 플러그인의 vitest 5 지원 여부 | Task 2 — cloud 는 자기 vitest 를 고정 |
| R2 바인딩 API 세부 | Task 5 |
| `wrangler dev --persist-to`·`--var`, `wrangler r2 object put` 형태 | Task 5·11 |
| Workers Ed25519 `importKey` 의 `jwk` 지원 | Task 7 |
| 브라우저 WebCrypto X25519 지원 범위 | D3 — P-256 을 고른 이유 |
| Paddle 엔터티 필드 경로(`current_billing_period.ends_at`, `scheduled_change.action`, `canceled_at`, `items[].price.id`, `customer_id`) | Task 9 |
| Paddle.js 스크립트 주소·`Initialize`·`Environment.set`·`Checkout.open` 의 `items`/`customer`/`discountCode`, CSP 출처 | Task 10 |
| 포털 응답 `urls` 하위 키, 샌드박스 API 주소 | Task 10 |
| Paddle API 키 접두사(위생 규칙용) | Task 11 |
| Resend `POST /emails` 형태 | Task 2 |
| Cloudflare 플랜별 DO 사용 가능 여부와 실제 비용 | 사용자 몫 |
