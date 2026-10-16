import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/** Server code newer than the running process: how many files, and the newest one's mtime (ms; null = none). */
export type ServerUpdate = { changedFiles: number; newestAt: number | null };

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
  private last: { at: number; value: ServerUpdate } | null = null;
  private inflight: Promise<ServerUpdate> | null = null;
  constructor(private o: { root: string; startedAt: number; minMs?: number; now?: () => number }) {}

  async start(): Promise<void> {
    const all = await sourceMtimes(this.o.root);
    this.since = Math.max(this.o.startedAt, ...all);
  }

  async check(): Promise<ServerUpdate> {
    const now = (this.o.now ?? Date.now)();
    if (this.last && now - this.last.at < (this.o.minMs ?? 15_000)) return this.last.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      if (this.since === null) await this.start();
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

export type SupervisionProbe = {
  ppid: () => number;
  /** A process's command line, or null when it is gone. */
  command: (pid: number) => Promise<string | null>;
  /** The pid in relaunch.pid; undefined = no file. */
  loopPid: () => Promise<number | undefined>;
};

const execFileP = promisify(execFile);
const defaultProbe = (pidFile: string): SupervisionProbe => ({
  ppid: () => process.ppid,
  command: async (pid) => {
    try { return (await execFileP('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3000 })).stdout.trim() || null; } catch { return null; }
  },
  loopPid: async () => {
    let text: string;
    try { text = await fs.readFile(pidFile, 'utf8'); } catch { return undefined; }
    const n = Number(text.trim());
    return Number.isInteger(n) && n > 0 ? n : NaN;
  },
});

/**
 * Whether a supervisor will start this server again, checked live (cached `ttlMs`): `DECK_SUPERVISED=1`, a parent that
 * is the relaunch loop (not launchd/init — a stopped loop leaves the server orphaned), and, when relaunch.pid exists,
 * that it names that parent.
 */
export function supervisionCheck(o: { env: boolean; pidFile: string; probe?: SupervisionProbe; ttlMs?: number; now?: () => number }): () => Promise<boolean> {
  const probe = o.probe ?? defaultProbe(o.pidFile);
  const now = o.now ?? Date.now;
  let last: { at: number; value: Promise<boolean> } | null = null;
  const check = async (): Promise<boolean> => {
    if (!o.env) return false;
    const ppid = probe.ppid();
    if (ppid <= 1) return false;
    const cmd = await probe.command(ppid);
    if (!cmd || !RELAUNCH_LOOP_RE.test(cmd)) return false;
    const loop = await probe.loopPid();
    return loop === undefined || loop === ppid;
  };
  return () => {
    const t = now();
    if (!last || t - last.at >= (o.ttlMs ?? 3000)) last = { at: t, value: check().catch(() => false) };
    return last.value;
  };
}
