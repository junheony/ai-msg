import fs from 'node:fs/promises';
import path from 'node:path';
import { isPinnableId } from './PinStore';

export const MAX_TITLE_CHARS = 200;
export const MAX_META_ENTRIES = 5000;

export type SessionMeta = { titles: Record<string, string>; archived: string[] };

/**
 * deck-only session metadata (`session-meta.json`): custom titles and archived ids. The Claude jsonl and
 * the Codex rollout are never touched; every device sees the same list (written 0600, atomically).
 */
export class SessionMetaStore {
  private titles = new Map<string, string>();
  private archivedIds = new Set<string>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return; // missing file
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    if (!o) {
      // Like pins.json: a corrupt file is moved aside, never silently overwritten by the next change.
      await fs.rename(this.file, `${this.file}.bad`).catch(() => {});
      console.error(`deck: 세션 정보 파일이 손상되어 ${path.basename(this.file)}.bad 로 옮겼습니다`);
      return;
    }
    const titles = o.titles && typeof o.titles === 'object' ? (o.titles as Record<string, unknown>) : {};
    for (const [id, t] of Object.entries(titles)) {
      if (isPinnableId(id) && typeof t === 'string' && t.trim()) this.titles.set(id, t.trim().slice(0, MAX_TITLE_CHARS));
    }
    if (Array.isArray(o.archived)) for (const id of o.archived) if (isPinnableId(id)) this.archivedIds.add(id);
  }

  title(sessionId: string): string | null {
    return this.titles.get(sessionId) ?? null;
  }

  isArchived(sessionId: string): boolean {
    return this.archivedIds.has(sessionId);
  }

  snapshot(): SessionMeta {
    return { titles: Object.fromEntries(this.titles), archived: [...this.archivedIds] };
  }

  /** `title`: string = rename, null/'' = back to the transcript's own title, undefined = unchanged. */
  async update(sessionId: string, change: { title?: string | null; archived?: boolean }): Promise<SessionMeta> {
    if (change.title !== undefined) {
      const t = (change.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
      if (t) this.titles.set(sessionId, t);
      else this.titles.delete(sessionId);
    }
    if (change.archived !== undefined) {
      if (change.archived) this.archivedIds.add(sessionId);
      else this.archivedIds.delete(sessionId);
    }
    if (this.titles.size > MAX_META_ENTRIES) this.titles.delete(this.titles.keys().next().value!);
    if (this.archivedIds.size > MAX_META_ENTRIES) this.archivedIds.delete(this.archivedIds.values().next().value!);
    const snap = this.snapshot();
    // Serialized: two quick changes must not race on the temp file.
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snap, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    await this.writing;
    return snap;
  }
}
