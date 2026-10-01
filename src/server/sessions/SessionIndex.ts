import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS, type Account } from '../../shared/accounts';
import type { PinnedProject, ProjectEntry, SessionEntry } from '../../shared/session-types';
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
  const byCwd = new Map<string, SessionEntry[]>();
  for (const s of newest.values()) {
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }
  const projects: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const p of pinned) {
    seen.add(p.cwd);
    const list = (byCwd.get(p.cwd) ?? []).sort((x, y) => y.lastModified - x.lastModified);
    projects.push({ cwd: p.cwd, name: p.name ?? path.basename(p.cwd), pinned: true, sessions: list });
  }
  for (const cwd of recent) {
    if (seen.has(cwd) || byCwd.has(cwd)) continue;
    seen.add(cwd);
    projects.push({ cwd, name: path.basename(cwd), pinned: false, sessions: [] });
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
    return parsed.filter((p): p is string => typeof p === 'string' && p.startsWith('/')).slice(0, MAX_RECENT_FOLDERS);
  } catch {
    return [];
  }
}

export class SessionIndex {
  private entries: SessionEntry[] = [];
  private grouped: ProjectEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private pinned: PinnedProject[] = [];
  private recentFolders: string[] = [];
  private recentWrite: Promise<void> = Promise.resolve();

  constructor(private readonly opts: { roots: Record<Account, string>; pinnedFile: string; recentFile?: string }) {}

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
    this.grouped = groupProjects(all, this.pinned, this.recentFolders);
  }

  recent(): string[] {
    return this.recentFolders;
  }

  /** F1: records an (already validated, real) folder as most recent and persists the list (0600). */
  async addRecent(cwd: string): Promise<string[]> {
    this.recentFolders = [cwd, ...this.recentFolders.filter((c) => c !== cwd)].slice(0, MAX_RECENT_FOLDERS);
    this.grouped = groupProjects(this.entries, this.pinned, this.recentFolders);
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
    return extra.length ? groupProjects([...this.entries, ...extra], this.pinned, this.recentFolders) : this.grouped;
  }

  sessions(): SessionEntry[] {
    return this.entries;
  }
}
