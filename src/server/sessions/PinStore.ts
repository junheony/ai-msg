import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_PINS = 200;

/** Claude session ids and Codex thread ids are UUIDs; nothing path-like is stored. */
export function isPinnableId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(v);
}

/** F2: pinned sessions (`pins.json`, pin order, oldest first), shared by every device. */
export class PinStore {
  private ids: string[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly max = MAX_PINS) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown;
      this.ids = Array.isArray(parsed) ? [...new Set(parsed.filter(isPinnableId))].slice(-this.max) : [];
    } catch {
      this.ids = [];
    }
  }

  list(): string[] {
    return this.ids;
  }

  async set(sessionId: string, pinned: boolean): Promise<string[]> {
    const rest = this.ids.filter((id) => id !== sessionId);
    const next = pinned ? (this.ids.includes(sessionId) ? this.ids : [...rest, sessionId].slice(-this.max)) : rest;
    this.ids = next;
    // Serialized: two quick toggles must not race on the temp file.
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    await this.writing;
    return next;
  }
}
