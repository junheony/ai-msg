# AI msg cloud (Cloudflare Worker)

AI msg Pro 클라우드 Worker 다. 공개본에는 들어가지 않는다(`.gitattributes` 의 `cloud/** export-ignore`).
이 문서는 Task 12 에서 완성한다. 지금은 Task 2~3·9 범위(두 출처·로그인·호스트 연결·QR 페어링·기기 API·릴레이·Paddle 웹훅)만 적는다.

## 구조

- 출처 둘을 한 Worker 가 맡고, `Host` 로 나눈다.
  - `PUBLIC_ORIGIN` (app): 로그인, 계정, 호스트 연결, 페어링 관리.
  - `RELAY_ORIGIN` (relay): `POST /v1/pair/claim`, `POST /v1/relay/ticket`, WS `GET /relay/host`(Bearer 호스트 토큰), `GET /relay/device?ticket=`(일회용·60초).
- 릴레이는 호스트마다 Durable Object 하나다(`RelayRoom`, `idFromName(hostId)`, Hibernation WS 전용, 타이머 없음).
  - 봉투 머리(kind·peer)만 읽고 본문은 그대로 넘긴다. 기기가 쓴 `peer` 는 그 기기 id 로 덮어쓴다.
  - 로그는 `{ev,host,dev,bytes,code}` 메타데이터 한 줄뿐이다(`relayLog`).
  - 이용권은 소켓 첨부의 `until` 이고 alarm 이 D1 에서 다시 읽는다. 끝나면 기기 소켓만 4402 로 닫고 호스트는 남긴다.
  - 기기 해제·페어링 소각 → 4403 과 호스트에 `{t:'revoked'}`, 호스트 해제 → 모두 4401. Worker 가 `/internal/*` 로 DO 에 알린다(`notifyRelay`, 실패하면 한 번 더, 또 실패하면 메타데이터 로그만).
  - 해제가 티켓 소비와 DO 수락 사이에 끼어도 남지 않도록, DO 는 수락 직후 D1 에서 기기(`state`)·호스트(`revoked_at`)를 다시 읽고 아니면 4403·4401 로 닫는다.
  - 종료 코드: 4401 인증 실패·호스트 해제, 4402 이용권 없음, 4403 기기 해제, 4408 핸드셰이크 시간 초과, 4409 새 연결로 대체, 4413 프레임 1MiB 초과, 4429 기기 소켓의 프레임 폭주(초당 200·버스트 400, 첨부의 토큰 버킷 — 호스트 소켓은 모든 기기의 응답이 지나가므로 제한 없음, 1MiB 상한만).
  - 깨진 프레임 로그(`bad_frame`)는 소켓당 한 번만 남긴다. 티켓 발급은 기기당 분당 10회(넘으면 429).
  - 다 쓴 `relay_tickets` 행 정리는 Task 12 의 cron 몫이다.
  - 반대편 경로는 404 다. relay 응답에서는 `Set-Cookie` 를 지우고, 엄격한 CSP 를 붙인다.
