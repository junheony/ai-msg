import fs from 'node:fs';
import path from 'node:path';

/** A detached child (its own process group, so the service manager's group kill misses it). `pgid` = the leader's pid. */
export type ChildEntry = { pgid: number; bin: string; engine: string; startedAt: string };

const isEntry = (v: unknown): v is ChildEntry => {
  const e = v as Partial<ChildEntry> | null;
  return !!e && Number.isInteger(e.pgid) && (e.pgid as number) > 1 && typeof e.bin === 'string' && e.bin !== '' && typeof e.engine === 'string';
};

/**
 * `<configDir>/run/children.json` (S5): the detached children this server started. A clean shutdown waits for its turns,
 * so the file empties itself; after a crash the next server (which took over a stale lock) reaps what is left.
 */
export class ChildRegistry {
  private entries = new Map<number, ChildEntry>();
  private constructor(private file: string) {}

  static open(file: string): ChildRegistry {
    const r = new ChildRegistry(file);
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(v)) for (const e of v) if (isEntry(e)) r.entries.set(e.pgid, { pgid: e.pgid, bin: e.bin, engine: e.engine, startedAt: String(e.startedAt ?? '') });
    } catch { /* none or unreadable: nothing recorded */ }
    return r;
  }

  list(): ChildEntry[] {
    return [...this.entries.values()];
  }

  add(e: ChildEntry): void {
    if (!isEntry(e)) return;
    this.entries.set(e.pgid, e);
    this.save();
  }

  remove(pgid: number): void {
    if (this.entries.delete(pgid)) this.save();
  }

  /** Forget everything (a clean start: no stale lock, so nothing recorded can be ours to kill). */
  clear(): void {
    this.entries.clear();
    this.save();
  }

  /**
   * After a stale-lock takeover: each recorded group that is alive and whose leader's command still contains the recorded
   * bin gets SIGTERM, then SIGKILL after 5 s if still alive. A reused pgid (another command) is left alone. One log line per
   * group — pgid and engine only, never arguments. The record is emptied afterwards.
   */
  async reapStale(o: {
    isAlive: (pgid: number) => boolean; commandOf: (pid: number) => string | null; kill: (pgid: number, signal: NodeJS.Signals) => void;
    sleep: (ms: number) => Promise<void>; log?: (line: string) => void;
  }): Promise<number> {
    const log = o.log ?? ((line: string) => console.error(line));
    const ours = this.list().filter((e) => o.isAlive(e.pgid) && (o.commandOf(e.pgid) ?? '').includes(e.bin));
    for (const e of ours) {
      try { o.kill(e.pgid, 'SIGTERM'); } catch { /* gone meanwhile */ }
    }
    if (ours.length) await o.sleep(5000);
    for (const e of ours) {
      let forced = false;
      if (o.isAlive(e.pgid)) {
        try { o.kill(e.pgid, 'SIGKILL'); forced = true; } catch { /* gone meanwhile */ }
      }
      log(`deck: 이전 서버가 남긴 ${e.engine} 자식 정리 (pgid ${e.pgid}${forced ? ', SIGKILL' : ''})`);
    }
    this.clear();
    return ours.length;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.list())}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('deck: 자식 기록 저장 실패', err instanceof Error ? err.message : err);
    }
  }
}

/** Default probes for `reapStale`: a whole process group. */
export const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};
export const killGroup = (pgid: number, signal: NodeJS.Signals): void => { process.kill(-pgid, signal); };
