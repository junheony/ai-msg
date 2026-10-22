import type { EngineId } from '../../shared/setup-types';
import { sm, type ServerMessages } from '../i18n';

// Server-side user strings for packaging (CLI, lock, doctor, service, setup wizard) now live in the server dictionary
// (src/server/i18n/{en,ko}/setup.ts). Read them at use time: the locale is set after the settings load.

export const texts = (): ServerMessages['setup']['cli'] => sm().setup.cli;
export const probeTexts = (): ServerMessages['setup']['probe'] => sm().setup.probe;
export const profileTexts = (): ServerMessages['setup']['profile'] => sm().setup.profile;
export const serviceTexts = (): ServerMessages['setup']['service'] => sm().setup.service;

const CLI_NAME: Record<EngineId, string> = { claude: 'claude', codex: 'codex', gemini: 'agy', grok: 'grok' };
const BIN_VAR: Record<EngineId, string> = { claude: 'DECK_CLAUDE_BIN', codex: 'DECK_CODEX_BIN', gemini: 'DECK_GEMINI_BIN', grok: 'DECK_GROK_BIN' };

/** What the user runs in a terminal to log in. `profileDir` (`~/…`): a Claude profile other than the default `~/.claude`. */
export function loginCommandFor(engine: EngineId, profileDir?: string): string {
  switch (engine) {
    case 'claude': return profileDir ? `CLAUDE_CONFIG_DIR=${profileDir} claude auth login` : 'claude auth login';
    case 'codex': return 'codex login';
    case 'gemini': return 'agy';
    case 'grok': return 'grok login';
  }
}

/** One sentence after the login command (Gemini's has no subcommand). */
export function loginHint(engine: EngineId, command: string): string {
  return engine === 'gemini' ? sm().setup.loginHintGemini(command) : sm().setup.loginHint(command);
}

export function missingBinNote(engine: EngineId): string {
  return sm().setup.missingBin(CLI_NAME[engine], BIN_VAR[engine], engine === 'grok' ? 'DECK_GROK_BIN, PATH, ~/.grok/bin/grok' : null);
}
