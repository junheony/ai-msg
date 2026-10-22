import { describe, expect, it } from 'vitest';
import { SESSION_GLYPH_NAMES } from '../../shared/sessionIcons';
import { SESSION_ICONS, assignMonograms, monogram } from './SessionIcon';

describe('monogram', () => {
  it('takes the first usable character: Hangul, Latin upper-cased, digits', () => {
    expect(monogram('백테스트 정리')).toBe('백');
    expect(monogram('fix the build')).toBe('F');
    expect(monogram('2026 계획')).toBe('2');
    expect(monogram('Ünïcode')).toBe('Ü');
  });

  it('skips leading emoji, punctuation, space and bracket tags', () => {
    expect(monogram('🚀 배포')).toBe('배');
    expect(monogram('👩‍💻👍🏽 — hello')).toBe('H');
    expect(monogram('  "quoted"')).toBe('Q');
    expect(monogram('[WIP] foo')).toBe('F');
    expect(monogram('[WIP] (초안) 설계')).toBe('설');
    expect(monogram('【公告】 news')).toBe('N');
    expect(monogram('[WIP]')).toBe('W'); // nothing after the tag: the tag itself
  });

  it('falls back to the project name, then a dot', () => {
    expect(monogram('', 'deck')).toBe('D');
    expect(monogram('🔥🔥', '프로젝트')).toBe('프');
    expect(monogram('', '')).toBe('·');
    expect(monogram('...', '!!!')).toBe('·');
  });

  it('two characters: the first two usable ones, Latin as Capital + lower', () => {
    expect(monogram('백테스트', '', 2)).toBe('백테');
    expect(monogram('FX backtest', '', 2)).toBe('Fx');
    expect(monogram('fx', '', 2)).toBe('Fx');
    expect(monogram('[WIP] a b', '', 2)).toBe('Ab');
    expect(monogram('x', '', 2)).toBe('X'); // only one there
  });

  it('composes decomposed Hangul (NFD) before picking', () => {
    expect(monogram('백테'.normalize('NFD'))).toBe('백');
  });
});

describe('assignMonograms', () => {
  const row = (id: string, title: string, project = 'dev') => ({ id, project, title });

  it('every row of a project whose letter another listed row of it shares takes two — pinned and not alike', () => {
    const m = assignMonograms([row('p', 'Fix pins'), row('q', '백업')], [
      row('r1', 'feature'), // F, as the pin
      row('r2', 'alpha'), row('r3', 'apple'), // A twice
      row('r4', 'avocado', 'other'), // another project: one letter
      row('r5', 'banana'), row('r6', 'zebra'), row('r7', 'bongo'), // b … z … b: still a clash
      row('r8', '정리'),
    ]);
    expect(['p', 'q', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].map((id) => m.get(id))).toEqual(['Fi', '백', 'Fe', 'Al', 'Ap', 'A', 'Ba', 'Z', 'Bo', '정']);
    // Another project may share the letter.
    const two = assignMonograms([row('a', '백테스트'), row('b', '백업', 'other')], []);
    expect([two.get('a'), two.get('b')]).toEqual(['백', '백']);
  });

  it('a reorder (within or across pinned and the rest) never changes the output', () => {
    const rows = [row('a', 'alpha'), row('b', 'alps'), row('c', 'cat'), row('d', 'cobra'), row('e', 'dog'), row('f', 'apex', 'x')];
    const base = assignMonograms(rows.slice(0, 2), rows.slice(2));
    for (const [pinned, rest] of [
      [[], [...rows].reverse()],
      [rows.slice(3), rows.slice(0, 3)],
      [[rows[4]!, rows[0]!], [rows[2]!, rows[5]!, rows[1]!, rows[3]!]],
    ] as const) {
      const m = assignMonograms([...pinned], [...rest]);
      for (const r of rows) expect(m.get(r.id)).toBe(base.get(r.id));
    }
    expect(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => base.get(id))).toEqual(['Al', 'Al', 'Ca', 'Co', 'D', 'A']);
  });

  it('a pinned row listed again below counts once', () => {
    const m = assignMonograms([row('a', 'alpha')], [row('a', 'alpha'), row('c', 'cat')]);
    expect(m.get('a')).toBe('A');
    expect(m.get('c')).toBe('C');
  });
});

describe('SESSION_ICONS', () => {
  it('matches the server allow-list, names unique', () => {
    expect(SESSION_ICONS.map((i) => i.name)).toEqual([...SESSION_GLYPH_NAMES]);
  });
});
