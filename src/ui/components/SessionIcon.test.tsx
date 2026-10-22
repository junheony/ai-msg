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

  it('pins of one project that share a letter: the later ones (id order) take two, whatever order they come in', () => {
    const pins = [row('b', '백업'), row('a', '백테스트'), row('c', '정리')];
    const m = assignMonograms(pins, []);
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual(['백', '백업', '정']);
    const r = assignMonograms([...pins].reverse(), []);
    for (const id of ['a', 'b', 'c']) expect(r.get(id)).toBe(m.get(id));
    // Another project may share the letter.
    const two = assignMonograms([row('a', '백테스트'), row('b', '백업', 'other')], []);
    expect(two.get('b')).toBe('백');
  });

  it('a row below: two letters when the row right above (same project) or a pin of its project shows its letter', () => {
    const m = assignMonograms([row('p', 'Fix pins')], [
      row('r1', 'feature'), // F is a pin's letter
      row('r2', 'alpha'), row('r3', 'apple'), // right under a same-letter row
      row('r4', 'avocado', 'other'), // another project: one letter
      row('r5', 'banana'), row('r6', 'zebra'), row('r7', 'bongo'), // b … z … b: not neighbours
    ]);
    expect(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((id) => m.get(id))).toEqual(['Fe', 'A', 'Ap', 'A', 'B', 'Z', 'B']);
  });

  it('a pinned row listed again below keeps its letters', () => {
    const m = assignMonograms([row('a', 'alpha'), row('b', 'alps')], [row('b', 'alps'), row('c', 'cat')]);
    expect(m.get('b')).toBe('Al');
    expect(m.get('c')).toBe('C');
  });
});

describe('SESSION_ICONS', () => {
  it('matches the server allow-list, names unique', () => {
    expect(SESSION_ICONS.map((i) => i.name)).toEqual([...SESSION_GLYPH_NAMES]);
  });
});
