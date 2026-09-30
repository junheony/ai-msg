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

export class SessionStateStore {
  private map = new Map<string, SessionState>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, SessionState>;
      this.map = new Map(Object.entries(parsed));
    } catch {
      this.map = new Map();
    }
  }

  get(id: string): SessionState | null {
    return this.map.get(id) ?? null;
  }

  async set(s: SessionState): Promise<void> {
    this.map.set(s.sessionId, s);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
  }
}
