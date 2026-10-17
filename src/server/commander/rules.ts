/**
 * 총사령탑 3층(실행 중 차단) — 설계 §5. 자동 턴(`commanderHop`)의 PreToolUse 훅이 Bash·`mcp__*` 호출마다 묻는다.
 * 기본은 `ask`(권한 카드), 작은 허용 목록만 `allow`. 순수 함수.
 * 1층 `screenInstruction` 은 상태 머신(4단계)과 함께 들어온다. 읽기 도구 경로 판정(`gateReadTool`)만 realpath 로 디스크를 본다.
 */
import fs from 'node:fs';
import path from 'node:path';

export type GateDecision = 'allow' | 'ask';

/**
 * 자동 턴에서 편집 도구가 한 번이라도 불렸는지 — 그 뒤 테스트 러너·git 은 ask(편집+러너 = 임의 코드 실행). 이 프로세스의
 * 편집에 더해, 세션 상태(`SessionState.commanderEdited`)에 남은 이전 자동 턴의 편집도 포함(사람 턴이 시작되면 풀린다).
 */
export type GateContext = {
  runnerConfigChanged: boolean;
  /** 읽기 명령(cat·grep…)의 경로 인자를 판정할 루트(`gateReadTool` 과 같은 기준). 없으면 읽기 명령도 ask. */
  roots?: ReadRoots;
};

/**
 * 자동 턴에서 손대면 사람 확인(ask)이 필요한 경로: `.claude/`·`.claude-<이름>/`(CLI 설정·훅·명령, 프로필별 설정 디렉터리) 와
 * `.git/`(훅·설정) 아래, 그리고 그 자체. `.claude.json`(CLI 전역 설정·MCP).
 * 경로 조각 단위 비교(`.gitignore`·`.claudeignore` 는 아님). 슬래시·백슬래시 모두. 대소문자 무시(macOS 기본 파일시스템은
 * `.Claude/` 가 `.claude/` 와 같은 디렉터리).
 */
const PROTECTED_EDIT_RE = /(?:^|[\\/])(?:\.(?:claude(?:-[^\\/]*)?|git)(?:[\\/]|$)|\.claude\.json$)/i;
/** 어느 디렉터리에 있든 모델 지시·MCP 설정 파일: `CLAUDE.md`·`CLAUDE.local.md`·`AGENTS.md`·`.mcp.json`. */
const PROTECTED_FILE_RE = /(?:^|[\\/])(?:claude(?:\.local)?\.md|agents\.md|\.mcp\.json)$/i;

export function isProtectedEditPath(filePath: string): boolean {
  return PROTECTED_EDIT_RE.test(filePath) || PROTECTED_FILE_RE.test(filePath);
}

/** 자동 턴의 읽기 도구 판정에 쓰는 루트: 세션 cwd 와 이 세션에 허용된 디렉터리. `home` 은 `~` 풀이용. */
export type ReadRoots = { cwd: string; allowDirs: readonly string[]; home: string; /** 상대 경로를 풀 기준(훅 입력의 cwd). 없으면 `cwd`. */ base?: string };

/** cwd 안이어도 읽기는 ask 인 파일: `.env`·`.env.*`(대소문자 무시). */
const SECRET_FILE_RE = /^\.env(?:\..*)?$/i;
/**
 * glob 패턴이 루트 밖을 가리킬 수 있는지: 맨 앞·중괄호 대안(`{`·`,` 뒤)의 `/`·`~`, `..` 조각, 백슬래시(윈도 경로·이스케이프).
 * `**\/*.{ts,tsx}` 같은 흔한 꼴은 통과.
 */
