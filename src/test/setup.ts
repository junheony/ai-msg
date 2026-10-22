/**
 * Unit tests assert the full (non-concise) chrome by default. Concise mode is on for real users
 * (`DEFAULT_PREFS.conciseMode`); tests that cover it set the pref explicitly.
 * Tests run in Korean (the strings most of them assert); English is covered by tests that call `setLocale('en')`.
 */
import { beforeEach } from 'vitest';
import { setLocale } from '../shared/locale';
import { DEFAULT_PREFS, PREFS_KEY } from '../ui/prefs';

// Also at load: some suites build their expected strings while collecting, before any beforeEach.
setLocale('ko');

beforeEach(() => {
  setLocale('ko');
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false, lang: 'ko' }));
    }
  } catch { /* node env without localStorage */ }
});