- Paddle 웹훅 `POST /v1/paddle/webhook`(app 출처, `src/paddle/`):
  - 순서: 본문 64KB 상한(`content-length` 와 실제로 읽은 바이트 둘 다, 넘으면 413·저장 없음) → 원문 바이트 HMAC(`Paddle-Signature`, 5초) → 401, `PADDLE_IP_CHECK=1` 이면 환경별 Paddle IP 목록 → 403, `event_id` 선조회(중복이면 200 `duplicate`), 변경·알림·이벤트 행을 한 batch 로 쓴다.
  - 모든 쓰기는 `occurred_at` 으로 막는 upsert 다. 늦게 온 옛 이벤트는 `stale` 로 기록만 한다.
  - 구독의 사용자는 기존 행의 주인 → 서명된 `custom_data.ref`(`signUserRef(CHECKOUT_SECRET, userId)`) → 이미 연결된 `paddle_customer_id` 순서로 정한다. 서명 없는 `user_id` 는 읽지 않는다. 주인이 정해진 구독은 주인이 바뀌지 않는다(다른 사용자의 ref 가 오면 `customer_conflict` 알림만).
  - user↔customer 연결은 서명된 ref, 그 사용자의 `checkout_intents` 가 이벤트 `occurred_at` 에 열려 있음, 다른 사용자가 그 customer 를 쓰지 않음, **Paddle customer 이메일 = 계정 이메일**(`emailKey` 비교)일 때만 새로 만든다(Paddle 은 같은 이메일이면 기존 고객을 재사용한다). 어긋나면 `customer_unlinked` 알림.
  - customer 이메일은 `customer.created`/`customer.updated` 로 `paddle_customers(id, email_key)` 에 둔다(원문 없음, `EMAIL_HASH_SECRET` HMAC). 그 이벤트가 아직 없으면 연결은 `paddle_link_pending` 에 보류되고(`customer_pending`), customer 이벤트가 오면 그때 맞춰 연결하거나 알린다. 오래 남은 보류 행 정리와 계정 삭제 때 지우기는 Task 12 몫.
  - 업무 충돌(사용자 못 찾음·두 번째 구독·고객 id 충돌·깨진 페이로드)은 200 + `ops_alerts` 행 + `console.error` 한 줄이다. D1 오류만 500(Paddle 이 다시 보낸다).
  - 전액 환불·차지백(거절·취소된 차지백과 차지백 되돌림은 제외)이면 커밋 뒤 `ctx.waitUntil` 로 Paddle 즉시 해지 API 를 부른다. 먼저 `cancel_done_at` 을 NULL → `-now` 로 조건부 선점해 한 번만 부르고, 성공하면 `+now` 다. 실패하면 음수가 남고 `refund_cancel_failed` 알림, Task 12 cron 이 `full = 1 AND (cancel_done_at IS NULL OR cancel_done_at < 0)` 을 다시 시도한다.
  - 구독이 바뀌면 그 사용자의 호스트 방에 recheck 를 보내 기기 소켓의 `until` 을 새로 읽게 한다.
- 이용권(`entitled.ts`): active·trialing 은 `period_end + 48시간`, past_due 는 순서대로 받은 첫 past_due 이벤트 시각 `+ 7일`(늦게 온 옛 past_due 는 무시한다 — 옛 연체 구간 것일 수 있어 Pro 를 일찍 끊지 않는 쪽), canceled·paused 는 `canceled_at`(예약 해지가 실행됐고 전액 환불이 없으면 `period_end + 48시간` 까지). 체험·comp 와 견줘 가장 늦은 `until` 이 이긴다(같으면 pro > comp > trial).
- 저장소는 D1 하나다(`migrations/`). `UI` R2 바인딩은 선언만 해 두었다(Task 7 이 쓴다).
- 설정이 틀리면 `checkConfig` 가 모든 요청에 503 `misconfigured` 로 답한다.
  - 원인은 `console.error` 로 한 번 남는다.
  - 검사 항목: https 출처, 두 출처가 서로 다름, 비밀(`SESSION_SECRET`·`EMAIL_HASH_SECRET`·`CHECKOUT_SECRET`) 32자 이상, `PADDLE_ENV` 가 `sandbox|production`, `PADDLE_IP_CHECK` 가 `0|1`, `resend` 일 때 `RESEND_API_KEY`·`EMAIL_FROM`, `MAX_HOSTS`·`MAX_DEVICES`·`TRIAL_DAYS` 가 양의 정수.
  - `log`·`DEV_ROUTES=1` 은 localhost·`.test` 출처에서만 허용한다.

## 보안 메모

