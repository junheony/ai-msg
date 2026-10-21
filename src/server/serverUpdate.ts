import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { LAUNCHD_LABEL, SERVICE_NAME } from './cli/service/record';

/**
 * Server code newer than the running process: how many files, and the newest one's mtime (ms; null = none). A package
 * install (no `src/server`) reports an upgraded package.json as one changed file plus `restartNeeded`/`reason`.
 */
export type ServerUpdate = { changedFiles: number; newestAt: number | null; restartNeeded?: true; reason?: string };

/** The code a restart would load: non-test `.ts` under src/server and src/shared. */
const DIRS = [path.join('src', 'server'), path.join('src', 'shared')];
const isSource = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts');

async function mtimes(dir: string, out: number[]): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') await mtimes(p, out); return; }
    if (!e.isFile() || !isSource(e.name)) return;
    try { out.push((await fs.stat(p)).mtimeMs); } catch { /* gone mid-scan */ }
  }));
}

/** Every source file's mtime under `root` (the deck source root). No git: works for npm/zip installs too. */
export async function sourceMtimes(root: string): Promise<number[]> {
  const out: number[] = [];
  for (const d of DIRS) await mtimes(path.join(root, d), out);
  return out;
}

/**
 * Notices server code edited since this process started. The baseline is the later of the start time and the newest
 * mtime at the first scan (a file dated in the future is not pending forever). `check` re-scans at most every `minMs`;
 * callers (GET /api/server-update, asked on connect and every minute by the UI) share the cached answer.
 */
export class ServerUpdateWatch {
  private since: number | null = null;
  private packaged = false;
  private last: { at: number; value: ServerUpdate } | null = null;
  private inflight: Promise<ServerUpdate> | null = null;
  /** `version`: the package version this process started with (package mode compares the disk's package.json to it). */
  constructor(private o: { root: string; startedAt: number; version?: string; minMs?: number; now?: () => number }) {}

  async start(): Promise<void> {
    this.packaged = this.o.version !== undefined && !(await fs.stat(path.join(this.o.root, 'src', 'server')).then((st) => st.isDirectory(), () => false));
    const all = await sourceMtimes(this.o.root);
    this.since = Math.max(this.o.startedAt, ...all);
  }

  /** Package mode: the installed package.json's version differs from the running one → restart needed. */
  private async packageCheck(): Promise<ServerUpdate> {
    const file = path.join(this.o.root, 'package.json');
    try {
      const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      const v = (JSON.parse(text) as { version?: unknown } | null)?.version;
      if (typeof v === 'string' && v !== this.o.version) return { changedFiles: 1, newestAt: st.mtimeMs, restartNeeded: true, reason: '패키지가 업그레이드됨' };
    } catch { /* mid-upgrade or gone: no change yet */ }
    return { changedFiles: 0, newestAt: null };
  }

