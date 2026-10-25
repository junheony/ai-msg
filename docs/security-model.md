# 보안 모델

원본은 `docs/superpowers/plans/2026-10-22-ai-msg-cloud-pro.md` 의 "보안 모델과 한계" 절이다. 이 문서의 나머지는 Task 11 에서 채운다.

## 암호 구현

- **암호 구현:** `Noise_KK_25519_AESGCM_SHA256` 을 Noise 사양 rev 34 §5(CipherState·SymmetricState·HandshakeState) 그대로 WebCrypto(X25519·AES-256-GCM·SHA-256·HMAC)로 직접 구현했다(`src/shared/cloud/noise.ts`, 런타임 의존성 추가 없음). 공개 테스트 벡터 2건(cacophony·snow 의 `Noise_KK_25519_AESGCM_SHA256` 항목, `src/shared/cloud/noise.fixtures/kk-vectors.json`)을 핸드셰이크·전송 메시지까지 모두 재현한다. 검토한 라이브러리 `noise-protocol`(ChaChaPoly·BLAKE2b 만, 직접 의존성 4개)·`noise-handshake`(ChaChaPoly·BLAKE2b 기본, `sodium-universal` 의존)·`noise-c.wasm`(WASM 안에 키가 있어 DH 를 바꿔 끼울 수 없음, 2022 년 이후 갱신 없음)은 합격 조건을 채우지 못했다. 폰 기기 키는 추출 불가 `CryptoKey` 로 만들고 DH 는 `deriveBits` 로만 쓴다. Node 24+ 는 WebCrypto X25519 를 지원한다. iOS Safari 의 지원은 Task 5 앞 실기 확인에서 본다 — 지원하지 않으면 그 런타임에서만 `@noble/curves` 가 필요하고(D3 승인 대상) 그때 폰 키는 IndexedDB 에 원시 바이트로 남는다.
