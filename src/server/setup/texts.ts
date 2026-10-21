import type { EngineId, LoginState } from '../../shared/setup-types';

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

const CLI_NAME: Record<EngineId, string> = { claude: 'claude', codex: 'codex', gemini: 'agy', grok: 'grok' };
const BIN_VAR: Record<EngineId, string> = { claude: 'DECK_CLAUDE_BIN', codex: 'DECK_CODEX_BIN', gemini: 'DECK_GEMINI_BIN', grok: 'DECK_GROK_BIN' };

/** What the user runs in a terminal to log in. `profileDir` (`~/…`): a Claude profile other than the default `~/.claude`. */
export function loginCommandFor(engine: EngineId, profileDir?: string): string {
  switch (engine) {
    case 'claude': return profileDir ? `CLAUDE_CONFIG_DIR=${profileDir} claude auth login` : 'claude auth login';
    case 'codex': return 'codex login';
    case 'gemini': return 'agy';
    case 'grok': return 'grok login';
  }
}

/** One sentence after the login command (Gemini's has no subcommand). */
export function loginHint(engine: EngineId, command: string): string {
  return engine === 'gemini' ? `터미널에서 ${command} 를 인자 없이 실행 → 브라우저에서 Google 로그인` : `터미널에서 ${command}`;
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