  async check(): Promise<ServerUpdate> {
    const now = (this.o.now ?? Date.now)();
    if (this.last && now - this.last.at < (this.o.minMs ?? 15_000)) return this.last.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      if (this.since === null) await this.start();
      if (this.packaged) {
        const value = await this.packageCheck();
        this.last = { at: now, value };
        return value;
      }
      const newer = (await sourceMtimes(this.o.root)).filter((m) => m > this.since!);
      const value = { changedFiles: newer.length, newestAt: newer.length ? Math.max(...newer) : null };
      this.last = { at: now, value };
      return value;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

/** The relaunch loop's command line (`/bin/sh <path>/relaunch.sh [OLD_PID]`); run.sh uses the same pattern. */
export const RELAUNCH_LOOP_RE = /^(\/bin\/)?(ba)?sh ([^ ]*\/)?relaunch\.sh( [^ ]+)*$/;

export type Supervisor = 'relaunch' | 'systemd' | 'launchd';

export type SupervisionProbe = {
  ppid: () => number;
  /** A process's command line, or null when it is gone. */
  command: (pid: number) => Promise<string | null>;
  /** The pid in relaunch.pid; undefined = no file. */
  loopPid: () => Promise<number | undefined>;
  /** The service manager's main pid for our unit/label; null = not running or not known. */
  servicePid?: (kind: 'systemd' | 'launchd') => Promise<number | null>;
};

const execFileP = promisify(execFile);
const runOut = async (cmd: string, args: string[]): Promise<string | null> => {
  try { return (await execFileP(cmd, args, { timeout: 3000 })).stdout; } catch { return null; }
};
const defaultProbe = (pidFile: string): SupervisionProbe => ({
  ppid: () => process.ppid,
  command: async (pid) => (await runOut('ps', ['-o', 'command=', '-p', String(pid)]))?.trim() || null,
  loopPid: async () => {
    let text: string;
    try { text = await fs.readFile(pidFile, 'utf8'); } catch { return undefined; }
    const n = Number(text.trim());
    return Number.isInteger(n) && n > 0 ? n : NaN;
  },
  servicePid: async (kind) => {
    if (kind === 'systemd') {
      const n = Number((await runOut('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', `${SERVICE_NAME}.service`]))?.trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    const m = /^\s*pid = (\d+)/m.exec((await runOut('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`])) ?? '');
    return m ? Number(m[1]) : null;
  },
});

/**
 * The supervisor this process can claim at start (sync — for the instance lock), from the markers the manager itself sets:
 * relaunch → the parent is the relaunch loop; systemd → `INVOCATION_ID` plus `SYSTEMD_EXEC_PID` = me or `MANAGERPID` =
 * parent; launchd → darwin, `XPC_SERVICE_NAME` = our label and launchd as parent. A marker inherited by a stray child
 * fails the pid/parent test. The live answer is `supervisionCheck`.
 */
export function startSupervisor(o: {
  supervisor: Supervisor | null; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; pid?: number; ppid?: number;
  commandOf: (pid: number) => string | null;
}): Supervisor | null {
  const pid = o.pid ?? process.pid;
  const ppid = o.ppid ?? process.ppid;
  const platform = o.platform ?? process.platform;
  switch (o.supervisor) {
    case 'relaunch': return ppid > 1 && RELAUNCH_LOOP_RE.test(o.commandOf(ppid) ?? '') ? 'relaunch' : null;
    case 'systemd':
      return platform === 'linux' && !!o.env.INVOCATION_ID && (o.env.SYSTEMD_EXEC_PID === String(pid) || o.env.MANAGERPID === String(ppid)) ? 'systemd' : null;
    case 'launchd': return platform === 'darwin' && o.env.XPC_SERVICE_NAME === LAUNCHD_LABEL && ppid === 1 ? 'launchd' : null;
    default: return null;
  }
}

/**
 * Whether a supervisor will start this server again, checked live (cached `ttlMs`). relaunch: a parent that is the relaunch
 * loop (not launchd/init — a stopped loop leaves the server orphaned) and, when relaunch.pid exists, that it names that
 * parent. systemd: `INVOCATION_ID` set and the unit's MainPID is me. launchd: darwin, `XPC_SERVICE_NAME` is our label and
 * the job's pid is me (`ppid === 1` alone proves nothing — an orphan has it too). null: false.
 */
export function supervisionCheck(o: {
  supervisor: Supervisor | null; pidFile: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; pid?: number;
  probe?: SupervisionProbe; ttlMs?: number; now?: () => number;
}): () => Promise<boolean> {
  const probe = o.probe ?? defaultProbe(o.pidFile);
  const env = o.env ?? process.env;
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  let last: { at: number; value: Promise<boolean> } | null = null;
  const check = async (): Promise<boolean> => {
    switch (o.supervisor) {
      case 'relaunch': {
        const ppid = probe.ppid();
        if (ppid <= 1) return false;
        const cmd = await probe.command(ppid);
        if (!cmd || !RELAUNCH_LOOP_RE.test(cmd)) return false;
        const loop = await probe.loopPid();
        return loop === undefined || loop === ppid;
      }
      case 'systemd':
        return !!env.INVOCATION_ID && (await probe.servicePid?.('systemd')) === pid;
      case 'launchd':
        return (o.platform ?? process.platform) === 'darwin' && env.XPC_SERVICE_NAME === LAUNCHD_LABEL && (await probe.servicePid?.('launchd')) === pid;
      default:
        return false;
    }
  };
  return () => {
    const t = now();
    if (!last || t - last.at >= (o.ttlMs ?? 3000)) last = { at: t, value: check().catch(() => false) };
    return last.value;
  };
}
