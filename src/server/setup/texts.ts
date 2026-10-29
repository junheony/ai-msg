import type { EngineId, LoginState } from '../../shared/setup-types';

// Server-side user strings for packaging (CLI, lock, doctor, service, setup wizard). Kept in one file for i18n (plan ③).

export const TEXTS = {
  portInUse: (port: number) => `포트 ${port} 에 이미 서버가 있습니다 — 같은 deck 이면 http://127.0.0.1:${port} 으로 접속하세요. 별도 인스턴스는 --port 와 DECK_CONFIG_DIR=<다른 폴더> 를 함께 지정해야 합니다(설정 폴더는 서버 하나만 씁니다)`,
  instanceLocked: (dir: string, pid: number | null, port: number | null) =>
    `설정 폴더 ${dir} 를 이미 서버(pid ${pid ?? '?'}, 포트 ${port ?? '?'})가 쓰고 있습니다 — 주소 http://127.0.0.1:${port ?? '?'}. 별도 인스턴스는 DECK_CONFIG_DIR=<다른 폴더> 로`,
  relaunchLoop: (dir: string) => `이 설정 폴더(${dir})는 relaunch 루프가 관리 중입니다 — 패키지 서버를 따로 띄우지 마세요`,
  startFailed: (msg: string) => `deck: 시작 실패 — ${msg}`,
  fatalBackoff: (sec: number) => `deck: 재시작해도 같은 이유로 실패합니다 — ${sec}초 뒤 종료합니다(원인을 고친 뒤 ai-msg service restart)`,
  starting: '시작 중입니다 — 잠시 뒤 다시 시도하세요',
  loginUrlLine: (url: string) => `deck: 로그인 주소 ${url} (이 주소를 열면 바로 로그인됩니다 — 남에게 보여 주지 마세요)`,
  tokenFileLine: (file: string) => `deck: 로그인 토큰 파일 ${file} — 로그인 주소는 ai-msg login-url 로 볼 수 있습니다`,
  notRunning: (port: number) => `deck: 서버가 실행 중이 아닙니다 — 설정 포트 ${port} 로 주소를 만듭니다`,
  noToken: (file: string) => `deck: 로그인 토큰(${file})이 없습니다 — 서버를 한 번 실행하세요`,
  notYet: (cmd: string) => `ai-msg ${cmd}: 아직 없는 명령입니다`,
  badArgs: (msg: string) => `ai-msg: ${msg} (ai-msg --help)`,
  help: [
    '사용법: ai-msg [명령] [옵션]',
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

const CLI_NAME: Record<EngineId, string> = { claude: 'claude', codex: 'codex', gemini: 'agy', grok: 'grok' };
const BIN_VAR: Record<EngineId, string> = { claude: 'DECK_CLAUDE_BIN', codex: 'DECK_CODEX_BIN', gemini: 'DECK_GEMINI_BIN', grok: 'DECK_GROK_BIN' };

/** What the user runs in a terminal to log in. `profileDir` (`~/…`): a Claude profile other than the default `~/.claude`. */
export function loginCommandFor(engine: EngineId, profileDir?: string): string {
  switch (engine) {
    case 'claude': return profileDir ? `CLAUDE_CONFIG_DIR=${profileDir} claude auth login` : 'claude auth login';
    case 'codex': return 'codex login';
    case 'gemini': return 'agy';
    case 'grok': return 'grok login --device-auth';
  }
}

/** One sentence after the login command. Headless hosts finish Grok and agy from the usage-strip re-login window. */
export function loginHint(engine: EngineId, command: string): string {
  if (engine === 'gemini') return `사용량의 재로그인 (${command}) — Enter 로 Google 로그인, 주소를 열고 코드를 붙여 넣기`;
  if (engine === 'grok') return `사용량의 재로그인 (${command}) — 다른 기기에서 주소와 코드를 입력`;
  return `터미널에서 ${command}`;
}

export function missingBinNote(engine: EngineId): string {
  const cli = CLI_NAME[engine];
  const where = engine === 'grok' ? ` (찾아본 곳: DECK_GROK_BIN, PATH, ~/.grok/bin/grok)` : '';
  return `${cli} 를 찾지 못했습니다 — 설치 후 PATH 에 두거나 ${BIN_VAR[engine]} 으로 지정하세요${where}`;
}

export const PROBE_TEXTS = {
  claudeTooOld: (version: string, min: string) => `claude ${version} 은 너무 오래됐습니다 — ${min} 이상으로 업데이트하세요`,
  spawnFailed: (kind: string) => `실행하지 못했습니다(${kind})`,
  timedOut: (sec: number) => `응답 없음(${sec}초)`,
  login: { yes: '로그인됨', no: '로그인 안 됨', unknown: '확인 못 함' } satisfies Record<LoginState, string>,
  missing: '찾지 못함',
  noVersion: '버전 모름',
  retired: '쉬는 계정',
  homeProfile: '기본',
  profile: '프로필',
} as const;

/** Claude profile add (setup wizard, plan ② Task 5): the `error` of POST /api/setup/profiles. */
export const PROFILE_TEXTS = {
  badId: (id: string, pattern: string) => `계정 id "${id}" 는 쓸 수 없습니다 — 영문 소문자·숫자로 시작하는 16자 이하(${pattern})`,
  reservedId: (id: string) => `계정 id "${id}" 는 다른 자리에 쓰는 이름입니다`,
  duplicate: (id: string) => `이미 있는 계정입니다: ${id}`,
  badLabel: '이름은 1~40자여야 합니다',
  badRequest: '잘못된 프로필 추가 요청입니다',
  symlink: (file: string) => `${file} 이 심볼릭 링크라 건드리지 않습니다 — 직접 정리한 뒤 다시 시도하세요`,
  notOwner: (file: string) => `${file} 의 소유자가 이 사용자가 아니라 건드리지 않습니다`,
  notDir: (file: string) => `${file} 이 폴더가 아닙니다`,
  brokenFile: (msg: string) => `계정 파일을 고치기 전에는 추가할 수 없습니다 — ${msg}`,
  invalid: (msg: string) => `계정을 추가할 수 없습니다 — ${msg}`,
  changed: '계정 파일이 그사이 바뀌었습니다 — 다시 시도하세요',
  busy: '다른 곳에서 계정 파일을 고치는 중입니다 — 잠시 뒤 다시 시도하세요',
} as const;

/** `ai-msg service` (plan ② Task 7). */
export const SERVICE_TEXTS = {
  windows: 'Windows 서비스는 아직 지원하지 않습니다',
  npxCache: 'npx 캐시에서 실행 중이라 서비스로 등록할 수 없습니다(캐시가 지워지면 서비스가 죽습니다) — 전역 설치(npm i -g <패키지>) 뒤 다시 실행하세요',
  nodeVersionManager: (p: string) => `버전 관리자의 node(${p})는 버전을 바꾸면 서비스가 죽습니다 — --node <안정 경로>(예: 시스템·Homebrew node)로 지정하세요`,
  nodeCellarNoLink: (p: string) => `Homebrew node(${p})의 안정 경로(opt/…/bin/node, bin/node)를 찾지 못했습니다 — --node <경로>로 지정하세요`,
  nodeMissing: (p: string) => `--node ${p} 를 실행할 수 없습니다`,
  nodeOld: (p: string, v: string) => `--node ${p} 는 ${v} 입니다 — Node 24 이상이 필요합니다`,
  nodeTcc: 'macOS 권한(전체 디스크 접근)은 이 node 경로에 줍니다 — node 를 업그레이드한 뒤 권한이 유지되는지 ai-msg doctor 로 확인하세요',
  notOurs: (file: string) => `남이 만든 파일이라 건드리지 않습니다: ${file}`,
  lockHeld: (pid: number, port: number) => `이 설정 폴더를 쓰는 서버(pid ${pid}, 포트 ${port})가 이미 있습니다 — 먼저 끄세요`,
  portBusy: (port: number) => `포트 ${port} 에 이미 서버가 있습니다 — 그 서버를 끄거나 --port 로 다른 포트를 지정하세요`,
  noUserBus: 'systemd 사용자 세션이 없습니다(systemctl --user 가 동작하지 않음) — 이 사용자로 로그인한 뒤 실행하거나, loginctl enable-linger 로 로그아웃 뒤에도 사용자 서비스를 켜 두세요',
  noGui: 'macOS 에 로그인한 GUI 세션에서 실행하세요(SSH 에서는 LaunchAgent 를 올릴 수 없습니다)',
  legacy: '이 맥은 저장소 방식 서비스(com.deck.server/relaunch)로 돌고 있습니다 — 패키지 서비스는 설치하지 않습니다',
  needConfirm: '확인이 필요합니다 — --yes 또는 --dry-run',
  askInstall: '설치할까요? [y/N] ',
  askUninstall: '서비스를 내리고 지울까요? [y/N] ',
  cancelled: '취소했습니다',
  dryRunHead: 'dry-run: 아무것도 쓰거나 실행하지 않습니다',
  dryRunNoProbe: 'dry-run: launchctl/systemctl 상태 확인도 하지 않습니다 — 실제 설치 때 다시 확인합니다',
  fileHead: (file: string) => `── ${file}`,
  commandsHead: '실행할 명령:',
  nodeLine: (node: string) => `node: ${node}`,
  warning: (s: string) => `경고: ${s}`,
  commandFailed: (cmd: string, code: number, stderr: string) => `명령 실패(종료 코드 ${code}): ${cmd}${stderr ? ` — ${stderr}` : ''}`,
  writeFailed: (file: string, msg: string) => `파일을 쓰지 못했습니다: ${file} — ${msg}`,
  rolledBack: '이전 상태로 되돌렸습니다',
  rollbackFailed: (msg: string) => `되돌리기 실패: ${msg}`,
  notVerified: (log: string) => `서비스가 기록된 설정으로 뜨지 않았습니다 — 로그: ${log}`,
  installed: (port: number) => `서비스를 설치했습니다 — http://127.0.0.1:${port} (로그인 주소: ai-msg login-url)`,
  lingerHint: '로그아웃 뒤에도 돌게 하려면: loginctl enable-linger',
  tccHint: (node: string) => `macOS: 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한에 ${node} 를 추가하세요`,
  notInstalled: '설치된 서비스가 없습니다',
  orphanUnloaded: (label: string) => `plist 없이 올라가 있던 ${label} 를 내렸습니다`,
  launchdRestartPlan: 'kill -TERM <서버 pid>  (실행 중이 아니면 launchctl kickstart)',
  notStopped: (file: string) => `서비스가 멈추지 않아 파일을 지우지 않았습니다: ${file}`,
  uninstalled: '서비스를 내리고 지웠습니다',
  dataKept: (dir: string) => `데이터 폴더 ${dir} 는 그대로 둡니다`,
  previousRemoved: (name: string) => `예전 이름의 서비스를 정리했습니다: ${name}`,
  restarted: '재시작을 요청했습니다 — 진행 중인 턴이 끝나면(최대 drain 상한) 새 서버로 바뀝니다',
  statusUnit: (file: string, state: string) => `서비스: ${state} (${file})`,
  statusRecord: (node: string, bin: string, port: number, drain: number) => `기록: node ${node} · bin ${bin} · 포트 ${port} · drain 상한 ${drain}분`,
  statusNoRecord: '기록: 없음',
  statusLock: (pid: number, port: number, version: string, supervisor: string | null) => `실행 중: pid ${pid} · 포트 ${port} · 버전 ${version || '?'} · 관리자 ${supervisor ?? '없음'}`,
  statusNoLock: '실행 중: 없음',
  statusDisk: (version: string) => `디스크의 패키지 버전: ${version}`,
  statusMismatch: '업그레이드 뒤 재시작 필요: ai-msg service restart',
  statusPortMismatch: (rec: number, live: number) => `기록된 포트 ${rec} 와 실행 중인 포트 ${live} 가 다릅니다 — ai-msg service install 로 다시 설치하세요`,
} as const;
