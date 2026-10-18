import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Design §5 fail-closed guard: a repository's own `.grok/` (hooks run at start, allow rules, mode, MCP) could apply
 * before any approval card. Until S9 shows a way to switch project config off, a turn does not start when one exists.
 * The range checked is cwd up to its git root (cwd only outside git); S9 에서 Grok 이 실제로 읽는 범위로 확정.
 */

export const GROK_PROJECT_BLOCKED_TEXT = '이 폴더에 Grok 프로젝트 설정(.grok/)이 있어 시작하지 않음';

/** 'none' = absent; 'dir' = a directory (through symlinks); 'unknown' = could not tell (counts as present). */
async function grokDirAt(dir: string): Promise<'none' | 'dir' | 'unknown'> {
  try {
    return (await fs.stat(path.join(dir, '.grok'))).isDirectory() ? 'dir' : 'none';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'unknown';
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.lstat(p); return true; } catch { return false; }
}

/** The nearest directory at or above `dir` holding `.git` (a dir, or a file for worktrees); null outside git. */
async function gitRoot(dir: string): Promise<string | null> {
  for (let d = dir; ; d = path.dirname(d)) {
    if (await exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The first `.grok` found from realpath(cwd) up to the git root, or null when there is none. `trusted` is the seat's
 * GROK_HOME (realpath): the user's own global config sits there and is not project config (a cwd of $HOME would
 * otherwise always be blocked). A `.grok` that cannot be checked counts as found.
 */
export async function findGrokProjectConfig(cwd: string, trusted: string | null = null): Promise<string | null> {
  const start = await fs.realpath(cwd);
  const root = (await gitRoot(start)) ?? start;
  for (let d = start; ; d = path.dirname(d)) {
    const found = await grokDirAt(d);
    if (found !== 'none') {
      const p = path.join(d, '.grok');
      let real: string | null = null;
      try { real = await fs.realpath(p); } catch { /* unknown → blocked */ }
      if (trusted === null || real !== trusted) return p;
    }
    if (d === root || path.dirname(d) === d) return null;
  }
}
