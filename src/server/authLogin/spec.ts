import { geminiSeatHome, type GeminiAccount } from '../../shared/accounts';
import type { EngineId } from '../../shared/setup-types';
import { loginCommandFor } from '../setup/texts';

/**
 * The only processes the in-app login window may start. The browser sends a seat id; the server picks the binary and
 * argv from this table. Nothing here is a shell. agy has no login subcommand: the window runs `agy` with no arguments
 * (its welcome screen) inside that seat's HOME, and the owner pastes the Google code. It is still not a shell.
 */
export type AuthAccounts = {
  has(id: string): boolean;
  isRetired(id: string): boolean;
  isHome(id: string): boolean;
  profileDir(id: string): string;
  label(id: string): string;
};

export type AuthBins = { claude: string | null; codex: string | null; grok: string | null; gemini: string | null };

export type AuthTarget = {
  seat: string;
  engine: EngineId;
  /** What the window shows. Not passed to a shell. */
  label: string;
  bin: string;
  args: readonly string[];
  /** Extra environment on top of the small allowlist (a non-home Claude profile, or an agy seat's HOME). */
  extraEnv: Record<string, string>;
  /** Linux pty columns. agy hard-wraps the OAuth URL to the width; a wide pty keeps it on one line. */
  cols?: number;
};

