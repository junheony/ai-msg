# Quarterdeck 설치·패키징·계정 UI 구현 계획 (계획 ②) — 개정 1판

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **개정 1판 (2026-10-18):** 독립 교차 검토(Claude + GPT-6 Astra) 지적을 반영했다 — 설정 폴더 단일 인스턴스 락, listen 부분 실패 정리, 서비스 생존·종료 계약, 서비스 설정 기록, node 경로, 서비스 파일 소유권·롤백, 계정 파일 쓰기 안전, 설치 스모크 보강, 번들 검사, 라벨 고정. 지적별 반영 위치는 맨 끝 "검토 반영 기록".

**Goal:** 다른 기기에서 `npx <패키지>` 한 줄로 deck 서버가 뜨고, 웹 첫 실행 마법사가 네 CLI(claude·codex·agy·grok)의 설치·버전·로그인 상태를 보여 주며 Claude 프로필을 추가할 수 있고, Linux(systemd)·macOS(LaunchAgent)에서 상주 서비스로 등록할 수 있게 한다 — 이 맥의 기존 설치(저장소 + relaunch 루프 + `com.deck.server`)는 그대로 둔 채.

**Architecture:** 서버 코드는 그대로 두고 진입점만 둘로 나눈다: 저장소 실행용 `src/server/main.ts`(지금 경로 유지 → `run.sh` 무변경)와 패키지용 CLI `src/server/cli/`(`start`·`doctor`·`service`·`login-url`). 서버는 시작하자마자 **설정 폴더 락(`<configDir>/server.lock`)을 잡고 포트를 연 뒤에야** 설정 폴더에 쓴다 — 같은 폴더를 두 서버가 나눠 쓰는 일을 구조적으로 막는다. esbuild 가 CLI·서버·Claude 자식 스크립트 둘을 `dist/server/*.js` 로 묶고, `prepack` 이 UI(`dist/ui`)와 서버 번들을 만든다. 개인 도구 경로(claude-pick·offload·usage-deck)는 `integrations.ts` 한곳으로 모아 "있을 때만" 쓰고, 첫 실행 감지는 각 CLI 의 공식 명령 출력만 읽는 `setup/detect.ts` 하나를 웹 마법사와 `doctor` 가 같이 쓴다. 상주 서비스는 지금 relaunch 방식과 같은 **생존·종료 계약**(아래 절)을 systemd·launchd 에 똑같이 적용한다.

**Tech Stack:** TypeScript(Node 24, ESM), esbuild(devDependency, 이미 tsx·vite 를 통해 0.28.2 설치돼 있음), vitest + @testing-library/react, React 19, 쉘 스크립트(pack 스모크).

**Spec:** `docs/superpowers/specs/2026-10-15-quarterdeck-paid-design.md` §5.1, §7(2~3주차), §10-2. 정책 규칙은 같은 스펙 §3, Claude CLI 엔진은 `docs/superpowers/plans/2026-10-15-claude-engine-cli.md`, Grok 은 `docs/superpowers/specs/2026-10-18-grok-engine-design.md`, Gemini 는 `docs/gemini-spike.md`.

## Global Constraints

- **선행 조건:** Grok 엔진 연결 작업(작업 트리의 미커밋 변경: `main.ts`·`config.ts`·`GrokEngine.ts`·`protocol.ts` 등)이 커밋된 뒤 시작한다. Task 1 첫 단계에서 `git status --short` 가 깨끗한지 확인하고, 아니면 멈추고 보고한다.
- Node `>=24` 유지(`engines.node`). 최소 버전을 낮추지 않는다.
- 런타임 의존성은 서버가 실제로 import 하는 `ws`·`zod`·`web-push` 셋뿐이다. 새 런타임 의존성 금지. 새 devDependency 는 `esbuild` 하나.
- deck 은 어떤 CLI 에도 로그인하지 않고, 토큰 파일·`auth.json`·`.credentials.json`·키체인을 읽지 않는다. 로그인 상태는 공식 명령의 **출력/종료 코드만**: `claude auth status --json`(필드 `loggedIn` 만, 로그아웃이면 종료 코드 1 — 2.1.283 실측), `codex login status`(0 = 로그인, 1 + "Not logged in" — 0.159.2 실측), `agy models`(종료 코드 0 = 로그인), `grok models`(첫 비지 않은 줄 "You are logged in" / "You are not authenticated", 종료 코드는 항상 0). 로그인은 "터미널에서 `<명령>` 하세요" 안내만.
- `claude auth status` 출력의 `email`·`orgId`·`orgName` 은 읽지도, 로그에 쓰지도, API 응답에 싣지도, 저장하지도 않는다. 프로브의 stdout/stderr 원문은 로그에 쓰지 않는다(종료 코드·분류만).
- **설정 폴더 쓰기 순서:** 서버(`startServer`)는 ① 설정 폴더 락 확보 ② 모든 주소 listen 성공 — 이 둘이 끝나기 전에는 설정 폴더에 락 파일 외에 아무것도 쓰지 않는다(토큰·VAPID·transcript 캐시·activity·쿨다운·push 포함). 실패하면 락을 지우고, 이번에 만든 빈 설정 폴더도 지운다.
- **CLI 자식 환경:** deck 이 띄우는 모든 CLI 자식(claude·codex·agy·grok, 감지 프로브 포함)의 env 에서 관리자 표식 변수(`XPC_SERVICE_NAME`·`INVOCATION_ID`·`JOURNAL_STREAM`·`SYSTEMD_EXEC_PID`·`MANAGERPID`·`NOTIFY_SOCKET`·`LISTEN_PID`·`LISTEN_FDS`·`DECK_SUPERVISOR`·`DECK_SUPERVISED`)를 지운다(Task 7).
- 테스트는 전부 `fs.mkdtemp(path.join(os.tmpdir(), …))` 임시 HOME·임시 configDir 로. 실제 `~/.config/deck`·`~/Library/LaunchAgents`·`~/.config/systemd` 에 쓰지 않는다. 테스트 안에서 실제 `launchctl`·`systemctl` 을 실행하지 않는다(실행 함수 주입). `plutil -lint`·`systemd-analyze verify` 는 임시 파일 대상으로만, 있을 때만.
- 실행 중인 서버를 건드리지 않는다: `npm run restart` 금지, 서버 신호 금지, `install-launchd.sh`·`relaunch.sh` 실행 금지.
- 저장소의 `dist/` 에 쓰지 않는다(이 맥의 서버가 `dist/ui` 를 실시간으로 내보낸다). 따라서 저장소에서 `npm run build`·`npm pack` 을 직접 돌리지 않는다. UI 빌드 확인은 `npx vite build --outDir "$(mktemp -d)"`, 서버 번들 확인은 `node scripts/build-server.mjs --outdir "$(mktemp -d)"`, 패키지 확인은 `scripts/pack-smoke.sh`(커밋된 트리를 임시 디렉터리에 풀어 `npm ci` 로 빌드한 뒤 pack)로만.
- `src/server/main.ts` 경로와 동작(직접 실행하면 서버 시작)은 유지한다 — 설치된 `relaunch.sh`→`scripts/launchd/run.sh` 가 `node --import tsx src/server/main.ts` 로 띄운다. `scripts/launchd/*`·`relaunch.sh`·`restart.sh`·`install-launchd.sh` 는 수정하지 않는다(이 맥 전용으로 남김, 패키지에는 안 들어감).
- 설정 디렉터리 기본값은 이 맥과 같은 `~/.config/deck`. 기존 env 이름(`DECK_*`)·포트 기본값 9320 유지.
- 새 사용자 문자열은 한국어로 쓰되 `src/server/setup/texts.ts`·`src/ui/setupTexts.ts` 두 파일에 모은다(계획 ③ i18n 이 그대로 키로 옮길 수 있게). 서비스·락 문구도 `setup/texts.ts` 에.
- Claude 자식 스크립트(`hookRelay.ts`·`permissionMcp.ts`)는 계속 `node:` 내장 모듈만 import 한다.
- 공개 위생: 새 파일은 `src/hygiene.test.ts` 를 통과해야 한다(홈 경로·작업 폴더명·tailnet 이름 금지). pack 결과물도 같은 검사를 통과해야 한다.
- 테스트 실행은 `--maxWorkers=2`.
- **D1(패키지 이름·npm 조직)은 Task 8 전에 정해져 있어야 한다.** Task 1~7 은 이름 없이 진행할 수 있다(스모크는 이름을 하드코딩하지 않음). Task 8 시작 때 D1 이 미정이면 멈추고 보고.

## Review Focus

1. **자식 스크립트가 `node_modules` 안에서 안 뜬다.** Node 의 타입 제거는 `node_modules` 아래 `.ts` 를 거부한다 → 패키지 설치본에서 `node …/hookRelay.ts` 가 실패하면 모든 Claude 권한 요청이 "relay 실패"로 거부된다. 기대: 패키지에서는 번들된 `.js` 를 띄운다. → Task 3 의 `childScripts.test.ts` + pack 스모크의 가짜 `claude` 권한 왕복(hookRelay·MCP 모두).
2. **번들 안의 "직접 실행이면 main()" 검사 오발.** `hookRelay`/`permissionMcp` 모듈이 `app.js` 에 함께 묶이면 `import.meta.url === argv[1]` 비교가 엉뚱하게 참이 될 수 있다. 기대: 서버 번들에는 두 모듈이 없다. → Task 3 빌드 스크립트의 metafile 검사(실패 시 빌드 중단).
3. **이 맥처럼 `accounts.json` 없이 자동 발견으로 돌던 설치에서 첫 프로필 추가.** 새 계정 하나만 적힌 파일이 생기면 a/b/c 가 사라지고 home 이 바뀐다. 기대: 추가 시점에 다시 발견한 계정 전부(id·폴더·home·카드 id 동일)를 먼저 파일로 옮겨 적고 새 계정을 덧붙인다. → Task 5 `materialize round-trip` 테스트.
4. **이 맥에서 `npx` 를 실행했을 때 9320 포트에 이미 deck 이 떠 있음.** 기대: 기존 서버를 건드리지 않고(신호 없음) "이미 실행 중 — 주소 / 별도 인스턴스는 `--port` + `DECK_CONFIG_DIR`" 한 줄로 종료 코드 1, 설정 폴더에 아무것도 쓰지 않음. → Task 2 `PortInUseError`·`InstanceLockedError` 테스트, Task 7 거부 테스트.
5. **`npx` 캐시 경로를 가리키는 서비스.** `~/.npm/_npx/<hash>/…` 는 캐시 정리 때 사라져 서비스가 조용히 죽는다. 기대: `service install` 은 경로에 `/_npx/` 가 있으면 "전역 설치(`npm i -g`) 뒤 다시" 안내로 거부. → Task 7 테스트.
6. **같은 설정 폴더에 서버 둘.** `--port 9400` 으로 두 번째 서버를 띄우면 같은 `~/.config/deck` 의 token·activity·쿨다운·push 를 덮어쓴다. 기대: 두 번째는 락에서 거부, 폴더 무변경. 낡은 락(죽은 pid)은 넘겨받는다. → Task 2 `instanceLock.test.ts`.
7. **서비스 종료가 진행 중 턴을 죽이거나, 크래시 뒤 고아 자식이 새 서버와 겹친다.** 기대: 정상 종료는 drain 뒤 종료(관리자는 그동안 자식에게 신호 안 보냄), 크래시는 그 서버의 자식 전부 정리 후 새 서버. → "서비스 생존·종료 계약" + Task 7 + Task 8 실기 확인.
8. **버전 경로 node 를 가리키는 서비스.** `process.execPath` 가 Homebrew Cellar·nvm·fnm·volta 경로면 node 업그레이드 때 서비스가 죽고 macOS 권한(TCC)도 잃는다. 기대: 안정 심링크로 바꾸거나 거부. → Task 7 `nodePath.test.ts`.

---

## 현재 결합 지점 (작업 트리 기준 2026-10-18, Grok 작업 커밋 뒤 줄 번호가 조금 밀릴 수 있음)

