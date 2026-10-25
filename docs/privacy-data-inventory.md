# 개인정보·데이터 목록 (Pro 클라우드)

클라우드(Cloudflare Worker·D1·Durable Object)가 무엇을, 왜, 얼마나 두는지 적는다. 보관 기간은 `cloud/src/cleanup.ts`(정리 cron)와 `cloud/src/account.ts`(계정 삭제)의 코드와 같아야 한다. 하나를 바꾸면 이 문서도 바꾼다.

- 정리 cron 은 매일 03:17 UTC 에 돈다. 표마다 한 번에 최대 5,000행을 지운다. 그래서 아래 기간은 "그 시각이 지난 뒤 다음 cron 에서" 지워진다는 뜻이다.
- 처리자: **Cloudflare**(Worker·D1·DO·요청 로그 — 모든 클라우드 데이터), **Paddle**(결제 판매자, 카드·세금·청구서는 Paddle 이 갖고 우리에게 오지 않는다), **Resend**(로그인 메일 발송, 받는 주소와 본문).
- 클라우드에 연결하지 않은 설치는 클라우드에 아무것도 보내지 않는다.

## 클라우드에 없는 것

- 대화·프롬프트·코드·AI 출력·승인 내용: 릴레이를 Noise 암호문으로 지나갈 뿐 저장하지 않는다. 키는 Mac 과 페어링한 폰에만 있다.
- 푸시 구독(endpoint·키): Mac 의 설정 폴더에만 있다. 클라우드는 푸시를 보내지도 받지도 않는다(출시 1차).
- 카드 번호·청구 주소: Paddle 에만 있다.
- AI 업체 로그인 정보.

## D1 표

| 항목 | 표·열 | 목적 | 보관 기간 | 처리자 |
|---|---|---|---|---|
| 계정 이메일(원문), 만든 시각 | `users.email`, `created_at` | 매직링크 로그인, 결제 고객과 맞추기 | 계정 삭제까지 | Cloudflare |
| 매직링크(토큰 해시, 받는 이메일 원문, 돌아갈 경로) | `magic_links` | 로그인 | 15분 유효, 만료 뒤 1일 지나 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 웹 세션(id 해시) | `web_sessions` | 로그인 유지 | 30일 유효, 만료되면 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 로그 메일(받는 주소·제목·본문) | `outbox` | 개발·테스트용 `log` 발송 방식에서만 쓴다. 운영(`resend`)에서는 쓰지 않는다 | 1일. 계정 삭제 때 즉시 | Cloudflare |
| Mac 연결 요청(장치 코드 해시, 사용자 코드, Mac 이름, 호스트 공개키, UI 버전) | `host_links` | Mac ↔ 계정 연결 | 10분 유효, 만료 뒤 1일 지나 삭제. 계정 삭제 때 즉시 | Cloudflare |
| Mac(호스트 id, 이름, 공개키, 토큰 해시, UI 버전, 연결·해제 시각) | `hosts` | 기기 등록, 릴레이 인증 | 계정 삭제까지(해제해도 행은 `revoked_at` 으로 남는다) | Cloudflare |
| 폰·브라우저 기기(기기 id, 이름, 공개키, 토큰 해시, 상태, 만든·마지막 접속 시각) | `devices` | 페어링, 릴레이 접근 | 계정 삭제까지(해제해도 행은 `revoked` 로 남는다) | Cloudflare |
| 페어링 시도(claim 해시, 상태, 기기 id, 페어링 MAC, 틀린 claim 수) | `pairings` | 안전한 페어링 | 5분 유효, 만료 뒤 1일 지나 기기가 가리키지 않으면 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 릴레이 티켓(해시, 기기·호스트·사용자 id) | `relay_tickets` | 기기 소켓 일회용 입장권 | 60초 유효, 만료 뒤 1시간 지나 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 체험(시작·끝 시각) | `trials` | 7일 체험 | 계정 삭제까지 | Cloudflare |
| 체험 1회 기록(정규화 이메일 키 = `EMAIL_HASH_SECRET` HMAC) | `trial_claims` | 이메일당 체험 1회 | **계정 삭제 뒤에도 남는다**(`user_id` 만 NULL) | Cloudflare |
| comp 부여(요금제, 끝 시각, 메모) | `grants` | 운영자가 주는 무료 이용권 | 계정 삭제까지 | Cloudflare |
| 속도 제한 카운터(키: IP — IPv4 그대로·IPv6 /64, 정규화 이메일 키, 사용자·호스트·기기 id) | `rate` | 남용 방지 | 창 시작 뒤 2일 지나 삭제. 계정 삭제 때 그 사용자 id 키만 즉시 | Cloudflare |
| 구독(Paddle 구독·고객 id, 상태, 가격 id, 기간, 해지 상태) | `subscriptions` | 이용권 판단 | **계정 삭제 뒤에도 남는다**(`user_id` 만 NULL). 정리 cron 대상 아님 | Cloudflare, Paddle(원본) |
| Paddle 고객 연결 | `users.paddle_customer_id` | 결제 포털, 구독 주인 정하기 | 계정 삭제까지 | Cloudflare, Paddle |
| Paddle 고객 이메일 키(HMAC, 원문 없음) | `paddle_customers` | 결제 이메일 = 계정 이메일 확인 | 정리 cron 대상 아님, 계정 삭제 때도 남는다 | Cloudflare, Paddle(원본) |
| 보류된 고객 연결(고객 id, 사용자 id) | `paddle_link_pending` | customer 이벤트를 기다리는 연결 | 30일 지나 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 결제 의도(요금제, 완료 시각) | `checkout_intents` | 결제 중 두 번째 구독 막기, 웹훅 연결 | 60분 유효(완료 뒤 15분 더), 만료되면 삭제. 계정 삭제 때 즉시 | Cloudflare |
| 웹훅 이벤트(event id, 종류, 발생·받은 시각) | `paddle_events` | 중복 방지, 결제 동기화 | 받은 뒤 90일 | Cloudflare |
| 환불·차지백(조정·거래·구독 id, 종류, 상태) | `refunds` | 전액 환불 시 자동 해지 | 정리 cron 대상 아님 | Cloudflare, Paddle(원본) |
| 운영 알림(종류, 참조 id, 상세) | `ops_alerts` | 결제 충돌 처리 | 처리하면 다음 cron 에서, 아니어도 90일. 계정 삭제 때 그 사용자 참조는 NULL | Cloudflare |