- 웹 세션 쿠키를 쓰는 POST 의 CSRF 방어는 `Origin === PUBLIC_ORIGIN` 검사가 전부다. 두 출처가 같은 사이트(eTLD+1)라서 `SameSite=Lax` 로는 막히지 않는다. 이 검사는 절대 느슨하게 하지 않는다(`null`·누락·Referer 대체 모두 거절).
- 그래서 app 페이지의 referrer 정책은 `same-origin` 이다. `no-referrer` 로 두면 브라우저가 폼 POST 에 `Origin: null` 을 보내서 로그인이 막힌다. relay 출처는 `no-referrer` 를 유지한다.
- 매직링크 토큰이 URL 쿼리(`/auth/verify?t=`)에 있어서 Cloudflare 요청 로그에 남는다. GET 은 토큰을 쓰지 않고 POST 만 쓰지만, 프래그먼트(`#t=`)로 옮기는 것은 나중에 검토한다.
- 릴레이 티켓이 URL 쿼리(`/relay/device?ticket=`)에 있어서 Cloudflare 요청 로그에 쿼리가 남는다 — 일회용·60초라 수용한다. 출시 뒤 Sec-WebSocket-Protocol 로 옮기는 것을 검토한다.
- IP 기준 제한의 키는 IPv4 는 주소 그대로, IPv6 는 /64 다(`ipKey`).
- 한도(MAX_HOSTS·MAX_DEVICES·체험 IP 한도)는 쓰는 문장의 WHERE 안에서 센다. 그래서 동시 요청이 낡은 개수로 통과하지 못한다.

## 로컬

```sh
npm --prefix cloud ci
npm --prefix cloud run typecheck
npm --prefix cloud test        # miniflare 안의 workerd, 네트워크 없음
```

## 배포(사용자 몫, 요약)

1. `wrangler d1 create ai-msg` 를 실행하고, 나온 `database_id` 를 `wrangler.jsonc` 에 넣는다.
2. `wrangler d1 migrations apply ai-msg --remote` 로 마이그레이션을 적용한다.
3. 비밀은 `wrangler secret put` 으로 넣는다: `SESSION_SECRET`, `EMAIL_HASH_SECRET`, `CHECKOUT_SECRET`(각각 32자 이상의 임의 값), `RESEND_API_KEY`, `PADDLE_WEBHOOK_SECRET`(Paddle 알림 대상의 비밀), `PADDLE_API_KEY`(권한 `subscription.write`, Task 10 부터 `customer_portal_session.write` 도). `PADDLE_WEBHOOK_SECRET` 이 비었거나 32자 미만이면 웹훅 경로만 503 이고(나머지는 정상), `pdl_ntfset_` 로 시작하지 않으면 경고 로그만 남긴다. Paddle 알림 대상은 `subscription.*`·`transaction.completed`·`adjustment.*` 와 함께 **`customer.created`·`customer.updated`** 도 구독해야 한다(빠지면 customer 연결이 보류에서 멈춘다).
   - `vars` 의 `PADDLE_ENV`(`sandbox`/`production`)와 키 환경을 맞춘다. 샌드박스 키는 샌드박스 주소에서만 통한다.
4. `wrangler.jsonc` 의 `vars` 를 채운다: `EMAIL_FROM`(Resend 에서 검증한 발신 주소), 두 출처. `routes` 에는 두 호스트 이름을 커스텀 도메인으로 적는다.
   - 결제(Task 10): `PADDLE_CLIENT_TOKEN`(클라이언트 토큰, 샌드박스는 `test_`·실서비스는 `live_` — `PADDLE_ENV` 와 안 맞으면 checkConfig 가 막는다), `PADDLE_PRICE_MONTHLY`·`PADDLE_PRICE_YEARLY`(가격 id), 선택 `PADDLE_DISCOUNT_FOUNDING`. 비어 있으면 `/checkout` 은 503 이다.
   - Paddle 대시보드에서 app 출처 도메인(예: `app.aimsg.app`)의 결제 승인(checkout domain approval)은 사용자가 한다.
5. `npm --prefix cloud run deploy` 로 배포한다. `predeploy` 가 `node scripts/build-legal.mjs --strict` 를 먼저 돌려, `docs/legal/*.md` 에 `{{…}}` 나 DRAFT 띠가 하나라도 남아 있으면 남은 개수와 `파일:줄` 목록을 찍고 배포를 멈춘다. 마이그레이션 `0004_account.sql`(정리용 색인)도 함께 적용한다. cron(`17 3 * * *`, UTC)은 `wrangler.jsonc` 의 `triggers` 로 같이 올라간다.