| 위치 | 결합 | 처리 |
|---|---|---|
| `src/server/config.ts:182` | `DECK_CONFIG_DIR \|\| ~/.config/deck` 고정, `XDG_CONFIG_HOME` 무시, 상대 경로 그대로 | Task 1 `resolveConfigDir`(절대화) |
| `src/server/config.ts:186`, `:81` | usage-deck 주소 파일 `~/.config/claude-pick/deck_url` | Task 1 `integrations.ts` 로 격리(있을 때만) |
| `src/server/config.ts:94-109`, `:191` | 보호 계정 `~/.config/offload/protect`(+`CLAUDE_PROTECT`) | Task 1 격리: `<configDir>/protect` 우선, 옛 경로는 있을 때만 |
| `src/server/config.ts:111`, `:128-132` | usage-deck 기본 주소 `127.0.0.1:9310`, 모드 판정 | 유지 — 주소를 설정했거나 응답 기록이 있을 때만 usage-deck(계획 ①에서 이미 격리) |
| `src/server/usage/UsageService.ts:153` | `opts.mode ?? 'usage-deck'` | Task 1: 기본값을 `'cli'` 로 |
| `src/server/routing/cooldown.ts:6-10`, `:40`; `TurnRunner.ts:1904` | 쿨다운 폴더 `${XDG_CACHE_HOME \|\| ~/.cache}/offload/cooldown` 을 claude-pick·offload 와 공유, 새 기기에서도 그 폴더를 만듦. `XDG_CACHE_HOME` 이 있으면 기존 `~/.cache/offload/cooldown` 을 놓침 | Task 1: 옛 폴더(두 후보)가 있을 때만 공유, 없으면 `<configDir>/cooldown` |
| `src/server/config.ts:156-158`, `:207` | `repoRootDefault()`(모듈 위치 두 단계 위) → `uiDir = <repo>/dist/ui` | 유지 — 번들 위치 `dist/server/app.js` 에서도 두 단계 위 = 패키지 루트. Task 3 의 `import.meta.url` 전수 표 + 스모크 UI 응답으로 확인 |
| `src/server/serverUpdate.ts:10` | 재시작 대기 감지가 `src/server`·`src/shared` mtime 을 봄 | 유지 + Task 7: 패키지 실행이면 디스크의 `package.json` 버전이 실행 중 버전과 다를 때 `restartNeeded` |
| `src/server/engine/ClaudeEngine.ts:37-39` | 자식 스크립트를 `claudeCli/*.ts` 로 고정 | Task 3 `childScript()` + Task 7 실행 시점 사본 |
| `src/server/main.ts:69`(`loadOrCreateToken`), `:58-67`(transcript 캐시), `:230`(listen) | listen 전에 토큰·캐시·스토어가 설정 폴더에 씀; listen 은 마지막, 일부 주소만 열린 채 실패하면 그대로 남음 | Task 2: 락 → `listenAll`(부분 실패 정리) → 그다음 쓰기 |
| `src/server/main.ts:251-258` | 모듈을 불러오기만 해도 `main()` 실행 | Task 2: 본문을 `server.ts` 로, `main.ts` 는 얇은 진입점 |
| `src/server/main.ts:215`; `serverUpdate.ts:62-63`, `:92-112`; `config.ts:224` | "관리자 있음" = `DECK_SUPERVISED=1` + 부모가 `relaunch.sh` + `relaunch.pid` | Task 7: `DECK_SUPERVISOR=systemd\|launchd` 판정 추가(relaunch 판정은 그대로) |
| `src/server/lifecycle.ts`(`installGracefulShutdown`, `drain`), `config.ts:230`(`DECK_DRAIN_MAX_MIN`, 기본 무한) | SIGTERM/USR2 → drain → 종료. relaunch 루프는 옛 서버가 끝난 뒤에야 새 서버를 띄움 | "서비스 생존·종료 계약"의 기준. 서비스 설치는 drain 상한을 유한값으로 기록(Task 7) |
| `src/server/engine/GrokEngine.ts:429` | grok 자식을 `detached: true`(새 프로세스 그룹)로 띄움 → launchd 프로세스 그룹 정리에서 빠짐 | Task 7 자식 기록(`run/children.json`)·낡은 락 인수 시 정리 |
| `src/server/engine/claudeCli/args.ts:139`(`claudeEnv`), `shared/accounts.ts:234`(`codexEnv`), `:252`(`geminiEnv`), `engine/grokEnv.ts:25`(허용 목록) | 서버 env 를 거의 그대로 자식에 넘김 | Task 7 `stripSupervisorEnv` 적용(grok 은 허용 목록에 없음을 테스트로 고정) |
| `src/server/http.ts:61`, `:74`; `crash.ts:11`; `lifecycle.ts:2,8`; `main.ts:239` | 문구·주석이 relaunch 루프·launchd 전제 | Task 7: `UNSUPERVISED_MESSAGE` 에 `quarterdeck service install` 안내. 주석은 손대지 않음 |
| `src/server/accounts.ts:34-56`, `:101-124` | 계정 = `accounts.json`, 없으면 `~/.claude`, `~/.claude-<한 글자>` 자동 발견 | 유지 + Task 5 프로필 추가(파일 물질화, 안전한 쓰기) |
| `src/shared/accounts.ts:73`, `:115` | `LEGACY_CARD` a/b/c → claude-pick 카드 id | 유지 — usage-deck 모드에서만 읽힘. 물질화할 때 `card` 를 쓰지 않아 기본값이 그대로 재계산됨(Task 5 테스트) |
| `src/shared/accounts.ts:197`; `src/ui/accounts.ts:6`, `:93`, `:96` | `LEGACY_ACCOUNTS`(a/b/c)를 UI 기본 컨텍스트로 | 유지 — `accounts` 를 안 보내는 옛 서버 호환용. 새 서버는 항상 보냄 |
| `src/server/engine/claudeCli/version.ts:61-65`, `CodexEngine.ts:364`, `GeminiEngine.ts:240`, `config.ts:172`(`resolveGrokBin`: `DECK_GROK_BIN` → PATH → `~/.grok/bin/grok`) | 바이너리 탐색: `DECK_*_BIN` → PATH → 홈 아래 설치 위치 | 유지. 감지·doctor 는 `loadConfig` 가 고른 경로를 그대로 씀(Task 4). 서비스 설치 때 해석된 절대 경로를 서비스 기록에 적음(Task 7) |
| `src/ui/components/Login.tsx:16` | "`~/.config/deck/token` 의 내용을 입력하세요" | Task 6: `login-url` 안내 + `#token=` 자동 로그인 |
| `src/server/bind.ts:18`; `files.ts:254-259`; `tccDenial.ts` | Tailscale.app 경로, Finder 열기, TCC 안내 — macOS 전용 | 유지 — 다른 OS 에선 없음/501 로 이미 처리됨 |
| `src/server/sessions/ProcessHolders.ts:72` | `ps -axww -o pid=,ppid=,command=`, grok 이 떠 있을 때만 `lsof`(터미널 grok 의 작업 폴더) | 유지, Task 8 Linux 확인 항목(procps 경고 여부, `lsof` 가 없는 배포판에서 경고 없이 꺼지는지) |
| `src/server/config.ts` `grokBotDir`·`geminiStateDir`·`importTmpDir`; `GeminiImports.ts` | 다른 앱 대화 가져오기(2026-10-18): Grok Bot 캐시는 macOS 경로만(다른 OS 는 null), agy 대화는 `node:sqlite` 로 임시 복사본을 `<configDir>/tmp/gemini-import` 에서 읽음 | 유지 — 설정 폴더 해석(Task 1)을 따라감. pack 스모크(Task 3)에서 `node:sqlite` 가 실험 기능 경고 없이 로드되는지(Node `>=24`) 확인 |
| `src/server/config.ts:221` | Claude Desktop 세션 경로 `~/Library/Application Support/…` | 유지 — 없으면 빈 목록 |
| `scripts/launchd/run.sh:17` | `exec node --import tsx src/server/main.ts` | 유지(경로 고정이 Task 2 제약의 이유) |
| `scripts/relaunch.sh:14-16`, `:86-88` | `~/.config/deck`, `env -i … PATH=…/opt/homebrew/bin… LANG=ko_KR.UTF-8 SHELL=/bin/zsh`, `relaunch.pid` | 이 맥 전용으로 유지, 패키지 제외. 관리자 없는 시작은 `relaunch.pid` 루프가 살아 있으면 거부(Task 2) |
| `scripts/install-launchd.sh:13-18`, `scripts/launchd/com.deck.server.plist`, `boot.mjs:16-17` | 라벨 `com.deck.server`, `~/.config/deck/boot.mjs` | 이 맥 전용으로 유지. 패키지 서비스는 다른 라벨(Task 7, D8) |
| `scripts/restart.sh:16`, `:27`, `:35` | 포트 9320, `lsof`, `~/.config/deck/activity.json` | 이 맥 전용으로 유지 |
| `package.json` | `private: true`, `start: tsx …`, react 등 UI 전용 패키지가 dependencies, `bin`·`files` 없음 | Task 3 |

## 서비스 생존·종료 계약 (Task 2·7 이 지키는 기준)

지금 relaunch 방식(옛 서버 drain → 종료 확인 → 새 서버)을 기준으로, 관리자가 누구든 같은 결과가 나오게 한다.

| # | 계약 | relaunch(이 맥, 무변경) | systemd 사용자 유닛 | launchd LaunchAgent |
|---|---|---|---|---|
| S1 | 설정 폴더 하나에 서버 하나 | 루프 pidfile + 새 서버 락 | 락(Task 2) — systemd 는 같은 유닛을 둘 띄우지 않음 | 락 — launchd 는 같은 라벨을 둘 띄우지 않음 |
| S2 | 정상 종료·재시작은 drain: 새 턴 거부, 진행 중 턴·백그라운드 작업은 drain 상한까지 끝나게 두고, 상한이면 `abortAll` 로 자식 정리 후 종료 코드 0 | USR2 → drain | `systemctl --user stop/restart` → SIGTERM 은 메인에게만(`KillMode=mixed`), 서버가 drain | `launchctl kickstart -k`/`bootout` → SIGTERM, 서버가 drain |
| S3 | 관리자의 강제 종료 시한 = drain 상한 + 여유 2분, **최대 30분**. 서비스 설치는 drain 상한을 유한값으로 기록(기본 25분, 1~28분) | 무한(현행) | `TimeoutStopSec=<drain×60+120>`(≤1800) | `ExitTimeOut=<같은 값>` |
| S4 | 서버 프로세스가 끝나면(정상·크래시 모두) 남은 자식은 전부 죽는다 — 새 서버가 뜨기 전에 | 현행 | `KillMode=mixed`: 메인 종료 뒤 cgroup 의 나머지에 SIGKILL | `AbandonProcessGroup=false`(launchd 가 작업의 프로세스 그룹을 정리). `detached` 자식(grok)은 그룹 밖이므로 S5 |
| S5 | 그룹 밖 자식(detached)은 서버가 `<configDir>/run/children.json` 에 pgid·bin·시작 시각을 기록하고, 낡은 락을 넘겨받은 새 서버가 살아 있는 기록 그룹(명령이 기록 bin 과 일치할 때만)에 SIGTERM → 5초 → SIGKILL | 같은 코드 | 같은 코드(보통은 cgroup 이 먼저 정리) | 같은 코드 |
| S6 | "지금 재시작"(UI) = drain 뒤 종료 코드 0 → 관리자가 다시 띄움 | 루프가 다시 띄움 | `Restart=always` | `KeepAlive=true` |
| S7 | 실행 중 패키지 파일이 교체돼도(`npm i -g` 새 버전) 실행 중 서버의 동작은 바뀌지 않는다 — 자식 스크립트는 시작 때 `<configDir>/run/<버전>/` 에 복사한 사본으로 띄우고, 새 버전 감지 시 "재시작 필요"만 표시 | 해당 없음(저장소 실행) | 같음 | 같음 |

이 계약에서 벗어나는 동작(예: 로그아웃 시 linger 없는 systemd 사용자 서비스가 drain 동안 로그아웃을 늦춤)은 README 에 적는다. S2~S4 는 Task 8 실기 확인 항목이다.

## File Structure

새 파일:

| 파일 | 책임 |
|---|---|
| `src/server/paths.ts` | `resolveConfigDir`(절대화·XDG 규칙) |
| `src/server/integrations.ts` | 개인 도구 연동 경로(usage-deck 주소 파일, 보호 계정 파일, 쿨다운 폴더) — 있을 때만 |
| `src/server/instanceLock.ts` | `acquireInstanceLock`, `readInstanceLock`, `InstanceLockedError` — `<configDir>/server.lock`(pid·port·주소·버전) |
| `src/server/server.ts` | 지금 `main.ts` 의 `main()` 본문 → `startServer()`, `listenAll`, `PortInUseError` |
| `src/server/cli/args.ts` | `parseCli` |
| `src/server/cli/app.ts` | `runCli` — 명령 분기, 시작 안내(로그인 주소), 포트·락 충돌 문구 |
| `src/server/cli/bin.ts` | 패키지 `bin`: Node 버전 확인 뒤 `./app.js` 를 동적 import |
| `src/server/cli/doctor.ts` | `formatDoctor` |
| `src/server/cli/service/index.ts` | `serviceAction` — 플랫폼 분기, 거부 조건, 확인·롤백 |
| `src/server/cli/service/record.ts` | `ServiceRecord`(`<configDir>/service.json` + `service.env`), 생성 파일 표식 |
| `src/server/cli/service/nodePath.ts` | `stableNodePath` — 안정 심링크 선택, 버전 관리자 경로 거부 |
| `src/server/cli/service/systemd.ts` | `systemdUnit`, `systemdQuote` |
| `src/server/cli/service/launchd.ts` | `launchAgentPlist` |
| `src/server/supervisorEnv.ts` | `stripSupervisorEnv`, `SUPERVISOR_ENV_KEYS` |
| `src/server/childRegistry.ts` | detached 자식 기록·낡은 기록 정리(S5) |
| `src/server/engine/claudeCli/childScripts.ts` | `childScript` — `.js`(번들) 우선, 없으면 `.ts`(저장소); `snapshotChildScripts`(S7) |
| `src/server/setup/detect.ts` | 네 CLI 감지·버전·로그인 프로브, 출력 해석기 |
| `src/server/setup/texts.ts` | 마법사·doctor·서비스·락의 서버 쪽 한국어 문구, 로그인 안내 명령 |
| `src/server/setup/profiles.ts` | `addClaudeProfile`, `materializeAccountsConfig` |
| `src/server/setup/SetupStore.ts` | `<configDir>/setup.json`(`pending`/`done`/`migrated`) |
| `src/server/setup/SetupService.ts` | 프로브 캐시(30s, 단일 실행) + `SetupStatus` 조립 |
| `src/shared/setup-types.ts` | `EngineId`, `LoginState`, `EngineProbe`, `ClaudeProfileProbe`, `SetupStatus` |
| `src/ui/setupApi.ts` | `/api/setup*` 호출 |
| `src/ui/setupTexts.ts` | 마법사 UI 한국어 문구 |
| `src/ui/loginHash.ts` | `readHashToken` |
| `src/ui/components/SetupWizard.tsx` | 첫 실행 마법사(엔진 → Claude 프로필 → 접속 주소 → 완료) |
| `scripts/build-server.mjs` | esbuild 번들 + metafile 검사(자식 모듈 혼입·외부 import) |
| `scripts/pack-smoke.sh` | 커밋된 트리 → 임시 `npm ci`·pack → 전역 설치·`npx` 스모크 |
| `scripts/smoke/fake-claude.mjs` | 스모크용 가짜 `claude`: 받은 `--settings`·`--mcp-config` 의 명령을 그대로 실행해 권한 왕복 |
| `scripts/smoke/turn.mjs` | 스모크용 WS 클라이언트: 로그인 → 세션 → 턴 → 권한 카드 승인/거부/무응답 |

수정: `src/server/config.ts`, `src/server/routing/cooldown.ts`, `src/server/usage/UsageService.ts`, `src/server/main.ts`, `src/server/engine/ClaudeEngine.ts`, `src/server/engine/GrokEngine.ts`(자식 기록), `src/server/engine/claudeCli/args.ts`, `src/shared/accounts.ts`(env 정리), `src/server/serverUpdate.ts`, `src/server/http.ts`, `src/server/ws.ts`, `src/shared/protocol.ts`, `src/ui/App.tsx`, `src/ui/components/Login.tsx`, `src/ui/components/SettingsView.tsx`, `package.json`, `package-lock.json`, `README.md`, `README.ko.md`.

---

### Task 1: 설정 경로 해석과 개인 도구 연동 격리

**Files:**
- Create: `src/server/paths.ts`, `src/server/integrations.ts`
- Modify: `src/server/config.ts:181-202`(configDir·deck_url·protect·cooldown 계산), `src/server/routing/cooldown.ts:6-10`, `src/server/usage/UsageService.ts:153`
- Test: `src/server/paths.test.ts`, `src/server/integrations.test.ts`, `src/server/config.test.ts`(추가)

**Interfaces:**
- Produces:
  - `resolveConfigDir(env: NodeJS.ProcessEnv, home: string, o?: { exists?: (p: string) => boolean; cwd?: string }): string` — 항상 절대 경로. `DECK_CONFIG_DIR`(`~/` 로 시작하면 home 확장, 상대 경로면 `cwd`(기본 `process.cwd()`) 기준 절대화 — 서비스는 Task 7 이 절대 경로를 기록하므로 cwd 차이가 없다) → `<home>/.config/deck` 가 있으면 그것 → `${XDG_CONFIG_HOME}/deck`(XDG 규칙대로 **절대 경로일 때만**, 상대면 무시) → `<home>/.config/deck`.
  - `type LegacyIntegrations = { deckUrlFile: string | null; protectFile: string | null; cooldownDir: string }`
  - `legacyIntegrations(env: NodeJS.ProcessEnv, home: string, configDir: string, exists?: (p: string) => boolean): LegacyIntegrations` — `deckUrlFile`: `<home>/.config/claude-pick/deck_url` 가 있을 때만. `protectFile`: `<configDir>/protect` → `<home>/.config/offload/protect` → null. `cooldownDir`: `CLAUDE_PICK_COOLDOWN_DIR`(있으면 없어도 그대로) → `${XDG_CACHE_HOME}/offload/cooldown`(절대 경로이고 **있으면**) → `<home>/.cache/offload/cooldown`(**있으면** — `XDG_CACHE_HOME` 이 설정돼 있어도 이 맥의 기존 폴더를 놓치지 않게) → `<configDir>/cooldown`.
  - `defaultCooldownDir` 는 삭제하고 호출처는 `cfg.cooldownDir` 만 쓴다. `DeckConfig` 모양은 바뀌지 않는다.
  - `loadConfig` 는 설정 폴더에 쓰지 않는다(읽기만) — Task 2 의 "락·listen 전 무쓰기" 전제. 테스트로 고정.

- [ ] **Step 1: 선행 조건 확인** — `git status --short` 가 비어 있어야 한다. 아니면 멈추고 보고.
- [ ] **Step 2: 실패하는 테스트 작성** (`paths.test.ts`, `integrations.test.ts`, `config.test.ts`)

