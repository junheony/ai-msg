import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account, ProjectsRoots } from '../../shared/accounts';
import type { BranchLink } from '../../shared/branches';
import type { DesktopSession, PinnedProject, ProjectEntry, SessionEntry, SessionHolder } from '../../shared/session-types';
import { findCopies, resolveCopies, type PrefixFn, type SessionCopy } from './copies';
import { CodexRolloutIndex } from './CodexImports';
import { recentDesktopSessions } from './DesktopSessions';
import { ancestorInfo, type FileState } from './SessionMover';
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
          ...(head.headless ? { headless: true } : {}),
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
export type SessionMetaView = { title(sessionId: string): string | null; isArchived(sessionId: string): boolean; /** 새 세션으로 이어가기 links. */ next?(sessionId: string): string | null; prev?(sessionId: string): string | null; /** 메시지 편집 갈래 links. */ branchOf?(sessionId: string): BranchLink | null; /** 작업 폴더 바꾸기: the folder deck runs the session in (the transcript head keeps the old one). */ cwd?(sessionId: string): string | null };

type CachedFile = FileState & { tail: string };
type CachedPair = { ancestor: boolean; n: number | null; reason: 'conversation' | 'unterminated' | null; x: CachedFile; y: CachedFile };

/** sha256 of the `TAIL_BYTES` before offset `size` of `file`; null when the file is no longer inode `ino` or shorter. */
const TAIL_BYTES = 4096;
async function tailHash(file: string, size: number, ino: number): Promise<string | null> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (st.ino !== ino || st.size < size) return null;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    if (bytesRead !== buf.length) return null;
    return createHash('sha256').update(buf).digest('hex');
  } finally {
    await fh.close();
  }
}

/**
 * `isAncestor(x, y)` answers per (x, y) pair, carried over appends (transcripts are append-only) instead of
 * re-reading both files whenever one grows. A file counts as appended-to when it is the same inode, larger, and
 * the 4KB before its old end still hash the same; anything else (shrunk, replaced, rewritten) recomputes.
 * An answer is carried over only where an append provably cannot change it:
 * - was an ancestor, x unchanged, y appended-to: n = commonPrefix(x, y) can only grow (y's old bytes stay), so
 *   x's tail from lastLineEnd(x, n) is a subset of the old tail's whole lines — all complete metadata lines.
 * - was not, because of a complete conversation line in x's tail (so n < |x|), and either n < old |y| (x[n] ≠ y[n],
 *   both bytes stay) or y unchanged (n = |y| cannot grow, x's first n bytes stay): n and the tail start stay, and
 *   that line stays in x's tail.
 * `full` is the from-scratch computation (a test hook).
 */
export class AncestorCache {
  private readonly pairs = new Map<string, CachedPair>();
  constructor(private readonly full: typeof ancestorInfo = ancestorInfo, private readonly max = 2000) {}

  async isAncestor(x: string, y: string): Promise<boolean> {
    const key = `${x}\0${y}`;
    const prev = this.pairs.get(key);
    if (prev) {
      const next = await this.carry(prev, x, y).catch(() => null);
      if (next) {
        this.pairs.delete(key);
        this.pairs.set(key, next);
        return next.ancestor;
      }
      this.pairs.delete(key);
    }
    try {
      const info = await this.full(x, y);
      const [tx, ty] = await Promise.all([tailHash(x, info.x.size, info.x.ino), tailHash(y, info.y.size, info.y.ino)]);
      if (tx !== null && ty !== null) {
        this.pairs.set(key, { ancestor: info.ancestor, n: info.n, reason: info.reason, x: { ...info.x, tail: tx }, y: { ...info.y, tail: ty } });
        if (this.pairs.size > this.max) this.pairs.delete(this.pairs.keys().next().value!);
      }
      return info.ancestor;
    } catch {
      return false;
    }
  }

