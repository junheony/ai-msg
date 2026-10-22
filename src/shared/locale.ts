// The language of this runtime (one per browser tab / server process) and how it is detected (i18n plan ③ Task 1).

export const LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];
/** A device's choice: 'auto' follows the browser. */
export type LangPref = 'auto' | Locale;

export function isLocale(v: unknown): v is Locale {
  return (LOCALES as readonly unknown[]).includes(v);
}

/**
 * Korean when any entry's primary subtag is `ko` (`ko-KR`, any case): Korean users often list English first
 * (['en-US', 'ko-KR']). Otherwise the first supported entry; none → 'en'.
 */
export function localeFromLanguages(langs: readonly string[]): Locale {
  const primaries = langs.map((l) => l.split(/[-_]/)[0]!.toLowerCase());
  if (primaries.includes('ko')) return 'ko';
  return primaries.find(isLocale) ?? 'en';
}

/**
 * DECK_LANG (en|ko only) → LC_ALL → LC_MESSAGES → LANG: the first that is set and not C / POSIX decides by its first two
 * letters (`ko_KR.UTF-8` → ko); an unknown language → 'en'. Nothing set → `fallback` ('en' unless the caller already has one).
 */
export function localeFromEnv(env: Record<string, string | undefined>, fallback: Locale = 'en'): Locale {
  if (isLocale(env.DECK_LANG)) return env.DECK_LANG;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    if (!v || v === 'C' || v === 'POSIX' || v.startsWith('C.')) continue;
    const two = v.slice(0, 2).toLowerCase();
    return isLocale(two) ? two : 'en';
  }
  return fallback;
}

let current: Locale = 'en';

export function setLocale(l: Locale): void {
  current = l;
}

export function getLocale(): Locale {
  return current;
}

/** The current locale's entry. */
export function pick<T>(byLocale: Record<Locale, T>): T {
  return byLocale[current];
}

/** The BCP 47 tag for Intl formatting. */
export function intlTag(l: Locale): 'en-US' | 'ko-KR' {
  return l === 'ko' ? 'ko-KR' : 'en-US';
}

/**
 * A dictionary's shape without its literal types: `const ko: Widen<typeof en> = { … }` makes tsc catch a missing or extra
 * key (and a function with other parameters) while letting every string differ.
 */
export type Widen<T> = T extends string
  ? string
  : T extends (...a: infer A) => infer R
    ? (...a: A) => R extends string ? string : R
    : T extends object
      ? { [K in keyof T]: Widen<T[K]> }
      : T;
