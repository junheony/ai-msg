import { describe, expect, it } from 'vitest';
import { DIGEST_LIMITS, SegmentCollector, clipSummary, doneEvidenceOk, exitCodeOf, isTestRunnerCommand } from './digest';

const CWD = '/work/proj';

describe('SegmentCollector', () => {
  it('collects edited files relative to cwd, including subagent edits and NotebookEdit', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'tool_call', toolUseId: 't1', name: 'Edit', input: { file_path: '/work/proj/src/a.ts' } });
    c.add({ type: 'tool_call', toolUseId: 't2', name: 'Write', input: { file_path: 'src/b.ts' } });
    c.add({ type: 'sub_tool_call', parentToolUseId: 'ag', toolUseId: 's1', name: 'MultiEdit', input: { file_path: '/work/proj/src/c.ts' } });
    c.add({ type: 'tool_call', toolUseId: 't3', name: 'NotebookEdit', input: { notebook_path: '/work/proj/n.ipynb' } });
    c.add({ type: 'tool_call', toolUseId: 't4', name: 'Edit', input: { file_path: '/work/proj/src/a.ts' } });
    c.add({ type: 'tool_call', toolUseId: 't5', name: 'Read', input: { file_path: '/work/proj/src/z.ts' } });
    c.add({ type: 'tool_call', toolUseId: 't6', name: 'Edit', input: { file_path: '/elsewhere/x.ts' } });
    const d = c.digest('d1');
    expect(d.changedFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'n.ipynb', '/elsewhere/x.ts']);
    expect(d.changedFileCount).toBe(5);
  });

  it('caps the file list at 40 but keeps the real count', () => {
    const c = new SegmentCollector(CWD);
    for (let i = 0; i < 55; i++) c.add({ type: 'tool_call', toolUseId: `t${i}`, name: 'Write', input: { file_path: `f${i}.ts` } });
    const d = c.digest('d');
    expect(d.changedFiles).toHaveLength(DIGEST_LIMITS.files);
    expect(d.changedFileCount).toBe(55);
  });

  it('records every test run (top level and subagent) with id, exit code and changes after it', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'tool_call', toolUseId: 'r1', name: 'Bash', input: { command: 'npx vitest run' } });
    c.add({ type: 'tool_result', toolUseId: 'r1', content: 'Exit code 1\n FAIL  a.test.ts > adds', isError: true });
    c.add({ type: 'tool_call', toolUseId: 'e1', name: 'Edit', input: { file_path: 'a.ts' } });
    c.add({ type: 'tool_call', toolUseId: 'r2', name: 'Bash', input: { command: 'npx vitest run' } });
    c.add({ type: 'tool_result', toolUseId: 'r2', content: 'Tests 3 passed', isError: false });
    c.add({ type: 'tool_call', toolUseId: 'ls', name: 'Bash', input: { command: 'ls -la' } });
    c.add({ type: 'tool_result', toolUseId: 'ls', content: 'x', isError: false });
    c.add({ type: 'sub_tool_call', parentToolUseId: 'ag', toolUseId: 's1', name: 'Bash', input: { command: 'pytest -q' } });
    c.add({ type: 'sub_tool_result', parentToolUseId: 'ag', toolUseId: 's1', isError: false });
    c.add({ type: 'turn_result', ok: true, text: 'done', errorText: null });
    const d = c.digest('d');
    // r2 는 테스트 러너가 아닌 `ls -la` Bash 실행이 그 뒤에 있으므로 filesChangedAfter 를 보수적으로 true 로 본다(§3 MEDIUM 수정).
    expect(d.testRuns.map((t) => [t.testRunId, t.exitCode, t.filesChangedAfter, t.hasOutput, t.sub])).toEqual([
      ['r1', 1, true, true, false],
      ['r2', 0, true, true, false],
      ['s1', 0, false, false, true],
    ]);
    expect(doneEvidenceOk(d, 'r2')).toBe(false); // non-runner Bash (`ls`) ran after it, conservatively counts as a change
    expect(doneEvidenceOk(d, 'r1')).toBe(false); // exit 1, and changed after
    expect(doneEvidenceOk(d, 's1')).toBe(false); // no output: exit code alone is not evidence
    expect(doneEvidenceOk(d, 'nope')).toBe(false);
  });

  it('a non-runner Bash command after a passing test run conservatively marks it as changed (§3 MEDIUM fix)', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'tool_call', toolUseId: 'r1', name: 'Bash', input: { command: 'npm test' } });
    c.add({ type: 'tool_result', toolUseId: 'r1', content: 'ok', isError: false });
    c.add({ type: 'tool_call', toolUseId: 'g1', name: 'Bash', input: { command: 'git commit -am wip' } });
    c.add({ type: 'tool_result', toolUseId: 'g1', content: 'ok', isError: false });
    const d = c.digest('d');
    expect(d.testRuns[0]).toMatchObject({ testRunId: 'r1', filesChangedAfter: true });
    expect(doneEvidenceOk(d, 'r1')).toBe(false);
  });

  it('a pass followed by an edit is not evidence; a run with no result yet has no exit code', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'tool_call', toolUseId: 'r1', name: 'Bash', input: { command: 'npm test' } });
    c.add({ type: 'tool_result', toolUseId: 'r1', content: 'ok', isError: false });
    c.add({ type: 'sub_tool_call', parentToolUseId: 'ag', toolUseId: 'e', name: 'Write', input: { file_path: 'x' } });
    c.add({ type: 'tool_call', toolUseId: 'r2', name: 'Bash', input: { command: 'cargo test' } });
    const d = c.digest('d');
    expect(doneEvidenceOk(d, 'r1')).toBe(false);
    expect(d.testRuns[1]).toMatchObject({ testRunId: 'r2', exitCode: null, hasOutput: false });
  });

  it('keeps test text within 1,200 chars, newest runs first, at least the last one', () => {
    const c = new SegmentCollector(CWD);
    for (let i = 0; i < 6; i++) {
      c.add({ type: 'tool_call', toolUseId: `r${i}`, name: 'Bash', input: { command: `npx vitest run ${i}\nsecond line` } });
      c.add({ type: 'tool_result', toolUseId: `r${i}`, content: 'x'.repeat(5_000) + `END${i}`, isError: false });
    }
    const d = c.digest('d');
    const size = d.testRuns.reduce((n, t) => n + t.command.length + t.outputTail.length, 0);
    expect(size).toBeLessThanOrEqual(DIGEST_LIMITS.tests);
    expect(d.testRuns.at(-1)!.testRunId).toBe('r5');
    expect(d.testRuns.at(-1)!.outputTail.endsWith('END5')).toBe(true);
    expect(d.testRuns.every((t) => !t.command.includes('\n'))).toBe(true);
  });

  it('summarises the last turn_result of the segment and reports failure from it', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'turn_result', ok: true, text: 'first sub-turn', errorText: null });
    c.add({ type: 'turn_result', ok: false, text: 'H'.repeat(3_000) + 'T'.repeat(3_000), errorText: 'boom '.repeat(100), failure: 'other' });
    const d = c.digest('d9');
    expect(d.digestId).toBe('d9');
    expect(d.turns).toBe(2);
    expect(d.summary.length).toBeLessThanOrEqual(DIGEST_LIMITS.summary);
    expect(d.summary.startsWith('H'.repeat(1_500))).toBe(true);
    expect(d.summary).toContain('중간 생략');
    expect(d.summary.endsWith('T')).toBe(true);
    expect(d.failure.ok).toBe(false);
    expect(d.failure.kind).toBe('other');
    expect(d.failure.errorText!.length).toBeLessThanOrEqual(DIGEST_LIMITS.errorText);
    expect(d.signature).toMatch(/^[0-9a-f]{16}\.0\.[0-9a-f]{16}$/);
  });

  it('classifies a failure when the caller did not', () => {
    const c = new SegmentCollector(CWD);
    c.add({ type: 'turn_result', ok: false, text: '', errorText: 'x', errorKind: 'authentication_failed' });
    expect(c.digest('d').failure.kind).not.toBeNull();
  });

  it('a segment with no turn_result at all is not ok (§3 LOW fix, digest.ts:112)', () => {
    const d = new SegmentCollector(CWD).digest('d');
    expect(d).toMatchObject({ turns: 0, summary: '', changedFiles: [], testRuns: [], failure: { ok: false, errorText: null, kind: null } });
    expect(d.signature.startsWith('-.0.')).toBe(true);
    expect(d.retries).toBe(0);
  });

  it('internal retries: cap · failover · retry sub-turns count, background continuations (`:bg<n>`) do not', () => {
    const c = new SegmentCollector(CWD);
    const r = (turnId: string) => c.add({ type: 'turn_result', turnId, ok: true, text: '', errorText: null });
    r('u:cmd1');
    r('u:cmd1:bg1');
    r('u:cmd1:bg2');
    expect(c.digest('d').retries).toBe(0);
    r('u:cmd1:cap1');
    // A background segment cut by a limit and moved to another account (turn_retry, then its turn_result) is a failover.
    c.add({ type: 'turn_retry', turnId: 'u:cmd1:bg3' });
    r('u:cmd1:bg3');
    r('v:cmd1');
    const d = c.digest('d');
    expect(d.turns).toBe(6);
    expect(d.retries).toBe(3);
  });
});