  /** The cached answer brought up to date with the files on disk, or null = recompute. */
  private async carry(prev: CachedPair, x: string, y: string): Promise<CachedPair | null> {
    const [sx, sy] = await Promise.all([fs.stat(x), fs.stat(y)]);
    const kind = (old: CachedFile, cur: typeof sx): 'same' | 'grown' | null => {
      if (cur.dev !== old.dev || cur.ino !== old.ino) return null;
      if (cur.size === old.size) return cur.mtimeMs === old.mtimeMs ? 'same' : null;
      return cur.size > old.size ? 'grown' : null;
    };
    const kx = kind(prev.x, sx);
    const ky = kind(prev.y, sy);
    if (!kx || !ky) return null;
    if (kx === 'same' && ky === 'same') return prev;
    let n: number | null;
    if (prev.ancestor && kx === 'same') {
      // y appended-to: n stays where y's old end did not cut it short (x[n] ≠ y[n], or all of x matched).
      n = prev.n !== null && (prev.n < prev.y.size || prev.n >= prev.x.size) ? prev.n : null;
    } else if (!prev.ancestor && prev.reason === 'conversation' && prev.n !== null && prev.n < prev.x.size && (prev.n < prev.y.size || ky === 'same')) {
      n = prev.n;
    } else {
      return null;
    }
    const update = async (file: string, old: CachedFile, cur: typeof sx, k: 'same' | 'grown'): Promise<CachedFile | null> => {
      if (k === 'same') return old;
      if ((await tailHash(file, old.size, old.ino)) !== old.tail) return null;
      const tail = await tailHash(file, cur.size, old.ino);
      return tail === null ? null : { size: cur.size, mtimeMs: cur.mtimeMs, dev: cur.dev, ino: cur.ino, tail };
    };
    const [ux, uy] = await Promise.all([update(x, prev.x, sx, kx), update(y, prev.y, sy, ky)]);
    if (!ux || !uy) return null;
    return { ...prev, n, x: ux, y: uy };
  }
}

export class SessionIndex {
  private entries: SessionEntry[] = [];
  private grouped: ProjectEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private pinned: PinnedProject[] = [];
  private recentFolders: string[] = [];
  private recentWrite: Promise<void> = Promise.resolve();
  private desktopList: DesktopSession[] = [];
  /** Ancestor answers (byte-prefix, or that plus Desktop's metadata lines), kept per file pair and carried over appends: a rescan or a session open does not re-read transcripts. */
  private readonly prefixCache = new AncestorCache();
  private readonly cachedPrefix: PrefixFn = (a, b) => this.prefixCache.isAncestor(a.file, b.file);

  private readonly codex: CodexRolloutIndex | null;

  /**
   * `desktopRoot`: Claude Desktop's `claude-code-sessions` dir (read-only metadata); absent = no Desktop list.
   * `codexRoot`: `~/.codex/sessions` — Codex Desktop / CLI threads listed for import; absent = none.
   * `codexArchivedRoot`: `~/.codex/archived_sessions` — threads archived in Codex, listed under 보관됨.
   * `home`: Claude Desktop's profile — between truly diverged copies with equal timestamps, deck's copy wins.
   * `holders`: which Claude sessions a process outside deck holds open (`heldBy`); re-read on every (re)group.
   */
  constructor(private readonly opts: { roots: ProjectsRoots; pinnedFile: string; recentFile?: string; desktopRoot?: string; codexRoot?: string; codexArchivedRoot?: string; meta?: SessionMetaView; home?: Account | null; holders?: { heldBy(sessionId: string): SessionHolder | null } }) {
    this.codex = opts.codexRoot ? new CodexRolloutIndex(opts.codexRoot, undefined, opts.codexArchivedRoot ?? null) : null;
  }

  /** A deck rename wins over the transcript's title; archived entries (deck's or Codex's) carry the flag; a Claude session held open outside deck carries `heldBy`. Unchanged entries are returned as is. */
  private decorate<T extends { sessionId: string; title: string; cwd?: string; engine?: string; archived?: boolean; codexArchived?: boolean; prevSession?: string; nextSession?: string; branch?: BranchLink; heldBy?: SessionHolder }>(e: T): T {
    const meta = this.opts.meta;
    const held = (e.engine ?? 'claude') === 'claude' ? (this.opts.holders?.heldBy(e.sessionId) ?? null) : null;
    const title = meta?.title(e.sessionId) ?? null;
    const archived = (meta?.isArchived(e.sessionId) ?? false) || !!e.codexArchived;
    const prev = meta?.prev?.(e.sessionId) ?? null;
    const next = meta?.next?.(e.sessionId) ?? null;
    const branch = meta?.branchOf?.(e.sessionId) ?? null;
    const cwd = (e.engine ?? 'claude') === 'claude' ? (meta?.cwd?.(e.sessionId) ?? null) : null;
    if (!meta && !held && !e.heldBy) return e;
    if (!title && !archived && !(cwd && cwd !== e.cwd) && !e.archived && !prev && !next && !e.prevSession && !e.nextSession && !branch && !e.branch && !held && !e.heldBy) return e;
    const out: T = { ...e, title: title ?? e.title };
    if (archived) out.archived = true;
    else delete out.archived;
    if (prev) out.prevSession = prev;
    else delete out.prevSession;
    if (next) out.nextSession = next;
    else delete out.nextSession;
    if (branch) out.branch = branch;
    else delete out.branch;
    if (held) out.heldBy = held;
    else delete out.heldBy;
    if (cwd && e.cwd !== undefined) out.cwd = cwd;
    return out;
  }

