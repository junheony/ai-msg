import { getLocale, intlTag, localeFromLanguages, pick, setLocale, type LangPref, type Locale, type Widen } from '../../shared/locale';
import { en } from './en';
import { ko } from './ko';

export type UiMessages = Widen<typeof en>;

/** The UI strings in the current locale (fixed at boot; changing the language reloads the page). */
export const ui = (): UiMessages => pick<UiMessages>({ en, ko });

/** Boot: 'auto' follows the browser's languages. Sets the runtime locale and `<html lang>`. */
export function initUiLocale(pref: LangPref, languages: readonly string[] = navigator.languages, root: HTMLElement = document.documentElement): Locale {
  const l = pref === 'auto' ? localeFromLanguages(languages) : pref;
  setLocale(l);
  root.lang = l;
  return l;
}

export function formatDateTime(ms: number, o?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleString(intlTag(getLocale()), o);
}

export function formatNumber(n: number): string {
  return n.toLocaleString(intlTag(getLocale()));
}
