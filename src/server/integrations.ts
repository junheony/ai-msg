import fs from 'node:fs';
import path from 'node:path';

/** Paths shared with personal tools (claude-pick, offload, usage-deck) — used only where those tools already left them. */
export type LegacyIntegrations = { deckUrlFile: string | null; protectFile: string | null; cooldownDir: string };

/**
 * `deckUrlFile`: `<home>/.config/claude-pick/deck_url` if it exists. `protectFile`: `<configDir>/protect` →
 * `<home>/.config/offload/protect` → null. `cooldownDir`: `CLAUDE_PICK_COOLDOWN_DIR` (as given) → an existing
 * `$XDG_CACHE_HOME/offload/cooldown` (absolute only) → an existing `<home>/.cache/offload/cooldown` → `<configDir>/cooldown`.
 * Reads only; nothing is created.
 */
export function legacyIntegrations(env: NodeJS.ProcessEnv, home: string, configDir: string, exists: (p: string) => boolean = fs.existsSync): LegacyIntegrations {
  const deckUrl = path.join(home, '.config', 'claude-pick', 'deck_url');
  const protect = [path.join(configDir, 'protect'), path.join(home, '.config', 'offload', 'protect')].find((p) => exists(p)) ?? null;
  let cooldownDir = env.CLAUDE_PICK_COOLDOWN_DIR || null;
  if (!cooldownDir) {
    const xdg = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? path.join(env.XDG_CACHE_HOME, 'offload', 'cooldown') : null;
    const candidates = [xdg, path.join(home, '.cache', 'offload', 'cooldown')].filter((p): p is string => !!p);
    cooldownDir = candidates.find((p) => exists(p)) ?? path.join(configDir, 'cooldown');
  }
  return { deckUrlFile: exists(deckUrl) ? deckUrl : null, protectFile: protect, cooldownDir };
}
