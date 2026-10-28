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

엔진 자체(Claude, Codex, Grok CLI)는 리눅스에서 동작합니다. 로그인 재인증은 사용량 창의 `재로그인` 이 그 CLI 의 로그인 명령만 실행합니다.

## 유닛이 지키는 것

- `KillMode=mixed`: 첫 SIGTERM 은 서버만 받아 진행 중인 턴을 마무리하고, 남은 프로세스는 종료 뒤 정리됩니다. 중지 대기는 drain 상한 + 2분입니다.
- `Restart=always`, 단 설정 오류로 즉시 죽는 종료 코드 78 은 재시작하지 않습니다 (같은 오류를 반복하지 않음).
- `EnvironmentFile` 에 `-` 가 없습니다. `service.env` 가 없으면 시작이 실패로 보입니다.