```ts
it('DECK_CONFIG_DIR wins', () => expect(resolveConfigDir({ DECK_CONFIG_DIR: '/x' }, home, { exists: () => true })).toBe('/x'));
it('relative DECK_CONFIG_DIR is made absolute against cwd; ~/ expands', () => {
  expect(resolveConfigDir({ DECK_CONFIG_DIR: 'rel/d' }, home, { cwd: '/w' })).toBe('/w/rel/d');
  expect(resolveConfigDir({ DECK_CONFIG_DIR: '~/d' }, home)).toBe(path.join(home, 'd'));
});
it('legacy ~/.config/deck wins over XDG_CONFIG_HOME', () => {
  fs.mkdirSync(path.join(home, '.config', 'deck'), { recursive: true });
  expect(resolveConfigDir({ XDG_CONFIG_HOME: path.join(home, 'xdg') }, home)).toBe(path.join(home, '.config', 'deck'));
});
it('XDG_CONFIG_HOME without a legacy dir', () =>
  expect(resolveConfigDir({ XDG_CONFIG_HOME: path.join(home, 'xdg') }, home)).toBe(path.join(home, 'xdg', 'deck')));
it('a relative XDG_CONFIG_HOME is ignored', () =>
  expect(resolveConfigDir({ XDG_CONFIG_HOME: 'xdg' }, home)).toBe(path.join(home, '.config', 'deck')));

it('fresh home: no personal-tool paths, cooldown under configDir', () => {
  expect(legacyIntegrations({}, home, cfgDir)).toEqual({ deckUrlFile: null, protectFile: null, cooldownDir: path.join(cfgDir, 'cooldown') });
});
it('an existing offload cooldown dir is still shared', () => {
  fs.mkdirSync(path.join(home, '.cache', 'offload', 'cooldown'), { recursive: true });
  expect(legacyIntegrations({}, home, cfgDir).cooldownDir).toBe(path.join(home, '.cache', 'offload', 'cooldown'));
});
it('XDG_CACHE_HOME set but only ~/.cache/offload/cooldown exists: still shared', () => {
  fs.mkdirSync(path.join(home, '.cache', 'offload', 'cooldown'), { recursive: true });
  expect(legacyIntegrations({ XDG_CACHE_HOME: path.join(home, 'xc') }, home, cfgDir).cooldownDir).toBe(path.join(home, '.cache', 'offload', 'cooldown'));
});
it('CLAUDE_PICK_COOLDOWN_DIR wins even when missing', () =>
  expect(legacyIntegrations({ CLAUDE_PICK_COOLDOWN_DIR: '/c' }, home, cfgDir).cooldownDir).toBe('/c'));
it('<configDir>/protect before ~/.config/offload/protect', () => { /* 둘 다 만들고 configDir 쪽이 뽑히는지 */ });

// config.test.ts
it('loadConfig writes nothing', () => { loadConfig({ PATH: '' }, home, repoRoot, () => {}); expect(listFiles(home)).toEqual([]); });
it('loadConfig + writeCooldown on a fresh home write only under configDir', () => {
  const cfg = loadConfig({ PATH: '' }, home, repoRoot, () => {});
  writeCooldown(cfg.cooldownDir, 'a', Date.now() + 60_000);
  expect(listFiles(home).every((f) => f.startsWith(path.join('.config', 'deck') + path.sep))).toBe(true);
  expect(cfg.usageMode).toBe('cli');
});
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/server/paths.test.ts src/server/integrations.test.ts src/server/config.test.ts --maxWorkers=2` → 모듈 없음으로 FAIL.
- [ ] **Step 4: 구현** — `paths.ts`, `integrations.ts`; `loadConfig` 가 둘을 쓰도록(`readDeckUrl` 은 `deckUrlFile` 이 null 이면 `''`, `readProtect` 는 `protectFile` 이 null 이면 호출하지 않음). `UsageService` 의 `mode` 기본값 `'cli'`. `loadConfig` 경로(계정 레지스트리 로딩 포함)에 쓰기가 있으면 걷어낸다.
- [ ] **Step 5: 통과 확인** — 같은 명령 PASS, 이어서 `npx vitest run src/server src/shared --maxWorkers=2` 전부 PASS, `npx tsc --noEmit -p .` 오류 0.
- [ ] **Step 6: 커밋** — `git commit -m "feat(packaging): 설정 경로 XDG 해석·절대화, 개인 도구 연동은 있을 때만"`

---

### Task 2: 설정 폴더 락, 서버 진입점 분리, `quarterdeck` CLI(start · login-url · --version · --help)

**Files:**
- Create: `src/server/instanceLock.ts`, `src/server/server.ts`, `src/server/cli/args.ts`, `src/server/cli/app.ts`, `src/server/cli/bin.ts`
- Modify: `src/server/main.ts`(전체 → 얇은 진입점)
- Test: `src/server/instanceLock.test.ts`, `src/server/cli/args.test.ts`, `src/server/cli/app.test.ts`, `src/server/server.listen.test.ts`, `src/server/server.order.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `resolveConfigDir` (Task 1 반영본).
- Produces (`instanceLock.ts`):
  - `type LockInfo = { pid: number; port: number; addresses: string[]; version: string; configDir: string; startedAt: string; supervisor: string | null }`
  - `class InstanceLockedError extends Error { holder: LockInfo | null; reason: 'lock' | 'relaunch-loop' }`
  - `acquireInstanceLock(configDir: string, o: { pid: number; port: number; version: string; supervisor: string | null; isAlive?: (pid: number) => boolean; commandOf?: (pid: number) => string | null }): Promise<InstanceLock>` — 폴더가 없으면 0700 으로 만들고(만들었음을 기억), `server.lock` 을 `O_CREAT|O_EXCL`·0600 으로 생성. 이미 있으면 읽어서: pid 가 살아 있고 그 명령이 node/quarterdeck 이면 `InstanceLockedError('lock')`; 죽었거나(또는 pid 재사용) 내용이 깨졌으면 **낡은 락** — 내용을 다시 읽어 그대로일 때만 지우고 `O_EXCL` 을 한 번 더 시도(경합에서 지면 `InstanceLockedError`). 낡은 락을 넘겨받았으면 `tookOverStale: true`(Task 7 S5 정리의 계기).
  - 관리자 없는 시작(`supervisor !== 'relaunch'`)은 `<configDir>/relaunch.pid` 의 루프가 살아 있으면 `InstanceLockedError('relaunch-loop')` — 락을 모르는 옛 코드 서버가 이 맥에서 돌고 있을 수 있어서.
  - `InstanceLock`: `update(p: { addresses: string[]; port: number }): Promise<void>`(임시 파일 → rename), `release(): void`(내 pid 일 때만 삭제; 이번에 만든 폴더가 비었으면 그 폴더도), `tookOverStale: boolean`, `file: string`.
  - `readInstanceLock(configDir: string, isAlive?): LockInfo | null` — 살아 있는 인스턴스의 기록만(죽은 pid → null). `login-url`·`service status` 가 쓴다.
- Produces (`server.ts`):
  - `startServer(o?: { cfg?: DeckConfig; onListening?: (info: ListenInfo) => void }): Promise<void>` — 순서: `loadConfig`(쓰기 없음) → `acquireInstanceLock` → 서버 객체 생성(요청 처리기는 자리표시: 준비 전 요청엔 503 "시작 중") → `listenAll` → `lock.update` → 그다음에 지금 `main()` 본문(transcript 캐시 정리, 토큰, 스토어…) → 실제 처리기로 교체·`attachWebSocket`. 어느 단계든 실패하면 연 서버·타이머를 닫고 `lock.release()` 후 오류를 던진다. 종료 경로(`shutdown`)에서도 `lock.release()`.
  - `type ListenInfo = { port: number; addresses: string[]; tokenFile: string; tokenCreated: boolean; lockFile: string }`
  - `listenAll(servers: http.Server[], port: number, addresses: string[]): Promise<void>` — 하나라도 실패하면 **이미 열린 서버를 모두 닫고(close 완료까지 대기) 남은 타이머를 정리한 뒤** 원래 오류를 던진다. `EADDRINUSE` 는 `PortInUseError` 로.
  - `class PortInUseError extends Error { port: number }`
- Produces (CLI):
  - `type CliCommand = { kind: 'start'; port?: number } | { kind: 'doctor'; json: boolean } | { kind: 'service'; action: 'install' | 'uninstall' | 'status' | 'restart'; dryRun: boolean; yes: boolean; node?: string; port?: number; drainMaxMin?: number } | { kind: 'login-url' } | { kind: 'version' } | { kind: 'help' } | { kind: 'error'; message: string }`
  - `parseCli(argv: string[]): CliCommand` — 인자 없음 = `start`.
  - `type CliIo = { out: (s: string) => void; err: (s: string) => void; isTTY: boolean; env: NodeJS.ProcessEnv; ask?: (q: string) => Promise<boolean> }`
  - `runCli(argv: string[], io?: CliIo, deps?: { start?: typeof startServer }): Promise<number>` — `doctor`·`service` 는 Task 4·7 이 채운다(그 전에는 "아직 없음" 오류 문구, 종료 코드 2).
  - 충돌 문구(`setup/texts.ts`): `PortInUseError` → "포트 N 에 이미 서버가 있습니다 — 같은 deck 이면 http://127.0.0.1:N 으로 접속하세요. 별도 인스턴스는 `--port` 와 `DECK_CONFIG_DIR=<다른 폴더>` 를 함께 지정해야 합니다(설정 폴더는 서버 하나만 씁니다)". `InstanceLockedError('lock')` → "설정 폴더 <dir> 를 이미 서버(pid P, 포트 N)가 쓰고 있습니다 — 주소 http://127.0.0.1:N. 별도 인스턴스는 `DECK_CONFIG_DIR=<다른 폴더>` 로". `'relaunch-loop'` → "이 설정 폴더는 relaunch 루프가 관리 중입니다 — 패키지 서버를 따로 띄우지 마세요". 모두 종료 코드 1, 신호 없음.
  - `loginUrl(port: number, token: string): string` → `http://127.0.0.1:<port>/#token=<encodeURIComponent(token)>`. `runCli('login-url')` 의 포트는 `readInstanceLock(configDir)` 의 실행 인스턴스 포트 → 없으면 `loadConfig` 의 포트 + "서버가 실행 중이 아닙니다" 한 줄(stderr). 토큰 파일이 없으면 "서버를 한 번 실행하세요", 종료 1.
  - `packageVersion(): string` — `<repoRootDefault()>/package.json` 의 `version`.
  - `bin.ts`: `node:` 만 import. `process.versions.node` 주 버전 < 24 면 한국어 한 줄 + 종료 코드 1, 아니면 `await import(new URL('./app.js', import.meta.url).href)` 의 `runCli(process.argv.slice(2))` 결과를 `process.exitCode` 로.
  - `app.ts` 맨 끝: `process.argv[1]` 이 이 파일일 때만 `runCli` 실행(개발용 `npx tsx src/server/cli/app.ts doctor`).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// args.test.ts
expect(parseCli([])).toEqual({ kind: 'start' });
expect(parseCli(['start', '--port', '9400'])).toEqual({ kind: 'start', port: 9400 });
expect(parseCli(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true });
expect(parseCli(['service', 'install', '--dry-run'])).toMatchObject({ kind: 'service', action: 'install', dryRun: true, yes: false });
expect(parseCli(['service', 'restart'])).toMatchObject({ kind: 'service', action: 'restart' });
expect(parseCli(['--version'])).toEqual({ kind: 'version' });
expect(parseCli(['start', '--port', 'x']).kind).toBe('error');
expect(parseCli(['service', 'install', '--drain-max-min', '29']).kind).toBe('error');
expect(parseCli(['bogus']).kind).toBe('error');

// instanceLock.test.ts — 임시 configDir
it('second acquire on the same dir is refused while the first holder lives', async () => {
  const a = await acquireInstanceLock(dir, { pid: process.pid, port: 1, version: 't', supervisor: null });
  await expect(acquireInstanceLock(dir, { pid: 999999, port: 2, version: 't', supervisor: null })).rejects.toMatchObject({ reason: 'lock', holder: { pid: process.pid, port: 1 } });
  a.release(); expect(fs.existsSync(path.join(dir, 'server.lock'))).toBe(false);
});
it('a stale lock (dead pid) is taken over and flagged', async () => { /* lock 파일에 죽은 pid → tookOverStale true */ });
it('a reused pid running something else is stale', async () => { /* isAlive true, commandOf → '/bin/sleep' → 인수 */ });
it('a corrupt lock is stale', async () => { /* '{' → 인수 */ });
it('unsupervised start refuses while a relaunch loop lives', async () => { /* relaunch.pid 에 살아 있는 pid + commandOf 'relaunch.sh' → reason relaunch-loop; supervisor 'relaunch' 면 통과 */ });
it('release removes the dir it created when empty', async () => { /* 없던 dir → acquire → release → dir 없음 */ });
it('readInstanceLock ignores a dead holder', () => { /* … */ });

// server.listen.test.ts — 실제 임시 포트를 먼저 점유
it('EADDRINUSE becomes PortInUseError', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = (blocker.address() as AddressInfo).port;
  await expect(listenAll([http.createServer()], port, ['127.0.0.1'])).rejects.toMatchObject({ name: 'PortInUseError', port });
});
it('partial failure closes the servers already bound', async () => {
  // 127.0.0.1 은 비어 있고 두 번째 주소(::1 또는 바인드 불가 주소)만 실패하도록 구성
  const s1 = http.createServer(), s2 = http.createServer();
  await expect(listenAll([s1, s2], port, ['127.0.0.1', '192.0.2.1'])).rejects.toThrow();
  expect(s1.listening).toBe(false);
  const again = http.createServer().listen(port, '127.0.0.1'); await once(again, 'listening'); again.close(); // 포트 해제 확인
});

// server.order.test.ts — 쓰기 순서
it('port in use: config dir untouched (no token, no cache, no lock left)', async () => {
  // blocker 가 포트 점유 → startServer({ cfg: tmpCfg(port) }) rejects PortInUseError → configDir 이 없거나 비어 있음
});
it('lock held by another live server: nothing written', async () => { /* 먼저 lock 을 잡아 두고 startServer → InstanceLockedError, 파일 목록 = ['server.lock'] 원래 내용 그대로 */ });

