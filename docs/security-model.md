# 보안 모델

원본은 `docs/superpowers/plans/2026-10-22-ai-msg-cloud-pro.md` 의 "보안 모델과 한계" 절이다. 구현이 이 문서와 어긋나면 구현을 고치거나 원본 절을 먼저 고친다.

## 지키는 것

- 릴레이를 지나는 대화·코드·명령·승인 내용은 Mac 과 페어링한 폰만 읽는다. 클라우드(Worker·DO)는 봉투 머리(종류·기기 id)와 암호문 길이만 본다.
- 키 교환은 Noise KK(`Noise_KK_25519_AESGCM_SHA256`)다. Mac 은 자기 로컬 신뢰 목록에 있는 기기 공개키로만 핸드셰이크를 받는다.
- 클라우드에 대화 내용·푸시 구독은 없다. 무엇이 어디에 얼마나 남는지는 `docs/privacy-data-inventory.md` 에 있다.

## 운영자를 신뢰하는 범위 — 폰 UI 의 JavaScript

- 폰이 여는 앱 코드(HTML·JS)는 클라우드(relay 출처, R2)가 내려준다. 그래서 **운영자 본인, 또는 배포 자격증명·R2·Cloudflare 계정을 탈취한 사람은 폰에 다른 JS 를 내려보낼 수 있다.**
- 그 JS 는 그 폰의 기기 키를 써서 정상 기기처럼 Mac 에 붙을 수 있고, 페어링 QR 을 찍는 순간의 `authSecret` 도 읽을 수 있다.
- 종단간 암호화는 "릴레이를 지나는 바이트" 를 지키지, "폰에서 도는 코드" 를 지키지 않는다. 클라우드 코드는 비공개라서 서버 코드 공개로 이 신뢰를 대신할 수도 없다.
- 폰 쪽 클라이언트 코드(`src/ui/relay/`, `src/shared/cloud/`)는 Apache-2.0 코어에 있어 누구나 읽을 수 있다. 다만 실제로 내려온 파일이 그 코드에서 빌드된 것인지 폰이 검증하는 장치는 출시 1차에 없다(출시 뒤: 버전별 빌드 해시 공개·재현 빌드).
- 폰 UI·페어링 화면(계획의 Task 5a~5c)은 아직 합쳐지지 않았다. 이 절은 그 화면이 들어올 때의 계약이다.

## 위협별로 막는 것과 못 막는 것

| 위협 | 막는 것 | 못 막는 것 |
|---|---|---|
| 릴레이(DO)·네트워크 탈취자 | 평문 읽기, 프레임 위조·재전송·순서 바꿈, 다른 기기 사칭(DO 가 출처 덮어쓰기 + Mac 신뢰 목록), 옛 UI 로 강제 이동(버전은 Noise 페이로드로 인증, 이동은 `ready` 검증 뒤) | 연결 끊기, 4409 로 계속 밀어내기, 트래픽 양·시각 관찰 |
| 클라우드 운영자·배포 탈취자 | 기존 기기 키 없이 Mac 에 붙기(Mac 신뢰 목록), 페어링 때 기기 키 바꿔치기(QR 의 `authSecret` HMAC + 확인 코드) | **폰에 악성 JS 를 내려 그 폰의 기기 키로 정상 기기처럼 행동하기** — 프롬프트 보내기, 대기 중 승인 누르기, 루프백 API 로 파일 읽기. 아래 "폰에서 막는 동작" 만 막힌다 |
| QR 엿보기(어깨 너머·사진) | Mac 이 확인 코드를 보여 주고 [허용] 을 눌러야 확정, 같은 페어링에 claim 이 두 번 오면 폐기 | 사용자가 코드를 비교하지 않고 [허용] 을 누르는 경우 |
| 같은 출처의 제3자 스크립트·XSS | 폰 UI 는 relay 출처에 따로 있고 제3자 스크립트·쿠키가 없다(relay 응답은 `Set-Cookie` 를 지우고 `script-src 'self'` CSP). Paddle.js 는 app 출처의 `/checkout` 에만 있다 | 폰 UI 자체의 XSS(그 탭 안에서 기기 키 사용 가능 — 추출 불가 키여도 사용은 된다) |
| 악성 웹페이지(사용자 브라우저) | 로컬 서버가 이미 막는다: Host 허용 목록(`isAllowedHost`, 421), 상태 변경 Origin 검사(`stateChangingOriginOk`, 403), 쿠키 `SameSite=Strict`. `/api/cloud/*` 도 같은 검사를 받는다(`src/server/cloud/localGuards.test.ts`) | — |
| 폰 분실·도난 | Mac 설정이나 계정 페이지에서 기기 해제 → 열린 채널 즉시 종료 | 잠금 해제된 폰을 쥔 사람(앱 잠금은 출시 뒤) |
| Paddle 웹훅 위조·중복·역순 | 원문 HMAC, `event_id` 멱등, `occurred_at` 순서, user 참조는 서버 서명 토큰 | — |

## 클라우드 웹 출처

