import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS, type Account } from '../../shared/accounts';
import type { BranchLink } from '../../shared/branches';
import type { DesktopSession, PinnedProject, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { findCopies, resolveCopies, type PrefixFn, type SessionCopy } from './copies';
import { CodexRolloutIndex } from './CodexImports';
import { recentDesktopSessions } from './DesktopSessions';
import { isBytePrefix } from './SessionMover';
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
export type SessionMetaView = { title(sessionId: string): string | null; isArchived(sessionId: string): boolean; /** 새 세션으로 이어가기 links. */ next?(sessionId: string): string | null; prev?(sessionId: string): string | null; /** 메시지 편집 갈래 links. */ branchOf?(sessionId: string): BranchLink | null };

export class SessionIndex {
  private entries: SessionEntry[] = [];
  private grouped: ProjectEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private pinned: PinnedProject[] = [];
  private recentFolders: string[] = [];
  private recentWrite: Promise<void> = Promise.resolve();
  private desktopList: DesktopSession[] = [];
  /** Byte-prefix answers by (file, size, mtime) pair: a rescan does not re-read unchanged transcripts. */
  private prefixCache = new Map<string, boolean>();
  private readonly cachedPrefix: PrefixFn = async (a, b) => {
    const key = `${a.file}\0${a.size}\0${a.mtimeMs}\0${b.file}\0${b.size}\0${b.mtimeMs}`;
    const hit = this.prefixCache.get(key);
    if (hit !== undefined) return hit;
    const v = a.size <= b.size && (await isBytePrefix(a.file, b.file).catch(() => false));
    if (this.prefixCache.size > 2000) this.prefixCache.clear();
    this.prefixCache.set(key, v);
    return v;
  };

  private readonly codex: CodexRolloutIndex | null;

  /**
   * `desktopRoot`: Claude Desktop's `claude-code-sessions` dir (read-only metadata); absent = no Desktop list.
   * `codexRoot`: `~/.codex/sessions` — Codex Desktop / CLI threads listed for import; absent = none.
   */
  constructor(private readonly opts: { roots: Record<Account, string>; pinnedFile: string; recentFile?: string; desktopRoot?: string; codexRoot?: string; meta?: SessionMetaView }) {
    this.codex = opts.codexRoot ? new CodexRolloutIndex(opts.codexRoot) : null;
  }

  /** A deck rename wins over the transcript's title; archived entries carry the flag. Unchanged entries are returned as is. */
  private decorate<T extends { sessionId: string; title: string; archived?: boolean; prevSession?: string; nextSession?: string; branch?: BranchLink }>(e: T): T {
    const meta = this.opts.meta;
    if (!meta) return e;
    const title = meta.title(e.sessionId);
    const archived = meta.isArchived(e.sessionId);
    const prev = meta.prev?.(e.sessionId) ?? null;
    const next = meta.next?.(e.sessionId) ?? null;
    const branch = meta.branchOf?.(e.sessionId) ?? null;
    if (!title && !archived && !e.archived && !prev && !next && !e.prevSession && !e.nextSession && !branch && !e.branch) return e;
    const out: T = { ...e, title: title ?? e.title };
    if (archived) out.archived = true;
    else delete out.archived;
    if (prev) out.prevSession = prev;
    else delete out.prevSession;
    if (next) out.nextSession = next;
    else delete out.nextSession;
    if (branch) out.branch = branch;
    else delete out.branch;
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
    // The same id in several profiles/dirs: the copy containing the others wins; truly diverged → newest.
    const byId = new Map<string, SessionEntry[]>();
    for (const e of all) byId.set(e.sessionId, [...(byId.get(e.sessionId) ?? []), e]);
    this.byId = new Map();
    for (const [id, list] of byId) {
      if (list.length === 1) { this.byId.set(id, list[0]!); continue; }
      const stamped = list.sort((x, y) => y.lastModified - x.lastModified).map((e) => ({ e, file: e.file, size: e.sizeBytes, mtimeMs: e.lastModified }));
      this.byId.set(id, (await resolveCopies(stamped, this.cachedPrefix))!.best.e);
    }
    this.pinned = await readPinned(this.opts.pinnedFile);
    if (this.opts.recentFile) this.recentFolders = await readRecent(this.opts.recentFile);
    this.grouped = this.group(all);
    if (this.codex) await this.codex.refresh().catch(() => undefined);
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

  /**
   * The copy of a Claude session to show/resume, starting from the one deck last used (`projectDir`):
   * a superset copy in another profile (e.g. Claude Desktop continued it on A) wins; truly diverged → newest.
   */
  async bestCopy(sessionId: string, projectDir: string, account: Account): Promise<SessionCopy | null> {
    return (await resolveCopies(await findCopies(this.opts.roots, sessionId, projectDir, account), this.cachedPrefix))?.best ?? null;
  }

  lookup(sessionId: string): SessionEntry | null {
    return this.byId.get(sessionId) ?? null;
  }

  /** An external Codex thread (Codex Desktop / CLI rollout) as of the last refresh; null if unknown. */
  codexImport(threadId: string): SessionEntry | null {
    return this.codex?.lookup(threadId) ?? null;
  }

  /**
   * Cached grouping of the profile scan; with `extra` (Codex sessions from the state store, D4) and/or
   * imported Codex threads a fresh grouping. A thread deck already runs (in `extra`) is not listed twice.
   */
  projects(extra: SessionEntry[] = []): ProjectEntry[] {
    const own = new Set(extra.map((e) => e.sessionId));
    const imports = (this.codex?.list() ?? []).filter((e) => !own.has(e.sessionId));
    return extra.length || imports.length ? this.group([...this.entries, ...extra, ...imports]) : this.grouped;
  }

  sessions(): SessionEntry[] {
    return this.entries;
  }
}