  /** Sessions deck runs or has run (its state store, a turn in flight); set by the ws layer. */
  private known: ((sessionId: string) => boolean) | null = null;

  /** `known` says which `claude -p` sessions are deck's own; the others (scripts' one-shots) stay out of the lists. Regroups. */
  setKnown(known: (sessionId: string) => boolean): void {
    this.known = known;
    this.regroup();
  }

  /** A headless session is listed only when deck runs it or keeps something for it (a title, a link, 보관됨…). */
  private listed(s: SessionEntry): boolean {
    if (!s.headless) return true;
    const id = s.sessionId;
    const meta = this.opts.meta;
    return !!this.known?.(id) || !!meta?.title(id) || !!meta?.isArchived(id) || !!meta?.next?.(id) || !!meta?.prev?.(id) || !!meta?.branchOf?.(id) || !!meta?.cwd?.(id);
  }

  private group(sessions: SessionEntry[], all = false): ProjectEntry[] {
    return groupProjects((all ? sessions : sessions.filter((s) => this.listed(s))).map((s) => this.decorate(s)), this.pinned, this.recentFolders);
  }

  /** Re-applies titles / archive flags / `heldBy` after a SessionMetaStore or process-holder change (no rescan). */
  regroup(): void {
    this.grouped = this.group(this.entries);
    this.desktopList = this.desktopList.map((d) => this.decorate(d));
  }

  /**
   * The cheap path next to `refresh`: re-stats the transcripts already listed (all, or only `sessionIds`' copies) and
   * takes their new mtime / size — no directory walk, no head read (~1 ms for a few hundred files vs ~300 ms for a
   * rescan). A vanished file is left for the next rescan. Regroups and returns true only when something moved.
   */
  async touch(sessionIds?: string[], skip?: ReadonlySet<string>): Promise<boolean> {
    const want = sessionIds ? new Set(sessionIds) : null;
    const list = this.entries.filter((e) => (!want || want.has(e.sessionId)) && !skip?.has(e.sessionId));
    const stats = await Promise.all(list.map((e) => fs.stat(e.file).catch(() => null)));
    let changed = false;
    list.forEach((e, i) => {
      const st = stats[i];
      if (!st || (st.mtimeMs === e.lastModified && st.size === e.sizeBytes)) return;
      // In place: `byId` holds these same objects.
      e.lastModified = st.mtimeMs;
      e.sizeBytes = st.size;
      changed = true;
    });
    if (changed) this.grouped = this.group(this.entries);
    return changed;
  }

  /** Called when the background Codex read (see `refresh`) has added threads. */
  onChange: (() => void) | null = null;

