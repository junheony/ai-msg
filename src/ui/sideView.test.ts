import { describe, expect, it } from 'vitest';
import { errorStatus, fileErrorKind, formatSize, lineCount, pickTarget, resolveDocLink } from './sideView';

describe('sideView', () => {
  it('formatSize: B / KB (one decimal under 10 KB) / MB', () => {
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(38_000)).toBe('37 KB');
    expect(formatSize(1.6 * 1024 * 1024)).toBe('1.6 MB');
    expect(formatSize(-1)).toBe('');
  });

  it('lineCount matches the gutter: a trailing newline starts no line, empty text is one line', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb\nc')).toBe(3);
  });

  it('fileErrorKind by status; errorStatus reads what getJson attached', () => {
    expect([404, 403, 413, 415, 0, 500, undefined].map(fileErrorKind)).toEqual(['missing', 'denied', 'tooBig', 'binary', 'offline', 'other', 'other']);
    expect(errorStatus(Object.assign(new Error('x'), { status: 413 }))).toBe(413);
    expect(errorStatus(new Error('x'))).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
  });

  it('resolveDocLink: next to the document, dots folded; absolute and ~ untouched', () => {
    expect(resolveDocLink('docs/spec.md', './plan.md')).toBe('docs/plan.md');
    expect(resolveDocLink('docs/spec.md', 'plan.md')).toBe('docs/plan.md');
    expect(resolveDocLink('docs/a/spec.md', '../../README.md')).toBe('README.md');
    expect(resolveDocLink('spec.md', 'img/x.png')).toBe('img/x.png');
    expect(resolveDocLink('/w/docs/spec.md', '../src/a.ts')).toBe('/w/src/a.ts');
    expect(resolveDocLink('/w/spec.md', '../../../x')).toBe('/x');
    expect(resolveDocLink('docs/spec.md', '../../x')).toBe('../x');
    expect(resolveDocLink('docs/spec.md', '/abs/x.md')).toBe('/abs/x.md');
    expect(resolveDocLink('docs/spec.md', '~/x.md')).toBe('~/x.md');
  });

  it('pickTarget: an exact listed path or no match → typed; else the highlighted match; nothing → null', () => {
    const files = ['a/b.ts', 'a/bb.ts'];
    expect(pickTarget('a/bb.ts', ['a/b.ts', 'a/bb.ts'], files, 0)).toBe('a/bb.ts');
    expect(pickTarget('bb', ['a/bb.ts'], files, 0)).toBe('a/bb.ts');
    expect(pickTarget('new.ts', [], files, -1)).toBe('new.ts');
    expect(pickTarget('  ', files, files, -1)).toBeNull();
  });

  it('pickTarget: a cut-off list and a typed path → the path as written (leading ./ dropped), not the fuzzy match', () => {
    const files = ['a/bb.ts'];
    expect(pickTarget('./a/b', ['a/bb.ts'], files, 0, true)).toBe('a/b');
    expect(pickTarget('a/b', ['a/bb.ts'], files, 0, false)).toBe('a/bb.ts');
    expect(pickTarget('bb', ['a/bb.ts'], files, 0, true)).toBe('a/bb.ts');
  });
});
