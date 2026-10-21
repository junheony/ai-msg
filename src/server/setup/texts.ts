// Server-side user strings for packaging (CLI, lock, doctor, service, setup wizard). Kept in one file for i18n (plan ③).

export const TEXTS = {
  portInUse: (port: number) => `포트 ${port} 에 이미 서버가 있습니다 — 같은 deck 이면 http://127.0.0.1:${port} 으로 접속하세요. 별도 인스턴스는 --port 와 DECK_CONFIG_DIR=<다른 폴더> 를 함께 지정해야 합니다(설정 폴더는 서버 하나만 씁니다)`,
  instanceLocked: (dir: string, pid: number | null, port: number | null) =>
    `설정 폴더 ${dir} 를 이미 서버(pid ${pid ?? '?'}, 포트 ${port ?? '?'})가 쓰고 있습니다 — 주소 http://127.0.0.1:${port ?? '?'}. 별도 인스턴스는 DECK_CONFIG_DIR=<다른 폴더> 로`,
  relaunchLoop: (dir: string) => `이 설정 폴더(${dir})는 relaunch 루프가 관리 중입니다 — 패키지 서버를 따로 띄우지 마세요`,
  startFailed: (msg: string) => `deck: 시작 실패 — ${msg}`,
  starting: '시작 중입니다 — 잠시 뒤 다시 시도하세요',
  loginUrlLine: (url: string) => `deck: 로그인 주소 ${url} (이 주소를 열면 바로 로그인됩니다 — 남에게 보여 주지 마세요)`,
  tokenFileLine: (file: string) => `deck: 로그인 토큰 파일 ${file} — 로그인 주소는 quarterdeck login-url 로 볼 수 있습니다`,
  notRunning: (port: number) => `deck: 서버가 실행 중이 아닙니다 — 설정 포트 ${port} 로 주소를 만듭니다`,
  noToken: (file: string) => `deck: 로그인 토큰(${file})이 없습니다 — 서버를 한 번 실행하세요`,
  notYet: (cmd: string) => `quarterdeck ${cmd}: 아직 없는 명령입니다`,
  badArgs: (msg: string) => `quarterdeck: ${msg} (quarterdeck --help)`,
  help: [
    '사용법: quarterdeck [명령] [옵션]',
    '',
    '  start [--port N]     서버 시작 (기본 명령)',
    '  login-url            실행 중인 서버의 로그인 주소 출력',
    '  doctor [--json]      설치·로그인 상태 점검',
    '  service <install|uninstall|status|restart> [--dry-run] [--yes] [--node 경로] [--port N] [--drain-max-min 1~28]',
    '                       상주 서비스 관리',
    '  --version            버전',
    '  --help               이 도움말',
    '',
    '환경 변수: DECK_CONFIG_DIR(설정 폴더), DECK_PORT(포트, 기본 9320)',
  ].join('\n'),
} as const;