// app.test.ts — start 를 주입
it('port in use: one Korean line, exit 1, no signal sent, mentions DECK_CONFIG_DIR', async () => {
  const io = fakeIo();
  const code = await runCli(['start'], io, { start: async () => { throw new PortInUseError(9320); } });
  expect(code).toBe(1);
  expect(io.errText()).toMatch(/9320/);
  expect(io.errText()).toMatch(/--port/);
  expect(io.errText()).toMatch(/DECK_CONFIG_DIR/);
});
it('instance locked: names the holder port and DECK_CONFIG_DIR', async () => { /* … */ });
it('prints the login URL on a TTY only', async () => { /* onListening({ tokenCreated: true, … }) → isTTY true 면 #token= 주소, false 면 토큰 파일 경로만 */ });
it('--port sets DECK_PORT for loadConfig', async () => { /* start 주입에서 cfg.port === 9400 */ });
it('login-url uses the running instance port from server.lock', async () => { /* lock 에 port 9411 + 살아 있는 pid → 주소의 포트 9411 */ });
it('loginUrl encodes the token', () => expect(loginUrl(9320, 'a+b')).toBe('http://127.0.0.1:9320/#token=a%2Bb'));
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cli src/server/instanceLock.test.ts src/server/server.listen.test.ts src/server/server.order.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — `instanceLock.ts`. `main.ts` 본문을 `server.ts` 로 옮기되(Grok 커밋본 기준) 위 순서대로 재배열: 락·listen 을 맨 앞으로, 처리기는 자리표시 → 준비 후 교체. 그 밖의 로직 변경 없음. `main.ts` 는 `installCrashHandlers` + `startServer().catch(…)`(지금 253-258 줄의 `AccountsFileError` 처리 그대로 + `PortInUseError`·`InstanceLockedError` 는 한 줄 문구)만. `runCli('start')` 는 `--port` 를 `env.DECK_PORT` 로 넘겨 `loadConfig(env)` → `startServer({ cfg, onListening })`. 시작 안내는 TTY 일 때만 로그인 주소, 아니면 지금처럼 경로만(서비스 로그에 토큰이 남지 않게).
- [ ] **Step 4: 통과 확인** — 위 명령 PASS; `npx vitest run src/server src/shared --maxWorkers=2` PASS; `npx tsc --noEmit -p .` 0.
- [ ] **Step 5: 저장소 진입점 무변경 확인** — `C=$(mktemp -d)`; `DECK_CONFIG_DIR="$C" HOME="$(mktemp -d)" DECK_LOOPBACK_ONLY=1 DECK_PORT=<빈 포트> npx tsx src/server/main.ts` 를 띄워 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<포트>/api/me` → `401`, `"$C/server.lock"` 에 그 pid·포트. 같은 `DECK_CONFIG_DIR` 로 다른 포트에 하나 더 띄우면 락 문구로 종료 1. 그다음 첫 프로세스에만 Ctrl-C → `server.lock` 사라짐. (실행 중인 9320 서버에는 아무것도 보내지 않는다.)
- [ ] **Step 6: 커밋** — `feat(packaging): 설정 폴더 락·listen 우선, 서버 본문을 startServer 로, quarterdeck CLI 진입점`

---

### Task 3: 서버 번들·패키지 메타데이터·pack 스모크

**Files:**
- Create: `scripts/build-server.mjs`, `scripts/pack-smoke.sh`, `scripts/smoke/fake-claude.mjs`, `scripts/smoke/turn.mjs`, `src/server/engine/claudeCli/childScripts.ts`
- Modify: `src/server/engine/ClaudeEngine.ts:37-39`, `package.json`, `package-lock.json`
- Test: `src/server/engine/claudeCli/childScripts.test.ts`, `src/server/packaging.test.ts`

**Interfaces:**
- Consumes: `bin.ts`·`app.ts` (Task 2).
- Produces:
  - `childScript(name: 'hookRelay' | 'permissionMcp', here?: string, exists?: (p: string) => boolean): string` — `here` 기본값은 이 모듈의 디렉터리. 후보 `<here>/<name>.js`(번들: `dist/server`) → `<here>/<name>.ts`(저장소: `claudeCli/`). 둘 다 없으면 throw. (실행 시점 사본 `snapshotChildScripts` 는 Task 7.)
  - 번들 산출물(모두 `--outdir`, 기본 `dist/server`): `bin.js`(shebang `#!/usr/bin/env node`, `chmod 755`), `app.js`, `hookRelay.js`, `permissionMcp.js`. esbuild: `bundle`, `platform: 'node'`, `format: 'esm'`, `target: 'node24'`, `packages: 'external'`, `splitting: false`(실행 중 파일 교체 때 늦게 불러오는 조각이 없게), `metafile: true`, `sourcemap: false`(배포물에 `sourcesContent` 로 소스·주석이 실리지 않게 — 나중에 켜면 `sourcesContent: false` 필수, 위생 검사 대상).
  - 빌드 실패 조건: ① `app.js` 의 metafile 입력에 `hookRelay.ts`·`permissionMcp.ts` 가 있음 ② `bin.js` 입력에 `bin.ts` 외 파일이 있음 ③ 어느 산출물이든 외부 import 가 `node:` 내장도 아니고 `package.json` 의 `dependencies`(및 그 하위 경로)에도 없음 ④ 자식 스크립트 두 개의 외부 import 가 `node:` 외에 있음.
  - **`import.meta.url`/`__dirname` 전수 표:** 구현자는 `rg -n "import\.meta\.(url|dirname|filename)|__dirname|__filename" src/server src/shared` 결과를 이 계획 Task 3 커밋 메시지 본문에 표로 남기고(파일:줄 → 번들 위치 `dist/server/app.js` 에서의 해석 결과 → 맞음/고침), 번들에서 틀어지는 것은 고친다. `packaging.test.ts` 가 같은 검색의 파일 목록을 스냅숏으로 고정해 새 사용처가 생기면 실패하게 한다(새 사용처는 표를 갱신하고 스냅숏 갱신).
  - `package.json`: `private` 삭제; `"bin": { "quarterdeck": "dist/server/bin.js" }`; `"files": ["dist/server", "dist/ui", "README.md", "README.ko.md", "LICENSE", "SECURITY.md"]`; scripts 추가 `"build:server": "node scripts/build-server.mjs"`, `"prepack": "npm run build && npm run build:server"`; `dependencies` = `ws`·`zod`·`web-push` 만(react·react-dom·react-markdown·rehype-*·remark-*·lowlight → devDependencies); devDependencies 에 `"esbuild": "^0.28.2"`. `name` 은 결정 지점 D1 이 정해질 때까지 그대로(스모크는 이름을 하드코딩하지 않음).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// childScripts.test.ts
it('prefers the bundled .js', () => expect(childScript('hookRelay', '/p', (f) => f === '/p/hookRelay.js' || f === '/p/hookRelay.ts')).toBe('/p/hookRelay.js'));
it('falls back to the .ts source', () => expect(childScript('permissionMcp', '/s', (f) => f === '/s/permissionMcp.ts')).toBe('/s/permissionMcp.ts'));
it('throws when neither exists', () => expect(() => childScript('hookRelay', '/n', () => false)).toThrow());
it('resolves the real source files in this checkout', () => expect(fs.existsSync(childScript('hookRelay'))).toBe(true));

// packaging.test.ts — package.json 정적 검사 + import.meta 사용처 스냅숏
expect(pkg.private).toBeUndefined();
expect(pkg.bin).toEqual({ quarterdeck: 'dist/server/bin.js' });
expect(pkg.files).not.toContain('src');
expect(Object.keys(pkg.dependencies).sort()).toEqual(['web-push', 'ws', 'zod']);
expect(pkg.engines.node).toBe('>=24');
expect(pkg.scripts.prepack).toBe('npm run build && npm run build:server');
expect(filesUsingImportMetaOrDirname()).toMatchInlineSnapshot(/* Step 3 에서 채움 */);
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/engine/claudeCli/childScripts.test.ts src/server/packaging.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — `childScripts.ts`; `ClaudeEngine.ts` 의 `HOOK_RELAY`/`PERMISSION_MCP` 를 `childScript(…)` 로. `build-server.mjs`(`--outdir` 인자, 실패 조건 ①~④). `import.meta.url`/`__dirname` 전수 확인·수정. `package.json` 수정 후 `npm install` 로 lock 갱신(`npm install` 은 `prepack` 을 돌리지 않는다).
- [ ] **Step 4: 통과 확인** — 위 테스트 PASS; `npx vitest run src/server src/shared --maxWorkers=2` PASS(엔진 테스트가 `childScript` 경유로 그대로 통과해야 함); `npx tsc --noEmit -p .` 0; `npx vite build --outDir "$(mktemp -d)"` 성공(UI 패키지를 devDependencies 로 옮겨도 빌드됨). 외부 import 검사가 실제로 막는지: 임시로 `app.ts` 에 devDependency import 한 줄을 넣고 빌드 실패를 확인한 뒤 되돌린다(커밋하지 않음).
- [ ] **Step 5: 번들 확인** — `D=$(mktemp -d); node scripts/build-server.mjs --outdir "$D" && ls "$D"` → `app.js bin.js hookRelay.js permissionMcp.js`(`.map` 없음); `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node "$D/permissionMcp.js"` → `"id":1` 과 `"result"` 가 든 한 줄.
- [ ] **Step 6: 스모크 보조 스크립트** —
  - `scripts/smoke/fake-claude.mjs`(`node:` 만): `--version` → `2.1.283 (Claude Code)`; `auth status --json` → `{"loggedIn":false}` 종료 1. 턴 모드(`-p … --settings=<f> --mcp-config=<f>`)에서는 **받은 설정 파일을 그대로 읽어** ① settings 의 PreToolUse 훅 `command` 를 셸 없이(명령 문자열을 deck 이 만든 형식대로 분해하지 말고 `sh -c` 로, 실제 CLI 와 같은 방식) 실행하고 훅 JSON 을 stdin 으로 넘겨 결정을 받는다(hookRelay 왕복) ② mcp-config 의 permission 서버 `command`/`args`/`env` 를 그대로 spawn 해 `initialize` → `tools/call`(permission prompt 도구) 왕복. 결과(허용/거부/시간 초과)를 stream-json `result` 로 낸다. 어느 단계든 실패하면 그 이유를 stderr 에 쓰고 종료 2.
  - `scripts/smoke/turn.mjs`: 설치된 패키지의 `ws` 를 `createRequire(<설치 경로>/package.json)` 로 불러 쓴다. 토큰 파일로 로그인 → `<공백·한글이 든 임시 폴더>` 에서 새 Claude 세션 → 턴 세 번: 권한 카드 승인 → 허용 결과, 거부 → 거부 결과, 무응답 → `DECK_HOOK_RELAY_DEADLINE_MS` 로 줄인 시한 뒤 실패 결과(닫힘 실패). 각 결과를 한 줄로 출력, 기대와 다르면 종료 1.
