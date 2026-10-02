import { describe, expect, it } from 'vitest';
import { resolveCopies, type PrefixFn } from './copies';

type C = { file: string; size: number; mtimeMs: number };
const c = (file: string, mtimeMs: number): C => ({ file, size: file.length, mtimeMs });
/** "file" names double as contents: x is a prefix of y when y starts with x. */
const prefix: PrefixFn = async (a, b) => b.file.startsWith(a.file);

describe('resolveCopies', () => {
  it('a prefix chain → the longest copy wins regardless of mtime', async () => {
    const r = await resolveCopies([c('ab', 9), c('abcd', 1), c('a', 5)], prefix);
    expect(r?.best.file).toBe('abcd');
    expect(r?.heads.map((h) => h.file)).toEqual(['abcd']);
  });

  it('equal copies → the first listed (deck\'s current) wins', async () => {
    const first = c('ab', 1);
    const r = await resolveCopies([first, c('ab', 9)], prefix);
    expect(r?.best).toBe(first);
    expect(r?.heads).toHaveLength(1);
  });

  it('diverged → both heads reported, newest mtime wins; prefixes of a head drop out', async () => {
    const r = await resolveCopies([c('abX', 1), c('a', 50), c('abY', 7)], prefix);
    expect(r?.heads.map((h) => h.file).sort()).toEqual(['abX', 'abY']);
    expect(r?.best.file).toBe('abY');
  });

  it('no copies → null', async () => {
    expect(await resolveCopies([], prefix)).toBeNull();
  });
});
