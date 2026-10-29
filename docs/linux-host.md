# MSG 리눅스 호스트

자체 리눅스(systemd)에서 MSG(`ai-msg`)를 상시 서비스로 띄우는 방법입니다. 맥의 LaunchAgent 는 그대로 두며, 새 호스트의 기준은 이쪽입니다. 라이브 서버에 적용하는 절차는 여기에 없고, 그 머신은 주인이 직접 다룹니다.

## 준비

- Node.js 24 (`node -v`).
- `systemctl --user` 가 동작하는 로그인 세션. SSH 만 있고 사용자 버스가 없으면 `ai-msg service install` 이 거절합니다. 그 경우 그 사용자로 로그인한 뒤 실행하거나, `loginctl enable-linger <user>` 로 로그아웃 뒤에도 사용자 서비스를 살려 둡니다.
- Claude Code / Codex / Grok CLI 는 평소 쓰는 터미널에서 되는 것과 같은 `PATH` 에 있어야 합니다. 설치기는 그 `PATH` 를 `service.env` 에 박제합니다.

## 설치

저장소에서:

```bash
npm install
npm run build
npm run build:server
node dist/server/bin.js service install --yes
```

`service install` 이 하는 일:

| 산출물 | 내용 |
| --- | --- |
| `~/.config/systemd/user/ai-msg.service` | 사용자 유닛. `ExecStart` 는 그 순간의 node 와 `dist/server/bin.js start`. |
| `~/.config/deck/service.env` | 유닛이 읽는 환경 (0600). `DECK_CONFIG_DIR`, `DECK_PORT`, 설치 시점의 `PATH`·`HOME`. |
| `~/.config/deck/service.json` | 설치 기록 (버전, 포트, 노드 경로). |

`XDG_CONFIG_HOME` 이 있으면 `~/.config` 대신 그 아래입니다. 설정 디렉터리(`DECK_CONFIG_DIR`)와 유닛 디렉터리는 다릅니다.

활성화는 설치기가 합니다 (`systemctl --user daemon-reload && enable --now`). 로그아웃해도 살려 두려면:

```bash
loginctl enable-linger "$USER"
```

## 확인·로그·갱신

```bash
systemctl --user status ai-msg.service
journalctl --user -u ai-msg.service -n 100 --no-pager
node dist/server/bin.js service status
```

코드를 갱신한 뒤:

```bash
npm run build && npm run build:server
node dist/server/bin.js service install --yes   # 유닛·service.env 를 다시 쓰고 재시작
```

node 경로가 바뀌면 반드시 다시 install 합니다. 유닛의 `ExecStart` 는 설치 시점의 절대 경로입니다.

## 맥 전용으로 남은 것

| 항목 | 리눅스 |
| --- | --- |
| LaunchAgent (`scripts/install-launchd.sh`, `~/.config/deck/env`) | 쓰지 않습니다. 리눅스 환경 파일은 `service.env` 입니다. |
| Claude Desktop 세션 목록 | 기본 경로가 macOS 앱 데이터라 리눅스에선 비어 있습니다. 따로 모아 둔 디렉터리가 있으면 `DECK_DESKTOP_SESSIONS_DIR`. |
| Grok Bot 앱 캐시에서 이어받기 | 맥 앱 경로입니다. 리눅스에선 `grok login` 과 세션 파일만 씁니다. |

엔진 자체(Claude, Codex, Grok CLI, agy)는 리눅스에서 동작합니다. 로그인 재인증은 사용량 창의 `재로그인` 이 그 자리의 로그인 명령만 실행합니다. 이 창은 셸이 아닙니다.

헤드리스(폰·다른 컴퓨터에서 Tailscale 로 접속)에서는 브라우저가 호스트에 열리지 않습니다. 각 자리는 이렇게 로그인합니다.

1. **Grok (x1).** 사용량 줄의 Grok → `재로그인`. 로그인 전에는 그 카드가 `로그인 필요`입니다. 창은 `grok login --device-auth` 를 실행합니다. 나온 주소와 코드를 다른 기기에서 입력하고, 창이 로그인됐다고 할 때까지 닫지 않습니다. 창이 끝나면 구독 사용량을 바로 다시 읽습니다. 서버를 다시 시작하지 않아도 카드에 사용량이 나타납니다. `grok models` 가 모델 목록을 보여 주면(첫 줄이 아직 "not authenticated" 여도) 로그인된 것으로 봅니다.
2. **Gemini (g1).** Gemini → `재로그인`. 창은 실제 홈에서 `agy` 를 실행하고 D-Bus 세션 주소는 넘기지 않습니다. Enter 가 Google 로그인을 고릅니다(메뉴가 보이면 창이 Enter 를 한 번 보냅니다). 한 줄로 나온 주소를 다른 기기에서 열고, 브라우저가 준 코드를 붙여 넣습니다. 상태는 `~/.gemini` 에 남습니다.
3. **Gemini 2 (g2).** Gemini 2 → `재로그인`. 같은 흐름이고 HOME 은 `~/.agy-g2` 입니다. g1 과 다른 Google 계정으로 로그인합니다. 사용량과 세션은 그 홈의 것입니다. git 설정과 `~/.ssh` 는 그 폴더로 링크됩니다.

키링이 잠겨 있으면 agy 는 파일에 자격 증명을 둡니다. 예전에 키링으로만 로그인했다면 각 Gemini 자리를 한 번 다시 로그인하세요.

## 유닛이 지키는 것

- `KillMode=mixed`: 첫 SIGTERM 은 서버만 받아 진행 중인 턴을 마무리하고, 남은 프로세스는 종료 뒤 정리됩니다. 중지 대기는 drain 상한 + 2분입니다.
- `Restart=always`, 단 설정 오류로 즉시 죽는 종료 코드 78 은 재시작하지 않습니다 (같은 오류를 반복하지 않음).
- `EnvironmentFile` 에 `-` 가 없습니다. `service.env` 가 없으면 시작이 실패로 보입니다.
