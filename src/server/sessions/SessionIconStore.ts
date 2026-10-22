import fs from 'node:fs/promises';
import path from 'node:path';
import { isSessionIconChoice } from '../../shared/sessionIcons';
import { isPinnableId } from './PinStore';

export const MAX_SESSION_ICONS = 2000;

/**
 * 직접 고른 세션 아이콘 (`session-icons.json`): session id → icon (an allowed emoji or `glyph:<name>`), shared by every
 * device like the pins. A session without an entry shows its title's first letter.
 */
export class SessionIconStore {
  private icons: Record<string, string> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly max = MAX_SESSION_ICONS) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      this.icons = {}; // missing file
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const next: Record<string, string> = {};
      for (const [id, icon] of Object.entries(parsed).slice(0, this.max)) if (isPinnableId(id) && isSessionIconChoice(icon)) next[id] = icon;
      this.icons = next;
      return;
    }
    // A corrupt file is moved aside (.bad), never silently overwritten by the next change.
    this.icons = {};
    await fs.rename(this.file, `${this.file}.bad`).catch(() => {});
    console.error(`deck: corrupt session icon file moved to ${path.basename(this.file)}.bad`);
  }

  list(): Record<string, string> {
    return this.icons;
  }

  /** `icon` null = back to the first letter. Returns the whole map. */
  async set(sessionId: string, icon: string | null): Promise<Record<string, string>> {
    if ((this.icons[sessionId] ?? null) === icon) return this.icons;
    const rest = { ...this.icons };
    delete rest[sessionId];
    if (icon === null) return this.commit(rest);
    if (Object.keys(rest).length >= this.max) return this.icons;
    return this.commit({ ...rest, [sessionId]: icon });
  }

  private async commit(next: Record<string, string>): Promise<Record<string, string>> {
    const prev = this.icons;
    this.icons = next;
    // Serialized: two quick changes must not race on the temp file.
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    try {
      await this.writing;
    } catch (err) {
      if (this.icons === next) this.icons = prev;
      throw err;
    }
    return next;
  }
}
