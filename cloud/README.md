# AI msg cloud (Cloudflare Worker)

AI msg Pro 클라우드 Worker 다. 공개본에는 들어가지 않는다(`.gitattributes` 의 `cloud/** export-ignore`).
이 문서는 Task 12 에서 완성한다. 지금은 Task 2 범위(두 출처·로그인·호스트 연결·QR 페어링·기기 API)만 적는다.

## 구조

- 출처 둘을 한 Worker 가 맡고, `Host` 로 나눈다.
  - `PUBLIC_ORIGIN` (app): 로그인, 계정, 호스트 연결, 페어링 관리.
  - `RELAY_ORIGIN` (relay): `POST /v1/pair/claim`, `POST /v1/relay/ticket`. Task 3 에서 WS 가 붙는다.
  - 반대편 경로는 404 다. relay 응답에서는 `Set-Cookie` 를 지우고, 엄격한 CSP 를 붙인다.
- 저장소는 D1 하나다(`migrations/`). `UI` R2 바인딩은 선언만 해 두었다(Task 7 이 쓴다).
- 설정이 틀리면 `checkConfig` 가 모든 요청에 503 `misconfigured` 로 답한다.
  - 원인은 `console.error` 로 한 번 남는다.
  - 검사 항목: https 출처, 두 출처가 서로 다름, 비밀 32자 이상, `resend` 일 때 `RESEND_API_KEY`·`EMAIL_FROM`.
  - `log`·`DEV_ROUTES=1` 은 localhost·`.test` 출처에서만 허용한다.

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
- `routes`: `[{ "pattern": "app.example", "custom_domain": true }, …]` 형태로 한 Worker 에 커스텀 도메인 둘을 건다(wrangler 설정 스키마).
- **(미확인)** 실제 Cloudflare 계정에서 배포할 때의 동작. 실제 배포는 하지 않았다.
  - 커스텀 도메인 두 개의 인증서 발급.
  - D1 원격 마이그레이션.
  - `cf-connecting-ip` 의 실제 값.
- **(미확인)** Resend 발신 도메인 검증 절차와, 오류 응답의 정확한 형태. 지금 코드는 2xx 가 아니면 실패로만 본다.