## D1 밖

| 항목 | 어디 | 목적 | 보관 기간 | 처리자 |
|---|---|---|---|---|
| Mac 이름 | `hosts.name` 등. 로컬 서버가 `os.hostname()` 앞 40자를 보낸다(클라우드는 64자까지 받는다) | 계정 페이지에서 Mac 구분 | 위 `hosts` 와 같다 | Cloudflare |
| 릴레이 메타데이터(이벤트 종류, 호스트·기기 id, 바이트 수, 종료 코드, 시각) | Worker 로그(`relayLog` 한 줄 JSON) | 운영·보안 | Cloudflare Workers 로그 설정을 따른다(미확인) | Cloudflare |
| 요청 로그(IP, URL — 쿼리의 매직링크 토큰·릴레이 티켓 포함) | Cloudflare 요청 로그 | 플랫폼 기본 | Cloudflare 설정을 따른다(미확인). 토큰은 한 번 쓰면 무효, 티켓은 일회용·60초 | Cloudflare |
| 로그인 메일(받는 주소, 링크가 든 본문) | Resend | 발송 | Resend 정책을 따른다(미확인) | Resend |
| 결제 정보(이메일, 카드, 국가, 청구서) | Paddle | 결제 판매자 업무 | Paddle 정책 | Paddle |
| 릴레이 소켓 첨부(`until`, 기기 id, 토큰 버킷) | Durable Object 메모리 | 이용권 끝나면 기기 소켓 닫기 | 소켓이 닫히면 사라진다 | Cloudflare |

## 계정 삭제

`POST /v1/account/delete` 가 한 batch 로 지운다: 사용자, 그 사용자의 호스트·기기·페어링·Mac 연결 요청·웹 세션·매직링크·로그 메일·체험·comp·결제 의도·보류 연결·릴레이 티켓·사용자 id 속도 키. 남는 것은 `trial_claims`(이메일 키)·`subscriptions`·`paddle_customers`·`refunds`·`paddle_events`(90일)·`ops_alerts`(참조 NULL, 90일)·IP·이메일 키 속도 카운터와 호스트·기기 id 로 묶인 속도 키 `ent:host:<호스트 id>`·`relay:ticket:dev:<기기 id>`(모두 2일 뒤 정리)다.
