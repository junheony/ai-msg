import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, intlTag, isLocale, localeFromEnv, localeFromLanguages, pick, setLocale } from './locale';

describe('locale', () => {
  afterEach(() => setLocale('ko'));

  it('browser languages: any ko entry → ko, else the first supported primary tag, else en', () => {
    expect(localeFromLanguages(['ko-KR', 'en-US'])).toBe('ko');
    expect(localeFromLanguages(['en-US', 'ko-KR'])).toBe('ko');
    expect(localeFromLanguages(['en-GB', 'fr'])).toBe('en');
    expect(localeFromLanguages(['fr-FR', 'de'])).toBe('en');
    expect(localeFromLanguages(['fr-FR', 'KO'])).toBe('ko');
    expect(localeFromLanguages([])).toBe('en');
  });

  it('env: DECK_LANG > LC_ALL > LC_MESSAGES > LANG, C/POSIX skipped, unknown → en', () => {
    expect(localeFromEnv({ LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', LC_ALL: 'C' })).toBe('ko');
    expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'POSIX' })).toBe('ko');
    expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', LC_ALL: 'en_US.UTF-8' })).toBe('en');
    expect(localeFromEnv({ LANG: 'ko_KR.UTF-8', DECK_LANG: 'en' })).toBe('en');
    expect(localeFromEnv({ DECK_LANG: 'fr', LANG: 'de_DE.UTF-8' })).toBe('en');
    expect(localeFromEnv({})).toBe('en');
    expect(localeFromEnv({}, 'ko')).toBe('ko');
    expect(localeFromEnv({ LANG: 'de_DE.UTF-8' }, 'ko')).toBe('en');
  });

  it('one current locale per runtime: pick, intlTag, isLocale', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(pick({ en: 'a', ko: 'b' })).toBe('a');
    setLocale('ko');
    expect(pick({ en: 'a', ko: 'b' })).toBe('b');
    expect(intlTag('ko')).toBe('ko-KR');
    expect(intlTag('en')).toBe('en-US');
    expect(isLocale('ko')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