- [ ] **Step 7: `scripts/pack-smoke.sh` 작성** — 커밋된 내용만 쓴다(`export-public.sh` 와 같은 방식). 모든 단계는 **저장소 밖 cwd**(`cd "$T"`)에서, 공통 환경 `env -i HOME="$T/home" PATH="$T/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" npm_config_cache="$T/npm-cache" DECK_LOOPBACK_ONLY=1` 로 돌린다(상속된 `DECK_*`·`XDG_*`·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`·`GROK_HOME`·`GEMINI_*` 가 없음을 첫 단계에서 `env` 출력으로 확인). 순서:
  1. `T=$(mktemp -d)`; `trap` 으로 테스트 프로세스 그룹 종료 + `rm -rf "$T"`.
  2. `git archive HEAD | tar -x -C "$T/src"`; `(cd "$T/src" && npm ci --cache "$T/npm-cache")`(저장소 `node_modules` 를 빌리지 않음 — 네트워크 필요, 없으면 "네트워크 없음"으로 실패 표시).
  3. `(cd "$T/src" && npm pack --json --pack-destination "$T/out")` → 파일 이름은 JSON 에서 읽는다.
  4. 압축을 `$T/x` 에 풀어 확인: `package/dist/server/{bin,app,hookRelay,permissionMcp}.js`, `package/dist/ui/index.html` 있음; `package/src`, `package/docs`, `package/scripts`, `*.test.*`, `*.map`, `.hygiene-private.json` 없음; `bin.js` 첫 줄이 shebang 이고 실행 권한.
  5. 위생: `(cd "$REPO" && DECK_HYGIENE_ROOT="$T/x/package" DECK_HYGIENE_RULES="$REPO/.hygiene-private.json" npx vitest run src/hygiene.test.ts)`.
  6. 가짜 CLI 를 `$T/bin` 에 만든다(`claude` → `scripts/smoke/fake-claude.mjs` 를 부르는 래퍼; `codex`: `--version` → `codex-cli 0.159.2`, `login status` → `Not logged in` 종료 1; `agy`: `models` 종료 1). **grok 은 PATH 에 두지 않고** `$T/home/.grok/bin/grok`(`--version` → `grok 1.0.62`, `models` → `You are not authenticated`)에만 둔다 — `resolveGrokBin` 의 세 번째 후보로 찾는지 확인.
  7. 전역 설치: 접두사 `G="$T/g 공백 한글"` 에 `npm i -g --prefix "$G" "$TGZ"` → `"$G/bin/quarterdeck" --version` = package.json 버전; `"$G/bin/quarterdeck" service install --dry-run` 종료 0, 출력의 bin 경로가 `realpath` 된 `$G/lib/node_modules/…/dist/server/bin.js` 이고 아무 파일도 쓰지 않음(`$T/home/Library`·`$T/home/.config/systemd` 없음).
  8. bin 충돌: 다른 접두사 `$T/g2/bin/quarterdeck` 에 남의 파일을 미리 두고 `npm i -g --prefix "$T/g2" "$TGZ"` 가 실패(EEXIST)하는지 확인 — README 문구(Task 8)의 근거. 실패하지 않으면 그 사실을 출력(경고, 스모크 실패 아님).
  9. `npx --yes "$TGZ" --version` = package.json 버전(캐시는 `$T/npm-cache`).
  10. `"$G/bin/quarterdeck" doctor` 종료 0, 출력에 엔진 넷과 "로그인 안 됨", grok 경로가 `.grok/bin/grok`(Task 4 전에는 이 단계를 `SKIP_DOCTOR=1` 로 건너뛸 수 있게).
  11. 서버: 빈 포트를 골라 **테스트 전용 프로세스 그룹**(`perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV'`)으로 `DECK_CLAUDE_BIN="$T/bin/claude" "$G/bin/quarterdeck" start --port "$PORT"`; 30초 안에 `curl /` 가 200 이고 본문에 `<div id="root">`; `index.html` 이 참조하는 JS·CSS 를 전부 요청해 200·올바른 `Content-Type`; `curl /api/me` 가 401; `$T/home/.config/deck/{token,server.lock}` 존재.
  12. 권한 왕복: `node scripts/smoke/turn.mjs` (Step 6) 가 승인·거부·시간 초과 세 줄을 기대대로 출력(`node_modules` 안 번들 `.js` 자식이 실제로 뜸 — Review Focus 1).
  13. 같은 `HOME` 으로 다른 포트에 두 번째 `start` → 락 문구, 종료 1, `server.lock` 내용 그대로.
  14. 종료: 그룹에 SIGTERM → 30초 안에 그룹의 프로세스가 0개(`ps -o pid= -g <pgid>` 빈 결과), 포트 해제(같은 포트에 `node -e` 로 listen 성공), `server.lock` 삭제됨.
  15. 성공 시 `pack-smoke: 완료` 출력, 실패한 단계 이름과 함께 종료 코드 1.
- [ ] **Step 8: 스모크 실행** — 먼저 Task 1~3 을 커밋한 뒤 `bash scripts/pack-smoke.sh` (doctor 단계는 `SKIP_DOCTOR=1`) → `pack-smoke: 완료`. 실행 전후 `ls -1A ~/.config/deck` 의 파일 이름 목록이 같아야 한다(실행 중인 서버가 내용·mtime 을 바꾸므로 이름 목록만 비교).
- [ ] **Step 9: 커밋** — `feat(packaging): esbuild 서버 번들(외부 import·자식 혼입 검사), bin·files·prepack, pack 스모크`

---

### Task 4: 엔진 감지·로그인 상태 모듈과 `quarterdeck doctor`

**Files:**
- Create: `src/shared/setup-types.ts`, `src/server/setup/detect.ts`, `src/server/setup/texts.ts`, `src/server/cli/doctor.ts`
- Modify: `src/server/cli/app.ts`(doctor 분기)
- Test: `src/server/setup/detect.test.ts`, `src/server/setup/noCredentialReads.test.ts`, `src/server/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `DeckConfig`(`claudeBin`·`codexBin`·`geminiBin`·`grokBin`·`grokHome`·`home`), `AccountRegistry.env`, `codexEnv`·`geminiEnv`(`shared/accounts.ts`), `grokEnv`(`engine/grokEnv.ts`), `stripSupervisorEnv`(Task 7 이 만들기 전에는 같은 키 목록을 `detect.ts` 안에서 지우고, Task 7 이 공용 함수로 옮긴다).
- Produces (`src/shared/setup-types.ts`):
  - `type EngineId = 'claude' | 'codex' | 'gemini' | 'grok'`
  - `type LoginState = 'yes' | 'no' | 'unknown'`
  - `type EngineProbe = { engine: EngineId; bin: string | null; version: string | null; login: LoginState; loginCommand: string; note?: string }`
  - `type ClaudeProfileProbe = { id: string; label: string; dir: string; home: boolean; active: boolean; login: LoginState; loginCommand: string }` — `dir` 은 `~/…` 표기.
  - `type SetupStatus = { engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[]; addresses: string[]; needed: boolean; supervised: boolean; restartNeeded: boolean; accountsFile: boolean; checkedAt: string }` — `accountsFile` = `accounts.json` 이 있음(없으면 마법사가 "첫 추가 뒤 자동 발견 끝" 고지, Task 6).
- Produces (`detect.ts`):
  - `type ProbeResult = { code: number | null; stdout: string; timedOut: boolean; spawnError?: 'ENOENT' | 'EACCES' | 'OTHER' }`
  - `type ProbeExec = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProbeResult>` — 기본 구현: `spawn`(셸 없음, `detached: true` 로 자기 프로세스 그룹), stdout·stderr 각각 64KB 상한(넘으면 읽기만 멈추고 버림), stdin 닫음. 시간 초과면 그룹에 SIGTERM → 2초 → SIGKILL 하고 **종료(`close`)를 확인한 뒤** `timedOut: true` 로 돌려준다. 실행 자체 실패(`error` 이벤트)는 `spawnError` 로 구분. stderr 는 해석에 쓰지 않고 버린다. 결과 원문을 로그에 쓰지 않는다.
  - `parseClaudeAuth(stdout: string): LoginState` — JSON 의 `loggedIn === true` → yes, `false` → no, 그 밖 → unknown. 다른 필드는 읽지 않는다.
  - `parseCodexLogin(code: number | null, stdout: string): LoginState` — 0 → yes, `Not logged in` 포함 → no, 그 밖 → unknown.
  - `parseGrokModels(stdout: string): LoginState` — 첫 비지 않은 줄 `/^You are logged in/` → yes, `/not authenticated/i` → no, 그 밖 → unknown(종료 코드는 보지 않음 — 항상 0).
  - Gemini: `agy models` 종료 코드 0 → yes, 0 아닌 종료 코드 → no, 시간 초과 → unknown.
  - 공통: `spawnError` → login `unknown` + note "실행하지 못했습니다(<ENOENT|EACCES>)" — "로그인 안 됨"과 섞지 않는다. 시간 초과 → `unknown` + note "응답 없음(15초)".
  - `probeEngines(o: { cfg: Pick<DeckConfig, 'claudeBin' | 'codexBin' | 'geminiBin' | 'grokBin' | 'grokHome' | 'home'>; profiles: ReadonlyArray<{ id: string; label: string; dir: string; home: boolean; active: boolean; env: Record<string, string | undefined> }>; env: NodeJS.ProcessEnv; exec?: ProbeExec; timeoutMs?: number }): Promise<{ engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[] }>` — 모두 병렬, 기본 시간 15s. claude 엔진 `login` = 프로필 중 하나라도 yes 면 yes. 버전: claude 는 `cfg.claudeBin.version`, 나머지는 `--version` 첫 줄(120자).
  - **Grok:** 바이너리는 `cfg.grokBin` 그대로(= `resolveGrokBin`: `DECK_GROK_BIN` → PATH → `~/.grok/bin/grok`, 감지가 따로 찾지 않음). 프로브 env 는 `grokEnv(env, cfg.grokHome)`(셸의 `GROK_HOME` 이 아니라 `~/.grok` 실경로 — 턴과 같은 좌석). 명령 `grok models` → `parseGrokModels`, `grok --version` 첫 줄.
- Produces (`texts.ts`): `loginCommandFor(engine: EngineId, profileDir?: string): string` — claude 기본 프로필 `claude auth login`, 다른 프로필 `CLAUDE_CONFIG_DIR=<~/…> claude auth login`, codex `codex login`, gemini `agy`(설명: "인자 없이 실행 → 브라우저에서 Google 로그인"), grok `grok login`. `missingBinNote(engine)` — "`<cli>` 를 찾지 못했습니다 — 설치 후 PATH 에 두거나 `DECK_<X>_BIN` 으로 지정하세요"; grok 은 찾아본 곳(`DECK_GROK_BIN`, PATH, `~/.grok/bin/grok`)을 함께 적는다. claude 가 너무 오래됐으면 최소 버전 안내.
- Produces (`doctor.ts`): `formatDoctor(r: { engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[] }): string` — 엔진마다 한 줄(이름 · 버전/없음 · 로그인됨/로그인 안 됨/확인 못 함 · 필요하면 안내 명령·note), 그 아래 Claude 프로필 줄. `doctor --json` 은 같은 객체를 JSON 으로. 종료 코드는 항상 0.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
expect(parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}')).toBe('no');
expect(parseClaudeAuth('{"loggedIn":true,"email":"someone@example.com","orgName":"X"}')).toBe('yes');
expect(parseClaudeAuth('not json')).toBe('unknown');
expect(parseCodexLogin(1, 'Not logged in\n')).toBe('no');
expect(parseCodexLogin(0, 'Logged in using ChatGPT\n')).toBe('yes');
expect(parseGrokModels('You are logged in as …\nmodels:')).toBe('yes');
expect(parseGrokModels('\n  You are not authenticated. Run grok login')).toBe('no');

it('never carries account identity into the result', async () => {
  const exec = fakeExec({ 'claude auth status --json': { code: 0, stdout: '{"loggedIn":true,"email":"someone@example.com","orgId":"org-1"}' } });
  const r = await probeEngines({ cfg, profiles, env: {}, exec });
  expect(JSON.stringify(r)).not.toMatch(/example\.com|org-1/);
});
it('runs claude per profile with that profile env (CLAUDE_CONFIG_DIR)', async () => { /* exec 가 받은 env 확인 */ });
it('grok is probed with grokEnv: GROK_HOME is cfg.grokHome, not the shell value', async () => { /* env.GROK_HOME='/elsewhere' → exec env.GROK_HOME === cfg.grokHome, args ['models'] */ });
it('probe envs carry no supervisor markers', async () => { /* env 에 XPC_SERVICE_NAME·INVOCATION_ID·DECK_SUPERVISOR → exec 가 받은 env 에 없음 */ });
it('a hanging CLI is unknown, not a crash', async () => { /* exec → { timedOut: true } → login 'unknown', note 응답 없음 */ });
it('a spawn failure is unknown with its reason, not "logged out"', async () => { /* spawnError 'EACCES' → unknown, note */ });
it('missing binaries are reported with the hint, never probed', async () => { /* bin null → exec 호출 0, grok note 에 .grok/bin/grok */ });
it('default exec: caps output, kills the group on timeout and waits for exit', async () => {
  // 임시 스크립트: 1MB 출력 후 sleep 60 (자식 하나 더 띄움) → timeoutMs 300 → timedOut true, stdout.length <= 64KB, 두 프로세스 모두 사라짐
});

// noCredentialReads.test.ts — src/server/setup/**, src/server/cli/** 의 비테스트 .ts
for (const bad of ['.credentials.json', 'auth.json', 'find-generic-password', 'oauth']) expect(sourceText).not.toContain(bad);

// doctor.test.ts
expect(formatDoctor(sample)).toMatch(/claude .*2\.1\.283.*로그인 안 됨.*claude auth login/);
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/setup src/server/cli/doctor.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — `detect.ts`, `texts.ts`, `doctor.ts`; `runCli('doctor')` 는 `loadConfig(io.env)` → 레지스트리의 계정마다 `{ id, label, dir: profileDir, home, active: !isRetired, env: accounts.env(id, io.env) }` → `probeEngines` → 출력. Grok 턴 쪽 동작(로그인 미리 확인 안 함, 설계 §5)은 바꾸지 않는다 — 이 프로브는 마법사·doctor 전용.
- [ ] **Step 4: 통과 확인** — 위 명령 PASS; `npx vitest run src/server src/shared --maxWorkers=2` PASS; `npx tsc --noEmit -p .` 0.
- [ ] **Step 5: 손으로 확인** — `HOME="$(mktemp -d)" npx tsx src/server/cli/app.ts doctor` → 네 줄(이 맥의 실제 CLI 를 찾되 임시 HOME 이라 claude 기본 프로필은 "로그인 안 됨", grok 은 PATH 에 없으면 "찾지 못함"). 실제 HOME 으로 돌리지 않는다.
- [ ] **Step 6: 커밋 후 스모크** — 커밋하고 `bash scripts/pack-smoke.sh`(이번엔 doctor 단계 포함) → 완료.

---

### Task 5: 설정 API, 마법사 완료 기록, Claude 프로필 추가

**Files:**
- Create: `src/server/setup/profiles.ts`, `src/server/setup/SetupStore.ts`, `src/server/setup/SetupService.ts`
- Modify: `src/server/http.ts`(라우트 + `deps.setup`), `src/server/ws.ts`(hello 에 `setup`), `src/shared/protocol.ts`(`FEATURES` 에 `'setup'`, hello 에 `setup?: { needed: boolean }`), `src/server/server.ts`(조립)
- Test: `src/server/setup/profiles.test.ts`, `src/server/setup/SetupStore.test.ts`, `src/server/setup/SetupService.test.ts`, `src/server/http-setup.test.ts`, `src/server/ws.test.ts`(hello 추가)

**Interfaces:**
- Consumes: `probeEngines`, `SetupStatus` (Task 4); `loadAccountRegistry`, `AccountsFileError` (`server/accounts.ts`); `buildRegistry`, `ACCOUNT_ID_RE`, `RESERVED_ACCOUNT_IDS`, `AccountsConfig` (`shared/accounts.ts`); `supervisionCheck` 결과.
- Produces:
  - `materializeAccountsConfig(reg: AccountRegistry, home: string): AccountsConfig` — `{ version: 1, home: reg.home, accounts: reg.all().map(id => ({ id, label?(기본 라벨과 다를 때만), configDir: '~/…', retired?: true })) }`. `card` 는 쓰지 않는다(a/b/c 기본 카드 id 가 재계산됨).
  - `class ProfileError extends Error { status: 400 | 409 }`
  - `addClaudeProfile(o: { configDir: string; home: string; id: string; label?: string; uid?: number; now?: () => Date }): Promise<{ id: string; dir: string; createdDir: boolean; backup: string | null }>` — 순서:
    1. 모듈 안 mutex(동시 추가 직렬화) + `<configDir>/accounts.json.lock`(`O_EXCL`, 30초 넘은 것은 낡은 것으로 지움)으로 다른 프로세스와도 직렬화.
    2. 기준본 읽기: `accounts.json` 이 있으면 그 내용(+해시). 없으면 **지금 다시 발견**(`loadAccountRegistry` 를 새로 돌림 — 서버 시작 뒤 생긴 `~/.claude-x` 포함)한 레지스트리의 `materializeAccountsConfig`.
    3. 검사: id 는 `ACCOUNT_ID_RE` 이고 예약어 아님(400), 기준본에 이미 있으면 409. `accounts.json` 과 대상 폴더 `<home>/.claude-<id>` 에 `lstat`: symlink 이거나 소유자가 내 uid 가 아니면 400(따라가지 않음). 깨진 `accounts.json`(`AccountsFileError`)은 400, 파일 그대로.
    4. 폴더가 없으면 0700 으로 만들고(`createdDir`), 있으면 내용은 건드리지 않는다.
    5. 새 내용 = 기준본 + 새 계정 → `buildRegistry` 로 검증.
    6. 쓰기 직전 최신본 재검증: 파일 존재 여부·해시가 2단계와 다르면 409 "계정 파일이 그사이 바뀌었습니다 — 다시 시도하세요".
    7. 기존 `accounts.json` 이 있고 이번이 deck 의 첫 수정이면(같은 폴더에 `accounts.json.bak-*` 가 없으면) `accounts.json.bak-<YYYYMMDD-HHMMSS>`(0600)로 복사.
    8. 같은 폴더 임시 파일(0600) → `fsync` → rename.
    9. 실패하면(어느 단계든) 4단계에서 **이번에 만든 폴더가 아직 비어 있을 때만** 지우고, 임시 파일·락을 지운다. 백업은 남긴다.
  - `class SetupStore { static open(file: string, o: { existingInstall: boolean }): Promise<SetupStore>; needed(): boolean; markDone(): Promise<void> }` — 파일 없음: `existingInstall` 이면 `{ state: 'done', doneAt, migrated: true }`, 아니면 **바로** `{ state: 'pending', createdAt }` 를 쓴다(마법사 전에 재시작해도 다시 뜸). `needed()` = `state === 'pending'`. 깨진 파일은 `pending` 으로 취급하고 덮어쓰지 않는다(다음 `markDone` 때 교체).
  - `existingInstall(configDir: string): boolean` — **실제 데이터**로 판정: `session-meta.json`·`session-state.json`·`activity.json`·`pins.json`·`projects.json`·`push-subscriptions.json`·`accounts.json` 중 하나라도 비지 않은 파일로 있음. 토큰 존재는 쓰지 않는다. `startServer` 가 락·listen 직후, **다른 스토어가 파일을 만들기 전에** 한 번 계산한다.
  - `class SetupService { constructor(o: { cfg: DeckConfig; accounts: AccountRegistry; store: SetupStore; supervised: () => Promise<boolean>; addresses: string[]; exec?: ProbeExec; ttlMs?: number }); status(force?: boolean): Promise<SetupStatus>; addProfile(id: string, label?: string): Promise<{ profile: ClaudeProfileProbe; restartNeeded: true }> }` — 캐시 30s, 동시 요청은 한 번만 프로브. 프로필 목록은 매번 `accounts.json` 을 새로 읽어(없으면 실행 중 레지스트리) 만들고, 실행 중 레지스트리에 없는 id 는 `active: false`. `restartNeeded` = 파일의 id 집합 ≠ 실행 중 레지스트리의 id 집합.
  - HTTP(로그인 필요, 변경 요청은 기존 출처 검사 적용): `GET /api/setup` → `SetupStatus`; `POST /api/setup/refresh` → `status(true)`; `POST /api/setup/profiles` `{ id, label? }` → 200 `{ ok: true, profile, restartNeeded: true }` / 400·409 `{ error: <한국어> }`; `POST /api/setup/done` → 200.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
it('materialize round-trip keeps a discovered a/b/c install identical', () => {
  for (const d of ['.claude', '.claude-b', '.claude-c']) fs.mkdirSync(path.join(home, d, 'projects'), { recursive: true });
  const reg = loadAccountRegistry({ configDir, homeDir: home, log: () => {} });
  const back = buildRegistry(materializeAccountsConfig(reg, home), { homeDir: home });
  expect(back.all()).toEqual(reg.all());
  expect(back.home).toBe(reg.home);
  for (const id of reg.all()) {
    expect(back.profileDir(id)).toBe(reg.profileDir(id));
    expect(back.cardId(id)).toBe(reg.cardId(id));
    expect(back.label(id)).toBe(reg.label(id));
  }
});
it('first add on a discovered install writes all old accounts plus the new one', async () => { /* accounts.json 의 id = a,b,c,d, 0600, ~/.claude-d 0700 */ });
it('first add re-discovers: a profile dir created after start is kept', async () => { /* 시작 뒤 ~/.claude-e 생성 → add d → 파일에 e 포함 */ });
it('rejects reserved, malformed and duplicate ids', async () => { /* 'gpt' → 400, 'A!' → 400, 'b' → 409 */ });
it('an existing profile dir is registered, its files untouched', async () => { /* 미리 둔 파일의 mtime·내용 동일 */ });
it('a broken accounts.json is refused, not overwritten', async () => { /* AccountsFileError → ProfileError 400, 파일 내용 그대로 */ });
it('backs up an existing accounts.json once before the first edit', async () => { /* .bak-* 하나, 두 번째 add 뒤에도 하나 */ });
it('a symlinked accounts.json or profile dir is refused', async () => { /* 400, 대상 무변경 */ });
it('a change between read and write is refused (409), nothing written', async () => { /* 2단계 뒤 훅으로 파일 수정 → 409, 수정본 그대로 */ });
it('concurrent adds are serialized: both land', async () => { /* Promise.all([add d, add e]) → 파일에 d,e */ });
it('a failed write removes only the empty dir it created', async () => { /* rename 실패 주입 → ~/.claude-d 없음; 미리 있던 폴더는 남음 */ });

it('SetupStore: an existing install is marked done without showing the wizard', async () => {
  const s = await SetupStore.open(file, { existingInstall: true });
  expect(s.needed()).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ migrated: true });
});
it('SetupStore: a fresh install writes pending at once and survives a restart', async () => {
  await SetupStore.open(file, { existingInstall: false });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ state: 'pending' });
  const again = await SetupStore.open(file, { existingInstall: true }); // 재시작 때는 다른 데이터가 생겼어도
  expect(again.needed()).toBe(true);
});
it('existingInstall: token alone is not an install; session data is', () => { /* token 만 → false; session-meta.json 비지 않음 → true */ });

it('SetupService caches the probe for 30s and single-flights', async () => { /* exec 호출 수 */ });
it('restartNeeded after addProfile; new profile listed as inactive with its login command', async () => { /* … */ });

// http-setup.test.ts (기존 http-*.test.ts 하네스)
it('GET /api/setup requires login', async () => { /* 401 */ });
it('POST /api/setup/profiles from a foreign Origin is 403', async () => { /* … */ });
it('POST /api/setup/profiles returns the Korean error and status', async () => { /* 409 */ });

// ws.test.ts
it('hello carries setup.needed and the setup feature', async () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/setup src/server/http-setup.test.ts src/server/ws.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `server.ts` 에서 `existingInstall` 을 락·listen 직후 계산, `SetupStore`·`SetupService` 를 만들고 `createRequestHandler`·`attachWebSocket` 에 넘긴다.
- [ ] **Step 4: 통과 확인** — 위 명령 PASS; `npx vitest run src/server src/shared --maxWorkers=2` PASS; `npx tsc --noEmit -p .` 0.
- [ ] **Step 5: 커밋** — `feat(setup): 설정 상태 API, 마법사 완료 기록(pending), 안전한 Claude 프로필 추가`

---

### Task 6: 첫 실행 마법사 UI와 주소 토큰 로그인

**Files:**
- Create: `src/ui/components/SetupWizard.tsx`, `src/ui/setupApi.ts`, `src/ui/setupTexts.ts`, `src/ui/loginHash.ts`
- Modify: `src/ui/App.tsx`(자동 열기·설정에서 열기·시작 시 해시 토큰 로그인), `src/ui/components/Login.tsx:16`, `src/ui/components/SettingsView.tsx`(“설치 점검” 버튼), `src/ui/styles.css`
- Test: `src/ui/components/SetupWizard.test.tsx`, `src/ui/loginHash.test.ts`, `src/ui/App.test.tsx`(추가)

**Interfaces:**
- Consumes: `SetupStatus`·`EngineProbe`·`ClaudeProfileProbe` (`shared/setup-types.ts`), `/api/setup*` (Task 5), hello `setup`·`features` (Task 5), `clipboard.ts`, `POST /api/restart`(이미 있음).
- Produces:
  - `readHashToken(hash: string): string | null` — `#token=<값>` 에서 디코드한 값, 없거나 비면 null.
  - `setupApi`: `getSetup(): Promise<SetupStatus>`, `refreshSetup(): Promise<SetupStatus>`, `addProfile(id: string, label?: string): Promise<{ ok: true; restartNeeded: true } | { ok: false; error: string }>`, `markSetupDone(): Promise<void>`.
  - `SetupWizard(props: { load?: () => Promise<SetupStatus>; onAddProfile?: typeof addProfile; onDone: () => void; onClose: () => void; onRestart?: () => void; pollMs?: number })` — 단계: ① 엔진 네 줄(설치·버전·로그인 상태, 로그인 안 됨이면 안내 명령 + 복사 버튼, note 표시, "다시 확인") ② Claude 프로필 목록(로그인 상태·안내 명령) + 프로필 추가 폼(id, 선택 라벨). `accountsFile === false` 면 폼 위에 고지: "처음 추가하면 지금 계정 목록이 설정 폴더의 accounts.json 으로 고정됩니다 — 이후 새 ~/.claude-x 폴더는 자동으로 잡히지 않으니 이 화면에서 추가하세요". 성공하면 "서버를 다시 시작하면 계정이 추가됩니다"와, `supervised` 이면 "지금 재시작" 버튼, 아니면 "터미널에서 quarterdeck 을 다시 실행하세요" ③ 접속 주소 목록(폰 페어링 QR 은 계획 ④ 라는 한 줄) ④ 완료 → `markSetupDone` 후 `onDone`. 열려 있는 동안 `pollMs`(기본 5000) 마다 `getSetup`.
  - App: `features` 에 `'setup'` 이 있고 `hello.setup?.needed` 이면 마법사를 연다. `SettingsView` 의 "설치 점검" 으로 언제든 연다. 시작 시 `readHashToken(location.hash)` 가 있으면 `POST /api/login` 후 `history.replaceState(null, '', location.pathname + location.search)`(성공·실패 모두 해시 제거).
  - Login 문구: `setupTexts.loginHint` = "터미널에서 `quarterdeck login-url` 을 실행해 나온 주소를 열거나, 설정 폴더의 token 파일 내용을 입력하세요."

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
expect(readHashToken('#token=a%2Bb')).toBe('a+b');
expect(readHashToken('#x=1')).toBeNull();
expect(readHashToken('')).toBeNull();

it('shows four engines with their state and the login command for a logged-out one', async () => {
  render(<SetupWizard load={async () => sample} onDone={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText('Claude')).toBeTruthy();
  expect(screen.getByText('claude auth login')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /복사/ }).length).toBeGreaterThan(0);
});
it('a missing CLI shows the install note, no login command', async () => { /* … */ });
it('without accounts.json the add form warns that auto-discovery ends', async () => { /* accountsFile false → 고지 문구; true → 없음 */ });
it('adding a profile posts the id and shows the restart notice; supervised shows 지금 재시작', async () => { /* … */ });
it('a server error on add is shown as is', async () => { /* { ok:false, error:'이미 있는 계정입니다: b' } */ });
it('완료 calls markSetupDone then onDone', async () => { /* … */ });
it('polls while open and stops after close', async () => { /* fake timers */ });