/** Markers only: agy treats an SSH session as headless and writes the token to a file instead of opening a browser. */
const AGY_SSH_MARKERS = { SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 22', SSH_CLIENT: '127.0.0.1 0 22' } as const;

const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

/** The server resolves CLI paths before this window. A relative name would be a PATH lookup the client could influence. */
function absoluteBin(bin: string | null, missing: string): string | { error: string } {
  if (!bin) return { error: missing };
  if (!bin.startsWith('/')) return { error: '로그인 프로그램 경로가 절대 경로가 아닙니다' };
  return bin;
}

/** `~/…` when `dir` is under `home`, otherwise the absolute path. */
export function displayDir(dir: string, home: string): string {
  if (dir === home) return '~';
  const prefix = home.endsWith('/') ? home : `${home}/`;
  return dir.startsWith(prefix) ? `~/${dir.slice(prefix.length)}` : dir;
}

/**
 * The seat the usage strip asked for → the one login command that seat uses. Unknown seats and retired Claude
 * accounts are refused. `bin` must already be the absolute path the server resolved; a relative path is refused.
 */
export function authTarget(seat: string, accounts: AuthAccounts, bins: AuthBins, home: string): AuthTarget | { error: string } {
  if (!SEAT_RE.test(seat)) return { error: '알 수 없는 자리입니다' };
  if (seat === 'gpt') {
    const bin = absoluteBin(bins.codex, 'codex 를 찾지 못했습니다');
    if (typeof bin !== 'string') return bin;
    return { seat, engine: 'codex', label: loginCommandFor('codex'), bin, args: ['login'], extraEnv: {} };
  }
  if (seat === 'x1') {
    const bin = absoluteBin(bins.grok, 'grok 을 찾지 못했습니다');
    if (typeof bin !== 'string') return bin;
    return { seat, engine: 'grok', label: loginCommandFor('grok'), bin, args: ['login', '--device-auth'], extraEnv: {} };
  }
  if (seat === 'g1' || seat === 'g2') {
    const bin = absoluteBin(bins.gemini, 'agy 를 찾지 못했습니다');
    if (typeof bin !== 'string') return bin;
    const account = seat as GeminiAccount;
    const seatHome = geminiSeatHome(account, home);
    const shown = displayDir(seatHome, home);
    return {
      seat,
      engine: 'gemini',
      label: account === 'g1' ? 'agy' : `HOME=${shown} agy`,
      bin,
      args: [],
      extraEnv: { HOME: seatHome, ...AGY_SSH_MARKERS },
      cols: 500,
    };
  }
  if (!accounts.has(seat) || accounts.isRetired(seat)) return { error: '그 Claude 계정은 다시 로그인할 수 없습니다' };
  const claude = absoluteBin(bins.claude, 'claude 를 찾지 못했습니다');
  if (typeof claude !== 'string') return claude;
  const dir = accounts.profileDir(seat);
  if (!dir.startsWith('/')) return { error: '프로필 경로가 절대 경로가 아닙니다' };
  const homeProfile = accounts.isHome(seat);
  const shown = homeProfile ? undefined : displayDir(dir, home);
  return {
    seat,
    engine: 'claude',
    label: loginCommandFor('claude', shown),
    bin: claude,
    args: ['auth', 'login'],
    extraEnv: homeProfile ? {} : { CLAUDE_CONFIG_DIR: dir },
  };
}

/** One line the person pastes (the code), or a bare Enter. Control characters and extra lines are refused. */
export function authInputLine(body: { text?: unknown; enter?: unknown }): { line: string } | { error: string } {
  if (body.enter === true && (body.text === undefined || body.text === '')) return { line: '\n' };
  if (typeof body.text !== 'string') return { error: '코드를 붙여 넣으세요' };
  const text = body.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
  if (!text) return { error: '코드를 붙여 넣으세요' };
  if (text.length > 4000) return { error: '코드가 너무 깁니다' };
  if (text.includes('\n')) return { error: '코드는 한 줄만 보낼 수 있습니다' };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { error: '코드에 넣을 수 없는 문자가 있습니다' };
  return { line: `${text}\n` };
}

/** Single-quote for `script -c` on Linux. Null when the string contains a quote or a newline — those never come from our argv. */
export function shellSingleQuote(s: string): string | null {
  if (/[\0\n\r']/.test(s)) return null;
  return `'${s}'`;
}

/**
 * How to ask the OS `script` command for a pty. macOS `script` execs the command and its arguments itself. Linux
 * util-linux only has `-c`, so the command is `exec` of the quoted binary — the person's keystrokes never enter that
 * string; they are written to the pty after `exec`.
 */
export function scriptInvocation(platform: NodeJS.Platform, bin: string, args: readonly string[], opts?: { cols?: number }): { cmd: string; argv: string[] } | { error: string } {
  if (!bin.startsWith('/') || /[\0\n\r]/.test(bin)) return { error: '로그인 프로그램 경로가 올바르지 않습니다' };
  for (const a of args) if (/[\0\n\r]/.test(a)) return { error: '로그인 프로그램 경로가 올바르지 않습니다' };
  if (platform === 'darwin') return { cmd: 'script', argv: ['-q', '/dev/null', bin, ...args] };
  const quoted = [bin, ...args].map(shellSingleQuote);
  if (quoted.some((q) => q === null)) return { error: '로그인 프로그램 경로가 올바르지 않습니다' };
  const cols = opts?.cols;
  const wide = typeof cols === 'number' && Number.isInteger(cols) && cols >= 80 && cols <= 1000 ? `stty cols ${cols} rows 40; ` : '';
  const line = `${wide}exec ${quoted.join(' ')}`;
  return { cmd: 'script', argv: ['-q', '-e', '-f', '-c', line, '/dev/null'] };
}

/** A hard-wrapped URL (agy splits a long OAuth URL on the pty width, with no extra spaces) back into one line. */
function joinWrappedUrls(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1]! : null;
    const cont = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(line) && !/^https?:/.test(line);
    if (prev !== null && /https?:\/\/\S*$/.test(prev) && cont) out[out.length - 1] = prev + line;
    else out.push(line);
  }
  return out.join('\n');
}

/** Drop ANSI and carriage returns so the window is readable text, including the login URL. */
export function plainTerminal(chunk: string): string {
  return joinWrappedUrls(chunk
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b./g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, ''));
}

const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK'] as const;

/** The login process sees a small environment: the paths it needs, plus the profile dir. Not the server's secrets. */
export function authChildEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };
  for (const k of ENV_KEEP) if (base[k]) env[k] = base[k];
  for (const [k, v] of Object.entries(base)) if (k.startsWith('LC_') && v) env[k] = v;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
