import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import type { ClaudeModel } from '../../shared/models';

export type SessionState = {
  sessionId: string;
  cwd: string;
  account: Account;
  /** Directory the jsonl currently lives in (moves update it). */
  projectDir: string;
  lastTurnAtMs: number | null;
  justCompacted: boolean;
  defaultModel: ClaudeModel;
};

let tmpCounter = 0;

export class SessionStateStore {
  private map = new Map<string, SessionState>();
  /** Review I6: writes are serialized; each snapshot goes through its own tmp file. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      this.map = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionState>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      this.map = new Map(Object.entries(parsed));
    } catch (err) {
      const bad = `${this.file}.bad-${Date.now()}`;
      await fs.rename(this.file, bad).catch(() => {});
      console.error(`deck: ${this.file} 을 읽지 못해 ${bad} 로 옮기고 빈 상태로 시작합니다 (${err instanceof Error ? err.message : String(err)})`);
      this.map = new Map();
    }
  }

  get(id: string): SessionState | null {
    return this.map.get(id) ?? null;
  }

  set(s: SessionState): Promise<void> {
    this.map.set(s.sessionId, s);
    const run = this.chain.then(() => this.write());
    this.chain = run.catch(() => {});
    return run;
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${++tmpCounter}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await fs.chmod(this.file, 0o600);
  }
}