- app 출처와 relay 출처는 한 Worker 가 `Host` 로 나눈다. 각 경로는 자기 출처에서만 답하고 반대편·모르는 호스트에서는 404 다.
- app 의 쿠키(`__Host-`, `HttpOnly`, `Secure`, `Path=/`, Domain 없음)를 쓰는 POST 는 `Origin === PUBLIC_ORIGIN` 일 때만 받는다(`null`·누락도 403). 두 출처가 같은 사이트라 `SameSite` 로는 막히지 않기 때문이다.
- app 의 HTML 은 모두 `frame-ancestors 'none'`·`base-uri 'none'`·`nosniff` 이고 `unsafe-*` 가 없다. Paddle 출처는 `/checkout` CSP 에만 있다. 법적 페이지는 스크립트 없는 CSP 에 공개 캐시, 나머지는 `no-store` 다.
- 설정이 틀리면 두 출처 모두 503 `misconfigured` 이고, 저장소에는 토큰·세션·이메일 키가 해시(HMAC·SHA-256, base64url 43자)로만 남는다. 로그에는 토큰·이메일·`Authorization` 이 남지 않는다. 회귀 테스트는 `cloud/test/security.test.ts` 다.

## 키 저장 위치

- **Mac:** 호스트 키·호스트 토큰·신뢰한 기기 공개키는 `<설정 폴더>/cloud/state.json` 에 있다. 폴더는 `0700`, 파일은 `0600` 이고 임시 파일에 쓴 뒤 바꿔 끼운다. 클라우드에 연결한 적 없는 설치는 클라우드에 아무 요청도 보내지 않는다(`src/server/cloud/faults.test.ts`).
- **폰(5a 계약, 구현 전):** 기기 키는 IndexedDB 의 추출 불가 `CryptoKey` 다(DH 는 `deriveBits` 로만). 그 런타임이 WebCrypto X25519 를 지원하지 않아 `@noble/curves` 로 대체하면 그 폰에서만 키가 IndexedDB 에 원시 바이트로 남는다.
- **클라우드:** 호스트·기기의 공개키와 토큰 해시만 있다. 비밀키는 없다.
- 저장소에 들어가는 파일에 비밀키 모양(PEM 머리, `d` 가 있는 OKP·EC JWK)이 있으면 위생 검사(`src/hygiene.ts`)가 실패한다.

## 기기 해제

- Mac 설정의 클라우드 행이나 계정 페이지에서 한다. 폰에서 다른 기기를 해제하는 것은 막는다(`mac_confirm_required`).
- 계정 페이지에서 해제하면 클라우드가 기기 행을 `revoked` 로 바꾸고 그 기기 소켓을 4403 으로 닫으며, 호스트에 `{t:'revoked'}` 를 보낸다. Mac 은 그 기기 채널을 먼저 끊고 신뢰 목록에서 키를 지운다. Mac 이 그때 꺼져 있었으면 다음 연결 때 클라우드의 기기 목록과 맞춰 지운다.
- Mac 에서 해제하면 채널을 먼저 끊고 신뢰 목록에서 지운 뒤 클라우드에 알린다. 알림이 실패하면 `pendingRevokes` 에 남겨 다음 연결 때 다시 보낸다.
- Mac 연결을 끊으면(호스트 해제) 그 Mac 의 기기가 모두 해제되고 소켓은 4401 로 닫힌다.

## 클라우드 장애

- 클라우드가 꺼져 있거나 5xx 를 내도 로컬 서버는 뜨고 무료 기능(세션·ws·로컬 푸시)은 그대로다. 릴레이 상태만 `down` 이 되고, 저장된 연결과 요금제 표시는 남는다.
- Mac 이 잠들었다 깨면(벽시계가 타이머보다 30초 넘게 앞서 가면) 릴레이 소켓을 바로 다시 연다. 60초 무응답을 기다리지 않는다.

## 정직한 문구

- en: "The relay is end-to-end encrypted: our servers pass along encrypted bytes between your Mac and the phone you paired, and cannot read your sessions. The phone app itself is delivered from our servers, so you are trusting us to serve the published app code. Sensitive actions — restarting the server, changing setup, raising permission modes, and pairing a new phone — need you at your Mac."
- ko: "릴레이는 종단간 암호화됩니다. 저희 서버는 Mac 과 페어링한 폰 사이에서 암호화된 바이트만 전달하고, 세션 내용을 읽을 수 없습니다. 다만 폰 앱 코드 자체는 저희 서버가 내려 주므로, 공개한 앱 코드를 그대로 내려 준다는 점은 저희를 믿으셔야 합니다. 서버 재시작·설정 변경·권한 모드 올리기·새 폰 연결은 Mac 앞에서 직접 하셔야 합니다."
- 쓰지 않는 문구: "클라우드도 절대 볼 수 없다", "운영자를 믿을 필요 없음", "서버 코드 공개로 검증 가능".

## 암호 구현

