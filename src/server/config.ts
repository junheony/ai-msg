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
  /** F2: pinned session ids. */
  pinsFile: string;
  /** Server settings (자동 승인). */
  settingsFile: string;
  /** F1: a new session's cwd must lie inside one of these: home, plus `DECK_EXTRA_CWD_ROOTS` (E2E temp dirs; loopback-only servers, never `/`). */
  cwdRoots: string[];
  /** Claude Desktop's Code-tab session records (read-only; titles/recency of Desktop sessions). */
  desktopSessionsRoot: string;
  /** Graceful restart (SIGTERM/SIGUSR2): how long running turns and background work may finish (`DECK_DRAIN_MAX_MIN`, default 15). */
  drainMaxMs: number;
  /** How long a CLI process is held open for background tasks after its turn (`DECK_BG_MAX_MIN`, default 120). */
  bgMaxMs: number;
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

/** Review fix 2: extra new-session roots exist for the E2E harnesses only — honoured on a loopback-only server, and `/` is never a root. */
function extraCwdRoots(env: NodeJS.ProcessEnv): string[] {
  if (env.DECK_LOOPBACK_ONLY !== '1') return [];
  return (env.DECK_EXTRA_CWD_ROOTS ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('/') && path.resolve(s) !== '/');
}

/** Positive minutes from env as ms, else the default. */
function minutes(v: string | undefined, fallbackMin: number): number {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMin) * 60_000;
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
    pinsFile: path.join(configDir, 'pins.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    cwdRoots: [home, ...extraCwdRoots(env)],
    desktopSessionsRoot: env.DECK_DESKTOP_SESSIONS_DIR || path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    drainMaxMs: minutes(env.DECK_DRAIN_MAX_MIN, 15),
    bgMaxMs: minutes(env.DECK_BG_MAX_MIN, 120),
  };
}
