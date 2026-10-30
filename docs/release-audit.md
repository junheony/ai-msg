# MSG 상업 출시 준비 감사

기준 커밋 `8dcfd09` (2026-10-29, `main`). 바깥 이름은 MSG. 코드·환경 변수·설정 경로는 `deck` / `ai-msg` / `~/.config/deck` 그대로다. 이 문서는 코드 변경이 아니라 출시 판단이다.

방법: 서버·UI·설치·CI를 읽고, 프로덕션 `npm audit`과 단위 테스트(`npx vitest run`)를 실행했다. `npm run test:e2e`는 로그인된 실제 계정의 토큰을 쓰므로 돌리지 않았다. 규모는 달력이 아니라 손대는 범위다. **작음**은 한 모듈과 테스트, **중간**은 여러 모듈, **큼**은 제품 결정이나 새 서브시스템이다.

약관 문단은 공개된 이용약관·보도를 읽은 요약이다. 법률 자문이 아니다. 판매 전에 담당 변호사가 현재 문서를 다시 읽어야 한다.

## 판정

**오늘, 일반 사용자에게 파는 상업 제품으로는 출시할 수 없다. 이미 CLI에 로그인된 단일 운영자의 자가 호스트(Linux systemd 또는 macOS LaunchAgent, Tailscale)로는 쓸 수 있다.**

자가 호스트가 성립하는 이유: 인증·Origin·Host·CSP·경로 검사·바인드 제한이 개인 셸치고는 단단하고, 단위 테스트 3,919건이 이 커밋에서 통과했다. 턴은 공식 CLI 자식 프로세스로만 나간다. 크래시 시 systemd `Restart=always`와 미처리 rejection을 죽이지 않는 처리가 있다.

일반 사용자 판매가 막히는 이유:

1. 제품의 핵심이 개인 구독(Claude 시트 A/B/C, Codex, Gemini `g1`/`g2`, Grok)으로 턴을 돌리고 계정을 나눠 쓰는 것이다. 2026년 Anthropic·OpenAI 공개 문서는 그 형태를 금지에 가깝게 적고 있다. MSG는 OAuth를 빼서 API를 직접 치지 않고 공식 CLI를 실행한다. 그 차이는 프록시 제품보다 낫지만, 판매용 하네스·계정 순환이라는 포지션을 없애지는 못한다.
2. 저장소는 공개 MIT이고 `version`은 `0.1.0`이다. 코드를 유료로 잠글 수 없다.
3. 설치는 `git clone` → Node 24 → 빌드 → 토큰 파일 → 각 CLI 로그인 → Tailscale이다. UI는 한국어이고, QR 페어링은 다음 버전으로 적혀 있다. macOS Finder 문구가 Linux 1급 호스트 화면에도 남아 있다.
4. 호스트를 옮기면 `pins.json`·`session-meta.json`·`session-state.json`이 따라가지 않는다. 사이드바는 인덱스에 없는 고정 id를 조용히 숨긴다.
5. `codex exec`와 Grok 헤드리스 세션이 최근 150칸을 채울 수 있다. Claude `claude -p` 일회성은 목록에서 빼는데, 이 둘은 빼지 않는다.

## 우선순위 10

