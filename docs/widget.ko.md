# MSG mini — 잠금 화면 위젯

MSG의 세션·사용량·허브 상태를 폰에서 한눈에 보는 **읽기 전용** 화면입니다. 끼어들기·중지·매매 같은 조작은 할 수 없습니다.

## 1. /mini 페이지 (모든 폰)

MSG 주소 뒤에 `/mini`를 붙여 엽니다 (예: `https://<MSG 주소>/mini`). MSG에 로그인한 브라우저면 바로 보입니다.

- 10초마다 새로고침, 버튼은 새로고침 하나뿐
- iPhone: 공유 → **홈 화면에 추가** 하면 앱처럼 전체 화면으로 열립니다
- 폴더블·듀얼 스크린(Duo)은 펼치면 두 칼럼, 접으면(커버 화면) 한 칼럼으로 맞춰집니다

## 2. 위젯 토큰

잠금 화면 위젯은 쿠키 대신 **위젯 토큰**으로 읽습니다. 이 토큰은 `GET /api/mini/status` 하나만 열고, 다른 어떤 API에도 쓸 수 없습니다.

MSG → 설정 → **계정** → **위젯 토큰** → **복사**.
토큰이 새어 나갔다고 생각되면 **재발급**을 누르면 됩니다. 이전 토큰은 즉시 무효가 되고, 위젯에 새 토큰을 다시 넣어야 합니다.

## 3. iPhone 잠금 화면 위젯 (Scriptable)

1. App Store에서 **Scriptable** (무료) 설치
2. Scriptable → `+` → `scripts/widget/msg-widget.js` 내용을 붙여넣고 이름을 `MSG`로 저장
3. 스크립트를 한 번 실행 → **MSG 주소**(예: `https://msg.example.ts.net`)와 **위젯 토큰**을 입력. 둘 다 iOS Keychain에만 저장됩니다
4. 잠금 화면 길게 누르기 → **사용자화** → 위젯 추가 → **Scriptable** → 원하는 모양 선택 → 위젯을 누르고 Script = `MSG`
   - 사각형: 실행 수 · 첫 세션 컨텍스트 % · 출력·턴·비용 · 허브 상태
   - 한 줄(시계 위): `MSG ▶1 · ctx 42% · ●`
   - 원형: 첫 세션 컨텍스트 % (세션이 없으면 실행 수)
5. 홈 화면 위젯(소·중·대)도 같은 스크립트로 됩니다. 대형은 세션 3개 + 좌석 사용량 + 허브까지 보여 줍니다

위젯을 누르면 `/mini` 페이지가 열립니다. 주소나 토큰을 바꾸려면 스크립트를 앱에서 실행해 **다시 설정**을 고르거나, 위젯 파라미터에 `reset`을 넣고 한 번 띄우면 됩니다.

서버에 닿지 않으면 위젯에 **오프라인**, 토큰이 거부되면 **토큰 거부됨 · 다시 설정**이라고 표시됩니다. iOS는 위젯을 대략 5~15분마다 갱신하므로 실시간은 아닙니다. 바로 보려면 `/mini`를 여세요.

## 4. Android (선택)

- 가장 간단한 방법은 Chrome에서 `/mini`를 열고 **홈 화면에 추가** (PWA)
- 홈 화면 위젯이 꼭 필요하면 **KWGT** 같은 HTTP 위젯 앱에서 `GET https://<MSG 주소>/api/mini/status` 를 헤더 `Authorization: Bearer <위젯 토큰>` 으로 불러와 `$wg(..., json, .sessions[0].contextPct)$` 식으로 값을 뽑아 쓰면 됩니다. 응답은 4 KB 미만의 JSON입니다

## 응답 필드 (참고)

`running`, `waiting`, `sessions[]` (title, model, account, contextPct, out, cacheRead, costUsd, turns, lastPrompt, state, updatedAgoMs, forMs), `seats[]` (label, left5h, leftWeek, resets5h, resetsWeek), `hub` (modes[], counts, worst), `generated_at`. 경로·비밀값은 서버에서 지우고 보냅니다.
