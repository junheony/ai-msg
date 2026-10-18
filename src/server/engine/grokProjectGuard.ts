import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Design §5 fail-closed guard: a repository's own `.grok` (hooks run at start, allow rules, mode, MCP) could apply
 * before any approval card. Until S9 shows a way to switch project config off, a turn does not start when one exists.
 * S9 결과 전까지 넓게 막음: every folder from cwd up to the one directly under the home directory (or up to the
 * filesystem root outside home) is checked, git root or not; a `.grok` of any type counts. Subfolders are not checked.
 */

export const GROK_PROJECT_BLOCKED_TEXT = '이 폴더에 Grok 프로젝트 설정(.grok/ 또는 .cursor/)이 있어 시작하지 않음';

/**
 * Folder names that count as project config: Grok's own, and Cursor's (§14.9-2: Grok reads `.cursor/` hooks, MCP servers
 * and rules through its external compat, on by default with no known switch).
 */
const PROJECT_DIRS = ['.grok', '.cursor'] as const;

/** True when `dir/<name>` exists as anything (dir, file, symlink — dangling too) or cannot be checked. */
async function configAt(dir: string, name: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, name));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/**
 * The first `.grok` or `.cursor` found from realpath(cwd) upwards, or null when there is none. `trusted` is the seat's
 * GROK_HOME (realpath): the user's own global config is not project config (a cwd of $HOME would otherwise always be
 * blocked). It covers a `.grok` only.
 * `home` bounds the walk: it stops at the folder directly under it, or at home itself when cwd is home.
 */
export async function findGrokProjectConfig(cwd: string, trusted: string | null = null, home: string = os.homedir()): Promise<string | null> {
  const start = await fs.realpath(cwd);
  let homeReal: string;
  try { homeReal = await fs.realpath(home); } catch { homeReal = path.resolve(home); }
  for (let d = start; ; d = path.dirname(d)) {
    for (const name of PROJECT_DIRS) {
      if (!(await configAt(d, name))) continue;
      const p = path.join(d, name);
      if (name !== '.grok' || trusted === null) return p;
      let real: string | null = null;
      try { real = await fs.realpath(p); } catch { /* unknown → blocked */ }
      if (real !== trusted) return p;
    }
    const parent = path.dirname(d);
    if (parent === d || parent === homeReal || d === homeReal) return null;
  }
}
