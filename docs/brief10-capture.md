# BRIEF10 캡처 재현

이 도구는 실제 빌드된 `dist/ui/index.html`의 App 전체 셸을 실행한다. 야핑봇·QUANT는 실제 `collectYapping` / `collectQuant`와 `liveHubDeps`로 읽고 `stripSecrets`를 거친다. 인증 성공 응답과 WebSocket hello의 세션·사용량·계정은 빈 검증용 데이터다. 배포 서버의 인증이나 거래 동작을 검증한 화면은 아니다.

Node 24에서 실행한다. 작업 디렉터리는 저장소 루트다.

```bash
npm exec --yes --package=node@24 -- node node_modules/vite/bin/vite.js build
npm exec --yes --package=node@24 -- node --import tsx scripts/brief10-preview.ts
```

두 번째 터미널에서 캡처한다.

```bash
npm exec --yes --package=node@24 -- node scripts/brief10-capture.mjs
```

서버는 `127.0.0.1:9410`에만 바인딩한다. 다른 빈 포트가 필요하면 두 명령에 동일한 `BRIEF10_PORT`를 지정한다(9400–9499 범위). 기존 프로세스는 중지하지 않는다. 완료하면 이 검증용 프로세스만 Ctrl-C로 종료한다.

Playwright는 저장소에 설치된 패키지를 먼저 찾고, 없으면 준비된 `/home/max/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`를 사용한다. `BRIEF10_PLAYWRIGHT=/절대/경로/playwright/index.mjs`로 바꿀 수 있다. package.json/lockfile 변경은 필요 없다.

브라우저는 기존 Playwright 캐시에서 가장 최신 Chromium을 찾아 실행하며 같은 빌드는 `chromium_headless_shell-N/chrome-headless-shell-linux64/chrome-headless-shell`을 우선한다. 현재 준비된 빌드는 1243이다. `BRIEF10_CHROMIUM=/절대/경로/chrome`으로 명시할 수 있으며 브라우저를 내려받지 않는다. 실제 실행 버전·경로는 `assertions.json`의 `browser`에 기록한다. 허브 폴링이 계속되므로 networkidle 대신 DOM 로드와 페이지 콘텐츠 준비를 기다린다.

`shots-yapquant/`에 데스크톱 1440×1000·모바일 390×844에서 두 탭의 PNG 4개, 각 화면 텍스트, 비밀 필드 제거 후의 `status.json`, `assertions.json`을 저장한다. 후자는 가로 넘침, 옛 로테이션 제거, X 3개·Telegram 3개 링크, 소스 상태 기본 접힘, 업비트1·2와 null 사유, 브라우저 오류·외부 요청을 기록한다. 누락은 실패 종료 코드로 남기며 실데이터를 가짜 수치로 바꾸지 않는다. 상위 소스의 당일 상태에 따라 실패할 수 있으므로 원인도 확인한다.

App은 고정 높이 셸 안에서 허브를 스크롤한다. 주 PNG 4개는 첫 화면이며, 그 아래 내용은 동일한 뷰포트에서 실제 스크롤한 `*-scroll-NN.png` 추가 화면으로 전부 기록한다. CSS나 화면 높이를 바꾸지 않으므로 모바일 카드·링크 배치를 그대로 검토할 수 있다. `assertions.json`의 `scrollShots`가 각 파일과 스크롤 위치를 기록한다.

HTTP 요청은 GET/HEAD만 허용한다. WebSocket은 빈 hello만 보내며 어떤 명령도 처리하지 않는다. 상위 HTTP 요청은 :8810/api/snapshot.json만 허용하고 리디렉션을 거부한다. 야핑봇은 수집기의 읽기 전용 SQLite·상태 파일 조회를 사용한다. :8095의 일부 GET은 상태를 변경하므로 이 호스트에서는 전부 차단한다. 다른 허브 수집기·프로덕션 서버·엔진·거래 API·프록시를 실행하지 않으며 ledger나 서비스 설정에 쓰지 않는다. 운영 서비스의 재시작·배포·push·merge·commit을 수행하지 않는다.

2026-11-02 02:12 KST 검증: Node 24.22.2, Chromium headless 153.0.8010.12(캐시 1243)에서 네 뷰의 32개 검증 모두 통과했다. 기본 PNG 4개와 추가 스크롤 PNG 23개를 생성했으며 콘솔·페이지 오류와 외부 요청은 없었다. 문서 폭은 데스크톱 1440px·모바일 390px 그대로였다. 재실행의 사실 기록은 `shots-yapquant/assertions.json`을 기준으로 한다.

## BRIEF10b override

The isolated preview now also permits exactly `http://127.0.0.1:8095/api/rising?limit=30` (GET, redirects rejected). Other :8095 routes remain blocked. Local yapping operational statistics are still read from local records. Set `BRIEF10B_RISING_FIXTURE=success` or `error` only for explicit synthetic Rising previews; the manifest labels that source. Use `scripts/brief10b-capture.mjs` for these screenshots. The original capture script rejects fixture mode to preserve its live-data claim and existing artifact names.
