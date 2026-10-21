// Which CLIs are installed and whether each is logged in — for the setup wizard and `quarterdeck doctor` only
// (turns never pre-check a login, design §5). Login state comes from the official status commands' output / exit code;
// only the fields named below are read, and raw output is never logged or returned.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { codexEnv, geminiEnv } from '../../shared/accounts';
import type { ClaudeProfileProbe, EngineId, EngineProbe, LoginState } from '../../shared/setup-types';
import type { DeckConfig } from '../config';
import { MIN_CLAUDE_VERSION } from '../engine/claudeCli/version';
import { grokEnv } from '../engine/grokEnv';
import { stripSupervisorEnv } from '../supervisorEnv';
import { PROBE_TEXTS, loginCommandFor, missingBinNote } from './texts';

export type ProbeResult = { code: number | null; stdout: string; timedOut: boolean; spawnError?: 'ENOENT' | 'EACCES' | 'OTHER' };
export type ProbeExec = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ProbeResult>;

const OUTPUT_CAP = 64 * 1024;
const KILL_GRACE_MS = 2000;
/** After the child exited (or was SIGKILLed): how long to wait for its pipes to close before closing them ourselves. */
const CLOSE_GRACE_MS = 500;
const DEFAULT_TIMEOUT_MS = 15_000;

const spawnErrorKind = (e: unknown): 'ENOENT' | 'EACCES' | 'OTHER' => {
  const code = (e as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'EACCES' ? code : 'OTHER';
};

/**
 * No shell, own process group, stdin closed. stdout kept up to 64 KB (the rest is read and dropped), stderr dropped.
 * On timeout: SIGTERM to the group, SIGKILL 2 s later. The result comes once the child has closed; if a grandchild that
 * left the group still holds the pipes, they are closed by force shortly after the child exited (or was SIGKILLed), so a
 * result always comes.
 */
export const defaultExec: ProbeExec = (bin, args, env, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const done = (r: ProbeResult) => { if (!settled) { settled = true; resolve(r); } };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    done({ code: null, stdout: '', timedOut: false, spawnError: spawnErrorKind(e) });
    return;
  }
  let stdout = '';
  let timedOut = false;
  let hardKill: NodeJS.Timeout | undefined;
  let forceClose: NodeJS.Timeout | undefined;
  const killGroup = (sig: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ }
  };
  const finish = (code: number | null) => {
    clearTimeout(timer);
    clearTimeout(hardKill);
    clearTimeout(forceClose);
    child.stdout!.destroy();
    child.stderr!.destroy();
    done({ code, stdout, timedOut });
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => { if (stdout.length < OUTPUT_CAP) stdout += c.slice(0, OUTPUT_CAP - stdout.length); });
  child.stderr!.resume();
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    hardKill = setTimeout(() => {
      killGroup('SIGKILL');
      if (!forceClose) forceClose = setTimeout(() => finish(null), CLOSE_GRACE_MS);
    }, KILL_GRACE_MS);
  }, timeoutMs);
  child.on('error', (e) => {
    if (child.pid !== undefined) return; // a running child's late error: 'close' still decides
    clearTimeout(timer);
    done({ code: null, stdout: '', timedOut: false, spawnError: spawnErrorKind(e) });
  });
  child.on('exit', (code) => {
    const exitCode = timedOut ? null : code;
    clearTimeout(forceClose);
    forceClose = setTimeout(() => {
      killGroup('SIGKILL'); // leftovers still in the group
      finish(exitCode);
    }, CLOSE_GRACE_MS);
  });
  child.on('close', (code) => {
    finish(timedOut ? null : code);
  });
});