  /** `codexInBackground`: do not wait for the (slow) Codex rollout read; `onChange` fires once it is done. */
  async refresh(opts: { codexInBackground?: boolean } = {}): Promise<void> {
    const all = (await Promise.all(this.opts.roots.map((r) => scanProfile(r.id, r.dir)))).flat();
    this.entries = all;
    // The same id in several profiles/dirs: the copy containing the others wins; truly diverged → latest conversation timestamp.
    const byId = new Map<string, SessionEntry[]>();
    for (const e of all) byId.set(e.sessionId, [...(byId.get(e.sessionId) ?? []), e]);
    this.byId = new Map();
    for (const [id, list] of byId) {
      if (list.length === 1) { this.byId.set(id, list[0]!); continue; }
      const stamped = list.sort((x, y) => y.lastModified - x.lastModified).map((e) => ({ e, file: e.file, size: e.sizeBytes, mtimeMs: e.lastModified, account: e.account }));
      this.byId.set(id, (await resolveCopies(stamped, this.cachedPrefix, { home: this.opts.home }))!.best.e);
    }
    this.pinned = await readPinned(this.opts.pinnedFile);
    if (this.opts.recentFile) this.recentFolders = await readRecent(this.opts.recentFile);
    this.grouped = this.group(all);
    if (this.codex) {
      const codexDone = this.codex.refresh().catch(() => undefined);
      if (opts.codexInBackground) void codexDone.then(() => this.onChange?.());
      else await codexDone;
    }
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
   * a superset copy in another profile (e.g. Claude Desktop continued it on A) wins; truly diverged → latest
   * conversation timestamp (see resolveCopies).
   */
  async bestCopy(sessionId: string, projectDir: string, account: Account): Promise<SessionCopy | null> {
    return (await resolveCopies(await findCopies(this.opts.roots, sessionId, projectDir, account), this.cachedPrefix, { home: this.opts.home }))?.best ?? null;
  }

  lookup(sessionId: string): SessionEntry | null {
    const e = this.byId.get(sessionId) ?? null;
    const cwd = e ? (this.opts.meta?.cwd?.(sessionId) ?? null) : null;
    return e && cwd && cwd !== e.cwd ? { ...e, cwd } : e;
  }

  /** An external Codex thread (Codex Desktop / CLI rollout) as of the last refresh; null if unknown. */
  codexImport(threadId: string): SessionEntry | null {
    return this.codex?.lookup(threadId) ?? null;
  }

  /**
   * The Codex thread as it is now: when the cached entry is stale — its rollout moved (archived / unarchived
   * in Codex) or its folder came / went — the Codex list is rescanned once and `onChange` fires (index push).
   */
  async freshCodexImport(threadId: string): Promise<SessionEntry | null> {
    const codex = this.codex;
    const e = codex?.lookup(threadId) ?? null;
    if (!codex || !e) return e;
    const [fileOk, dirOk] = await Promise.all([fs.stat(e.file).then((st) => st.isFile(), () => false), fs.stat(e.cwd).then((st) => st.isDirectory(), () => false)]);
    if (fileOk && dirOk === !e.cwdMissing) return e;
    await codex.refresh().catch(() => undefined);
    this.onChange?.();
    return codex.lookup(threadId);
  }

  /**
   * Deck's own Codex sessions (`extra`: the state store's entries) as Codex has them now: titled with the Codex
   * thread name when there is one (the stored title is the first prompt), and at least as recent as the thread's
   * rollout file — Codex Desktop / CLI may be running it outside deck. As of the last refresh; others pass through.
   */
  codexOwned(extra: SessionEntry[]): SessionEntry[] {
    const codex = this.codex;
    if (!codex) return extra;
    return extra.map((e) => {
      if (e.engine !== 'codex') return e;
      const title = codex.threadName(e.sessionId) ?? e.title;
      const lastModified = Math.max(e.lastModified, codex.lookup(e.sessionId)?.lastModified ?? 0);
      return title === e.title && lastModified === e.lastModified ? e : { ...e, title, lastModified };
    });
  }

  /**
   * Cached grouping of the profile scan; with `extra` (Codex sessions from the state store, D4) and/or
   * imported Codex threads a fresh grouping. A thread deck already runs (in `extra`) is not listed twice;
   * if Codex has since archived it (its newest rollout is in archived_sessions), deck's entry is archived too.
   * `all`: headless sessions deck does not know are included (search, file lookup) — the sidebar leaves them out.
   */
  projects(extra: SessionEntry[] = [], opts: { all?: boolean } = {}): ProjectEntry[] {
    extra = this.codexOwned(extra);
    const all = this.codex?.list() ?? [];
    const archivedInCodex = new Set(all.filter((e) => e.codexArchived).map((e) => e.sessionId));
    const own = new Set(extra.map((e) => e.sessionId));
    const mine = archivedInCodex.size ? extra.map((e) => (archivedInCodex.has(e.sessionId) ? { ...e, archived: true, codexArchived: true } : e)) : extra;
    const imports = all.filter((e) => !own.has(e.sessionId));
    if (opts.all) return this.group([...this.entries, ...mine, ...imports], true);
    return extra.length || imports.length ? this.group([...this.entries, ...mine, ...imports]) : this.grouped;
  }

  sessions(): SessionEntry[] {
    return this.entries;
  }
}