// App.test.tsx
it('opens the wizard when hello says setup is needed', async () => { /* features ['setup'], setup.needed true */ });
it('does not open it for a server without the setup feature', async () => { /* … */ });
it('logs in from #token= and strips the hash', async () => { /* fetch mock + history.replaceState spy */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/ui --maxWorkers=2` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces. 스타일은 기존 시트·카드 클래스를 재사용하고 새 CSS 는 마법사 전용 블록 하나.
- [ ] **Step 4: 통과 확인** — `npx vitest run src/ui --maxWorkers=2` PASS; `npx tsc --noEmit -p .` 0; `npx vite build --outDir "$(mktemp -d)"` 성공.
- [ ] **Step 5: 화면 확인(선택)** — Task 2 Step 5 처럼 임시 HOME·임시 configDir·임시 포트로 서버를 띄우고 `npx vite build --outDir "$D"` 결과를 `DECK_UI_DIR="$D"` 로 물려, 로그인 주소로 들어가 마법사가 뜨는지, 마법사 전에 서버를 재시작해도 다시 뜨는지 본다. 끝나면 그 프로세스만 끈다.
- [ ] **Step 6: 커밋** — `feat(setup): 첫 실행 마법사 UI, 주소 토큰 로그인`

---

### Task 7: 상주 서비스 — 생존·종료 계약, Linux systemd 사용자 유닛, macOS LaunchAgent(패키지 설치본)

**Files:**
- Create: `src/server/cli/service/index.ts`, `src/server/cli/service/record.ts`, `src/server/cli/service/nodePath.ts`, `src/server/cli/service/systemd.ts`, `src/server/cli/service/launchd.ts`, `src/server/supervisorEnv.ts`, `src/server/childRegistry.ts`
- Modify: `src/server/cli/app.ts`(service 분기), `src/server/serverUpdate.ts:88-112`(`supervisionCheck`, 패키지 버전 감지), `src/server/config.ts`(`supervisor`), `src/server/http.ts:74`(`UNSUPERVISED_MESSAGE`), `src/server/server.ts`(자식 기록·낡은 기록 정리·자식 스크립트 사본), `src/server/engine/ClaudeEngine.ts`(사본 경로), `src/server/engine/GrokEngine.ts:429`(detached 자식 기록), `src/server/engine/claudeCli/args.ts:139`, `src/shared/accounts.ts:234,252`(env 정리), `src/server/setup/detect.ts`(공용 `stripSupervisorEnv` 로)
- Test: `src/server/cli/service/systemd.test.ts`, `src/server/cli/service/launchd.test.ts`, `src/server/cli/service/index.test.ts`, `src/server/cli/service/nodePath.test.ts`, `src/server/cli/service/record.test.ts`, `src/server/supervisorEnv.test.ts`, `src/server/childRegistry.test.ts`, `src/server/serverUpdate.test.ts`(추가)

**Interfaces:**
- Consumes: `resolveConfigDir`(Task 1), `acquireInstanceLock`·`readInstanceLock`(Task 2), `runCli`(Task 2), "서비스 생존·종료 계약" S1~S7, 결정 지점 D8.
- Produces (식별자):
  - `SERVICE_NAME = 'quarterdeck'`(유닛 `quarterdeck.service`); `LAUNCHD_LABEL = 'local.quarterdeck.server'`(D8 — **영구 고정**, 도메인과 무관); `PREVIOUS_LAUNCHD_LABELS: string[] = []`·`PREVIOUS_UNIT_NAMES: string[] = []`(이름을 바꾸게 되면 옛 이름을 여기에 넣는다 — install·uninstall·status 가 표식 있는 옛 파일을 찾아 내리고 지운다); `LEGACY_LAUNCHD_LABEL = 'com.deck.server'`.
  - `MANAGED_MARKER = 'managed-by: quarterdeck service'` — 유닛 첫 줄 `# managed-by: quarterdeck service (수정하지 마세요 — quarterdeck service install 이 다시 씁니다)`, plist 는 `<?xml?>` 다음 줄 XML 주석.
- Produces (`supervisorEnv.ts`): `SUPERVISOR_ENV_KEYS`(Global Constraints 의 목록), `stripSupervisorEnv<T extends Record<string, string | undefined>>(env: T): T`(복사본). `claudeEnv`·`codexEnv`·`geminiEnv`·감지 프로브가 사용. `grokEnv` 는 허용 목록이라 손대지 않고 테스트로만 고정.
- Produces (`nodePath.ts`): `stableNodePath(o: { execPath: string; explicit?: string; realpath: (p) => string; exists: (p) => boolean; nodeVersion: (bin) => Promise<string | null> }): Promise<{ node: string; warning?: string } | { error: string }>` —
  - `explicit`(`--node`)가 있으면: 존재·실행 가능·`--version` 주 버전 ≥ 24 확인 후 그대로.
  - `execPath` 실경로가 Homebrew Cellar(`…/Cellar/node[@N]/<버전>/bin/node`)면 `<prefix>/opt/node[@N]/bin/node` → `<prefix>/bin/node` 순으로 **실경로가 같은** 후보를 고른다(`<prefix>` = Cellar 의 상위). 없으면 error.
  - nvm(`/.nvm/versions/`)·fnm(`/fnm/node-versions/`, `/.fnm/`)·volta(`/.volta/tools/image/`)·asdf(`/.asdf/installs/`)·mise(`/mise/installs/`)·n(`/n/versions/`) 경로면 error: "버전 관리자의 node(<경로>)는 버전을 바꾸면 서비스가 죽습니다 — `--node <안정 경로>`(예: 시스템·Homebrew node)로 지정하세요".
  - 그 밖(`/usr/bin/node`, `/usr/local/bin/node` 등)은 그대로.
  - darwin 이면 warning: "macOS 권한(전체 디스크 접근)은 이 node 경로에 줍니다 — node 를 업그레이드한 뒤 권한이 유지되는지 `quarterdeck doctor` 로 확인"(TCC 가 심링크/실경로 중 무엇에 붙는지는 Task 8 실기 확인).
- Produces (`record.ts`):
  - `type ServiceRecord = { version: 1; platform: 'linux' | 'darwin'; node: string; bin: string; configDir: string; port: number; drainMaxMin: number; env: Record<string, string>; installedAt: string; packageVersion: string }` — `env` = 설치 시점의 `PATH`, `HOME`, `LANG`/`LC_*`, `DECK_CONFIG_DIR=<절대 configDir>`, `DECK_PORT`, `DECK_DRAIN_MAX_MIN`, 지금 설정된 그 밖의 `DECK_*`(단 `DECK_SUPERVISOR`·`DECK_SUPERVISED`·`DECK_ENV_FILE` 제외), `XDG_CONFIG_HOME`·`XDG_CACHE_HOME`·`CLAUDE_PICK_COOLDOWN_DIR`(설정돼 있을 때), 그리고 `loadConfig` 가 지금 찾은 CLI 의 절대 경로 `DECK_CLAUDE_BIN`·`DECK_CODEX_BIN`·`DECK_GEMINI_BIN`·`DECK_GROK_BIN`(심링크는 풀지 않음 — CLI 자체 업데이트를 막지 않게; 못 찾은 CLI 는 적지 않음).
  - `writeServiceRecord(configDir, r)` → `<configDir>/service.json`(0600) + `<configDir>/service.env`(systemd `EnvironmentFile` 형식, `systemdQuote`, 0600, 첫 줄 표식). 둘 다 `service install` 만 쓴다(서버는 읽지 않음 — 서비스 env 는 관리자가 넣어 줌).
  - `drainMaxMin`: `--drain-max-min`(1~28) → 지금 env 의 `DECK_DRAIN_MAX_MIN`(유한하고 28 이하일 때) → 25. 28 초과·무한이면 25 로 두고 한 줄 경고.
  - `stopTimeoutSec(r) = r.drainMaxMin * 60 + 120`(≤ 1800, S3).
- Produces (파일 생성기):
  - `systemdQuote(s: string): string` — 공백·따옴표·`%`·`$`·`\` 를 systemd 규칙대로.
  - `systemdUnit(r: ServiceRecord, envFile: string): string` — 표식 첫 줄; `[Unit] Description=Quarterdeck local server`, `After=network-online.target`; `[Service] Type=simple`, `ExecStart=<node> <bin> start`(인용), `WorkingDirectory=<home>`, `EnvironmentFile=<envFile>`(앞의 `-` 없음 — 없으면 시작 실패로 드러나게), `Environment=DECK_SUPERVISOR=systemd`, `Restart=always`, `RestartSec=5`, `KillMode=mixed`(S2: 첫 SIGTERM 은 메인에게만, S4: 메인 종료 뒤 남은 cgroup 은 SIGKILL), `TimeoutStopSec=<stopTimeoutSec>`; `[Install] WantedBy=default.target`.
  - `launchAgentPlist(r: ServiceRecord, o: { label: string; logFile: string }): string` — 표식 주석; `Label`, `ProgramArguments=[node, bin, start]`, `WorkingDirectory=<home>`, `RunAtLoad=true`, `KeepAlive=true`(S6), `ThrottleInterval=10`, `AbandonProcessGroup=false`(S4 — 명시), `ExitTimeOut=<stopTimeoutSec>`(S3), `EnvironmentVariables{...r.env, DECK_SUPERVISOR=launchd}`, `StandardOutPath`/`StandardErrorPath` = `<configDir>/quarterdeck.log`. XML 이스케이프.
- Produces (`index.ts`):
  - `type ServiceDeps = { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; configDir: string; execPath: string; bin: string; uid: number; port: number; isTTY: boolean; ask: (q: string) => Promise<boolean>; run: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>; portBusy: (port: number) => Promise<boolean>; httpProbe: (port: number) => Promise<number | null>; fsOps?: …; sleep?: (ms: number) => Promise<void>; out: (s: string) => void; err: (s: string) => void }`
  - `serviceAction(cmd: Extract<CliCommand, { kind: 'service' }>, d: ServiceDeps): Promise<number>`:
    - **공통 거부(install, 아무것도 쓰기 전):** `bin` 실경로에 `/_npx/` → "전역 설치(`npm i -g <패키지>`) 뒤 다시 실행하세요", 1. `stableNodePath` error → 그 문구, 1. 대상 유닛/plist 가 있는데 표식이 없음 → "남이 만든 파일이라 건드리지 않습니다: <경로>", 1(덮어쓰지도 지우지도 않음). `readInstanceLock(configDir)` 가 살아 있는 서버를 가리키고 그 서버가 이 서비스가 아님(supervisor 가 같은 플랫폼 서비스가 아님) → "이 설정 폴더를 쓰는 서버(pid, 포트)가 이미 있습니다 — 먼저 끄세요", 1. 그 밖에 `portBusy(port)` → "포트 N 에 이미 서버가 있습니다", 1.
    - **미리보기·확인:** `--dry-run` 이면 쓸 파일 경로·전체 내용·실행할 명령 목록·선택된 node(경고 포함)를 출력하고 0(파일·명령 없음). 아니면 같은 요약을 보이고 TTY 면 `ask("설치할까요? [y/N]")`, TTY 가 아니면 `--yes` 가 없을 때 "확인이 필요합니다 — `--yes` 또는 `--dry-run`" 1.
    - **명령 실행 규칙:** 모든 `run` 의 종료 코드를 확인한다. 실패하면 stderr 첫 줄(최대 200자)과 함께 보고하고 **롤백**: 이번에 쓴 파일은 이전 내용으로 되돌리거나(재설치) 지우고, 등록 상태를 이전으로(새로 올렸다면 내림), 서비스 기록(`service.json`/`service.env`)도 이전 것으로. 롤백 자체의 실패도 보고하고 종료 1.
    - **설치 후 검증:** 최대 30초 동안 `readInstanceLock(configDir)` 의 pid 가 서비스의 메인 PID(`systemctl --user show -p MainPID --value quarterdeck.service` / `launchctl print gui/<uid>/<label>` 의 `pid`)와 같고 port 가 기록과 같으며 `httpProbe(port)` 가 401 인지 확인. 아니면 롤백 + "서비스가 기록된 설정으로 뜨지 않았습니다 — 로그: <경로>", 1.
    - **linux:** 유닛 `${XDG_CONFIG_HOME(절대일 때) || ~/.config}/systemd/user/quarterdeck.service`. install: 기록 쓰기 → 유닛 쓰기 → `systemctl --user daemon-reload` → 처음이면 `enable --now`, 우리 유닛 재설치면 `enable` + `restart`(S2 drain 을 거쳐 교체) → 검증. 끝에 "로그아웃 뒤에도 돌게 하려면 `loginctl enable-linger`" 안내(실행하지 않음). `systemctl --user` 자체가 안 되면(사용자 버스 없음) 쓰기 전에 "systemd 사용자 세션이 없습니다" 1. uninstall: 표식 확인 → `disable --now` → `is-active` 가 inactive 가 될 때까지 대기(최대 `stopTimeoutSec`) → 유닛·기록 삭제 → `daemon-reload`. restart: `systemctl --user restart`. status: `is-active` + 기록 + 락 대조(아래).
    - **darwin:** 먼저 `launchctl print gui/<uid>` 가 실패하면(SSH 등 GUI 세션 없음) "macOS 에 로그인한 GUI 세션에서 실행하세요(SSH 에서는 LaunchAgent 를 올릴 수 없습니다)" 1. `launchctl print gui/<uid>/com.deck.server` 가 0 **또는** `~/Library/LaunchAgents/com.deck.server.plist` 가 있음 **또는** `<configDir>/relaunch.pid` 루프가 살아 있음 → 거부("이 맥은 저장소 방식 서비스(com.deck.server/relaunch)로 돌고 있습니다 — 패키지 서비스는 설치하지 않습니다"), 파일도 쓰지 않음. 아니면 install: 기록 쓰기 → `~/Library/LaunchAgents/<label>.plist` 쓰기 → 우리 라벨이 이미 올라가 있으면 `launchctl bootout gui/<uid>/<label>` 후 내려갈 때까지 대기 → `launchctl bootstrap gui/<uid> <plist>` → 검증. node 경로에 전체 디스크 접근 권한을 주라는 안내 + `stableNodePath` 경고 출력. uninstall: 표식 확인 → `bootout` → `launchctl print` 가 실패할 때까지 대기(최대 `stopTimeoutSec`) → plist·기록 삭제. restart: `launchctl kickstart -k gui/<uid>/<label>`. status: `launchctl print` + 기록 + 락 대조.
    - **옛 이름 정리:** install·uninstall 은 `PREVIOUS_*` 의 파일 중 표식 있는 것만 같은 방식으로 내리고 지운다(지금은 빈 목록 — 코드와 테스트만).
    - **status 대조:** 기록의 node·bin·port 와 실행 중 인스턴스(락)의 pid·port·버전, 디스크 패키지 버전을 나란히 보이고 다르면 한 줄 경고("업그레이드 뒤 재시작 필요: `quarterdeck service restart`").
    - **uninstall 은 설정·데이터 폴더를 건드리지 않는다**(지우는 것은 유닛/plist 와 `service.json`·`service.env` 뿐) — 출력에도 "데이터 폴더 <dir> 는 그대로 둡니다".
    - win32 등: "Windows 서비스는 아직 지원하지 않습니다" 1.
  - `DeckConfig.supervisor: 'relaunch' | 'systemd' | 'launchd' | null` — `DECK_SUPERVISOR` 값(systemd|launchd), 없고 `DECK_SUPERVISED=1` 이면 `'relaunch'`. `supervised: boolean` 은 `supervisor !== null` 로 유지.
  - `supervisionCheck(o: { supervisor: DeckConfig['supervisor']; pidFile: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; pid?: number; probe?: SupervisionProbe; ttlMs?: number; now?: () => number })` — `'relaunch'`: 지금 판정 그대로. `'systemd'`: `env.INVOCATION_ID` 가 비지 않고 `systemctl --user show -p MainPID --value quarterdeck.service` 가 내 pid(캐시 ttl). `'launchd'`: darwin 이고 `env.XPC_SERVICE_NAME === LAUNCHD_LABEL` 이고 `launchctl print gui/<uid>/<label>` 의 pid 가 내 pid(캐시 ttl). `ppid === 1` 은 쓰지 않는다(고아도 1). null: false.
- Produces (자식 관리, S5·S7):
  - `childRegistry.ts`: `ChildRegistry.open(<configDir>/run/children.json)`, `add({ pgid, bin, engine, startedAt })`, `remove(pgid)`, `reapStale(o: { isAlive, commandOf, kill, sleep })` — 기록된 그룹이 살아 있고 그 명령이 기록 bin 을 포함할 때만 SIGTERM → 5초 → SIGKILL, 결과를 한 줄 로그(인자 원문 없이 pgid·엔진만). `server.ts` 는 락이 `tookOverStale` 일 때 시작 직후 `reapStale` 을 부른다. `GrokEngine` 은 detached 자식을 띄울 때 `add`, 끝날 때 `remove`(주입식 — 테스트 기본은 no-op).
  - `snapshotChildScripts(o: { src: string; runDir: string; version: string }): { hookRelay: string; permissionMcp: string }` — 번들 실행(`.js`)일 때만 `<configDir>/run/<version>-<내용 해시 8자>/` 에 두 파일을 복사(이미 있으면 재사용)하고 그 경로를 `ClaudeEngine` 에 넘긴다. 저장소 실행(`.ts`)이면 원본 경로 그대로. 시작 때 현재 것 외의 옛 사본 폴더는 지운다.
  - `serverUpdate`: 패키지 실행(`src` 없음)이면 디스크의 `<패키지 루트>/package.json` 버전이 시작 때 버전과 다를 때 `restartNeeded: true`(이유 "패키지가 업그레이드됨").

- [ ] **Step 1: 실패하는 테스트 작성** (임시 HOME, `run` 은 호출 기록만)

```ts
const rec = (o: Partial<ServiceRecord> = {}): ServiceRecord => ({ version: 1, platform: 'linux', node: '/usr/bin/node', bin: '/opt/q dir/bin.js', configDir: '/h/.config/deck', port: 9320, drainMaxMin: 25, env: { PATH: '/h/.local/bin:/usr/bin', HOME: '/h' }, installedAt: 't', packageVersion: '0.1.0', ...o });

it('unit: marker, ExecStart, EnvironmentFile without -, KillMode=mixed, stop timeout = drain + 2 min', () => {
  const u = systemdUnit(rec(), '/h/.config/deck/service.env');
  expect(u.split('\n')[0]).toContain(MANAGED_MARKER);
  expect(u).toContain('ExecStart=/usr/bin/node "/opt/q dir/bin.js" start');
  expect(u).toContain('EnvironmentFile=/h/.config/deck/service.env');
  expect(u).toContain('KillMode=mixed');
  expect(u).toContain('TimeoutStopSec=1620');
  expect(u).toContain('Environment=DECK_SUPERVISOR=systemd');
});
it('stop timeout never exceeds 30 minutes', () => expect(stopTimeoutSec(rec({ drainMaxMin: 28 }))).toBeLessThanOrEqual(1800));
it('plist: marker, AbandonProcessGroup false, ExitTimeOut, escaped env, verifies with plutil when available', () => { /* darwin 이고 plutil 있으면 임시 파일에 써서 plutil -lint 0 */ });
it('unit verifies with systemd-analyze when available', () => { /* linux 이고 있으면 임시 파일 verify */ });
it('record: resolved absolute paths, no supervisor vars, drain clamped', () => { /* DECK_SUPERVISED·DECK_SUPERVISOR 제외, DECK_CONFIG_DIR 절대, DECK_DRAIN_MAX_MIN 무한 → 25 + 경고 */ });

it('nodePath: Homebrew Cellar → opt/bin symlink with the same realpath', async () => { /* … */ });
it('nodePath: nvm/fnm/volta/asdf/mise paths are refused without --node', async () => { /* 각 경로 → error */ });
it('nodePath: --node is checked for version >= 24', async () => { /* v22 → error */ });

it('linux install: record + unit written, daemon-reload, enable --now, then verified against the lock', async () => { /* run 기록 순서, 락의 pid = MainPID, httpProbe 401 → 0 */ });
it('linux install rolls back when enable fails', async () => { /* enable 종료 1 → 유닛·기록 없음, daemon-reload 재실행, 종료 1 */ });
it('linux install rolls back when the service does not come up with the recorded port', async () => { /* 락 없음 → disable --now, 파일 삭제, 1 */ });
it('reinstall of our own unit restores the previous unit on failure', async () => { /* 이전 내용 그대로 */ });
it('a unit without our marker is neither overwritten nor removed', async () => { /* install 1, uninstall 1, 파일 그대로 */ });
it('--dry-run prints files and commands, writes and runs nothing', async () => { /* … */ });
it('non-TTY without --yes refuses; TTY asks', async () => { /* … */ });
it('linux uninstall waits for inactive before deleting, keeps the data dir', async () => { /* configDir 의 다른 파일 그대로 */ });
it('refuses a bin inside the npx cache, writes nothing', async () => { /* bin: <home>/.npm/_npx/abc/node_modules/x/dist/server/bin.js → 1, 파일 없음, run 호출 없음 */ });
it('refuses when the port is busy or another server holds the config dir', async () => { /* portBusy → 1; 살아 있는 락(supervisor null) → 1 */ });
it('darwin: com.deck.server loaded, or its plist exists, or a relaunch loop lives → refuse, nothing written', async () => {
  const run = recordRun({ 'launchctl print gui/501': 0, 'launchctl print gui/501/com.deck.server': 0 });
  expect(await serviceAction(install, deps({ platform: 'darwin', run }))).toBe(1);
  expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))).toBe(false);
  expect(run.calls.some((c) => c.args.includes('bootstrap'))).toBe(false);
  /* plist 파일만 있는 경우, relaunch.pid 만 있는 경우도 각각 1 */
});
it('darwin: no GUI domain (SSH) → refuse with the hint', async () => { /* print gui/501 → 113 */ });
it('darwin reinstall boots out our label before bootstrap', async () => { /* 순서 */ });
it('darwin install writes an escaped plist and bootstraps it, verified by pid', async () => { /* … */ });
it('previous labels with our marker are cleaned on install', async () => { /* PREVIOUS_LAUNCHD_LABELS 주입 */ });
it('win32 is not supported yet', async () => { /* 1 */ });

