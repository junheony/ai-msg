import fs from 'node:fs';
import path from 'node:path';

/**
 * The deck config dir, always absolute: `DECK_CONFIG_DIR` (`~/` expands to home, a relative path is taken against
 * `cwd`) → `<home>/.config/deck` when it exists (every install before XDG support) → `$XDG_CONFIG_HOME/deck` (only
 * when absolute, per the XDG spec) → `<home>/.config/deck`.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv, home: string, o: { exists?: (p: string) => boolean; cwd?: string } = {}): string {
  const exists = o.exists ?? fs.existsSync;
  const explicit = env.DECK_CONFIG_DIR;
  if (explicit) {
    if (explicit === '~') return home;
    if (explicit.startsWith('~/')) return path.join(home, explicit.slice(2));
    return path.resolve(o.cwd ?? process.cwd(), explicit);
  }
  const legacy = path.join(home, '.config', 'deck');
  if (exists(legacy)) return legacy;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'deck');
  return legacy;
}
