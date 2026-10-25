# 보안 모델

원본은 `docs/superpowers/plans/2026-10-22-ai-msg-cloud-pro.md` 의 "보안 모델과 한계" 절이다. 이 문서의 나머지는 Task 11 에서 채운다.

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