// supervisorEnv.test.ts
it('claude/codex/gemini child envs drop supervisor markers', () => { /* claudeEnv·codexEnv·geminiEnv 에 XPC_SERVICE_NAME 등 → 없음 */ });
it('grokEnv never passes supervisor markers', () => { /* … */ });

// childRegistry.test.ts
it('reapStale kills a live recorded group whose command matches, ignores a reused pgid', async () => { /* … */ });

// serverUpdate.test.ts
it('systemd supervisor: supervised iff INVOCATION_ID set and MainPID is me', async () => { /* … */ });
it('launchd supervisor: supervised iff XPC_SERVICE_NAME is our label and launchd pid is me; an orphan with ppid 1 is not', async () => { /* … */ });
it('relaunch supervisor keeps today’s rules', async () => { /* 기존 테스트가 새 시그니처로 그대로 통과 */ });
it('package mode: a newer package.json on disk means restartNeeded', async () => { /* … */ });
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/server/cli/service src/server/supervisorEnv.test.ts src/server/childRegistry.test.ts src/server/serverUpdate.test.ts --maxWorkers=2` → FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces. `runCli('service')` 의 기본 `run` 은 `execFile`(셸 없음), `bin` 은 `fs.realpathSync(process.argv[1])`, `execPath` 는 `process.execPath`, `ask` 는 `node:readline`. `UNSUPERVISED_MESSAGE` 에 "패키지로 설치했다면 `quarterdeck service install`" 한 문장 추가. `server.ts` 에 자식 사본·자식 기록·낡은 기록 정리 연결.
- [ ] **Step 4: 통과 확인** — 위 명령 PASS; `npx vitest run src/server src/shared --maxWorkers=2` PASS; `npx tsc --noEmit -p .` 0.
- [ ] **Step 5: 커밋 후 스모크** — `feat(packaging): quarterdeck service — 생존·종료 계약, systemd 사용자 유닛, macOS LaunchAgent, 소유권·롤백` 커밋 후 `bash scripts/pack-smoke.sh` → 완료(`service install --dry-run` 단계 포함).

---

### Task 8: 설치 문서와 전체 검증

**선행:** D1(패키지 이름·npm 조직)이 정해져 있다. 아니면 멈추고 보고.

**Files:**
- Modify: `package.json`(`name`, 스코프면 `publishConfig.access: "public"`), `README.md`, `README.ko.md`(설치 절)
- Test: 없음(검증 명령만)

- [ ] **Step 1: 이름 반영과 README 설치 절** — D1 이름을 `package.json` 에 넣는다. README 두 개: `npx <패키지>` · 전역 설치 `npm i -g <패키지>`(같은 이름의 `quarterdeck` 명령이 이미 있으면 EEXIST 로 실패 — 설치 전 `command -v quarterdeck` 확인, Task 3 Step 7-8 결과 근거) · `quarterdeck doctor` · `login-url` · `service install [--dry-run] [--node <경로>]` · 업그레이드 절차(`npm i -g <패키지>@latest` → `quarterdeck service restart`, 실행 중 서버는 재시작 전까지 옛 버전으로 돈다) · 버전 관리자(nvm 등) node 는 서비스에 쓰지 말 것 · 설정 폴더는 서버 하나만(별도 인스턴스는 `DECK_CONFIG_DIR` + `--port`) · 서비스 정지는 진행 중 턴을 최대 drain 상한(기본 25분)까지 기다림 · `uninstall` 은 데이터 폴더를 지우지 않음 · 각 CLI 로그인은 사용자가 터미널에서 · Node 24. 개인 경로·작업 폴더명 금지(위생 검사).
- [ ] **Step 2: 전체 검증**
  - `npx tsc --noEmit -p .` → 오류 0
  - `npx vitest run src/server src/shared --maxWorkers=2` → 전부 PASS
  - `npx vitest run src/ui --maxWorkers=2` → 전부 PASS
  - `npx vite build --outDir "$(mktemp -d)"` → 성공
  - 커밋 후 `bash scripts/pack-smoke.sh` → `pack-smoke: 완료`
  - `scripts/export-public.sh "$(mktemp -d)"` → `export-public: 완료`
  - `ls -1A ~/.config/deck` 의 파일 이름 목록이 작업 시작 때와 같고 `accounts.json`·`setup.json`·`cooldown/`·`server.lock`·`service.json`·`run/` 이 새로 생기지 않았다(테스트가 실제 설정 폴더에 쓰지 않았음. 단 이 맥의 서버가 그사이 사용자 지시로 재시작돼 새 코드로 돌면 `server.lock`·`run/` 은 정상).
- [ ] **Step 3: Linux 실기 확인(사용자 기기가 있을 때, 선택)** — tarball 을 옮겨 `npm i -g <tgz>` → `quarterdeck doctor` → `quarterdeck service install --dry-run` → `quarterdeck service install` → `systemctl --user status quarterdeck` active, `quarterdeck service status` 대조 일치 → UI "지금 재시작" 이 보이고 동작 → **계약 확인:** (a) 긴 턴 진행 중 `systemctl --user restart quarterdeck` → 턴이 끝난 뒤에야 새 pid(S2), (b) drain 상한을 1분으로 설치하고 끝나지 않는 턴 중 stop → 약 1분 뒤 중단·종료, `TimeoutStopSec` 전에 끝남(S3), (c) 서버에 `kill -9` → 재시작 전 그 cgroup 의 claude·grok 자식이 모두 사라짐(`systemd-cgls --user-unit quarterdeck`)(S4), (d) 같은 HOME 에서 `quarterdeck start --port 9401` → 락 거부(S1), (e) `npm i -g <새 tgz>` 후 UI 에 "재시작 필요", 그 상태에서 권한 요청이 정상 동작(S7), `service restart` 후 새 버전 → `ps -axww` 경고 여부(`ProcessHolders`) → `quarterdeck service uninstall`(데이터 폴더 그대로).
- [ ] **Step 4: macOS 실기 확인(이 맥이 아닌 맥, 선택)** — `service install` → `kill -9` 서버 → 새 서버 뜨기 전 자식(특히 detached grok) 정리(S4·S5) → Homebrew `brew upgrade node` 뒤 서비스 생존과 전체 디스크 접근 권한 유지 여부(심링크 경로로 등록한 권한이 실경로 변경 뒤에도 유효한지 — 결과를 README 와 D8 아래 메모에 기록).
- [ ] **Step 5: 커밋** — `docs: 패키지 설치 안내, 패키지 이름 확정`

---

## 결정 지점

| # | 질문 | 추천 | 대안 | 추천 이유 |
|---|---|---|---|---|
| D1 | npm 패키지 이름 | **스코프 패키지 `@<조직>/quarterdeck`, `bin` 은 `quarterdeck`** → 실행은 `npx @<조직>/quarterdeck`, 전역 설치 뒤엔 `quarterdeck`. **Task 8 전에 확정**(조직 확보 포함) | `quarterdeck-app` 같은 비스코프 이름 / 기존 이름 양도 협상 | **`quarterdeck` 은 npm 에 이미 있다**(0.12.8, 설명 "A quarterdeck foundation for coding agents", 2026-09-29 갱신 — 같은 영역 이름이라 혼동 위험). 스펙의 `npx quarterdeck` 은 그대로 쓸 수 없다. `@quarterdeck/cli` 는 2026-10-18 기준 비어 있으나 조직 확보 여부는 미확인. 기존 패키지도 `quarterdeck` bin 을 쓰면 둘 다 전역 설치한 사용자에게 EEXIST — 확정 전에 `npm view quarterdeck bin` 으로 확인하고, 겹치면 README 경고(Task 8)로 충분한지 bin 이름 변경이 필요한지 함께 정한다. 계획은 Task 8 전까지 이름을 하드코딩하지 않는다 |
| D2 | 서버 실행 방식 | **esbuild 번들(`dist/server`)** | `tsx` 를 dependencies 에 두고 `src` 를 그대로 배포 | 자식 스크립트를 `node x.ts` 로 띄우는 구조라 `node_modules` 안 `.ts` 거부(Review Focus 1)를 피하려면 어차피 `.js` 가 필요. tsx 경로로 바꾸면 PreToolUse 훅 호출마다 로더 기동 비용이 붙는다. 설치 크기·시작 시간도 번들이 작다 |
| D3 | 첫 실행 마법사 형태 | **웹 UI 마법사 + `quarterdeck doctor`(같은 감지 모듈의 텍스트 출력)** | 터미널 대화형 마법사만 / 둘 다 대화형 | 사용자는 대개 폰·다른 기기 브라우저로 본다. 감지 로직은 하나라 `doctor` 는 거의 공짜이고 원격 지원·버그 보고용으로 쓸모 있다 |
| D4 | 프로필 추가가 언제 적용되나 | **`accounts.json` 에 적고 다음 서버 시작부터**(관리자 있으면 "지금 재시작" 버튼) | 실행 중 레지스트리 교체(라이브 갱신) | 레지스트리와 `projectsRoots` 를 세션 색인·라우터·사용량·엔진이 시작 때 붙잡는다. 라이브 교체는 손댈 곳이 넓고 진행 중 턴과 엮인다. 추가는 드문 일 |
| D5 | 설정 폴더 | **`~/.config/deck` 유지, 없을 때만 `$XDG_CONFIG_HOME/deck`(절대 경로일 때)** | 새 이름 `quarterdeck` 폴더 + 이전 | 이 맥의 데이터·launchd·스크립트가 전부 `~/.config/deck` 을 본다. 이름을 바꾸면 이전 코드와 두 경로 유지 비용만 생긴다 |
| D6 | 이 맥의 이행과 설정 폴더 독점 | **지금은 옮기지 않는다** — 저장소 + relaunch 루프 + `com.deck.server` 그대로. **설정 폴더는 서버 하나가 독점**한다: 패키지 쪽은 같은 설정 폴더의 락이 살아 있거나, (관리자 없는 시작이면) relaunch 루프가 살아 있거나, 9320 이 차 있으면 시작을 거부하고, 서비스 설치는 거기에 `com.deck.server`(올라가 있거나 plist 가 있음)까지 보고 거부. 별도 인스턴스는 `DECK_CONFIG_DIR` + `--port` 를 함께 바꿀 때만 | 지금 패키지 설치로 갈아타기(`com.deck.server` 내리고 `quarterdeck service install`) / 포트만 다르면 허용 | 데이터 폴더가 같아 나중에 언제든 갈아탈 수 있다. 서버를 다시 띄우는 일이라 사용자 지시가 필요하다. 개발 중엔 저장소 실행이 맞다. 포트만 다른 두 서버가 같은 폴더를 쓰면 token·activity·쿨다운·push 가 서로 덮인다 |
| D7 | 로그인 토큰 전달 | **`quarterdeck login-url`(실행 인스턴스 포트를 락에서 읽음) + `#token=` 조각 자동 로그인, 시작 때는 TTY 일 때만 주소 출력** | 시작할 때마다 출력 / 지금처럼 파일 내용 붙여넣기만 | 조각은 서버 요청·접속 로그에 남지 않는다. 서비스 모드 로그 파일에 토큰이 남지 않게 TTY 일 때만 |
| D8 | macOS 패키지 서비스 라벨·포함 여부 | **포함, 라벨은 `local.quarterdeck.server` 로 지금 영구 고정**(도메인·npm 스코프가 정해져도 바꾸지 않음). 혹시 바꾸게 되면 `PREVIOUS_LAUNCHD_LABELS` 에 옛 이름을 넣어 표식 있는 옛 plist 를 내리고 지운다(코드는 Task 7 에 이미 있음) | macOS 는 전경 실행만(서비스 없음) / 도메인 정해지면 역DNS 로 변경 | 맥 사용자가 주 대상. 라벨은 설치본마다 남는 영구 식별자라, 바꾸면 옛 서비스와 새 서비스가 같은 설정 폴더로 겹쳐 뜰 수 있다(락이 막지만 사용자에게 혼란). 고정이 가장 싸다 |
| D9 | UI 전용 패키지 위치 | **devDependencies 로** | dependencies 유지 | UI 는 빌드돼 들어가므로 설치 때 react 등을 받을 이유가 없다 |
| D10 | 폰 페어링 QR | **계획 ④(릴레이)로 미룸**, 마법사는 접속 주소만 보여 줌 | 지금 LAN/Tailscale 주소 QR | QR 은 릴레이 페어링(일회용 키 교환)과 같은 화면이어야 하고, 지금 넣으면 의존성이나 자체 QR 인코더가 하나 더 생긴다 |
| D11 | 서비스 drain 상한 | **서비스 설치 시 유한값 기록(기본 25분, 1~28분), 관리자 강제 시한 = 상한 + 2분 ≤ 30분** | 현행처럼 무한 + 관리자 시한 1일 | 무한 drain 이면 stop/restart·로그아웃·업그레이드가 하루까지 멈춘다. relaunch(이 맥)는 무한을 유지 — 사람이 직접 지켜보는 개발 설치라서 |

