import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveUnderRoots } from './dirs';

/** Files listed for the composer's @ picker, at most. */
export const MAX_FILES = 5000;
const WALK_SKIP = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', 'venv']);
const CACHE_MS = 10_000;

export type FileListing = { cwd: string; files: string[]; truncated: boolean; git: boolean };

function gitLsFiles(cwd: string, max: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    // Tracked + untracked-but-not-ignored, relative to cwd (a subfolder of a repo lists only itself).
    execFile('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const files = stdout.split('\0').filter(Boolean);
      resolve(files.slice(0, max + 1));
    });
  });
}

/** No git: breadth-first walk, hidden entries and the usual build/dependency dirs skipped, symlinks not followed. */
async function walk(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length <= max) {
    const rel = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) queue.push(p); }
      else if (e.isFile()) { out.push(p); if (out.length > max) break; }
    }
  }
  return out;
}

/**
 * The composer's `@` picker: files under a session's cwd, relative to it. The cwd must resolve (symlinks
 * included) inside one of `roots` like `/api/dirs`; inside a git repo `git ls-files` decides (.gitignore
 * respected), otherwise a bounded walk. Listings are cached briefly per folder. Read-only.
 */
export class FileLister {
  private cache = new Map<string, { at: number; listing: FileListing }>();

  constructor(private readonly opts: { home: string; roots: string[]; max?: number; now?: () => number }) {}

  async list(input: string): Promise<FileListing> {
    const cwd = await resolveUnderRoots(input, this.opts.home, this.opts.roots);
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(cwd);
    if (hit && now - hit.at < CACHE_MS) return hit.listing;
    const max = this.opts.max ?? MAX_FILES;
    const fromGit = await gitLsFiles(cwd, max);
    const all = fromGit ?? (await walk(cwd, max));
    // git paths are already relative and inside cwd; anything odd (absolute, ..) is dropped anyway.
    const files = all.filter((f) => !f.startsWith('/') && !f.split('/').includes('..'));
    const listing: FileListing = { cwd, files: files.slice(0, max), truncated: files.length > max, git: fromGit !== null };
    this.cache.set(cwd, { at: now, listing });
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return listing;
  }
}
