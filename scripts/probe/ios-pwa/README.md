# iOS 홈 화면 PWA 탐침

Pro 계획 "Task 5 앞 실기 확인" 용. Safari 와 홈 화면 앱이 저장소를 나눠 쓰는지, 홈 화면 앱에서 카메라·`BarcodeDetector`·푸시가 되는지 본다. 외부 출처·추적 코드는 없다.

## 띄우기

HTTPS 정적 호스팅에 이 폴더를 올린다(서비스 워커는 HTTPS 에서만 등록된다). tailnet 이면 `python3 -m http.server <port> --bind 127.0.0.1` 을 이 폴더에서 띄우고, 그 포트로 가는 `tailscale serve` HTTPS 주소로 연다.

## 순서 (iPhone)

1. Safari 에서 열고 [쓰기].
2. 공유 › 홈 화면에 추가 → 홈 화면 앱으로 열고 [읽기]. Safari 에서 쓴 값(`safari@…`)이 보이는지.
3. 홈 화면 앱에서 [쓰기] → Safari 로 돌아가 [읽기]. 앱에서 쓴 값(`pwa@…`)이 보이는지.
4. 홈 화면 앱에서 [카메라](권한 창이 뜨고 `ok` 인지), [푸시 지원], 화면 맨 위의 `BarcodeDetector`·`PushManager`, [쓰기] 뒤 `persist` 값.

## 결과

| 항목 | 값 |
|---|---|
| iOS 버전 | |
| 2. 앱에서 Safari 값 보임 (localStorage / indexedDB) | |
| 3. Safari 에서 앱 값 보임 (localStorage / indexedDB) | |
| 앱 camera | |
| 앱 BarcodeDetector | |
| 앱 PushManager | |
| 앱 Notification.permission | |
| 앱 persist | |
| 앱 sw | |
