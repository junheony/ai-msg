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

export function groupProjects(sessions: SessionEntry[], pinned: PinnedProject[]): ProjectEntry[] {
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

export class SessionIndex {
  private entries: SessionEntry[] = [];
  private grouped: ProjectEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private pinned: PinnedProject[] = [];

  constructor(private readonly opts: { roots: Record<Account, string>; pinnedFile: string }) {}

  async refresh(): Promise<void> {
    const all = (await Promise.all(ACCOUNTS.map((a) => scanProfile(a, this.opts.roots[a])))).flat();
    this.entries = all;
    this.byId = new Map();
    for (const e of all) {
      const prev = this.byId.get(e.sessionId);
      if (!prev || e.lastModified > prev.lastModified) this.byId.set(e.sessionId, e);
    }
    this.pinned = await readPinned(this.opts.pinnedFile);
    this.grouped = groupProjects(all, this.pinned);
  }

  lookup(sessionId: string): SessionEntry | null {
    return this.byId.get(sessionId) ?? null;
  }

  /** Cached grouping of the profile scan; with `extra` (Codex sessions from the state store, D4) a fresh grouping. */
  projects(extra: SessionEntry[] = []): ProjectEntry[] {
    return extra.length ? groupProjects([...this.entries, ...extra], this.pinned) : this.grouped;
  }

  sessions(): SessionEntry[] {
    return this.entries;
  }
}
