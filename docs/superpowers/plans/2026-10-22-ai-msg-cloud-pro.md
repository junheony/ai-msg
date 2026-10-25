# AI msg 클라우드·Pro·결제·체험 구현 계획 (계획 ④)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **작성 2026-10-22, 개정 2026-10-25(독립 보안 검토 반영 — 판정 "고친 뒤 착수", 필수 10·권장 8).** 제품명 **AI msg** 기준이다(npm `ai-msg`, CLI `ai-msg`). 스펙에 나오는 Quarterdeck 은 옛 이름이다. 무료(Community)와 Pro 를 **같은 날** 출시한다. 계획 ①(정책 준수)은 끝났고, 계획 ②(패키징)는 Task 1–7 이 끝났다. 계획 ③(i18n·랜딩, `2026-10-22-ai-msg-i18n-landing.md`)은 이 계획과 나란히 진행한다. 이 계획에서 쓰는 Cloudflare·Paddle API 가운데 공식 문서로 확인한 것과 확인하지 못한 것은 맨 끝 "근거·미확인" 절에 나눠 적었다. 본문에 **(미확인)** 이 붙은 형태와 **착수 시 확인** 이 붙은 라이브러리·벡터는 구현하는 Task 의 첫 단계에서 실제로 확인한 뒤에 쓴다. 검토 항목이 어디에 반영됐는지는 맨 끝 "검토 반영표" 에 있다.

## 출시 범위

출시 1차는 "최소 판매 범위"만 담는다. Pro 가 파는 것은 **집 밖에서 폰으로 보고 승인하는 클라우드 릴레이와 그 폰으로 오는 알림**뿐이다(출시 점검 문서 §2 "Pro 문구는 릴레이·푸시만"). 로컬 기능을 잠그는 게이트는 출시 1차에 없다.

**출시 1차(MVP) — 이 순서로 실행한다**

| 순서 | Task | 한 줄 |
|---|---|---|
| 1 | Task 1 | Noise KK 기반 공유 릴레이 프로토콜(검증 라이브러리 또는 사양 그대로 구현 + 공식 테스트 벡터), 봉투·터널 프레임, 페어링 MAC·확인 코드 |
| 2 | Task 2 | 클라우드 패키지 뼈대 — 두 출처(app·relay), 매직링크, 호스트 연결, 페어링(두 번 claim 폐기), 기기 API, 체험(이메일 정규화·IP 제한) |
| 3 | Task 3 | 릴레이 DO — Hibernation WS, 일회용 티켓, 출처 덮어쓰기, 이용권 alarm(48시간 유예), 해제 통지 |
| 4 | Task 4a | 로컬 클라우드 클라이언트 ① — 장치 코드 연결, 상태 파일, RelayClient(이용권은 연결을 유지한 채 `ent` 제어로, 끊기면 최대 5분 간격) |
| 5 | Task 4b | 로컬 클라우드 클라이언트 ② — RelayBridge(Mac 확인 필요 동작 차단, 해제 즉시 종료), `/api/cloud` |
| 6 | Task 5 앞 실기 확인 | iOS 홈 화면 PWA 저장소 분리·카메라·푸시 탐침(탐침은 실행자, iPhone 확인은 사용자 몫) — 결과로 5a·5b 페어링 화면을 확정 |
| 7 | Task 5a | Mac 쪽 페어링 — QR·확인 코드·[허용]/[거부]·페어링 코드 [복사] |
| 8 | Task 5b | 폰 UI 전송 계층 — apiFetch·터널 WS·RelayConnection(402 는 5초부터 최대 5분)·PWA 안 페어링(코드 붙여 넣기·스캔)·Mac VAPID 직접 푸시·재페어링 흐름 |
| 9 | Task 5c | relay 출처 UI 배포 — 분리 출처, 제3자 스크립트·쿠키 없음, boot 최신 폴백, 릴리스 스크립트, e2e 이정표 |
| 10 | Task 7 | 요금제 표시 — `/v1/entitlement` 표시용 응답과 설정 › 계정의 요금제 행(서명·로컬 게이트 없음) |
| 11 | Task 9 | Paddle 웹훅 — 전부 upsert, 업무 충돌은 200+기록+알림, 서명된 user 참조, past_due 는 `occurred_at`+7일, 전액 환불·차지백이면 해지 |
| 12 | Task 10 | 결제·계정 화면 — app 출처에서만 Paddle.js, 이중 구독 방지 |
| 13 | Task 12 | 법적 페이지 게시(`docs/legal/*.md` 빌드)·비제휴 고지·계정 삭제(체험 이메일 해시 보존)·만료 행 정리 cron |
| 14 | Task 11 | 보안·장애 테스트와 문서(보안 모델·데이터 목록·배포 절차), 로컬 서버 방어 회귀 테스트 |

**출시 뒤 — 지우지 않고 맨 끝 "출시 뒤" 절에 둔다**

| Task | 한 줄 | 미룬 이유 |
|---|---|---|
| Task 6 | 클라우드 경유 웹 푸시(VAPID 대행) | Mac 이 자기 VAPID 로 직접 푸시하면 된다(권장 2). iOS 실기에서 직접 푸시가 안 될 때만 꺼낸다 |
| Task 8 | 로컬 Pro 기능 게이트(오픈코어 경계) | 확정 범위("릴레이·푸시만")와 어긋난다. `accounts`·`routeFull` 은 다시 꺼내도 게이트에 넣지 않는다(필수 6) |
| Task 13 | entitlement 서명(Ed25519 JWS)·`ProGate`·7일 오프라인 유예·출시 스위치 | 로컬 게이트가 없으면 필요 없다. Task 7 에서 분리 |
| Task 14 | 릴레이 부하 스크립트 | 출시 판단에 필요 없다. 배포본 비용 실측과 함께 한다 |

## 보안 모델과 한계

이 절은 `docs/security-model.md`(Task 11)와 랜딩 문구의 원본이다. 구현이 이 절과 어긋나면 구현을 고치거나 이 절을 먼저 고친다.

**지키는 것.** 릴레이를 지나는 대화·코드·명령·승인 내용은 Mac 과 페어링한 폰만 읽는다. 클라우드(Worker·DO)는 봉투 머리(종류·기기 id)와 암호문 길이만 본다. 키 교환은 Noise KK(`Noise_KK_25519_AESGCM_SHA256`)이고, Mac 은 자기 로컬 신뢰 목록에 있는 기기 공개키로만 핸드셰이크를 받는다.

**운영자를 신뢰하는 범위 — 폰 UI 의 JavaScript.** 폰이 여는 앱 코드(HTML·JS)는 클라우드(relay 출처, R2)가 내려준다. 그래서 **운영자 본인, 또는 배포 자격증명·R2·Cloudflare 계정을 탈취한 사람은 폰에 다른 JS 를 내려보낼 수 있다.** 그 JS 는 그 폰의 기기 키(IndexedDB)를 써서 정상 기기처럼 Mac 에 붙을 수 있고, 페어링 QR 을 찍는 순간의 `authSecret` 도 읽을 수 있다. 종단간 암호화는 "릴레이를 지나는 바이트" 를 지키지, "폰에서 도는 코드" 를 지키지 않는다. 클라우드는 비공개(출시 점검 D1)라서 서버 코드 공개로 이 신뢰를 대신할 수도 없다. 폰 쪽 클라이언트 코드(`src/ui/relay/`, `src/shared/cloud/`)는 Apache-2.0 코어에 있어 누구나 읽을 수 있지만, 실제로 내려온 파일이 그 코드에서 빌드된 것인지 폰이 검증하는 장치는 출시 1차에 없다(출시 뒤: 버전별 빌드 해시 공개·재현 빌드).

**Mac 확인이 필요한 동작.** 폰(릴레이 기기)에서 온 요청 가운데 아래는 Mac 에 닿기 전에 `RelayBridge` 가 막고 `mac_confirm_required` 로 거절한다. 사용자는 Mac 앞에서 직접 한다. 출시 1차에는 "폰 요청 → Mac 에서 [허용]" 대화상자가 없다(출시 뒤, D19).
- 서버 재시작·업데이트: `POST /api/restart`, `/api/server-update*`
- 첫 실행 마법사: `/api/setup` 아래 전부
- 로그인·로그아웃·클라우드 설정: `/api/login`, `/api/logout`, `/api/cloud/*`(단 `GET /api/cloud/status` 는 읽기만 허용)
- 권한 모드 상향(ws): `set_permission_mode` 의 `acceptEdits`·`bypassPermissions`, `set_settings` 의 `autoApprove: true`·`defaultPermissionMode` 상향·`commanderEnabled: true`, `send` 의 `permissionMode` 상향·`sandbox: 'workspace-write'`(복제한 새 세션 포함), `set_sandbox` 의 `workspace-write`
- 기기 해제: 폰에서 `/api/cloud/devices/:id/revoke` 는 막는다(다른 기기 해제는 Mac 이나 계정 페이지에서)
- 새 기기 페어링 확정: Mac 화면에서 확인 코드 6자리를 보고 [허용] 을 눌러야 한다

**위협별로 막는 것과 못 막는 것**

| 위협 | 막는 것 | 못 막는 것 |
|---|---|---|
| 릴레이(DO)·네트워크 탈취자 | 평문 읽기, 프레임 위조·재전송·순서 바꿈, 다른 기기 사칭(DO 가 출처 덮어쓰기 + Mac 신뢰 목록), 옛 UI 로 강제 이동(버전은 Noise 페이로드로 인증, 이동은 `ready` 검증 뒤) | 연결 끊기, 4409 로 계속 밀어내기, 트래픽 양·시각 관찰 |
| 클라우드 운영자·배포 탈취자 | 기존 기기 키 없이 Mac 에 붙기(Mac 신뢰 목록), 페어링 때 기기 키 바꿔치기(QR 의 `authSecret` HMAC + 확인 코드) | **폰에 악성 JS 를 내려 그 폰의 기기 키로 정상 기기처럼 행동하기** — 프롬프트 보내기, 대기 중 승인 누르기, 루프백 API 로 파일 읽기. 위 "Mac 확인 필요" 동작만 막힌다 |
| QR 엿보기(어깨 너머·사진) | 즉시 페어링: Mac 이 확인 코드를 보여 주고 [허용] 을 눌러야 확정, 같은 페어링에 claim 이 두 번 오면 폐기 | 사용자가 코드를 비교하지 않고 [허용] 을 누르는 경우 |
| 같은 출처의 제3자 스크립트·XSS | 폰 UI 는 relay 출처에 따로 있고 제3자 스크립트·쿠키가 없다. Paddle.js 는 app 출처에만 있다 | 폰 UI 자체의 XSS(그 탭 안에서 기기 키 사용 가능 — 추출 불가 키여도 사용은 된다) |
| 악성 웹페이지(사용자 브라우저) | 로컬 서버가 이미 막는다: Host 허용 목록(`src/server/http.ts` 의 `isAllowedHost`), 상태 변경 Origin 검사(`stateChangingOriginOk`), 쿠키 `SameSite=Strict`(`src/server/auth.ts`). `/api/cloud/*` 도 같은 검사를 받는다(Task 11 회귀 테스트) | — |
| 폰 분실·도난 | Mac 설정이나 계정 페이지에서 기기 해제 → 열린 채널 즉시 종료 | 잠금 해제된 폰을 쥔 사람(앱 잠금은 출시 뒤) |
| Paddle 웹훅 위조·중복·역순 | 원문 HMAC, `event_id` 멱등, `occurred_at` 순서, user 참조는 서버 서명 토큰 | — |

**랜딩에 쓸 정직한 문구** (계획 ③ 의 `relayCiphertext` 문구를 이것으로 바꾼다)
- en: "The relay is end-to-end encrypted: our servers pass along encrypted bytes between your Mac and the phone you paired, and cannot read your sessions. The phone app itself is delivered from our servers, so you are trusting us to serve the published app code. Sensitive actions — restarting the server, changing setup, raising permission modes, and pairing a new phone — need you at your Mac."
- ko: "릴레이는 종단간 암호화됩니다. 저희 서버는 Mac 과 페어링한 폰 사이에서 암호화된 바이트만 전달하고, 세션 내용을 읽을 수 없습니다. 다만 폰 앱 코드 자체는 저희 서버가 내려 주므로, 공개한 앱 코드를 그대로 내려 준다는 점은 저희를 믿으셔야 합니다. 서버 재시작·설정 변경·권한 모드 올리기·새 폰 연결은 Mac 앞에서 직접 하셔야 합니다."
- 쓰지 않는 문구: "클라우드도 절대 볼 수 없다", "운영자를 믿을 필요 없음", "서버 코드 공개로 검증 가능".

**Goal:** 집 밖의 폰에서 클라우드 릴레이를 거쳐 Mac 의 AI msg 세션을 보고 승인한다. 릴레이는 내용을 읽을 수 없다(종단간 암호화, 위 "보안 모델과 한계" 의 범위 안에서). Pro(릴레이 이용권)는 클라우드가 직접 판단하고, 결제는 Paddle 구독(월·연)으로 받으며 7일 체험은 카드 없이 준다. 오프라인이거나 클라우드가 장애일 때도 무료 기능은 지금과 똑같이 동작한다. 출시 1차에는 로컬 기능을 잠그는 게이트가 없다.

**Architecture:**

저장소에 독립 패키지 `cloud/`(Cloudflare Worker 하나, **비공개** — 공개본 export 에서 뺀다, D11)를 새로 둔다. 이 Worker 는 **두 출처**를 호스트 이름으로 나눠 맡는다(D18).
- app 출처(`https://app.aimsg.app`): 매직링크 로그인, 계정·결제 페이지(Paddle.js), 법적 페이지, 호스트(Mac) API(`/v1/host/*`, `/v1/pair/start|:id`, `/v1/devices`, `/v1/entitlement`), Paddle 웹훅.
- relay 출처(`https://relay.aimsg.app`): 폰 UI(`/v/<버전>/`), 폰 API(`/v1/pair/claim`, `/v1/relay/ticket`), 릴레이 WS(`/relay/host`, `/relay/device`). 제3자 스크립트·쿠키가 없다.

맡는 일은 계정, 호스트 연결(장치 코드), 페어링·기기(사용자당 3대), 이용권 판단, Paddle 웹훅, 법적 페이지·계정 삭제·정리 cron 이다.

데이터는 D1 에 저장한다. 릴레이는 **Mac(호스트)마다 Durable Object 하나**(`RelayRoom`, Hibernation WebSocket)를 둔다. Mac 은 바깥으로 WS 를 열어 상주하고, 폰은 일회용 티켓으로 접속한다. 종단간 암호화는 이렇게 한다.
- Mac 과 폰이 페어링 때 QR 로 X25519 정적 공개키를 교환한다. Mac 은 확인 코드를 보여 주고 사용자가 [허용] 해야 신뢰 목록에 넣는다.
- 접속할 때마다 **Noise KK**(`Noise_KK_25519_AESGCM_SHA256`, prologue 에 프로토콜 버전·기기 id·호스트 id) 핸드셰이크를 한다. 버전 정보는 핸드셰이크 페이로드로 인증된다.
- 전송은 Noise 가 나눈 방향별 CipherState 로 한다(논스가 곧 카운터라 재전송·순서 바꿈은 복호화 실패).

복호화는 Mac(Node)과 폰(브라우저)만 한다. Worker 는 봉투만 다룬다. 그래서 `src/shared/cloud/noise.ts` 는 Node·브라우저 공통이고, `cloud/` 는 `envelope.ts`(봉투, zod 없음)만 가져다 쓴다.

Mac 쪽 `RelayBridge` 는 복호화한 요청을 **자기 서버의 루프백**(`http://127.0.0.1:<port>`, `ws://127.0.0.1:<port>/ws`)으로 프록시한다. 기존 인증·라우트·ws 처리기는 바꾸지 않는다. 다만 "Mac 확인이 필요한 동작" 은 브리지가 루프백에 닿기 전에 막는다(HTTP 는 `relayPathPolicy`, ws 는 `relayWsPolicy`). 폰 UI 는 같은 React 앱을 relay 출처의 `/v/<버전>/` 에서 연다. 이때 `src/ui/transport.ts` 가 `fetch`·WebSocket 을 터널로 바꿔 끼운다. 폰 알림은 Mac 이 자기 VAPID 키로 직접 보낸다(기존 `PushNotifier`, 클라우드 경유 없음).

Pro(릴레이 이용권)는 클라우드만 판단한다. 티켓 발급·호스트 WS 업그레이드·DO alarm 이 이용권을 직접 확인한다. 로컬은 요금제를 **표시만** 한다(Task 7). 로컬 코드를 고쳐도 릴레이는 생기지 않는다(스펙 §4).

Paddle 은 웹훅(서명 검증, `event_id` 로 멱등, `occurred_at` 으로 순서 판정, 모든 반영은 upsert)으로 구독 상태만 받는다. 체험은 Paddle 이 아니라 클라우드가 자체 행으로 관리하고, 계정을 지워도 정규화한 이메일의 키 해시는 남겨 체험을 다시 받지 못하게 한다.

**Tech Stack:**
- 로컬: TypeScript(Node 24, ESM), `ws`·`zod`·`web-push`(기존 런타임 의존성), WebCrypto(`globalThis.crypto.subtle`), React 19, vitest + @testing-library/react.
- 암호: Noise KK. Task 1 Step 1 에서 검증된 Noise 구현을 고르고, 맞는 것이 없으면 Noise 사양(rev 34 §5 HandshakeState) 그대로 얇게 구현한다. 어느 쪽이든 **공식 테스트 벡터 통과가 합격 조건**이다. X25519 는 WebCrypto 를 먼저 쓰고, 런타임이 지원하지 않으면 `@noble/curves`(착수 시 확인)로 대신한다. 런타임 의존성이 하나 늘 수 있다(D3, 사용자 결정).
- 클라우드(`cloud/` 자체 `package.json`): Cloudflare Workers + Durable Objects(Hibernation WebSocket API) + D1 + R2 + Cron Triggers, `wrangler`, `@cloudflare/vitest-plugin`(로컬 workerd/miniflare 테스트, vitest `^4.1`). 런타임 의존성은 없다.
- 결제: Paddle Billing(웹훅 + Paddle.js 오버레이 체크아웃 + 고객 포털·구독 해지 API).
- 메일: Resend HTTP API, `EmailSender` 인터페이스 뒤에 둔다(D9).
- QR: `qrcode-generator`(UI devDependency, D10).

**Spec:**
- `docs/superpowers/specs/2026-10-15-quarterdeck-paid-design.md` 의 §1(핵심 약속 2·4), §4(티어), §5.1(Pro 모듈·entitlement 24시간·7일 유예 — 출시 뒤 Task 13), §5.3(클라우드), §5.4(결제), §6(보안), §7(4~6주차: "폰에서 릴레이 경유 승인 성공"), §10-4, §11.
- 확정 결정: `docs/superpowers/specs/2026-10-22-ai-msg-launch-readiness.md` §5 D1(Apache-2.0 코어 + **클라우드 비공개**), §2 Anthropic 행("Pro 문구는 릴레이·푸시만"), L8(같은 벤더 다계정 순환).
- 법적 문서 초안: `docs/legal/{terms,privacy,refund}{,.ko}.md`(별도 작업에서 작성 중, Task 12 가 빌드해 싣는다).
- UI 기준: `docs/superpowers/specs/2026-10-21-ui-overhaul-design.md`(설정 4묶음의 **계정**, 시트·SheetHead, 토큰, 터치 44px, 대비 4.5).
- ws 호환 규칙: `docs/protocol.md`.
- 형식 기준: `docs/superpowers/plans/2026-10-18-quarterdeck-packaging.md`.

## Global Constraints

- **선행 조건:** 리네임(`ai-msg`) 작업이 master 에 병합된 뒤 시작한다. Task 1 Step 0 에서 `node -p "require('./package.json').name"` 이 `ai-msg` 이고 `git status --short` 가 깨끗한지 확인하고, 아니면 멈추고 보고한다. 환경 변수 접두사·설정 폴더는 병합된 코드를 따른다. 이 문서는 지금 코드 기준인 `DECK_*`·`<configDir>`(=`resolveConfigDir`)로 쓴다. 리네임이 접두사를 바꿨으면 `DECK_CLOUD_URL` 같은 새 이름도 같은 규칙으로 바꾼다(D16).
- **무료 기능은 클라우드와 무관하게 동작한다.**
  - `startServer` 는 클라우드 호출을 기다리지 않는다. `CloudService.start()` 는 listen 과 `attachWebSocket` 이 끝난 **뒤에** 시작하고, 그 안의 오류는 모두 잡아 상태(`relay: 'down'`)와 로그 한 줄로만 남긴다.
  - 클라우드에 연결하지 않은 설치는 클라우드로 요청을 하나도 보내지 않는다(테스트로 고정).
  - `DECK_CLOUD=off` 면 `/api/cloud/*` 가 404 이고 기능 이름 `cloud` 도 알리지 않는다.
- **유료 기능은 클라우드만 판단한다(출시 1차).** 릴레이 티켓과 DO alarm 이 이용권을 확인한다(호스트 WS 는 이용권 없이도 붙고 `{t:'ent'}` 로 상태만 받는다 — 2차 필수 1). 로컬에는 Pro 게이트·오프라인 유예가 없다(출시 뒤 Task 13). 로컬 기능(다계정·자동 분배·인계·병목·재시도·총사령탑)은 Community 와 똑같이 동작한다.
- **Pro 문구는 릴레이·푸시만.** 같은 벤더 여러 계정 순환(`accounts`)·리셋 승격(`routeFull`)은 유료 게이트에 넣지 않는다 — 한도 회피를 파는 모양이 된다(출시 점검 L8). 랜딩·계정 페이지·결제 페이지 문구도 같다.
- **클라우드는 평문을 보지 않는다.** Worker·DO 코드는 터널 프레임을 해석하지 않는다. 봉투의 머리(종류·기기 id)만 읽는다. 로그에는 메타데이터(사용자 id·호스트 id·기기 id·바이트 수·종료 코드)만 남긴다(스펙 §6). 이것은 Task 3 테스트로 고정한다. 단, 폰 UI 코드를 클라우드가 내려 주는 한계는 "보안 모델과 한계" 대로 문서·랜딩에 적는다.
- **출처 분리(D18).** 폰 UI·폰 API·릴레이 WS 는 relay 출처에만, 로그인·계정·결제·법적 페이지는 app 출처에만 있다. 반대쪽 출처로 오면 404 다. relay 출처 응답은 `Set-Cookie` 를 절대 내지 않고, CSP 는 `script-src 'self'` 이며 제3자 출처를 하나도 허용하지 않는다. app 출처 쿠키는 `Domain` 속성 없이(호스트 전용) 심는다.
- **클라우드 비공개(출시 점검 D1).** `cloud/` 는 `.gitattributes` 의 `export-ignore` 와 `scripts/export-public.sh` 의 금지 경로 목록 두 곳에 넣는다(Task 2). 공개 코어(`src/`)에는 Worker 비밀·운영 주소 외의 운영 정보를 넣지 않는다.
- **자격증명 비접촉 유지:** 클라우드로 CLI 토큰·`auth.json`·키체인 내용을 보내지 않는다. D1 에는 이메일, 토큰의 **sha256 해시**, 공개키만 저장한다. 비밀 토큰은 모두 32바이트 난수를 base64url 로 만들고, 발급 응답에 딱 한 번만 싣는다.
- **런타임 의존성:**
  - 루트는 `ws`·`zod`·`web-push` 셋에 **최대 하나**만 더한다: Task 1 Step 1 에서 고른 Noise 구현, 또는 WebCrypto X25519 가 없는 런타임을 위한 `@noble/curves`(착수 시 확인). 둘 다 필요 없으면 늘리지 않는다. 더하기 전에 사용자 승인을 받는다(D3). 새 devDependency 는 `qrcode-generator` 하나다(D10).
  - `cloud/` 는 런타임 의존성 0. devDependency 는 `wrangler`·`@cloudflare/vitest-plugin`·`vitest`·`typescript`·`@cloudflare/workers-types` 다.
  - `cloud/` 는 루트 npm 패키지(`files: dist`)에 들어가지 않는다.
- **공유 코드 규칙:** `src/shared/cloud/*.ts` 는 `node:` import 와 DOM 전용 API 를 쓰지 않는다. `globalThis.crypto`·`TextEncoder`·`Uint8Array`(와 D3 에서 승인한 의존성 하나)만 쓴다. `noise.ts`·`pairing.ts` 는 Node·브라우저만 쓰고, `cloud/` 는 `envelope.ts`·`b64.ts`·`api-types.ts` 만 상대 경로로 import 한다(`cloud/tsconfig.json` 의 `include` 에 그 세 파일). 이 세 파일은 서로만 상대 경로로 import 하고 패키지(zod 등)는 쓰지 않는다 — Worker 번들에 들어가기 때문이다(`src/hygiene.test.ts` 가 검사). 봉투는 `envelope.ts` 에 있고 `frames.ts` 가 다시 export 한다. Worker 는 복호화하지 않는다.
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
  - 새 필드는 선택 필드로만 더한다. 새 메시지 종류는 만들지 않는다.
  - 기능 이름 `cloud` 를 `FEATURES` 에 더하고 표에 한 줄 적는다. UI 는 `has()` 로만 판단한다. (`pro` 기능 이름과 `hello.pro`·`settings.pro` 는 출시 뒤 Task 13.)
  - 릴레이 기기가 보낸 "Mac 확인 필요" ws 메시지는 `RelayBridge` 가 기존 `error` 메시지에 새 `code: 'mac_confirm_required'` 를 붙여 그 스트림에만 돌려준다. 이 코드는 `docs/protocol.md` 의 error 코드 표에 적는다.
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

1. **페어링 때 클라우드가 폰 공개키를 바꿔치기하거나, 누가 QR 을 엿봤다.** 기대: QR 에만 있는 `authSecret` 으로 만든 HMAC(`pairingMac`)이 Mac 에서 맞지 않으면 거절·해제한다. MAC 이 맞아도 Mac 은 확인 코드 6자리(`confirmCode`)를 보여 주고 사용자가 [허용] 을 눌러야 확정한다. 같은 페어링에 올바른 claim 이 두 번 오면 클라우드가 페어링을 `burned` 로 바꾸고 두 기기를 모두 해제한다. → Task 1 `pairing.test.ts`, Task 2 `pairing.test.ts`, Task 5a `Pairing.test.ts`.
2. **재전송·순서 바꿈·방향 혼동 프레임, 핸드셰이크 전사 변조.** 기대: Noise CipherState 논스가 맞지 않거나 비트가 바뀌었으면 복호화 실패로 세션을 닫는다. prologue(버전·기기 id·호스트 id)나 핸드셰이크 메시지가 바뀌면 핸드셰이크가 실패한다. 공식 테스트 벡터를 통과한다. → Task 1 `noise.test.ts`·`noise.vectors.test.ts`, Task 4b `RelayBridge.test.ts`.
3. **폰이 다른 기기 id 를 사칭한다.** 기대: DO 가 봉투의 출처 id 를 소켓 태그(`dev:<id>`)로 덮어쓴다. Mac 은 로컬 신뢰 목록(`<configDir>/cloud/state.json` 의 `devices`)에 있는 공개키로만 핸드셰이크를 받는다. → Task 3 `relay.test.ts`, Task 4b.
4. **클라우드 장애·미연결 상태로 시작한다.** 기대: 서버가 정상으로 뜨고, 무료 기능(세션·승인·LAN 접속·로컬 푸시)이 그대로이며, 클라우드 요청은 0건(미연결) 또는 백오프 재시도(연결됨)다. → Task 4b `CloudService.test.ts`, Task 11 장애 테스트.
5. **구독 갱신 순간에 릴레이가 끊긴다.** 기대: `active` 의 이용권은 `period_end + 48시간` 까지라 갱신 웹훅이 늦어도 끊기지 않는다. 이용권이 없는 동안에도 Mac 은 릴레이에 붙어 있고, 결제 웹훅의 recheck 가 `{t:'ent',ok:true}` 로 바로 알려 폰이 수 초 안에 티켓을 받는다(2차 필수 1). → Task 9 `paddle.webhook.test.ts`, Task 3 `relay.test.ts`, Task 4a `RelayClient.test.ts`.
6. **Paddle 웹훅 중복·순서 역전·서명 위조·결정적 오류.** 기대: 같은 `event_id` 는 한 번만 기록하고, 반영은 전부 upsert 라 두 번 와도 같다. 더 오래된 `occurred_at` 은 상태를 되돌리지 못한다. 서명 오차가 5초를 넘거나 원문이 바뀌었으면 401 이다. 고객 id 충돌 같은 업무 충돌은 200 + `outcome` 기록 + 알림이고 재시도를 부르지 않는다. 브라우저가 보낸 `user_id` 는 믿지 않는다(서버 서명 토큰만). → Task 9.
7. **폰(릴레이 기기)이 Mac 확인이 필요한 동작을 한다.** 폰이 `/api/restart`·`/api/setup/*`·`/api/login`·`/api/cloud/unlink` 를 부르거나, ws 로 권한 모드를 올리는 경우다. 기대: `relayPathPolicy`·`relayWsPolicy` 가 `mac_confirm_required` 로 막고 루프백에는 닿지 않는다. 폰이 보낸 `cookie`·`authorization`·`origin`·`host` 머리는 버린다. → Task 4b `pathPolicy.test.ts`·`wsPolicy.test.ts`.
8. **기기를 해제했는데 열린 채널이 살아 있다.** 기대: Mac 에서 해제하면 그 기기의 Noise 세션과 루프백 스트림이 즉시 닫힌다. 계정 페이지(클라우드)에서 해제하면 DO 가 호스트에게 `{t:'revoked',dev}` 를 보내고 Mac 이 로컬 신뢰 목록에서도 지운다. → Task 4b `RelayBridge.test.ts`, Task 3 `relay.test.ts`.
9. **Mac 과 폰 UI 버전이 다르거나, 릴레이 탈취자가 옛 UI 로 끌고 간다.** 기대: `hostVersion` 은 Noise 두 번째 메시지 페이로드로 인증되고, 폰은 `ready` 를 검증한 뒤에만 `/v/<hostVersion>/` 로 옮긴다. 버전 문자열은 semver 모양만 받는다. → Task 1, Task 5b `RelayConnection.test.ts`.
10. **같은 출처의 제3자 스크립트가 기기 키에 닿는다.** 기대: 폰 UI 는 relay 출처에만 있고, relay 출처 응답에는 `Set-Cookie` 가 없으며 CSP 가 제3자 출처를 허용하지 않는다. `/checkout`·`/account` 는 relay 출처에서 404 다. → Task 2 `origins.test.ts`, Task 5c `ui.test.ts`, Task 11 `security.test.ts`.
11. **DO 가 잠들지 못해 비용이 폭증한다.** 기대: DO 안에 `setInterval`·`setTimeout` 상주 타이머가 없다. 핑은 `setWebSocketAutoResponse` 로 깨우지 않고 답하고, 이용권 만료는 alarm 으로 처리한다. → Task 3 코드 검사 테스트(부하 스크립트는 출시 뒤 Task 14).

---

## 현재 결합 지점 (master 기준 2026-10-22, 리네임 병합 뒤 줄 번호가 조금 밀릴 수 있음)

| 위치 | 결합 | 처리 |
|---|---|---|
| `src/server/server.ts:350` | `attachWebSocket(servers, {...})` — 모든 서버 쪽 조립의 끝 | Task 4b: 그 뒤에 `CloudService` 를 만들고 `start()`(대기 없음), `cleanup` 에 `stop()` |
| `src/server/server.ts:273`, `:326` | `sameVendorRotation: () => settings.get().sameVendorRotation` | 출시 1차에서는 건드리지 않는다. 출시 뒤 Task 8 도 이 줄을 게이트하지 않는다(필수 6, L8) |
| `src/server/server.ts:303-311` | `new BottleneckWatch({ sendPush, retry, … })` | 출시 뒤 Task 8 |
| `src/server/server.ts:337` | Commander `enabled: () => settings.get().commanderEnabled === true` | 출시 뒤 Task 8(D7 재검토) |
| `src/server/http.ts:32-66` | `HttpDeps` — 기능별 선택 의존성 | Task 4b: `cloud?: CloudHttpDeps`(없으면 `/api/cloud/*` 없음) |
| `src/server/http.ts:580-598` | `/api/push/{key,subscribe,unsubscribe,status,test}` | Task 5b: 변경 없음 — 폰이 터널로 `key`·`subscribe` 를 부르고 Mac 이 직접 푸시한다. (클라우드 경유는 출시 뒤 Task 6) |
| `src/server/push/PushNotifier.ts:126-129`, `:176-191` | 기본 `send` = `webpush.sendNotification`, `deliver` 의 404/410 정리 | 출시 1차 변경 없음(출시 뒤 Task 6) |
| `src/server/push/SubscriptionStore.ts:4`, `:26` | `PushSub = { endpoint, keys }`, `parseSubscription` | 출시 1차 변경 없음(출시 뒤 Task 6) |
| `src/server/auth.ts` | `COOKIE_NAME = 'deck_session'`, `cookieValueFor(token)`, `checkUpgrade`(Host·Origin 루프백 허용) | Task 4b: `RelayBridge` 가 루프백 요청에 이 쿠키·Origin 을 붙인다(코드 변경 없음). Task 11: `SameSite=Strict`(`:70`) 회귀 테스트 |
| `src/server/bind.ts` | 바인드 주소에 항상 `127.0.0.1` 포함 | Task 4b: 루프백 프록시의 전제(변경 없음, 테스트로 고정) |
| `src/server/routing/AutoRoute.ts:295`, `:485`, `:522` | `RouteInput`, `const cell = cellOf(...)`, 리셋 승격 | 건드리지 않는다(필수 6 — `routeFull` 은 게이트 대상이 아니다) |
| `src/server/turn/TurnRunner.ts:1603`, `:1609`, `:1613`, `:1951` | `claudeAccounts`(순환/고정), Gemini `loggedIn: { g1, g2 }`, `chooseRoute(...)`, `previewRoute` | 건드리지 않는다(필수 6 — `accounts` 는 게이트 대상이 아니다) |
| `src/server/ws.ts` `send` 처리(`msg.handoff`), `:1653`(commander), 계정 고정 검사 | 인계·총사령탑·계정 고정 | 출시 뒤 Task 8(인계·총사령탑만) |
| `src/shared/protocol.ts:239`, `:270`, `:272` | `FEATURES`, `hello`, `settings` | Task 4b: `'cloud'` / 출시 뒤 Task 13: `'pro'`, `hello.pro?`, `settings.pro?` |
| `src/ui/ws.ts:25`, `:36` | `${proto}://${location.host}/ws`, 닫힐 때 `fetch('/api/me')` | Task 5b: 릴레이 모드면 `openTunnelSocket()`·`apiFetch` |
| `src/ui/push.ts` | SW `/sw.js` scope `/` 등록, `/api/push/*` 호출 | Task 5b: `apiFetch`(릴레이 모드에서도 Mac 의 `publicKey` 로 구독) |
| `src/ui/components/Lightbox.tsx:4`, `src/ui/sessionApi.ts:143`, `src/ui/components/FileMenu.tsx:246`, `src/ui/components/ShareMenu.tsx:13` | 브라우저가 직접 여는 `/api/attachments/:id`·`/api/file?…raw=1` 주소, `window.open` | Task 5b: 릴레이 모드는 터널로 받아 blob URL(`useApiUrl`) |
| `src/ui/` 의 `fetchFn = fetch` 기본값과 직접 `fetch(` 호출(`sessionApi.ts`·`pins.ts`·`upload.ts`·`ActivityButton.tsx`·`FolderPicker.tsx`·`ComposerSuggest.tsx`·`MemoryEditor.tsx`·`SessionCwdDialog.tsx`·`Sidebar.tsx`·`ActivitySheet.tsx`·`UsageSheet.tsx`·`Highlights.tsx`·`UsageView.tsx` 등) | 같은 출처 HTTP 가정 | Task 5b: 기본값을 `apiFetch` 로 바꾸고 `transport.guard.test.ts` 로 고정 |
| `src/ui/components/SettingsView.tsx` `SETTINGS_GROUPS` | `['account','계정']` 묶음 | Task 5a: `CloudSection` / Task 7: 요금제 행 / Task 10: [구독 관리] |
| `src/ui/components/Pane.tsx:120-122`, `src/ui/components/ContextGauge.tsx`(ContextHint) | 원클릭 인계 `send{handoff:true}` | 출시 뒤 Task 8 |
| `vite.config.ts` | root `src/ui`, base 기본값, `__DECK_VERSION__` | Task 5a: `--mode relay` 면 `__AIMSG_RELAY__ = true`(base 는 `--base /v/<ver>/`) |
| `src/ui/public/sw.js`, `manifest.webmanifest` | 루트 scope SW | Task 5c: 클라우드가 relay 출처 루트에서 `/sw.js`·`/manifest.webmanifest` 를 내보낸다 |
| `src/server/paths.ts` `resolveConfigDir` | 설정 폴더 | Task 4a: `<configDir>/cloud/state.json` |
| `src/server/http.ts:320`(`isAllowedHost`), `:325`(`stateChangingOriginOk`) | 로컬 서버의 Host 허용 목록·상태 변경 Origin 검사 | Task 11: `/api/cloud/*` 회귀 테스트(코드 변경 없음) |
| `src/server/http.ts:360`(`/api/restart`), `:377`(`/api/setup*`) | 재시작·첫 실행 마법사 | Task 4b: `relayPathPolicy` 가 `mac_confirm_required` |
| `src/shared/protocol.ts:138`(`set_permission_mode`), `:140`(`set_sandbox`), `:147`(`set_settings`), `:52`(`send.permissionMode`), `src/shared/permission.ts:6`(`PERM_MODES`) | 권한 모드·샌드박스·자동 승인 | Task 4b: `relayWsPolicy` 가 상향을 `mac_confirm_required` |
| `.gitattributes`, `scripts/export-public.sh:35` | 공개본 제외 목록(두 곳) | Task 2: `cloud` 추가(D11) |

## 프로토콜 계약 (Task 1·2·3·4a·4b·5a·5b·5c 가 지키는 기준)

**두 출처 (D18)** — Worker 하나가 `Host` 머리로 나눈다. 반대쪽 출처로 온 요청은 404 다.

| 출처 | 경로 |
|---|---|
| app (`PUBLIC_ORIGIN`, 기본 `https://app.aimsg.app`) | `/login`·`/auth/*`·`/link`·`/account`·`/checkout`·`/legal/*`·`/static/*`(페이지용), `/v1/auth/*`, `/v1/host/*`, `/v1/pair/start`, `/v1/pair/:id`(+`/confirm`·`/reject`), `/v1/devices*`, `/v1/entitlement`, `/v1/billing/*`, `/v1/account/*`, `/v1/paddle/webhook`, `/dev/outbox` |
| relay (`RELAY_ORIGIN`, 기본 `https://relay.aimsg.app`) | `/`(부트스트랩)·`/boot.js`·`/version.json`·`/v/<ver>/*`·`/sw.js`·`/manifest.webmanifest`·`/icons/*`, `/v1/pair/claim`, `/v1/relay/ticket`, `/relay/host`, `/relay/device` |

relay 출처는 쿠키를 읽지도 심지도 않는다. 폰 UI 가 app 출처의 페이지(계정·법적 페이지)를 열 때는 새 탭 링크로만 연다.

**식별자와 토큰** — 모두 32바이트 난수를 base64url 로 만들고, D1 에는 sha256 base64url 만 저장한다.
- `hostToken`: Mac 이 클라우드 API·릴레이에 쓴다. `Authorization: Bearer`.
- `deviceToken`: 폰이 티켓 발급에 쓴다.
- `ticket`: 60초 일회용. 폰 WS 주소의 `?ticket=` 에 싣는다. 브라우저 WebSocket 은 머리를 지정할 수 없어서다.
- `claimSecret`·`authSecret`: 페어링 QR 에만 있다. 클라우드에는 `sha256(claimSecret)` 만 간다.

**길이 접두 연결 `lp`** — MAC·확인 코드·prologue 의 입력은 모두 `lp(x) = u16be(len(x)) ‖ x` 를 이어 붙인다(경계 모호성 방지). 문자열은 UTF-8 바이트다.

**페어링 (QR 일회용, 5분, Mac [허용] 필수)**
1. Mac 이 app 출처에 `POST /v1/pair/start {claimHash}` 를 보내 `{pairingId, expiresAt}` 를 받는다.
2. Mac 이 QR 을 띄운다. 주소는 `https://<relay>/v/<hostVersion>/#pair=2.<pairingId>.<claimSecret>.<authSecret>.<hostPub>` 이고(조각이라 서버 로그에 남지 않음), `hostPub` 은 X25519 공개키 32바이트 base64url 이다.
   - QR 아래에 같은 내용의 **페어링 코드** `2.<pairingId>.<claimSecret>.<authSecret>.<hostPub>`(= `#pair=` 뒤 문자열) 를 [복사] 버튼과 함께 보여 준다. iOS 홈 화면 PWA 는 Safari 와 저장소를 따로 쓸 수 있어서(실기 확인 전 추정), 이미 설치한 PWA 안에서 이 코드를 붙여 넣거나 앱 안 스캔으로 페어링할 수 있어야 한다(2차 필수 2, Task 5a·5b).
3. 폰이 X25519 기기 정적 키를 만든다(가능하면 추출 불가 `CryptoKey`, Task 1 D3). 그다음 relay 출처에 `POST /v1/pair/claim {pairingId, claim, devicePub, deviceName, mac}` 을 보내 `{deviceId, deviceToken, hostId}` 를 받는다.
   - `mac = HMAC-SHA256(authSecret, lp("aimsg-pair-v2") ‖ lp(pairingId) ‖ lp(devicePub) ‖ lp(hostPub))`
   - 폰은 받은 직후 **확인 코드** `confirmCode = u32be(sha256(lp("aimsg-sas-v1") ‖ lp(pairingId) ‖ lp(devicePub) ‖ lp(hostPub))[0..4)) mod 1 000 000` 을 6자리(앞 0 채움)로 크게 보여 주고 "Mac 화면의 숫자와 같으면 Mac 에서 [허용] 을 누르세요" 라고 쓴다.
4. 클라우드는 같은 페어링에 **올바른 claim 이 두 번째로 오면** 페어링을 `burned` 로 바꾸고 그 페어링으로 만든 기기를 모두 `revoked` 로 바꾼 뒤 409 `{code:'pairing_burned'}` 를 준다. 틀린 claim 은 지금처럼 `bad_claims` 를 세고 5회면 `expired` 다.
   - **예외 — 같은 폰의 재전송(멱등):** 두 번째 claim 의 `devicePub`·`mac` 이 첫 claim 과 같고 상태가 아직 `claimed` 면 태우지 않는다. 같은 `deviceId` 로 `deviceToken` 을 새로 발급해(`token_hash` 교체 — 첫 응답을 못 받았으니 옛 토큰은 아무도 갖고 있지 않다) 200 을 준다. 응답이 사라져 폰이 다시 보내도 자기 페어링을 태우지 않는다. `devicePub`·`mac` 이 같은데 이미 `confirmed` 면 409 `{code:'already_paired'}`(태우지 않음)이고, 폰은 저장된 기기 정보가 없으면 "새 QR 로 다시 연결하세요" 를 보인다.
5. Mac 이 `GET /v1/pair/:id` 를 폴링해 `devicePub`·`mac`·`deviceName` 을 받는다.
   - MAC 이 틀리면 `POST /v1/pair/:id/reject`(클라우드가 기기 해제)하고 끝낸다.
   - MAC 이 맞으면 **확정하지 않고** PairSheet 에 기기 이름과 같은 공식의 확인 코드를 보여 주며 [허용]·[거부] 를 기다린다(`awaiting_approval`).
   - [허용] → `POST /v1/pair/:id/confirm` → 성공하면 로컬 신뢰 목록에 추가. 클라우드는 `claimed` 상태에서만 confirm 을 받는다(`burned` 면 409).
   - 상태가 `burned` 면 "이 QR 이 두 곳에서 쓰였습니다 — 새 QR 을 만드세요" 를 보여 주고 끝낸다.
6. 기기는 confirm 뒤에만 티켓을 받는다(`devices.state = 'active'`). 그 전의 티켓 요청은 403 `{code:'pending_confirm'}` 이고 폰은 3초마다 다시 묻는다.

**세션 핸드셰이크 (폰 WS 연결마다) — Noise KK**
- 프로토콜 이름 `Noise_KK_25519_AESGCM_SHA256`. 개시자(initiator)는 폰, 응답자(responder)는 Mac 이다. 둘 다 상대 정적 키를 미리 안다(폰: QR 의 `hostPub`, Mac: 신뢰 목록의 `pub`).
- `prologue = lp("aimsg-relay/2") ‖ lp(deviceId) ‖ lp(hostId)`. 둘 중 하나라도 다르면 핸드셰이크가 실패한다.
- 메시지 1(폰 → Mac, 봉투 종류 `hs_init`): Noise `-> e, es, ss` + 페이로드 `{"v":2,"uiVersion":"<semver>"}`(암호화·인증됨).
- 메시지 2(Mac → 폰, 봉투 종류 `hs_ack`): Noise `<- e, ee, se` + 페이로드 `{"v":2,"hostVersion":"<semver>"}`(암호화·인증됨).
- Split 뒤 폰은 `c1` 로 보내고 `c2` 로 받으며, Mac 은 반대다.
- 양쪽은 첫 전송 메시지로 `{t:'ready'}` 를 보낸다. 5초 안에 상대 `ready` 가 오지 않거나 열리지 않으면 세션을 버린다(폰은 4408 로 닫는다).
- **msg1 재전송 방어 — `ready` 복호화 전에는 기존 세션 교체(4409·`dropDevice`) 금지.** 릴레이는 옛 `hs_init` 을 다시 보낼 수 있고 Mac 의 `hostHandshake` 는 거기에도 `Transport` 를 돌려준다. Mac 은 기기의 `ready` 를 그 Transport 로 복호화한 뒤에만(`transport.peerAuthenticated`) 새 세션을 인증된 것으로 보고, 그때 같은 기기의 옛 세션을 버린다. 새 핸드셰이크가 5초 안에 `ready` 를 열지 못하면 새 쪽만 버리고 옛 세션은 그대로 둔다(Task 4b). DO 의 4409 는 티켓으로 인증된 소켓 교체이고 Noise 세션 교체와는 별개다(Task 3).
- **버전 이동은 `ready` 검증 뒤에만** 한다. `hostVersion` 은 `/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/` 에 맞아야 하고, 아니면 이동하지 않고 오류 화면을 보인다.

**전송 메시지**
- 봉투 종류 `data` 의 payload 는 Noise 전송 메시지 그대로다(AES-256-GCM 암호문 + 태그 16바이트, 논스는 CipherState 의 `n` — 4바이트 0 ‖ u64be(n), ad 는 빈 값).
- Noise 메시지 한 개는 65,535바이트 이하다. 그래서 평문은 `NOISE_MAX_PLAINTEXT = 65519` 바이트 이하여야 하고, `encodeTunnel` 이 넘으면 던진다.
- 받는 쪽은 자기 `n` 으로만 연다. 재전송·순서 바꿈·비트 변조는 모두 복호화 실패(`DecryptError`)이고, 그 세션을 닫는다.
- 2^32 메시지를 넘으면 재연결로 새 핸드셰이크를 한다(`RekeyNeeded`).

**봉투 (DO 가 보는 것 전부)** — 바이너리다.

| 위치 | 내용 |
|---|---|
| `[0]` | 종류: 1 data · 2 hs_init · 3 hs_ack · 4 close |
| `[1]` | `peer` 길이(≤64) |
| `[2..2+len)` | `peer`(ASCII. 호스트가 보낼 때는 대상 기기 id, DO 가 호스트에게 넘길 때는 출처 기기 id, 폰 쪽은 `host`) |
| 나머지 | payload(Noise 메시지) |

- DO 는 폰이 보낸 `peer` 를 무시하고 태그의 기기 id 로 덮어쓴다.
- DO 제어 메시지는 텍스트 JSON 이다: `{t:'peer', dev, up}`·`{t:'revoked', dev}`·`{t:'ent', ok, until}`(호스트에게), `{t:'host', up}`(폰에게). 핑은 텍스트 `ping` → `pong`(auto-response)이다.
- **호스트 WS 는 이용권과 무관하게 붙는다**(2차 필수 1). 유효하고 해제되지 않은 hostToken 이면 업그레이드를 받고, DO 는 연결 직후·alarm·`/internal/recheck` 때마다 `{t:'ent', ok, until}` 를 호스트에게 보낸다. 이용권이 없으면 **티켓만** 402 로 막고, alarm 은 기기 소켓만 4402 로 닫는다. 그래서 폰에서 결제해도 웹훅 → `/internal/recheck` 가 이미 붙어 있는 Mac 에 바로 닿는다.
- 호스트 → DO 텍스트 `{"t":"recheck"}` 는 DO 가 이용권을 다시 계산하게 한다(attachment 의 `lastRecheck` 로 30초에 한 번까지, 넘으면 무시).

**터널 프레임 (Noise 전송 메시지 안의 평문 JSON, zod 로 검증)**
- `ready`
- `ws.open{s}` · `ws.msg{s,d}` · `ws.close{s,code?}`
- `http.req{id,m,p,h,b?,more}` · `http.res{id,st,h,b?,more}` · `http.chunk{id,b,more}` · `http.abort{id}`

본문 `b` 는 base64 이고 조각마다 원본 32KiB 이하다(`TUNNEL_CHUNK = 32768` — base64·JSON 을 더해도 `NOISE_MAX_PLAINTEXT` 안). `ws.msg` 의 `d` 가 한도를 넘으면 `ws.msg{s,d,more:true}` 조각으로 나눈다(`chunkString` 은 JSON 이스케이프 뒤 UTF-8 바이트로 잰다). 기기당 동시 `ws` 스트림은 8개, 진행 중 `http` 는 32개까지다. `frames.ts` 는 봉투 크기(`MAX_FRAME`)만 막는다 — `more` 조각 재조립 상한(1MiB)과 동시 스트림 수 상한은 받는 쪽인 DO(Task 3, 프레임 크기)·`RelayBridge`(Task 4b)·`RelayConnection`(Task 5b)이 지킨다.
- `http.req` 의 `p` 는 `/` 하나로 시작하는 출처 상대 경로(`//host`·역슬래시·공백·제어 문자·`.`/`..` 구간과 그 퍼센트 인코딩 금지, 2048자 이하)만 프레임 검증을 통과한다. 그래도 `relayPathPolicy` 는 퍼센트 디코딩·정규화한 경로로 검사한다(Task 4b).

**종료 코드**

| 코드 | 뜻 |
|---|---|
| 4401 | 인증 실패·호스트 연결 해제 |
| 4402 | 이용권 없음 |
| 4403 | 기기 해제 |
| 4408 | 핸드셰이크 시간 초과 |
| 4409 | 같은 호스트·기기의 새 연결로 대체됨 |
| 4413 | 프레임 1MiB 초과 |
| 4429 | 프레임 폭주(소켓당 초당 200·버스트 400 초과, 릴레이가 닫음) |

**이용권 표시 (출시 1차)** — `GET /v1/entitlement`(host Bearer)는 서명 없는 JSON `{plan: 'pro'|'trial'|'comp'|'none', st: 'active'|'trialing'|'past_due'|'canceled'|'none', untilMs, checkedAt}` 을 준다. 로컬은 **표시만** 한다(Task 7). Ed25519 JWS·로컬 검증·오프라인 유예는 출시 뒤 Task 13 이다.

**이용권 계산 (`entitledState`, 클라우드)** — 출처별 `until` 가운데 가장 큰 값을 쓴다.
- 체험: `trials.ends_at`.
- comp: `grants.until`.
- 구독 `active`(해지 예약 포함): `period_end + 48시간`(갱신 웹훅 지연 유예, 필수 7). **해지를 예약한 구독은 `period_end + 48시간` 까지 쓸 수 있다**(2차 권장). 예약만으로는 `until` 이 줄지 않는다. 기간 끝에 `canceled` 웹훅이 와도, 그 전에 `scheduled_cancel = 1` 이었고 전액 환불·차지백(`refunds.full = 1`)이 없으면 `until = max(canceled_at, period_end + 48시간)` 를 유지한다. 이 유예는 `docs/legal/refund*.md` 3절에 적었다.
- 구독 `past_due`: `past_due 로 바뀐 이벤트의 occurred_at + 7일`(권장 5).
- 구독 `canceled`·`paused`(위 예약 해지 예외 밖): `canceled_at ?? occurred_at`.

---

## File Structure

출시 1차 파일만 적는다. 출시 뒤 Task(6·8·13·14)의 파일은 각 Task 의 **Files** 블록에 있다.

새 파일 — 공유:

| 파일 | 책임 |
|---|---|
| `src/shared/cloud/b64.ts` | base64url 인코드·디코드, `randomToken(bytes)`, `sha256B64u`, `timingSafeEqual`, `lp(...)` |
| `src/shared/cloud/noise.ts` | Noise KK(`Noise_KK_25519_AESGCM_SHA256`) — `X25519Key`, `deviceHandshake`·`hostHandshake`, `Transport`(encrypt/decrypt), 오류 클래스. Task 1 Step 1 에서 고른 라이브러리를 감싸거나 사양 그대로 구현 |
| `src/shared/cloud/noise.fixtures/kk-vectors.json` | 공식 테스트 벡터에서 이 계획이 쓰는 KK 항목만 옮긴 것(출처·라이선스 머리말 포함) |
| `src/shared/cloud/envelope.ts` | 봉투 encode/decode, 상수(`TUNNEL_CHUNK`, `NOISE_MAX_PLAINTEXT`, `MAX_FRAME`, 종료 코드) — zod 없음, Worker 가 쓴다 |
| `src/shared/cloud/frames.ts` | 터널 프레임 zod 스키마, `chunkBytes`, `envelope.ts` 다시 export |
| `src/shared/cloud/pairing.ts` | QR 주소 encode/parse, `pairingMac`, `confirmCode`, `claimHash` |
| `src/shared/cloud/api-types.ts` | 클라우드 HTTP API 요청·응답 타입(Worker 와 로컬 클라이언트가 공유) |

새 파일 — 클라우드(`cloud/`, 비공개):

| 파일 | 책임 |
|---|---|
| `cloud/package.json`, `cloud/package-lock.json`, `cloud/tsconfig.json`, `cloud/vitest.config.ts`, `cloud/wrangler.jsonc` | 패키지·빌드·테스트·배포 설정(D1 `DB`, DO `RELAY`, R2 `UI`, Cron) |
| `cloud/migrations/0001_init.sql` … `0004_account.sql` | D1 스키마(Task 2·3·9·12) |
| `cloud/src/index.ts` | `export default { fetch, scheduled }`, `export { RelayRoom }`, 기동 설정 검사 |
| `cloud/src/env.ts` | `Env` 타입(바인딩·비밀·변수) |
| `cloud/src/router.ts`, `cloud/src/http.ts`, `cloud/src/origins.ts` | 작은 라우터, `json()`·`problem()`·Origin 검사·CSP 머리, 호스트 이름으로 app/relay 출처 나누기 |
| `cloud/src/auth/tokens.ts`, `cloud/src/auth/magic.ts`, `cloud/src/auth/session.ts`, `cloud/src/auth/email.ts` | 토큰·해시, 매직링크, 웹 세션 쿠키, 이메일 정규화·키 해시 |
| `cloud/src/email.ts` | `EmailSender`(`log`·`resend`) |
| `cloud/src/rate.ts` | D1 고정 창 속도 제한 |
| `cloud/src/hosts.ts`, `cloud/src/pairing.ts`, `cloud/src/devices.ts` | 호스트 연결(장치 코드), 페어링(두 번 claim 폐기), 기기 목록·해제(DO 통지) |
| `cloud/src/entitled.ts` | `entitledState(db, userId, nowMs)` — 체험·comp·구독을 합친 `{plan, st, untilMs}` |
| `cloud/src/relay/RelayRoom.ts`, `cloud/src/relay/routes.ts`, `cloud/src/relay/tickets.ts` | 릴레이 DO, 업그레이드 라우트, 티켓 |
| `cloud/src/entitlement.ts` | `GET /v1/entitlement`(표시용, 서명 없음) |
| `cloud/src/paddle/signature.ts`, `cloud/src/paddle/webhook.ts`, `cloud/src/paddle/apply.ts`, `cloud/src/paddle/api.ts`, `cloud/src/paddle/userRef.ts` | 서명 검증, 웹훅 수신, 상태 반영(upsert), `PaddleApi`(포털·해지), 서버 서명 user 참조 |
| `cloud/src/ops.ts` | `alert(db, kind, ref)` — `ops_alerts` 행 + 구조화 로그 |
| `cloud/src/ui.ts` | relay 출처의 `/`(부트스트랩)·`/v/*`·`/sw.js`·`/manifest.webmanifest`·아이콘을 R2 에서 |
| `cloud/src/pages/{login,verify,link,account,checkout,legal}.ts`, `cloud/src/pages/layout.ts` | 서버 렌더 HTML(영어, 인라인 스크립트 없음), 공통 바닥글(법적 링크·비제휴 고지) |
| `cloud/src/legal/notice.ts` | 비제휴 고지 문구(en/ko) |
| `cloud/scripts/build-legal.mjs` | `docs/legal/*.md` → `cloud/src/legal/pages.gen.ts`(gitignore, `pretest`·`predev`·`predeploy` 에서 생성) |
| `cloud/src/account.ts` | 계정 삭제 |
| `cloud/src/cleanup.ts` | `runCleanup(env, nowMs)` — 만료 행 정리(cron) |
| `cloud/static/{account.js,checkout.js,pages.css}`, `cloud/static/boot.js` | app 출처 페이지 스크립트·스타일, relay 출처 부트스트랩 스크립트 |
| `cloud/scripts/publish-ui.sh` | `vite build --mode relay --base /v/<ver>/` → R2 업로드 |
| `cloud/test/helpers.ts`, `cloud/test/*.test.ts`, `cloud/test/fixtures/paddle/*.json` | 워커 테스트 |
| `cloud/README.md` | 배포·운영 절차(사용자용) |

새 파일 — 로컬 서버:

| 파일 | 책임 |
|---|---|
| `src/server/cloud/config.ts` | `cloudConfig(env)` — app 주소(`DECK_CLOUD_URL`), relay 주소(`DECK_RELAY_URL`), 끄기(`DECK_CLOUD=off`) |
| `src/server/cloud/CloudState.ts` | `<configDir>/cloud/state.json`(호스트 id·토큰·X25519 호스트 키·신뢰 기기·마지막 요금제) |
| `src/server/cloud/CloudApi.ts` | 클라우드 HTTP 클라이언트(시간 제한 10초, `fetch` 주입) |
| `src/server/cloud/HostLink.ts` | 장치 코드 연결 시작·폴링 |
| `src/server/cloud/RelayClient.ts` | 바깥으로 여는 WS, 백오프, 종료 코드 처리 |
| `src/server/cloud/RelayBridge.ts` | 기기별 Noise 핸드셰이크·전송·터널 → 루프백, 해제 즉시 종료 |
| `src/server/cloud/loopback.ts`, `src/server/cloud/pathPolicy.ts`, `src/server/cloud/wsPolicy.ts` | 루프백 대상·머리, 터널 HTTP 정책, 터널 ws 메시지 정책(Mac 확인 필요 동작) |
| `src/server/cloud/Pairing.ts` | QR 만들기·폴링·검증·확인 코드·[허용] 대기·확정 |
| `src/server/cloud/PlanView.ts` | `/v1/entitlement` 를 받아 표시용 상태로(검증·게이트 없음) |
| `src/server/cloud/CloudService.ts` | 조립·상태·시작/정지 |
| `src/server/cloud/testkit.ts` | `FakeRelay`(DO 흉내), `fakeCloudFetch` |
| `src/server/cloud/texts.ts` 또는 `src/server/i18n/{en,ko}/cloud.ts` | 서버 문구 |

새 파일 — UI:

| 파일 | 책임 |
|---|---|
| `src/ui/transport.ts` | `isRelayMode()`, `apiFetch`, `openSocket`, `setRelayConnection` |
| `src/ui/relay/keystore.ts` | `KeyStore` 인터페이스 + IndexedDB 구현 + 메모리 구현(테스트) |
| `src/ui/relay/pairing.ts` | `#pair=` 처리, claim, 확인 코드 표시 상태, 저장, 조각 지우기 |
| `src/ui/relay/RelayConnection.ts` | 티켓 → WS → Noise 핸드셰이크 → 전송 → 다중화, 재연결 |
| `src/ui/relay/tunnelFetch.ts`, `src/ui/relay/tunnelSocket.ts` | 터널 위 `fetch`·WebSocket 흉내 |
| `src/ui/relay/blobUrl.ts` | `useApiUrl(path)` — 릴레이 모드면 blob URL |
| `src/ui/relay/RelayGate.tsx` | 릴레이 모드의 연결 상태 화면(로그인 화면 대신), 확인 코드 화면, 재페어링 안내 |
| `src/ui/qr.ts` | `qrSvgPath(text)` — `qrcode-generator` 래퍼 |
| `src/ui/cloudApi.ts` | `/api/cloud/*` 호출 |
| `src/ui/components/CloudSection.tsx`, `src/ui/components/PairSheet.tsx` | 설정 › 계정의 클라우드·요금제 행, 폰 연결 시트(확인 코드·[허용]) |
| `src/ui/cloudTexts.ts` 또는 `src/ui/i18n/{en,ko}/cloud.ts` | UI 문구 |
| `src/ui/transport.guard.test.ts` | `fetch(`·`= fetch` 직접 사용 금지 검사 |

새 파일 — 스크립트·문서: `scripts/release.sh`(5c), `scripts/probe/ios-pwa/*`(Task 5 앞 실기 확인), `scripts/smoke/relay-e2e.sh`, `scripts/smoke/relay-phone.ts`, `scripts/render/cloud-section.html`, `scripts/render/pair-sheet.html`, `docs/security-model.md`, `docs/privacy-data-inventory.md`.

수정하는 파일은 다음과 같다.
- 서버: `src/server/server.ts`, `src/server/http.ts`, `src/shared/protocol.ts`(`FEATURES` 에 `cloud`, error 코드 `mac_confirm_required` 설명)
- UI: `src/ui/ws.ts`, `src/ui/push.ts`, `src/ui/App.tsx`, `src/ui/sessionApi.ts`, `src/ui/components/{SettingsView,Lightbox,FileMenu,ShareMenu}.tsx`, Task 5b 표의 `fetchFn` 기본값 파일들
- 설정·문서·검사: `vite.config.ts`, `package.json`, `package-lock.json`, `.gitignore`, `.gitattributes`(D11), `docs/protocol.md`, `src/hygiene.ts`, `scripts/contrast-check.mjs`, `scripts/export-public.sh`(D11), `README.md`

---

### Task 1: 공유 릴레이 프로토콜 — Noise KK·봉투·터널 프레임·페어링

**Files:**
- Create: `src/shared/cloud/b64.ts`, `src/shared/cloud/noise.ts`, `src/shared/cloud/frames.ts`, `src/shared/cloud/pairing.ts`, `src/shared/cloud/api-types.ts`, `src/shared/cloud/noise.fixtures/kk-vectors.json`
- Test: `src/shared/cloud/noise.test.ts`, `src/shared/cloud/noise.vectors.test.ts`, `src/shared/cloud/frames.test.ts`, `src/shared/cloud/pairing.test.ts`, `src/shared/cloud/testHex.ts`(테스트 도우미)
- Modify(조건부): `package.json`·`package-lock.json` — Step 1 에서 고른 의존성이 있고 사용자가 승인했을 때만(D3)

**Interfaces:**
- `b64.ts`: `toB64u(u8: Uint8Array): string`, `fromB64u(s: string): Uint8Array`(잘못된 글자면 `TypeError`), `randomToken(bytes = 32): string`, `sha256B64u(s: string | Uint8Array): Promise<string>`, `timingSafeEqual(a: string, b: string): boolean`, `lp(...parts: (string | Uint8Array)[]): Uint8Array`(각 조각 `u16be(len) ‖ bytes`, 65535 바이트 넘으면 `RangeError`).
- `noise.ts`:
  - `const PROTOCOL_NAME = 'Noise_KK_25519_AESGCM_SHA256'`, `const NOISE_MAX_MSG = 65535`, `const NOISE_MAX_PLAINTEXT = 65519`
  - `interface X25519Key { readonly publicRaw: Uint8Array /* 32B */; dh(peerPublic: Uint8Array): Promise<Uint8Array /* 32B */> }` — DH 를 인터페이스로 둬서 폰은 추출 불가 `CryptoKey` 를 그대로 쓴다.
  - `generateStaticKey(o: { extractable: boolean }): Promise<StaticKey>`; `type StaticKey = X25519Key & { readonly privateKey: CryptoKey }`
  - `exportStaticPrivate(k: StaticKey): Promise<string>`(pkcs8 base64url, 호스트 저장용), `importStaticPrivate(pkcs8B64u: string, o?: { extractable?: boolean }): Promise<StaticKey>`, `importRawPrivate(raw32: Uint8Array): Promise<StaticKey>`(테스트 벡터용 — pkcs8 고정 머리 `302e020100300506032b656e04220420` ‖ raw)
  - `class HandshakeState` — KK 만. `constructor(o: { initiator: boolean; prologue: Uint8Array; s: X25519Key; rs: Uint8Array; e?: X25519Key /* 벡터 테스트 전용 */ })`, `writeMessage(payload: Uint8Array): Promise<Uint8Array>`, `readMessage(msg: Uint8Array): Promise<Uint8Array>`, `split(): Promise<{ send: CipherState; recv: CipherState }>`(개시자는 `send=c1`, 응답자는 `send=c2`), `readonly handshakeHash: Uint8Array`(split 뒤)
  - `class CipherState { readonly n: bigint; encrypt(ad: Uint8Array, plain: Uint8Array): Promise<Uint8Array>; decrypt(ad: Uint8Array, ct: Uint8Array): Promise<Uint8Array> }` — 실패해도 `n` 을 올리지 않는다(사양 §5.1).
  - `class Transport { constructor(send: CipherState, recv: CipherState); encrypt(plain: Uint8Array): Promise<Uint8Array>; decrypt(ct: Uint8Array): Promise<Uint8Array> }` — ad 는 빈 값, 평문이 `NOISE_MAX_PLAINTEXT` 를 넘으면 `RangeError`, 한쪽 `n` 이 `2n ** 32n` 에 닿으면 `RekeyNeeded`.
  - `relayPrologue(deviceId: string, hostId: string): Uint8Array` = `lp('aimsg-relay/2', deviceId, hostId)`
  - `deviceHandshake(o: { self: X25519Key; hostPublic: Uint8Array; deviceId: string; hostId: string; uiVersion: string }): Promise<{ msg1: Uint8Array; finish(msg2: Uint8Array): Promise<{ transport: Transport; hostVersion: string }> }>`
  - `hostHandshake(o: { self: X25519Key; devicePublic: Uint8Array; deviceId: string; hostId: string; msg1: Uint8Array; hostVersion: string }): Promise<{ msg2: Uint8Array; transport: Transport; uiVersion: string }>`
  - `isSemver(s: string): boolean` — `/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/`, 40자 이하
  - 오류: `class HandshakeError`(prologue·정적 키·메시지 변조·페이로드 형식), `class DecryptError`(전송 복호화 실패 — 재전송·순서 바꿈·변조 포함), `class RekeyNeeded`
- `frames.ts`:
  - `enum EnvKind { Data = 1, HsInit = 2, HsAck = 3, Close = 4 }`
  - `encodeEnvelope(e: { kind: EnvKind; peer: string; payload: Uint8Array }): Uint8Array`, `decodeEnvelope(u8: Uint8Array): { kind: EnvKind; peer: string; payload: Uint8Array } | null`(peer 가 64자를 넘거나 ASCII 가 아니면 null)
  - `TunnelFrame`(zod 판별 유니온 — `ready`, `ws.open`, `ws.msg{s,d,more?}`, `ws.close`, `http.req`, `http.res`, `http.chunk`, `http.abort`), `parseTunnelFrame(json: unknown): TunnelFrame | null`, `encodeTunnel(f: TunnelFrame): Uint8Array`(UTF-8 결과가 `NOISE_MAX_PLAINTEXT` 를 넘으면 `RangeError`)
  - `chunkBytes(u8: Uint8Array, size = TUNNEL_CHUNK): Uint8Array[]`, `chunkString(s: string, size = TUNNEL_CHUNK): string[]`(UTF-16 대리쌍을 자르지 않는다)
  - `const TUNNEL_CHUNK = 32768`, `const CLOSE = { unauthorized: 4401, notEntitled: 4402, revoked: 4403, hsTimeout: 4408, replaced: 4409, tooLarge: 4413, rateLimited: 4429 } as const`, `const MAX_FRAME = 1 << 20`
- `pairing.ts`:
  - `type PairQr = { v: 2; pairingId: string; claim: string; auth: string; hostPub: string; hostVersion: string; relayOrigin: string }`
  - `encodePairUrl(q: PairQr): string`, `parsePairHash(hash: string): Omit<PairQr, 'relayOrigin' | 'hostVersion'> | null`(v1 형식·글자 수가 다른 `hostPub` 은 null)
  - `claimHash(claim: string): Promise<string>`
  - `pairingMac(auth: string, o: { pairingId: string; devicePub: string; hostPub: string }): Promise<string>`, `verifyPairingMac(auth, o, mac): Promise<boolean>`(상수 시간 비교)
  - `confirmCode(o: { pairingId: string; devicePub: string; hostPub: string }): Promise<string>` — 6자리 문자열(앞 0 채움)
- `api-types.ts`: Task 2·3·7·9·10·12 의 요청·응답 타입(`LinkStartRes`, `LinkPollRes`, `PairStartRes`, `PairClaimReq`, `PairClaimRes`, `PairStatusRes`(`state: 'open' | 'claimed' | 'confirmed' | 'rejected' | 'burned' | 'expired'`), `TicketRes`, `DeviceInfo`, `EntitlementRes`(`{plan, st, untilMs, checkedAt}`), `DeleteAccountReq`)과 `ApiError = { error: string; code?: string }`.

- [ ] **Step 0: 선행 확인** — `git status --short` 가 비어 있고 `node -p "require('./package.json').name"` 이 `ai-msg` 인지 확인한다. 아니면 멈추고 보고한다.
- [ ] **Step 1: Noise 구현 고르기(착수 시 확인)** — 아래 후보를 실제로 열어 보고 결과를 이 Task 의 커밋 메시지 본문과 `docs/security-model.md` 의 "암호 구현" 줄에 남긴다. 이름은 조사 시점의 후보일 뿐이고, 존재·유지 상태·지원 범위는 모두 **착수 시 확인**이다.
  - 후보: `noise-protocol`(npm), `noise-handshake`(npm), `noise-c.wasm`(npm). 공식 사양 사이트(noiseprotocol.org)의 구현 목록도 본다.
  - 합격 조건(모두 만족):
    1. `KK` 패턴과 `25519`·`AESGCM`·`SHA256` 조합을 지원한다.
    2. Node 24 와 브라우저(iOS Safari 포함)에서 네이티브 애드온 없이 돈다.
    3. DH 를 바꿔 끼울 수 있다(폰의 추출 불가 `CryptoKey` 를 쓰려면 필요).
    4. 라이선스가 Apache-2.0 코어와 맞는다.
    5. 전이 의존성이 작다(직접 의존성 2개 이하).
    6. Step 2 의 공식 테스트 벡터를 통과한다.
  - 판정:
    - 합격한 것이 있으면 `noise.ts` 를 그 라이브러리를 감싸는 얇은 층으로 만든다(위 Interfaces 는 그대로). 런타임 의존성이 하나 늘어나므로 **사용자 승인 뒤에** `package.json` 에 넣는다(D3).
    - 합격한 것이 없으면(조건 3 의 DH 교체나 조건 1 의 AESGCM 때문에 그럴 가능성이 높다) Noise 사양 rev 34 §5(CipherState·SymmetricState·HandshakeState)를 WebCrypto 로 그대로 구현한다. 의존성은 늘지 않는다. 라이브러리가 `ChaChaPoly`·`BLAKE2s` 조합만 지원해서 그 조합으로 바꾸려면, 프로토콜 이름·계약 절·Review Focus 2 를 같은 커밋에서 고친다.
  - X25519: `crypto.subtle.generateKey({ name: 'X25519' }, …)` 가 Node 24 와 대상 브라우저(iOS Safari 최소 지원 버전)에서 되는지 **착수 시 확인**한다. 안 되는 런타임이 있으면 그 런타임에서만 `@noble/curves` 의 x25519(착수 시 확인)를 쓴다. 이때 폰 키는 추출 불가가 아니라 IndexedDB 에 원시 바이트로 남으므로 `docs/security-model.md` 에 적는다. 이것도 의존성 승인 대상이다(D3, 루트 추가는 최대 하나).
- [ ] **Step 2: 공식 테스트 벡터 가져오기(착수 시 확인)** — Noise 공식 벡터 모음(cacophony 의 `vectors/cacophony.txt`, snow 의 `tests/vectors/` — 위치·형식·라이선스 모두 착수 시 확인)에서 `protocol_name === 'Noise_KK_25519_AESGCM_SHA256'` 항목만 골라 `src/shared/cloud/noise.fixtures/kk-vectors.json` 에 옮긴다.
  - 파일 머리 `_source`(원본 저장소 주소·커밋)와 `_license`(원본 라이선스 이름) 필드를 둔다. 라이선스가 재배포를 막으면 파일을 넣지 않고, 테스트가 `NOISE_VECTORS` 환경 변수 경로에서 읽게 바꾼 뒤 CI 단계에서 내려받는다.
  - 항목이 하나도 없으면 멈추고 보고한다(Step 1 의 조합 결정을 다시 한다).
  - 벡터에 들어 있는 개인키는 공개 테스트 데이터라 `src/hygiene.test.ts` 의 "개인키 문자열 금지" 와 부딪칠 수 있다. 부딪치면 이 파일 하나만 그 검사의 허용 목록에 넣고 이유를 주석으로 단다.
- [ ] **Step 3: 실패하는 테스트 작성**

```ts
// src/shared/cloud/noise.vectors.test.ts
import { describe, expect, it } from 'vitest';
import vectors from './noise.fixtures/kk-vectors.json';
import { HandshakeState, Transport, importRawPrivate } from './noise';
import { fromHex, toHex } from './testHex';

type V = {
  protocol_name: string; init_prologue: string; resp_prologue: string;
  init_static: string; init_ephemeral: string; init_remote_static: string;
  resp_static: string; resp_ephemeral: string; resp_remote_static: string;
  handshake_hash?: string; messages: { payload: string; ciphertext: string }[];
};
const kk = (vectors as { vectors: V[] }).vectors.filter((v) => v.protocol_name === 'Noise_KK_25519_AESGCM_SHA256');

describe('Noise KK official vectors', () => {
  it('has at least one vector', () => expect(kk.length).toBeGreaterThan(0));
  it.each(kk.map((v, i) => [i, v] as const))('vector %i reproduces every ciphertext', async (_i, v) => {
    const init = new HandshakeState({
      initiator: true, prologue: fromHex(v.init_prologue),
      s: await importRawPrivate(fromHex(v.init_static)), rs: fromHex(v.init_remote_static),
      e: await importRawPrivate(fromHex(v.init_ephemeral)),
    });
    const resp = new HandshakeState({
      initiator: false, prologue: fromHex(v.resp_prologue),
      s: await importRawPrivate(fromHex(v.resp_static)), rs: fromHex(v.resp_remote_static),
      e: await importRawPrivate(fromHex(v.resp_ephemeral)),
    });
    const [m1, m2, ...rest] = v.messages;
    expect(toHex(await init.writeMessage(fromHex(m1.payload)))).toBe(m1.ciphertext);
    expect(toHex(await resp.readMessage(fromHex(m1.ciphertext)))).toBe(m1.payload);
    expect(toHex(await resp.writeMessage(fromHex(m2.payload)))).toBe(m2.ciphertext);
    expect(toHex(await init.readMessage(fromHex(m2.ciphertext)))).toBe(m2.payload);
    const i = await init.split(); const r = await resp.split();
    if (v.handshake_hash) expect(toHex(init.handshakeHash)).toBe(v.handshake_hash);
    const iT = new Transport(i.send, i.recv); const rT = new Transport(r.send, r.recv);
    // KK 는 메시지 3 부터 개시자·응답자가 번갈아 보낸다(벡터 형식 그대로).
    for (const [k, m] of rest.entries()) {
      const [tx, rx] = k % 2 === 0 ? [iT, rT] : [rT, iT];
      expect(toHex(await tx.encrypt(fromHex(m.payload)))).toBe(m.ciphertext);
      expect(toHex(await rx.decrypt(fromHex(m.ciphertext)))).toBe(m.payload);
    }
  });
});

// src/shared/cloud/noise.test.ts
import { describe, expect, it } from 'vitest';
import { DecryptError, HandshakeError, RekeyNeeded, Transport, deviceHandshake, generateStaticKey, hostHandshake, isSemver } from './noise';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

async function connect(o: { hostSelf?: Awaited<ReturnType<typeof generateStaticKey>>; hostDeviceId?: string; hostHostId?: string; tamper?: (m: Uint8Array) => void } = {}) {
  const host = await generateStaticKey({ extractable: true });
  const dev = await generateStaticKey({ extractable: false });
  const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '1.0.0' });
  o.tamper?.(d.msg1);
  const h = await hostHandshake({ self: o.hostSelf ?? host, devicePublic: dev.publicRaw, deviceId: o.hostDeviceId ?? 'd1', hostId: o.hostHostId ?? 'h1', msg1: d.msg1, hostVersion: '1.2.3' });
  const fin = await d.finish(h.msg2);
  return { dev: fin.transport, host: h.transport, hostVersion: fin.hostVersion, uiVersion: h.uiVersion };
}

describe('noise relay handshake', () => {
  it('both sides learn the authenticated versions and talk both ways', async () => {
    const c = await connect();
    expect(c.hostVersion).toBe('1.2.3'); expect(c.uiVersion).toBe('1.0.0');
    expect(dec(await c.host.decrypt(await c.dev.encrypt(enc('{"t":"ready"}'))))).toBe('{"t":"ready"}');
    expect(dec(await c.dev.decrypt(await c.host.encrypt(enc('yo'))))).toBe('yo');
  });
  it('prologue mismatch (deviceId or hostId) fails the handshake', async () => {
    await expect(connect({ hostDeviceId: 'd2' })).rejects.toBeInstanceOf(HandshakeError);
    await expect(connect({ hostHostId: 'h2' })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a host without the paired static key cannot read message 1 (cloud in the middle)', async () => {
    const evil = await generateStaticKey({ extractable: true });
    await expect(connect({ hostSelf: evil })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a flipped bit anywhere in message 1 fails', async () => {
    await expect(connect({ tamper: (m) => { m[m.length - 1] ^= 1; } })).rejects.toBeInstanceOf(HandshakeError);
    await expect(connect({ tamper: (m) => { m[0] ^= 1; } })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('a relay cannot swap hostVersion: message 2 is authenticated', async () => {
    const host = await generateStaticKey({ extractable: true }); const dev = await generateStaticKey({ extractable: false });
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '1.0.0' });
    const h = await hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: d.msg1, hostVersion: '2.0.0' });
    h.msg2[h.msg2.length - 5] ^= 1;
    await expect(d.finish(h.msg2)).rejects.toBeInstanceOf(HandshakeError);
  });
  it('hostHandshake rejects a non-semver version in the payload', async () => {
    const host = await generateStaticKey({ extractable: true }); const dev = await generateStaticKey({ extractable: false });
    const d = await deviceHandshake({ self: dev, hostPublic: host.publicRaw, deviceId: 'd1', hostId: 'h1', uiVersion: '../../evil' });
    await expect(hostHandshake({ self: host, devicePublic: dev.publicRaw, deviceId: 'd1', hostId: 'h1', msg1: d.msg1, hostVersion: '1.0.0' })).rejects.toBeInstanceOf(HandshakeError);
  });
  it('replayed, reordered and wrong-direction transport messages fail', async () => {
    const c = await connect();
    const f1 = await c.dev.encrypt(enc('1')); const f2 = await c.dev.encrypt(enc('2'));
    await expect(c.host.decrypt(f2)).rejects.toBeInstanceOf(DecryptError); // 순서 바꿈
    expect(dec(await c.host.decrypt(f1))).toBe('1');                         // 실패가 n 을 올리지 않았다
    await expect(c.host.decrypt(f1)).rejects.toBeInstanceOf(DecryptError); // 재전송
    await expect(c.dev.decrypt(await c.dev.encrypt(enc('x')))).rejects.toBeInstanceOf(DecryptError); // 방향
  });
  it('rejects oversize plaintext and signals rekey at 2^32', async () => {
    const c = await connect();
    await expect(c.dev.encrypt(new Uint8Array(65520))).rejects.toBeInstanceOf(RangeError);
    (c.dev as unknown as { send: { n: bigint } }).send.n = 2n ** 32n;
    await expect(c.dev.encrypt(enc('x'))).rejects.toBeInstanceOf(RekeyNeeded);
  });
  it('the phone key stays non-extractable', async () => {
    const dev = await generateStaticKey({ extractable: false });
    expect(dev.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', dev.privateKey)).rejects.toThrow();
  });
  it('semver check', () => {
    expect(isSemver('1.2.3')).toBe(true); expect(isSemver('1.2.3-beta.1')).toBe(true);
    expect(isSemver('1.2')).toBe(false); expect(isSemver('1.2.3/../x')).toBe(false);
  });
});

// src/shared/cloud/frames.test.ts
it('envelope round trip and peer limits', () => {
  const p = new Uint8Array([1, 2, 3]);
  expect(decodeEnvelope(encodeEnvelope({ kind: EnvKind.Data, peer: 'dev_abc', payload: p }))).toEqual({ kind: EnvKind.Data, peer: 'dev_abc', payload: p });
  expect(() => encodeEnvelope({ kind: EnvKind.Data, peer: 'x'.repeat(65), payload: p })).toThrow();
  expect(decodeEnvelope(new Uint8Array([9]))).toBeNull();
});
it('tunnel frames are validated', () => {
  expect(parseTunnelFrame({ t: 'ready' })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'GET', p: '/api/me', h: {}, more: false })).not.toBeNull();
  expect(parseTunnelFrame({ t: 'http.req', id: 1, m: 'TRACE', p: '/api/me', h: {}, more: false })).toBeNull();
  expect(parseTunnelFrame({ t: 'eval', code: '1' })).toBeNull();
});
it('chunks at 32 KiB and a full chunk still fits one Noise message', () => {
  expect(chunkBytes(new Uint8Array(32768 * 2 + 1)).map((c) => c.length)).toEqual([32768, 32768, 1]);
  const b = btoa(String.fromCharCode(...new Uint8Array(32768).fill(255)));
  expect(encodeTunnel({ t: 'http.chunk', id: 2_000_000_000, b, more: true }).length).toBeLessThanOrEqual(65519);
});
it('encodeTunnel refuses a frame that would not fit', () => {
  expect(() => encodeTunnel({ t: 'ws.msg', s: 1, d: 'x'.repeat(70000) })).toThrow(RangeError);
});
it('chunkString never splits a surrogate pair', () => {
  const s = 'a'.repeat(32767) + '😀';
  expect(chunkString(s).join('')).toBe(s);
  expect(chunkString(s)[0].endsWith('\ud83d')).toBe(false);
});

// src/shared/cloud/pairing.test.ts
it('QR url round trip on the relay origin, hash only, v2', () => {
  const hostPub = toB64u(new Uint8Array(32).fill(7));
  const url = encodePairUrl({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub, hostVersion: '1.2.3', relayOrigin: 'https://relay.example' });
  expect(url).toBe(`https://relay.example/v/1.2.3/#pair=2.p1.c.a.${hostPub}`);
  expect(parsePairHash(new URL(url).hash)).toEqual({ v: 2, pairingId: 'p1', claim: 'c', auth: 'a', hostPub });
  expect(parsePairHash('#pair=1.p1.c.a.h')).toBeNull();
  expect(parsePairHash('#pair=2.p1.c.a.short')).toBeNull();
});
it('mac fails when the cloud swaps the device key, and lp removes boundary ambiguity', async () => {
  const mac = await pairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' });
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'real', hostPub: 'h' }, mac)).toBe(true);
  expect(await verifyPairingMac('auth', { pairingId: 'p1', devicePub: 'swapped', hostPub: 'h' }, mac)).toBe(false);
  expect(await pairingMac('k', { pairingId: 'ab', devicePub: 'c', hostPub: 'h' })).not.toBe(await pairingMac('k', { pairingId: 'a', devicePub: 'bc', hostPub: 'h' }));
});
it('confirm code is 6 digits, stable, and changes with the device key', async () => {
  const a = await confirmCode({ pairingId: 'p1', devicePub: 'real', hostPub: 'h' });
  expect(a).toMatch(/^\d{6}$/);
  expect(await confirmCode({ pairingId: 'p1', devicePub: 'real', hostPub: 'h' })).toBe(a);
  expect(await confirmCode({ pairingId: 'p1', devicePub: 'swapped', hostPub: 'h' })).not.toBe(a);
});
```

  `testHex.ts` 는 `src/shared/cloud/testHex.ts` 에 둔다(`fromHex`·`toHex` 두 함수, 테스트 전용, 실행 코드에서 import 하지 않는다).

- [ ] **Step 4: 실패 확인** — `npx vitest run src/shared/cloud --maxWorkers=2` 가 모듈 없음으로 FAIL 하는지 본다.
- [ ] **Step 5: 구현** — 위 계약과 Noise 사양 rev 34 를 그대로 따른다(Step 1 에서 라이브러리를 골랐으면 감싸기만 한다).
  - 사양 구현일 때:
    - `HASHLEN = 32`. 프로토콜 이름이 32바이트 이하라 `h = name ‖ 0 채움`, `ck = h`.
    - `MixHash(prologue)` → 사전 메시지로 `MixHash(개시자 s 공개키)`, `MixHash(응답자 s 공개키)`.
    - `HKDF` 는 HMAC-SHA256 으로 사양 §4.3 그대로(`importKey('raw', ck, {name:'HMAC', hash:'SHA-256'})`). WebCrypto 의 `HKDF` 알고리즘은 쓰지 않는다(출력 분할 규칙이 다르다).
    - AES-GCM 논스는 `4바이트 0 ‖ u64be(n)`, 핸드셰이크 중 ad 는 `h`, 전송 중 ad 는 빈 값이다.
    - KK 패턴: 메시지 1 `e, es, ss`, 메시지 2 `e, ee, se`. 각 토큰 순서와 `EncryptAndHash(payload)` 위치는 사양 §5.3 을 따른다.
  - `deviceHandshake`·`hostHandshake` 는 페이로드를 `{"v":2,"uiVersion"}`·`{"v":2,"hostVersion"}` JSON 으로 만들고, 받은 쪽은 `v === 2` 와 `isSemver` 를 확인해 아니면 `HandshakeError` 를 던진다.
  - 핸드셰이크 중 생긴 모든 오류(곡선 밖 공개키로 `importKey` 실패 포함)는 `HandshakeError` 로, 전송 중 복호화 오류는 `DecryptError` 로 감싼다.
  - `generateStaticKey` 는 `{ name: 'X25519' }` 이고 `dh` 는 `deriveBits({ name: 'X25519', public }, privateKey, 256)` 다. 결과가 전부 0 이면(작은 차수 점) `HandshakeError` 다.
- [ ] **Step 6: 통과 확인** — 위 명령이 PASS 하는지 본다. 공통 검증 명령 다섯 개도 돌린다.
- [ ] **Step 7: 커밋** — `feat(cloud): 공유 릴레이 프로토콜 — Noise KK(공식 벡터 통과)·봉투·터널 프레임·페어링 MAC·확인 코드`. 본문에 Step 1 의 후보별 판정 한 줄씩과 벡터 출처를 적는다.

---

### Task 2: 클라우드 패키지 뼈대 — 두 출처·계정·호스트 연결·페어링·기기 API·체험

**Files:**
- Create:
  - 패키지 설정: `cloud/package.json`, `cloud/package-lock.json`, `cloud/tsconfig.json`, `cloud/vitest.config.ts`, `cloud/wrangler.jsonc`, `cloud/migrations/0001_init.sql`
  - 진입·공통: `cloud/src/index.ts`, `cloud/src/env.ts`, `cloud/src/router.ts`, `cloud/src/http.ts`, `cloud/src/origins.ts`
  - 인증·메일·제한: `cloud/src/auth/tokens.ts`, `cloud/src/auth/magic.ts`, `cloud/src/auth/session.ts`, `cloud/src/auth/email.ts`, `cloud/src/email.ts`, `cloud/src/rate.ts`
  - 도메인: `cloud/src/hosts.ts`, `cloud/src/pairing.ts`, `cloud/src/devices.ts`, `cloud/src/entitled.ts`
  - 페이지: `cloud/src/pages/layout.ts`, `cloud/src/pages/login.ts`, `cloud/src/pages/verify.ts`, `cloud/src/pages/link.ts`
- Modify:
  - `.gitignore`(`cloud/node_modules/`, `cloud/.wrangler/`, `cloud/.dev.vars`, `cloud/src/legal/pages.gen.ts`)
  - `.gitattributes`(`cloud/ export-ignore`), `scripts/export-public.sh`(금지 경로 목록에 `cloud`) — 클라우드 비공개(D11·출시 점검 D1)
- Test: `cloud/test/helpers.ts`, `cloud/test/origins.test.ts`, `cloud/test/config.test.ts`, `cloud/test/auth.test.ts`, `cloud/test/email.test.ts`, `cloud/test/hosts.test.ts`, `cloud/test/pairing.test.ts`, `cloud/test/entitled.test.ts`

**Interfaces:**
- `cloud/package.json` scripts: `"typecheck": "tsc --noEmit -p ."`, `"test": "vitest run --maxWorkers=2"`, `"dev": "wrangler dev --local"`. devDependencies 는 Global Constraints 의 다섯 개로 버전을 고정한다(`npm i -D --save-exact`).
- `cloud/vitest.config.ts`: `cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: TEST_VARS } })` 플러그인을 쓴다. `TEST_VARS = { PUBLIC_ORIGIN: 'https://app.test', RELAY_ORIGIN: 'https://relay.test', EMAIL_MODE: 'log', DEV_ROUTES: '1', SESSION_SECRET: 's'.repeat(32), EMAIL_HASH_SECRET: 'e'.repeat(32) }`. 마이그레이션은 `readD1Migrations('./migrations')` → 테스트 setup 에서 `applyD1Migrations(env.DB, migrations)` 로 적용한다(`readD1Migrations`·`miniflare.bindings` 형태 **(미확인)** — Step 1 에서 플러그인 README 로 확인).
- `cloud/wrangler.jsonc`: `name: "ai-msg-cloud"`, `main: "src/index.ts"`, `compatibility_date: "2026-10-15"`, `d1_databases: [{ binding: "DB", database_name: "ai-msg", migrations_dir: "migrations" }]`, `vars: { PUBLIC_ORIGIN: "https://app.aimsg.app", RELAY_ORIGIN: "https://relay.aimsg.app", EMAIL_MODE: "resend", EMAIL_FROM, DEV_ROUTES: "0", MAX_DEVICES: "3", MAX_HOSTS: "3", TRIAL_DAYS: "7" }`, `routes` 에 두 호스트 이름(사용자 도메인, `cloud/README.md`). 기본값이 `resend` 라서 설정을 빠뜨려도 메일이 D1 에 쌓이는 일이 없다(권장 8). `database_id` 는 배포 때 사용자가 넣는다.
- `Env`: `DB: D1Database; RELAY: DurableObjectNamespace; UI: R2Bucket; PUBLIC_ORIGIN: string; RELAY_ORIGIN: string; EMAIL_MODE: 'log' | 'resend'; EMAIL_FROM: string; RESEND_API_KEY?: string; SESSION_SECRET: string; EMAIL_HASH_SECRET: string; DEV_ROUTES: '0' | '1'; MAX_DEVICES: string; MAX_HOSTS: string; TRIAL_DAYS: string` — 뒤 Task 가 늘린다.
- `index.ts`: `checkConfig(env): { ok: true } | { ok: false; reason: string }`.
  - `EMAIL_MODE === 'log'` 또는 `DEV_ROUTES === '1'` 인데 `PUBLIC_ORIGIN` 의 호스트가 `localhost`·`127.0.0.1`·`*.test` 가 아니면 거부한다(권장 8).
  - `SESSION_SECRET`·`EMAIL_HASH_SECRET` 이 32자 미만이면 거부한다. `EMAIL_MODE === 'resend'` 인데 `RESEND_API_KEY` 가 없으면 거부한다.
  - 두 출처가 같거나 둘 중 하나가 `https:` 가 아니면(로컬 호스트 제외) 거부한다.
  - 거부면 모든 요청에 503 `{error:'misconfigured', code:'misconfigured'}` 를 주고 `console.error` 로 이유를 한 번 남긴다(Workers 에는 "기동 실패" 가 없어서 요청마다 검사 결과를 캐시해 쓴다).
- `origins.ts`: `type Side = 'app' | 'relay'`, `sideOf(req: Request, env: Env): Side | null`(`new URL(req.url).host` 를 두 출처의 host 와 비교, 아니면 null → 404), 라우트 표의 각 줄에 `side` 를 붙여 반대쪽이면 404. `relayHeaders(h: Headers)`: `Set-Cookie` 를 지우고 `content-security-policy: default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `referrer-policy: no-referrer`, `cross-origin-opener-policy: same-origin` 를 붙인다.
- `auth/email.ts`:
  - `normalizeEmail(raw: string): string | null` — 앞뒤 공백 제거, 소문자, `@` 가 하나가 아니거나 254자를 넘으면 null. 로컬 부분의 첫 `+` 부터 끝까지를 지운다. 도메인이 `gmail.com`·`googlemail.com` 이면 로컬 부분의 `.` 을 지우고 도메인을 `gmail.com` 으로 쓴다(권장 3).
  - `emailKey(secret: string, raw: string): Promise<string>` = `HMAC-SHA256(secret, normalizeEmail(raw))` base64url. 로그인 계정은 받은 주소(소문자)로 만들고, 정규화 키는 체험 1회 판정에만 쓴다.
- `0001_init.sql`:

```sql
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, paddle_customer_id TEXT UNIQUE);
CREATE TABLE magic_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE web_sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE host_links (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, host_name TEXT NOT NULL, host_pub TEXT NOT NULL, ui_version TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed')), user_id TEXT, last_poll INTEGER, expires_at INTEGER NOT NULL);
CREATE TABLE hosts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, host_pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ui_version TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE pairings (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), claim_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','claimed','confirmed','rejected','burned','expired')), device_id TEXT, mac TEXT, bad_claims INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), host_id TEXT NOT NULL REFERENCES hosts(id), pairing_id TEXT NOT NULL REFERENCES pairings(id), name TEXT NOT NULL, pub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('claimed','active','revoked')), created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE trials (user_id TEXT PRIMARY KEY REFERENCES users(id), started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);
-- 계정을 지워도 남는다(Task 12). user_id 는 삭제 때 NULL.
CREATE TABLE trial_claims (email_key TEXT PRIMARY KEY, user_id TEXT, claimed_at INTEGER NOT NULL);
CREATE TABLE grants (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL CHECK (plan IN ('comp')), until INTEGER NOT NULL, note TEXT);
CREATE TABLE rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX devices_user ON devices(user_id, state);
CREATE INDEX devices_pairing ON devices(pairing_id);
CREATE INDEX hosts_user ON hosts(user_id);
```

- 라우트(`api-types.ts` 타입 사용, 각 줄의 `[app]`·`[relay]` 는 출처). 인증은 라우트마다 셋 중 하나로 정해져 있고 섞지 않는다(2차 권장 — 옛 문구 "API 는 Bearer 만" 은 아래 쿠키 라우트와 맞지 않았다).
  - **쿠키(웹 세션) 라우트 — 이 목록만 `__Host-aimsg_web` 을 읽는다.** `POST /auth/verify`(쿠키를 심는 쪽), `GET /link`·`GET /account`·`GET /checkout`(페이지), `POST /v1/host/link/approve`, `POST /v1/billing/intent`·`/v1/billing/intent/complete`·`/v1/billing/portal`(Task 10), `POST /v1/account/delete`(Task 12), `POST /v1/devices/:id/revoke`(웹 세션으로 부를 때).
  - **쿠키 라우트의 CSRF:** GET 이 아닌 요청은 `Origin === PUBLIC_ORIGIN` 이어야 하고, `Origin` 이 없거나 다르면 403 `{code:'bad_origin'}` 이다(`Referer` 로 대신하지 않는다). 본문은 `Content-Type: application/json` 만 받아 단순 폼 POST 를 막는다(`POST /auth/verify` 는 같은 출처 페이지의 폼이라 `application/x-www-form-urlencoded` 도 받되 Origin 검사는 같다). 쿠키는 `SameSite=Lax` 라 이 검사가 주 방어다. `cookieRoute(handler)` 래퍼 하나로 묶어 빠뜨리지 않는다.
  - **Bearer 라우트(host·device 토큰):** 그 밖의 `/v1/*` 전부. 쿠키는 보지 않는다. 쿠키만 있고 Bearer 가 없으면 401 이다. `POST /v1/devices/:id/revoke` 는 Bearer 가 있으면 Bearer 로, 없으면 쿠키 라우트 규칙(Origin 검사)으로 처리한다.
  - **relay 라우트:** 쿠키를 읽지 않는다(`/v1/pair/claim` 은 인증 없음 + `Origin === RELAY_ORIGIN`, `/v1/relay/ticket` 은 device Bearer).
  - `[app] POST /v1/auth/magic {email, next?}`
    - 항상 200 `{ok:true}` 를 돌려준다(가입 여부를 드러내지 않음).
    - 속도 제한: 이메일(정규화 키)당 시간당 5회, IP(`CF-Connecting-IP`)당 시간당 20회.
    - 토큰 유효 15분, 한 번만 쓸 수 있다.
    - 메일 본문의 주소: `${PUBLIC_ORIGIN}/auth/verify?t=<token>`.
  - `[app] GET /auth/verify?t=` 는 "Sign in" 버튼 하나만 있는 페이지를 보여 준다(메일 스캐너가 미리 열어도 토큰이 소모되지 않게). `POST /auth/verify {t}` 가 토큰을 소모하고, 사용자를 upsert 한 뒤 쿠키 `__Host-aimsg_web=<id>.<HMAC(SESSION_SECRET,id)>`(`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`, `Domain` 없음 — relay 출처로 새지 않는다)를 심고 `next` 로 303 보낸다(같은 출처 경로만, 아니면 `/account`).
  - `[app] POST /v1/host/link/start {hostName, hostPub, uiVersion}` → `{deviceCode, userCode, verifyUrl, interval: 3, expiresIn: 600}`.
    - `userCode` 는 `XXXX-XXXX`(헷갈리는 글자 0/O/1/I 없음)이고, `verifyUrl = ${PUBLIC_ORIGIN}/link?code=<userCode>` 다.
    - 속도 제한: IP 당 시간당 10회(권장 8). `uiVersion` 은 `isSemver`.
  - `[app] GET /link?code=` 는 로그인하지 않았으면 `/login?next=/link?code=…` 로 보내고, 로그인했으면 호스트 이름과 공개키 지문(sha256 앞 8바이트를 16진 4묶음)을 보여 준다. 버튼은 "Link this Mac".
  - `[app] POST /v1/host/link/approve {userCode}`(웹 세션 + Origin)
    - 속도 제한: 사용자당 시간당 10회, IP 당 시간당 20회(권장 8). 틀린 `userCode` 도 센다.
    - 호스트 수가 `MAX_HOSTS` 를 넘으면 409.
    - 체험(D8, 권장 3): `trial_claims` 에 `emailKey` 가 없고, IP 키 `trial:ip:<ip>` 가 하루 3회 미만이면 `trial_claims`·`trials`(`TRIAL_DAYS`일)를 한 batch 로 만든다. 둘 중 하나라도 걸리면 체험 없이 연결만 하고, 응답 `trial: 'granted' | 'already_used' | 'unavailable'` 로 알려 준다(페이지는 결제 링크를 보여 준다).
    - 상태를 `approved` 로 바꾼다.
  - `[app] POST /v1/host/link/poll {deviceCode}`
    - `last_poll` 이 2초 안이면 429 `{code:'slow_down'}`.
    - 아직이면 202 `{state:'pending'}`.
    - 승인됐으면 200 `{state:'linked', hostId, hostToken, email}` 를 주고 상태를 `consumed` 로 바꾼다. `hosts` 행이 만들어지고 토큰은 이 응답에만 실린다.
    - 만료·거절이면 410.
  - `[app] POST /v1/host/unlink`(host) → 호스트 `revoked_at` 을 기록하고, 그 호스트의 기기를 모두 `revoked` 로 바꾼다. Task 3 이 DO 종료를 더한다.
  - `[app] POST /v1/pair/start {claimHash}`(host) → `{pairingId, expiresAt}`(5분). 호스트당 열린 페어링은 3개까지다.
  - `[relay] POST /v1/pair/claim {pairingId, claim, devicePub, deviceName, mac}`(인증 없음, `Origin === RELAY_ORIGIN`, IP 당 분당 10회)
    - `sha256(claim)` 를 상수 시간으로 비교한다. 틀리면 `bad_claims++` 하고, 5회가 되면 `expired` 로 바꾼다. 404·410 은 페어링이 없거나 만료·거절·폐기일 때다.
    - **맞는데 `devicePub`·`mac` 이 그 페어링의 기기와 같으면(같은 폰의 재전송, 2차 권장 — 멱등):** 상태가 `claimed` 면 태우지 않고 `UPDATE devices SET token_hash = ? WHERE id = ? AND state = 'claimed'` 로 `deviceToken` 을 새로 발급해 200 `{deviceId, deviceToken, hostId}`(같은 `deviceId`)를 준다. 상태가 `confirmed` 면 409 `{code:'already_paired'}`(태우지 않음). 비교는 저장된 `devices.pub`·`pairings.mac` 과 상수 시간으로 한다. 이 분기는 `bad_claims` 를 세지 않는다.
    - **맞는데 상태가 `claimed`·`confirmed` 이고 `devicePub`·`mac` 이 다르면**(같은 QR 의 두 번째 사용, 필수 3): 한 batch 로 페어링을 `burned`, `pairing_id` 가 같은 기기를 모두 `revoked` 로 바꾸고 409 `{code:'pairing_burned'}` 를 준다. Task 3 이 DO 통지를 더한다.
    - 상태가 `open` 이고 활성·claimed 기기 수가 `MAX_DEVICES` 이상이면 409 `{code:'device_limit'}`.
    - 상태가 `open` 이면 `devices(state='claimed', pairing_id)` 를 만들고 페어링을 `claimed` 로 바꾼 뒤 `{deviceId, deviceToken, hostId}` 를 준다. `devicePub` 은 32바이트 base64url 이어야 한다.
  - `[app] GET /v1/pair/:id`(host, 자기 호스트 것만) → `{state, deviceId?, devicePub?, deviceName?, mac?}`.
  - `[app] POST /v1/pair/:id/confirm`(host) → 상태가 `claimed` 일 때만 페어링 `confirmed`·기기 `active`, 그 밖에는 409 `{code: state}`. `POST /v1/pair/:id/reject`(host) → 페어링 `rejected`·기기 `revoked`.
  - `[app] GET /v1/devices`(host) → `DeviceInfo[]`(자기 호스트의 활성 기기). `[app] POST /v1/devices/:id/revoke` 는 host 토큰이나 웹 세션으로 부른다.
  - `[app] GET /dev/outbox?to=` 는 `DEV_ROUTES === '1'` 이고 `EMAIL_MODE === 'log'` 일 때만 열린다(Task 5c e2e 용). 그 밖에는 404 다.
- `entitled.ts`: `entitledState(db, userId, nowMs): Promise<{ plan: 'trial' | 'comp' | 'pro' | 'none'; st: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none'; untilMs: number }>`. 이 Task 에서는 `trials`·`grants` 만 본다. 둘 다 유효하면 `until` 이 큰 쪽을 쓰고, 둘 다 없거나 지났으면 `none`/0 이다. Task 9 가 구독을 더한다(계약 절 "이용권 계산").
- `email.ts`: `interface EmailSender { send(m: { to: string; subject: string; text: string }): Promise<void> }`.
  - `log` 모드는 `outbox` 테이블에 쓴다(위 `checkConfig` 때문에 로컬·`.test` 출처에서만).
  - `resend` 모드는 `POST https://api.resend.com/emails`(`Authorization: Bearer`, 본문 `{from, to, subject, text}`)로 보낸다. 이 형태는 **(미확인)** 이라 Step 1 에서 Resend 문서로 확인하고, 다르면 이 파일만 고친다.

- [ ] **Step 1: 도구·API 확인** — 다음을 확인하고, 확인한 것을 `cloud/README.md` 의 "확인한 버전" 절에 적는다.
  - `npm --prefix cloud i -D --save-exact wrangler @cloudflare/vitest-plugin vitest typescript @cloudflare/workers-types` 로 설치한다.
  - `node_modules/@cloudflare/vitest-plugin/README.md` 에서 `cloudflareTest`·`miniflare.bindings`·`readD1Migrations`·`applyD1Migrations` 의 형태와, vitest 지원 범위(`^4.1` 이상, 5 지원 여부)를 확인한다.
  - Resend `POST /emails` 의 형태를 확인한다.
  - Workers 의 `routes`(커스텀 도메인 두 개를 한 Worker 에) 형태를 확인한다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/helpers.ts
import { env, exports } from 'cloudflare:workers';
export const APP = 'https://app.test'; export const RELAY = 'https://relay.test';
export const call = (path: string, init: RequestInit = {}, origin = APP) => exports.default.fetch(new Request(`${origin}${path}`, init));
export const post = (path: string, body: unknown, headers: Record<string, string> = {}, origin = APP) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) }, origin);
export const relayPost = (path: string, body: unknown, headers: Record<string, string> = {}) => post(path, body, headers, RELAY);
export async function loginAs(email: string): Promise<string> {
  await post('/v1/auth/magic', { email });
  const row = await env.DB.prepare('SELECT body FROM outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 1').bind(email.toLowerCase()).first<{ body: string }>();
  const t = /t=([A-Za-z0-9_-]+)/.exec(row!.body)![1]!;
  const res = await post('/auth/verify', { t });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
export async function linkHost(email = 'user@example.test', ip = '198.51.100.1'): Promise<{ hostId: string; hostToken: string; cookie: string; trial: string }> {
  const s = await (await post('/v1/host/link/start', { hostName: 'Test Mac', hostPub: toB64u(new Uint8Array(32).fill(1)), uiVersion: '1.0.0' })).json() as LinkStartRes;
  const cookie = await loginAs(email);
  const a = await (await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie, 'cf-connecting-ip': ip })).json() as { trial: string };
  const p = await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json() as { hostId: string; hostToken: string };
  return { ...p, cookie, trial: a.trial };
}
export async function claim(o: { hostToken: string; secret?: string; devicePub?: string }): Promise<{ pairingId: string; res: Response }> {
  const secret = o.secret ?? 'claim-secret';
  const { pairingId } = await (await post('/v1/pair/start', { claimHash: await sha256B64u(secret) }, { authorization: `Bearer ${o.hostToken}` })).json() as PairStartRes;
  const res = await relayPost('/v1/pair/claim', { pairingId, claim: secret, devicePub: o.devicePub ?? toB64u(new Uint8Array(32).fill(2)), deviceName: 'Phone', mac: 'm' });
  return { pairingId, res };
}

// cloud/test/origins.test.ts
it('app routes are 404 on the relay origin and vice versa', async () => {
  expect((await call('/login', {}, RELAY)).status).toBe(404);
  expect((await call('/checkout', {}, RELAY)).status).toBe(404);
  expect((await post('/v1/auth/magic', { email: 'a@example.test' }, {}, RELAY)).status).toBe(404);
  expect((await post('/v1/pair/claim', { pairingId: 'x' })).status).toBe(404);
  expect((await call('/login', {}, 'https://other.test')).status).toBe(404);
});
it('relay origin never sets cookies and sends a strict CSP', async () => {
  const r = await relayPost('/v1/pair/claim', { pairingId: 'nope', claim: 'x', devicePub: 'x', deviceName: 'x', mac: 'x' });
  expect(r.headers.get('set-cookie')).toBeNull();
  expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(r.headers.get('content-security-policy')).not.toMatch(/https?:\/\//);
});
it('the web session cookie is host-only', async () => {
  const res = await (async () => { await post('/v1/auth/magic', { email: 'c@example.test' }); const row = await env.DB.prepare('SELECT body FROM outbox ORDER BY id DESC LIMIT 1').first<{ body: string }>(); return post('/auth/verify', { t: /t=([A-Za-z0-9_-]+)/.exec(row!.body)![1] }); })();
  const sc = res.headers.get('set-cookie')!;
  expect(sc).toMatch(/^__Host-aimsg_web=/); expect(sc.toLowerCase()).not.toContain('domain=');
});

// cloud/test/config.test.ts — 순수 함수
it('refuses log email or dev routes on a public origin', () => {
  const base = { PUBLIC_ORIGIN: 'https://app.aimsg.app', RELAY_ORIGIN: 'https://relay.aimsg.app', EMAIL_MODE: 'resend', RESEND_API_KEY: 'k', DEV_ROUTES: '0', SESSION_SECRET: 's'.repeat(32), EMAIL_HASH_SECRET: 'e'.repeat(32) } as Env;
  expect(checkConfig(base)).toEqual({ ok: true });
  expect(checkConfig({ ...base, EMAIL_MODE: 'log' })).toMatchObject({ ok: false });
  expect(checkConfig({ ...base, DEV_ROUTES: '1' })).toMatchObject({ ok: false });
  expect(checkConfig({ ...base, RESEND_API_KEY: undefined })).toMatchObject({ ok: false });
  expect(checkConfig({ ...base, RELAY_ORIGIN: base.PUBLIC_ORIGIN })).toMatchObject({ ok: false });
  expect(checkConfig({ ...base, PUBLIC_ORIGIN: 'http://localhost:8787', RELAY_ORIGIN: 'http://127.0.0.1:8787', EMAIL_MODE: 'log', RESEND_API_KEY: undefined })).toEqual({ ok: true });
});

// cloud/test/email.test.ts
it('normalizes plus tags, gmail dots and googlemail', () => {
  expect(normalizeEmail(' A.B+promo@GoogleMail.com ')).toBe('ab@gmail.com');
  expect(normalizeEmail('a.b+x@example.test')).toBe('a.b@example.test');
  expect(normalizeEmail('no-at-sign')).toBeNull();
});

// cloud/test/auth.test.ts
it('magic link: same answer for any email, single use, 15 minutes', async () => {
  expect((await post('/v1/auth/magic', { email: 'a@example.test' })).status).toBe(200);
  const cookie = await loginAs('a@example.test');
  expect(cookie).toMatch(/^__Host-aimsg_web=/);
  // 같은 토큰 재사용 → 400, 15분 뒤 → 400(시계는 vi.setSystemTime)
});
it('GET /auth/verify does not consume the token (link scanners)', async () => { /* GET 후에도 POST 가 성공 */ });
it('rate limits per normalized email', async () => {
  for (let i = 0; i < 6; i++) await post('/v1/auth/magic', { email: i % 2 ? 'r+x@example.test' : 'r@example.test' });
  const n = await env.DB.prepare("SELECT count(*) AS n FROM outbox WHERE to_addr LIKE 'r%'").first<{ n: number }>();
  expect(n!.n).toBe(5);
});
it('rejects cross-origin state changes', async () => {
  expect((await post('/auth/verify', { t: 'x' }, { origin: 'https://evil.test' })).status).toBe(403);
});

// cloud/test/hosts.test.ts
it('device-code link: pending → approved → token once', async () => {
  const s = await (await post('/v1/host/link/start', { hostName: 'Test Mac', hostPub: toB64u(new Uint8Array(32)), uiVersion: '1.0.0' })).json() as LinkStartRes;
  expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(202);
  const cookie = await loginAs('u@example.test');
  expect((await post('/v1/host/link/approve', { userCode: s.userCode }, { cookie })).status).toBe(200);
  vi.advanceTimersByTime(3000);
  const p = await (await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).json() as LinkPollRes;
  expect(p).toMatchObject({ state: 'linked' });
  vi.advanceTimersByTime(3000);
  expect((await post('/v1/host/link/poll', { deviceCode: s.deviceCode })).status).toBe(410);
  const stored = await env.DB.prepare('SELECT token_hash FROM hosts').first<{ token_hash: string }>();
  expect(stored!.token_hash).not.toContain((p as { hostToken: string }).hostToken);
});
it('polling faster than 2 s gets slow_down', async () => { /* 연속 두 번 → 두 번째 429 */ });
it('trial once per normalized email, even across accounts', async () => {
  expect((await linkHost('t.r.i.a.l@gmail.com')).trial).toBe('granted');
  expect((await linkHost('trial+again@gmail.com')).trial).toBe('already_used');
});
it('trial at most 3 per IP per day', async () => {
  for (const n of [1, 2, 3]) expect((await linkHost(`ip${n}@example.test`, '203.0.113.9')).trial).toBe('granted');
  expect((await linkHost('ip4@example.test', '203.0.113.9')).trial).toBe('unavailable');
});
it('link/start and approve are rate limited', async () => { /* 같은 IP 11번째 start → 429, 같은 사용자 11번째 approve → 429 */ });
it('MAX_HOSTS', async () => { /* 4번째 approve → 409 */ });

// cloud/test/pairing.test.ts
it('claim works only on the relay origin with the right secret; device limit 3', async () => { /* … */ });
it('wrong secret 5 times expires the pairing', async () => { /* … */ });
it('a second correct claim burns the pairing and revokes every device it made', async () => {
  const h = await linkHost();
  const first = await claim({ hostToken: h.hostToken });
  expect(first.res.status).toBe(200);
  const again = await relayPost('/v1/pair/claim', { pairingId: first.pairingId, claim: 'claim-secret', devicePub: toB64u(new Uint8Array(32).fill(3)), deviceName: 'Thief', mac: 'm' });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ code: 'pairing_burned' });
  const rows = await env.DB.prepare('SELECT state FROM devices WHERE pairing_id = ?').bind(first.pairingId).all<{ state: string }>();
  expect(rows.results.every((r) => r.state === 'revoked')).toBe(true);
  const st = await (await call(`/v1/pair/${first.pairingId}`, { headers: { authorization: `Bearer ${h.hostToken}` } })).json() as PairStatusRes;
  expect(st.state).toBe('burned');
  expect((await post(`/v1/pair/${first.pairingId}/confirm`, {}, { authorization: `Bearer ${h.hostToken}` })).status).toBe(409);
});
it('the same phone resending the same claim (lost response) gets the same deviceId and a fresh token, not a burn', async () => {
  const h = await linkHost();
  const first = await claim({ hostToken: h.hostToken });                 // devicePub·mac 고정
  const a = await first.res.json() as PairClaimRes;
  const again = await relayPost('/v1/pair/claim', first.body);            // 같은 본문 그대로 재전송
  expect(again.status).toBe(200);
  const b = await again.json() as PairClaimRes;
  expect(b.deviceId).toBe(a.deviceId);
  expect(b.deviceToken).not.toBe(a.deviceToken);                          // token_hash 교체
  const st = await (await call(`/v1/pair/${first.pairingId}`, { headers: { authorization: `Bearer ${h.hostToken}` } })).json() as PairStatusRes;
  expect(st.state).toBe('claimed');                                       // burned 아님
  expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${a.deviceToken}` })).status).toBe(401); // 옛 토큰 무효
  await post(`/v1/pair/${first.pairingId}/confirm`, {}, { authorization: `Bearer ${h.hostToken}` });
  const late = await relayPost('/v1/pair/claim', first.body);
  expect(late.status).toBe(409); expect(await late.json()).toMatchObject({ code: 'already_paired' });
});
it('cookie routes need Origin === PUBLIC_ORIGIN and JSON; Bearer routes ignore cookies', async () => {
  const cookie = await loginAs('c@example.test');
  expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, origin: 'https://evil.test' })).status).toBe(403);
  expect((await post('/v1/host/link/approve', { userCode: 'AAAA-AAAA' }, { cookie, origin: null })).status).toBe(403); // Origin 없음
  expect((await post('/v1/pair/start', { claimHash: 'x' }, { cookie })).status).toBe(401); // 쿠키만으로는 Bearer 라우트 불가
  // /v1/billing/*·/v1/account/delete 는 Task 10·12 테스트와 Task 11 security.test.ts 출처 행렬이 같은 래퍼(cookieRoute)를 확인한다
});
it('host sees devicePub+mac, confirm activates only from claimed, reject revokes', async () => { /* … */ });
it('a host cannot read another host’s pairing', async () => { /* 404 */ });

// cloud/test/entitled.test.ts
it('trial and comp: larger until wins; expired → none', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현**
  - 라우터는 `[side, method, pattern, handler]` 배열 하나로 둔다(의존성 없음). `sideOf` 가 null 이거나 줄의 `side` 와 다르면 404 다.
  - 모든 응답에 `cache-control: no-store` 를 붙인다. app 출처 HTML 에는 `content-security-policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` 를, relay 출처 응답에는 `relayHeaders` 를 붙인다.
  - 토큰 비교는 `timingSafeEqual` 로 한다. 시각은 모두 ms 정수다.
  - 두 번째 claim 의 `burned` 처리와 체험 생성은 각각 `db.batch([...])` 한 번으로 한다. 체험 batch 의 `trial_claims` 는 `INSERT … ON CONFLICT DO NOTHING` 이 아니라 먼저 `SELECT` 로 판정하고, 경합으로 batch 가 UNIQUE 위반이면 `already_used` 로 답한다.
  - `.gitattributes` 에 `cloud/ export-ignore` 를, `scripts/export-public.sh` 의 금지 경로 목록에 `cloud` 를 더한다. `git check-attr export-ignore cloud/package.json` 이 `set` 인지 본다.
- [ ] **Step 5: 통과 확인** — `npm --prefix cloud ci && npm --prefix cloud run typecheck && npm --prefix cloud test` 가 PASS 하는지 본다. 공통 검증 명령 다섯 개도 돌린다.
- [ ] **Step 6: 커밋** — `feat(cloud): Workers 패키지 — 두 출처·매직링크·호스트 장치 코드 연결·QR 페어링(두 번째 claim 폐기)·기기 API·체험(이메일 정규화·IP 제한)`

---

### Task 3: 릴레이 Durable Object (`RelayRoom`)

**Files:**
- Create: `cloud/src/relay/RelayRoom.ts`, `cloud/src/relay/routes.ts`, `cloud/src/relay/tickets.ts`, `cloud/migrations/0002_relay.sql`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`, `cloud/wrangler.jsonc`(DO 바인딩·마이그레이션·호환성 플래그), `cloud/src/devices.ts`·`cloud/src/hosts.ts`·`cloud/src/pairing.ts`(해제·폐기 시 DO 에 알림)
- Test: `cloud/test/relay.test.ts`, `cloud/test/relay.static.test.ts`

모든 라우트는 **relay 출처**다(D18). app 출처로 오면 404 다.

**Interfaces:**
- `wrangler.jsonc`:
  - `durable_objects.bindings: [{ name: "RELAY", class_name: "RelayRoom" }]`
  - `migrations: [{ tag: "v1", new_sqlite_classes: ["RelayRoom"] }]` — 키 이름 **(미확인)**, Step 1 에서 확인.
  - `compatibility_flags: ["web_socket_auto_reply_to_close"]`
- `0002_relay.sql`: `CREATE TABLE relay_tickets (ticket_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, host_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);`
- `POST /v1/relay/ticket`(device Bearer, `Origin === RELAY_ORIGIN`)
  - 토큰이 없거나 기기가 `revoked`·호스트가 해제됐으면 401 `{code:'revoked'}`(폰은 재페어링 안내, Task 5b).
  - 기기가 `claimed`(Mac 이 아직 [허용] 안 함)면 403 `{code:'pending_confirm'}`.
  - `entitledState(...).untilMs > now` 가 아니면 402 `{code:'not_entitled'}`. `untilMs` 에는 이미 `active` 48시간·`past_due` 7일 유예가 들어 있다(계약 절, Task 9).
  - 통과하면 `{ticket, hostId, expiresIn: 60}` 를 준다.
- `GET /relay/host`(Upgrade, host Bearer)
  - 클라이언트가 보낸 `x-relay-*` 머리는 지운다.
  - 토큰이 없거나 틀리거나 호스트가 해제됐으면 401 이다. **이용권은 보지 않는다**(2차 필수 1 — 이용권 없는 Mac 도 DO 에 붙어 있어야 결제 웹훅의 `/internal/recheck` 가 닿는다). 이용권은 티켓(402)과 DO 의 `{t:'ent'}`·alarm 이 맡는다.
  - 통과하면 `env.RELAY.get(env.RELAY.idFromName(hostId)).fetch(req2)` 로 넘긴다. `req2` 에는 `x-relay-role: host`, `x-relay-host`, `x-relay-user`, `x-relay-until`(`entitledState(...).untilMs`, 없으면 `0`)을 싣는다.
- `GET /relay/device?ticket=`
  - `Origin` 머리가 있으면 `RELAY_ORIGIN` 이어야 한다(아니면 403).
  - 티켓은 `UPDATE … SET used_at=? WHERE ticket_hash=? AND used_at IS NULL AND expires_at>?` 의 `changes === 1` 일 때만 받는다.
  - 받으면 클라이언트의 `x-relay-*` 를 지우고 `x-relay-role: device`, `x-relay-device`, `x-relay-host`, `x-relay-user`(티켓 행의 `user_id`), `x-relay-until`(이 시점의 `entitledState(...).untilMs`)을 실어 같은 DO 로 넘긴다(2차 필수 3 — attachment `{role, dev, user, until}` 과 alarm 이 `user`·`until` 을 읽는데 옛 문구는 role·device 만 넘겼다). 기기의 `last_seen` 을 갱신한다.
  - DO 쪽 업그레이드는 `x-relay-role` 에 맞는 머리가 하나라도 없으면 500 으로 거절하고 로그를 남긴다(`user` 없는 attachment 를 만들지 않는다).
- `RelayRoom implements DurableObject`:
  - 생성자: `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`.
  - `fetch(req)`
    - `/internal/revoke {dev}` 이면 그 기기 소켓을 4403 으로 닫고, 호스트 소켓에 `{t:'revoked',dev}` 를 보낸다(필수 5 — Mac 이 로컬 신뢰 목록에서도 지운다). 호스트가 없으면 보내지 않는다(Mac 은 다음 연결 때 `GET /v1/devices` 로 맞춘다, Task 4b).
    - `/internal/unlink` 이면 전부 4401 로 닫는다.
    - `/internal/recheck` 이면 alarm 을 즉시 건다(`setAlarm(Date.now())`). 호스트가 not_entitled 로 붙어 있어도 이 경로로 닿는다.
    - 그 밖에는 업그레이드다. `new WebSocketPair()` → `ctx.acceptWebSocket(server, [role === 'host' ? 'host' : `dev:${id}`])` → `server.serializeAttachment({ role, dev?, user, until, lastRecheck: 0 })` 순서로 처리한다.
    - 같은 태그의 옛 소켓은 4409 로 닫는다. 이것은 티켓으로 인증된 소켓 사이의 교체다. DO 는 Noise 를 풀 수 없으므로 소켓 안의 핸드셰이크가 진짜인지 모른다 — Mac 쪽 Noise 세션 교체는 계약 절의 "`ready` 복호화 전에는 교체 금지" 규칙을 Task 4b 가 따로 지킨다.
    - 호스트가 붙으면 모든 기기에 `{t:'host',up:true}` 를 보내고, 호스트에게 `{t:'ent', ok: until > now, until}` 를 보낸다. 기기가 붙으면 호스트에게 `{t:'peer',dev,up:true}` 를, 그 기기에게 `{t:'host',up:<호스트 있음>}` 을 보낸다.
    - alarm 은 `until > now` 인 소켓의 `min(until)` 로 건다. 모두 지난 상태(호스트만 not_entitled 로 붙어 있음)면 alarm 을 걸지 않는다 — 다음 계산은 `/internal/recheck` 나 호스트의 `{"t":"recheck"}` 가 일으킨다.
  - `webSocketMessage(ws, msg)`
    - 문자열은 `ping`(auto-response 가 처리)과 호스트의 `{"t":"recheck"}` 만 뜻이 있다. `recheck` 는 호스트 소켓에서만, attachment 의 `lastRecheck` 가 30초 이전일 때만 `lastRecheck = now` 로 바꾸고 alarm 을 즉시 건다. 그 밖의 문자열은 무시한다.
    - `ArrayBuffer` 가 `MAX_FRAME` 을 넘으면 4413 으로 닫는다.
    - `decodeEnvelope` 가 실패하면 버린다.
    - 호스트가 보낸 것은 `getWebSockets('dev:'+peer)[0]` 에게 `peer='host'` 로 바꿔 보낸다. 대상이 없으면 호스트에게 `{t:'peer',dev:peer,up:false}` 를 보낸다.
    - 기기가 보낸 것은 `peer` 를 첨부의 기기 id 로 덮어써 호스트에게 보낸다. 호스트가 없으면 `{t:'host',up:false}` 를 보낸다.
  - `webSocketClose(ws, code, reason, wasClean)` — 상대에게 알린다(호스트가 닫히면 기기들에 `host up:false`).
  - `alarm()`
    - 첨부의 `user` 로 D1 의 `entitledState` 를 다시 읽는다(호스트·기기 모두 같은 user 다. 호스트가 없고 기기만 있어도 기기 attachment 의 `user` 로 읽는다 — 필수 3).
    - 모든 소켓의 attachment `until` 을 새 값으로 갱신하고, 호스트에게 `{t:'ent', ok, until}` 를 보낸다.
    - 지났으면 **기기 소켓만** 4402 로 닫는다. 호스트 소켓은 열어 둔다(2차 필수 1). 아니면 alarm 을 새 `until` 로 다시 건다.
  - 로그는 `console.log(JSON.stringify({ ev, host, dev, bytes, code }))` 형태로만 남기고 payload 는 기록하지 않는다.
- `webSocketError` 처리기는 쓰지 않는다. 문서에서 확인하지 못했기 때문이다 **(미확인)**. 오류는 close 로 수렴한다고 본다.

- [ ] **Step 1: API 확인** — `wrangler.jsonc` 의 DO 마이그레이션 키(`new_sqlite_classes` / `new_classes`)를 wrangler 설정 스키마(`node_modules/wrangler/config-schema.json`)에서 확인한다. 테스트에서 클라이언트 WS 를 얻는 방법(`res.webSocket` + `accept()`)과 `evictDurableObject`·`runInDurableObject` 시그니처를 플러그인 README 에서 확인한다(`runInDurableObject` 가 없으면 attachment 검사는 DO 의 테스트 전용 `/internal/debug-attachments`(`DEV_ROUTES === '1'` 일 때만)로 바꾼다). 확인한 형태를 README "확인한 버전" 에 적는다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/relay.test.ts
import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { EnvKind, decodeEnvelope, encodeEnvelope, CLOSE } from '../../src/shared/cloud/envelope';

const stubFor = (hostId: string) => env.RELAY.get(env.RELAY.idFromName(hostId));

async function openWs(path: string, headers: Record<string, string> = {}) {
  const res = await call(path, { headers: { upgrade: 'websocket', ...headers } }, RELAY);
  if (res.status !== 101) return { status: res.status, ws: null };
  const ws = res.webSocket!; ws.accept();
  const inbox: (string | ArrayBuffer)[] = []; const closes: number[] = [];
  ws.addEventListener('message', (e) => inbox.push(e.data as string | ArrayBuffer));
  ws.addEventListener('close', (e) => closes.push(e.code));
  return { status: 101, ws, inbox, closes };
}
async function pairedDevice(h: { hostToken: string; hostId: string }): Promise<{ deviceId: string; deviceToken: string }> { /* pair/start → claim → confirm */ }
async function ticketFor(deviceToken: string) { return (await (await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${deviceToken}` })).json() as TicketRes).ticket; }

it('host needs a valid token but no entitlement; it is told ent:false and tickets are 402', async () => {
  expect((await openWs('/relay/host', { authorization: 'Bearer nope' })).status).toBe(401);
  const h = await linkHost(); const d1 = await pairedDevice(h);
  await env.DB.prepare('UPDATE trials SET ends_at = 0').run();
  const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
  expect(host.status).toBe(101);                                           // 2차 필수 1: 업그레이드는 받는다
  await waitFor(() => host.inbox!.some((m) => typeof m === 'string'));
  expect(JSON.parse(host.inbox!.find((m) => typeof m === 'string') as string)).toMatchObject({ t: 'ent', ok: false });
  expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(402);
});
it('not_entitled host stays attached; recheck after payment flips it to ent:true within the same alarm (2차 필수 1)', async () => {
  const h = await linkHost(); const d1 = await pairedDevice(h);
  await env.DB.prepare('UPDATE trials SET ends_at = 0').run();
  const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
  await env.DB.prepare('UPDATE trials SET ends_at = ?').bind(Date.now() + 86_400_000).run(); // 결제·체험 연장과 같은 효과
  await stubFor(h.hostId).fetch('https://relay/internal/recheck');
  await runDurableObjectAlarm(stubFor(h.hostId));
  await waitFor(() => host.inbox!.some((m) => typeof m === 'string' && JSON.parse(m).t === 'ent' && JSON.parse(m).ok === true));
  expect(host.closes).toEqual([]);                                         // 끊지 않고 상태만 바뀐다
  const p1 = await openWs(`/relay/device?ticket=${await ticketFor(d1.deviceToken)}`);
  expect(p1.status).toBe(101);
});
it('host text {"t":"recheck"} triggers a recheck at most once per 30 s', async () => { /* 두 번 연속 → alarm 한 번 */ });
it('device route forwards user and until: a device-only DO alarm reads the user (2차 필수 3)', async () => {
  const h = await linkHost(); const d1 = await pairedDevice(h);
  await env.DB.prepare('UPDATE trials SET ends_at = ?').bind(Date.now() + 50).run();
  const p1 = await openWs(`/relay/device?ticket=${await ticketFor(d1.deviceToken)}`); // 호스트 없이 기기만
  await runInDurableObject(stubFor(h.hostId), (_i, state) => {
    const att = state.getWebSockets(`dev:${d1.deviceId}`)[0].deserializeAttachment();
    expect(att).toMatchObject({ role: 'device', dev: d1.deviceId, user: expect.any(String) });
    expect(att.until).toBeGreaterThan(0);
  });
  await env.DB.prepare('UPDATE trials SET ends_at = 0').run();
  await runDurableObjectAlarm(stubFor(h.hostId));
  await waitFor(() => p1.closes!.includes(CLOSE.notEntitled));
});
it('client-sent x-relay-* headers are stripped on both routes', async () => { /* x-relay-user: 다른 사람 → attachment 의 user 는 티켓/토큰의 user */ });
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
it('revoking a device closes it with 4403 and tells the host', async () => {
  const h = await linkHost(); const d1 = await pairedDevice(h);
  const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
  const p1 = await openWs(`/relay/device?ticket=${await ticketFor(d1.deviceToken)}`);
  await post(`/v1/devices/${d1.deviceId}/revoke`, {}, { authorization: `Bearer ${h.hostToken}` });
  await waitFor(() => p1.closes!.includes(CLOSE.revoked));
  await waitFor(() => host.inbox!.some((m) => typeof m === 'string' && JSON.parse(m).t === 'revoked'));
  expect(JSON.parse(host.inbox!.find((m) => typeof m === 'string' && JSON.parse(m).t === 'revoked') as string)).toEqual({ t: 'revoked', dev: d1.deviceId });
  expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(401);
});
it('a burned pairing closes the device that already connected', async () => { /* claim → confirm → 연결 → 같은 QR 로 두 번째 claim → 4403 + revoked 통지 */ });
it('unlink closes all with 4401', async () => { /* … */ });
it('ticket before Mac approval is 403 pending_confirm', async () => {
  const h = await linkHost(); const { res } = await claim({ hostToken: h.hostToken });
  const { deviceToken } = await res.json() as PairClaimRes;
  const t = await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${deviceToken}` });
  expect(t.status).toBe(403); expect(await t.json()).toMatchObject({ code: 'pending_confirm' });
});
it('relay routes are 404 on the app origin', async () => {
  expect((await post('/v1/relay/ticket', {})).status).toBe(404);
});
it('alarm closes devices with 4402 once the entitlement is over; host stays and gets ent:false', async () => {
  /* trials.ends_at = now+50ms 로 호스트·기기 연결 → ends_at 과거로 → runDurableObjectAlarm(stub)
     → 기기 closes 에 4402, 호스트 closes 비어 있음 + {t:'ent',ok:false} */
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
- [ ] **Step 4: 구현** — 위 Interfaces 대로 만든다. 해제·연결 끊기·페어링 폐기 라우트(Task 2)는 `ctx.waitUntil(stub.fetch('https://relay/internal/…'))` 로 DO 에 알린다. 폐기는 그 페어링으로 만든 기기마다 `/internal/revoke` 를 보낸다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 6: 커밋** — `feat(cloud): 호스트별 릴레이 DO — Hibernation WS·일회용 티켓(확인 전 403)·출처 덮어쓰기·이용권 alarm·해제 시 종료와 호스트 통지`

---

### Task 4a: 로컬 클라우드 클라이언트 ① — 설정·상태·API·호스트 연결·RelayClient

> 2차 검토 권장에 따라 옛 Task 4(약 200줄)를 둘로 나눴다. 4a 는 "Mac 이 클라우드에 연결되고 바깥 WS 가 붙어 있다" 까지, 4b 는 그 위의 Noise 브리지·정책·`/api/cloud` 다. 4a 만으로도 `RelayClient` 를 `FakeRelay` 로 끝까지 시험할 수 있다.

**Files:**
- Create:
  - 설정·상태·API: `src/server/cloud/config.ts`, `src/server/cloud/CloudState.ts`, `src/server/cloud/CloudApi.ts`, `src/server/cloud/HostLink.ts`
  - 릴레이: `src/server/cloud/RelayClient.ts`
  - 도구: `src/server/cloud/testkit.ts`(`FakeRelay` — `ws` WebSocketServer 로 Task 3 DO 의 업그레이드 응답·제어 메시지·종료 코드를 흉내 냄)
- Test: `src/server/cloud/config.test.ts`, `src/server/cloud/CloudState.test.ts`, `src/server/cloud/HostLink.test.ts`, `src/server/cloud/RelayClient.test.ts`

**Interfaces:**
- `config.ts`: `cloudConfig(env: NodeJS.ProcessEnv): { enabled: boolean; baseUrl: string; relayUrl: string }`.
  - `DECK_CLOUD=off` 면 꺼진다.
  - `DECK_CLOUD_URL`(app 출처)의 기본값은 `https://app.aimsg.app`, `DECK_RELAY_URL`(relay 출처)의 기본값은 `https://relay.aimsg.app` 이다(D16·D18).
  - https 만 받는다. http 는 호스트가 `127.0.0.1`·`localhost`·`[::1]` 일 때만 받고, 그 밖은 `enabled:false` 로 두고 로그 한 줄을 남긴다. 두 주소가 같은 출처면 `enabled:false`.
- `CloudState.ts`:
  - `type TrustedDevice = { id: string; name: string; pub: string /* X25519 32B b64u */; addedAt: number }`
  - `type CloudStateData = { v: 2; hostId: string | null; hostToken: string | null; email: string | null; hostKey: string /* pkcs8 b64u */; devices: TrustedDevice[]; pendingRevokes: string[]; plan: EntitlementRes | null }`
  - `class CloudState { static load(configDir: string): Promise<CloudState>; get(): CloudStateData; update(p: Partial<CloudStateData>): Promise<void>; removeDevice(id: string): Promise<boolean>; reset(): Promise<void> }`
    - 파일은 `<configDir>/cloud/state.json`(0600, 폴더 0700, 임시 파일 → rename)이다.
    - `hostKey` 는 처음 `load` 할 때 만든다(`generateStaticKey({extractable:true})` → `exportStaticPrivate`). 파일 쓰기는 첫 `update` 때 한다.
    - 깨진 파일이나 `v` 가 2 가 아닌 파일은 `state.json.broken-<ms>` 로 옮기고 새로 시작한다.
- `CloudApi.ts`: `class CloudApi { constructor(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }); linkStart(…); linkPoll(…); unlink(token); pairStart(token, claimHash); pairStatus(token, id); pairConfirm(token, id); pairReject(token, id); devices(token); revokeDevice(token, id); entitlement(token) }`. 오류는 `CloudError { status: number; code?: string }` 로 던진다. (푸시 대행 메서드는 출시 뒤 Task 6.)
- `HostLink.ts`: `startLink(o: { api; state; hostName: string; uiVersion: string; now?; sleep? }): { info: LinkStartRes; done: Promise<'linked' | 'expired' | 'cancelled'>; cancel(): void }`. `interval` 초마다 폴링하고(429 `slow_down` 이면 간격 +2초), 연결되면 `state.update({ hostId, hostToken, email })` 한다. `hostPub` 은 `hostKey` 의 X25519 공개키다.
- `RelayClient.ts`: `class RelayClient extends EventEmitter`
  - 생성자: `constructor(o: { url: string /* wss://<relay>/relay/host */; token: () => string | null; WebSocketImpl?: typeof WebSocket; backoff?: { minMs: number; maxMs: number }; entitlementBackoff?: { minMs: number; maxMs: number }; now?; random? })`. 기본값 `backoff = { minMs: 1000, maxMs: 60000 }`, `entitlementBackoff = { minMs: 30000, maxMs: 300000 }`(**상한 5분**, 2차 필수 1 — 옛 값은 5분→1시간이었다).
  - 메서드: `start(); stop(); recheck()`, `send(env: Uint8Array): boolean`, `entitled(): { ok: boolean; until: number } | null`
  - 이벤트: `'envelope'(env)`, `'control'(json)`, `'entitlement'({ ok, until })`, `'state'(s: 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced')`
  - 연결: `ws` 라이브러리의 `new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })` 로 연다.
  - 핑: 25초마다 텍스트 `ping` 을 보내고, 60초 동안 아무 수신이 없으면 끊고 재연결한다.
  - **이용권 상태는 연결을 끊지 않고 바꾼다(2차 필수 1).** 업그레이드가 되면 `connecting` 에 머물다가 DO 의 첫 `{t:'ent', ok, until}` 을 받으면 `ok` 면 `up`, 아니면 `not_entitled` 로 둔다. 연결된 채로 오는 `{t:'ent'}` 마다 `up` ↔ `not_entitled` 를 바꾸고 `'entitlement'` 를 낸다. `not_entitled` 인 동안에도 소켓은 열어 두므로 결제 웹훅의 `/internal/recheck` 결과가 수 초 안에 `{t:'ent',ok:true}` 로 온다.
  - `recheck()`(설정 화면을 열 때·Task 7 의 요금제가 바뀔 때): 연결돼 있으면 텍스트 `{"t":"recheck"}` 를 보낸다(DO 가 30초에 한 번까지 받는다). 아래 이용권 백오프로 기다리는 중이면 대기를 건너뛰고 즉시 연결한다.
  - 업그레이드 응답 처리: 401 이면 `unlinked` 로 두고 멈춘다. 402 는 새 DO 에서는 나오지 않지만(호스트 업그레이드는 이용권을 보지 않는다), 운영 차단이나 옛 배포에 대비해 `not_entitled` 로 두고 `entitlementBackoff`(30초부터 두 배씩, **최대 5분**)로 다시 시도한다.
  - 종료 코드 처리: 4401 은 `unlinked`, 4402 는 `not_entitled`(이용권 백오프), 4409 는 `replaced`(같은 호스트가 다른 곳에서 붙음 — 10분 뒤 재시도)다. 그 밖에는 지수 백오프에 ±20% 흔들림을 더해 재시도한다. `not_entitled` 상태에서 연결이 끊기면 재연결 간격도 5분을 넘지 않는다. 정상 연결이 60초 이어지면 두 백오프를 모두 처음으로 되돌린다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/cloud/RelayClient.test.ts — FakeRelay(testkit) + 가짜 시계
it('backs off 1s→2s→4s… capped at 60s with jitter; resets after a good connection', async () => { /* 가짜 시계 */ });
it('ent control flips up ↔ not_entitled without reconnecting (2차 필수 1)', async () => {
  const { client, relay } = setupClient();
  const states: string[] = []; client.on('state', (s) => states.push(s));
  client.start(); await relay.attempted(1);
  relay.control({ t: 'ent', ok: false, until: 0 });
  await waitFor(() => states.at(-1) === 'not_entitled');
  relay.control({ t: 'ent', ok: true, until: Date.now() + 86_400_000 });  // 웹훅 → recheck 결과
  await waitFor(() => states.at(-1) === 'up');
  expect(relay.attempts).toBe(1);                                          // 끊고 다시 붙지 않았다
});
it('402 upgrade or 4402 → not_entitled, retries after 30 s, then 60, 120, 240, 300, 300 (cap 5 min)', async () => {
  const { client, relay, clock } = setupClient({ upgradeStatus: 402 });
  client.start(); await relay.attempted(1);
  for (const [n, sec] of [[2, 30], [3, 60], [4, 120], [5, 240], [6, 300], [7, 300]] as const) {
    clock.advance(sec * 1000 * 0.79); expect(relay.attempts).toBe(n - 1);
    clock.advance(sec * 1000 * 0.42); await relay.attempted(n);
  }
});
it('recheck(): sends {"t":"recheck"} when attached; skips the entitlement wait when backing off', async () => {
  /* 붙은 상태 → relay.textsReceived 에 '{"t":"recheck"}' / 402 뒤 recheck → 즉시 시도 */
});
it('401 upgrade → unlinked and stops; 4409 → replaced and waits 10 min', async () => { /* FakeRelay 응답 지정 */ });
it('pings every 25 s and reconnects after 60 s of silence', async () => { /* … */ });

// src/server/cloud/CloudState.test.ts
it('creates the host key on load, writes 0600 on first update, moves a broken file aside', async () => { /* … */ });

// src/server/cloud/HostLink.test.ts
it('polls every interval, +2 s on slow_down, stores hostId/hostToken/email when linked', async () => { /* … */ });

// src/server/cloud/config.test.ts
it('https only; http only for loopback; same origin for app and relay → disabled', () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cloud --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다. `FakeRelay` 는 Task 3 DO 의 규칙(업그레이드는 토큰만 확인, 첫 텍스트 `{t:'ent'}`, `{"t":"recheck"}` 수신, 제어 메시지 `peer`·`revoked`·`host`·`ent`, 종료 코드)을 같은 상수(`frames.ts`)로 흉내 낸다.
- [ ] **Step 4: 통과 확인** — 위 명령과 공통 검증 명령 다섯 개를 돌린다.
- [ ] **Step 5: 커밋** — `feat(cloud): 로컬 클라우드 클라이언트 ① — 장치 코드 연결·상태 파일·바깥 WS 상주(이용권은 연결 유지한 채 ent 제어로, 끊김 시 최대 5분)`

---

### Task 4b: 로컬 클라우드 클라이언트 ② — RelayBridge·정책·CloudService·`/api/cloud`

**Files:**
- Create:
  - 릴레이: `src/server/cloud/RelayBridge.ts`, `src/server/cloud/loopback.ts`, `src/server/cloud/pathPolicy.ts`, `src/server/cloud/wsPolicy.ts`
  - 조립·문구: `src/server/cloud/CloudService.ts`, `src/server/cloud/texts.ts`(또는 i18n 사전)
- Modify: `src/server/server.ts`, `src/server/http.ts`, `src/server/cloud/testkit.ts`(루프백 흉내 추가), `src/shared/protocol.ts`(`FEATURES` 에 `'cloud'`, `RefusalCode` 에 `'mac_confirm_required'`), `docs/protocol.md`(기능 표에 `cloud`, error 코드 표에 `mac_confirm_required`)
- Test: `src/server/cloud/RelayBridge.test.ts`, `src/server/cloud/pathPolicy.test.ts`, `src/server/cloud/wsPolicy.test.ts`, `src/server/cloud/CloudService.test.ts`, `src/server/http-cloud.test.ts`

**Interfaces:**
- `RelayBridge.ts`: `class RelayBridge`
  - 생성자: `constructor(o: { relay: Pick<RelayClient, 'send' | 'on'>; state: CloudState; loopback: LoopbackTarget; hostVersion: string; fetchImpl?: typeof fetch; WebSocketImpl?: typeof WebSocket; now? })`
  - 기기별 세션 `Map<deviceId, { transport: Transport | null; ready: boolean; streams: Map<number, WebSocket>; http: Map<number, AbortController>; hsTimer }>`
  - 핸드셰이크
    - `hs_init` 를 받으면 봉투 `peer`(DO 가 덮어쓴 기기 id)로 `state.devices` 에서 공개키를 찾는다. 없으면 무시하고 로그 한 줄을 남긴다.
    - 찾으면 `hostHandshake({ self, devicePublic, deviceId, hostId, msg1, hostVersion })` 를 하고 `hs_ack`(msg2)와 `ready` 를 보낸 뒤 5초 안에 기기의 `ready` 를 기다린다. `HandshakeError` 면 세션을 만들지 않는다.
    - 같은 기기의 새 `hs_init` 는 옛 세션을 **건드리지 않고** 대기 세션으로 처리한다. 대기 세션의 Transport 가 기기의 `ready` 를 복호화하면(`transport.peerAuthenticated`) 그때 옛 세션을 `dropDevice(id, 'replaced')` 하고 대기 세션을 올린다. 5초 안에 `ready` 가 열리지 않거나 `DecryptError` 면 대기 세션만 버린다(옛 msg1 재전송으로 정상 세션을 밀어내는 공격 방어). 테스트: 같은 msg1 을 두 번 보내도 기존 세션이 살아 있다.
  - 프레임 처리(기기의 `ready` 전에는 `ready` 외 전부 버린다)
    - `ws.open` → 루프백 WS 를 연다. 상한 8개다.
    - `ws.msg` → `relayWsPolicy` 가 `mac_confirm_required` 면 루프백에 보내지 않고, 그 스트림에 `{"type":"error","turnId":null,"message":<texts.macConfirmRequired>,"code":"mac_confirm_required"}` 을 `ws.msg` 로 돌려준다(`clientRef`·`sessionId` 가 있으면 그대로 싣는다). 조각(`more:true`)은 모아서 검사한 뒤 보낸다(모은 크기 상한 1MiB).
    - `http.req` → `relayPathPolicy` 결과가 `deny` 면 `http.res{st:403, b:{"error":"forbidden"}}`, `mac_confirm_required` 면 `http.res{st:403, b:{"error":"mac_confirm_required","code":"mac_confirm_required"}}` 를 돌려주고 루프백에 닿지 않는다. `allow` 면 `fetch(loopback + p)` 로 보내고, 응답 본문을 32KiB 조각(`TUNNEL_CHUNK`)으로 스트리밍한다. 시간 제한은 60초다.
  - `dropDevice(id: string, reason: 'revoked' | 'decrypt' | 'peer_down' | 'replaced'): void` — Noise 세션을 버리고, 그 기기의 루프백 WS 를 모두 닫고, 진행 중 `http` 를 모두 abort 한다. `revoked` 면 기기에 봉투 `close` 를 보낸다. 동기 함수라 호출 뒤 바로 다음 프레임부터 처리되지 않는다(필수 5).
  - 오류 처리: `DecryptError` 면 `dropDevice(id, 'decrypt')`.
  - 제어 메시지: `{t:'peer',dev,up:false}` → `dropDevice(dev,'peer_down')`. `{t:'revoked',dev}` → **`dropDevice(dev,'revoked')` 를 먼저**(동기 — 그 뒤 프레임은 처리되지 않는다), 그다음 `state.removeDevice(dev)`(비동기 파일 쓰기)(필수 5, 2차 권장 — 옛 순서는 파일 쓰기를 기다리는 사이 프레임이 지날 수 있었다). `{t:'ent'}` 는 RelayClient 가 처리한다.
- `loopback.ts`: `type LoopbackTarget = { port: number; token: () => string }`, `loopbackHeaders(t): Record<string,string>`. 결과는 `{ cookie: `${COOKIE_NAME}=${cookieValueFor(token)}`, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }` 다.
- `pathPolicy.ts`: `relayPathPolicy(method: string, path: string): 'allow' | 'deny' | 'mac_confirm_required'`. 규칙은 쿼리를 뗀 경로를 퍼센트 디코딩하고 `.`/`..`·중복 `/` 를 정규화한 **뒤에** 맞춘다. 디코딩이 실패하거나 정규화 결과가 원문 경로와 다르면 `deny` 다(프레임 검증의 `p` 제한은 1차 방어일 뿐이다).
  - `deny`: `/api/` 로 시작하지 않는 경로, `..`·`%2e%2e`(대소문자 무관)·`//`·`\` 가 들어간 경로, 프로토콜이 있는 절대 주소.
  - `mac_confirm_required`(보안 모델 절 목록): `/api/restart`, `GET` 이 아닌 `/api/server-update*`, `/api/setup` 과 그 아래 전부, `/api/login`, `/api/logout`, `/api/cloud/` 아래 전부(단 `GET /api/cloud/status` 는 `allow`).
  - 그 밖의 `/api/*` 는 `allow`.
  - 머리는 `content-type`·`accept`·`range`·`if-none-match` 만 넘기고, 나머지는 버린다.
- `wsPolicy.ts`: `relayWsPolicy(msg: unknown): 'allow' | 'mac_confirm_required'` — `ClientMsg` 스키마로 파싱하지 않고 `type` 과 아래 필드만 본다(파싱 실패한 메시지는 루프백 서버가 기존대로 거절하게 `allow`).
  - `RAISED = new Set(['acceptEdits', 'bypassPermissions'])`
  - `set_permission_mode` 의 `mode ∈ RAISED`
  - `set_settings` 의 `autoApprove === true`, `defaultPermissionMode ∈ RAISED`, `commanderEnabled === true` 가운데 하나라도
  - `send` 의 `permissionMode ∈ RAISED` 또는 `sandbox === 'workspace-write'`(새 세션 생성 — 복제도 서버가 준 `session_duplicate` 값을 폰이 `send` 로 보내므로 여기서 걸린다)
  - `set_sandbox` 의 `sandbox === 'workspace-write'`
  - 내리는 쪽(`default`·`plan`·`read-only`·`false`)은 `allow` 다.
- `CloudService.ts`: `class CloudService`
  - 생성자: `constructor(o: { cfg: { enabled; baseUrl; relayUrl }; configDir: string; port: number; token: () => string; hostVersion: string; hostName: string; log: (s: string) => void; fetch?; WebSocketImpl? })`
  - 메서드: `start(): void`(대기 없음. 연결된 상태면 RelayClient 를 시작), `stop(): Promise<void>`, `status(): CloudStatus`, `startLink()`, `unlink()`, `revokeDevice(id): Promise<void>`, `onChange(cb)`
  - `revokeDevice(id)`: ① `bridge.dropDevice(id, 'revoked')` ② `state.removeDevice(id)` ③ `api.revokeDevice` — 실패하면 `pendingRevokes` 에 넣고 다음 `up` 때 다시 보낸다. ①이 동기라 열린 채널은 파일 쓰기·클라우드 응답을 기다리지 않고 바로 닫힌다(필수 5, 2차 권장 — 순서를 dropDevice → removeDevice 로 바꿨다).
  - RelayClient 가 `up` 이 될 때마다 `syncDevices()`: `pendingRevokes` 를 보내고, `api.devices(token)` 의 활성 목록에 없는 로컬 신뢰 기기를 `dropDevice(…,'revoked')` + `removeDevice` 순서로 지운다. 호출이 실패하면 로컬 목록을 그대로 둔다.
  - 연결하지 않은 상태면 네트워크 호출이 0건이다.
- `http.ts`: `HttpDeps.cloud?: { service: CloudService }`. 라우트는 다음과 같고, 쿠키·Host·Origin 검사는 기존 `/api/*` 와 같다(`isAllowedHost`·`stateChangingOriginOk` 를 그대로 지난다).
  - `GET /api/cloud/status` → `CloudStatus`
  - `POST /api/cloud/link/start` → `{userCode, verifyUrl, expiresAt}`. 이미 진행 중이면 같은 값을 준다.
  - `POST /api/cloud/unlink` → `{ok}`
  - `POST /api/cloud/devices/:id/revoke` → `{ok}`(`revokeDevice`)
- `CloudStatus = { enabled: boolean; linked: boolean; email: string | null; relay: 'off' | 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced'; link: { userCode: string; verifyUrl: string; expiresAt: number } | null; devices: { id: string; name: string; addedAt: number }[]; plan: EntitlementRes | null }`. 이 타입은 `src/shared/cloud/api-types.ts` 에 둔다.
- `server.ts`
  - `attachWebSocket` 다음 줄에서 `cloudConfig(process.env)` 가 켜져 있을 때만 `new CloudService({...})` 를 만든다.
  - `hostVersion` 은 `packageVersion()`, `hostName` 은 `os.hostname()` 을 앞 40자로 자른 값이다. 이 값은 클라우드에만 보내고 로그에는 쓰지 않는다. `docs/privacy-data-inventory.md` 에 "Mac 이름(os.hostname 앞 40자)" 으로 적는다(Task 11, 권장 8).
  - `start()` 후 `cleanup.push(() => cloud.stop())`. 요청 처리기 deps 에 `cloud: { service }` 를 넣는다.
  - `FEATURES` 의 `'cloud'` 는 서비스가 있을 때만 알린다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/cloud/pathPolicy.test.ts
it.each([
  ['GET', '/api/me', 'allow'], ['POST', '/api/push/subscribe', 'allow'], ['GET', '/api/cloud/status', 'allow'],
  ['GET', '/api/server-update', 'allow'],
  ['POST', '/api/restart', 'mac_confirm_required'], ['POST', '/api/server-update/apply', 'mac_confirm_required'],
  ['GET', '/api/setup', 'mac_confirm_required'], ['POST', '/api/setup/finish', 'mac_confirm_required'],
  ['POST', '/api/login', 'mac_confirm_required'], ['POST', '/api/logout', 'mac_confirm_required'],
  ['POST', '/api/cloud/unlink', 'mac_confirm_required'], ['POST', '/api/cloud/pair/start', 'mac_confirm_required'],
  ['POST', '/api/cloud/devices/d1/revoke', 'mac_confirm_required'],
  ['GET', '/api/../etc', 'deny'], ['GET', '/api/%2E%2E/x', 'deny'], ['GET', '/api\\..\\x', 'deny'],
  ['GET', '//evil.test/api/me', 'deny'], ['GET', '/index.html', 'deny'],
])('%s %s → %s', (m, p, want) => expect(relayPathPolicy(m, p)).toBe(want));

// src/server/cloud/wsPolicy.test.ts
it.each([
  [{ type: 'set_permission_mode', sessionId: 's', mode: 'bypassPermissions' }, 'mac_confirm_required'],
  [{ type: 'set_permission_mode', sessionId: 's', mode: 'acceptEdits' }, 'mac_confirm_required'],
  [{ type: 'set_permission_mode', sessionId: 's', mode: 'plan' }, 'allow'],
  [{ type: 'set_settings', autoApprove: true }, 'mac_confirm_required'],
  [{ type: 'set_settings', autoApprove: false }, 'allow'],
  [{ type: 'set_settings', defaultPermissionMode: 'acceptEdits' }, 'mac_confirm_required'],
  [{ type: 'set_settings', commanderEnabled: true }, 'mac_confirm_required'],
  [{ type: 'set_settings', routingPolicy: 'drain' }, 'allow'],
  [{ type: 'send', text: 'hi', permissionMode: 'bypassPermissions' }, 'mac_confirm_required'],
  [{ type: 'send', text: 'hi', sandbox: 'workspace-write' }, 'mac_confirm_required'],
  [{ type: 'send', text: 'hi' }, 'allow'],
  [{ type: 'set_sandbox', sessionId: 's', sandbox: 'workspace-write' }, 'mac_confirm_required'],
  [{ type: 'set_sandbox', sessionId: 's', sandbox: 'read-only' }, 'allow'],
  [{ type: 'permission_response', requestId: 'r', behavior: 'allow' }, 'allow'],
  ['not json', 'allow'],
])('%j → %s', (msg, want) => expect(relayWsPolicy(msg)).toBe(want));

// src/server/cloud/RelayBridge.test.ts — FakeRelay + 루프백 흉내(쿠키 검사하는 작은 http/ws 서버)
it('a trusted device reaches the loopback with the server cookie; the phone never sees it', async () => {
  const { relay, loop, device } = await setup(); // device: shared noise 로 핸드셰이크하는 가짜 폰
  const res = await device.http('GET', '/api/me');
  expect(res.status).toBe(200);
  expect(loop.lastCookie).toBe(`deck_session=${cookieValueFor('tok')}`);
  expect(JSON.stringify(relay.sentPlain)).not.toContain('deck_session'); // FakeRelay 는 암호문만 봄
});
it('untrusted device key: no hs_ack', async () => { /* state.devices 에 없는 id → hs_ack 없음 */ });
it('frames before the device ready are ignored', async () => { /* ready 전에 보낸 http.req → loop.hits 0 */ });
it('mac-confirm paths never touch the loopback', async () => {
  const { loop, device } = await setup();
  const r = await device.http('POST', '/api/restart');
  expect(r.status).toBe(403); expect(JSON.parse(r.body)).toMatchObject({ code: 'mac_confirm_required' });
  expect(loop.hits).toBe(0);
});
it('ws permission raise is answered with mac_confirm_required and not forwarded', async () => {
  const { loop, device } = await setup();
  const s = await device.wsOpen();
  s.send(JSON.stringify({ type: 'set_permission_mode', sessionId: 's1', mode: 'bypassPermissions' }));
  const back = JSON.parse(await s.next());
  expect(back).toMatchObject({ type: 'error', code: 'mac_confirm_required' });
  expect(loop.wsReceived).toEqual([]);
});
it('phone-supplied cookie/origin headers are dropped', async () => { /* h: { cookie: 'x', origin: 'https://evil' } → loop 는 bridge 값만 */ });
it('ws stream proxied both ways and closed with the session', async () => { /* ws.open → ws.msg 왕복 → 기기 peer down → 루프백 ws 닫힘 */ });
it('large response comes back in 32 KiB chunks', async () => { /* 100 KiB → http.res + http.chunk ×4 */ });
it('replayed frame ends the device session', async () => { /* 같은 암호 프레임 재전송 → 루프백 ws 닫힘 */ });
it('local revoke closes the open channel at once', async () => {
  const { svc, loop, device } = await setup({ withService: true });
  const s = await device.wsOpen();
  const slow = device.http('GET', '/api/slow'); // 루프백이 응답을 붙잡고 있는 요청
  await svc.revokeDevice(device.id);
  await waitFor(() => loop.wsClosed === 1 && loop.aborted === 1);
  await expect(slow).rejects.toThrow();
  expect(svc.status().devices.map((d) => d.id)).not.toContain(device.id);
  s.send('{"type":"ping"}'); expect(loop.wsReceived).toEqual([]);
});
it('cloud revoke notice removes the device locally and closes it', async () => {
  const { relay, state, loop, device } = await setup();
  await device.wsOpen();
  relay.control({ t: 'revoked', dev: device.id });
  await waitFor(() => loop.wsClosed === 1);
  expect(state.get().devices.find((d) => d.id === device.id)).toBeUndefined();
});
it('revoke works even when the cloud call fails, and is retried on the next connection', async () => { /* api.revokeDevice 500 → pendingRevokes 에 남음 → 재연결 뒤 호출 */ });
it('on connect, devices no longer active in the cloud are dropped locally', async () => { /* api.devices → [] → 로컬 신뢰 목록 비움 */ });

// src/server/cloud/CloudService.test.ts
it('not linked: zero requests to the cloud', async () => {
  const calls: string[] = [];
  const svc = new CloudService({ ...opts, fetch: async (u) => { calls.push(String(u)); return new Response('{}'); } });
  svc.start(); await sleep(50);
  expect(calls).toEqual([]);
  expect(svc.status()).toMatchObject({ linked: false, relay: 'off' });
});
it('cloud unreachable while linked: status down, start() never throws', async () => { /* 닫힌 포트 → relay 'down' */ });
it('revokeDevice drops the session before the state file write finishes', async () => {
  /* state.removeDevice 를 붙잡아 두는 가짜 → revokeDevice 호출 직후 bridge 세션 없음, loop.wsClosed === 1 */
});

// src/server/http-cloud.test.ts
it('/api/cloud/* needs the cookie and a same-origin Origin', async () => { /* 401 / 403 */ });
it('DECK_CLOUD=off: no routes, no cloud feature', async () => { /* 404, hello.features 에 cloud 없음 */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cloud src/server/http-cloud.test.ts --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다. `texts.macConfirmRequired` 는 "Mac 에서 직접 해 주세요 — 보안상 폰에서는 바꿀 수 없는 설정입니다" 다.
- [ ] **Step 4: 통과 확인** — 위 명령과 공통 검증 명령 다섯 개를 돌린다.
- [ ] **Step 5: 커밋** — `feat(cloud): 로컬 클라우드 클라이언트 ② — Noise 브리지(Mac 확인 필요 동작 차단·해제 즉시 종료, dropDevice 먼저)·/api/cloud`

---

### Task 5 앞 실기 확인: iOS 홈 화면 PWA 저장소·카메라·푸시 (5a 착수 전 — 탐침은 실행자, iPhone 확인은 사용자 몫)

> 2차 필수 2. iOS 는 Safari 와 홈 화면 PWA 의 저장소를 따로 둘 수 있다(**추정, 실기 확인 전**). 그러면 Safari 에서 QR 로 페어링한 정보가 PWA 에 없다. 5a·5b 의 페어링 화면 설계가 이 결과에 달려 있으므로 5a 보다 먼저 확인한다(5a 착수 전에 탐침을 만들어 사용자에게 넘기고, 결과가 오기 전까지는 4b 뒤 Task 7·9 를 먼저 해도 된다). 실행자는 탐침 파일만 만들고, iPhone 에서 여는 일은 사용자가 한다.

**Files:**
- Create: `scripts/probe/ios-pwa/index.html`, `scripts/probe/ios-pwa/probe.js`, `scripts/probe/ios-pwa/manifest.webmanifest`, `scripts/probe/ios-pwa/sw.js`, `scripts/probe/ios-pwa/README.md`

**Interfaces:**
- `index.html`: 인라인 스크립트 없이 `probe.js` 를 싣고, 버튼 [쓰기]·[읽기]·[카메라]·[푸시 지원] 과 결과 `<pre id="out">` 만 둔다. `<link rel="manifest" href="manifest.webmanifest">`.
- `manifest.webmanifest`: `{"name":"AI-MSG probe","start_url":"./","display":"standalone","icons":[]}`.
- `sw.js`: 빈 서비스 워커(`self.addEventListener('fetch', () => {})`) — 설치 조건 충족용.
- `probe.js`:

```js
// scripts/probe/ios-pwa/probe.js — 저장소 분리·persist·카메라·BarcodeDetector·푸시 지원을 한 화면에 적는다
const out = document.getElementById('out');
const log = (k, v) => { out.textContent += `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`; };
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
log('standalone', standalone);
log('BarcodeDetector', 'BarcodeDetector' in window);
log('PushManager', 'PushManager' in window);
navigator.serviceWorker?.register('sw.js').then(() => log('sw', 'ok'), (e) => log('sw', String(e)));
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
document.getElementById('write').onclick = async () => {
  const v = `${standalone ? 'pwa' : 'safari'}@${new Date().toISOString()}`;
  localStorage.setItem('probe', v);
  const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, 'probe');
  log('wrote', v);
  log('persist', navigator.storage?.persist ? await navigator.storage.persist() : 'unsupported');
};
document.getElementById('read').onclick = async () => {
  log('localStorage', localStorage.getItem('probe'));
  const db = await idb();
  const r = db.transaction('kv').objectStore('kv').get('probe');
  r.onsuccess = () => log('indexedDB', r.result ?? null);
};
document.getElementById('camera').onclick = async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); log('camera', 'ok'); s.getTracks().forEach((t) => t.stop()); }
  catch (e) { log('camera', String(e)); }
};
document.getElementById('push').onclick = async () => {
  log('Notification.permission', typeof Notification === 'undefined' ? 'none' : Notification.permission);
};
```

- `README.md`: 아래 Step 2 의 순서와 결과 표 양식.

- [ ] **Step 1: 탐침 만들기(실행자)** — 위 파일을 만든다. `src/hygiene.test.ts` 를 통과하는지 본다. 외부 출처·추적 코드를 넣지 않는다.
- [ ] **Step 2: 실기 확인(사용자 몫)** — 탐침 폴더를 HTTPS 정적 호스팅에 올린다(호스팅 선택은 사용자 몫, 서비스 워커는 HTTPS 에서만 등록된다). iPhone 에서 다음 순서로 보고 `README.md` 결과 표에 적는다.
  1. Safari 에서 열고 [쓰기].
  2. 공유 › 홈 화면에 추가 → 홈 화면 앱으로 열고 [읽기]. **Safari 에서 쓴 값이 보이는지**(저장소 공유 여부).
  3. 홈 화면 앱에서 [쓰기] → Safari 로 돌아가 [읽기].
  4. 홈 화면 앱에서 [카메라](권한 창이 뜨고 `ok` 인지), `BarcodeDetector` 값, `persist` 값, `PushManager` 값.
- [ ] **Step 3: 결정 반영(실행자, 결과를 받은 뒤)** — 결과에 따라 5a·5b 를 이렇게 확정하고, 결과 표를 이 문서 "근거·미확인" 절에 옮긴다.
  - 저장소가 **분리**되면(예상): 5b 의 PWA 안 페어링(코드 붙여 넣기 + 앱 안 스캔)이 주 경로다. Safari 에서 `#pair=` 로 열린 iOS 화면은 "홈 화면 앱으로 쓰려면 먼저 홈 화면에 추가하고, 그 앱에서 [코드 붙여 넣기] 로 연결하세요" 를 먼저 보여 주고 [이 브라우저에서 연결] 을 두 번째 버튼으로 둔다(기기 3대 한도를 Safari·PWA 가 나눠 먹지 않게).
  - 저장소가 **공유**되면: 같은 화면에서 [이 브라우저에서 연결] 을 첫 버튼으로 둔다. 코드 붙여 넣기·스캔은 그대로 둔다(재페어링 때 쓴다).
  - 홈 화면 앱에서 카메라가 `ok` 이고 `BarcodeDetector` 가 있으면 [스캔] 을 보인다. 카메라는 되는데 `BarcodeDetector` 가 없으면 [스캔] 을 숨기고 코드 붙여 넣기만 둔다. JS QR 디코더를 들일지는 결정 지점 D20 으로 남긴다(라이브러리 이름은 착수 시 확인, 런타임 의존성 규칙상 사용자 승인 필요).
  - `PushManager` 가 홈 화면 앱에서 없으면 출시 뒤 Task 6 을 다시 본다.

---

### Task 5a: Mac 쪽 페어링과 시트

**Files:**
- Create:
  - 서버: `src/server/cloud/Pairing.ts`
  - UI 화면·문구: `src/ui/qr.ts`, `src/ui/cloudApi.ts`, `src/ui/transport.ts`(이 Task 에서는 `isRelayMode()` 만), `src/ui/components/CloudSection.tsx`, `src/ui/components/PairSheet.tsx`, `src/ui/cloudTexts.ts`(또는 i18n 사전)
  - 렌더: `scripts/render/cloud-section.html`, `scripts/render/pair-sheet.html`
- Modify:
  - 서버: `src/server/http.ts`(`/api/cloud/pair/start`, `/api/cloud/pair/:id`, `/api/cloud/pair/:id/approve`, `/api/cloud/pair/:id/deny`, `/api/cloud/devices`), `src/server/cloud/CloudService.ts`
  - UI: `src/ui/components/SettingsView.tsx`(계정 묶음에 `CloudSection`), `src/ui/vite-env.d.ts`
  - 빌드·의존성: `vite.config.ts`, `package.json`·`package-lock.json`(devDependency `qrcode-generator`)
- Test: `src/server/cloud/Pairing.test.ts`, `src/ui/components/CloudSection.test.tsx`, `src/ui/components/PairSheet.test.tsx`

**Interfaces:**
- `Pairing.ts`: `startPairing(o: { api; state; hostVersion: string; relayOrigin: string; now?; sleep? }): Promise<PairingRun>`
  - `type PairingView = { state: 'open' } | { state: 'awaiting_approval'; deviceName: string; confirmCode: string } | { state: 'paired'; device: TrustedDevice } | { state: 'rejected' | 'denied' | 'burned' | 'expired' }`
  - `type PairingRun = { pairingId: string; qrUrl: string; pairCode: string; expiresAt: number; view(): PairingView; approve(): Promise<void>; deny(): Promise<void>; done: Promise<PairingView> }`
  - `claim`·`auth` 를 `randomToken(16)` 으로 만든다. `qrUrl = encodePairUrl({ v: 2, …, relayOrigin })`. `pairCode` 는 `qrUrl` 의 `#pair=` 뒤 문자열 그대로다(`2.<pairingId>.<claim>.<auth>.<hostPub>`, 2차 필수 2 — PWA 안에서 붙여 넣는다).
  - 2초마다 폴링한다.
    - 클라우드 상태가 `burned` 면 `burned` 로 끝낸다(신뢰 목록에 넣지 않는다).
    - `claimed` 가 되면 `verifyPairingMac` 를 본다. 실패하면 `pairReject` 후 `rejected`.
    - 성공하면 **확정하지 않고** `awaiting_approval`(기기 이름·`confirmCode`)로 두고 폴링을 이어 간다(그사이 `burned` 가 되면 `burned`).
  - `approve()` → `pairConfirm` 성공 시에만 `state.devices` 에 추가하고 `paired`. 409 면 그 코드(`burned` 등)로 끝낸다. `deny()` → `pairReject` 후 `denied`.
  - 5분이 지나면 `expired`. `awaiting_approval` 에서 5분이 지나도 `expired` 이고, 클라우드에 `pairReject` 를 보낸다.
- http 라우트(쿠키·Host·Origin 검사. 터널로 오면 `relayPathPolicy` 가 `mac_confirm_required` 로 막는다 — 폰은 자기 자신을 승인할 수 없다):
  - `POST /api/cloud/pair/start` → `{pairingId, qrUrl, pairCode, expiresAt}`
  - `GET /api/cloud/pair/:id` → `PairingView`(`paired` 면 `device` 대신 `deviceName`)
  - `POST /api/cloud/pair/:id/approve` → `{ok}` / 409 `{code}`, `POST /api/cloud/pair/:id/deny` → `{ok}`
  - `GET /api/cloud/devices` → 로컬 신뢰 목록과 클라우드 목록을 합친다(클라우드 실패 시 로컬만). 해제는 Task 4b 의 `POST /api/cloud/devices/:id/revoke`.
- `vite.config.ts`: `mode === 'relay'` 면 `define.__AIMSG_RELAY__ = 'true'`, 아니면 `'false'` 다. base 는 CLI `--base` 를 그대로 쓴다. `src/ui/vite-env.d.ts` 에 `declare const __AIMSG_RELAY__: boolean` 을 더한다. relay 빌드는 외부 출처 자산(폰트·CDN)을 하나도 넣지 않는다(5b Step 5 에서 빌드 결과를 `grep -E 'https?://'` 로 확인, 허용 목록은 relay 출처뿐).
- `transport.ts`(이 Task): `isRelayMode(): boolean`(= `__AIMSG_RELAY__`)만 둔다. 나머지는 5b.
- `CloudSection.tsx`(설정 › 계정)
  - 행 1 "클라우드 연결": 미연결이면 [연결하기] → 코드·주소를 보여 주고 상태를 폴링한다. 연결되면 이메일·[끊기]다.
  - 행 2 "폰 연결": [QR 보기] → `PairSheet` 를 연다.
  - 행 3 "연결된 기기": 이름·추가일·[해제](→ `/api/cloud/devices/:id/revoke`, 열린 채널이 바로 끊긴다).
  - 릴레이 모드(폰 자신)에서는 행 1·2·[해제] 를 숨긴다. 그 경로는 `relayPathPolicy` 가 막는다.
- `PairSheet.tsx`
  - `Sheet` + `SheetHead`.
  - QR 은 `qrSvgPath` 로 그린 SVG `<path>` 다. 흰 바탕에 4모듈 여백을 둔다(다크 테마에서도 흰 바탕이라 대비가 확보된다).
  - 남은 시간을 보여 주고, 만료되면 [새 QR] 을 띄운다.
  - 상태 문구: "폰 카메라로 찍으세요" → `awaiting_approval` 이면 "<기기 이름> 이 연결하려 합니다. 폰에 보이는 숫자가 **123 456** 과 같나요?" + [허용]·[거부](둘 다 44px, [허용] 에 초기 포커스를 두지 않는다) → "연결됨: <기기>" / "확인 실패 — 다시 시도" / "이 QR 이 두 곳에서 쓰였습니다 — 새 QR 을 만드세요"(`burned`).
  - **페어링 코드(2차 필수 2):** QR 아래에 접힌 [코드로 연결] 을 둔다. 펼치면 `pairCode` 를 고정폭 글꼴로 보여 주고 [복사](`navigator.clipboard.writeText`) 버튼을 둔다. 안내: "홈 화면 앱에서 연결할 때: 이 코드를 복사해 폰의 AI-MSG 앱 › [코드 붙여 넣기] 에 넣으세요(같은 Apple 계정이면 Mac 에서 복사한 것을 iPhone 에서 붙여 넣을 수 있습니다)." 코드는 QR 과 같은 비밀이므로 같은 5분 만료·일회용 규칙을 따르고, 화면 녹화·공유 경고 한 줄을 붙인다. 만료되면 코드도 지운다.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/server/cloud/Pairing.test.ts
it('mac ok → awaiting_approval with the confirm code; nothing trusted until approve()', async () => {
  const run = await startPairing({ api, state, hostVersion: '1.0.0', relayOrigin: 'https://relay.test', sleep: tick });
  phone.claim(run.qrUrl);
  await waitFor(() => run.view().state === 'awaiting_approval');
  expect(state.get().devices).toEqual([]);
  expect(api.calls).not.toContain('pairConfirm');
  expect((run.view() as { confirmCode: string }).confirmCode).toBe(await phone.confirmCode());
  await run.approve();
  expect(run.view().state).toBe('paired'); expect(state.get().devices).toHaveLength(1);
});
it('deny() rejects in the cloud and trusts nothing', async () => { /* … */ });
it('mac bad → reject, not trusted', async () => { /* fakeCloudFetch 가 devicePub 를 바꿔치기 */ });
it('burned in the cloud → burned, never trusted, approve() is refused', async () => { /* … */ });
it('expires after 5 minutes, also while awaiting approval', async () => { /* … */ });
it('pairCode equals the #pair= payload of qrUrl and parses back', async () => {
  const run = await startPairing({ api, state, hostVersion: '1.0.0', relayOrigin: 'https://relay.test', sleep: tick });
  expect('#pair=' + run.pairCode).toBe(new URL(run.qrUrl).hash);
  expect(parsePairHash('#pair=' + run.pairCode)).not.toBeNull();
});

// src/ui/components/PairSheet.test.tsx
it('shows the QR, counts down, offers a new QR when expired; close returns focus', async () => { /* … */ });
it('awaiting approval: code + 허용/거부; 허용 is not auto-focused', async () => { /* document.activeElement !== 허용 버튼 */ });
it('touch targets are 44px on phone', () => { /* .sheet-head 버튼·허용·거부 min-height */ });
it('코드로 연결: shows the pair code with a copy button; cleared on expiry', async () => { /* clipboard.writeText 스파이, 만료 뒤 코드 텍스트 없음 */ });

// src/ui/components/CloudSection.test.tsx
it('not linked → 연결하기 → code shown → linked (email)', async () => { /* … */ });
it('relay mode hides link, pair and revoke', () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cloud src/ui/components/CloudSection.test.tsx src/ui/components/PairSheet.test.tsx --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다.
- [ ] **Step 4: 통과 확인** — 위 명령과 공통 검증 명령 다섯 개를 돌린다.
- [ ] **Step 5: 화면 확인** — `scripts/render/cloud-section.html`·`pair-sheet.html` 픽스처(합성 이메일 `user@example.test`, 기기 이름 `Phone`, 확인 코드 `123 456` 상태, [코드로 연결] 펼친 상태 포함)로 `scripts/render-check.sh` 를 360·412·1440 폭에서 돌린다.
- [ ] **Step 6: 커밋** — `feat(cloud): Mac 쪽 QR 페어링 — 확인 코드·[허용]/[거부]·페어링 코드 복사·설정 › 계정 클라우드 행`

---

### Task 5b: 폰 UI 전송 계층 — transport·RelayConnection·PWA 안 페어링·가드

**Files:**
- Create:
  - UI 전송·릴레이: `src/ui/relay/keystore.ts`, `src/ui/relay/pairing.ts`, `src/ui/relay/RelayConnection.ts`, `src/ui/relay/tunnelFetch.ts`, `src/ui/relay/tunnelSocket.ts`, `src/ui/relay/blobUrl.ts`, `src/ui/relay/RelayGate.tsx`, `src/ui/relay/PairEntry.tsx`, `src/ui/relay/scan.ts`
- Modify:
  - UI: `src/ui/transport.ts`(5a 에서 만든 파일에 나머지), `src/ui/ws.ts`, `src/ui/push.ts`, `src/ui/App.tsx`, `src/ui/sessionApi.ts`, `src/ui/components/{Lightbox,FileMenu,ShareMenu}.tsx`, `fetchFn = fetch` 기본값을 가진 파일 전부(`sessionApi.ts`·`pins.ts`·`upload.ts`·`components/{ActivityButton,FolderPicker,ComposerSuggest,MemoryEditor,SessionCwdDialog,Sidebar,ActivitySheet,UsageSheet,Highlights,UsageView}.tsx` 와 가드 테스트가 찾는 나머지)
- Test: `src/ui/transport.test.ts`, `src/ui/transport.guard.test.ts`, `src/ui/relay/pairing.test.ts`, `src/ui/relay/RelayConnection.test.ts`, `src/ui/relay/tunnelFetch.test.ts`, `src/ui/relay/RelayGate.test.tsx`, `src/ui/relay/PairEntry.test.tsx`

**Interfaces:**
- `transport.ts`:
  - `isRelayMode(): boolean`(= `__AIMSG_RELAY__`)
  - `apiFetch(input: string, init?: RequestInit): Promise<Response>` — 릴레이 모드면 `tunnelFetch`, 아니면 `fetch(input, { credentials: 'same-origin', ...init })`.
  - `openSocket(): WebSocketLike` — 릴레이 모드면 `connection.openStream()`, 아니면 `new WebSocket(`${proto}://${location.host}/ws`)`.
  - `setRelayConnection(c: RelayConnection | null): void`
- `keystore.ts`:
  - `type RelayIdentity = { deviceId: string; deviceToken: string; hostId: string; hostPub: string; hostVersion: string; key: StaticKey }`
  - `interface KeyStore { load(): Promise<RelayIdentity | null>; save(i: RelayIdentity): Promise<void>; clear(): Promise<void> }`
  - 구현은 `indexedDbKeyStore()`(DB `aimsg-relay`, 저장소 `identity`, 추출 불가 `CryptoKey` 를 구조화 복제로 저장)와 `memoryKeyStore()` 둘이다. 저장에 성공하면 `navigator.storage?.persist?.()` 를 한 번 부른다(iOS 저장소 삭제 완화, 권장 7).
- `relay/pairing.ts`:
  - `handlePairString(o: { payload: string /* "2.<pairingId>.<claim>.<auth>.<hostPub>" */; store: KeyStore; fetch?: typeof fetch; deviceName: string; hostVersion: string }): Promise<PairResult>` — QR·코드 붙여 넣기·앱 안 스캔이 모두 이 함수를 지난다. 앞뒤 공백·줄바꿈·`#pair=` 접두사·전체 주소(`https://…/#pair=…`)를 받아 `parsePairHash('#pair=' + payload)` 로 정규화한다. 형식이 틀리면 `{ state: 'error', code: 'bad_code' }`.
  - `handlePairHash(o: { hash: string; … })` 는 `#pair=` 가 있으면 `handlePairString` 을 부르고 `history.replaceState` 로 조각을 지운다(오류여도 지운다). 없으면 `{ state: 'none' }`.
  - `type PairResult = { state: 'claimed'; confirmCode: string } | { state: 'none' } | { state: 'error'; code: 'pairing_burned' | 'already_paired' | 'device_limit' | 'expired' | 'bad_code' | 'network' }`
  - `generateStaticKey({ extractable: false })` → `pairingMac` → `POST /v1/pair/claim`(relay 출처, 쿠키 없음). 본문에 `auth` 를 싣지 않는다.
  - **재전송(2차 권장 — 멱등 claim):** 네트워크 오류·시간 초과면 **같은 키·같은 본문**으로 2초 간격 최대 3번 다시 보낸다(키를 새로 만들지 않는다). 그래서 응답이 사라져도 클라우드가 같은 `devicePub` 으로 보고 같은 `deviceId` 와 새 토큰을 준다.
  - 성공하면 identity 를 저장하고 `confirmCode` 를 돌려준다.
  - `deviceName` 은 `navigator.userAgentData?.platform ?? 'Phone'` 에서 만든 짧은 이름이다. 홈 화면 앱(`display-mode: standalone`)이면 뒤에 " (앱)" 을 붙여 Mac 목록에서 Safari 항목과 구별한다.
- `relay/scan.ts`: `canScan(): Promise<boolean>`(= `'BarcodeDetector' in window` 이고 `BarcodeDetector.getSupportedFormats()` 에 `qr_code` 가 있음), `scanOnce(video: HTMLVideoElement, signal: AbortSignal): Promise<string>`(`getUserMedia({ video: { facingMode: 'environment' } })` → 프레임마다 `detect` → 첫 `rawValue`). 외부 라이브러리 없음. BarcodeDetector 의 iOS 지원 여부는 **착수 시 확인**(Task 5 앞 실기 확인 결과)이고, 없으면 `canScan()` 이 false 라 [스캔] 을 숨긴다.
- `relay/PairEntry.tsx`(2차 필수 2 — 이미 설치한 PWA 안에서 페어링): `pairing_needed`·`revoked` 화면 안에 둔다.
  - [코드 붙여 넣기]: 여러 줄 입력칸(`autocapitalize="off"`, `autocorrect="off"`, `spellcheck=false`, `inputmode="text"`) + [연결]. 붙여 넣으면 바로 `handlePairString` 을 부른다.
  - [스캔]: `canScan()` 이 참일 때만 보인다. 카메라 미리보기 시트를 열고 읽은 값을 `handlePairString` 에 넘긴다. 닫으면 스트림을 멈춘다.
  - 결과 `claimed` 면 `RelayConnection.start()` 를 다시 불러 `awaiting_mac` 으로 간다. 오류 코드별 문구는 RelayGate 와 같다(`bad_code`: "코드 형식이 맞지 않습니다. Mac 에서 [복사] 한 코드를 그대로 붙여 넣으세요.").
- `RelayConnection.ts`: `class RelayConnection`
  - 생성자: `constructor(o: { store: KeyStore; relayOrigin: string; uiVersion: string; WebSocketImpl?; fetch?; navigate?: (url: string) => void })`
  - 상태: `'pairing_needed' | 'awaiting_mac' | 'connecting' | 'host_offline' | 'up' | 'not_entitled' | 'revoked'`
  - 메서드: `start(); stop(); onState(cb); http(req): Promise<Response>; openStream(): WebSocketLike`
  - 흐름: `POST /v1/relay/ticket` → `wss://<relay>/relay/device?ticket=` → `deviceHandshake({ self: identity.key, hostPublic, deviceId, hostId, uiVersion })` → `hs_init` → `hs_ack` → `ready` 보내기 → 호스트 `ready` 받기(5초, 아니면 4408 로 닫고 재시도) 순서다.
  - 티켓 응답: 403 `pending_confirm` → `awaiting_mac`(3초마다 다시), 401 → `revoked`(identity 삭제), 402 → `not_entitled`. **402 재시도는 5초부터 두 배씩, 최대 5분**이고 앱이 보이게 되면(`visibilitychange`) 즉시 다시 묻는다(2차 필수 1 — 결제 직후 Mac 은 이미 붙어 있으므로 폰이 수 초 안에 티켓을 받는다. 옛 값은 5분 고정이었다).
  - 버전: **호스트 `ready` 를 연 뒤에만** 본다. `hostVersion !== uiVersion` 이고 `isSemver(hostVersion)` 이면 `localStorage['aimsg.hostVersion'] = hostVersion` 후 `navigate('/v/<hostVersion>/' + location.search)`. semver 가 아니면 이동하지 않고 오류 상태를 보인다(필수 4).
  - 봉투 `close` 를 받거나 4403 으로 닫히면 `revoked`(identity 삭제).
  - 재연결: 1→30초 백오프. 앱이 보이게 될 때(`visibilitychange`)는 즉시 시도한다.
- `tunnelSocket.ts`: `WebSocketLike` 는 `readyState`·`send`·`close`·`onopen`·`onmessage`·`onclose`·`onerror` 만 갖는다. `src/ui/ws.ts` 가 쓰는 것이 이것뿐인지 Step 1 에서 확인하고, 더 있으면 같이 흉내 낸다. 32KiB 를 넘는 `send` 는 `ws.msg{more:true}` 조각으로 나눈다(`chunkString`).
- `blobUrl.ts`: `useApiUrl(path: string | null): string | null` — 일반 모드는 그대로 돌려준다. 릴레이 모드는 `apiFetch` → `URL.createObjectURL` 하고, 언마운트 때 `revokeObjectURL` 한다. `openApiUrl(path)` 는 릴레이 모드에서 blob 을 새 탭으로 연다(`FileMenu.tsx:246`).
- `ShareMenu.tsx:13`: 릴레이 모드의 세션 링크는 `${location.origin}/v/<ver>/?session=<id>` 다.
- `push.ts`(Mac VAPID 직접 푸시, 권장 2): `/api/push/key`·`/api/push/subscribe` 를 `apiFetch` 로 부른다. 릴레이 모드에서도 Mac 의 VAPID 공개키로 relay 출처의 SW(`/sw.js`)에서 구독하고, 구독(endpoint)은 터널로 Mac 에 저장된다. Mac 의 기존 `PushNotifier` 가 푸시 서비스로 직접 보낸다(클라우드 경유 없음, Web Push 암호화로 푸시 서비스도 내용을 못 읽는다). 알림 클릭 주소는 상대 경로라 relay 출처의 `/` → `boot.js` 가 버전 경로로 옮긴다. iOS 는 홈 화면에 추가한 PWA 에서만 웹 푸시가 되므로(Apple 문서 기준, 실기 확인은 사용자 몫) RelayGate 의 알림 켜기 안내에 그 문구를 넣는다.
- `RelayGate.tsx`: 릴레이 모드에서 `App.tsx` 가 `Login` 대신 그린다. 상태별 화면은 다음과 같고, `up` 이면 앱을 그대로 보여 준다.
  - `awaiting_mac`: 확인 코드 6자리를 크게, "Mac 화면의 숫자와 같으면 Mac 에서 [허용] 을 누르세요. 다르면 [거부] 하세요."
  - `pairing_needed`·`revoked`(재페어링 흐름, 권장 7 + 2차 필수 2): "이 폰의 연결 정보가 없습니다(처음이거나, 브라우저 저장소가 지워졌거나, 기기가 해제됨). Mac 에서 설정 › 계정 › 폰 연결 → [QR 보기] 를 여세요." 아래에 `PairEntry`([코드 붙여 넣기]·[스캔]). 홈 화면 앱이면 "카메라 앱으로 QR 을 찍으면 Safari 로 열려 이 앱에는 연결되지 않습니다 — 여기서 붙여 넣거나 스캔하세요" 를 덧붙인다. "예전 기기 항목은 Mac 에서 해제해 두세요."
  - Safari(홈 화면 앱 아님)에서 `#pair=` 로 열린 iOS: Task 5 앞 실기 확인 Step 3 의 결정대로 [이 브라우저에서 연결]·[홈 화면 앱에서 연결하는 법] 순서를 정한다.
  - 페어링 오류 `device_limit`: "기기는 3대까지입니다. Mac 설정이나 계정 페이지에서 안 쓰는 기기를 해제하세요." `pairing_burned`: "이 QR 은 두 곳에서 쓰여 폐기됐습니다. 새 QR 을 만드세요." `already_paired`: "이 QR 로는 이미 연결이 끝났습니다. 이 폰에 연결 정보가 없으면 Mac 에서 새 QR 을 만드세요."
  - `host_offline`: Mac 이 꺼져 있거나 잠들었음. `not_entitled`: 구독 필요 → app 출처 계정 페이지를 **새 탭 링크**로.
- `transport.guard.test.ts`: `src/ui/**/*.{ts,tsx}` 가운데 테스트가 아니고, `transport.ts`·`relay/` 도 아닌 파일에서 `/\bfetch\(/`·`/=\s*fetch\b/`·`/new WebSocket\(/` 이 나오면 실패한다.

- [ ] **Step 1: 확인** — `src/ui/ws.ts` 가 쓰는 WebSocket 멤버를 확인한다. `navigator.storage.persist` 와 `BarcodeDetector` 의 iOS Safari 지원 여부를 MDN 호환표와 Task 5 앞 실기 확인 결과로 확인한다(없으면 호출·버튼을 건너뛴다).
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

// src/ui/relay/RelayConnection.test.ts — @vitest-environment node, memoryKeyStore, 가짜 WS 위에 가짜 호스트(shared noise)
it('ticket → handshake → ready both ways → up; http() returns the host response', async () => { /* … expect(res.status).toBe(200) */ });
it('moves to /v/<ver>/ only after the host ready opened', async () => {
  const { conn, host, navigate } = await setupConn({ hostVersion: '2.0.0', uiVersion: '1.0.0', holdReady: true });
  conn.start(); await host.handshakeDone();
  expect(navigate).not.toHaveBeenCalled();
  host.sendReady();
  await waitFor(() => navigate.mock.calls.length === 1);
  expect(navigate).toHaveBeenCalledWith('/v/2.0.0/');
});
it('a forged ready (not decryptable) never moves the page', async () => {
  const { conn, host, navigate } = await setupConn({ hostVersion: '2.0.0', uiVersion: '1.0.0', holdReady: true });
  conn.start(); await host.handshakeDone();
  host.sendRawEnvelope(new Uint8Array(40)); // 릴레이가 끼워 넣은 쓰레기
  await sleep(20);
  expect(navigate).not.toHaveBeenCalled();
});
it('pending_confirm → awaiting_mac and polls every 3 s', async () => { /* 403 두 번 → 200 → connecting */ });
it('401 on ticket or 4403 → revoked and identity cleared', async () => { /* store.load() === null */ });
it('402 → not_entitled, retried after 5 s, 10 s, 20 s … capped at 5 min; visibilitychange retries at once (2차 필수 1)', async () => {
  const { conn, ticket, clock } = await setupConn({ ticketStatus: 402 });
  conn.start(); await ticket.called(1);
  for (const [n, sec] of [[2, 5], [3, 10], [4, 20], [5, 40], [6, 80], [7, 160], [8, 300], [9, 300]] as const) {
    clock.advance(sec * 1000 - 1); expect(ticket.calls).toBe(n - 1);
    clock.advance(1); await ticket.called(n);
  }
  ticket.respond(200); document.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => conn.state === 'connecting' || conn.state === 'up');
});
it('streams: ws.open/ws.msg map to a WebSocketLike the app can use; big sends are chunked', async () => { /* 100 KiB send → ws.msg more:true ×3 + 끝 */ });

// src/ui/relay/pairing.test.ts
it('#pair= → claim with mac over devicePub, saves identity, returns the confirm code, clears the hash', async () => {
  /* fetch 스파이로 본문 검사: claim, devicePub(32B), mac; auth 는 본문에 없음; 결과 confirmCode === confirmCode({pairingId, devicePub, hostPub}) */
});
it('pairing_burned / device_limit come back as error codes and the hash is still cleared', async () => { /* … */ });
it('the stored device key is non-extractable', async () => { /* (await store.load())!.key.privateKey.extractable === false */ });
it('pair string: accepts the bare code, #pair=…, or the full URL with whitespace; rejects junk as bad_code', async () => { /* 세 형태 → 같은 claim 본문, 'abc' → bad_code */ });
it('network error resends the same devicePub (idempotent claim), never a new key', async () => {
  /* fetch 가 첫 번째는 throw, 두 번째는 200 → 두 본문의 devicePub·mac 이 같다 */
});
it('409 retry waits at least 10 s before resending the same claim', async () => { /* 가짜 타이머: 409 {code:'retry'} → 9.9초엔 두 번째 fetch 없음, 10초 뒤 같은 본문으로 재전송 */ });

// src/ui/relay/RelayGate.test.tsx
it('awaiting_mac shows the 6-digit code', () => { /* getByText('123 456') */ });
it('revoked shows the re-pair steps', () => { /* '새 QR' 안내 */ });
it('pairing_needed in a home-screen app shows paste and (if supported) scan', () => { /* canScan false → [스캔] 없음, [코드 붙여 넣기] 있음 */ });

// src/ui/relay/PairEntry.test.tsx
it('pasting a code calls handlePairString and moves to awaiting_mac', async () => { /* … */ });
it('scan button hidden when BarcodeDetector is missing; scan stops the camera on close', async () => { /* getUserMedia 스파이, track.stop 호출 */ });
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/ui/relay src/ui/transport.test.ts src/ui/transport.guard.test.ts --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
  - `fetchFn = fetch` 기본값을 모두 `fetchFn = apiFetch` 로 바꾼다. 테스트가 `fetchFn` 을 주입하는 방식은 그대로다.
  - `Lightbox.tsx` 의 `attachmentUrl` 을 쓰는 곳은 `useApiUrl(attachmentUrl(id))` 로, `sessionApi.ts:143` 의 `rawFileUrl` 을 쓰는 이미지·다운로드는 `useApiUrl`/`openApiUrl` 로 바꾼다.
  - `App.tsx` 는 `isRelayMode()` 면 `RelayGate` 로 감싸고 `Login` 을 그리지 않는다.
  - `push.ts` 의 `post` 는 `apiFetch` 를 쓴다.
- [ ] **Step 5: 통과 확인** — 위 명령과 공통 검증 명령 다섯 개를 돌린다. `npx vite build --mode relay --base /v/0.0.0-test/ --outDir "$O"`(`O=$(mktemp -d)`)도 성공하고, `grep -rEo 'https?://[^"'"'"' )]+' "$O"` 에 외부 출처가 없는지 본다(라이브러리 주석·SVG 네임스페이스 `http://www.w3.org/` 는 허용 목록).
- [ ] **Step 6: 커밋** — `feat(cloud): 폰 UI 터널 전송 — apiFetch·터널 WS·blob 자산·RelayConnection(402 는 5초부터 최대 5분)·PWA 안 페어링(코드 붙여 넣기·스캔)·Mac 직접 푸시`

---

### Task 5c: 클라우드 UI 배포 — `ui.ts`·boot 폴백·릴리스 스크립트·e2e 이정표 "폰에서 릴레이 경유 승인 성공"

**Files:**
- Create:
  - 클라우드: `cloud/src/ui.ts`, `cloud/static/boot.js`, `cloud/scripts/publish-ui.sh`
  - 릴리스: `scripts/release.sh`
  - 스모크: `scripts/smoke/relay-e2e.sh`, `scripts/smoke/relay-phone.ts`
- Modify: `cloud/src/index.ts`, `cloud/wrangler.jsonc`(R2 `UI`, 정적 자산 `assets: { directory: "./static", binding: "ASSETS", run_worker_first: true }` — 모든 요청이 Worker 의 출처 검사를 먼저 거친다), `cloud/src/env.ts`(`UI: R2Bucket`, `ASSETS: Fetcher`)
- Test: `cloud/test/ui.test.ts`, `cloud/test/boot.test.ts`

**Interfaces:**
- `cloud/src/ui.ts` — **relay 출처 전용**(D18). R2 바인딩 `UI`(`get(key)` → 본문·`httpMetadata`. R2 Workers API 형태 **(미확인)**, Step 1 에서 확인):
  - `GET /boot.js` → `env.ASSETS.fetch(new Request(new URL('/boot.js', req.url)))` 응답에 `relayHeaders` 를 덧씌워 준다(`no-cache`). app 출처에서는 404.
  - `GET /` → 부트스트랩 HTML. 인라인 스크립트 없이 `<script type="module" src="/boot.js">` 를 쓴다.
  - `GET /version.json` → R2 `latest/version.json`(`{"version":"<semver>"}`)을 `no-cache` 로 준다. 없으면 404.
  - `GET /v/<ver>/*` → R2 `v/<ver>/…`(`<ver>` 는 `isSemver`). 없으면 404. 해시가 붙은 자산은 `cache-control: public, max-age=31536000, immutable` 이고, `index.html` 은 `no-store` 다.
  - `GET /sw.js`·`/manifest.webmanifest`·`/icons/*` → R2 `latest/…` 를 `no-cache` 로 준다.
  - 머리: `relayHeaders`(Task 2) — `Set-Cookie` 없음, `script-src 'self'`, 제3자 출처 없음. `connect-src 'self' wss://<relay host>`. `style-src` 는 기존 UI 가 HTML `style=""` 속성이나 `<style>` 을 쓰는지 Step 1 에서 확인하고, 쓰면 `'unsafe-inline'` 을 `style-src` 에만 더한다(`script-src` 에는 절대 더하지 않는다).
- `cloud/static/boot.js`(ES 모듈, 2차 권장 — 버전 폴백):
  - `export async function pickTarget(o: { stored: string | null; exists: (ver: string) => Promise<boolean>; latest: () => Promise<string | null> }): Promise<string | null>`
    1. `stored`(`localStorage['aimsg.hostVersion']`)가 semver 이고 `exists(stored)`(= `fetch('/v/<ver>/index.html', { method: 'HEAD' })` 가 200)면 `stored`.
    2. 아니면 `latest()`(= `/version.json` 의 `version`, semver 검사)를 쓴다. Mac 이 아직 올라오지 않은 버전이거나 `publish-ui.sh` 가 빠진 버전이어도 폰은 최신 UI 로 열리고, 핸드셰이크 뒤 `ready` 의 `hostVersion` 이 있으면 RelayConnection 이 그쪽으로 옮긴다(없으면 그대로 머문다 — 이동 전에 `exists` 를 다시 본다).
    3. 둘 다 없으면 null → "AI-MSG 를 불러오지 못했습니다. 잠시 뒤 다시 여세요." 와 [다시 시도].
  - 아래쪽 실행부는 `typeof document !== 'undefined'` 일 때만 돈다: `pickTarget` → `location.replace('/v/<ver>/' + location.search + location.hash)`(`#pair=` 조각을 그대로 넘긴다). 저장된 값이 없는 첫 방문·홈 화면 앱도 최신 UI 의 `RelayGate`(페어링 화면, 5b)로 간다.
  - RelayConnection 의 버전 이동(5b)도 `navigate` 전에 같은 `exists` 를 확인하고, 없으면 지금 버전에 머물며 "Mac 버전 UI 를 아직 받을 수 없어 최신 UI 로 연결했습니다" 한 줄을 띄운다.
- `cloud/scripts/publish-ui.sh <ver> [--latest] [--dry-run]` — `npx vite build --mode relay --base /v/<ver>/ --outDir "$(mktemp -d)"` 결과를 `wrangler r2 object put` 으로 `v/<ver>/…` 에 올린다. `--latest` 면 빌드·`v/<ver>/` 업로드를 하지 않고, 이미 올라간 `v/<ver>/index.html` 이 있는지 확인한 뒤 `sw.js`·`manifest.webmanifest`·`icons/*` 와 `version.json`(`{"version":"<ver>"}`)만 `latest/…` 에 올린다(없으면 멈춘다). `--dry-run` 은 올릴 키 목록만 출력한다.
- `scripts/release.sh <ver> [--dry-run]`(2차 권장 — npm 릴리스와 UI 게시를 한 번에, 빠뜨리지 않게). 기존 릴리스 절차(`package.json` scripts·`docs/` 의 배포 문서)가 있는지 **착수 시 확인**하고, 있으면 그 절차를 이 스크립트가 부르게 한다. 순서:
  1. `node -p "require('./package.json').version"` 이 `<ver>` 와 같고 `git status --short` 가 비었는지 본다. 아니면 멈춘다.
  2. `cloud/scripts/publish-ui.sh <ver>` — 새 버전 UI 를 먼저 올린다(`latest` 는 아직 안 바꿈). 새 Mac 이 나와도 폰이 `/v/<ver>/` 를 찾을 수 있게 하려는 순서다.
  3. `npm publish`(기존 절차가 있으면 그것).
  4. `cloud/scripts/publish-ui.sh <ver> --latest` — `latest/version.json` 을 새 버전으로.
  5. 2 가 실패하면 3·4 를 하지 않는다. 3 이 실패하면 4 를 하지 않는다(새 UI 는 올라가 있지만 `latest` 는 그대로라 해가 없다).
  - `--dry-run` 은 각 단계의 명령을 출력만 하고(`publish-ui.sh --dry-run`, `npm publish --dry-run`) 아무것도 올리지 않는다. 실제 실행은 사용자 몫(배포)이다.
- `scripts/smoke/relay-e2e.sh`(로컬만, 저장소 `dist/` 무변경)
  1. 임시 디렉터리 `T` 를 만든다. 테스트용 세션·이메일 해시 비밀을 생성해 `cloud/.dev.vars` 를 쓴다(gitignore, 끝나면 `trap` 으로 지움). `PUBLIC_ORIGIN=http://127.0.0.1:$CP`, `RELAY_ORIGIN=http://localhost:$CP`(호스트 이름이 달라 두 출처가 갈린다), `EMAIL_MODE=log`, `DEV_ROUTES=1`.
  2. `npx --prefix cloud wrangler dev --local --port $CP --persist-to "$T/wr"` 를 띄운다. `--persist-to` 플래그는 **(미확인)** 이라 Step 1 에서 `wrangler dev --help` 로 확인한다. 폰 UI 는 `publish-ui.sh` 대신 테스트 객체 하나만 로컬 R2 에 넣는다(스모크는 가상 폰이라 UI 자산이 필요 없다).
  3. 계획 ② 의 `scripts/smoke/fake-claude.mjs` 를 `"$T/bin/claude"` 로 감싸 PATH 앞에 둔다.
  4. 저장소 서버를 띄운다: `DECK_CONFIG_DIR="$T/conf" HOME="$T/home" DECK_LOOPBACK_ONLY=1 DECK_PORT=$DP DECK_CLOUD_URL=http://127.0.0.1:$CP DECK_RELAY_URL=http://localhost:$CP npx tsx src/server/main.ts`
  5. `npx tsx scripts/smoke/relay-phone.ts $DP $CP "$T/conf/token" "$T/work"` 를 실행한다.
- `scripts/smoke/relay-phone.ts`
  1. 로컬 API 에 로그인한다(`turn.mjs` 와 같은 방식).
  2. `POST /api/cloud/link/start` 를 보낸다.
  3. 클라우드 `/v1/auth/magic` 을 보내고 `/dev/outbox` 에서 토큰을 꺼내 `POST /auth/verify` 로 로그인한다.
  4. `POST /v1/host/link/approve` 를 보내고, `/api/cloud/status` 가 `linked`·`relay:'up'` 이 될 때까지 기다린다(DO 의 첫 `{t:'ent',ok:true}` 를 받은 뒤라야 `up`).
  5. `POST /api/cloud/pair/start` → QR 주소를 파싱한다.
  6. **가상 폰**이 공유 `noise.ts`·`pairing.ts` 로 claim 하고 자기 쪽 `confirmCode` 를 계산한다. 티켓이 403 `pending_confirm` 인지 본다.
  7. Mac 쪽 `GET /api/cloud/pair/:id` 가 `awaiting_approval` 이고 `confirmCode` 가 폰 것과 같은지 확인한 뒤 `POST /api/cloud/pair/:id/approve` 를 보낸다(사람이 [허용] 누르는 것 대신).
  8. 티켓 → `ws` → Noise 핸드셰이크 → `ready` 교환 → `ws.open` 순서로 진행한다.
  9. 터널 WS 로 `send`(프롬프트 "approve") → `permission_request` 를 받는다 → `permission_response{allow}` 를 보낸다 → `turn_result` 를 받는다.
  10. 터널로 `POST /api/restart` 를 보내 403 `mac_confirm_required` 인지 본다.
  11. `relay-e2e: 승인 → allow hook=… mcp=…` 를 출력하고 0 으로 끝난다. 60초 안에 끝나지 않으면 마지막 메시지 12개와 함께 1 로 끝난다.

- [ ] **Step 1: 확인** — 다음을 확인한다.
  - R2 바인딩 API(`get`·`put`·`httpMetadata`)를 Workers 타입 정의와 플러그인 README 로 확인한다.
  - `wrangler dev` 의 `--persist-to` 플래그와 `wrangler r2 object put` 형태를 확인한다.
  - `src/ui/` 가 HTML `style=""`·`<style>` 을 쓰는지(`style-src`) 확인한다.
  - 저장소에 기존 릴리스 스크립트·문서가 있는지 확인한다(`release.sh` 가 감쌀 대상).
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/ui.test.ts — R2 에 테스트 객체를 put 한 뒤
it('/v/<ver>/ serves the versioned build on the relay origin, / boots, /sw.js from latest', async () => { /* … */ });
it('UI routes are 404 on the app origin', async () => { expect((await call('/v/1.0.0/index.html')).status).toBe(404); });
it('no cookie, strict CSP with no third-party origin', async () => {
  const r = await call('/v/1.0.0/index.html', {}, RELAY);
  expect(r.headers.get('set-cookie')).toBeNull();
  const csp = r.headers.get('content-security-policy')!;
  expect(csp).toContain("script-src 'self'"); expect(csp).not.toContain("'unsafe-eval'");
  expect(csp.match(/https?:\/\/[^\s;']+/g) ?? []).toEqual([]);
});
it('non-semver version path is 404', async () => { expect((await call('/v/..%2f/index.html', {}, RELAY)).status).toBe(404); });
it('/version.json comes from R2 latest/ with no-cache; 404 when missing', async () => { /* … */ });

// cloud/test/boot.test.ts — boot.js 의 순수 함수만
import { pickTarget } from '../static/boot.js';
it('stored version that exists wins', async () => {
  expect(await pickTarget({ stored: '1.2.3', exists: async () => true, latest: async () => '1.3.0' })).toBe('1.2.3');
});
it('stored version missing on R2 falls back to latest (2차 권장)', async () => {
  expect(await pickTarget({ stored: '1.2.3', exists: async () => false, latest: async () => '1.3.0' })).toBe('1.3.0');
});
it('no stored version (first visit / home-screen app) goes to latest; junk is ignored', async () => {
  expect(await pickTarget({ stored: null, exists: async () => true, latest: async () => '1.3.0' })).toBe('1.3.0');
  expect(await pickTarget({ stored: '../x', exists: async () => true, latest: async () => '1.3.0' })).toBe('1.3.0');
  expect(await pickTarget({ stored: null, exists: async () => true, latest: async () => 'nope' })).toBeNull();
});
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령 다섯 개를 돌린다. `bash scripts/release.sh "$(node -p "require('./package.json').version")" --dry-run` 이 ① UI 게시 ② npm publish ③ latest 갱신 순서의 명령만 출력하고 0 으로 끝나는지 본다(작업 트리가 깨끗할 때).
- [ ] **Step 6: 이정표 확인** — `bash scripts/smoke/relay-e2e.sh` 가 `relay-e2e: 승인 → allow …` 를 출력하고 0 으로 끝나는지 본다. 실행 중인 9320 서버에는 아무것도 보내지 않는다.
- [ ] **Step 7: 커밋** — `feat(cloud): relay 출처의 버전별 UI(boot 최신 폴백)·릴리스 스크립트(UI 먼저 → npm → latest)·폰에서 릴레이 경유 승인 e2e`

---

### Task 7: 요금제 표시 — `/v1/entitlement` 표시용 응답과 설정의 요금제 행

출시 1차는 **표시만** 한다. 서명(JWS)·로컬 검증·`ProGate`·오프라인 유예·출시 스위치는 출시 뒤 Task 13 이다. 릴레이 허용 여부는 이 Task 와 무관하게 클라우드(Task 3)가 정한다.

**Files:**
- Create: `cloud/src/entitlement.ts`, `src/server/cloud/PlanView.ts`
- Modify: `cloud/src/index.ts`, `src/server/cloud/CloudApi.ts`(`entitlement(token)`), `src/server/cloud/CloudService.ts`(PlanView 조립·`status.plan`), `src/server/http.ts`(`POST /api/cloud/plan/refresh`), `src/ui/cloudApi.ts`, `src/ui/components/CloudSection.tsx`(요금제 행), `src/ui/cloudTexts.ts`(또는 사전), `scripts/render/cloud-section.html`
- Test: `cloud/test/entitlement.test.ts`, `src/server/cloud/PlanView.test.ts`, `src/ui/components/CloudSection.test.tsx`(추가)

**Interfaces:**
- `[app] GET /v1/entitlement`(host Bearer) → `EntitlementRes = { plan: 'pro' | 'trial' | 'comp' | 'none'; st: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'; untilMs: number; checkedAt: number }`.
  - `entitledState(db, userId, now)` 를 그대로 옮기고 `checkedAt = now` 를 붙인다. `cache-control: no-store`.
  - 해제된 호스트·틀린 토큰은 401 `{code:'revoked'}`. 호스트당 분당 6회(넘으면 429).
- `CloudApi.entitlement(token): Promise<EntitlementRes>` — 401 이면 `CloudAuthError`(Task 4a 의 기존 처리로 `unlinked`).
- `PlanView.ts`: `class PlanView`
  - 생성자: `constructor(o: { api: CloudApi; state: CloudState; relay: { recheck(): void }; now?: () => number; setTimer?: typeof setTimeout })`
  - 메서드: `start()`(연결돼 있으면 즉시 한 번, 그 뒤 6시간 ±30분마다), `refresh(): Promise<EntitlementRes | null>`, `get(): EntitlementRes | null`, `stop()`
  - 새 값을 `state.plan` 에 저장한다. 네트워크·5xx 실패면 저장된 값을 그대로 둔다(표시는 `checkedAt` 으로 "마지막 확인 <시각>").
  - `plan`·`st`·`untilMs` 중 하나라도 바뀌고 새 `untilMs > now` 면 `relay.recheck()` 를 부른다(Task 4a — 붙어 있으면 `{"t":"recheck"}` 를 보내고, 끊겨 대기 중이면 즉시 다시 붙는다). 반대로 RelayClient 의 `'entitlement'` 이벤트(DO 의 `{t:'ent'}`)가 오면 `PlanView` 를 곧바로 다시 가져온다(2차 필수 1 — 웹훅 → recheck → 설정 화면까지 수 초).
  - 이 값으로 아무것도 막지 않는다. 테스트로 고정한다(아래 "표시만" 테스트).
- `POST /api/cloud/plan/refresh`(쿠키·Origin) → `EntitlementRes | null`. 설정 › 계정을 열 때 UI 가 한 번 부른다. 터널로 오면 `relayPathPolicy` 가 막는다(`/api/cloud/*` 규칙 그대로).
- `CloudStatus.plan`(Task 4b 타입)은 `PlanView.get()` 이다.
- `CloudSection.tsx` 요금제 행 문구:
  - `none`: "Community — 폰 릴레이는 Pro 에서" (+ Task 10 의 [Pro 구독])
  - `trial`: "체험 중 · N일 남음"(N = `ceil((untilMs - now) / 1일)`)
  - `pro`·`active`: "Pro · 사용 중", `past_due`: "결제 확인 필요 · <날짜>까지 유지", `canceled`(until 미래): "해지됨 · <날짜>까지"
  - `comp`: "Pro(초대) · <날짜>까지"
  - 클라우드 미연결이면 행을 숨긴다. 버튼은 [새로고침] 과 Task 10 이 더하는 [구독 관리].
  - Pro 설명 한 줄은 "Pro: 집 밖에서 폰으로 보고 승인하는 클라우드 릴레이와 폰 알림" 이다. 다른 기능 이름을 넣지 않는다(출시 점검 "릴레이·푸시만").

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// cloud/test/entitlement.test.ts
it('trial host → trial/trialing with the trial end', async () => {
  const h = await linkHost(); // Task 2 helper — 첫 연결이라 체험 시작
  const r = await call('/v1/entitlement', { headers: { authorization: `Bearer ${h.hostToken}` } });
  expect(r.status).toBe(200);
  const b = await r.json() as EntitlementRes;
  expect(b).toMatchObject({ plan: 'trial', st: 'trialing' });
  expect(b.untilMs).toBeGreaterThan(Date.now());
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it('comp grant wins when its until is later', async () => { /* grants 행 → plan comp */ });
it('nothing → none / 0', async () => { /* trials.ends_at 과거 */ });
it('revoked host → 401; relay origin → 404', async () => { /* … */ });

// src/server/cloud/PlanView.test.ts
it('stores the plan and calls relay.recheck when it changes to a live plan', async () => {
  const recheck = vi.fn();
  const api = { entitlement: vi.fn().mockResolvedValueOnce(none).mockResolvedValueOnce(pro) };
  const pv = new PlanView({ api: api as never, state, relay: { recheck } });
  await pv.refresh(); expect(recheck).not.toHaveBeenCalled();
  await pv.refresh(); expect(recheck).toHaveBeenCalledTimes(1);
  expect(state.get().plan).toEqual(pro);
});
it('a network failure keeps the stored plan', async () => { /* … */ });
it('display only: no server route or ws message is refused because of the plan', async () => {
  /* plan none 상태로 startServer → 다계정 순환·인계·총사령탑 설정 ws 메시지가 지금처럼 동작 */
});

// src/ui/components/CloudSection.test.tsx (추가)
it('plan row texts for trial / pro / past_due / canceled / none', () => { /* 5 상태 */ });
it('opening the account group calls plan/refresh once', async () => { /* fetchFn 스파이 */ });
```

- [ ] **Step 2: 실패 확인** — `npm --prefix cloud test` 와 `npx vitest run src/server/cloud src/ui/components/CloudSection.test.tsx --maxWorkers=2` 가 FAIL 하는지 본다.
- [ ] **Step 3: 구현** — 위대로 만든다.
- [ ] **Step 4: 통과 확인** — cloud 검증 세 개와 공통 검증 명령 다섯 개를 돌린다. 렌더 픽스처에 체험·Pro·결제 확인 필요·Community 네 상태를 더해 360·1440 폭으로 본다.
- [ ] **Step 5: 커밋** — `feat(cloud): 요금제 표시 — /v1/entitlement 표시용 응답·PlanView(바뀌면 릴레이 재시도)·설정 요금제 행`

---

### Task 9: Paddle 웹훅과 구독 상태

**Files:**
- Create:
  - `cloud/src/paddle/signature.ts`, `cloud/src/paddle/webhook.ts`, `cloud/src/paddle/apply.ts`, `cloud/src/paddle/userRef.ts`, `cloud/src/paddle/api.ts`, `cloud/src/ops.ts`
  - `cloud/migrations/0003_billing.sql`
  - `cloud/test/fixtures/paddle/{subscription.created,subscription.activated,subscription.updated,subscription.past_due,subscription.canceled,transaction.completed,adjustment.created}.json`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV: 'sandbox' | 'production'`, `PADDLE_IP_CHECK: '0' | '1'`, `PADDLE_API_KEY`, `CHECKOUT_SECRET`), `cloud/src/entitled.ts`(구독 반영), `cloud/vitest.config.ts`(`TEST_VARS` 에 `PADDLE_WEBHOOK_SECRET`·`CHECKOUT_SECRET`)
- Test: `cloud/test/paddle.signature.test.ts`, `cloud/test/paddle.webhook.test.ts`, `cloud/test/paddle.userRef.test.ts`, `cloud/test/entitled.test.ts`(추가)

**Interfaces:**
- `0003_billing.sql`:

```sql
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), customer_id TEXT, status TEXT NOT NULL, price_id TEXT, period_end INTEGER, canceled_at INTEGER, past_due_since INTEGER, scheduled_cancel INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE paddle_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE refunds (adjustment_id TEXT PRIMARY KEY, transaction_id TEXT, subscription_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, full INTEGER NOT NULL DEFAULT 0, cancel_done_at INTEGER, last_event_at INTEGER NOT NULL);
CREATE TABLE ops_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT, detail TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
-- Task 10 이 쓴다(이중 구독 방지, 권장 6).
CREATE TABLE checkout_intents (user_id TEXT PRIMARY KEY REFERENCES users(id), plan TEXT NOT NULL, completed_at INTEGER, expires_at INTEGER NOT NULL);
CREATE INDEX subscriptions_user ON subscriptions(user_id, status);
```

- `ops.ts`: `alertStmt(db, kind: OpsKind, ref: string | null, detail: string, now: number): D1PreparedStatement` — `ops_alerts` 행을 넣는 문장을 돌려주고(같은 batch 에 넣는다), 같은 내용을 `console.error(JSON.stringify({ alert: kind, ref }))` 로 남긴다(이메일·토큰은 넣지 않는다). `OpsKind = 'unmatched' | 'customer_conflict' | 'second_subscription' | 'invalid_event' | 'bad_payload' | 'refund_cancel_failed'`. 운영자는 `wrangler d1 execute` 로 `resolved_at IS NULL` 행을 본다(`cloud/README.md`).
- `signature.ts`: `verifyPaddleSignature(header: string | null, rawBody: string, secret: string, nowSec: number, toleranceSec = 5): Promise<boolean>`
  - 머리 형식은 `ts=<unix>;h1=<hex>` 이고 `h1` 이 여럿일 수 있다(비밀 교체 대비, 하나만 맞으면 통과).
  - 서명 대상은 `${ts}:${rawBody}` 이고 HMAC-SHA256 hex 로 계산한다. 비교는 상수 시간으로 한다.
  - `|now - ts| > tolerance` 면 false 다.
- `userRef.ts`(필수 8 — 브라우저가 보낸 `user_id` 를 믿지 않는다):
  - `signUserRef(secret: string, userId: string): Promise<string>` = `v1.<userId>.<b64u(HMAC-SHA256(secret, lp('aimsg-userref-v1', userId)))>`
  - `verifyUserRef(secret: string, ref: unknown): Promise<string | null>` — 형식·HMAC 이 맞을 때만 userId, 아니면 null(상수 시간 비교).
  - `checkConfig`(Task 2)에 `CHECKOUT_SECRET` 32자 이상을 더한다.
- `api.ts`: `interface PaddleApi { cancelSubscription(id: string): Promise<void>; portalSession(customerId: string, subscriptionIds: string[]): Promise<{ url: string }> }`. 이 Task 는 `cancelSubscription` 만 구현한다(`portalSession` 은 Task 10).
  - `cancelSubscription` 은 `POST <api>/subscriptions/{id}/cancel` 본문 `{ effective_from: 'immediately' }`, 머리 `Authorization: Bearer <PADDLE_API_KEY>` 다. 경로·본문 필드·필요 권한은 **(미확인)** 이라 Step 1 에서 Paddle API 문서로 확인한다. `<api>` 는 `PADDLE_ENV` 로 고른다(샌드박스 주소 **(미확인)**).
  - 테스트에는 가짜를 주입한다(외부 호출 없음). `index.ts` 가 `deps.paddle` 로 묶는다.
- `webhook.ts`: `POST /v1/paddle/webhook`(app 출처)
  1. `await req.text()` 로 원문을 그대로 읽는다(JSON 으로 다시 직렬화하지 않음).
  2. 서명을 검증한다. 실패하면 401 이고 아무것도 저장하지 않는다.
  3. `PADDLE_IP_CHECK === '1'` 이면 `CF-Connecting-IP` 가 환경별 Paddle IP 목록에 있어야 한다(아래 근거 절의 6개씩). 아니면 403 이다.
  4. JSON 파싱에 실패하거나 `event_id`·`event_type`·`occurred_at` 이 없으면 **200** `{outcome:'bad_payload'}` + `alertStmt('bad_payload', sha256(raw) 앞 16자)`. 서명이 맞는 결정적 오류라 재시도해도 같기 때문이다.
  5. `SELECT outcome FROM paddle_events WHERE event_id = ?` 가 있으면 바로 200 `{outcome:'duplicate'}`.
  6. `const plan = await planEvent(env, ev, now)` — 읽기만 하고 쓸 문장을 만든다. 데이터 모양이 틀리면 던지지 않고 `outcome:'invalid'` 를 돌려준다.
  7. `env.DB.batch([...plan.stmts, ...plan.alerts, insertEvent])` — `insertEvent` 는 `INSERT INTO paddle_events … ON CONFLICT(event_id) DO NOTHING`. 모든 반영 문장이 upsert 라서, 같은 이벤트가 동시에 두 번 들어와도 결과가 같다.
  8. batch 가 던지면(D1 일시 오류) **500** — 이벤트 행도 남지 않아 Paddle 재시도가 처음부터 다시 한다. 그 밖에는 **200** `{outcome}`.
  9. 커밋 뒤 `ctx.waitUntil` 로 `plan.effects` 를 실행한다: 호스트 DO 마다 `/internal/recheck`, 전액 환불·차지백이면 `paddle.cancelSubscription`(성공하면 `refunds.cancel_done_at`, 실패하면 `alert('refund_cancel_failed')` — Task 12 cron 이 다시 시도).
  10. 응답은 5초 안에 낸다(D1 몇 줄과 SELECT 몇 개다).
- `apply.ts`: `planEvent(env, ev, now): Promise<{ outcome: Outcome; stmts: D1PreparedStatement[]; alerts: D1PreparedStatement[]; effects: Effect[] }>`
  - `Outcome = 'applied' | 'stale' | 'unmatched' | 'customer_conflict' | 'second_subscription' | 'refund_recorded' | 'refund_cancel' | 'ignored' | 'invalid'`
  - **user 찾기:** `verifyUserRef(CHECKOUT_SECRET, data.custom_data?.ref)` → 없으면 `users.paddle_customer_id = data.customer_id` → 둘 다 없으면 `user_id NULL` 로 반영하고 `outcome:'unmatched'` + 알림. `custom_data.user_id` 같은 서명 없는 값은 읽지 않는다.
  - `subscription.*` → `subscriptions` upsert:

```sql
INSERT INTO subscriptions (id, user_id, customer_id, status, price_id, period_end, canceled_at, past_due_since, scheduled_cancel, last_event_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?4 = 'past_due' THEN ?8 END, ?9, ?8, ?10)
ON CONFLICT(id) DO UPDATE SET
  user_id = COALESCE(excluded.user_id, subscriptions.user_id),
  customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
  period_end = COALESCE(excluded.period_end, subscriptions.period_end), canceled_at = excluded.canceled_at,
  past_due_since = CASE WHEN excluded.status = 'past_due' THEN COALESCE(subscriptions.past_due_since, excluded.last_event_at) END,
  scheduled_cancel = CASE WHEN excluded.status = 'canceled' THEN MAX(subscriptions.scheduled_cancel, excluded.scheduled_cancel) ELSE excluded.scheduled_cancel END,
  last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
WHERE excluded.last_event_at >= subscriptions.last_event_at
```

    - `?8` 은 이벤트의 `occurred_at`(ms)이다. 저장된 `last_event_at` 이 더 크면 `outcome:'stale'`(SELECT 로 미리 판단, 문장은 그대로 넣어도 WHERE 가 막는다).
    - `past_due_since` 는 `past_due` 로 **처음 바뀐 이벤트의 `occurred_at`** 이고, past_due 가 이어지는 동안 바뀌지 않는다(권장 5).
    - 기간 끝 해지가 실제로 일어난 `canceled` 이벤트는 `current_billing_period` 가 비어 올 수 있어 `period_end` 는 기존 값을 지키고(`COALESCE`), `scheduled_cancel = 1` 도 지킨다(`MAX`). 그래야 예약 해지 유예(`period_end + 48시간`, 계약 절)를 계산할 수 있다.
    - 같은 user 에 `status IN ('active','trialing','past_due')` 인 **다른** 구독이 이미 있는데 이 이벤트도 활성이면 그대로 반영하고 `outcome:'second_subscription'` + 알림(권장 6 — 사람이 환불한다).
    - 활성 이벤트가 오면 `DELETE FROM checkout_intents WHERE user_id = ?` 를 같은 batch 에 넣는다(Task 10 잠금 해제).
  - `transaction.completed` → user 를 찾았고 `data.customer_id` 가 있으면:
    - 다른 user 가 그 `customer_id` 를 갖고 있거나, 이 user 가 다른 `customer_id` 를 갖고 있으면 **바꾸지 않고** `outcome:'customer_conflict'` + 알림, 200(필수 8 — UNIQUE 충돌로 500 을 내지 않는다).
    - 아니면 `UPDATE users SET paddle_customer_id = ? WHERE id = ? AND paddle_customer_id IS NULL`.
  - `adjustment.created|updated` → `refunds` upsert(`ON CONFLICT(adjustment_id) DO UPDATE … WHERE excluded.last_event_at >= refunds.last_event_at`, 필수 8 — 일반 INSERT 로 중복 오류를 내지 않는다).
    - **전액 환불(승인됨) 또는 차지백**이면 `full = 1`, `outcome:'refund_cancel'`, effect `cancel(subscription_id)`(권장 4). 해지 결과는 뒤따르는 `subscription.canceled` 웹훅이 상태에 반영한다.
    - 부분 환불·크레딧은 기록만(`refund_recorded`).
  - 그 밖의 이벤트는 `ignored` 로 이벤트 행만 남긴다.
  - 상태가 바뀐 user 의 호스트(`hosts.user_id`, `revoked_at IS NULL`)마다 effect `recheck(hostId)`.
- **Paddle 엔터티 필드 이름은 (미확인)** 이다: `data.status`, `data.customer_id`, `data.custom_data`, `data.current_billing_period.ends_at`, `data.scheduled_change.action`, `data.canceled_at`, `data.items[0].price.id`, adjustment 의 `action`(refund·chargeback 값)·`type`(full/partial)·`status`·`subscription_id`·`transaction_id`. Step 1 에서 문서 예시 페이로드와 맞추고, 픽스처를 그 모양 그대로 만든다. 확인한 것은 웹훅 머리·서명 방식·이벤트 이름·`custom_data` 전달·`event_id`·`occurred_at`(근거 절)이다.
- `entitled.ts` 추가(계약 절 "이용권 계산"): `subscriptions` 를 후보에 넣는다. `active`·`trialing`(해지 예약 포함) → `period_end + 48시간`(필수 7), `past_due` → `past_due_since + 7일`, `canceled`·`paused` → `canceled_at ?? last_event_at`. 단 `canceled` 이고 `scheduled_cancel = 1` 이며 그 구독에 `refunds.full = 1` 행이 없으면 `max(canceled_at, period_end + 48시간)`(예약 해지 유예, 2차 권장). `plan: 'pro'`. 여러 출처 가운데 `until` 이 가장 큰 것을 쓰고, 같으면 표시 우선순위 pro > comp > trial.

- [ ] **Step 1: Paddle 페이로드·API 확인** — Paddle 개발자 문서에서 다음을 확인하고 `cloud/README.md` 에 적는다. 다른 경로가 나오면 `apply.ts`·`api.ts` 와 이 문서의 Interfaces 를 고친다.
  - `subscription.created`·`updated`·`past_due`·`canceled`·`transaction.completed`·`adjustment.created` 예시 페이로드의 필드 경로(위 목록). 픽스처의 이메일·이름은 합성값으로 바꾼다.
  - 구독 해지 API 경로·본문·필요 권한, 샌드박스·라이브 API 주소.
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

// cloud/test/paddle.userRef.test.ts
it('round-trips and rejects tampering', async () => {
  const ref = await signUserRef('c'.repeat(32), 'u_1');
  expect(await verifyUserRef('c'.repeat(32), ref)).toBe('u_1');
  expect(await verifyUserRef('c'.repeat(32), ref.replace('u_1', 'u_2'))).toBeNull();
  expect(await verifyUserRef('c'.repeat(32), 'u_1')).toBeNull();
  expect(await verifyUserRef('c'.repeat(32), { user_id: 'u_1' })).toBeNull();
});

// cloud/test/paddle.webhook.test.ts — 픽스처 + sign helper, 가짜 PaddleApi(calls 기록)
it('duplicate event_id: second delivery is answered from paddle_events, state applied once', async () => {
  const a = await deliver(fx('subscription.activated', { ref: await refFor(user) }));
  const b = await deliver(fx('subscription.activated', { ref: await refFor(user) }));
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(await b.json()).toEqual({ outcome: 'duplicate' });
  expect(await count('paddle_events')).toBe(1);
});
it('replaying the same event after its row was lost gives the same state (all upserts)', async () => {
  await deliver(ev1); await env.DB.prepare('DELETE FROM paddle_events').run();
  expect((await deliver(ev1)).status).toBe(200);
  expect(await sub('sub_1')).toMatchObject({ status: 'active' });
});
it('older occurred_at cannot undo a newer state', async () => { /* canceled(10:00) 뒤 updated(09:00, active) → canceled, outcome stale */ });
it('active keeps entitlement 48 h past period_end (late renewal webhook)', async () => {
  /* entitledState.untilMs === period_end + 48h */
});
it('past_due: 7 days from the first past_due event, a later past_due update does not move it', async () => {
  /* past_due(occurred T) → updated past_due(T+2d) → untilMs === T + 7d */
});
it('forged custom_data.user_id is ignored; unknown customer → unmatched + ops alert, 200', async () => {
  const r = await deliver(fx('subscription.activated', { user_id: victim.id }));
  expect(r.status).toBe(200); expect(await r.json()).toEqual({ outcome: 'unmatched' });
  expect(await sub('sub_1')).toMatchObject({ user_id: null });
  expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'unmatched' }));
});
it('customer id already owned by another user → 200 customer_conflict, users unchanged, alert', async () => { /* … */ });
it('second active subscription for the same user → applied + second_subscription alert', async () => { /* … */ });
it('active subscription clears the checkout intent', async () => { /* checkout_intents 행 삭제 */ });
it('full refund → cancelSubscription called once; partial refund only recorded', async () => {
  await deliver(fx('adjustment.created', { action: 'refund', type: 'full', status: 'approved', subscription_id: 'sub_1' }));
  expect(paddle.calls).toEqual([['cancelSubscription', 'sub_1']]);
  expect(await refund('adj_1')).toMatchObject({ full: 1 });
});
it('chargeback → cancel; cancel failure → refund_cancel_failed alert, cancel_done_at stays null', async () => { /* … */ });
it('refund event delivered twice → one refunds row, no SQL error', async () => { /* … */ });
it('signed but unparseable body → 200 bad_payload + alert; missing data.status → 200 invalid + alert', async () => { /* … */ });
it('D1 failure during apply → 500 and no paddle_events row', async () => {
  /* deps.db 를 batch 가 던지는 래퍼로 바꿔 deliver → 500, 원래 DB 에 이벤트 행 없음 */
});
it('scheduled cancel keeps entitlement until period_end + 48 h, even after the canceled webhook', async () => {
  /* updated(active, scheduled_change.action='cancel', period_end P) → canceled(occurred P, current_billing_period 없음)
     → entitledState.untilMs === P + 48h. 같은 흐름에 full refund 행이 있으면 untilMs === canceled_at */
});
it('canceled closes device sockets at recheck, host stays attached and gets ent:false', async () => {
  /* 호스트 WS + 기기 WS 연결 → canceled(즉시) → runDurableObjectAlarm → 기기 4402, 호스트 열림 + {t:'ent',ok:false} */
});
it('Mac attached while not_entitled → webhook → recheck → ticket within seconds (2차 필수 1)', async () => {
  // relay.test.ts 의 openWs·pairedDevice·waitFor 를 helpers.ts 로 옮겨 같이 쓴다
  const h = await linkHost(); const d1 = await pairedDevice(h);
  await env.DB.prepare('UPDATE trials SET ends_at = 0').run();
  const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
  expect(host.status).toBe(101);                                           // 이용권 없어도 붙는다
  const ents = () => host.inbox!.filter((m) => typeof m === 'string').map((m) => JSON.parse(m as string)).filter((m) => m.t === 'ent');
  await waitFor(() => ents().length === 1); expect(ents()[0].ok).toBe(false);
  expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(402);
  const t0 = Date.now();
  // 폰에서 결제 → 웹훅 → effects(/internal/recheck)
  expect((await deliver(fx('subscription.activated', { ref: await refFor(h.userId) }))).status).toBe(200);
  await runDurableObjectAlarm(env.RELAY.get(env.RELAY.idFromName(h.hostId)));
  await waitFor(() => ents().some((m) => m.ok === true));
  expect(host.closes).toEqual([]);
  expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(200);
  expect(Date.now() - t0).toBeLessThan(5000);                               // 백오프 대기 없음
});
it('bad signature → 401, nothing stored; IP check on: non-Paddle IP → 403', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 6: 커밋** — `feat(billing): Paddle 웹훅 — 원문 HMAC·event_id 선조회·전부 upsert·업무 충돌은 200+기록+알림·서명된 user 참조·active 48시간·past_due 7일 유예·전액 환불/차지백 해지`

---

### Task 10: 결제·계정 화면 (app 출처 + 로컬 설정)

Paddle.js 는 **app 출처에만** 싣는다. relay 출처(폰 UI·기기 키)에는 어떤 제3자 스크립트도 없다(필수 2, D18).

**Files:**
- Create: `cloud/src/pages/account.ts`, `cloud/src/pages/checkout.ts`, `cloud/src/billing.ts`, `cloud/static/account.js`, `cloud/static/checkout.js`, `cloud/static/pages.css`
- Modify: `cloud/src/index.ts`, `cloud/src/paddle/api.ts`(`portalSession`), `cloud/src/env.ts`(`PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_MONTHLY`, `PADDLE_PRICE_YEARLY`, `PADDLE_DISCOUNT_FOUNDING?`), `src/ui/components/CloudSection.tsx`, `src/ui/cloudTexts.ts`(또는 사전), `scripts/render/cloud-section.html`
- Test: `cloud/test/billing.test.ts`, `src/ui/components/CloudSection.test.tsx`(추가)

**Interfaces:**
- 정적 파일: `[app] GET /static/{account.js,checkout.js,pages.css}` → `env.ASSETS.fetch(new Request(new URL('/' + 파일이름, req.url)))`(Task 5c 가 더한 `assets` 바인딩은 `./static` 을 루트에 올리므로 `/static/` 접두사를 떼어 넘긴다. `run_worker_first` 라 출처 검사를 먼저 거친다). 파일 이름은 이 세 개만 허용하고, `boot.js` 는 app 출처에서 404. relay 출처에서는 셋 다 404.
- `[app] GET /account`(웹 세션 필요, 없으면 `/login?next=/account`)
  - 보여 주는 것: 이메일, 요금제(체험 N일 남음 / Pro 월·연 · 다음 결제일 / 결제 확인 필요 / 해지됨 · 날짜까지 / 만료), 연결된 Mac 목록(이름·연결일·[Unlink]), 기기 목록(이름·추가일·[Revoke]).
  - 버튼: [Subscribe monthly]·[Subscribe yearly](구독이 없을 때) 또는 [Manage billing], [Sign out]. 맨 아래 "Delete account" 묶음은 Task 12 가 더한다.
  - Pro 설명 문구: "AI-MSG Pro: a cloud relay to see and approve your Mac's sessions from your phone, with push notifications." 다른 기능 이름을 넣지 않는다(출시 점검 "릴레이·푸시만", 필수 6).
- `[app] GET /checkout?plan=pro-monthly|pro-yearly` — 계획 ③ 랜딩의 결제 버튼이 가리키는 **고정 주소**다.
  - 로그인하지 않았으면 `/login?next=…` 으로 보낸다.
  - `entitledState` 가 `plan:'pro'` 이고 `st` 가 `active`·`past_due` 면 `/account` 로 보낸다.
  - `checkout_intents` 에 이 user 의 `completed_at` 이 있고 `expires_at > now` 면(결제를 마쳤는데 웹훅이 아직 안 옴) `/account?pending=1` 로 보낸다. 계정 페이지는 "Payment received — confirming. This takes up to a minute." 를 보여 준다(권장 6).
  - 그 밖에는 Paddle.js 오버레이를 여는 페이지를 준다. 값(클라이언트 토큰·가격 id·이메일·`ref = signUserRef(CHECKOUT_SECRET, userId)`)은 `data-*` 속성으로 넘기고 인라인 스크립트는 쓰지 않는다.
  - 이 주소는 계획 ③ D12 의 `AIMSG_CHECKOUT_PRO_MONTHLY`·`AIMSG_CHECKOUT_PRO_YEARLY` 값이 된다(`https://app.aimsg.app/checkout?plan=pro-monthly` 등).
- `billing.ts`(웹 세션 + `Origin === PUBLIC_ORIGIN`):
  - `POST /v1/billing/intent {plan}` → 위 두 조건(활성 구독·완료된 intent)이면 409 `{code:'already_subscribed' | 'payment_pending'}`. 아니면 `checkout_intents` upsert(`completed_at NULL`, `expires_at = now + 15분`) 후 200. `checkout.js` 가 오버레이를 열기 **전에** 부른다.
  - `POST /v1/billing/intent/complete` → `completed_at = now`, `expires_at = now + 15분`. `checkout.js` 가 Paddle.js 의 결제 완료 이벤트에서 부른다. 이벤트 이름(`checkout.completed`)은 **(미확인)** 이다.
  - 활성 구독 웹훅이 오면 Task 9 가 intent 를 지운다. 완료 이벤트가 안 와서(탭을 닫음) 두 번째 결제가 생기면 Task 9 의 `second_subscription` 알림이 마지막 그물이다.
  - `POST /v1/billing/portal` → `{url}`. `PaddleApi.portalSession(customerId, subscriptionIds)` 가 `POST <api>/customers/{customer_id}/portal-sessions`(본문 `{ subscription_ids?: string[] }` ≤ 25, `Authorization: Bearer <PADDLE_API_KEY>`)로 요청한다. 이 엔드포인트와 권한 `customer_portal_session.write`, "캐시 금지" 는 확인했다. 응답 `data.urls.general` 아래 개요 링크의 하위 키 이름은 **(미확인)** 이다. `cache-control: no-store`.
- `checkout.js`
  - `Paddle.Initialize({ token, eventCallback })`, 샌드박스면 `Paddle.Environment.set('sandbox')`.
  - `Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customer: { email }, customData: { ref }, discountCode? })`. `customData` 에는 서명된 `ref` 하나만 싣는다(`user_id` 를 싣지 않는다, 필수 8).
  - 확인한 것은 `customData` → 웹훅 `custom_data` 전달이다. `Initialize`·`eventCallback`·`Environment.set`·`items`·`customer.email`·`discountCode` 의 정확한 형태와 Paddle.js 스크립트 주소는 **(미확인)** 이라 Step 1 에서 확인한다.
- CSP(`/checkout`·`/account`만): `script-src 'self' <Paddle.js 출처>; frame-src <Paddle 체크아웃 출처>; connect-src 'self' <Paddle 출처>; frame-ancestors 'none'`. 출처 목록은 **(미확인)** 이라 Step 1 에서 확정한다. 다른 app 페이지(로그인·법적 페이지)는 `script-src 'self'` 만이다.
- 로컬 `CloudSection.tsx`
  - 요금제 행(Task 7)에 [구독 관리] 를 더한다. 사용자 기기에서 `window.open('<PUBLIC_ORIGIN>/account', '_blank', 'noopener')` 로 연다(relay 출처가 아니라 app 출처).
  - `plan: 'none'` 이고 체험을 이미 썼으면 [Pro 구독] → `<PUBLIC_ORIGIN>/checkout?plan=pro-monthly` 를 새 탭으로. 미연결이면 연결 흐름을 시작한다(첫 연결 때 체험, D8).
  - 결제를 마치고 돌아오면(`visibilitychange`) `POST /api/cloud/plan/refresh` 를 한 번 부른다 → 바뀌면 Task 7 이 `relay.recheck()`.

- [ ] **Step 1: Paddle.js·포털 응답 확인** — 다음을 확인하고 `cloud/README.md` 에 적는다.
  - Paddle.js v2 의 스크립트 주소·`Initialize`·`eventCallback` 의 완료 이벤트 이름·`Environment`·`Checkout.open` 인자, CSP 에 넣을 출처.
  - 포털 세션 응답의 `urls` 구조, 샌드박스 API 주소.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/billing.test.ts
it('/checkout without a session → login with next', async () => { /* 302 Location /login?next=%2Fcheckout%3Fplan%3Dpro-monthly */ });
it('/checkout renders data-* only, signed ref instead of user_id, no inline script, Paddle only in CSP', async () => {
  const r = await call('/checkout?plan=pro-monthly', { headers: { cookie: await webCookie(user) } });
  const html = await r.text();
  expect(html).not.toMatch(/<script>(?!<\/script>)|<script[^>]*>[^<]+<\/script>/);
  expect(html).not.toContain(`data-user-id`);
  expect(await verifyUserRef(env.CHECKOUT_SECRET, attr(html, 'data-ref'))).toBe(user.id);
});
it('checkout pages are 404 on the relay origin and Paddle never appears in relay CSP', async () => { /* … */ });
it('/checkout with an active subscription → /account', async () => { /* … */ });
it('completed intent within 15 min → /account?pending=1; intent API returns payment_pending', async () => {
  await post('/v1/billing/intent', { plan: 'pro-monthly' }, webHeaders(user));
  await post('/v1/billing/intent/complete', {}, webHeaders(user));
  expect((await call('/checkout?plan=pro-yearly', webHeaders(user))).headers.get('location')).toBe('/account?pending=1');
  expect((await post('/v1/billing/intent', { plan: 'pro-yearly' }, webHeaders(user))).status).toBe(409);
});
it('an abandoned (not completed) intent does not block a retry', async () => { /* intent → intent → 200 */ });
it('intent / portal need session + Origin; portal is no-store', async () => { /* 가짜 PaddleApi */ });
it('account page: Pro copy names only relay and push; lists hosts and devices; revoke works', async () => {
  /* 본문에 'relay'·'push' 포함, 'accounts'·'rotation'·'routing' 미포함 */
});

// src/ui/components/CloudSection.test.tsx (추가)
it('구독 관리 opens the app-origin account page on this device', async () => { /* window.open 스파이 — PUBLIC_ORIGIN/account */ });
it('after trial: Pro 구독 opens checkout; coming back refreshes the plan', async () => { /* visibilitychange → plan/refresh */ });
```

- [ ] **Step 3: 실패 확인** — 해당 테스트들이 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 위대로 만든다. 페이지 HTML 은 영어이고 `escapeHtml` 을 거친다. 스타일은 `pages.css` 한 파일이다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다. 렌더 픽스처를 확인한다(체험·Pro·결제 확인 중·만료 네 상태).
- [ ] **Step 6: 커밋** — `feat(billing): 계정·결제 페이지(app 출처에서만 Paddle.js·서명된 user 참조)·결제 진행 잠금·포털·설정의 구독 행`

---

### Task 12: 법적 페이지 게시·계정 삭제·만료 행 정리 cron

번호는 새로 붙였지만 **Task 11 보다 먼저** 실행한다(출시 범위 표 순서 9). Task 11 의 보안 테스트가 이 Task 의 라우트까지 덮는다.

**Files:**
- Create:
  - 법적 페이지: `cloud/scripts/legal-md.mjs`(순수 변환, `node:` 없음), `cloud/scripts/build-legal.mjs`(파일 읽기·쓰기), `cloud/src/pages/legal.ts`, `cloud/src/legal/notice.ts`
  - 계정·정리: `cloud/src/account.ts`, `cloud/src/cleanup.ts`, `cloud/migrations/0004_account.sql`
- Modify: `cloud/src/index.ts`(`scheduled`, 라우트), `cloud/src/pages/layout.ts`(바닥글), `cloud/src/pages/account.ts`(삭제 묶음), `cloud/static/account.js`(삭제 확인), `cloud/wrangler.jsonc`(`triggers.crons`), `cloud/package.json`(`pretest`·`predev`·`predeploy`), `.gitignore`(`cloud/src/legal/pages.gen.ts`)
- Test: `cloud/test/legal-md.test.ts`, `cloud/test/legal.test.ts`, `cloud/test/account.test.ts`, `cloud/test/cleanup.test.ts`

**Interfaces:**
- 선행 조건: 법적 문서 초안 `docs/legal/{terms,privacy,refund}{,.ko}.md` 가 이 브랜치에 있어야 한다. Step 0 에서 여섯 파일이 있는지 보고, 없으면 멈추고 보고한다(초안은 별도 작업에서 쓰는 중).
- `legal-md.mjs`: `renderLegal(md: string, o: { strict: boolean; links: Record<string, string> }): { title: string; html: string; placeholders: string[] }`
  - **지원하는 문법만** 받는다: `#`·`##`·`###` 제목, 문단, `> ` 인용, `- ` 목록, `1. ` 번호 목록(한 단계), 파이프 표(머리 줄 + `|---|` 줄), `**굵게**`, `` `코드` ``, `[글](주소)`.
  - 모든 텍스트를 먼저 HTML 이스케이프한 뒤 위 문법만 태그로 바꾼다.
  - 그 밖의 문법(원시 HTML `<`, 이미지 `![`, 코드 펜스 ```` ``` ````, 들여쓴 하위 목록, `*기울임*`·`_기울임_`, 각주)이 나오면 `LegalSyntaxError(줄 번호)` 를 던져 **빌드를 실패**시킨다.
  - 링크 주소는 `links` 표에 있는 상대 경로(`terms.md` → `/legal/terms`, `privacy.ko.md` → `/legal/ko/privacy` 등), `https://`, `mailto:` 만 허용한다. 그 밖(`javascript:`, 모르는 상대 경로)은 `LegalSyntaxError`.
  - `{{…}}` 표시(초안의 `{{EFFECTIVE_DATE}}`·`{{확인 필요: …}}`)는 `placeholders` 에 모은다. `strict` 면 하나라도 있으면 던진다. 아니면 `<mark class="todo">` 로 눈에 띄게 그린다. `strict` 는 첫 인용 블록의 `DRAFT` 표시도 거부한다.
- `build-legal.mjs [--strict]`: 저장소 루트의 `docs/legal/` 여섯 파일을 읽어 `cloud/src/legal/pages.gen.ts` 를 쓴다: `export const LEGAL = { terms: { en: { title, html }, ko: { … } }, privacy: …, refund: … } as const; export const LEGAL_DRAFT: boolean`. 파일이 하나라도 없으면 실패한다.
  - `cloud/package.json`: `"pretest": "node scripts/build-legal.mjs"`, `"predev": "node scripts/build-legal.mjs"`, `"predeploy": "node scripts/build-legal.mjs --strict"`, `"deploy": "wrangler deploy"`. 그래서 **초안 표시가 남아 있으면 배포가 안 된다**(사용자가 `npm --prefix cloud run deploy` 로 배포, `cloud/README.md`).
  - 생성 파일은 커밋하지 않는다(`.gitignore`). 원본은 `docs/legal/*.md` 하나뿐이다.
- `notice.ts`: 비제휴 고지 en/ko.
  - en: "AI-MSG is an independent product. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google or xAI. Product names such as Claude, Codex, Gemini and Grok belong to their owners. AI-MSG runs the official tools you install and sign in to yourself; it does not sell or resell AI usage."
  - ko: "AI-MSG 는 독립 제품입니다. Anthropic·OpenAI·Google·xAI 와 제휴하거나 그들의 보증·후원을 받지 않습니다. Claude·Codex·Gemini·Grok 등의 이름은 각 소유자의 것입니다. AI-MSG 는 사용자가 직접 설치하고 로그인한 공식 도구를 실행할 뿐, AI 사용을 판매·재판매하지 않습니다."
- `pages/legal.ts` — `[app] GET /legal/{terms,privacy,refund,notice}`(영어), `[app] GET /legal/ko/{terms,privacy,refund,notice}`(한국어).
  - `layout.ts` 로 감싼다. CSP `default-src 'self'; script-src 'none'; style-src 'self'; frame-ancestors 'none'`. `cache-control: public, max-age=3600`.
  - `LEGAL_DRAFT` 면 맨 위에 "Draft — not yet in force" 띠를 보인다(로컬·테스트에서만 가능, 배포는 strict 라 막힌다).
  - relay 출처에서는 404. relay 출처의 부트스트랩 화면(Task 5c)은 app 출처 법적 페이지로 가는 일반 링크만 둔다.
- `layout.ts` 바닥글(모든 app 페이지): "Terms · Privacy · Refunds · Notice" 링크 + 고지 첫 문장. 결제 페이지(`/checkout`)에도 붙는다(출시 점검 L10 의 "결제 페이지에 고지").
- `account.ts` — `[app] POST /v1/account/delete {confirm: 'DELETE'}`(웹 세션 + `Origin === PUBLIC_ORIGIN`, 사용자당 시간당 5회)
  - `confirm` 이 정확히 `DELETE` 가 아니면 400 `{code:'confirm_required'}`.
  - `subscriptions` 에 이 user 의 `status IN ('active','trialing','past_due') AND scheduled_cancel = 0` 이 있으면 409 `{code:'active_subscription'}`(계정 페이지는 [Manage billing] 에서 먼저 해지하라고 안내).
  - 아니면 한 batch 로 지운다(자식부터): `relay_tickets`(user) → `devices`(user) → `pairings`(그 user 의 호스트) → `hosts`(user) → `host_links`(user_id) → `web_sessions` → `magic_links`(email) → `outbox`(to_addr) → `trials` → `grants` → `checkout_intents` → `users`.
  - **남기는 것:** `trial_claims` 행은 남기고 `user_id` 만 NULL(정규화 이메일 키 해시라 원래 주소를 되돌릴 수 없다 — 같은 이메일로 다시 가입해도 체험은 `already_used`). `subscriptions` 는 `user_id` 만 NULL(결제 기록은 Paddle 이 판매자로서 보관). `ops_alerts.ref` 가 그 user id 면 NULL.
  - 커밋 뒤 `ctx.waitUntil` 로 그 user 의 호스트 DO 마다 `/internal/unlink`(Task 3, 4401 로 모두 닫음). Mac 은 다음 호출에서 401 → `unlinked`(Task 4a).
  - 응답 200 `{ok:true}` + 쿠키 지우기(`__Host-aimsg_web=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`). `account.js` 가 `/account/deleted`(로그인 없이 보이는 안내 페이지)로 옮긴다.
- 계정 페이지(Task 10)의 "Delete account" 묶음: 지우는 것·남는 것을 위 목록대로 한 줄씩, 입력칸("type DELETE") + [Delete my account]. 활성 구독이면 버튼 대신 해지 안내.
- `0004_account.sql` — 정리 쿼리용 색인:

```sql
CREATE INDEX magic_links_exp ON magic_links(expires_at);
-- relay_tickets(expires_at) 색인은 Task 3 의 0002_relay.sql(relay_tickets_expires)에 이미 있다.
CREATE INDEX pairings_exp ON pairings(expires_at);
CREATE INDEX host_links_exp ON host_links(expires_at);
CREATE INDEX web_sessions_exp ON web_sessions(expires_at);
CREATE INDEX rate_window ON rate(window_start);
CREATE INDEX ops_alerts_created ON ops_alerts(created_at);
CREATE INDEX paddle_events_received ON paddle_events(received_at);
CREATE INDEX checkout_intents_exp ON checkout_intents(expires_at);
CREATE INDEX trial_claims_user ON trial_claims(user_id);
```

- `cleanup.ts`: `runCleanup(env: Env, nowMs: number, deps: { paddle: PaddleApi }): Promise<Record<string, number>>` — 표마다 한 번에 최대 5,000행(`WHERE rowid IN (SELECT rowid … LIMIT 5000)`)을 지우고 지운 수를 돌려준다.

| 표 | 지우는 조건 |
|---|---|
| `magic_links` | `expires_at < now − 1일` |
| `relay_tickets` | `expires_at < now − 1시간` |
| `rate` | `window_start < now − 2일`(가장 긴 창이 하루) |
| `pairings` | `expires_at < now − 1일` 이고 그 페어링을 가리키는 `devices` 가 없음 |
| `host_links` | `expires_at < now − 1일` |
| `web_sessions` | `expires_at < now` |
| `outbox` | `created_at < now − 1일`(로그 모드에서만 쌓인다) |
| `checkout_intents` | `expires_at < now` |
| `paddle_events` | `received_at < now − 90일`(Paddle 재시도는 약 2일) |
| `ops_alerts` | `resolved_at IS NOT NULL` 이거나 `created_at < now − 90일` |

  - 이어서 `refunds` 가운데 `full = 1 AND cancel_done_at IS NULL AND last_event_at < now − 10분` 인 행에 `paddle.cancelSubscription` 을 다시 시도한다(Task 9). 성공하면 `cancel_done_at`, 실패하면 `refund_cancel_failed` 알림(같은 행은 하루 한 번만).
  - 결과는 `console.log(JSON.stringify({ cron: 'cleanup', ...counts }))` 로 남긴다(개수만, 식별자 없음).
- `index.ts`: `scheduled(controller, env, ctx) { ctx.waitUntil(runCleanup(env, Date.now(), deps)) }`. `wrangler.jsonc`: `triggers: { crons: ["17 3 * * *"] }`(하루 한 번, UTC 03:17).
- 데이터 보관 기간은 위 표가 기준이고, Task 11 의 `docs/privacy-data-inventory.md` 와 `docs/legal/privacy*.md` 가 같은 값을 말해야 한다(다르면 사용자에게 보고).

- [ ] **Step 0: 선행 조건 확인** — `ls docs/legal/{terms,privacy,refund}{,.ko}.md` 가 여섯 개를 모두 찾는지 본다. 없으면 멈추고 보고한다.
- [ ] **Step 1: 확인** — `cloudflare:test` 에 scheduled 핸들러를 부르는 helper 가 있는지(`createScheduledController` 등) 플러그인 README 에서 확인한다. 없으면 테스트는 `runCleanup` 을 직접 부르고 `scheduled` 는 `exports.default.scheduled` 호출로 연결만 본다. `wrangler.jsonc` 의 `triggers.crons` 형태도 확인한다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/legal-md.test.ts
import { renderLegal, LegalSyntaxError } from '../scripts/legal-md.mjs';
const links = { 'terms.md': '/legal/terms', 'privacy.md': '/legal/privacy' };
it('renders the supported subset and escapes text', () => {
  const r = renderLegal('# T\n\n- **a** & `b`\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\nSee [Privacy](privacy.md).', { strict: false, links });
  expect(r.title).toBe('T');
  expect(r.html).toContain('<strong>a</strong> &amp; <code>b</code>');
  expect(r.html).toContain('<table>'); expect(r.html).toContain('href="/legal/privacy"');
});
it.each(['<b>x</b>', '![i](x.png)', '```\ncode\n```', '- a\n  - nested', '*it*', '[x](javascript:alert(1))', '[x](other.md)'])(
  'rejects unsupported syntax: %s', (md) => { expect(() => renderLegal(md, { strict: false, links })).toThrow(LegalSyntaxError); });
it('placeholders: marked when not strict, fatal when strict', () => {
  expect(renderLegal('Date {{EFFECTIVE_DATE}}', { strict: false, links }).html).toContain('<mark class="todo">');
  expect(() => renderLegal('Date {{EFFECTIVE_DATE}}', { strict: true, links })).toThrow();
  expect(() => renderLegal('> **DRAFT. Not legal advice.**', { strict: true, links })).toThrow();
});
it('the real drafts build in non-strict mode', async () => { /* LEGAL.terms.en.title 이 비어 있지 않음 — pages.gen.ts import */ });

// cloud/test/legal.test.ts
it('/legal/terms and /legal/ko/terms on the app origin, 404 on relay', async () => { /* … */ });
it('legal pages run no script and every app page has the footer with the notice', async () => {
  for (const p of ['/login', '/legal/privacy', '/legal/notice']) {
    const r = await call(p); const html = await r.text();
    expect(html).toContain('href="/legal/terms"'); expect(html).toContain('not affiliated');
  }
  expect((await call('/legal/terms')).headers.get('content-security-policy')).toContain("script-src 'none'");
});

// cloud/test/account.test.ts
it('needs session, Origin and confirm', async () => { /* 401 / 403 / 400 confirm_required */ });
it('active subscription → 409 active_subscription, nothing deleted', async () => { /* … */ });
it('deletes the account, keeps the trial claim, closes the relay', async () => {
  const { user, host, hostWs } = await linkedUserWithRelay('a.b+x@gmail.com');
  const r = await post('/v1/account/delete', { confirm: 'DELETE' }, webHeaders(user));
  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(await row('users', user.id)).toBeNull();
  expect(await count('hosts')).toBe(0); expect(await count('devices')).toBe(0);
  expect(await env.DB.prepare('SELECT user_id FROM trial_claims').first()).toEqual({ user_id: null });
  await waitFor(() => hostWs.closeCode === 4401);
});
it('signing up again with an equivalent address gets trial already_used', async () => {
  /* 삭제 뒤 'ab@gmail.com' 으로 가입·연결 → approve 응답 trial: 'already_used' */
});

// cloud/test/cleanup.test.ts
it('removes only expired rows and keeps pairings that devices still point to', async () => {
  await seedExpiredAndFresh(); // 표마다 지난 행 1개·살아 있는 행 1개
  const n = await runCleanup(env, Date.now(), { paddle: fakePaddle() });
  expect(n).toMatchObject({ magic_links: 1, relay_tickets: 1, rate: 1, host_links: 1, web_sessions: 1, checkout_intents: 1 });
  expect(await count('pairings')).toBe(2); // 지난 페어링 하나는 기기가 가리켜서 남음
  expect(Object.values(await runCleanup(env, Date.now(), { paddle: fakePaddle() })).every((v) => v === 0)).toBe(true);
});
it('retries a pending refund cancel and records success', async () => { /* refunds full=1 cancel_done_at NULL → calls 1, cancel_done_at 채워짐 */ });
it('logs counts only', async () => { /* console.log 스파이 — 이메일·id 없음 */ });
```

- [ ] **Step 3: 실패 확인** — `npm --prefix cloud test` 가 FAIL 하는지 본다(`pretest` 가 초안으로 `pages.gen.ts` 를 만든다).
- [ ] **Step 4: 구현** — 위대로 만든다.
- [ ] **Step 5: 통과 확인** — cloud 검증 세 개와 공통 검증 명령을 돌린다. `node cloud/scripts/build-legal.mjs --strict` 는 초안 표시 때문에 **실패해야 정상**이다 — 실패 메시지가 남은 `{{…}}` 개수와 파일·줄을 알려 주는지 본다.
- [ ] **Step 6: 커밋** — `feat(cloud): 법적 페이지(docs/legal 빌드·초안이면 배포 거부)·비제휴 고지 바닥글·계정 삭제(체험 키 보존)·만료 행 정리 cron`

---

### Task 11: 보안·장애 테스트와 문서

출시 1차 범위만 담는다. 부하 스크립트는 출시 뒤 Task 14, 출시 스위치는 출시 뒤 Task 13 이다. `publish-ui.sh`·`scripts/release.sh` 는 Task 5c 에서 만든다.

**Files:**
- Create: `docs/security-model.md`, `docs/privacy-data-inventory.md`, `src/server/cloud/faults.test.ts`, `src/server/cloud/localGuards.test.ts`, `cloud/test/security.test.ts`, `cloud/README.md`(완성)
- Modify: `src/hygiene.ts`(`GENERIC_RULES` 추가), `src/hygiene.test.ts`(규칙 확인 케이스), `README.md`(Pro·클라우드 절 — 위 "랜딩에 쓸 정직한 문구" 와 같은 뜻), `docs/protocol.md`(최종 점검)

**Interfaces:**
- 위생 규칙 추가(`GENERIC_RULES`) — 테스트 문자열은 기존처럼 쪼개 쓴다.
  - PEM 개인키 일반형: `BEGIN (EC |RSA )?PRIVATE KEY`
  - 개인 JWK: `"kty"\s*:\s*"(OKP|EC)"` 와 같은 객체 안의 `"d"\s*:\s*"[A-Za-z0-9_-]{40,}"`
  - Paddle API 키 접두사는 **(미확인)** 이라 규칙에 넣지 않는다. 확인되면 따로 더한다.
- `localGuards.test.ts`(권장 1 — 악성 웹페이지는 로컬 서버가 이미 막는다는 것을 `/api/cloud/*` 에도 고정, 실제 `startServer` + 임시 configDir)
  - `Host: evil.test` 로 `GET /api/cloud/status` → 421(`src/server/http.ts` 의 `isAllowedHost` 검사).
  - 로그인 쿠키를 가진 채 `Origin: https://evil.test` 로 `POST /api/cloud/pair/start`·`/api/cloud/link/start`·`/api/cloud/devices/x/revoke`·`/api/cloud/plan/refresh` → 403(`stateChangingOriginOk`).
  - 쿠키 없이 같은 요청 → 401. 로그인 응답의 쿠키에 `SameSite=Strict` 가 있다(`src/server/auth.ts` 의 `loginCookieHeader`).
  - 터널(RelayBridge, FakeRelay)로 온 `POST /api/cloud/pair/:id/approve`·`/api/restart`·`/api/setup/*` → 403 `mac_confirm_required`, 루프백에는 닿지 않는다.
- `faults.test.ts`(로컬, 실제 `startServer` + 임시 configDir)
  - 클라우드 주소가 닫힌 포트일 때 서버가 뜨고 `/api/me`·ws `hello`·세션 목록·로컬 푸시 구독이 정상인지 본다.
  - 클라우드에 연결하지 않은 설치는 클라우드로 요청을 하나도 보내지 않는다(`fetch` 스파이 0회).
  - 연결 상태에서 클라우드가 5xx 일 때 `relay: 'down'`, 저장된 요금제 표시 유지, 로컬 VAPID 푸시 무영향인지 본다.
  - 잠자기·깨어남(시계 점프 2시간)에 RelayClient 가 즉시 재연결하는지 본다.
- `cloud/test/security.test.ts`
  - **출처 분리 행렬:** 라우트 표 전체를 돌며 반대쪽 출처로 보내면 404, 모르는 호스트 이름이면 404.
  - **relay 출처:** 모든 응답에 `Set-Cookie` 가 없고, CSP 에 제3자 출처·`'unsafe-eval'` 이 없으며 `script-src 'self'` 다. 요청에 app 쿠키를 붙여 보내도 결과가 같다(쿠키를 읽지 않음).
  - **app 출처:** 모든 HTML 응답에 CSP·`frame-ancestors 'none'` 이 있고, 개인 정보가 있는 페이지는 `no-store` 다. Paddle 출처는 `/checkout`·`/account` CSP 에만 있다. 쿠키에 `Domain` 이 없다.
  - 상태를 바꾸는 웹 라우트(`/v1/host/link/approve`, `/v1/billing/*`, `/v1/account/delete`, `/v1/devices/:id/revoke`)에 교차 출처를 보내면 403.
  - 토큰·티켓·claim·`auth`·이메일이 로그(`console.log`·`console.error` 스파이)에 나오지 않는다.
  - D1 에 평문 토큰이 없다(모든 `*_hash` 열이 해시 모양, `trial_claims.email_key` 가 이메일 모양이 아님).
  - 속도 제한: 매직링크·`link/start`·`link/approve`·claim·ticket·계정 삭제가 각각 걸린다.
  - `checkConfig`: 공개 출처에서 `EMAIL_MODE=log`·`DEV_ROUTES=1`, 비밀 길이 부족, 두 출처 같음 → 모든 요청 503.
- 문서
  - `docs/security-model.md`(영어): 이 계획의 "보안 모델과 한계" 절을 그대로 옮긴다 — 지키는 것, **운영자 신뢰 범위(폰 UI JS)**, Mac 확인이 필요한 동작 목록, 위협별 표, 페어링(확인 코드·[허용]·두 번 claim 폐기), 키 저장 위치(Mac `state.json` 0600, 폰 IndexedDB 추출 불가 키 — 또는 `@noble/curves` 대체 시 원시 바이트), 기기 해제. "암호 구현" 줄에 Task 1 Step 1 의 결과(고른 라이브러리와 버전 또는 사양 직접 구현)와 통과한 테스트 벡터 출처를 적는다.
  - `docs/privacy-data-inventory.md`: 항목·목적·보관 기간·처리자(Cloudflare·Paddle·Resend). 이메일, 정규화 이메일 키 해시(계정 삭제 뒤에도 보관 — 체험 1회), IP(속도 제한 키, 최대 2일), Mac 이름(`os.hostname()` 앞 40자, 권장 8), 호스트·기기 id·공개키·기기 이름, 릴레이 메타데이터(바이트 수·시각·종료 코드), Paddle 고객·구독 id, 웹훅 이벤트(90일), 운영 알림(90일). 푸시 구독(endpoint)은 Mac 에만 있고 클라우드에 없다. 보관 기간은 Task 12 정리 표와 같아야 한다. `docs/legal/privacy.md` 와 다른 점이 있으면 목록으로 사용자에게 보고한다(법적 문서는 이 Task 에서 고치지 않는다).
  - `cloud/README.md`: 사용자 배포 절차(아래 "사용자 몫" 순서와 같게), comp 부여 SQL(`INSERT INTO grants (user_id, plan, until, note) VALUES (?, 'comp', ?, 'owner')`), `ops_alerts` 확인 쿼리, 비밀 목록.

- [ ] **Step 1: 실패하는 테스트 작성** — `localGuards.test.ts`, `faults.test.ts`, `cloud/test/security.test.ts`, 위생 규칙 케이스를 작성한다.

```ts
// src/server/cloud/localGuards.test.ts
it('a malicious page cannot drive /api/cloud/* on the local server', async () => {
  const s = await startTestServer(); const cookie = await s.login();
  expect((await s.raw('GET', '/api/cloud/status', { host: 'evil.test', cookie })).status).toBe(421);
  for (const p of ['/api/cloud/pair/start', '/api/cloud/link/start', '/api/cloud/devices/x/revoke', '/api/cloud/plan/refresh'])
    expect((await s.raw('POST', p, { cookie, origin: 'https://evil.test' })).status).toBe(403);
  expect((await s.raw('POST', '/api/cloud/pair/start', {})).status).toBe(401);
  expect(s.loginSetCookie).toContain('SameSite=Strict');
});
it('the phone cannot approve its own pairing or restart the server through the tunnel', async () => {
  const { phone, loopbackHits } = await relayRig();
  for (const [m, p] of [['POST', '/api/cloud/pair/p1/approve'], ['POST', '/api/restart'], ['POST', '/api/setup/finish']] as const) {
    const r = await phone.http(m, p);
    expect(r.status).toBe(403); expect((await r.json()).code).toBe('mac_confirm_required');
  }
  expect(loopbackHits()).toEqual([]);
});

// cloud/test/security.test.ts
it('every route is 404 on the other origin', async () => {
  for (const r of ROUTES) expect((await call(r.path, { method: r.method }, r.side === 'app' ? RELAY : APP)).status, r.path).toBe(404);
});
it('relay origin never sets a cookie and allows no third-party origin', async () => { /* RELAY_ROUTES 전부 */ });
```

- [ ] **Step 2: 실패 확인** — 새 테스트가 FAIL 하는지 본다(이미 통과하는 검사는 그 검사를 일부러 끈 상태에서 한 번 FAIL 을 본 뒤 되돌린다).
- [ ] **Step 3: 구현** — 테스트가 드러낸 빈틈을 고친다. 문서 세 개를 쓴다.
- [ ] **Step 4: 통과 확인** — 공통 검증 명령 다섯 개와 cloud 검증 세 개를 돌린다. `bash scripts/smoke/relay-e2e.sh` 를 한 번 더 돌린다.
- [ ] **Step 5: 커밋** — `docs(cloud): 보안 모델(운영자 신뢰 범위 포함)·데이터 목록·배포 절차, 로컬 방어 회귀·출처 분리·장애 테스트, 위생 규칙`

---

## 출시 뒤

출시 1차에서 미룬 Task 다. 지우지 않고 여기에 둔다. 번호는 원래 번호를 유지하고(6·8), 옛 Task 7·11 에서 떼어 낸 부분은 13·14 로 새로 붙였다. 꺼내는 순서는 6(필요할 때만) → 13 → 8, 14 는 아무 때나다. 꺼낼 때마다 출시 1차 Task 와 같은 형식의 검토를 다시 받는다.

### Task 6: 클라우드 경유 웹 푸시 (출시 뒤)

> **출시 뒤.** 출시 1차의 폰 알림은 Task 5b 대로 Mac 이 자기 VAPID 키로 직접 보낸다(권장 2). 이 Task 는 iOS 실기에서 릴레이 출처 PWA 가 Mac VAPID 키로 구독·수신하지 못할 때만 꺼낸다. 꺼낼 때 마이그레이션 이름은 `0005_push.sql` 이다(0003·0004 는 Task 9·12 가 쓴다). 체험·Pro 확인은 Task 2·7 의 `entitledState` 를 그대로 쓴다.

**Files:**
- Create: `cloud/src/push/vapid.ts`, `cloud/src/push/send.ts`, `cloud/migrations/0005_push.sql`, `cloud/scripts/gen-vapid.mjs`, `src/server/cloud/pushRelay.ts`
- Modify: `cloud/src/index.ts`, `cloud/src/env.ts`(`VAPID_PUBLIC`, `VAPID_PRIVATE_JWK`, `VAPID_SUBJECT`), `src/server/push/SubscriptionStore.ts`, `src/server/push/PushNotifier.ts`, `src/server/http.ts`, `src/server/server.ts`, `src/server/cloud/CloudService.ts`(VAPID 공개키 캐시), `src/ui/push.ts`
- Test: `cloud/test/push.test.ts`, `src/server/cloud/pushRelay.test.ts`, `src/server/push/PushNotifier.test.ts`(추가), `src/server/push/SubscriptionStore.test.ts`(추가), `src/server/http.test.ts`(추가), `src/ui/push.test.ts`(있으면 추가, 없으면 생성)

**Interfaces:**
- `0005_push.sql`: `CREATE TABLE push_endpoints (host_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (host_id, endpoint_hash));`
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

### Task 8: 로컬 Pro 기능 게이트 — 오픈코어 경계 (출시 뒤)

> **출시 뒤.** 출시 1차에는 로컬 기능을 잠그지 않는다(출시 범위 절). 이 Task 를 꺼내기 전에 ① 출시 점검의 "Pro 문구는 릴레이·푸시만" 과 L8, ② 법률 검토 결과, ③ Task 13(서명 entitlement·`ProGate`)이 끝났는지를 다시 확인하고, 사용자가 게이트할 기능을 새로 고른다. **같은 벤더 여러 계정 순환(`accounts`)과 리셋 승격(`routeFull`)은 다시 꺼내도 게이트에 넣지 않는다**(필수 6 — 한도 회피를 파는 모양). 옛 D7(총사령탑 = Pro)의 근거는 철회했고, 꺼낼 때 새로 판단한다.

**Files:**
- Modify:
  - 서버: `src/server/server.ts`(`:303-311` BottleneckWatch, `:337` Commander), `src/server/push/BottleneckWatch.ts`(`allow?`), `src/server/ws.ts`(`msg.handoff`·`retryDue`·commander 문구)
  - 공유: `src/shared/protocol.ts`(`error.code` 에 `'pro_required'` 설명, `feature?`)
  - UI: `src/ui/components/Pane.tsx`(`:120-122`), `src/ui/components/ContextGauge.tsx`(ContextHint), `src/ui/components/SettingsView.tsx`(총사령탑 토글 잠금 표시)
  - 문서: `docs/protocol.md`(`pro_required`)
- Test: `src/server/push/BottleneckWatch.test.ts`(추가), `src/server/ws.pro.test.ts`(추가), `src/ui/components/ContextGauge.test.tsx`(추가)

**Interfaces:**

| ProFeature(후보) | 게이트 지점 | Community 동작 |
|---|---|---|
| `handoff` | `ws.ts` 의 `send` 처리에서 `msg.handoff === true && !pro.has('handoff')` → `pro_required`. UI `Pane.tsx:120` 은 보내기 전에 `proHas('handoff')` 확인 | ContextHint 는 "새 세션으로 이어가기: 요약을 복사해 새 세션에 붙여 넣으세요" 안내 + "Pro 로 한 번에" 링크(설정 › 계정) |
| `bottleneck` | `BottleneckWatch` `allow('renotify')` | 첫 푸시만, 재알림 없음 |
| `autoRetry` | `BottleneckWatch` `allow('retry')`, `ws.ts` 의 `retryDue` | 리셋 시각 자동 재시도 없음(실패 카드에 "다시 보내기" 그대로) |
| `commander` | `server.ts:337` `enabled: () => settings.get().commanderEnabled === true && pro.has('commander')` | 총사령탑 꺼짐. 설정 토글은 잠금 표시 |

- 게이트에 넣지 않는 것: 다계정·계정 순환·홈 이외 계정 고정·Gemini `g2`·자동 분배 후보 수·리셋 승격. 이것들은 Community 와 Pro 가 똑같다.
- `BottleneckWatch` 생성자 옵션: `allow?: (what: 'renotify' | 'retry') => boolean`(기본 항상 true).
- `ws.ts` 거절 문구: "Pro 기능입니다 — 설정 › 계정에서 체험을 시작하거나 구독하세요" 형태로, `code: 'pro_required'` 와 `feature` 이름을 싣는다. `error` 메시지에 선택 필드 `feature?: ProFeature` 를 더한다. UI 는 이 코드면 토스트에 [설정 열기] 를 붙인다.

- [ ] **Step 1: 범위 재확인** — 위 인용의 ①②③ 을 확인하고 사용자에게 게이트할 기능 목록을 받는다. 표에서 빠진 기능의 행·테스트는 지운다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// src/server/push/BottleneckWatch.test.ts (추가)
it('allow(renotify)=false: no reminder pushes; allow(retry)=false: booked retry not fired', () => { /* … */ });

// src/server/ws.pro.test.ts (추가) — ProGate({ enforce: true }) community
it('send with handoff → error pro_required (feature handoff), no turn started', async () => { /* … */ });
it('commander_set while community → commander_disabled', async () => { /* … */ });
it('account rotation and pinning work the same on community and pro', async () => { /* 게이트 없음 고정 */ });
it('same flows succeed with a trial claim', async () => { /* … */ });
it('enforce=false (PRO_ENFORCE default): nothing is refused', async () => { /* … */ });

// src/ui/components/ContextGauge.test.tsx (추가)
it('community: hint shows guidance and a Pro link instead of the one-click button', () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — 해당 테스트들이 FAIL 하는지 본다.
- [ ] **Step 4: 구현** — 표대로 만든다. 게이트는 모두 `ProGate.has` 하나를 거친다. 호출 지점에서 `PRO_ENFORCE` 를 직접 보지 않는다.
- [ ] **Step 5: 통과 확인** — 공통 검증 명령 다섯 개를 돌린다. 기존 라우팅·병목·총사령탑 테스트가 무변경으로 통과해야 한다(enforce 기본값 false).
- [ ] **Step 6: 커밋** — `feat(pro): 오픈코어 경계 — 원클릭 인계·병목 재알림·자동 재시도·총사령탑을 ProGate 로(계정 순환·자동 분배는 게이트 없음)`

---

### Task 13: entitlement 서명·로컬 검증·`ProGate`·출시 스위치 (출시 뒤)

> **출시 뒤.** Task 7 의 표시용 응답에서 떼어 낸 부분이다. Task 8 을 꺼낼 때만 필요하다(로컬 게이트가 없으면 서명·오프라인 유예가 지킬 것이 없다). 릴레이 허용은 계속 클라우드가 정한다.

**Files:**
- Create: `cloud/scripts/gen-entitlement-key.mjs`, `src/shared/pro.ts`, `src/server/cloud/Entitlement.ts`, `src/server/cloud/entitlement-keys.json`, `src/server/pro/features.ts`, `src/server/pro/gate.ts`, `src/server/pro/release.test.ts`, `src/ui/pro.ts`
- Modify: `cloud/src/entitlement.ts`(`GET /v1/entitlement/signed`), `cloud/src/env.ts`(`ENTITLEMENT_SIGNING_JWK`, `ENTITLEMENT_KID`), `src/server/cloud/CloudService.ts`, `src/server/server.ts`, `src/server/http.ts`(`status.pro`), `src/server/ws.ts`(`hello.pro`, `settings.pro`), `src/shared/protocol.ts`(`FEATURES` 에 `'pro'`, `hello.pro?`, `settings.pro?`), `docs/protocol.md`(`pro` 행), `src/ui/components/CloudSection.tsx`(오프라인 유예 문구)
- Test: `cloud/test/entitlement.signed.test.ts`, `src/server/cloud/Entitlement.test.ts`, `src/server/pro/gate.test.ts`, `src/server/ws.pro.test.ts`

**Interfaces:**
- `[app] GET /v1/entitlement/signed`(host Bearer) → `{ jws, claims }`.
  - 클레임: `{ hid, plan, st, until: untilMs/1000, iat, exp }`. `exp = min(until, iat + 7일)`(`plan: 'none'` 이면 `exp = iat`). `plan: 'none'` 이어도 서명한 토큰을 준다(로컬이 "만료됨" 을 확정할 수 있게).
  - 개인키는 `importKey('jwk', ENTITLEMENT_SIGNING_JWK, {name:'Ed25519'}, false, ['sign'])` 로 읽는다. Workers 에서 Ed25519 를 `jwk` 형식으로 가져오는지는 **(미확인)** 이라 Step 1 에서 확인한다. 안 되면 `pkcs8` 로 하고 `gen-entitlement-key.mjs` 출력도 그에 맞춘다.
- `gen-entitlement-key.mjs --kid <kid> --out <저장소 밖 경로>`: 공개 JWK 를 `{kid, jwk}` JSON 으로 stdout 에 쓰고, 개인 JWK 는 파일(0600)에 쓴다. 출력 경로가 저장소 안이면 거부한다.
- `entitlement-keys.json`: `{ "keys": { "<kid>": { "kty": "OKP", "crv": "Ed25519", "x": "…" } } }`. 처음에는 `{ "keys": {} }` 로 커밋한다(어떤 토큰도 통과하지 못함 → Community). 실제 키는 사용자가 넣는다.
- `src/shared/pro.ts`:
  - `PRO_FEATURES` 는 Task 8 Step 1 에서 사용자가 고른 목록이다(후보 `'handoff' | 'bottleneck' | 'autoRetry' | 'commander'`, `accounts`·`routeFull` 은 넣지 않는다). `type ProFeature = typeof PRO_FEATURES[number]`
  - `type ProStatus = { tier: 'community' | 'trial' | 'pro'; until: string | null; offlineUntil: string | null; features: ProFeature[]; reason: 'not_linked' | 'no_plan' | 'expired' | 'verify_failed' | null }`
- `features.ts`: `export const PRO_ENFORCE = false` — 출시 스위치. Step 6 에서만 `true`.
- `gate.ts`: `class ProGate`
  - 생성자: `constructor(o: { enforce?: boolean /* 기본 PRO_ENFORCE */; now?: () => number })`
  - 메서드: `set(claims: EntitlementClaims | null, reason: ProStatus['reason']): void; status(): ProStatus; has(f: ProFeature): boolean; onChange(cb): () => void`
  - `has` 는 `!enforce || (claims && now < exp && plan !== 'none')` 다. 진행 중인 턴은 호출 지점이 판단 시점에만 `has` 를 묻기 때문에 영향받지 않는다.
- `Entitlement.ts`: `class EntitlementManager`
  - 생성자: `constructor(o: { api: CloudApi; state: CloudState; gate: ProGate; keys?: Record<string, JsonWebKey>; hostId: () => string | null; now?; setTimer? })`
  - 메서드: `start()`(저장된 토큰 검증 → `gate.set` → 연결돼 있으면 즉시 갱신 → 24시간 ±1시간마다), `refresh(): Promise<ProStatus>`, `stop()`
  - 갱신 실패(네트워크·5xx)면 저장된 토큰을 유지한다(7일 오프라인 유예 = `exp`). 서명 검증에 실패한 새 토큰은 버린다.
- protocol·ws: `hello.pro?: ProStatus` 는 `FEATURES` 에 `'pro'` 가 있을 때 싣는다. `ProGate.onChange` 가 불리면 기존 `settings` 방송에 `pro` 필드를 함께 싣는다. 새 메시지 종류는 없다.
- `ui/pro.ts`: `proHas(f: ProFeature, s: { features: Features; pro?: ProStatus }): boolean` — `!has('pro')` 면 `true`(옛 서버 = 게이트 없음).
- `CloudSection.tsx` 요금제 행에 "오프라인 — <날짜>까지 Pro 유지" 를 더한다.
- `release.test.ts`: `expect(PRO_ENFORCE).toBe(true)` 와 `Object.keys(entitlementKeys.keys).length >= 1`. Step 6 에서 함께 커밋한다.

- [ ] **Step 1: 확인** — Workers 의 Ed25519 `importKey` 형식(`jwk`/`pkcs8`)을 테스트 하나로 확인하고 `cloud/README.md` 에 적는다.
- [ ] **Step 2: 실패하는 테스트 작성**

```ts
// cloud/test/entitlement.signed.test.ts — 실행 중 생성한 키를 env 에 넣는 helper(withSigningKey)
it('trial user gets a signed trial token whose exp ≤ trial end', async () => { /* verifyEntitlement(공유 모듈)로 검증 */ });
it('no plan → signed none token with exp = iat', async () => { /* … */ });
it('token is bound to the calling host (hid)', async () => { /* … */ });

// src/server/cloud/Entitlement.test.ts — 실행 중 생성한 키를 keys 로 주입
it('online: refresh stores and opens Pro', async () => { /* gate.status().tier === 'pro' */ });
it('offline within exp keeps Pro (offlineUntil set); past exp drops to community/expired', async () => { /* now 주입 */ });
it('a token signed by an unknown key is ignored and not stored', async () => { /* … */ });
it('empty entitlement-keys.json → nothing verifies', async () => { /* 실제 파일 import → keys {} */ });

// src/server/pro/gate.test.ts
it('enforce=false: has() is always true but status() still reports the tier', () => { /* … */ });
it('enforce=true: community has nothing; trial/pro have every feature', () => { /* … */ });

// src/server/ws.pro.test.ts
it('hello carries pro; a gate change rides on the settings broadcast', async () => { /* … */ });
```

- [ ] **Step 3: 실패 확인** — 위 테스트 파일들이 FAIL 하는지 본다.
- [ ] **Step 4: 구현 → 통과 확인** — 위대로 만들고 cloud 검증 세 개와 공통 검증 명령을 돌린다.
- [ ] **Step 5: 커밋** — `feat(pro): Ed25519 entitlement 발급·로컬 검증·24시간 갱신·7일 오프라인 유예, ProGate(출시 스위치 꺼짐), hello/settings.pro`
- [ ] **Step 6: 출시 스위치(사용자 확인 뒤)** — 아래 셋이 모두 참일 때만 진행하고, 아니면 멈추고 보고한다. 그다음 `PRO_ENFORCE = true` 로 바꾸고 `release.test.ts` 를 추가해 공통 검증 명령을 돌린 뒤 `feat(pro): 출시 스위치 — Pro 게이트 적용 시작` 으로 커밋한다. 실행 중인 서버에 반영되는 것은 사용자의 재시작 지시 때다.
  - ① `entitlement-keys.json` 에 사용자가 생성한 공개키가 있다.
  - ② 그 키에 맞는 개인키가 클라우드 비밀로 배포됐다.
  - ③ 이 Mac 소유자 계정에 comp 부여가 끝났다는 사용자 확인이 있다.

---

### Task 14: 릴레이 부하 스크립트 (출시 뒤)

> **출시 뒤.** 출시 판단에는 Task 3 의 "상주 타이머 없음" 코드 검사로 충분하다. 배포본 비용 실측(사용자 몫)과 함께 한다.

**Files:**
- Create: `cloud/scripts/load-relay.mjs`

**Interfaces:**
- `load-relay.mjs --hosts 50 --devices 2 --rate 5 --seconds 60 --url http://127.0.0.1:<port>` — `wrangler dev --local` 대상이다. 가짜 호스트·기기는 공유 `noise.ts` 로 실제 핸드셰이크를 한다. 지연 p50/p95, 끊김 수, DO 별 메시지 수를 출력한다. `--url` 이 `127.0.0.1`·`localhost` 가 아니면 거부한다(배포본 부하는 사용자가 따로 판단).

- [ ] **Step 1: 작성** — 위대로 만든다. `DEV_ROUTES=1` 로컬 클라우드에서 계정·호스트·페어링을 자동으로 만든다(Task 5c 스모크의 helper 재사용).
- [ ] **Step 2: 로컬 실행** — `--hosts 50 --devices 2 --seconds 60` 을 돌리고 결과 한 줄을 커밋 메시지 본문에 적는다.
- [ ] **Step 3: 커밋** — `chore(cloud): 로컬 릴레이 부하 스크립트`

---

## 결정 지점

| # | 질문 | 추천 | 대안 | 추천 이유 |
|---|---|---|---|---|
| D1 | 릴레이를 종단간 암호화하나, 무엇을 약속하나 | **한다(필수).** 클라우드는 봉투 머리와 암호문만 본다. 단 문구는 "정직한 운영자 가정" 을 함께 적는다 — 폰 UI 코드를 클라우드가 내보내므로 운영자·배포 권한 탈취자는 악성 UI 로 기기 키를 쓸 수 있다(보안 모델과 한계 절) | TLS 종단까지만 암호화(클라우드가 평문 중계) | 스펙 §5.3·§6 이 "암호문만" 을 요구한다. 수동적 클라우드 침해(DB·로그·DO 메모리 유출)에는 평문이 없다. 능동적 운영자 공격은 막지 못하므로 랜딩 `relayCiphertext` 문구와 `docs/security-model.md` 에 한계를 같이 적고, Mac 확인이 필요한 동작은 폰에서 막아 피해 범위를 줄인다(D19) |
| D2 | DO 단위 | **호스트(Mac)당 1개**(`idFromName(hostId)`) | 스펙대로 사용자당 1개 | 한 사용자가 Mac 을 둘 연결하면 사용자당 DO 는 호스트 구분 라우팅과 호스트별 교체(4409) 규칙을 따로 짜야 한다. 호스트당 DO 는 격리·장애 범위·이용권 alarm 이 단순하다. Hibernation 이라 DO 수가 늘어도 유휴 비용은 거의 없다고 본다(비용 실측은 사용자 몫). **스펙과 다르므로 스펙 §5.3 을 갱신할 것** |
| D3 | 키 교환·전송 암호 | **Noise KK(`Noise_KK_25519_AESGCM_SHA256`)**, prologue 에 프로토콜 버전·기기 id·호스트 id. 검증된 구현이 있으면 쓰고, 없으면 사양 그대로 얇게 구현한다. 어느 쪽이든 공식 테스트 벡터 통과가 합격 조건이다. 후보 라이브러리와 벡터 출처는 착수 시 확인(Task 1 Step 1) | 자작 ECDH 4항 조합(옛 추천) / MLS 류 | 옛 근거("세 런타임 공통이라 P-256")는 틀렸다 — Worker 는 봉투만 넘기고 복호화하지 않으므로 암호는 Node 와 브라우저 두 곳만 필요하다. 자작 조합은 전사 바인딩이 빠지기 쉽다(검토 필수 4). X25519 는 WebCrypto 를 먼저 쓰고, 지원하지 않는 런타임(iOS Safari 포함 여부는 착수 시 확인)이면 `@noble/curves`(착수 시 확인)로 대신한다. 루트 런타임 의존성이 최대 하나 늘 수 있어 **사용자 승인**이 필요하다 |
| D4 | 폰 UI 를 어떻게 내보내나 | **relay 출처에서 R2 버전별(`/v/<ver>/`) 영구 보관 + 루트 부트스트랩**. 폰은 Mac 의 `ready`(Noise 로 인증된 `hostVersion`)를 검증한 뒤에만 그 버전으로 옮긴다 | 최신 UI 하나만 + 프로토콜 호환 범위 / Mac 이 터널로 UI 를 서빙(SW 가 가로챔) | 사용자마다 Mac 버전이 달라 버전을 맞춰야 지금의 `has()` 규칙으로 충분하다. Workers 정적 자산은 배포 때 옛 파일을 지우므로 버전별 보관은 R2 가 맞다. 신뢰 한계: 이 방식은 클라우드가 UI 코드를 고를 수 있다는 뜻이라 D1 의 한계와 같다. 재현 가능 빌드 해시 공개·Mac 서빙은 범위 밖(출시 뒤 검토) |
| D5 | Mac 쪽 "두 번째 벽" | **Mac 로컬 신뢰 목록 + 페어링 때 확인 코드 대조와 Mac [허용]**. 루프백 토큰 쿠키는 Mac 의 `RelayBridge` 가 붙이고, 폰은 로그인 토큰을 모른다 | 스펙 문구대로 폰이 기존 로그인 토큰을 한 번 입력 / MAC 만 맞으면 자동 확정(옛 추천) | 클라우드가 뚫려도 Mac 이 모르는 키로는 핸드셰이크가 안 된다. QR 을 엿본 사람이 먼저 claim 해도 Mac 화면의 확인 코드와 [허용] 을 넘을 수 없고, 같은 페어링에 claim 이 두 번 오면 폐기(`burned`)한다(검토 필수 3). 토큰을 폰에 두면 클라우드 출처 XSS 에 토큰까지 노출된다. 스펙 §5.3 갱신 |
| D6 | 로컬 Pro 게이트 | **출시 1차에는 없다.** Pro 이용권은 클라우드가 릴레이·티켓에서 직접 확인하고, 로컬은 표시만 한다(Task 7). 로컬 게이트(`ProGate`·서명 entitlement·출시 스위치)는 출시 뒤 Task 13·8 | 출시 1차에 `ProGate` + `PRO_ENFORCE` / 비공개 `@ai-msg/pro` 모듈 | 확정 범위가 "Pro 는 릴레이·푸시만" 이다. 게이트가 없으면 서명 키·오프라인 유예·comp 부여 전 끊김 위험이 모두 사라진다. 나중에 필요하면 Task 13 의 `ProGate.has` 하나가 끼울 자리다 |
| D7 | 총사령탑의 티어 | **철회 — 출시 1차에는 모두에게 같다.** Task 8 을 꺼낼 때 새로 판단한다 | Pro(옛 추천) | 옛 근거("엔진 사용량을 많이 쓰는 무인 자동화라 유료")는 "한도를 더 쓰게 해 주는 기능을 판다" 로 읽힐 수 있어 L8·"릴레이·푸시만" 과 맞지 않는다 |
| D8 | 7일 체험을 누가 관리하나 | **클라우드 자체 `trials` 행 — 첫 호스트 연결 때 자동 시작, 정규화 이메일 해시(`email_key`)당 1회, IP 당 생성 제한, 카드 없음.** 계정을 삭제해도 `trial_claims` 의 `email_key` 는 남긴다 | Paddle 구독 체험(카드 필요) / [체험 시작] 버튼으로 명시 시작 | Paddle 의 카드 없는 체험은 Checkout 에서 쓸 수 없다(확인). 연결이 곧 릴레이를 쓰려는 의사라 자동 시작이 마찰이 가장 적다. `+태그`·Gmail 점 정규화와 IP 제한으로 쉬운 남용을 줄이고(권장 3), 삭제 후 재가입 체험은 해시 보존으로 막는다(검토 필수 9). 해시 보존은 개인정보처리방침에 적는다 |
| D9 | 매직링크 메일 제공자 | **Resend**(HTTP API 하나, `EmailSender` 뒤) | Postmark / Cloudflare Email 기능 / AWS SES | Workers 에서 `fetch` 한 번이면 되고, 도메인 인증(SPF/DKIM)만 하면 된다. API 형태는 미확인이라 Task 2 Step 1 에서 확인한다. 인터페이스 뒤에 있어 바꾸기 쉽다 |
| D10 | QR 생성 | **`qrcode-generator`(UI devDependency, 번들에 포함)** | 자체 QR 인코더 | QR 인코딩(리드-솔로몬·마스크)은 직접 짜면 버그가 나기 쉽다. 런타임 의존성이 아니라 UI 번들에 들어가는 devDependency 다. 라이선스는 설치 때 확인한다 |
| D11 | `cloud/` 를 공개하나 | **비공개(공개본 export 에서 뺀다)** — 출시 점검 확정 D1("Apache-2.0 코어 + 클라우드 비공개")을 따른다 | 공개(옛 추천) | 사용자 확정 사항이다. 옛 근거("서버 공개 = E2EE 근거")는 폰 UI 를 클라우드가 내보내는 구조에서 약하다(D1 한계). 대신 프로토콜 문서·보안 모델·공식 벡터 통과 테스트는 공개 코어(`src/shared/relay/*`, `docs/`)에 있다 |
| D12 | 폰 알림 경로 | **Mac 이 자기 VAPID 키로 푸시 서비스에 직접 보낸다**(기존 `PushNotifier`). 폰은 relay 출처 SW 로 Mac 공개키를 써서 구독하고 구독은 터널로 Mac 에 저장된다 | 클라우드 VAPID 대행(옛 추천, 출시 뒤 Task 6) / 릴레이 WS 로 발송 요청 | 클라우드가 푸시 경로에 아예 없다. 새 클라우드 코드·키·SSRF 검사가 필요 없다(권장 2). iOS 홈 화면 PWA 에서 이 방식이 되는지는 실기 확인(사용자 몫)이고, 안 되면 Task 6 을 꺼낸다 |
| D13 | Community "벤더당 1계정" 을 어디서 막나 | **철회 — 이 계획에서 막지 않는다.** 같은 벤더 계정 순환은 출시 점검 확정대로 "설정에서 직접 켜기" 이고 요금제와 무관하다 | 실행 시점 차단(옛 추천) | 다계정 순환을 유료 게이트로 두면 한도 회피를 파는 모양이 된다(검토 필수 6, L8) |
| D14 | 웹훅 처리 시점·실패 | **동기 처리 후 200.** 적용 문장은 전부 upsert 이고 `paddle_events` 기록과 한 batch 다. 업무 충돌(고객 충돌·두 번째 구독·알 수 없는 사용자 참조·결정적 형식 오류)은 200 + `outcome` 기록 + `ops_alerts`. D1 장애만 500 → Paddle 재시도 | 200 먼저 + `waitUntil` / 모든 오류 500(옛 추천) | 결정적 오류에 500 을 주면 약 2일 60회 재시도 뒤 이벤트를 잃는다(검토 필수 8). upsert 와 `occurred_at` 비교로 재전송·순서 뒤바뀜에도 같은 결과가 된다. `customData` 는 브라우저 값이라 서버가 서명한 `userRef` 만 믿는다 |
| D15 | 환불·결제 실패 | **`past_due` 는 그 이벤트의 `occurred_at` + 7일까지 유지. 전액 환불·차지백이면 Paddle API 로 구독을 즉시 해지(실패하면 알림 + 정리 cron 이 재시도). 부분 환불은 기록만** | `period_end + 7일`(옛 추천) / 환불은 항상 기록만 | `period_end` 기준이면 결제 실패 시각과 무관하게 유예가 들쭉날쭉하다(권장 5). 전액 환불 뒤 구독이 살아 있으면 다음 결제가 다시 일어난다(권장 4). API 경로와 조정 필드는 Task 9 Step 1 에서 확인한다 |
| D16 | 클라우드 주소·환경 변수 이름 | **app `https://app.aimsg.app`, relay `https://relay.aimsg.app`(도메인 확보 뒤 확정), `DECK_CLOUD_URL`·`DECK_RELAY_URL`·`DECK_CLOUD`(리네임이 접두사를 바꾸면 따라감)** | 랜딩과 같은 호스트(`aimsg.app`) | 랜딩(정적)·앱(쿠키·결제)·릴레이(폰 UI·기기 키)를 서브도메인으로 나누면 쿠키·CSP·스크립트가 섞이지 않는다. 바뀌면 상수와 `wrangler.jsonc` 의 `PUBLIC_ORIGIN`·`RELAY_ORIGIN` 만 고친다 |
| D17 | 사용자당 Mac 수 | **3대(`MAX_HOSTS`)**, 기기 3대(스펙)와 별도 | 무제한 / 1대 | 개인 개발자 기준으로 집·회사·서버 정도면 충분하다. 계정 공유 남용을 막는다. 변수라서 바꾸기 쉽다 |
| D18 | 출처를 나누나 | **둘로 나눈다 — app(로그인·계정·결제·법적 페이지, 쿠키·Paddle.js)과 relay(폰 UI·폰 API·릴레이 WS, 쿠키 없음·제3자 스크립트 없음).** Worker 하나가 `Host` 로 나누고 반대쪽 출처 요청은 404 | 한 출처(옛 구조) / Worker 두 개 | 같은 출처면 Paddle.js 같은 제3자 스크립트나 계정 페이지 XSS 가 폰 UI 의 IndexedDB 기기 키에 닿는다(검토 필수 2). Worker 하나면 D1·DO 바인딩과 배포가 하나로 유지된다 |
| D19 | 폰에서 Mac 확인이 필요한 동작(재시작·설정 마법사·로그인·클라우드 연결 해제·권한 모드 상향) | **출시 1차는 폰에서 거절(`mac_confirm_required`)하고 Mac 앞에서 하게 한다** | "폰 요청 → Mac 에 [허용] 대화상자"(출시 뒤) | 악성 UI(D1 한계)나 훔친 폰이 Mac 을 원격으로 재설정·권한 상향하는 길을 막는다(검토 필수 1). 대화상자는 Mac 앞에 사람이 있어야 의미가 있어 원격 사용 이점이 작고, 만들면 UI·프로토콜 일이 커진다 |
| D20 | 홈 화면 PWA 안 [스캔] 에 JS QR 디코더를 들이나 | **들이지 않는다.** `BarcodeDetector` 가 있을 때만 [스캔] 을 보이고, 없으면 페어링 코드 붙여 넣기만 둔다 | JS QR 디코더(이름·라이선스는 착수 시 확인)를 relay UI 번들에 넣기 | Mac 에서 [복사] 한 코드를 iPhone 에 붙여 넣는 경로(같은 Apple 계정의 공유 클립보드)로 같은 일을 할 수 있고, 번들·의존성·검토 범위가 늘지 않는다. Task 5 앞 실기 확인에서 붙여 넣기가 불편하다고 나오면 의존성 승인과 함께 다시 정한다 |

## 사용자 몫 (이 계획의 작업이 아님)

- **결정:** D3 루트 런타임 의존성 추가 승인(Noise 구현 또는 `@noble/curves` 중 Task 1 Step 1 이 고른 것 하나), D19 확인, D20(실기 확인 결과에 따라).
- **5a 착수 전 iOS 실기 확인(2차 필수 2):** "Task 5 앞 실기 확인" 의 탐침을 HTTPS 정적 호스팅에 올리고 iPhone 에서 Safari ↔ 홈 화면 앱 저장소 공유 여부, `persist()`, 카메라, `BarcodeDetector`, `PushManager` 를 확인해 결과 표를 넘긴다.
- **Paddle**
  - 판매자 가입·KYC(한국 개인/개인사업자), USD 수취 계좌·정산 비용 확인(스펙 §5.4).
  - 상품 "AI msg Pro" 와 가격 둘(월 $15, 연 $150), 창립 고객 할인 코드(연 $120 상당).
  - 샌드박스·라이브 각각 알림 대상(웹훅 주소 `https://app.aimsg.app/v1/paddle/webhook`, 구독·거래·조정 이벤트 선택)을 만들고, 그 비밀을 `wrangler secret put PADDLE_WEBHOOK_SECRET` 로 넣는다.
  - API 키는 `PADDLE_API_KEY` 로 넣는다. 권한은 고객 포털 세션 생성과 **구독 해지**(전액 환불·차지백 자동 해지, D15) 둘이다. 권한 이름은 Task 9·10 Step 1 에서 확인한 것을 `cloud/README.md` 에 적는다. client-side token 과 가격 id 는 `wrangler.jsonc` vars 로 넣는다.
  - 승인 도메인에 **app 출처만** 넣는다(relay 출처는 넣지 않는다). 그 밖의 Paddle.js 체크아웃 요구사항은 Task 10 Step 1 에서 확인한다.
- **Cloudflare**
  - 계정과 플랜(DO 사용 가능 여부는 플랜별로 확인), 도메인 `aimsg.app`(후보) 확보, `app.`·`relay.` 두 호스트 이름을 같은 Worker 의 `routes` 로 연결.
  - `wrangler d1 create ai-msg` → `database_id` 기입, `wrangler d1 migrations apply`(0001–0004), R2 버킷 `ai-msg-ui` 생성.
  - 비밀 넣기: `SESSION_SECRET`, `EMAIL_HASH_SECRET`, `CHECKOUT_SECRET`, `RESEND_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_API_KEY`. (`ENTITLEMENT_SIGNING_JWK`·`VAPID_PRIVATE_JWK` 는 출시 1차에 없다 — Task 13·6 을 꺼낼 때만.)
  - `npm --prefix cloud run deploy`(predeploy 가 법적 페이지를 strict 로 빌드하므로 초안 표시나 `{{…}}` 가 남아 있으면 배포가 멈춘다). 이후 릴리스마다 `scripts/release.sh <버전>`(UI 게시 → npm publish → `latest` 갱신, Task 5c).
- **메일:** Resend 가입, 발신 도메인 SPF/DKIM 인증.
- **법적 문서**
  - `docs/legal/{terms,privacy,refund}{,.ko}.md` 의 `{{…}}` 자리(사업자 정보·연락처·관할 등)를 채우고 초안 표시를 지운 뒤 변호사 1회 검토. 특히 `terms.md` §1 의 "추가 기능과 선택형 클라우드 서비스" 문구를 "릴레이·폰 알림" 으로 좁힐지 정한다(출시 점검 "Pro 문구는 릴레이·푸시만").
  - `docs/privacy-data-inventory.md`(Task 11)와 `privacy.md` 가 어긋나는 항목을 Task 11 이 보고하면 바로잡는다. Paddle 판매자 심사가 요구하는 페이지 주소는 `https://app.aimsg.app/legal/*` 다.
- **서면 확인:** Anthropic·OpenAI·xAI 에 구독 로그인한 공식 CLI 를 서브프로세스로 띄우는 것과 원격 승인이 허용되는지 확인한다(스펙 §3 규칙 7, §11).
- **랜딩 문구:** 계획 ③ 의 `relayCiphertext` 등 Pro 문구를 D1 의 정직한 문구("클라우드는 대화를 저장·열람하지 않는다, 폰 UI 는 우리 서버가 내보낸다")와 "릴레이·폰 알림" 범위로 바꾼다.
- **이 Mac 소유자 계정 comp 부여**(`cloud/README.md` 의 SQL). 출시 1차에는 로컬 게이트가 없으므로 릴레이를 쓸 때만 필요하다.
- **실기 확인(출시 전):** iOS Safari(홈 화면 PWA 안에서 코드 붙여 넣기·스캔 페어링, Mac VAPID 직접 푸시 — 안 되면 Task 6 을 꺼낸다, 저장소 삭제 뒤 재페어링)·Android Chrome 에서 QR 페어링(확인 코드 대조·Mac [허용]) → 승인 → 푸시. 실제 결제 1건(샌드박스 → 라이브), 전액 환불 1건(자동 해지 확인).
- **운영:** `ops_alerts` 를 보는 방법(주기적 D1 조회 또는 알림 연결)을 정하고, 배포본 DO 비용 실측(스펙 §11)과 외부 1인 보안 리뷰(스펙 §7, Task 1 의 Noise 구현 우선).

## 범위 밖

- Team(공유 계정 풀·관리자), 메터드 크레딧 폴백(스펙 §4 두 번째 수익원).
- 유휴 할당량 작업·교차 검증 버튼(출시 뒤), 무인 자동 인계(v1.1).
- 폰 하나로 여러 Mac 을 오가는 화면. v1 은 기기 하나가 Mac 하나에 페어링한다. 다른 Mac 은 새 기기 등록으로 처리한다.
- 네이티브 모바일 앱, Windows 호스트.
- Polar 등 대체 판매 대행 구현(Paddle 심사 실패 시 별도 계획).
- 키 자동 교체(`kid` 목록 구조만 준비, Task 13·6 을 꺼낼 때).
- i18n·랜딩·설치 문서 — 계획 ③. 이 계획은 결제 고정 주소(`/checkout?plan=…`)와 법적 페이지 주소만 제공한다.
- 앱(로컬 UI) 안의 비제휴 고지(L10 의 "설정 › 정보") — 계획 ③·브랜드 정리 쪽. 이 계획은 app 출처 페이지(계정·결제·법적 페이지) 바닥글과 `/legal/notice` 만 맡는다.
- 비공개 Pro 모듈(D6 대안).
- 릴레이 모드 앱 잠금(WebAuthn, 권장 7 의 앞부분) — 보류. iOS 홈 화면 PWA 의 WebAuthn 동작을 실기로 확인해야 하고, 악성 운영자 JS(D1 한계)는 잠금 화면 뒤에서도 기기 키를 쓸 수 있어 막는 범위가 "폰을 잠깐 빌린 사람" 으로 좁다. 출시 뒤 실기 확인 후 다시 판단한다.
- 폰 UI 재현 가능 빌드 해시 공개, Mac 이 UI 를 직접 서빙하는 방식(D4 대안).
- 폰 요청을 Mac 에서 [허용] 하는 대화상자(D19 대안).

## 근거·미확인

**공식 문서로 확인한 것 (2026-10-22)**
- Cloudflare Durable Objects WebSocket Hibernation 의 메서드와 한도:
  - 메서드: `ctx.acceptWebSocket(ws, tags?)`(태그 10개·각 256자), `ctx.getWebSockets(tag?)`, `ctx.getTags(ws)`, `webSocketMessage(ws, message)`, `webSocketClose(ws, code, reason, wasClean)`, `ws.serializeAttachment`/`deserializeAttachment`(16,384바이트), `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(req, res))`(요청·응답 각 2,048자), `setHibernatableWebSocketEventTimeout`(최대 7일).
  - 한도·플래그: DO 하나당 WebSocket 32,768개. 호환성 플래그 `web_socket_auto_reply_to_close`(호환 날짜 2026-04-07 이상에서 기본).
- `@cloudflare/vitest-plugin`:
  - 설정: `cloudflareTest({ wrangler: { configPath } })`, vitest `^4.1` 이상.
  - import: `env`·`exports` 는 `cloudflare:workers` 에서, `runInDurableObject`·`runDurableObjectAlarm`·`listDurableObjectIds`·`applyD1Migrations`·`evictDurableObject` 는 `cloudflare:test` 에서 가져온다.
- Workers WebCrypto: Ed25519 sign/verify/generate, ECDH, HKDF, AES-GCM, HMAC, ECDSA 를 지원한다(Ed25519 는 출시 뒤 Task 13 에서만 쓴다).
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
- Paddle.js `Checkout.open` 의 `customData` 는 웹훅 `custom_data` 로 전달되고, 거래 → 구독 → 이후 거래로 복사된다. 브라우저가 정하는 값이라 서버는 서명된 `userRef` 만 믿는다(Task 9).
- Paddle 카드 없는 체험(`requires_payment_method: false`)은 개발자 미리보기·조기 접근 전용이고 Checkout 에서 쓸 수 없다.
- `web-push` 3.6.7 소스: `generateRequestDetails` 는 `vapidDetails` 가 없으면 `Authorization` 없이 aes128gcm 본문과 머리를 만든다(출시 뒤 Task 6 에서만 쓴다).

**미확인 (해당 Task 첫 단계에서 확인)**

| 항목 | 어디서 쓰나 |
|---|---|
| Noise KK 구현 후보(이름·유지 상태·라이선스·번들 크기)와 공식 테스트 벡터 파일의 출처·형식 — 착수 시 확인 | Task 1 Step 1, D3 |
| WebCrypto X25519 지원(Node 22, iOS Safari·Android Chrome 최신), 없을 때 `@noble/curves` 의 API·라이선스 — 착수 시 확인 | Task 1 Step 1, D3 |
| `webSocketError` 처리기, DO WebSocket 메시지 크기 한도 | Task 3 — 32KiB 조각·1MiB 상한으로 피해 감 |
| wrangler DO 마이그레이션 키(`new_sqlite_classes`/`new_classes`) | Task 3 |
| 테스트 안 클라이언트 WS 획득 형태(`res.webSocket`+`accept()`) | Task 3 |
| `readD1Migrations` 시그니처, `miniflare.bindings` 형태, 플러그인의 vitest 5 지원 여부 | Task 2 — cloud 는 자기 vitest 를 고정 |
| Resend `POST /emails` 형태 | Task 2 |
| R2 바인딩 API 세부(`get` 반환·`httpMetadata`), `env.ASSETS.fetch` 경로 규칙 | Task 5c |
| 기존 UI 의 인라인 `style` 사용 여부(`style-src` 결정) | Task 5c |
| `navigator.storage.persist()` 의 iOS Safari 홈 화면 PWA 동작, 저장소 삭제 조건 | Task 5b(재페어링 흐름), Task 5 앞 실기 확인 |
| iOS 에서 Safari 와 홈 화면 PWA 의 저장소 공유 여부, 홈 화면 PWA 안의 카메라(`getUserMedia`)·`BarcodeDetector` 지원 — 착수 시 확인 | Task 5 앞 실기 확인 → 5a·5b 페어링 화면, D20 |
| 저장소의 기존 릴리스 절차(`package.json` scripts·배포 문서) — 착수 시 확인 | Task 5c `scripts/release.sh` |
| `wrangler dev --persist-to`·`--var`, `wrangler r2 object put` 형태 | Task 5c·11 |
| Paddle 엔터티 필드 경로(`current_billing_period.ends_at`, `scheduled_change.action`, `canceled_at`, `items[].price.id`, `customer_id`) | Task 9 |
| Paddle 조정(adjustment) 의 전액/부분·차지백 구분 필드, 구독 즉시 해지 API(경로·`effective_from`·필요 권한) | Task 9 Step 1, D15 |
| Paddle.js 스크립트 주소·`Initialize`·`Environment.set`·`Checkout.open` 의 `items`/`customer`/`customData`, 결제 완료 이벤트 이름, CSP 출처 | Task 10 |
| 포털 응답 `urls` 하위 키, 샌드박스 API 주소 | Task 10 |
| `cloudflare:test` 의 scheduled 핸들러 helper, `wrangler.jsonc` `triggers.crons` 형태 | Task 12 Step 1 |
| Paddle API 키 접두사(위생 규칙용) | Task 11 |
| Workers Ed25519 `importKey` 의 `jwk` 지원 | 출시 뒤 Task 13 |
| Cloudflare 플랜별 DO 사용 가능 여부와 실제 비용 | 사용자 몫 |

## 검토 반영표

독립 검토(2026-10-25, 판정 "고친 뒤 착수")의 항목별 반영 위치다.

| 검토 항목 | 반영 | 위치 |
|---|---|---|
| 필수 1 — 폰 UI JS 를 클라우드가 서빙(운영자 신뢰), Mac 확인 동작 | 반영 | "보안 모델과 한계" 절(위협 표·정직한 문구), D1·D4·D19, Task 4b `relayPathPolicy`·`relayWsPolicy`(`mac_confirm_required`)와 `pathPolicy.test.ts`, Review Focus 7, 사용자 몫 "랜딩 문구" |
| 필수 2 — 같은 출처 공유 | 반영 | D18, 프로토콜 계약 "두 출처", Task 2 `origins.ts`·`origins.test.ts`, Task 5c `ui.ts`(relay 전용·쿠키 없음·제3자 없음), Task 10(Paddle.js 는 app 출처만), Task 11 `security.test.ts` 출처 행렬 |
| 필수 3 — QR 엿보기 즉시 페어링 | 반영 | 프로토콜 계약 "페어링", Task 1 `confirmCode`, Task 2 두 번째 claim → `burned`·`pending_confirm` 403, Task 5a `PairingView.awaiting_approval` + Mac [허용]/[거부], D5 |
| 필수 4 — 핸드셰이크 전사 미바인딩, 버전 다운그레이드, D3 근거 | 반영 | Task 1 Noise KK(prologue·공식 벡터 합격 조건, 라이브러리 착수 시 확인), 프로토콜 계약 `ready`, Task 5b `RelayConnection`(ready 검증 뒤에만 버전 이동, semver 만), D3 근거 정정 |
| 필수 5 — 로컬 해제가 열린 채널을 안 끊음 | 반영 | Task 4b `CloudService.revokeDevice` → `RelayBridge.dropDevice(id,'revoked')`(Noise 세션·루프백 스트림 즉시 종료)와 클라우드 `revoked` 통지 → 로컬 신뢰 목록 삭제, Task 3 해제 통지, Review Focus 8 |
| 필수 6 — Task 8 범위 어긋남(accounts·routeFull) | 반영 | 출시 범위 표, Task 8 을 "출시 뒤" 로 옮기고 `accounts`·`routeFull` 행·테스트 삭제, D7·D13 철회 |
| 필수 7 — 갱신 때 릴레이 끊김 | 반영 | 프로토콜 계약 이용권 규칙(active = `period_end` + 48시간), Task 2 `entitledState`, Task 3 alarm, Task 4a RelayClient(2차에서 `ent` 제어·최대 5분으로 바뀜)·`recheck()`, Task 7 |
| 필수 8 — 웹훅 멱등·실패·user_id 신뢰 | 반영 | Task 9 전체(`planEvent`, 전부 upsert, 200 + `outcome` + `ops_alerts`, D1 장애만 500, `userRef` 서명), D14 |
| 필수 9 — 법적 페이지·계정 삭제·정리 cron | 반영 | 새 Task 12(`docs/legal/*.md` 빌드·게시, strict 배포 검사, `/v1/account/delete`, `email_key` 보존, `runCleanup` + Cron), D8 |
| 필수 10 — 클라우드 공개 여부 | 반영 | D11 → 비공개, Architecture·Global Constraints(공개본 export 에서 `cloud/` 제외) |
| 권장 1 — 위협 정리, `/api/cloud/*` 회귀 테스트 | 반영 | "보안 모델과 한계" 위협 표, Task 11 `localGuards.test.ts`(Host 421·Origin 403·쿠키 401·SameSite) |
| 권장 2 — Mac VAPID 직접 푸시, Task 6 제외 | 반영 | Task 5b `push.ts`, D12, Task 6 은 "출시 뒤"(iOS 실기 실패 때만) |
| 권장 3 — 이메일 정규화·IP 체험 제한 | 반영 | Task 2 `normalizeEmail`·`email_key`·IP 당 체험 생성 제한, D8 |
| 권장 4 — 전액 환불·차지백 → API 해지 | 반영 | Task 9 `cancel` effect·실패 알림, Task 12 cron 재시도, D15 |
| 권장 5 — past_due 는 `occurred_at` + 7일 | 반영 | Task 9 `past_due_since`, Task 2 `entitledState`, D15 |
| 권장 6 — `/checkout` 이중 구독 | 반영 | Task 10 `checkout_intents`(완료 intent 잠금·active 면 `/account`), Task 9 `second_subscription` 알림 |
| 권장 7 — WebAuthn 앱 잠금, iOS 저장소 삭제 뒤 재페어링 | 일부 반영 | 재페어링 흐름·`navigator.storage.persist`는 Task 5b. **WebAuthn 은 보류** — iOS PWA 실기 확인이 필요하고 악성 운영자 JS 는 잠금 뒤에서도 키를 쓸 수 있어 효과가 좁다(범위 밖 절) |
| 권장 8 — `EMAIL_MODE: log` 기동 거부, link/start·approve 속도 제한, `os.hostname` 데이터 목록 | 반영 | Task 2 `checkConfig`(공개 출처에서 `log` 면 거부, 기본 `resend`)·속도 제한 표, Task 4b 호스트 이름 전송 범위, Task 11 `privacy-data-inventory.md` |
| 최소 판매 범위 | 반영 | 맨 위 "출시 범위" 표(1차 14개 단계 — Task 4·5 를 4a·4b·실기 확인·5a·5b·5c 로 나눔 / 출시 뒤 6·8·13·14), "출시 뒤" 절 |

**2차 검토(2026-10-25, 판정 "고친 뒤 착수")**

| 검토 항목 | 반영 | 위치 |
|---|---|---|
| 2차 필수 1 — 이용권 없는 Mac 이 릴레이에 붙지 못해 결제 뒤 recheck 가 닿지 않음 | 반영 | 프로토콜 계약 제어 메시지(`{t:'ent'}`·호스트 `{"t":"recheck"}`), Global Constraints, Task 3 `/relay/host`(이용권 확인 안 함)·alarm(기기만 4402, 호스트는 `ent:false`)·테스트 3개, Task 4a RelayClient(`ent` 로 연결 유지, 끊김 백오프 30초→최대 5분), Task 5b 티켓 402 재시도 5초→최대 5분, Task 7 `'entitlement'` 즉시 갱신, Task 9 "not_entitled 로 붙은 Mac → 웹훅 → recheck → 5초 안에 티켓" 테스트, Review Focus 5 |
| 2차 필수 2 — iOS 홈 화면 PWA 안에서 페어링할 길이 없음 | 반영 | 프로토콜 계약 페어링(페어링 코드), Task 5a `pairCode`·PairSheet [코드로 연결]/[복사], Task 5b `handlePairString`·`PairEntry`(붙여 넣기·`BarcodeDetector` 스캔)·RelayGate 문구, 새 "Task 5 앞 실기 확인"(탐침 4종, 5a 전), 출시 범위 표, 사용자 몫, 근거·미확인, D20 |
| 2차 필수 3 — 기기 라우트가 user·until 을 DO 에 안 넘김 | 반영 | Task 3 `/relay/device`(`x-relay-user`·`x-relay-until`·`x-relay-host`, 클라이언트 `x-relay-*` 제거, 빠지면 500), 테스트 "device-only DO alarm reads the user"·"x-relay-* stripped" |
| 2차 권장 — 쿠키 라우트 목록·Origin CSRF | 반영 | Task 2 라우트 절(쿠키 라우트 목록, `Origin === PUBLIC_ORIGIN`·JSON 만, `cookieRoute`), `pairing.test.ts` CSRF 테스트 |
| 2차 권장 — 같은 devicePub claim 멱등 | 반영 | 프로토콜 계약 4단계 예외, Task 2 claim 분기(`claimed` 면 새 토큰·같은 `deviceId`, `confirmed` 면 409 `already_paired`), 테스트, Task 5b 같은 키로 재전송 |
| 2차 권장 — 릴리스 통합·boot 폴백 | 반영 | Task 5c `scripts/release.sh`(UI 게시 → npm publish → `latest`, dry-run), `publish-ui.sh --latest`, `/version.json`, `boot.js` `pickTarget`(없는 버전이면 최신)·`boot.test.ts`, 사용자 몫 배포 줄 |
| 2차 권장 — revoke 순서 | 반영 | Task 4b `revokeDevice`·제어 `revoked`·`syncDevices` 모두 `dropDevice` → `removeDevice`, CloudService 테스트 |
| 2차 권장 — 예약 해지 period_end+48h, 환불 문서 | 반영 | 프로토콜 계약 이용권 계산, Task 9 upsert(`COALESCE`·`MAX`)·`entitled.ts`·테스트, `docs/legal/refund.md`·`refund.ko.md` 3절 |
| 2차 권장 — Task 4·5 분할 | 반영 | Task 4a·4b, Task 5a·5b·5c(각자 Files·Interfaces·Steps·커밋), 출시 범위 표 14단계, Review Focus·결합 지점·이후 Task 참조 갱신 |
