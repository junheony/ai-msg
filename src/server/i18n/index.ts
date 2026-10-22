import { localeFromEnv, pick, type Locale, type Widen } from '../../shared/locale';
import type { DeckSettings } from '../../shared/protocol';
import { en } from './en';
import { ko } from './ko';

export type ServerMessages = Widen<typeof en>;

/** The server's strings in the current locale (one per process: resolveServerLocale). */
export const sm = (): ServerMessages => pick<ServerMessages>({ en, ko });

/** The server's language: the last explicit pick from any device, else the environment (DECK_LANG → LC_ALL → LC_MESSAGES → LANG). */
export function resolveServerLocale(settings: Pick<DeckSettings, 'language'>, env: Record<string, string | undefined>): Locale {
  return settings.language ?? localeFromEnv(env);
}
