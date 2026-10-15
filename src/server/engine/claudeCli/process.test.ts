// src/server/engine/claudeCli/process.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeProcess, exitFailureText } from './process';
import { fakeClaudeCli, cli } from './fakeClaudeCli';
import { parseLine, type CliMessage } from './messages';
import { mapCliMessage } from './stream';
import { classifyFailure } from '../limitDetect';

const mk = (fake: ReturnType<typeof fakeClaudeCli>, extra: Partial<ConstructorParameters<typeof ClaudeProcess>[0]> = {}) =>
  new ClaudeProcess({ bin: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' }, spawnFn: fake.spawnFn, killGraceMs: 50, drainMs: 20, ...extra });

const collect = async (p: ClaudeProcess) => { const out: CliMessage[] = []; for await (const m of p.messages()) out.push(m); return out; };

afterEach(() => vi.useRealTimers());

describe('ClaudeProcess', () => {
  it('spawns with bin/args/cwd/env, writes stdin lines, yields stdout frames, exits 0 after stdin closes', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    expect(fake.spawns[0]).toMatchObject({ bin: 'claude', args: ['-p'], cwd: '/w', env: { A: '1' } });
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'hi' }, uuid: 'u1' })).toBe(true);
    fake.push(cli.init(), cli.result('ok'));
    const reading = collect(p);
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    p.closeInput();
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'late' } })).toBe(false);
    const frames = await reading;
    expect(frames.map((f) => f.type)).toEqual(['system', 'result']);
    expect(await p.exited).toEqual({ code: 0, signal: null, spawnError: null });
    expect(fake.inputs[0]!.uuid).toBe('u1');
  });

  it('skips non-JSON stdout lines', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    const reading = collect(p);
    fake.ctl()!.raw('not json');
    fake.ctl()!.push(cli.init());
    fake.end(0);
    expect((await reading).length).toBe(1);
  });

  it('interrupt sends SIGINT once and escalates to SIGTERM when the child ignores it', async () => {
    const fake = fakeClaudeCli({ onSignal: () => { /* ignore SIGINT */ } });
    const p = mk(fake);
    p.start();
    p.interrupt();
    p.interrupt();
    expect(fake.state.signals).toEqual(['SIGINT']);
    expect(await p.exited).toEqual({ code: null, signal: 'SIGTERM', spawnError: null });
    expect(fake.state.signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(fake.state.inputClosed).toBe(true);
    expect(p.interrupted).toBe(true);
  });

  it('interrupt: a child that answers SIGINT with a result keeps running until stop()', async () => {
    const fake = fakeClaudeCli({ onSignal: (_s, ctl) => ctl.push({ ...cli.result(''), subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted' }) });
    const p = mk(fake, { killGraceMs: 10_000 });
    p.start();
    const it = p.messages()[Symbol.asyncIterator]();
    p.interrupt();
    const r = (await it.next()).value as CliMessage;
    expect(r.type).toBe('result');
    p.stop();
    expect(await p.exited).toEqual({ code: 0, signal: null, spawnError: null });
    expect(fake.state.signals).toEqual(['SIGINT']);
  });

  it('stop escalates to SIGTERM then SIGKILL for a child that never exits', async () => {
    const fake = fakeClaudeCli({ exitOnStdinClose: false });
    const p = mk(fake);
    p.start();
    p.stop();
    expect(await p.exited).toMatchObject({ signal: 'SIGTERM' });
  });

  it('keeps the stderr tail and never mixes it into frames', async () => {
    const fake = fakeClaudeCli();
    const p = mk(fake);
    p.start();
    fake.stderr('x'.repeat(10_000) + 'TAIL');
    fake.end(1);
    await p.exited;
    await collect(p);
    expect(p.stderrTail.endsWith('TAIL')).toBe(true);
    expect(p.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(p.exit).toEqual({ code: 1, signal: null, spawnError: null });
  });

  it('a throwing spawn is recorded as spawnError, not thrown', async () => {
    const p = new ClaudeProcess({ bin: '/nope', args: [], cwd: '/w', env: {}, spawnFn: () => { throw new Error('ENOENT'); } });
    p.start();
    expect(await p.exited).toEqual({ code: null, signal: null, spawnError: 'ENOENT' });
    expect(await collect(p)).toEqual([]);
    expect(p.write({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'x' } })).toBe(false);
  });

  it('exitFailureText (Korean, never stderr)', () => {
    expect(exitFailureText({ code: null, signal: null, spawnError: 'spawn claude ENOENT' })).toBe('Claude Code 실행 실패: spawn claude ENOENT');
    expect(exitFailureText({ code: 1, signal: null, spawnError: null })).toBe('Claude Code 종료 코드 1');
    expect(exitFailureText({ code: null, signal: 'SIGKILL', spawnError: null })).toBe('Claude Code 종료 신호 SIGKILL');
  });
});

describe('rate limits ride the stream, never stderr (review M4)', () => {
  it('rate_limit_event → rate_limit; an error result text classifies as limit', () => {
    const ev = mapCliMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_800_000_000 } } } });
    expect(ev[0]).toMatchObject({ kind: 'rate_limit', info: { status: 'rejected', fiveHour: { usedPct: 100 } } });
    const [res] = mapCliMessage({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1800000000', session_id: 's' }) as unknown as [{ ok: boolean; errorText: string | null }];
    expect(classifyFailure({ ok: res.ok, errorText: res.errorText, errorKind: null, rateLimitStatus: null })).toBe('limit');
  });
});

describe('abort fixture (real CLI capture)', () => {
  const file = path.join(__dirname, 'fixtures', 'abort.jsonl');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'abort.meta.json'), 'utf8')) as { resultAfterSigint: boolean; exit: { code: number | null; signal: string | null } };
  const frames = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => parseLine(l)!);
  it('B1: SIGINT mid-turn still produced a result frame, after the last text delta', () => {
    expect(meta.resultAfterSigint).toBe(true);
    const lastDelta = frames.map((f) => f.type).lastIndexOf('stream_event');
    const result = frames.findIndex((f) => f.type === 'result');
    expect(result).toBeGreaterThan(lastDelta);
  });
  it('B2: the process then exited on stdin close without a signal', () => {
    expect(meta.exit.signal).toBeNull();
  });
});
