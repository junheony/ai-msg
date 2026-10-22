import { describe, expect, it } from 'vitest';
import { setLocale } from '../../shared/locale';
import { withLang } from '.';

describe('withLang', () => {
  it("tags send and start_task with this tab's UI language; other messages unchanged", () => {
    setLocale('ko');
    expect(withLang({ type: 'send', text: 'hi' })).toEqual({ type: 'send', text: 'hi', lang: 'ko' });
    expect(withLang({ type: 'start_task', text: 'x' })).toEqual({ type: 'start_task', text: 'x', lang: 'ko' });
    const other = { type: 'interrupt', turnId: 't' };
    expect(withLang(other)).toBe(other);
    setLocale('en');
    expect(withLang({ type: 'send', text: 'hi' })).toMatchObject({ lang: 'en' });
    expect(withLang({ type: 'send', text: 'hi' }, 'ko')).toMatchObject({ lang: 'ko' });
  });
});