## 계정·결제 페이지 (Task 10, app 출처에서만)

- `GET /account`: 이메일, 요금제 줄, 연결된 Mac[Unlink]·폰[Revoke], 구독 버튼(살아 있는 구독·확인 중 결제가 없을 때), [Manage billing](연결된 Paddle customer 가 있을 때), Sign out. 서드파티 스크립트 없음 — 기본 엄격 CSP.
- `GET /checkout?plan=pro-monthly|pro-yearly`: Paddle.js 오버레이. 이 페이지만 `script-src 'self' https://cdn.paddle.com`·Paddle frame 출처를 허용하는 CSP 를 쓴다. relay 출처에서는 404.
- 흐름: checkout.js → `POST /v1/billing/intent`(의도 행을 먼저 쓰고 서명된 ref 를 돌려준다, 60분 — 결제 창에 오래 머물러도 웹훅 때 열려 있도록) → `Paddle.Checkout.open`(`customer.email` = 계정 이메일, `settings.allowLogout: false`, `customData` 에는 ref 만) → `checkout.completed` 면 `POST /v1/billing/intent/complete`(아직 열린 의도만, 15분 더 잠금) → `/account?pending=1`(10초마다 새로 고침, 웹훅이 오면 Task 9 가 의도 행을 지운다).
- 잠금: `subscriptions` 에 살아 있는 `active`·`trialing`·`past_due` 구독(기간 지난 행은 제외, 아래 Task 12)이 하나라도 있으면(comp 기간이 더 길어도) 또는 완료한 결제가 확인 중이면 새 결제를 막는다(409 `already_subscribed`·`payment_pending`). 계정 페이지의 구독 버튼도 같은 헬퍼(`liveSubscription`)로 판단한다.
- `POST /v1/billing/portal`: 그 사용자에게 연결된 customer 와, 그 customer 아래 그 사용자의 살아 있는 구독만 넘긴다(`no-store`). 연결된 customer 가 없으면 409 `no_customer` + "결제 때 쓴 이메일이 계정 이메일과 다를 수 있다 — 지원에 문의" 안내(영문). Paddle 실패는 502.
- `POST /v1/hosts/:id/unlink`(쿠키, 사용자당 시간 20회), `POST /logout`(폼). 정적 파일 `/static/{checkout,account}.js`·`pages.css` 는 ASSETS 바인딩이 없어서 TS 문자열로 내보낸다.
- 로컬 앱의 설정 > 클라우드 행: [Pro 구독]·[구독 관리] 는 `/api/cloud/web/{checkout,account}` 로 열고, 로컬 서버가 클라우드 주소로 302 한다(상태 응답에 클라우드 주소를 싣지 않기 위해). 돌아오면 요금제를 한 번 다시 읽는다.

## 법적 페이지·계정 삭제·정리 cron (Task 12)

- 법적 페이지: `docs/legal/{terms,privacy,refund}{,.ko}.md` 가 유일한 원본이다. `scripts/build-legal.mjs` 가 `src/legal/pages.gen.ts`(커밋 안 함)를 만든다. `test`·`dev`·`typecheck` 앞에서 자동으로 돈다. 지원 문법 밖(원시 HTML, 이미지, 기울임, 각주, 코드 펜스, 들여쓴 줄)은 `파일:줄` 과 함께 빌드 실패다. `/legal/{terms,privacy,refund,notice}` 와 `/legal/ko/…` 는 스크립트 없는 CSP 에 1시간 캐시이고, 모든 app 페이지 바닥글에 링크와 비제휴 고지가 붙는다.
- 계정 삭제: `POST /v1/account/delete {confirm:'DELETE'}`. 갱신되는 구독(`scheduled_cancel = 0` 이고 아직 살아 있음)이 있으면 409 다. 나머지는 한 batch 로 지운다. `trial_claims` 와 `subscriptions` 는 `user_id` 만 NULL 로 남는다.
- 정리 cron: 매일 03:17 UTC 에 만료 행을 지운다(표마다 최대 5,000행). 환불 해지 재시도, 보류 고객 연결 알림(30일 지나면 삭제), 기간이 지났는데 살아 있는 구독 알림도 한다. 로그는 개수만 남는다.
- "살아 있는 구독"(결제 차단·계정 삭제 차단 공통)은 `active`·`trialing` 이면 `period_end` 뒤 3일까지, `past_due` 는 7일 유예까지다. 그 뒤에도 상태가 그대로면 webhook 을 놓친 것으로 보고 `subscription_stale` 알림을 낸다.