| # | 할 일 | 심각도 | 규모 |
| --- | --- | --- | --- |
| 1 | 판매 형태를 정한다. 호스팅·시트 풀·계정 순환을 팔지 않는다. 공식 CLI를 사용자 머신에서만 실행하는 자가 호스트로 좁히거나, API 키 과금으로 바꾼 뒤에 변호사 확인을 받는다. | Blocker | 큼 |
| 2 | 유료화 전에 라이선스를 가른다. 이미 공개된 MIT 커밋은 회수되지 않는다. 이후 상업 코드는 별도 라이선스이거나, 과금 대상을 지원·호스팅으로 둔다. | Blocker | 큼 |
| 3 | `codex exec`·Grok `autoRun`을 Claude 헤드리스와 같이 기본 목록에서 뺀다. 검색·보관에서는 남긴다. | Blocker | 중간 |
| 4 | `~/.config/deck` 이전 명령과 문서를 만든다. 고정, 제목, 보관, 계정 핀, 권한, `memory.md`가 새 호스트에 보이게 한다. | Blocker | 중간 |
| 5 | 재로그인 창의 `agy`(인자 없음, 10분, 줄당 4,000자)를 자격 증명 파일이 생기면 닫거나, 코드 한 줄만 받게 한다. UI 문구 “다른 명령은 입력할 수 없습니다”와 `SECURITY.md`를 코드와 맞춘다. | High | 작음 |
| 6 | Grok 사용량 폴러가 `auth`에서 프로세스 수명 동안 멈추는 동작을 고친다. main에는 없고, [PR #7](https://github.com/junheony/ai-msg/pull/7)이 열려 있다. | High | 작음 |
| 7 | 온보딩을 한 경로로 맞춘다. README의 “SDK가 Claude 바이너리를 깔아 준다”는 문장은 지금 `package.json`과 다르다. macOS `com.deck.server`(소스+tsx)와 `ai-msg service`(번들)가 서로를 거부한다. | High | 중간 |
| 8 | 프로덕션 `zod@4.6.5`를 `>=4.6.6`으로 올린다. `npm audit --omit=dev`의 유일한 high. | High | 작음 |
| 9 | Linux CI를 실패시키게 한다. 문서상 1급 호스트인데 `ubuntu-latest`는 `continue-on-error`다. | High | 작음 |
| 10 | `hello`/`index`가 세션 전체를 매 변경마다 보내는 것을 줄이고, 수 GB Claude jsonl의 첫 읽기가 이벤트 루프를 오래 잡지 않게 한다. | Med | 중간 |

## 1. 블로커 — 판매 전에 닫을 것

| ID | 심각도 | 내용 | 근거 | 규모 |
| --- | --- | --- | --- | --- |
| B1 | Blocker | 개인 구독 위로 턴을 라우팅해 파는 것은 현재 공개 약관과 충돌한다. Anthropic 소비자 약관은 계정 공유를 금지하고, API 키나 명시적 허용이 아니면 봇·스크립트 등 자동 접근을 금지한다 (2025-10-08 시행본 §계정, §자동 접근). 2026-02 안내·보도는 Free/Pro/Max OAuth를 Claude Code·Claude.ai 밖으로 쓰는 것, 그리고 서드파티 하네스를 위반으로 적는다. OpenAI “Sign in with ChatGPT” 약관(2026-09-29)은 여러 계정, 사용량 나누기, 계정 순환, 한도 우회, 구독 풀링·재판매를 금지하고, 그 플랜을 쓰게 하면서 앱 이용료를 받지 말라고 한다. MSG는 토큰을 꺼내지 않고 `claude` / `codex exec` / `agy` / `grok`를 실행한다. Codex 경로는 SIWC 앱이 아니다. 그래도 제품 기능인 시트 순환(`자동`, 한도·Fable 캡에서 다른 Claude 계정으로 재시도)은 그 금지 문장과 같은 모양이다. 사용자가 자기 머신에서 자기 CLI를 쓰는 개인 도구로 둘 때와, 그 도구를 판매·호스팅할 때의 위험이 다르다. 호스팅해서 운영자 계정으로 여러 고객을 받는 형태는 약관 위반으로 보는 것이 맞다. | `README.md:338`, `src/server/routing/AutoRoute.ts` 파일 머리, `README.md` 계정 라우팅 절 | 큼 |
| B2 | Blocker | 공개 MIT라 유료 독점 제품이 성립하지 않는다. `private: true`는 npm 배포만 막을 뿐 GitHub 공개와 재배포를 막지 않는다. 받은 사람은 복사·수정·판매가 가능하다. 이미 푸시된 커밋의 MIT는 유지된다. | `LICENSE`, `package.json` `license` / `private` / `version` `0.1.0` | 큼 |
| B3 | Blocker | 자동 실행 세션이 사이드바를 채운다. Claude 헤드리스(`claude -p`)는 deck이 알거나 메타가 있을 때만 목록에 남는다. Codex는 `exec: true`를 달고 **모든** 사용자 스레드를 넣고, Grok 헤드리스는 `autoRun`만 붙인 채 목록에 남긴다. 화면은 최근 150개만 그리므로, 그 150이 자동 실행이면 사람이 연 대화는 검색 안으로 밀린다. | `src/server/sessions/SessionIndex.ts:298-304`, `src/server/sessions/CodexImports.ts:160-164`, `src/server/sessions/GrokImports.ts:112`, `src/ui/components/Sidebar.tsx:23`, `:446` | 중간 |
| B4 | Blocker | 호스트 이전에 고정·세션 메타가 없다. 전사본은 CLI 홈(`~/.claude`, `~/.codex`, `~/.grok`)에 있고, 고정·제목·보관·작업 폴더·계정 핀·모델·권한 모드·메모는 `DECK_CONFIG_DIR`(기본 `~/.config/deck`)에만 있다. 이전 명령이 없고 `docs/linux-host.md`는 라이브 적용 절차를 적지 않는다. macOS LaunchAgent는 `~/.config/deck/env`를 셸로 source하고, Linux 유닛은 `service.env`를 읽는다. 새 호스트에 인덱스가 없으면 사이드바는 `pins.json`에 id가 있어도 행을 그리지 않는다. | `src/server/config.ts:229`, `:252`, `src/server/server.ts:163`, `:174`, `:176`, `src/ui/components/Sidebar.tsx:214-218`, `docs/linux-host.md` 서두, `scripts/launchd/run.sh:5-9`, `src/server/cli/service/systemd.ts:20` | 중간 |

## 2. 갭 — 이어서 닫을 것

| ID | 심각도 | 내용 | 근거 | 규모 |
| --- | --- | --- | --- | --- |
| G1 | High | 제한 재로그인 창이 `agy`에서는 프로그램 전체다. 자리 id만 받고 argv는 서버가 고른다. Claude는 `auth login`, Codex는 `login`, Grok은 `login --device-auth`. `g1`/`g2`는 인자 없는 `agy`이고 HOME만 자리 홈으로 바꾼다. SSH 환경 변수를 넣어 헤드리스로 보이게 한다. 입력은 제어 문자·줄바꿈이 없는 한 줄, 최대 4,000자이며, 창이 살아있는 10분 동안 반복된다. Linux `script -c` 문자열은 바이너리를 작은따옴표로 감싸고, `stty cols`는 80–1000 정수만 넣는다. 셸 메타문자 주입은 이 경로에서 막혀 있다. 다만 `agy`가 로그인 뒤에 프롬프트를 실행하면, MSG Gemini 권한 매핑을 거치지 않는 두 번째 입력 통로가 된다. 화면 문구는 “다른 명령은 입력할 수 없습니다”이다. 헤드리스 `agy`가 코드만 받고 끝나는지는 이 저장소만으로 확인하지 못했다. | `src/server/authLogin/spec.ts:63-82`, `:102-110`, `:124-133`, `src/server/authLogin/hub.ts:20`, `:101-110`, `src/ui/components/AuthTerminal.tsx:120`, `SECURITY.md:13` | 작음 |
| G2 | High | Grok 구독 사용량 조회가 `auth`(그리고 `no_bin`, `unsupported`)에서 `stop()` 후 재시작 전까지 돌아오지 않는다. 다른 실패는 1시간부터 배가하며 최대 6시간까지 재시도한다. 로그인 만료 한 번이 카드를 멈춘다. | `src/server/usage/GrokBillingPoller.ts:13`, `:129-132`, 테스트 `GrokBillingPoller.test.ts`의 `auth` 케이스. 수정은 PR #7 | 작음 |
| G3 | High | 새 사용자 설치가 개발자 절차다. Node 24 미만은 `ai-msg`가 거절한다. README 빠른 시작은 `npm install`이 Claude Code 네이티브 바이너리(SDK 선택 의존성)를 깐다고 적지만, 의존성은 `web-push`, `ws`, `zod`뿐이다. `npm start`는 devDependency `tsx`로 소스를 실행한다. Linux 서비스는 `npm run build && npm run build:server` 뒤 `dist/server/bin.js`다. macOS `scripts/install-launchd.sh`는 `com.deck.server` + `node --import tsx`이고, `ai-msg service install`의 라벨 `local.ai-msg.server`는 그 레거시 에이전트가 있으면 설치를 거부한다. `~/Documents` 아래는 Full Disk Access가 필요하다. QR은 “다음 버전”이다. | `package.json` `engines`·`dependencies`·`scripts.start`, `README.md:52`, `src/server/cli/bin.ts:3-6`, `scripts/launchd/run.sh:17`, `src/server/cli/service/record.ts:6-12`, `src/ui/setupTexts.ts:39` | 중간 |
| G4 | High | 프로덕션 의존성 high 1건. `zod@4.6.5` — GHSA-mrhx-c7xc-m3w5, 제약 컬렉션 검증 중 메모리 고갈, 수정 `>=4.6.6` (`npm audit fix`가 이 패키지만 올린다). WebSocket 수신은 1 MiB에서 잘리므로 익명 인터넷 노출 수준의 구멍은 아니다. 쿠키를 가진 클라이언트의 부하이고, 그 클라이언트는 이미 셸에 가깝다. 그래도 패치 전에 두는 이유는 없다. dev 전용 high(`vite@8.3.1`, `undici@8.11.2` via jsdom, `source-map-js@1.2.1`)와 low(`katex@0.16.47`)는 프로덕션 서버 프로세스에 실리지 않는다. Vite 개발 서버를 꼬리넷에 열지 않는다. | `package.json` `zod`, `src/server/ws.ts:311-312`. 2026-10-29 `npm audit --omit=dev`: high 1 | 작음 |
| G5 | High | Linux가 문서상 1급 호스트인데 CI는 macOS만 실패로 게이트한다. `ubuntu-latest`는 `continue-on-error`. 최근 main 런(2026-10-29, run 40847917899)은 두 OS 모두 success였다. e2e는 CI에 없다. | `.github/workflows/ci.yml:19-20`, `:33-34`, `README.md` “Linux is a first-class host” | 작음 |
| G6 | Med | 세션이 수천 개면 목록 페이로드와 첫 읽기가 무겁다. 사이드바 DOM은 최근 150으로 잘리지만, `hello`/`index`는 프로젝트 배열 전체를 보내고 갱신 때마다 다시 보낸다. Codex 롤아웃 헤더는 파일당 2 MiB·동시 읽기가 있고, 이후 스캔은 stat 위주다. Codex 대화 열기는 끝 16 MiB만 읽는다. 검색은 64 MiB 초과 파일을 건너뛴다. Claude `readTranscript`는 기본 마지막 200메시지·도구 결과 8 KiB이고 메모리 캐시 64 MiB지만, 캐시가 없으면 파일 전체를 한 줄씩 읽는다. 수 GB jsonl의 첫 오픈이 그 경로다. 검색의 Claude 읽기는 `maxMessages: Infinity`라 64 MiB 미만 파일은 파싱 결과가 메모리에 쌓인다. 채팅은 가상 스크롤 없이 그 200개를 마크다운으로 그린다. 키 입력은 전사본을 다시 그리지 않도록 테스트되어 있다. | `src/server/ws.ts:358`, `src/ui/components/Sidebar.tsx:23`, `src/server/sessions/CodexImports.ts:15`, `src/server/engine/codexRollout.ts:239-243`, `src/server/sessions/search.ts:63-84`, `src/server/sessions/transcript.ts:419-420`, `:677-685`, `src/ui/components/Chat.tsx:619` | 중간 |
| G7 | Med | 단일 토큰이 곧 셸이다. 토큰은 64 hex, 파일 `0600`. 브라우저는 `sha256("deck-cookie:"+token)`만 쿠키로 가진다. `HttpOnly; SameSite=Strict; Path=/`, HTTPS(`x-forwarded-proto`)일 때만 `Secure`. 로그인마다 바뀌지 않고, 로그아웃은 쿠키만 지운다. 무효화는 토큰 파일 삭제다. 상태 변경 `/api`는 Origin 또는 `Sec-Fetch-Site: same-origin`. WebSocket 업그레이드는 Host 허용 목록 + 쿠키 + Origin. 바인드는 `127.0.0.1`과 Tailscale로 판정된 `100.64/10`뿐이고 `0.0.0.0`은 없다. 로그인 시도 제한은 없고, README가 그것을 적는다. 256비트라 추측은 비현실적이다. 꼬리넷 HTTP로 로그인하면 쿠키에 `Secure`가 없다. Tailscale 구간은 WireGuard로 감싸이나, 토큰을 가진 꼬리넷 기기는 그 머신의 셸이다. 다중 사용자는 없다. | `src/server/auth.ts:28-29`, `:69-71`, `:121-130`, `src/server/http.ts:104-120`, `:397-408`, `src/server/ws.ts:672-681`, `src/server/bind.ts:59-78`, `README.md:259` | 중간 (제품 범위). 속도 제한 자체는 작음 |
| G8 | Med | 위험 동작 전 승인이 엔진마다 다르다. Claude와 Grok은 승인 카드·감사 로그가 있다. Codex는 `approval_policy=never`와 샌드박스(기본 workspace-write + 네트워크, `danger-full-access` 없음)이다. Gemini는 모드 매핑이고 헤드리스는 승인을 물을 수 없어 거절로 남기는 경로가 있다. “모두 자동 승인”은 opt-in이다. Grok 쪽 검사는 샌드박스가 아니라 보고된 권한의 최선을 다한 확인이다. | `README.md` Codex 표, `docs/ARCHITECTURE.md` Codex sandbox 문단, `SECURITY.md` 범위 | 큼 (Codex에 카드를 얹는 일) |
| G9 | Med | 관측은 로그 한 줄이다. `console.error`/`journalctl`, 권한 감사 `audit.log`(입력 해시, 5 MiB에서 회전), 하이라이트 `events.jsonl` 7일, `/api/diag` 분당 30줄. 메트릭·트레이스·에러 수집은 없다. `scripts/monitor/deck-uptime.sh`는 별도 스크립트다. `ai-msg doctor`는 항상 종료 코드 0이다. | `src/server/http.ts:110-111`, `:418-424`, `src/server/audit.ts`, `src/server/cli/doctor.ts:1`, `SECURITY.md` “best-effort” | 중간 |
| G10 | Med | 갱신 경로가 호스트마다 다르다. Linux는 빌드 후 `service install`이 유닛의 절대 경로를 다시 쓴다. macOS LaunchAgent는 소스를 그대로 실행한다. 자동 업데이트·마이그레이션 버전은 없다. UI 빌드 id로 새로고침을 알리고, 서버 파일 mtime으로 “서버 업데이트 대기”를 띄운다. 내용이 같아도 타임스탬프가 바뀌면 갱신으로 센다. | `docs/linux-host.md` “코드를 갱신한 뒤”, `README.md` 서버 업데이트 문단 | 중간 |
| G11 | Low | `script` 바이너리는 `PATH` 조회다. 로그인 argv의 바이너리는 절대 경로만 받는다. 사용자 PATH를 바꿀 수 있는 주체는 이미 그 계정으로 명령을 실행할 수 있다. | `src/server/authLogin/pty.ts:15`, `src/server/authLogin/spec.ts:38-40` | 작음 |
| G12 | Low | 비밀 문자열 레드액션은 UI로 나가는 stderr·생각 블록 위주다. `sk-ant-`, Bearer, `token=` 형태, JWT, 40자 이상 hex. 토큰 파일 내용은 비-TTY 기동 로그에 찍지 않고, `login-url`은 TTY에만 `#token=`을 낸다. 해시가 브라우저 기록에 남을 수 있어, 로그인 직후 지워도 기록·화면 공유에는 토큰이 남는다. 도구 입력 원문은 감사 로그에 없고 해시만 있다. | `src/server/engine/redact.ts:5-20`, `src/server/cli/app.ts:27-28`, `:145-147`, `src/ui/App.tsx`의 `#token=` 처리 | 작음 |
| G14 | Med | 첫 화면 JS 청크가 500 kB를 넘는다. `vite build`가 `index-*.js` 507.43 kB (gzip 159.95 kB)에 경고를 냈다. 같은 빌드의 나머지는 react 218.83, vendor 253.98, 지연 로드 `mdEnhance` 267.06·`lowlight` 162.48, CSS 170.46 (gzip 31.28)이다. 분할은 의존성에는 적용됐고 앱 코드 청크에는 아직이다. | `vite.config.ts`의 `codeSplitting` 주석, 2026-10-29 `npm run build` 로그 | 중간 |
| G13 | Low | 경로 탈출은 세션 파일 API에서 막혀 있다. cwd는 홈(또는 loopback 전용 추가 루트) 안의 실제 디렉터리, 대상 realpath는 그 cwd 안, `O_NOFOLLOW`, 하드링크 `nlink>1` 거부, 홈 직하 dotfile·`Library`·`.ssh`·`.env`·키 파일 거부, deck 설정 디렉터리는 preview 거부. 정적 파일은 UI 루트 밖을 404. 미리보기 iframe은 로그인 없이 내려가나 `sandbox`와 `frame-ancestors 'self'`다. 모델이 돌아가는 CLI는 이 제한 밖의 사용자 권한이다. 제품은 셸 접근과 같다. | `src/server/dirs.ts:25-46`, `src/server/files.ts:109-177`, `src/server/http.ts:104-107`, `:368-376` | — (유지) |

## 3. 업그레이드 — Grok형 목표와 차이

목표: 짧고 빠른 답, 백그라운드와 완료 알림, 버튼 선택, 메모리, 예약, 위험한 일 전 승인, 자동 모델 배분.

| 목표 | 지금 | 격차 | 규모 |
| --- | --- | --- | --- |
| 짧고 빠른 답 | 간결 모드가 기본. 즉답, 생각·도구 접기, 설명 턴은 빠른 모델. | 자동 실행 목록과 큰 `index`가 체감 속도를 깎는다 (B3, G6). | 중간 |
| 백그라운드와 완료 알림 | `/bg`·작업으로. 동시 기본 3, 대기 20, 끝난 것 50. Web Push는 HTTPS PWA. 포그라운드 탭은 알림을 생략하고 iOS는 항상 띄운다(권한 회수 회피). http 꼬리넷 IP는 서비스 워커가 막힌다. | 푸시를 켜려면 `tailscale serve`가 필수인데 테스트가 그 명령을 돌리지 않는다. 일반 사용자 설명은 “홈 화면에 설치, iOS 16.4+”까지 가야 한다. | 중간 |
| 버튼 선택 | 마지막 답의 `deck-choices` 펜스가 카드가 되고, 누르면 그 문장을 보낸다. | 모델이 펜스를 안 내면 카드가 없다. 서버가 선택지를 강제하지 않는다. | 중간 |
| 메모리 | 설정 → 일반, `memory.md`, 최대 4,096바이트. 모든 엔진 턴에 숨은 맥락으로 들어가고 전사본 사용자 메시지로는 남기지 않는다. | 기기마다 메모리가 아니라 서버 한 장이다. 호스트를 옮기면 함께 안 간다 (B4). | 작음 (이전에 포함) |
| 예약 | 사용자 스케줄러가 없다. “예약 작업” 행은 CLI가 넣은 트랜스크립트 표시다. | Grok형 예약·리마인더. 승인 정책과 같이 설계해야 한다. | 큼 |
| 위험한 일 전 승인 | Claude·Grok 카드, 총사령탑은 기본 꺼짐이고 되돌리기 어려운 단계에서 선다. | Codex·Gemini는 G8. | 큼 |
| 자동 모델 | `AutoRoute`가 첫 턴의 종류·난이도·한도로 엔진·모델·effort를 고른다. Gemini·Grok은 설정에서 동의한 뒤에만. | `docs/ARCHITECTURE.md:38`은 여전히 “Gemini는 자동으로 고르지 않는다”고 적는다. 코드와 문서가 어긋난다. | 작음 (문서) |
| 모바일·PWA | `display: standalone`, 아이콘, `sw.js` 셸 캐시, 폭 720px 이하는 서랍·단일 창. 오프라인 HTML은 서버가 없을 때를 말한다. | 매니페스트 `lang`은 `ko`. 푸시는 HTTPS. 폰에서 토큰을 붙이는 절차가 남는다 (QR은 G3). | 중간 |
| 언어 | `index.html` `lang=ko`. 문자열은 한국어. README가 국제화를 로드맵으로 적는다. `setupTexts.ts` 주석이 i18n을 위한 모음이라고 한다. | 브랜드·키 이름(Enter, Tab, Esc, Desktop, Finder, Claude, GPT)이 섞인다. Linux에서도 “Finder 에서 보기 (서버 Mac)”이다. 영어 사용자는 설치 전에 막힌다. | 중간 |
| 빈 상태·오류 | 빈 채팅, 빈 사이드바, 검색 없음, 보관 없음, 연결 대기, 로딩 스켈레톤, 권한·한도 안내가 있다. | 고정이 조용히 사라지는 경우(B4)는 빈 상태가 아니라 데이터 손실처럼 보인다. 이유 문장이 없다. | 작음 |
| 패키징 | 바이너리 설치, 업데이트 채널, 라이선스 서버, 결제, 텔레메트리가 없다. | 판매 단위를 정한 뒤 (B1·B2). 개인 식별 텔레메트리는 자가 호스트 신뢰와 맞지 않으니, 로컬 진단·opt-in이 맞다. | 큼 |

## 4. 테스트·문서·이번 실행

| 항목 | 결과 |
| --- | --- |
| 단위 테스트 | 커밋 `8dcfd09`, Node v24.22.2, `npx vitest run --maxWorkers=4`: Test Files 300, Tests 3926, 45.0s, 종료 코드 0. 직전 커밋 `88c57c0`도 299 파일·3919 테스트·46.5s·종료 코드 0이었다. |
| `ws.outside.test.ts` | 이번 감사에서 실패하지 않았다. 파일은 프로세스 밖 세션을 실 WebSocket과 `outsidePollMs: 40`으로 본다. 공유 `beforeAll` 서버와 10초 테스트 제한이라 타이밍에 민감하다. Linux 잡이 `continue-on-error`이므로 거기서만 흔들려도 필수 체크는 초록으로 남을 수 있다. |
| e2e | `tests/e2e`, `DECK_E2E=1`. CI 밖. 실제 계정 토큰을 소비한다. |
| 문서 어긋남 | `README.md:52` SDK 문장. `docs/ARCHITECTURE.md:18` “서버 빌드 단계가 없다” — `npm run build:server`와 `dist/server/bin.js`가 있다. `:38` Gemini 자동 선택. 스크린샷은 README에 자리표시만 있다. CHANGELOG는 없다. `SECURITY.md`는 개인 프로젝트 best-effort이고, `agy` 창을 “코드 한 줄”로만 적는다 (G1). |
| 번들 | 진입 청크 507.43 kB로 500 kB 경고가 난다 (G14). react·vendor·수식/하이라이트는 그 아래이거나 지연 로드다. |

## 5. 실행 기록

감사 환경: Linux, Node v24.22.2 (이미지 기본 Node는 v22.23.4였다. `engines`가 24라 24를 설치한 뒤 `npm ci`).

`npm audit --omit=dev` (2026-10-29):

- high 1: `zod` `<4.6.6` (GHSA-mrhx-c7xc-m3w5). 설치본 `4.6.5`.
- dev 트리를 포함하면 high 4, low 4, critical 0. dev high는 `vite`, `undici`(jsdom), `source-map-js`.

단위 테스트 `8dcfd09`: 300 파일, 3926 테스트, 45.0초, 실패 0. `ws.outside.test.ts` 포함, 이번 실행에서는 흔들리지 않았다.

`npm run build` (Vite 8.3.1, 722 모듈, 0.4초): `dist/ui/assets/index-*.js` 507.43 kB (gzip 159.95 kB) — “Some chunks are larger than 500 kB”. `react` 218.83 (gzip 68.26), `vendor` 253.98 (gzip 74.83), `mdEnhance` 267.06 (gzip 80.28), `lowlight` 162.48 (gzip 51.56), `index.css` 170.46 (gzip 31.28). `dist/`는 커밋하지 않는다.

## 6. 판매한다면 최소한의 제품 문장

자가 호스트 1인, 그 사람이 이미 구매한 CLI 로그인, 그 머신의 셸과 같은 권한, 계정 순환은 사용자 본인의 약관 책임, 한국어 UI, Node 24, Tailscale HTTPS에서만 푸시. 호스팅 멀티테넌트와 “구독이 포함된다”는 판매는 이 코드의 약관·라이선스와 맞지 않는다.
