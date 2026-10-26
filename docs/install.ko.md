# AI-MSG 설치

[English](install.md) | 한국어

AI-MSG 는 내 컴퓨터에서 돌면서, 이미 설치하고 로그인해 둔 코딩 에이전트 CLI 를 구동합니다. 이 안내는 설치, CLI 별 로그인, 폰에서 열기, 서비스로 실행, 업그레이드, 삭제를 다룹니다.

## 요구 사항

| | |
|---|---|
| Node.js | 24 이상 |
| OS | macOS(지원 플랫폼) 또는 Linux(서버와 Claude·Codex 엔진은 돌지만 덜 검증됨). Windows 는 아직 지원하지 않습니다. |
| CLI 하나 이상 | Claude Code(`claude`, 2.1.259 이상, 2.1.283 권장), Codex CLI(`codex`, 0.159 이상), Antigravity CLI 로 쓰는 Gemini(`agy`), Grok Build CLI(`grok`) |
| 선택 | 폰에서 열 때 쓰는 Tailscale |

## 빠른 시작

```bash
npx ai-msg
```

> **npm 에 아직 없습니다:** 패키지를 아직 올리지 않아 위 한 줄은 지금은 동작하지 않습니다. 저장소에서 직접 실행하세요 — [CONTRIBUTING.md](../CONTRIBUTING.md#run-from-the-repository) (영어). <!-- npm-pending -->

터미널에 로그인 주소가 나옵니다.

```
AI-MSG: login address http://127.0.0.1:9320/#token=… (opening it logs you in at once — don't show it to anyone)
```

같은 컴퓨터의 브라우저에서 그 주소를 엽니다. 첫 실행 마법사가 네 CLI 를 나열하고, 어느 것이 설치돼 있고 로그인돼 있는지 보여 주며, 안 된 것에는 로그인 명령을 알려 줍니다. 나중에 설정에서 다시 열 수 있습니다.

주소에는 로그인 토큰이 들어 있어서 터미널에만 출력하고 서비스 로그에는 남기지 않습니다. 토큰은 처음 시작할 때 `~/.config/deck/token`(권한 `0600`)에 만들어집니다. 모든 브라우저의 로그인을 끊으려면 그 파일을 지우고 다시 시작하세요.

## CLI 별 로그인

AI-MSG 는 대신 로그인하지 않고 CLI 의 토큰도 읽지 않습니다. 각 CLI 의 명령으로 터미널에서 한 번씩 로그인하세요.

| CLI | 명령 |
|---|---|
| Claude Code | `claude auth login` |
| Codex | `codex login` |
| Gemini(Antigravity) | 인자 없이 `agy` 를 실행하고 브라우저에서 Google 로 로그인 |
| Grok | `grok login` |

두 번째 Claude 계정은 두 번째 Claude Code 프로필 폴더입니다. 예: `CLAUDE_CONFIG_DIR=~/.claude-b claude auth login`. [Claude 계정 여러 개 쓰기](../README.ko.md#claude-계정-여러-개-쓰기)를 보세요. 새 CLI 를 설치했다면 AI-MSG 를 다시 시작해야 찾습니다.

## 언어

설정 › 화면 › 언어(설정의 첫 묶음)에서 영어와 한국어 중에 고릅니다. 고른 값은 그 기기에 적용되고, 알림과 서버 문구는 어느 기기에서든 마지막으로 고른 언어를 따릅니다. 아직 고르지 않았다면 서버는 `DECK_LANG`(`en` 또는 `ko`), 그다음 `LC_ALL`, `LC_MESSAGES`, `LANG`, 그다음 영어를 따릅니다. `ai-msg --help`, `ai-msg doctor`, `ai-msg service install` 은 터미널의 환경을 따릅니다.

화면 번역을 진행 중이라 일부 화면은 아직 한국어로만 나옵니다.

## 폰에서 열기

서버는 `127.0.0.1` 과 이 컴퓨터의 Tailscale 주소에서만 듣고 `0.0.0.0` 에서는 듣지 않습니다. 두 기기 모두 Tailscale 이 켜져 있으면 폰에서 `http://<tailscale-ip>:9320` 을 엽니다. Web Push 와 홈 화면 설치는 HTTPS 가 필요하며 `tailscale serve` 가 제공합니다. 예:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:9320
```

자세한 내용과 `Host` 규칙은 [원격 접속](../README.ko.md#원격-접속)에 있습니다. Tailscale·HTTPS 설정 없이 어디서든 세션에 닿는 것은 Pro(출시 예정)에서 제공할 계획입니다.

## 설치 확인

```bash
ai-msg doctor          # 설치·로그인된 CLI, Claude 프로필별
ai-msg doctor --json   # 같은 내용을 JSON 으로
ai-msg login-url       # 로그인 주소를 다시 출력
```

`login-url` 은 실행 중인 서버의 포트를 읽고, 서버가 없으면 `DECK_PORT`(기본 `9320`)로 주소를 만들며 그렇다고 알려 줍니다.

## 서비스로 실행

서비스는 로그인할 때 AI-MSG 를 켜고, 종료되면 다시 켭니다. npx 캐시에서는 돌 수 없으므로(캐시가 비워질 수 있음) 먼저 전역으로 설치하세요.

```bash
npm i -g ai-msg
ai-msg service install --dry-run   # 쓸 파일과 명령만 보여 주고 바꾸지 않음
ai-msg service install             # 쓰기 전에 묻습니다. --yes 로 건너뜀
ai-msg service status
```

macOS 에서는 LaunchAgent(`local.ai-msg.server`), Linux 에서는 systemd 사용자 유닛(`ai-msg.service`)입니다.

`service install` 옵션:

| 옵션 | 뜻 |
|---|---|
| `--dry-run` | 쓸 것과 실행할 것만 보여 주고 아무것도 쓰지 않습니다. |
| `--yes` | 확인을 묻지 않습니다(터미널이 아닐 때 필요). |
| `--node <path>` | 서비스가 쓰는 node 바이너리. 기본값: 명령을 실행한 node. |
| `--port N` | 서비스의 포트(기본 `DECK_PORT` 또는 `9320`). |
| `--drain-max-min N` | 정지·재시작 때 돌고 있는 턴을 기다리는 분(1~28, 기본 25). |

설치기가 확인하는 것:

- **버전 관리자의 node 는 안 됩니다.** nvm, fnm, volta, asdf, mise, n 의 node 는 버전을 바꾸면 서비스가 깨지므로 거부합니다. 안정적인 것을 직접 주세요. 예: `ai-msg service install --node /opt/homebrew/bin/node`.
- **macOS:** SSH 가 아니라 로그인된 데스크톱 세션에서 실행하세요(LaunchAgent 를 거기서는 올릴 수 없습니다). 프로젝트가 `~/Documents`, 데스크탑, 다운로드 아래에 있으면 설치기가 알려 주는 node 경로를 시스템 설정 › 개인정보 보호 및 보안 › 전체 디스크 접근 권한에 추가하세요. node 를 업그레이드한 뒤에는 `ai-msg doctor` 로 권한이 유지되는지 확인하세요. 서비스 로그는 `~/.config/deck/ai-msg.log` 입니다.
- **Linux:** 로그인 세션에서 실행하세요(`systemctl --user` 가 필요). 로그아웃한 뒤에도 서비스를 돌리려면 `loginctl enable-linger` 를 실행하세요. 로그: `journalctl --user -u ai-msg`.
- 서비스에 필요한 설정(CLI 경로, 허용된 `DECK_*` 변수, 포트, 정지 대기 상한)은 설치할 때 기록됩니다. 바꾼 뒤에는 `ai-msg service install` 을 다시 실행하세요.

## 업그레이드

```bash
npm i -g ai-msg@latest
ai-msg service restart
```

실행 중인 서버는 재시작 전까지 옛 버전입니다. 재시작이 필요하면 `ai-msg service status` 가 알려 줍니다. 재시작은 돌고 있는 턴을 정지 대기 상한까지 기다립니다.

## 정지와 삭제

```bash
ai-msg service uninstall
```

서비스를 멈추고 파일을 지웁니다. 정지는 돌고 있는 턴을 정지 대기 상한(기본 25분)까지 기다립니다. 데이터 폴더(`~/.config/deck`)는 남기니, 지우고 싶으면 직접 지우세요. 그다음 `npm uninstall -g ai-msg`.

## 설정 폴더 하나에 서버 하나

설정 폴더 하나는 한 번에 서버 하나만 씁니다. 같은 폴더에서 두 번째 서버를 띄우면 시작을 거부하고 이미 돌고 있는 서버의 주소를 알려 줍니다. 따로 돌리려면 다른 폴더와 다른 포트를 함께 주세요.

```bash
DECK_CONFIG_DIR=~/.config/deck-test ai-msg --port 9400
```

## 설정 폴더와 환경변수

AI-MSG 가 보관하는 모든 것(토큰, 설정, 계정, 세션 상태, 감사 로그, 첨부, 푸시 키)은 `~/.config/deck` 또는 `DECK_CONFIG_DIR` 에 있습니다. 대화 기록은 각 CLI 가 두는 자리에 그대로 있습니다. 모든 설정은 선택인 `DECK_*` 환경변수이며 [설정](../README.ko.md#설정)과 [파일](../README.ko.md#파일)에 있습니다.

## 문제 해결

| 메시지 | 할 일 |
|---|---|
| A server is already on port 9320 | AI-MSG 라면 `http://127.0.0.1:9320` 을 여세요(`ai-msg login-url` 이 로그인 주소를 출력). 아니면 `--port` 와 다른 `DECK_CONFIG_DIR` 로 시작하세요. |
| The config folder is already used by a server | 다른 AI-MSG 가 이 폴더를 쓰고 있습니다. 그것을 멈추거나(`ai-msg service status` 로 확인) 다른 `DECK_CONFIG_DIR` 를 쓰세요. |
| Run this from a logged-in macOS GUI session | SSH 로 `service install` 을 실행했습니다. Mac 에서 터미널로 실행하세요. |
| No systemd user session | 로그인 세션에서 실행하세요. `sudo` 나 단독 `su` 로는 안 됩니다. |
| CLI 가 not found 로 보임 | 설치해서 `PATH` 에 두거나 `DECK_CLAUDE_BIN`, `DECK_CODEX_BIN`, `DECK_GEMINI_BIN`, `DECK_GROK_BIN` 으로 가리키고 다시 시작하세요. |

## Windows

아직 지원하지 않습니다.