## 운영 알림 보기

업무 충돌은 `ops_alerts` 에 남는다(종류: `unmatched`, `second_subscription`, `customer_conflict`, `customer_unlinked`, `bad_payload`, `invalid_event`, `refund_cancel_failed`, `customer_pending_stale`, `subscription_stale` — 마지막 둘은 정리 cron 이 하루 한 번 낸다). 아직 처리하지 않은 것만 본다.

```sh
npx --prefix cloud wrangler d1 execute ai-msg --remote --command "SELECT id, kind, ref, detail, created_at FROM ops_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50"
```

처리했으면 `UPDATE ops_alerts SET resolved_at = <ms> WHERE id = ?` 로 닫는다.

## 확인한 버전

2026-10-25 기준이다. 표시가 없으면 확인한 것이다.

- 설치된 버전(`package-lock.json`, 정확 버전):
  - `wrangler` 4.152.0
  - `@cloudflare/vitest-plugin` 1.4.7 (miniflare 5.20261019.2-beta 를 함께 가져온다)
  - `vitest` 5.0.5
  - `typescript` 7.0.2
  - `@cloudflare/workers-types` 5.20261025.1
- vitest 지원 범위: 플러그인 peer 는 `vitest ^4.1.0 || ^5.0.0` 이므로 5 를 지원한다.
- 플러그인 API는 패키지의 `.d.ts` 와 Cloudflare 문서로 확인했다. 패키지 README 는 문서 링크뿐이다.
  - `cloudflareTest(options | async () => options)`: vite 플러그인이다. `wrangler.configPath` 를 받는다.
  - `miniflare.bindings`: wrangler 설정보다 우선한다. 테스트 전용 vars·비밀은 여기서 넣는다.
  - `readD1Migrations(dir)`: `vitest.config.ts`(Node 쪽)에서 부르고, 결과를 바인딩(`TEST_MIGRATIONS`)으로 넘긴다.
  - `applyD1Migrations(db, migrations, table?)`: `cloudflare:test` 에서 가져온다. setup 파일에서 부른다.
  - 테스트 쪽 `env`·`exports` 는 `cloudflare:workers` 에서 가져온다.
    - `exports.default.fetch` 의 타입은 `Cloudflare.GlobalProps.mainModule` 로 잡는다(`test/env.d.ts`).
    - 이 fetch 는 리다이렉트를 따라간다. 그래서 테스트 helper 는 `redirect: 'manual'` 을 준다.
  - 테스트 파일마다 저장소가 따로다. 같은 파일 안에서는 상태가 이어진다.
    - 그래서 IP 제한이 테스트끼리 새지 않도록, helper 가 요청마다 새 IP 를 준다.
  - `vi.useFakeTimers({ toFake: ['Date'] })`: Worker 코드의 `Date.now()` 에도 걸린다. 같은 isolate 이기 때문이다.
- Resend: `POST https://api.resend.com/emails`.
  - 인증은 `Authorization: Bearer <key>` 다.
  - 본문에서 `from`·`to`·`subject` 는 필수다. `text` 는 선택이다.
  - 성공하면 `{ id }` 로 답한다.
  - 실제 호출은 하지 않았다. 테스트는 fetch 를 주입해서 요청 형태만 본다.
