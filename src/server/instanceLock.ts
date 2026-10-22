import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RELAUNCH_LOOP_RE } from './serverUpdate';

/** `<configDir>/server.lock`: the one server that owns this config dir (S1). */
export type LockInfo = { pid: number; port: number; addresses: string[]; version: string; configDir: string; startedAt: string; supervisor: string | null };

export class InstanceLockedError extends Error {
  override name = 'InstanceLockedError';
  constructor(readonly configDir: string, readonly holder: LockInfo | null, readonly reason: 'lock' | 'relaunch-loop') {
    super(reason === 'lock' ? `config dir ${configDir} is locked by pid ${holder?.pid ?? '?'}` : `config dir ${configDir} is run by a relaunch loop`);
  }
}

export type InstanceLock = {
  file: string;
  tookOverStale: boolean;
  update(p: { addresses: string[]; port: number }): Promise<void>;
  release(): void;
};

type Probes = { isAlive?: (pid: number) => boolean; commandOf?: (pid: number) => string | null; ppid?: number };

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function commandOfPid(pid: number): string | null {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

const lockFile = (configDir: string) => path.join(configDir, 'server.lock');

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo> | null;
    if (!v || !Number.isInteger(v.pid) || (v.pid as number) <= 0 || typeof v.port !== 'number') return null;
    return { pid: v.pid!, port: v.port, addresses: Array.isArray(v.addresses) ? v.addresses.filter((a) => typeof a === 'string') : [], version: String(v.version ?? ''), configDir: String(v.configDir ?? ''), startedAt: String(v.startedAt ?? ''), supervisor: typeof v.supervisor === 'string' ? v.supervisor : null };
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** A holder is live while its pid runs and that pid is still a node/ai-msg process (a reused pid is not). Unknown command → live. */
function holderLive(info: LockInfo | null, isAlive: (pid: number) => boolean, commandOf: (pid: number) => string | null): boolean {
  if (!info || !isAlive(info.pid)) return false;
  const cmd = commandOf(info.pid);
  return cmd === null || /node|ai-msg/i.test(cmd);
}

/** Write `text` to `file` only if it does not exist yet (temp file + link: readers never see a half-written lock). */
function createExclusive(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Take the config dir's lock before anything else is written there. A live holder → `InstanceLockedError('lock')`; a dead
 * or reused pid, or a corrupt file, is a stale lock: taken over by renaming it aside (so only one taker wins), then one
 * more try. While `relaunch.pid` names a live relaunch loop, only that loop's own child may start: `supervisor ===
 * 'relaunch'` and the loop is this process's parent (an inherited DECK_SUPERVISED alone is not enough).
 */
export async function acquireInstanceLock(configDir: string, o: { pid: number; port: number; version: string; supervisor: string | null } & Probes): Promise<InstanceLock> {
  const isAlive = o.isAlive ?? pidAlive;
  const commandOf = o.commandOf ?? commandOfPid;
  const loopPid = Number((readText(path.join(configDir, 'relaunch.pid')) ?? '').trim());
  const ownLoop = o.supervisor === 'relaunch' && loopPid === (o.ppid ?? process.ppid);
  if (!ownLoop && Number.isInteger(loopPid) && loopPid > 0 && isAlive(loopPid) && RELAUNCH_LOOP_RE.test(commandOf(loopPid) ?? '')) {
    throw new InstanceLockedError(configDir, null, 'relaunch-loop');
  }
  const createdDir = !fs.existsSync(configDir);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const file = lockFile(configDir);
  let info: LockInfo = { pid: o.pid, port: o.port, addresses: [], version: o.version, configDir, startedAt: new Date().toISOString(), supervisor: o.supervisor };
  const removeCreatedDir = () => {
    if (!createdDir) return;
    try { fs.rmdirSync(configDir); } catch { /* not empty or gone */ }
  };
  let tookOverStale = false;
  if (!createExclusive(file, JSON.stringify(info))) {
    const text = readText(file);
    const holder = text === null ? null : parseLock(text);
    if (holderLive(holder, isAlive, commandOf)) throw new InstanceLockedError(configDir, holder, 'lock');
    // Stale: move it aside (atomic: of two takers only one rename succeeds) and drop it only if it is the file judged
    // stale; a fresh lock that slipped in meanwhile is put back. Then race once more.
    const aside = `${file}.${o.pid}.${Date.now()}.stale`;
    let moved = false;
    try { fs.renameSync(file, aside); moved = true; } catch { /* another taker moved it first, or it is gone */ }
    if (moved) {
      if (readText(aside) === text) fs.rmSync(aside, { force: true });
      else {
        try { fs.linkSync(aside, file); } catch { /* a newer lock is already in place */ }
        fs.rmSync(aside, { force: true });
      }
    }
    if (!createExclusive(file, JSON.stringify(info))) {
      const now = readText(file);
      throw new InstanceLockedError(configDir, now === null ? null : parseLock(now), 'lock');
    }
    tookOverStale = true;
  }
  return {
    file,
    tookOverStale,
    async update(p) {
      info = { ...info, addresses: p.addresses, port: p.port };
      const tmp = `${file}.${o.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    },
    release() {
      const cur = parseLock(readText(file) ?? '');
      if (cur?.pid === o.pid) fs.rmSync(file, { force: true });
      removeCreatedDir();
    },
  };
}

/** The running instance's lock record, or null (no lock, unreadable, or its pid is gone). */
export function readInstanceLock(configDir: string, isAlive: (pid: number) => boolean = pidAlive): LockInfo | null {
  const info = parseLock(readText(lockFile(configDir)) ?? '');
  return info && isAlive(info.pid) ? info : null;
}
