# AI msg cloud (Cloudflare Worker)

AI msg Pro 클라우드 Worker 다. 공개본에는 들어가지 않는다(`.gitattributes` 의 `cloud/** export-ignore`).
이 문서는 Task 12 에서 완성한다. 지금은 Task 2~3 범위(두 출처·로그인·호스트 연결·QR 페어링·기기 API·릴레이)만 적는다.

## 구조

- 출처 둘을 한 Worker 가 맡고, `Host` 로 나눈다.
  - `PUBLIC_ORIGIN` (app): 로그인, 계정, 호스트 연결, 페어링 관리.
  - `RELAY_ORIGIN` (relay): `POST /v1/pair/claim`, `POST /v1/relay/ticket`, WS `GET /relay/host`(Bearer 호스트 토큰), `GET /relay/device?ticket=`(일회용·60초).
- 릴레이는 호스트마다 Durable Object 하나다(`RelayRoom`, `idFromName(hostId)`, Hibernation WS 전용, 타이머 없음).
  - 봉투 머리(kind·peer)만 읽고 본문은 그대로 넘긴다. 기기가 쓴 `peer` 는 그 기기 id 로 덮어쓴다.
  - 로그는 `{ev,host,dev,bytes,code}` 메타데이터 한 줄뿐이다(`relayLog`).
  - 이용권은 소켓 첨부의 `until` 이고 alarm 이 D1 에서 다시 읽는다. 끝나면 기기 소켓만 4402 로 닫고 호스트는 남긴다.
  - 기기 해제·페어링 소각 → 4403 과 호스트에 `{t:'revoked'}`, 호스트 해제 → 모두 4401. Worker 가 `/internal/*` 로 DO 에 알린다(`notifyRelay`).
  - 다 쓴 `relay_tickets` 행 정리는 Task 12 의 cron 몫이다.
  - 반대편 경로는 404 다. relay 응답에서는 `Set-Cookie` 를 지우고, 엄격한 CSP 를 붙인다.
- 저장소는 D1 하나다(`migrations/`). `UI` R2 바인딩은 선언만 해 두었다(Task 7 이 쓴다).
- 설정이 틀리면 `checkConfig` 가 모든 요청에 503 `misconfigured` 로 답한다.
  - 원인은 `console.error` 로 한 번 남는다.
  - 검사 항목: https 출처, 두 출처가 서로 다름, 비밀 32자 이상, `resend` 일 때 `RESEND_API_KEY`·`EMAIL_FROM`, `MAX_HOSTS`·`MAX_DEVICES`·`TRIAL_DAYS` 가 양의 정수.
  - `log`·`DEV_ROUTES=1` 은 localhost·`.test` 출처에서만 허용한다.

## 보안 메모

- 웹 세션 쿠키를 쓰는 POST 의 CSRF 방어는 `Origin === PUBLIC_ORIGIN` 검사가 전부다. 두 출처가 같은 사이트(eTLD+1)라서 `SameSite=Lax` 로는 막히지 않는다. 이 검사는 절대 느슨하게 하지 않는다(`null`·누락·Referer 대체 모두 거절).
- 그래서 app 페이지의 referrer 정책은 `same-origin` 이다. `no-referrer` 로 두면 브라우저가 폼 POST 에 `Origin: null` 을 보내서 로그인이 막힌다. relay 출처는 `no-referrer` 를 유지한다.
- 매직링크 토큰이 URL 쿼리(`/auth/verify?t=`)에 있어서 Cloudflare 요청 로그에 남는다. GET 은 토큰을 쓰지 않고 POST 만 쓰지만, 프래그먼트(`#t=`)로 옮기는 것은 나중에 검토한다.
- IP 기준 제한의 키는 IPv4 는 주소 그대로, IPv6 는 /64 다(`ipKey`).
- 한도(MAX_HOSTS·MAX_DEVICES·체험 IP 한도)는 쓰는 문장의 WHERE 안에서 센다. 그래서 동시 요청이 낡은 개수로 통과하지 못한다.

## 로컬

```sh
npm --prefix cloud ci
npm --prefix cloud run typecheck
npm --prefix cloud test        # miniflare 안의 workerd, 네트워크 없음
```

## 배포(사용자 몫, 요약 — Task 12 에서 완성)

1. `wrangler d1 create ai-msg` 를 실행하고, 나온 `database_id` 를 `wrangler.jsonc` 에 넣는다.
2. `wrangler d1 migrations apply ai-msg --remote` 로 마이그레이션을 적용한다.
3. 비밀은 `wrangler secret put` 으로 넣는다: `SESSION_SECRET`, `EMAIL_HASH_SECRET`(각각 32자 이상의 임의 값), `RESEND_API_KEY`.
4. `wrangler.jsonc` 의 `vars` 를 채운다: `EMAIL_FROM`(Resend 에서 검증한 발신 주소), 두 출처. `routes` 에는 두 호스트 이름을 커스텀 도메인으로 적는다.
5. `wrangler deploy` 로 배포한다.

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
