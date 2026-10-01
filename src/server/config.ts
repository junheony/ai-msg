import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAccount, projectsDir, type Account } from '../shared/accounts';
import { resolveCodexBin } from './engine/CodexEngine';
import { defaultCooldownDir } from './routing/cooldown';

export type DeckConfig = {
  home: string;
  configDir: string;
  tokenFile: string;
  pinnedFile: string;
  stateFile: string;
  auditFile: string;
  deckUrl: string;
  protectedAccount: Account | null;
  cooldownDir: string;
  port: number;
  loopbackOnly: boolean;
  devOrigins: string[];
  projectsRoots: Record<Account, string>;
  uiDir: string;
  /** Deviation (added per review I5): extra Host-header names (e.g. Tailscale MagicDNS) allowed in addition to loopback/CGNAT. */
  extraHosts: string[];
  /** D11: null = Codex disabled (no `codex` binary found). */
  codexBin: string | null;
  /** `$CODEX_HOME/sessions` (rollout files; read-only for deck). */
  codexSessionsRoot: string;
  /** D7: private attachment dir (0700) under the config dir. */
  attachmentsDir: string;
  /** F1: folders opened with 폴더 열기 (newest first, max 20). */
  recentFoldersFile: string;
  /** F1: a new session's cwd must lie inside one of these: home, plus `DECK_EXTRA_CWD_ROOTS` (E2E temp dirs). */
  cwdRoots: string[];
};

/** ~/.config/offload/protect: comment lines start with '#'; first non-blank token must be a|b|c. */
export function readProtect(file: string): Account | null {
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const tok = line.split(/\s+/)[0];
      return isAccount(tok) ? tok : null;
    }
  } catch {
    // missing file
  }
  return null;
}

export function readDeckUrl(file: string, fallback = 'http://127.0.0.1:9310'): string {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0]?.trim() ?? '';
    return first || fallback;
  } catch {
    return fallback;
  }
}

function repoRootDefault(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), repoRoot: string = repoRootDefault()): DeckConfig {
  const configDir = env.DECK_CONFIG_DIR || path.join(home, '.config', 'deck');
  const protectedAccount = isAccount(env.CLAUDE_PROTECT) ? env.CLAUDE_PROTECT : readProtect(path.join(home, '.config', 'offload', 'protect'));
  return {
    home,
    configDir,
    tokenFile: path.join(configDir, 'token'),
    pinnedFile: path.join(configDir, 'projects.json'),
    stateFile: path.join(configDir, 'session-state.json'),
    auditFile: path.join(configDir, 'audit.log'),
    deckUrl: env.DECK_URL || readDeckUrl(path.join(home, '.config', 'claude-pick', 'deck_url')),
    protectedAccount,
    cooldownDir: defaultCooldownDir(env, home),
    port: Number(env.DECK_PORT) || 9320,
    loopbackOnly: env.DECK_LOOPBACK_ONLY === '1',
    devOrigins: (env.DECK_DEV_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    projectsRoots: { a: projectsDir('a', home), b: projectsDir('b', home), c: projectsDir('c', home) },
    uiDir: env.DECK_UI_DIR || path.join(repoRoot, 'dist', 'ui'),
    extraHosts: (env.DECK_EXTRA_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    codexBin: resolveCodexBin(env, home),
    codexSessionsRoot: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions'),
    attachmentsDir: path.join(configDir, 'attachments'),
    recentFoldersFile: path.join(configDir, 'recent-folders.json'),
    cwdRoots: [home, ...(env.DECK_EXTRA_CWD_ROOTS ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('/'))],
  };
}
