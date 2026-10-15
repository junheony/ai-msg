import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { versionAtLeast } from '../CodexEngine';

/** 2.1.259 introduced `--permission-prompts`; 2.1.283 is the version the plan's CLI facts were verified on. */
export const MIN_CLAUDE_VERSION = '2.1.259';
export const RECOMMENDED_CLAUDE_VERSION = '2.1.283';

export type ClaudeBin =
  | { ok: true; bin: string; version: string; belowRecommended: boolean }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'too_old'; bin: string; version: string };

export function parseClaudeVersion(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** `claude --version` with a minimal env: no profile dir, no tokens — the version string needs neither. */
function defaultVersionFn(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
  } catch {
    return null;
  }
}

/**
 * `DECK_CLAUDE_BIN` → each PATH entry → `~/.local/bin/claude` → `~/.claude/local/claude`.
 * Every candidate (the override included) must report >= MIN_CLAUDE_VERSION. The first existing
 * but too-old binary is remembered so the startup log can say "update claude" instead of "install".
 */
export function resolveClaudeBin(
  env: NodeJS.ProcessEnv,
  home: string,
  existsFn: (p: string) => boolean = isExecutable,
  versionFn: (bin: string) => string | null = defaultVersionFn,
): ClaudeBin {
  let tooOld: { bin: string; version: string } | null = null;
  const check = (p: string): ClaudeBin | null => {
    if (!existsFn(p)) return null;
    const version = parseClaudeVersion(versionFn(p));
    if (version === null) return null;
    if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) { tooOld ??= { bin: p, version }; return null; }
    return { ok: true, bin: p, version, belowRecommended: !versionAtLeast(version, RECOMMENDED_CLAUDE_VERSION) };
  };
  if (env.DECK_CLAUDE_BIN) {
    const r = check(env.DECK_CLAUDE_BIN);
    if (r) return r;
    return tooOld ? { ok: false, reason: 'too_old', ...(tooOld as { bin: string; version: string }) } : { ok: false, reason: 'missing' };
  }
  const candidates = [
    ...(env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ];
  for (const p of candidates) {
    const r = check(p);
    if (r) return r;
  }
  return tooOld ? { ok: false, reason: 'too_old', ...(tooOld as { bin: string; version: string }) } : { ok: false, reason: 'missing' };
}
