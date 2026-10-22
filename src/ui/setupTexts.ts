import type { EngineId } from '../shared/setup-types';
import { ui, type UiMessages } from './i18n';

// The first-run wizard's (설치 점검) strings now live in the UI dictionary (src/ui/i18n/{en,ko}/setup.ts).

/** Product names: the same in every language. */
export const ENGINE_NAME: Record<EngineId, string> = { claude: 'Claude', codex: 'GPT (Codex)', gemini: 'Gemini', grok: 'Grok' };

export const setupTexts = (): UiMessages['setup'] => ui().setup;

/** A live view of `setupTexts()`: every read follows the current locale, so module-level imports stay correct. */
export const SETUP_TEXTS: UiMessages['setup'] = new Proxy({} as UiMessages['setup'], { get: (_t, k) => Reflect.get(setupTexts(), k) });
