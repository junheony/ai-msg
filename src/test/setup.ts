/**
 * Unit tests assert the full (non-concise) chrome by default. Concise mode is on for real users
 * (`DEFAULT_PREFS.conciseMode`); tests that cover it set the pref explicitly.
 */
import { beforeEach } from 'vitest';
import { DEFAULT_PREFS, PREFS_KEY } from '../ui/prefs';

beforeEach(() => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, conciseMode: false }));
    }
  } catch { /* node env without localStorage */ }
});