const GLOB_OUTSIDE = /(?:^|[{,])\s*[\/~]|(?:^|[\/{,])\.\.(?:[\/},]|$)|\\/;
/** glob 패턴이 `.env` 파일을 겨냥하는지. */
const GLOB_SECRET = /(?:^|[\/{,])\.env/i;

/** 있는 데까지 realpath 로 풀고 없는 꼬리는 그대로 붙인다(심볼릭 링크 디렉터리로 바깥을 가리키는 것까지 본다). */
function realish(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** 절대 경로 `target` 이 realpath 기준으로 세션 cwd·allowDirs 안이고 `.env`·`.env.*` 가 아닌지. */
function insideRoots(target: string, roots: ReadRoots): boolean {
  if (!roots.cwd || !path.isAbsolute(roots.cwd)) return false;
  const real = realish(target);
  if (SECRET_FILE_RE.test(path.basename(target)) || SECRET_FILE_RE.test(path.basename(real))) return false;
  const rootList = [roots.cwd, ...roots.allowDirs.filter((d) => path.isAbsolute(d))].map(realish);
  return rootList.some((r) => within(real, r));
}

/**
 * 자동 턴 편집 도구의 대상 경로 판정. 보호 경로(원문과 realpath 둘 다 — cwd 안 심볼릭 링크로 `.claude`·`.git` 을 가리키는
 * 우회 차단)거나 realpath 가 세션 cwd·allowDirs 밖이면 ask. 상대 경로는 `base`(없으면 cwd) 기준.
 */
export function gateEditPath(filePath: string, roots: ReadRoots): 'pass' | 'ask' {
  if (filePath.includes('\0') || isProtectedEditPath(filePath)) return 'ask';
  if (!roots.cwd || !path.isAbsolute(roots.cwd)) return 'ask';
  const target = path.resolve(roots.base ?? roots.cwd, filePath);
  const real = realish(target);
  if (isProtectedEditPath(target) || isProtectedEditPath(real)) return 'ask';
  const rootList = [roots.cwd, ...roots.allowDirs.filter((d) => path.isAbsolute(d))].map(realish);
  return rootList.some((r) => within(real, r)) ? 'pass' : 'ask';
}

/**
 * 읽기 도구(Read·NotebookRead·Glob·Grep·LS)의 경로 판정. 'pass' = 판정 없이 통과(CLI 의 보통 권한 흐름), 'ask' = 사람 확인.
 * 대상(`file_path`·`notebook_path`·`path`, Glob·Grep·LS 는 없으면 cwd)을 `~` 풀고 상대면 `base` 기준으로 풀어 realpath 로
 * 본다 — 세션 cwd·allowDirs 밖이면 ask. `.env`·`.env.*` 는 안이어도 ask. Glob 의 `pattern`·Grep 의 `glob` 이 바깥이나
 * `.env` 를 가리켜도 ask. 경로가 문자열이 아니거나 `~user` 같이 애매하면 ask.
 */
export function gateReadTool(toolName: string, input: unknown, roots: ReadRoots): 'pass' | 'ask' {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const key = toolName === 'Read' ? 'file_path' : toolName === 'NotebookRead' ? 'notebook_path' : 'path';
  const raw = i[key];
  let target: string;
  if (raw === undefined || raw === null || raw === '') {
    if (key !== 'path') return 'ask';
    target = roots.base ?? roots.cwd;
  } else if (typeof raw !== 'string' || raw.includes('\0')) {
    return 'ask';
  } else if (raw === '~' || raw.startsWith('~/')) {
    target = path.join(roots.home, raw.slice(1));
  } else if (raw.startsWith('~')) {
    return 'ask';
  } else {
    target = path.resolve(roots.base ?? roots.cwd, raw);
  }
  if (!insideRoots(target, roots)) return 'ask';
  for (const g of [toolName === 'Glob' ? i.pattern : undefined, toolName === 'Grep' ? i.glob : undefined]) {
    if (g === undefined) continue;
    if (typeof g !== 'string' || GLOB_OUTSIDE.test(g) || GLOB_SECRET.test(g)) return 'ask';
  }
  return 'pass';
}

/**
 * 셸이 해석하는 연산·치환이 하나라도 있으면 허용 목록 불인정: 파이프·`;`·`&`(&&·||·백그라운드 포함)·리다이렉트·
 * `$`(변수·`$(…)`·`${IFS}`)·백틱·괄호(zsh glob 한정자 `*(e:…:)` 는 코드를 실행한다)·줄바꿈. 따옴표 안에 있어도 그대로 ask(보수적).
 */
const SHELL_META = /[|;&<>$`()\n\r\0]/;

/**
 * 인자 한 단어가 cwd 밖을 가리킬 수 있는지: 절대경로·`~`(맨 앞, `=` 뒤, 짧은 옵션에 붙은 꼴 포함), `..` 경로 조각,
 * 중괄호 확장(`{/etc/x,}`). `./...`(go 패키지 패턴)는 `..` 조각이 아니다.
 */
const OUTSIDE_CWD = /^(?:-[A-Za-z0-9]*)?[\/~]|=[\/~]|(?:^|[\/=])\.\.(?:\/|$)|[{]/;

/**
 * 옵션 화이트리스트 한 벌. 여기 없는 `-` 로 시작하는 단어는 전부 거부(→ ask): git 의 장옵션 축약(`--out`·`--ext`·
 * `--textc`)이나 러너의 실행·설정 옵션(`-toolexec`·`--root`·`--globalSetup`·`--manifest-path`)이 저절로 빠진다.
 */
type ArgSpec = {
  flags: ReadonlySet<string>;
  /** 단어 전체가 맞아야 하는 꼴(`-n5`·`--format=…`). */
  patterns: readonly RegExp[];
  /** 값을 다음 단어로 받는 옵션과 그 값의 꼴. */
  next: ReadonlyMap<string, RegExp>;
  /** 단독 `--` 뒤: 'rest' = 나머지는 위치 인자(검사 안 함), 다른 벌 = 그 벌로 계속, 없음 = 거부. */
  dashdash?: 'rest' | ArgSpec;
  /** 위치 인자(옵션이 아닌 단어)는 cwd 상대만. */
  cwdPaths: boolean;
};

const spec = (flags: string[], patterns: RegExp[] = [], next: [string, RegExp][] = [], rest: Partial<Pick<ArgSpec, 'dashdash' | 'cwdPaths'>> = {}): ArgSpec =>
  ({ flags: new Set(flags), patterns, next: new Map(next), cwdPaths: true, ...rest });

const ANY = /^.+$/s;
const NUM = /^\d+$/;
const GIT_COLOR = /^--color=(?:always|never|auto)$/;
const GIT_DIFF_OUT = ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '-p', '--patch', '--no-patch', '--color', '--no-color', '-w', '--ignore-all-space', '--ignore-space-change', '--word-diff', '--summary', '--raw', '--minimal', '--patience', '--histogram', '--no-renames'];
const GIT_DIFF_PAT = [GIT_COLOR, /^-U\d+$/, /^--unified=\d+$/, /^--stat=\d+(?:,\d+)*$/, /^--word-diff=(?:color|plain|porcelain|none)$/];
const GIT_FORMAT = /^--(?:pretty|format)=.*$/s;
const gitSpec = (flags: string[], patterns: RegExp[] = [], next: [string, RegExp][] = []) => spec(flags, patterns, next, { dashdash: 'rest', cwdPaths: false });

/** git status/diff/log/show 의 허용 옵션. 위치 인자(리비전·경로)는 그대로(`main..HEAD` 가 흔하다). */
const GIT_READ: ReadonlyMap<string, ArgSpec> = new Map([
  ['status', gitSpec(['-s', '--short', '-b', '--branch', '--porcelain', '--long', '-v', '--verbose', '--ignored', '--no-renames'], [/^--porcelain=v[12]$/, /^(?:-u|--untracked-files)(?:=?(?:no|normal|all))?$/])],
  ['diff', gitSpec([...GIT_DIFF_OUT, '--cached', '--staged', '--check', '-R'], GIT_DIFF_PAT)],
  ['log', gitSpec([...GIT_DIFF_OUT, '--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--reverse', '--first-parent', '--no-merges', '--merges', '--follow', '--abbrev-commit', '-s'],
    [...GIT_DIFF_PAT, GIT_FORMAT, /^-\d+$/, /^-n\d+$/, /^--max-count=\d+$/, /^--skip=\d+$/, /^--(?:since|until|after|before|author|committer|grep)=.+$/s, /^--date=(?:relative|local|iso|iso-strict|rfc|short|raw|default|unix|human)$/, /^--decorate=(?:short|full|auto|no)$/],
    [['-n', NUM]])],
  ['show', gitSpec([...GIT_DIFF_OUT, '--oneline', '--abbrev-commit', '-s'], [...GIT_DIFF_PAT, GIT_FORMAT])],
]);
const GIT_BRANCH_LIST_OPTS = new Set(['--list', '-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose']);

const VITEST = spec(['run', '--run', '--silent', '--passWithNoTests', '--bail'],
  [/^--reporter=(?:default|verbose|dot|json|basic|tap|tap-flat|junit|hanging-process|github-actions)$/, /^--(?:max|min)Workers=\d+%?$/, /^--testNamePattern=.+$/s, /^--testTimeout=\d+$/, /^--retry=\d+$/, /^--bail=\d+$/],
  [['-t', ANY], ['--testNamePattern', ANY]]);
const JEST = spec(['--ci', '--runInBand', '-i', '--silent', '--verbose', '--passWithNoTests', '--no-cache', '--bail', '--onlyChanged', '-o', '--detectOpenHandles', '--forceExit'],
  [/^--maxWorkers=\d+%?$/, /^--testNamePattern=.+$/s, /^--bail=\d+$/, /^--testTimeout=\d+$/, /^--watchAll=false$/],
  [['-t', ANY], ['--testNamePattern', ANY]]);
const PYTEST = spec(['-q', '-v', '-vv', '-vvv', '-x', '-s', '--lf', '--ff', '--last-failed', '--failed-first', '--no-header', '-ra', '-rA', '--exitfirst', '--quiet', '--verbose', '--co', '--collect-only'],
  [/^--tb=(?:auto|long|short|line|native|no)$/, /^--maxfail=\d+$/, /^--durations=\d+$/],
  [['-k', ANY], ['-m', ANY]]);
const GO_TEST = spec(['-v', '-race', '-short', '-cover', '-failfast', '-json'],
  [/^-(?:run|skip|bench)=.+$/s, /^-count=\d+$/, /^-timeout=[\d.]+(?:ns|us|ms|s|m|h)?$/, /^-parallel=\d+$/],
  [['-run', ANY], ['-skip', ANY], ['-bench', ANY], ['-count', NUM], ['-timeout', /^[\d.]+(?:ns|us|ms|s|m|h)?$/]]);
/** `cargo test -- …` 뒤는 테스트 바이너리 인자. */
const CARGO_TEST_BIN = spec(['--nocapture', '--ignored', '--include-ignored', '--exact', '--show-output', '-q', '--quiet'], [/^--test-threads=\d+$/]);
const CARGO_TEST = spec(['--release', '--lib', '--bins', '--tests', '--doc', '--all', '--workspace', '--all-targets', '-q', '--quiet', '--no-fail-fast'], [], [], { dashdash: CARGO_TEST_BIN });
/** `npm test` 의 인자는 스크립트 속 러너로 넘어가 무엇이 될지 모른다: 위치 인자와 `--silent` 만. */
const NPM_TEST = spec(['--silent', '-s']);

/** §3 테스트 러너와 그 인자가 시작하는 자리. 접두는 `npx`·`yarn`·`pnpm exec` 하나만(뒤에 vitest·jest·pytest). */
function testRunner(w: readonly string[]): { spec: ArgSpec; at: number } | null {
  const i = w[0] === 'npx' || w[0] === 'yarn' ? 1 : w[0] === 'pnpm' && w[1] === 'exec' ? 2 : 0;
  const name = w[i];
  if (name === 'vitest') return { spec: VITEST, at: i + 1 };
  if (name === 'jest') return { spec: JEST, at: i + 1 };
  if (name === 'pytest') return { spec: PYTEST, at: i + 1 };
  if (i !== 0 || w[1] !== 'test') return null;
  if (name === 'go') return { spec: GO_TEST, at: 2 };
  if (name === 'cargo') return { spec: CARGO_TEST, at: 2 };
  if (name === 'npm' || name === 'pnpm') return { spec: NPM_TEST, at: 2 };
  return null;
}

function argsAllowed(args: readonly string[], s: ArgSpec): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return s.dashdash === 'rest' ? true : s.dashdash ? argsAllowed(args.slice(i + 1), s.dashdash) : false;
    if (a.startsWith('-')) {
      if (s.flags.has(a) || s.patterns.some((r) => r.test(a))) continue;
      const v = s.next.get(a);
      if (!v || i + 1 >= args.length || !v.test(args[i + 1]!)) return false;
      i++;
      continue;
    }
    if (s.cwdPaths && OUTSIDE_CWD.test(a)) return false;
  }
  return true;
}

const READ_ONLY = new Set(['ls', 'grep', 'rg', 'cat', 'head', 'tail', 'wc']);
/** rg 의 `--pre`(파일마다 명령 실행)·`--pre-glob`. */
const RG_EXEC_OPT = /^--pre(?:-glob)?(?:=|$)/;
/**
 * 읽기 명령별로 ask 인 옵션: 심볼릭 링크를 따라 들어가는 것(grep `-R`·BSD `-S`·`--dereference-recursive`, rg `-L`·`--follow`,
 * ls `-L`·`--dereference`)과 파일 목록을 다른 파일에서 읽는 wc `--files0-from`. 짧은 옵션은 묶음(`-rnR`) 안에서도 찾는다.
 */
const READ_ONLY_DENY: Readonly<Record<string, RegExp>> = {
  grep: /^(?:-[^-]*[RS]|--dereference-recursive(?:=|$))/,
  rg: /^(?:-[^-]*L|--follow(?:=|$))/,
  ls: /^(?:-[^-]*L|--dereference(?:=|$))/,
  wc: /^--files0-from(?:=|$)/,
};
/** grep·rg 의 `-f<파일>`(패턴 파일)처럼 짧은 옵션에 붙은 경로. */
const ATTACHED_FILE = /^-[A-Za-z]*f(.+)$/s;

/**
 * 셸 단어 나누기: 따옴표·백슬래시를 푼 값과, 따옴표 밖에 glob 문자(`*`·`?`·`[`)가 있었는지. SHELL_META 를 거른 뒤라 치환은
 * 없다. 따옴표가 닫히지 않으면 null.
 */
function shellWords(s: string): { w: string; glob: boolean }[] | null {
  const out: { w: string; glob: boolean }[] = [];
  let w = '';
  let glob = false;
  let inWord = false;
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") { if (c === "'") q = ''; else w += c; continue; }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) w += s[++i];
      else w += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (inWord) out.push({ w, glob });
      w = ''; glob = false; inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'" || c === '"') q = c;
    else if (c === '\\') { if (i + 1 < s.length) w += s[++i]; }
    else { if (c === '*' || c === '?' || c === '[') glob = true; w += c; }
  }
  if (q) return null;
  if (inWord) out.push({ w, glob });
  return out;
}

/**
 * 읽기 명령의 인자 판정. 위치 인자와 경로를 받는 옵션 값(`--file=…`·`-f…`)은 `gateReadTool` 과 같은 기준(realpath 로
 * cwd·allowDirs 안, `.env` 아님). 옵션 단어 자체는 예전처럼 글자로도 본다(절대 경로·`..` 가 붙으면 ask). 옵션의 다음 단어도 위치 인자로 본다(패턴이 경로처럼 보이면 ask — 보수적). 따옴표 밖 glob 은
 * 셸이 무엇으로 펼칠지(심볼릭 링크·`.env`) 미리 볼 수 없어 ask.
 */
function readArgsAllowed(head: string, args: readonly { w: string; glob: boolean }[], roots: ReadRoots): boolean {
  const base = roots.base ?? roots.cwd;
  // 셸이 펼치는 `~`(맨 앞·`=` 뒤)·중괄호는 글자로 거르고, 나머지(절대 경로·`..`·심볼릭 링크)는 realpath 로 본다.
  const ok = (p: string) => !/(?:^|=)~|[{]/.test(p) && insideRoots(path.resolve(base, p), roots);
  let opts = true;
  for (const { w, glob } of args) {
    if (glob) return false;
    if (opts && w === '--') { opts = false; continue; }
    if (opts && w.startsWith('-')) {
      if (OUTSIDE_CWD.test(w) || READ_ONLY_DENY[head]?.test(w) || (head === 'rg' && RG_EXEC_OPT.test(w))) return false;
      const eq = w.startsWith('--') ? w.indexOf('=') : -1;
      const attached = (head === 'grep' || head === 'rg') && !w.startsWith('--') ? ATTACHED_FILE.exec(w)?.[1] : undefined;
      const value = eq > 0 ? w.slice(eq + 1) : attached;
      if (value !== undefined && value !== '' && !ok(value)) return false;
      continue;
    }
    if (!ok(w)) return false;
  }
  return true;
}

/** Bash 명령 하나가 허용 목록에 드는지. 조금이라도 애매하면 false(→ ask). */
export function isAllowedCommand(command: string, ctx: GateContext): boolean {
  const raw = command.trim();
  if (!raw || SHELL_META.test(raw)) return false;
  // 셸이 지우는 따옴표·백슬래시를 지운 꼴로 인자를 본다(`--p"re"` = `--pre`, `"/etc"` = `/etc`).
  const rawWords = raw.split(/\s+/);
  const words = raw.replace(/["'\\]/g, '').split(/\s+/);
  /** 명령 이름 자리(앞 n 단어)는 따옴표·백슬래시 없이 그대로여야 한다(`"git" status` 는 ask). */
  const plainHead = (n: number) => rawWords.length === words.length && words.slice(0, n).every((w, i) => w === rawWords[i]);
  const runner = testRunner(words);
  if (runner) return !ctx.runnerConfigChanged && plainHead(runner.at) && argsAllowed(words.slice(runner.at), runner.spec);
  const head = words[0]!;
  if (READ_ONLY.has(head)) {
    if (!plainHead(1) || !ctx.roots) return false;
    const parsed = shellWords(raw);
    return !!parsed && readArgsAllowed(head, parsed.slice(1), ctx.roots);
  }
  if (head === 'git') {
    if (ctx.runnerConfigChanged || !plainHead(2)) return false;
    const sub = words[1] ?? '';
    const s = GIT_READ.get(sub);
    if (s) return argsAllowed(words.slice(2), s);
    if (sub === 'branch') {
      const rest = words.slice(2);
      return rest.includes('--list') && rest.every((w) => !w.startsWith('-') || GIT_BRANCH_LIST_OPTS.has(w));
    }
  }
  return false;
}

/** 3층 판정. Bash 는 허용 목록, `mcp__*` 와 그 밖의 도구는 늘 ask. */
export function gateTool(toolName: string, input: unknown, ctx: GateContext): GateDecision {
  if (toolName !== 'Bash') return 'ask';
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  return typeof command === 'string' && isAllowedCommand(command, ctx) ? 'allow' : 'ask';
}
