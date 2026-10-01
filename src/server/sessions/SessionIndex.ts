import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS, type Account } from '../../shared/accounts';
import type { DesktopSession, PinnedProject, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { recentDesktopSessions } from './DesktopSessions';
import { pathKey } from './slug';
import { readHead } from './transcript';

const UUID_JSONL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function scanProfile(account: Account, projectsRoot: string): Promise<SessionEntry[]> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(projectsRoot);
  } catch {
    return [];
  }
  const out: SessionEntry[] = [];
  for (const d of dirs) {
    const projectDir = path.join(projectsRoot, d);
    let names: string[];
    try {
      if (!(await fs.stat(projectDir)).isDirectory()) continue;
      names = await fs.readdir(projectDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = UUID_JSONL.exec(name);
      if (!m) continue;
      const file = path.join(projectDir, name);
      try {
        const st = await fs.stat(file);
        const head = await readHead(file);
        if (!head.cwd) continue;
        out.push({
          sessionId: m[1]!,
          account,
          engine: 'claude',
          cwd: head.cwd,
          projectDir,
          file,
          title: head.title ?? '(제목 없음)',
          lastModified: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out;
}

/** F1: `recent` = folders opened with 폴더 열기 (newest first); those without sessions follow the pinned projects. */
export function groupProjects(sessions: SessionEntry[], pinned: PinnedProject[], recent: string[] = []): ProjectEntry[] {
  const newest = new Map<string, SessionEntry>();
  for (const s of sessions) {
    const prev = newest.get(s.sessionId);
    if (!prev || s.lastModified > prev.lastModified) newest.set(s.sessionId, s);
  }
  // Keyed by the NFC spelling: NFC and NFD transcripts of one folder form a single project.
  const byCwd = new Map<string, SessionEntry[]>();
  for (const s of newest.values()) {
    const key = pathKey(s.cwd);
    const list = byCwd.get(key) ?? [];
    list.push(s);
    byCwd.set(key, list);
  }
  const projects: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const p of pinned) {
    const key = pathKey(p.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = (byCwd.get(key) ?? []).sort((x, y) => y.lastModified - x.lastModified);
    projects.push({ cwd: key, name: p.name ?? path.basename(key), pinned: true, sessions: list });
  }
  for (const cwd of recent) {
    const key = pathKey(cwd);
    if (seen.has(key) || byCwd.has(key)) continue;
    seen.add(key);
    projects.push({ cwd: key, name: path.basename(key), pinned: false, sessions: [] });
  }
  const rest = [...byCwd.entries()].filter(([cwd]) => !seen.has(cwd)).map(([cwd, list]) => ({
    cwd,
    name: path.basename(cwd),
    pinned: false,
    sessions: list.sort((x, y) => y.lastModified - x.lastModified),
  }));
  rest.sort((x, y) => (y.sessions[0]?.lastModified ?? 0) - (x.sessions[0]?.lastModified ?? 0));
  return projects.concat(rest);
}

export async function readPinned(file: string): Promise<PinnedProject[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is PinnedProject => !!p && typeof p === 'object' && typeof (p as PinnedProject).cwd === 'string')
      .map((p) => ({ cwd: p.cwd, ...(typeof p.name === 'string' ? { name: p.name } : {}) }));
  } catch {
    return [];
  }
}

export const MAX_RECENT_FOLDERS = 20;

/** F1: `recent-folders.json` = absolute paths, newest first; junk entries are dropped. */
export async function readRecent(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
      .filter((p) => !seen.has(pathKey(p)) && !!seen.add(pathKey(p)))
      .slice(0, MAX_RECENT_FOLDERS);
  } catch {
    return [];
  }
}

/** deck-side titles / archive flags (SessionMetaStore) laid over the scanned entries. */
export type SessionMetaView = { title(sessionId: string): string | null; isArchived(sessionId: string): boolean };

export class SessionIndex {
  private entries: SessionEntry[] = [];
  private grouped: ProjectEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private pinned: PinnedProject[] = [];
  private recentFolders: string[] = [];
  private recentWrite: Promise<void> = Promise.resolve();
  private desktopList: DesktopSession[] = [];

  /** `desktopRoot`: Claude Desktop's `claude-code-sessions` dir (read-only metadata); absent = no Desktop list. */
  constructor(private readonly opts: { roots: Record<Account, string>; pinnedFile: string; recentFile?: string; desktopRoot?: string; meta?: SessionMetaView }) {}

  /** A deck rename wins over the transcript's title; archived entries carry the flag. Unchanged entries are returned as is. */
  private decorate<T extends { sessionId: string; title: string; archived?: boolean }>(e: T): T {
    const meta = this.opts.meta;
    if (!meta) return e;
    const title = meta.title(e.sessionId);
    const archived = meta.isArchived(e.sessionId);
    if (!title && !archived && !e.archived) return e;
    const out: T = { ...e, title: title ?? e.title };
    if (archived) out.archived = true;
    else delete out.archived;
    return out;
  }

  private group(sessions: SessionEntry[]): ProjectEntry[] {
    return groupProjects(sessions.map((s) => this.decorate(s)), this.pinned, this.recentFolders);
  }

  /** Re-applies titles / archive flags after a SessionMetaStore change (no rescan). */
  regroup(): void {
    this.grouped = this.group(this.entries);
    this.desktopList = this.desktopList.map((d) => this.decorate(d));
  }

  async refresh(): Promise<void> {
    const all = (await Promise.all(ACCOUNTS.map((a) => scanProfile(a, this.opts.roots[a])))).flat();
    this.entries = all;
    this.byId = new Map();
    for (const e of all) {
      const prev = this.byId.get(e.sessionId);
      if (!prev || e.lastModified > prev.lastModified) this.byId.set(e.sessionId, e);
    }
    this.pinned = await readPinned(this.opts.pinnedFile);
    if (this.opts.recentFile) this.recentFolders = await readRecent(this.opts.recentFile);
    this.grouped = this.group(all);
    this.desktopList = this.opts.desktopRoot ? (await recentDesktopSessions(this.opts.desktopRoot, (id) => this.lookup(id)).catch(() => [])).map((d) => this.decorate(d)) : [];
  }

  /** The most recently active Claude Desktop sessions deck can open (as of the last refresh). */
  desktop(): DesktopSession[] {
    return this.desktopList;
  }

  recent(): string[] {
    return this.recentFolders;
  }

  /** F1: records an (already validated, real) folder as most recent and persists the list (0600). */
  async addRecent(cwd: string): Promise<string[]> {
    this.recentFolders = [cwd, ...this.recentFolders.filter((c) => pathKey(c) !== pathKey(cwd))].slice(0, MAX_RECENT_FOLDERS);
    this.grouped = this.group(this.entries);
    const file = this.opts.recentFile;
    const snapshot = this.recentFolders;
    if (file) {
      // Serialized: two quick opens must not race on the temp file.
      this.recentWrite = this.recentWrite.catch(() => {}).then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        await fs.rename(tmp, file);
      });
      await this.recentWrite;
    }
    return snapshot;
  }

  lookup(sessionId: string): SessionEntry | null {
    return this.byId.get(sessionId) ?? null;
  }

  /** Cached grouping of the profile scan; with `extra` (Codex sessions from the state store, D4) a fresh grouping. */
  projects(extra: SessionEntry[] = []): ProjectEntry[] {
    return extra.length ? this.group([...this.entries, ...extra]) : this.grouped;
  }

  sessions(): SessionEntry[] {
    return this.entries;
  }
}
