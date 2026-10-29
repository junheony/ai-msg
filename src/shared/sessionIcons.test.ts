import { describe, expect, it } from 'vitest';
import { MAX_SESSION_ICONS, SESSION_ICON_EMOJI, isSessionIconChoice } from './sessionIcons';

describe('isSessionIconChoice', () => {
  it('takes the listed emoji and glyph:<name>, nothing else', () => {
    expect(SESSION_ICON_EMOJI.length).toBe(24);
    for (const e of SESSION_ICON_EMOJI) expect(isSessionIconChoice(e)).toBe(true);
    expect(isSessionIconChoice('glyph:leaf')).toBe(true);
    expect(isSessionIconChoice('glyph:anchor')).toBe(true);
    expect(isSessionIconChoice('🎯')).toBe(true);
    expect(MAX_SESSION_ICONS).toBe(2000);
    for (const bad of ['glyph:nope', 'leaf', '😀', '', null, 3, '🚀🚀']) expect(isSessionIconChoice(bad)).toBe(false);
  });
});
