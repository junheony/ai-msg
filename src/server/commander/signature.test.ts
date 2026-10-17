import { describe, expect, it } from 'vitest';
import { failedTestNames, noProgress, normalizeErrorLine, segmentSignature } from './signature';

describe('normalizeErrorLine', () => {
  it('drops paths, numbers and hashes and keeps only the first non-empty line', () => {
    const a = normalizeErrorLine('\nTypeError at /tmp/run-123/src/a.ts:42:7 (commit 1a2b3c4d5e)\nmore');
    const b = normalizeErrorLine('TypeError at /tmp/run-999/src/a.ts:10:1 (commit ffeeddccbb)');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d/);
  });
});

describe('failedTestNames', () => {
  it('reads vitest, pytest, go and cargo failures', () => {
    const out = [
      ' FAIL  src/a.test.ts > math > adds',
      ' × src/b.test.ts > subtracts 12ms',
      'FAILED tests/test_x.py::test_one - assert 1 == 2',
      '--- FAIL: TestThing (0.01s)',
      'test parse::works ... FAILED',
    ].join('\n');
    expect(failedTestNames(out)).toEqual(['TestThing', 'parse::works', 'src/a.test.ts > math > adds', 'src/b.test.ts > subtracts', 'tests/test_x.py::test_one'].sort());
  });
});

const sig = (o: Partial<Parameters<typeof segmentSignature>[0]> = {}) =>
  segmentSignature({ ok: true, errorText: null, changedFileCount: 0, tests: [], ...o });

describe('segmentSignature', () => {
  it('is the same for the same failure with different line numbers', () => {
    const a = sig({ ok: false, errorText: 'Error in /x/a.ts:1', changedFileCount: 2 });
    const b = sig({ ok: false, errorText: 'Error in /y/a.ts:99', changedFileCount: 2 });
    expect(a).toBe(b);
  });
  it('uses failed test names', () => {
    const t = (name: string) => [{ command: 'npx vitest run', exitCode: 1, output: ` FAIL  ${name}` }];
    expect(sig({ tests: t('a > x') }).split('.')[0]).not.toBe(sig({ tests: t('a > y') }).split('.')[0]);
    expect(sig({ tests: t('a > x') }).split('.')[0]).not.toBe('-');
  });
  it('no failure → error part "-"', () => {
    expect(sig().split('.')[0]).toBe('-');
  });
});

describe('noProgress', () => {
  const fail = (e: string, files = 1) => sig({ ok: false, errorText: e, changedFileCount: files });
  it('same error signature twice in the last three', () => {
    expect(noProgress([fail('A'), fail('A')])).toBe(true);
    expect(noProgress([fail('A'), sig({ changedFileCount: 1 }), fail('A')])).toBe(true);
  });
  it('A/B alternation', () => {
    expect(noProgress([fail('A'), fail('B'), fail('A')])).toBe(true);
  });
  it('three segments with no changes and the same test results', () => {
    expect(noProgress([sig(), sig(), sig()])).toBe(true);
    expect(noProgress([sig(), sig()])).toBe(false);
    expect(noProgress([sig(), sig({ changedFileCount: 1 }), sig()])).toBe(false);
  });
  it('only the last three count; distinct errors with edits are progress', () => {
    expect(noProgress([fail('A'), fail('B'), fail('C'), fail('D')])).toBe(false);
    expect(noProgress([fail('A'), fail('B'), fail('C')])).toBe(false);
    expect(noProgress([])).toBe(false);
    expect(noProgress(['garbage'])).toBe(false);
  });

  it('the last segment resolving an earlier error is progress, not stagnation (§5 MEDIUM fix, signature.ts:69-73)', () => {
    expect(noProgress([fail('A'), fail('A'), sig()])).toBe(false);
    expect(noProgress([fail('A'), sig()])).toBe(false);
    // 한 번도 오류가 없던 정체(변경 0·결과 동일)는 여전히 진척 없음이다.
    expect(noProgress([sig(), sig(), sig()])).toBe(true);
  });
});
