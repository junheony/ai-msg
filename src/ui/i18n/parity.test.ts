import { describe, expect, it } from 'vitest';
import { en } from './en';
import { ko } from './ko';
import { en as sharedEn } from '../../shared/messages/en';
import { ko as sharedKo } from '../../shared/messages/ko';

const shape = (o: unknown): unknown => typeof o === 'function' ? `fn/${(o as (...a: unknown[]) => unknown).length}` : typeof o === 'string' ? 'str' : Object.fromEntries(Object.entries(o as object).sort().map(([k, v]) => [k, shape(v)]));
const strings = (o: unknown): string[] => typeof o === 'string' ? [o] : typeof o === 'function' ? [] : Object.values(o as object).flatMap(strings);

describe('UI dictionaries', () => {
  it('ko has exactly the keys and function arities of en', () => {
    expect(shape(ko)).toEqual(shape(en));
    expect(shape(sharedKo)).toEqual(shape(sharedEn));
  });

  it('no empty strings in either locale', () => {
    for (const d of [en, ko, sharedEn, sharedKo]) expect(strings(d).filter((s) => s.length === 0)).toEqual([]);
  });
});