describe('helpers', () => {
  it('clipSummary leaves short text alone', () => {
    expect(clipSummary('abc')).toBe('abc');
    expect(clipSummary('a'.repeat(4_000))).toHaveLength(4_000);
  });
  it('exitCodeOf prefers the code in the output', () => {
    expect(exitCodeOf('Exit code 2\nfail', true)).toBe(2);
    expect(exitCodeOf('fail', true)).toBe(1);
    expect(exitCodeOf('fine', false)).toBe(0);
  });

  it('exitCodeOf never returns 0 when isError is true (§3 HIGH fix, digest.ts:45-48)', () => {
    expect(exitCodeOf('Exit code 0\nFAIL something', true)).toBe(1);
  });

  it('exitCodeOf only recognizes the exit code on the first line', () => {
    expect(exitCodeOf('ok\nExit code 5', false)).toBe(0);
    expect(exitCodeOf('ok\nExit code 5', true)).toBe(1);
  });

  it('isTestRunnerCommand recognizes a runner only at the front of the command (§3 HIGH fix, digest.ts:34)', () => {
    // 인정: 맨 앞 러너, cd 접두, 환경변수 할당, npx/pnpm exec/yarn 접두.
    expect(isTestRunnerCommand('npx vitest run')).toBe(true);
    expect(isTestRunnerCommand('pnpm exec vitest run')).toBe(true);
    expect(isTestRunnerCommand('yarn jest')).toBe(true);
    expect(isTestRunnerCommand('CI=1 npm test')).toBe(true);
    expect(isTestRunnerCommand('cd src/server && npm test')).toBe(true);
    // 거부: 명령 러너 판별을 피해 가는 패턴들.
    expect(isTestRunnerCommand('cat vitest.config.ts')).toBe(false);
    expect(isTestRunnerCommand('grep jest package.json')).toBe(false);
    expect(isTestRunnerCommand('echo npm test')).toBe(false);
    expect(isTestRunnerCommand('npm test || true')).toBe(false);
    expect(isTestRunnerCommand('vitest | tail')).toBe(false);
    expect(isTestRunnerCommand('npm test; echo done')).toBe(false);
    expect(isTestRunnerCommand('npm test & echo bg')).toBe(false);
    expect(isTestRunnerCommand('npm test > out.log')).toBe(false);
    expect(isTestRunnerCommand('echo $(npm test)')).toBe(false);
    expect(isTestRunnerCommand('npm test && rm -rf /tmp/x')).toBe(false);
  });
});
