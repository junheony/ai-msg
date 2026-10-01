import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeckSettings } from '../shared/protocol';

/** 자동 승인 is on unless the user turned it off. */
export const DEFAULT_SETTINGS: DeckSettings = { autoApprove: true };

/** Server-wide settings (`settings.json`), shared by every device. A missing or corrupt file = defaults. */
export class SettingsStore {
  private current: DeckSettings = { ...DEFAULT_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      parsed = null;
    }
    const r = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    this.current = { autoApprove: typeof r.autoApprove === 'boolean' ? r.autoApprove : DEFAULT_SETTINGS.autoApprove };
  }

  get(): DeckSettings {
    return this.current;
  }

  async set(patch: Partial<DeckSettings>): Promise<DeckSettings> {
    const next = { ...this.current, ...patch };
    this.current = next;
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
