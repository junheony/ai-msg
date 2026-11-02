# BRIEF10c 캡처 재현

실제 빌드 App과 프로덕션 수집기·daily 파서를 사용한다. 일별 데이터만 명시적으로 선택한 검증 fixture로 대체할 수 있으며 기본값은 live다. 성공 fixture의 마지막 날짜는 실행 당일 KST 날짜다. 앱·수집기 시계를 고정하거나 과거 날짜로 바꾸지 않는다. 이전 BRIEF10/10b의 캡처 파일은 변경하지 않는다.

Node 24, 저장소 루트에서 빌드한다.

```bash
npm exec --yes --package=node@24 -- node node_modules/vite/bin/vite.js build
```

아래에서 비어 있는 검증 전용 포트를 고른다. 운영 서비스를 재시작하거나 기존 프로세스를 중지하지 않는다.

```bash
BRIEF10_PORT=9413 BRIEF10C_DAILY_FIXTURE=success npm exec --yes --package=node@24 -- node --import tsx scripts/brief10-preview.ts
```

별도 터미널에서 같은 포트를 대상으로 캡처한다.

```bash
BRIEF10_PORT=9413 npm exec --yes --package=node@24 -- node scripts/brief10c-capture.mjs
```

오류 화면은 별도의 빈 포트에서 `BRIEF10C_DAILY_FIXTURE=error`로 검증용 프로세스를 시작하고 캡처한다. 라이브 화면은 해당 변수를 생략한다. `BRIEF10B_RISING_FIXTURE`는 설정하지 않는다. 종료할 때 직접 시작한 검증용 프로세스만 종료한다.

캡처는 데스크톱 1440×1000, 모바일 390×844에서 `.yp-growth`부터 `.yp-daily` 끝까지 실제 허브 컨테이너를 스크롤한다. 앱 CSS·높이·배치는 변경하지 않는다. 합성 데이터에는 `SYNTHETIC DAILY FIXTURE` 표식을 추가하여 PNG에도 성격을 표시한다. 셸 인증 응답과 WebSocket hello는 기존 도구와 동일한 빈 fixture다. 검증 완료를 의미하는 배포·로그인·거래 화면은 아니다.

결과는 `shots-yapquant/brief10c-daily-{live|success|error}-{desktop|mobile}.png`와 필요시 `-scroll-NN.png`, 화면 텍스트, 소스 payload, assertions JSON으로 저장한다. 이전 작업의 파일명을 재사용하지 않는다. 검증 JSON에는 실제 브라우저 버전·경로, manifest의 데이터 출처, 콘솔·페이지 오류, 차단 요청, 뷰포트별 결과가 기록된다. 같은 시나리오 재실행은 해당 BRIEF10c 시나리오 파일만 갱신한다.

성공 fixture와 live에서는 daily 소스 연결 성공, 실제 payload와 DOM의 30개 날짜·조회·게시·팔로워 값 일치, 관측값 수에 맞는 조회·게시 막대, null 날짜에서 분리된 팔로워 경로의 각 x 좌표와 점 위치, `팔로워 기록은 14일치` 안내, 서버의 증감 KPI 출력 일치를 확인한다. 성공 fixture는 추가로 앞쪽 팔로워 null 16개, 14개 관측점으로 이루어진 팔로워 경로, 숫자 증감을 확인한다. 오류 fixture에서는 시간 초과 사유, 오래된 차트 제거, 데이터 없음 KPI를 확인한다. 모든 경우 모바일·데스크톱 가로 넘침과 콘솔 오류, 실제 캡처의 KPI 및 차트 제목 가림 여부를 검증하며 실패 시 종료 코드는 1이다. 필요한 경우 `-chart.png`로 가려지지 않은 차트 제목 화면을 별도 저장한다.

스크립트 작성 시 실행한 정적 확인: `node --check scripts/brief10c-capture.mjs`, `node --check scripts/brief10-capture.mjs`, `node --check scripts/brief10b-capture.mjs` — 모두 종료 코드 0. 실제 브라우저 실행 결과는 각 시나리오의 `*-assertions.json`에 기록된다.

검증 도구의 HTTP 상위 요청은 기존 QUANT snapshot, 정확한 Rising URL, 정확한 daily URL만 허용한다. `days=30` 이외 URL과 리디렉션은 거부한다. 다른 :8095 GET, 상태 변경 요청, 운영 서버 실행, 배포·push·merge·재시작을 하지 않는다. Playwright/Chromium 경로는 [기존 캡처 문서](brief10-capture.md)의 환경변수 규칙을 따른다.
