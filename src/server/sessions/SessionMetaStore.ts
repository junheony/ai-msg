import fs from 'node:fs/promises';
import path from 'node:path';
import type { BranchLink } from '../../shared/branches';
import { isPinnableId } from './PinStore';

export const MAX_TITLE_CHARS = 200;
export const MAX_META_ENTRIES = 5000;

/**
 * `next`: 새 세션으로 이어가기 links, old session id → the session that continues it (present only when non-empty).
 * `branches`: 메시지 편집 갈래, branch child → { parent, n } in creation order (present only when non-empty).
 */
export type SessionMeta = { titles: Record<string, string>; archived: string[]; next?: Record<string, string>; branches?: Record<string, BranchLink>; /** 작업 폴더 바꾸기: session id → the folder its turns run in (wins over the transcript's first cwd). */ cwds?: Record<string, string> };

/**
 * deck-only session metadata (`session-meta.json`): custom titles and archived ids. The Claude jsonl and
 * the Codex rollout are never touched; every device sees the same list (written 0600, atomically).
 */
export class SessionMetaStore {
  private titles = new Map<string, string>();
  private archivedIds = new Set<string>();
  private nextIds = new Map<string, string>();
  private prevIds = new Map<string, string>();
  private branchLinks = new Map<string, BranchLink>();
  private cwds = new Map<string, string>();
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
    const next = o.next && typeof o.next === 'object' ? (o.next as Record<string, unknown>) : {};
    for (const [from, to] of Object.entries(next)) if (isPinnableId(from) && isPinnableId(to) && from !== to) this.setLink(from, to);
    const branches = o.branches && typeof o.branches === 'object' ? (o.branches as Record<string, unknown>) : {};
    for (const [child, l] of Object.entries(branches)) {
      const link = l && typeof l === 'object' ? (l as Record<string, unknown>) : {};
      if (isPinnableId(child) && isPinnableId(link.parent) && link.parent !== child && Number.isInteger(link.n) && (link.n as number) >= 0) {
        this.branchLinks.set(child, { parent: link.parent as string, n: link.n as number });
      }
    }
    const cwds = o.cwds && typeof o.cwds === 'object' ? (o.cwds as Record<string, unknown>) : {};
    for (const [id, c] of Object.entries(cwds)) if (isPinnableId(id) && typeof c === 'string' && c.startsWith('/')) this.cwds.set(id, c);
  }

  /** 작업 폴더 바꾸기: the folder deck runs `sessionId` in when it was changed in deck; null = the transcript's own. */
  cwd(sessionId: string): string | null {
    return this.cwds.get(sessionId) ?? null;
  }

  /** 작업 폴더 바꾸기: records the session's new folder (null = back to the transcript's own). */
  async setCwd(sessionId: string, cwd: string | null): Promise<SessionMeta> {
    this.cwds.delete(sessionId);
    if (cwd) this.cwds.set(sessionId, cwd);
    if (this.cwds.size > MAX_META_ENTRIES) this.cwds.delete(this.cwds.keys().next().value!);
    return this.update(sessionId, {});
  }

  /** 메시지 편집 갈래: the session `sessionId` was forked from, and at which user message; null = not a branch. */
  branchOf(sessionId: string): BranchLink | null {
    return this.branchLinks.get(sessionId) ?? null;
  }

  /** 메시지 편집 갈래: `child` was forked from `parent` by editing its user message `n`; it takes the parent's deck title. */
  async branch(child: string, parent: string, n: number): Promise<SessionMeta> {
    if (child !== parent) {
      this.branchLinks.delete(child);
      this.branchLinks.set(child, { parent, n });
    }
    if (this.branchLinks.size > MAX_META_ENTRIES) this.branchLinks.delete(this.branchLinks.keys().next().value!);
    const title = this.titles.get(parent);
    return this.update(child, title ? { title } : {});
  }

  private setLink(from: string, to: string): void {
    const old = this.nextIds.get(from);
    if (old) this.prevIds.delete(old);
    this.nextIds.set(from, to);
    this.prevIds.set(to, from);
  }

  /** The session that continues `sessionId` (새 세션으로 이어가기), or null. */
  next(sessionId: string): string | null {
    return this.nextIds.get(sessionId) ?? null;
  }

  /** The session `sessionId` continues, or null. */
  prev(sessionId: string): string | null {
    return this.prevIds.get(sessionId) ?? null;
  }

  /**
   * 새 세션으로 이어가기: `to` continues `from`; `to` is titled `title`. A session continues into one session
   * only — once `from` has a next session, a link to another is refused (it would orphan the first). `alive` says whether
   * a session still exists: a link to one that is gone (deleted outside deck, its account removed) is replaced instead.
   */
  async link(from: string, to: string, title: string, alive?: (sessionId: string) => boolean): Promise<SessionMeta> {
    const old = this.nextIds.get(from);
    if (old && old !== to && (!alive || alive(old))) {
      console.warn(`deck: ${from} already continues in ${old}; not linking ${to}`);
      return this.snapshot();
    }
    if (from !== to) this.setLink(from, to);
    if (this.nextIds.size > MAX_META_ENTRIES) {
      const [k, v] = this.nextIds.entries().next().value!;
      this.nextIds.delete(k);
      this.prevIds.delete(v);
    }
    return this.update(to, { title });
  }

  /** The link into `to` goes (the session that continued another was deleted): the old session may continue anew. False = none. */
  async unlink(to: string): Promise<boolean> {
    const from = this.prevIds.get(to);
    if (!from) return false;
    this.prevIds.delete(to);
    if (this.nextIds.get(from) === to) this.nextIds.delete(from);
    await this.update(to, {});
    return true;
  }

  title(sessionId: string): string | null {
    return this.titles.get(sessionId) ?? null;
  }

  isArchived(sessionId: string): boolean {
    return this.archivedIds.has(sessionId);
  }

  snapshot(): SessionMeta {
    return { titles: Object.fromEntries(this.titles), archived: [...this.archivedIds], ...(this.nextIds.size ? { next: Object.fromEntries(this.nextIds) } : {}), ...(this.branchLinks.size ? { branches: Object.fromEntries(this.branchLinks) } : {}), ...(this.cwds.size ? { cwds: Object.fromEntries(this.cwds) } : {}) };
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