- Durable Object: `migrations[].new_sqlite_classes` 키는 wrangler 설정 스키마(`config-schema.json`)에서 확인했다.
  - `web_socket_auto_reply_to_close` 는 2026-04-07 부터 기본값이라(설치된 workerd 바이너리의 플래그 표에서 확인) 플래그를 따로 두지 않는다.
  - `cloudflare:test` 의 `runInDurableObject(stub, fn)`, `runDurableObjectAlarm(stub)`(alarm 이 돌았으면 true), `evictDurableObject(stub, { webSockets: 'hibernate' | 'close' })` 는 `.d.ts` 로 확인했다.
  - 테스트 쪽(workerd) 클라이언트 WebSocket 의 `binaryType` 기본값은 Blob 이다. 그래서 테스트는 `arraybuffer` 로 바꾼다.
  - Worker 는 DO 가 준 101 응답을 그대로 돌려준다. 새 Response 로 다시 만들면 `webSocket` 이 사라진다.
- **(미확인)** 실제 Cloudflare 에서의 Hibernation 동작(잠든 뒤 깨어나는 시점, 과금). 테스트는 `evictDurableObject` 로만 흉내 냈다.
- `routes`: `[{ "pattern": "app.example", "custom_domain": true }, …]` 형태로 한 Worker 에 커스텀 도메인 둘을 건다(wrangler 설정 스키마).
- **(미확인)** 실제 Cloudflare 계정에서 배포할 때의 동작. 실제 배포는 하지 않았다.
  - 커스텀 도메인 두 개의 인증서 발급.
  - D1 원격 마이그레이션.
  - `cf-connecting-ip` 의 실제 값.
- **(미확인)** Resend 발신 도메인 검증 절차와, 오류 응답의 정확한 형태. 지금 코드는 2xx 가 아니면 실패로만 본다.
- Paddle(2026-10-26, developer.paddle.com 문서로 확인, 실제 호출은 하지 않았다):
  - 엔터티 필드 경로·조정의 `action`/`type`/`status`·즉시 해지 API(`POST /subscriptions/{id}/cancel`, `effective_from: immediately`, `subscription.write`)·API 주소·키 접두사(`pdl_sdbx_`·`pdl_live_`). 상세는 계획 문서 "근거·미확인" 절.
  - 테스트 픽스처(`test/fixtures/paddle/`)는 문서 예시 모양을 본뜬 합성 값이다.
  - **(미확인)** 차지백 조정의 `status`·`type`(지금은 `action = chargeback` 이면 전액으로 본다), 해지 API 응답 본문(2xx 만 본다), 실제 샌드박스 웹훅의 전달 모양.
- Paddle.js·포털(2026-10-26, developer.paddle.com 문서로 확인, 실제 호출은 하지 않았다):
  - 스크립트 `https://cdn.paddle.com/paddle/v2/paddle.js`(include-paddlejs). 샌드박스는 `Paddle.Environment.set('sandbox')` 를 `Paddle.Initialize({ token, eventCallback })` 보다 먼저 부른다(paddle-environment-set·paddle-initialize).
  - `Paddle.Checkout.open({ items: [{ priceId, quantity }], customer: { email } | { id }, customData, discountCode, settings: { displayMode, allowLogout } })`(paddle-checkout-open). `customer` 는 `email` 과 `id` 중 하나만. `settings.allowLogout`: "Whether the user can change their email once on the checkout", 기본 `true`.
  - 이벤트 `checkout.completed`·`checkout.closed`(paddlejs events overview).
  - 포털: `POST /customers/{customer_id}/portal-sessions`, 본문 `subscription_ids`(선택, 최대 25), 권한 `customer_portal_session.write`, 201 의 `data.urls.general.overview`. 링크는 임시 토큰을 담으니 캐시하지 않는다(create-customer-portal-session).
  - **(미확인)** `allowLogout: false` 가 `customer.email` 로 연 결제에서도 이메일 변경을 완전히 막는지(문서 예시는 `customer.id`). 못 막더라도 Task 9 가 이메일이 다른 customer 는 연결하지 않는다.
  - **(미확인)** 결제 frame 출처(`sandbox-buy.paddle.com`·`buy.paddle.com`)와 Paddle.js 가 인라인 스타일·추가 출처를 쓰는지 — CSP 는 실제 샌드박스에서 콘솔 위반을 보고 조정해야 한다. 실제 샌드박스 결제도 아직 안 해 봤다.