## 사용자 몫 (이 계획의 작업이 아님)

- npm 조직·패키지 이름 확보(D1) — **Task 8 전에**. 정해지면 `package.json` 의 `name`(+스코프면 `publishConfig.access: "public"`)과 README 자리표시를 Task 8 이 바꾼다.
- 도메인·회사명 → `homepage`·`author`(macOS 서비스 라벨은 D8 로 고정돼 영향 없음).
- Paddle 가입·KYC, Anthropic·OpenAI·xAI 서면 확인(스펙 §3 규칙 7, §5.4).
- 이 맥을 패키지 설치로 옮길지와 그 시점(D6) — 서버 재시작이 따르므로 사용자 지시가 있을 때만.
- Linux·다른 맥 실기 확인(Task 8 Step 3·4)과, macOS 서비스를 쓸 때 node 에 전체 디스크 접근 권한 부여.
- 실제 `npm publish`(이 계획은 pack 까지만).

## 범위 밖

- Community/Pro 계정 수 제한, 라이선스 키, Pro 모듈 로딩 — 계획 ④.
- i18n·영어 기본 문자열 — 계획 ③(이 계획은 새 문자열을 두 파일에 모아 둘 뿐).
- Windows 서비스 — 2차.
- Gemini 두 번째 계정·Grok 두 번째 계정(`x2`) — 각 엔진 설계 v2.
- 이 맥의 relaunch 루프에 drain 상한·락 대기 같은 서비스 계약을 소급 적용하는 일(이 맥 전용 스크립트는 수정하지 않는다는 제약 유지).

## 검토 반영 기록

독립 교차 검토(Claude + GPT-6 Astra, 2026-10-18) 지적과 반영 위치.

| # | 지적 | 반영 위치 / 거절 사유 |
|---|---|---|
| 1 | 설정 폴더 단일 인스턴스 락(포트만 다르면 같은 폴더에 서버 둘) | 반영 — Task 2 `instanceLock.ts`(pid+port, 살아 있으면 거부, 낡은 락·pid 재사용·깨진 락 인수, relaunch 루프 감지), Global Constraints "설정 폴더 쓰기 순서", `server.order.test.ts`, 충돌 문구에 `DECK_CONFIG_DIR`, D6 "설정 폴더 독점", Review Focus 6, 스모크 13 |
| 2 | 다중 주소 listen 부분 실패 시 열린 서버·타이머 정리 | 반영 — Task 2 `listenAll` 계약 + `partial failure closes the servers already bound` 테스트, `startServer` 실패 경로의 정리·락 해제 |
| 3 | 서비스 종료·드레인 계약(KillMode=mixed, AbandonProcessGroup=true+KeepAlive 고아, TimeoutStopSec 상한) | 반영 — 새 절 "서비스 생존·종료 계약" S1~S7, Task 7 `systemdUnit`(KillMode=mixed 유지 이유 명시, `TimeoutStopSec` ≤1800), `launchAgentPlist`(`AbandonProcessGroup=false`, `ExitTimeOut`), `childRegistry`(detached grok), D11, Task 8 Step 3 (a)~(c)·Step 4 실기 확인 |
| 4 | 서비스 env 저장 주체 없음·launchd 대응 없음·login-url 포트 재현 | 반영 — Task 7 `record.ts`(`service.json`+`service.env`, 해석된 절대 경로·허용 env, plist 는 같은 기록에서 생성, `EnvironmentFile` 의 `-` 제거), 설치 후 락·MainPID·HTTP 401 검증, `status` 대조. login-url 은 Task 2 `readInstanceLock` 의 실행 인스턴스 포트 |
| 5 | `process.execPath` 버전 경로·업그레이드·실행 중 파일 교체 | 반영 — Task 7 `nodePath.ts`(Cellar → opt/bin 심링크, 버전 관리자 경로 거부, `--node`), `service restart`, S7 자식 스크립트 사본·패키지 버전 감지 "재시작 필요", Task 3 `splitting: false`, README 업그레이드 절, Task 8 Step 3 (e)·Step 4(TCC) |
| 6 | 토큰 존재로 기존 설치 판정 → 마법사 전 재시작 시 완료 처리 | 반영 — Task 5 `SetupStore` 첫 실행 즉시 `pending`, `existingInstall` 은 세션·activity 등 실제 데이터로, 다른 스토어가 쓰기 전에 계산 |
| 7 | `ppid===1` 판정은 고아도 참 | 반영 — Task 7 `supervisionCheck`: launchd `XPC_SERVICE_NAME === LAUNCHD_LABEL` + launchd pid 대조, systemd `INVOCATION_ID` + MainPID 대조. `supervisorEnv.ts` 로 CLI 자식·프로브 env 에서 제거(Global Constraints, Task 4 프로브) |
| 8 | 서비스 등록 소유권·롤백(표식, 남의 파일 비접촉, dry-run+TTY 확인, 종료 코드, 복원, 종료 확인 후 삭제, bootout 후 재등록, SSH gui 도메인, uninstall 데이터 비접촉, com.deck.server plist 존재) | 반영 — Task 7 `MANAGED_MARKER`, `serviceAction` 의 공통 거부·미리보기·확인·명령 실행 규칙·롤백·설치 후 검증·linux/darwin 절차, 각 항목 테스트. relaunch 루프 생존도 거부 조건에 추가 |
| 9 | 계정 파일 쓰기(백업, mutex/잠금, 최신본 재검증, symlink·소유권, 실패 시 빈 폴더만 정리, 추가 시점 재발견, 자동 발견 종료 고지) | 반영 — Task 5 `addClaudeProfile` 9단계 + 테스트 6개, Task 4 `SetupStatus.accountsFile`, Task 6 마법사 고지 |
| 10 | 설치 스모크 보강(`npm ci`, 저장소 밖 cwd, 임시 캐시, `npm i -g --prefix`, dry-run, 실제 `--settings`·MCP 명령 권한 왕복, 공백·한글, UI 자산, 프로세스 그룹 종료·포트 해제, plutil·systemd-analyze, env 정리) | 반영 — Task 3 Step 6(`fake-claude.mjs`·`turn.mjs`)·Step 7(15단계). `plutil -lint`·`systemd-analyze verify` 는 서비스 파일을 실제 설치하지 않고 검사할 수 있는 Task 7 단위 테스트 쪽에 둠(있을 때만) — 스모크의 dry-run 은 출력만 보므로 |
| 11 | 번들(`import.meta.url`/`__dirname` 전수, 외부 import 검사, 소스맵 위생) | 반영 — Task 3 전수 표 + 사용처 스냅숏 테스트, 빌드 실패 조건 ③④, `sourcemap: false`(켜면 `sourcesContent: false`), 스모크 4 에 `*.map` 없음 |
| 12 | D8 서비스 라벨을 영구 식별자로 지금 고정, 아니면 옛 라벨 정리 코드 | 반영 — D8 `local.quarterdeck.server` 영구 고정 + `PREVIOUS_LAUNCHD_LABELS`·`PREVIOUS_UNIT_NAMES` 정리 코드·테스트(둘 다). "스코프 기반" 라벨은 거절 — 스코프(D1)가 미정이고, 스코프가 바뀌어도 라벨이 따라 바뀌지 않는 편이 영구 식별자로 낫다 |
| 13a | `XDG_CACHE_HOME` 이 있어도 기존 `~/.cache/offload/cooldown` 을 놓치지 않게 | 반영 — Task 1 `legacyIntegrations` 후보 순서 + 테스트 |
| 13b | 상대 XDG 경로·`DECK_CONFIG_DIR` 절대화 기준 | 반영 — Task 1 `resolveConfigDir`(상대 XDG 무시, `DECK_CONFIG_DIR` 은 `~/` 확장·cwd 기준 절대화, 서비스는 절대 경로 기록) + 테스트 |
| 13c | CLI 프로브: 출력 상한·실행 실패와 비로그인 구분·타임아웃 후 종료 보장·원문 로그 금지 | 반영 — Task 4 `ProbeExec`(stdout·stderr 각 64KB, 프로세스 그룹 종료 후 `close` 확인, `spawnError` 구분), Global Constraints 원문 로그 금지, 테스트 2개 |
| 13d | `npm i -g` bin 이름 충돌(EEXIST) 사전 확인 | 반영 — Task 3 스모크 8, D1 확인 항목(`npm view quarterdeck bin`), Task 8 README 경고 |
| 13e | D1 조직 확보를 Task 8 전에 | 반영 — Global Constraints, Task 8 선행 조건, D1, 사용자 몫 |
| 추가 | Grok 감지 규칙(`DECK_GROK_BIN` → PATH → `~/.grok/bin/grok`, `grok models` 첫 줄) | 확인 — 원래도 `cfg.grokBin`(=`resolveGrokBin`)·`parseGrokModels` 로 들어 있었음. 보강: Task 4 에 Grok 프로브 절(감지가 따로 찾지 않음, `grokEnv` 로 `GROK_HOME` 고정, 첫 비지 않은 줄, 종료 코드 무시), `missingBinNote` 에 세 후보, 테스트, 스모크 6·10 에서 grok 을 `~/.grok/bin/grok` 에만 두고 찾는지 확인 |