/** `claude auth status --json`: the `loggedIn` field only. */
export function parseClaudeAuth(stdout: string): LoginState {
  try {
    const v = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
    return v === true ? 'yes' : v === false ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `codex login status`: exit 0 = logged in, "Not logged in" = not. */
export function parseCodexLogin(code: number | null, stdout: string): LoginState {
  if (code === 0) return 'yes';
  return stdout.includes('Not logged in') ? 'no' : 'unknown';
}

/** `grok models`: the first non-empty line (the exit code is always 0). */
export function parseGrokModels(stdout: string): LoginState {
  const first = stdout.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  if (/^You are logged in/.test(first)) return 'yes';
  return /not authenticated/i.test(first) ? 'no' : 'unknown';
}

/** A run that said nothing usable about login: why (never reported as logged out). */
function failure(r: ProbeResult, timeoutMs: number): string | null {
  if (r.spawnError) return PROBE_TEXTS.spawnFailed(r.spawnError);
  if (r.timedOut) return PROBE_TEXTS.timedOut(Math.round(timeoutMs / 1000));
  return null;
}

const firstLine = (r: ProbeResult): string | null => (r.code === 0 && !r.spawnError && !r.timedOut ? r.stdout.split('\n').map((l) => l.trim()).find((l) => l)?.slice(0, 120) ?? null : null);

function tilde(dir: string, home: string): string {
  if (dir === home) return '~';
  return dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
}

export type ProbeProfile = { id: string; label: string; dir: string; home: boolean; active: boolean; env: Record<string, string | undefined> };

export async function probeEngines(o: {
  cfg: Pick<DeckConfig, 'claudeBin' | 'codexBin' | 'geminiBin' | 'grokBin' | 'grokHome' | 'home'>;
  profiles: ReadonlyArray<ProbeProfile>;
  env: NodeJS.ProcessEnv;
  exec?: ProbeExec;
  timeoutMs?: number;
}): Promise<{ engines: EngineProbe[]; claudeProfiles: ClaudeProfileProbe[] }> {
  const exec = o.exec ?? defaultExec;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = (bin: string, args: string[], env: Record<string, string | undefined>) => exec(bin, args, stripSupervisorEnv(env), timeoutMs);
  const { cfg } = o;

  const missing = (engine: EngineId): EngineProbe => ({ engine, bin: null, version: null, login: 'unknown', loginCommand: loginCommandFor(engine), note: missingBinNote(engine) });

  /** codex / gemini / grok: `--version` and one status command, in parallel. */
  const probeOther = async (engine: EngineId, bin: string | null, env: Record<string, string | undefined>, status: string[], parse: (r: ProbeResult) => LoginState): Promise<EngineProbe> => {
    if (!bin) return missing(engine);
    const [v, s] = await Promise.all([run(bin, ['--version'], env), run(bin, status, env)]);
    const why = failure(s, timeoutMs);
    return { engine, bin, version: firstLine(v), login: why ? 'unknown' : parse(s), loginCommand: loginCommandFor(engine), ...(why ? { note: why } : {}) };
  };

  const probeProfile = async (p: ProbeProfile): Promise<ClaudeProfileProbe> => {
    const custom = p.env.CLAUDE_CONFIG_DIR !== undefined;
    const base = { id: p.id, label: p.label, dir: tilde(p.dir, cfg.home), home: p.home, active: p.active, loginCommand: loginCommandFor('claude', custom ? tilde(p.dir, cfg.home) : undefined) };
    if (!cfg.claudeBin.ok) return { ...base, login: 'unknown' };
    const r = await run(cfg.claudeBin.bin, ['auth', 'status', '--json'], p.env);
    return { ...base, login: failure(r, timeoutMs) ? 'unknown' : parseClaudeAuth(r.stdout) };
  };

  const [claudeProfiles, codex, gemini, grok] = await Promise.all([
    Promise.all(o.profiles.map(probeProfile)),
    probeOther('codex', cfg.codexBin, codexEnv(o.env), ['login', 'status'], (r) => parseCodexLogin(r.code, r.stdout)),
    probeOther('gemini', cfg.geminiBin, geminiEnv(o.env), ['models'], (r) => (r.code === 0 ? 'yes' : 'no')),
    probeOther('grok', cfg.grokBin, grokEnv(o.env, cfg.grokHome), ['models'], (r) => parseGrokModels(r.stdout)),
  ]);

  let claude: EngineProbe;
  const cb = cfg.claudeBin;
  if (cb.ok) {
    const active = claudeProfiles.filter((p) => p.active);
    const login: LoginState = active.some((p) => p.login === 'yes') ? 'yes' : active.length > 0 && active.every((p) => p.login === 'no') ? 'no' : 'unknown';
    claude = { engine: 'claude', bin: cb.bin, version: cb.version, login, loginCommand: loginCommandFor('claude') };
  } else if (cb.reason === 'too_old') {
    claude = { engine: 'claude', bin: cb.bin, version: cb.version, login: 'unknown', loginCommand: loginCommandFor('claude'), note: PROBE_TEXTS.claudeTooOld(cb.version, MIN_CLAUDE_VERSION) };
  } else {
    claude = missing('claude');
  }
  return { engines: [claude, codex, gemini, grok], claudeProfiles };
}