- **암호 구현:** `Noise_KK_25519_AESGCM_SHA256` 을 Noise 사양 rev 34 §5(CipherState·SymmetricState·HandshakeState) 그대로 WebCrypto(X25519·AES-256-GCM·SHA-256·HMAC)로 직접 구현했다(`src/shared/cloud/noise.ts`, 런타임 의존성 추가 없음). 공개 테스트 벡터 2건(cacophony·snow 의 `Noise_KK_25519_AESGCM_SHA256` 항목, `src/shared/cloud/noise.fixtures/kk-vectors.json`)을 핸드셰이크·전송 메시지까지 모두 재현한다. 검토한 라이브러리 `noise-protocol`(ChaChaPoly·BLAKE2b 만, 직접 의존성 4개)·`noise-handshake`(ChaChaPoly·BLAKE2b 기본, `sodium-universal` 의존)·`noise-c.wasm`(WASM 안에 키가 있어 DH 를 바꿔 끼울 수 없음, 2022 년 이후 갱신 없음)은 합격 조건을 채우지 못했다. 폰 기기 키는 추출 불가 `CryptoKey` 로 만들고 DH 는 `deriveBits` 로만 쓴다. Node 24+ 는 WebCrypto X25519 를 지원한다. iOS Safari 의 지원은 Task 5 앞 실기 확인에서 본다 — 지원하지 않으면 그 런타임에서만 `@noble/curves` 가 필요하고(D3 승인 대상) 그때 폰 키는 IndexedDB 에 원시 바이트로 남는다.

## 핸드셰이크 재전송과 세션 교체

- Noise KK 메시지 1(`hs_init`)은 릴레이가 보관했다가 다시 보낼 수 있다. Mac(`hostHandshake`)은 재전송된 msg1 에도 응답하고 `Transport` 를 돌려준다 — 재전송자는 기기 정적 키·임시 키가 없어서 그 채널을 읽지도 쓰지도 못하지만, 채널이 생겼다는 사실만으로는 기기가 살아 있다는 증거가 아니다.
- 그래서 **기기의 첫 전송 메시지(`ready`)를 그 Transport 로 복호화한 뒤에만**(`transport.peerAuthenticated === true`) 인증된 연결로 본다. 그 전에는 같은 기기의 기존 세션을 교체하지 않는다(`dropDevice`·4409 금지). 5초 안에 `ready` 가 열리지 않으면 새 핸드셰이크만 버리고 기존 세션은 그대로 둔다.
- DO 의 4409(같은 태그의 새 소켓)는 일회용 티켓으로 인증된 소켓끼리의 교체이고, Mac 쪽 Noise 세션 교체는 위 규칙을 따로 따른다.

## 페어링 확인 코드가 기대는 것

- 확인 코드(`confirmCode`)는 6자리(약 20비트)이고 공개 값(`pairingId`·`devicePub`·`hostPub`)만 해시한다. 비밀이 아니므로 혼자서는 기기 키 바꿔치기를 막지 못한다(공격자가 맞는 코드가 나오는 키를 찾을 수 있다).
- 안전성은 두 가지에 기댄다. ① QR 에만 있는 256비트 `authSecret` 으로 만든 `pairingMac` — 클라우드는 이 값을 모르므로 폰 공개키를 바꾸면 Mac 에서 MAC 이 틀린다. ② 같은 페어링에 올바른 claim 이 두 번 오면 클라우드가 페어링을 `burned` 로 바꾸고 기기를 모두 해제한다 — QR 을 엿본 사람이 먼저 claim 해도 진짜 폰의 claim 이 오는 순간 폐기된다.
- 확인 코드는 위 둘을 지나온 뒤 "사람이 화면 두 개를 맞춰 보는" 마지막 단계다. `claimSecret`·`authSecret` 은 43자(256비트) 이상이어야 하고 `parsePairHash` 가 짧은 값을 거절한다.

## 폰에서 막는 동작(Mac 확인)

- 새 세션은 Mac 기본값으로 실행된다(폰은 도구 승인을 이미 할 수 있으므로).
- Mac 확인(`mac_confirm_required`) 대상은 기존 세션 권한 상향, 권한을 넓히는 영속 설정·안전 스위치·외부 전송 동의(`autoConsent` 넓히기)·전역 지시(`/api/memory` 쓰기)와 서버 관리 동작(재시작·업데이트·설정 마법사·로그인·클라우드 설정)이다. 좁히는 쪽은 폰에서도 된다. 목록은 원본 절과 `docs/protocol.md` 의 `mac_confirm_required` 표를 따른다.

## 터널 경로와 한도

- `http.req` 의 `p` 는 `/` 하나로 시작하는 출처 상대 경로만 받는다(`//host`·역슬래시·공백·제어 문자·`.`/`..` 구간(퍼센트 인코딩 포함)은 프레임 단계에서 거절, 2048자 이하). Mac 의 `relayPathPolicy` 는 그래도 퍼센트 디코딩·정규화한 경로로 규칙을 검사한다.
- 봉투는 `MAX_FRAME`(1MiB) 이하만 받는다. `more` 조각 재조립 상한과 기기당 동시 스트림 수 상한은 `frames.ts` 가 아니라 DO(Task 3)·`RelayBridge`(Task 4b)·폰 `RelayConnection`(Task 5b)이 지킨다.
