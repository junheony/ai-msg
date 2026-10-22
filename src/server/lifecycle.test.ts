import { describe, expect, it } from 'vitest';
import { SERVICE_DECK_KEYS } from './cli/service/record';
import { loadConfig } from './config';
import { drain, flushThenExit, installGracefulShutdown, type DrainTarget } from './lifecycle';

/** A fake clock + target: `finishAt[i]` is when turn i ends; abort ends all. */
function world(finishAt: number[]) {
  let t = 0;
  let aborted = false;
  const calls: string[] = [];
  const target: DrainTarget = {
    drain: () => { calls.push('drain'); },
    activeTurns: () => (aborted ? 0 : finishAt.filter((f) => f > t).length),
    abortAll: () => { calls.push('abort'); aborted = true; },
  };
  return { target, calls, now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('drain', () => {
  it('refuses new turns at once and resolves when running turns finish, without aborting', async () => {
    const w = world([2500, 7000]);
    const logs: string[] = [];
    expect(await drain(w.target, { maxMs: 60_000, now: w.now, sleep: w.sleep, log: (m) => logs.push(m) })).toBe('drained');
    expect(w.calls).toEqual(['drain']);
    expect(w.now()).toBe(7000);
    expect(logs.join('\n')).toContain('2개');
  });

  it('aborts what is left at the deadline', async () => {
    const w = world([1000, 10 * 60_000]);
    expect(await drain(w.target, { maxMs: 5 * 60_000, now: w.now, sleep: w.sleep })).toBe('timeout');
    expect(w.calls).toEqual(['drain', 'abort']);
    expect(w.now()).toBe(5 * 60_000);
  });

  it('with no limit (maxMs Infinity) waits until the work ends, never aborting', async () => {
    const w = world([1000, 5 * 60 * 60_000]);
    const logs: string[] = [];
    expect(await drain(w.target, { maxMs: Infinity, pollMs: 60_000, now: w.now, sleep: w.sleep, log: (m) => logs.push(m) })).toBe('drained');
    expect(w.calls).toEqual(['drain']);
    expect(w.now()).toBe(5 * 60 * 60_000);
    expect(logs.join('\n')).toContain('끝날 때까지 — 다시 보내면 즉시 종료');
    expect(logs.join('\n')).toContain('2개');
    expect(logs.join('\n')).not.toContain('최대');
  });

  it('with nothing running it is done immediately', async () => {
    const w = world([]);
    expect(await drain(w.target, { maxMs: 1000, now: w.now, sleep: w.sleep })).toBe('drained');
    expect(w.now()).toBe(0);
  });
});

describe('installGracefulShutdown', () => {
  function host() {
    const handlers = new Map<string, () => void>();
    return { on: (sig: string, fn: () => void) => { handlers.set(sig, fn); }, fire: (sig: string) => handlers.get(sig)!() };
  }

  it('SIGTERM and SIGUSR2 drain then exit once; a second signal exits now', async () => {
    const h = host();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let active = 1;
    const calls: string[] = [];
    const target: DrainTarget = { drain: () => calls.push('drain'), activeTurns: () => active, abortAll: () => { calls.push('abort'); active = 0; } };
    const exits: string[] = [];
    const g = installGracefulShutdown(h, target, { maxMs: 60_000, pollMs: 1, sleep: () => gate, exit: (r) => exits.push(r) });
    h.fire('SIGUSR2');
    expect(g.draining()).toBe(true);
    expect(calls).toEqual(['drain']);
    expect(exits).toEqual([]);
    h.fire('SIGTERM');
    expect(calls).toEqual(['drain', 'drain', 'abort']);
    expect(exits).toEqual(['SIGTERM']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual(['SIGTERM']);
  });

  it('exits after the drain completes', async () => {
    const h = host();
    let active = 1;
    const target: DrainTarget = { drain: () => {}, activeTurns: () => active, abortAll: () => {} };
    const exits: string[] = [];
    installGracefulShutdown(h, target, { maxMs: 60_000, pollMs: 1, sleep: async () => { active = 0; }, exit: (r) => exits.push(r) });
    h.fire('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual(['SIGTERM:drained']);
  });

  it('request starts the same drain without a signal; while draining it does nothing (no forced exit)', async () => {
    const h = host();
    let active = 1;
    const calls: string[] = [];
    const target: DrainTarget = { drain: () => calls.push('drain'), activeTurns: () => active, abortAll: () => calls.push('abort') };
    const exits: string[] = [];
    let drains = 0;
    const g = installGracefulShutdown(h, target, { maxMs: Infinity, pollMs: 1, sleep: () => new Promise((r) => setTimeout(r, 1)), exit: (r) => exits.push(r), onDrain: () => { drains++; } });
    g.request('UI 재시작');
    expect(g.draining()).toBe(true);
    g.request('UI 재시작');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c === 'abort')).toEqual([]);
    expect(drains).toBe(1);
    expect(exits).toEqual([]);
    active = 0;
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual(['UI 재시작:drained']);
  });

  it('force: nothing when not draining; while draining it aborts and exits now like a second signal', () => {
    const h = host();
    const calls: string[] = [];
    const target: DrainTarget = { drain: () => calls.push('drain'), activeTurns: () => 1, abortAll: () => calls.push('abort') };
    const exits: string[] = [];
    const g = installGracefulShutdown(h, target, { maxMs: Infinity, pollMs: 1, sleep: () => new Promise(() => {}), exit: (r) => exits.push(r) });
    expect(g.force('UI 강제 재시작')).toBe(false);
    expect(g.draining()).toBe(false);
    expect(calls).toEqual([]);
    g.request('UI 재시작');
    expect(g.force('UI 강제 재시작')).toBe(true);
    expect(calls).toEqual(['drain', 'drain', 'abort']);
    expect(exits).toEqual(['UI 강제 재시작']);
  });

  it('onDrain runs once when a graceful drain starts', () => {
    const h = host();
    let drains = 0;
    installGracefulShutdown(h, { drain: () => {}, activeTurns: () => 1, abortAll: () => {} }, { maxMs: 60_000, sleep: () => new Promise(() => {}), exit: () => {}, onDrain: () => { drains++; } });
    h.fire('SIGTERM');
    h.fire('SIGTERM');
    expect(drains).toBe(1);
  });

  it('an onDrain that throws is logged and the drain still runs', async () => {
    const h = host();
    const calls: string[] = [];
    const logs: string[] = [];
    const exits: string[] = [];
    installGracefulShutdown(h, { drain: () => calls.push('drain'), activeTurns: () => 0, abortAll: () => {} }, { maxMs: 60_000, log: (m) => logs.push(m), exit: (r) => exits.push(r), onDrain: () => { throw new Error('disk full'); } });
    h.fire('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['drain']);
    expect(exits).toEqual(['SIGTERM:drained']);
    expect(logs.join('\n')).toContain('disk full');
  });

  it('with no limit a second signal still exits at once', async () => {
    const h = host();
    let active = 1;
    const calls: string[] = [];
    const target: DrainTarget = { drain: () => calls.push('drain'), activeTurns: () => active, abortAll: () => { calls.push('abort'); active = 0; } };
    const exits: string[] = [];
    let t = 0;
    installGracefulShutdown(h, target, { maxMs: Infinity, pollMs: 60_000, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setTimeout(r, 0)); }, exit: (r) => exits.push(r) });
    h.fire('SIGTERM');
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(t).toBeGreaterThan(0);
    expect(calls).toEqual(['drain']);
    expect(exits).toEqual([]);
    h.fire('SIGUSR2');
    expect(calls).toEqual(['drain', 'drain', 'abort']);
    expect(exits).toEqual(['SIGUSR2']);
  });

  it('SIGINT does not wait', () => {
    const h = host();
    const calls: string[] = [];
    const exits: string[] = [];
    installGracefulShutdown(h, { drain: () => calls.push('drain'), activeTurns: () => 3, abortAll: () => calls.push('abort') }, { maxMs: 60_000, exit: (r) => exits.push(r) });
    h.fire('SIGINT');
    expect(calls).toEqual(['drain', 'abort']);
    expect(exits).toEqual(['SIGINT']);
  });
});

describe('flushThenExit', () => {
  it('exits once the flush resolves', async () => {
    let release!: () => void;
    const exits: number[] = [];
    const done = flushThenExit(() => new Promise<void>((r) => { release = r; }), () => exits.push(1), 1500);
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([]);
    release();
    await done;
    expect(exits).toEqual([1]);
  });

  it('exits after the timeout when the flush hangs, and when it rejects', async () => {
    const exits: string[] = [];
    await flushThenExit(() => new Promise<void>(() => {}), () => exits.push('hang'), 10);
    await flushThenExit(() => Promise.reject(new Error('x')), () => exits.push('reject'), 1500);
    expect(exits).toEqual(['hang', 'reject']);
  });
});

describe('config: drain and background limits', () => {
  it('defaults to no drain or background limit; positive env minutes set one; 0, empty and junk mean no limit', () => {
    const d = loadConfig({ PATH: '/nonexistent' }, '/h', '/repo');
    expect(d.drainMaxMs).toBe(Infinity);
    expect(d.bgMaxMs).toBe(Infinity);
    expect(loadConfig({ PATH: '/nonexistent', DECK_DRAIN_MAX_MIN: '0', DECK_BG_MAX_MIN: '' }, '/h', '/repo')).toMatchObject({ drainMaxMs: Infinity, bgMaxMs: Infinity });
    const o = loadConfig({ PATH: '/nonexistent', DECK_DRAIN_MAX_MIN: '30', DECK_BG_MAX_MIN: '0.5' }, '/h', '/repo');
    expect(o.drainMaxMs).toBe(30 * 60_000);
    expect(o.bgMaxMs).toBe(30_000);
    expect(loadConfig({ PATH: '/nonexistent', DECK_DRAIN_MAX_MIN: 'x', DECK_BG_MAX_MIN: '-1' }, '/h', '/repo')).toMatchObject({ drainMaxMs: Infinity, bgMaxMs: Infinity });
  });

  it('steering is on unless DECK_STEER=0', () => {
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').steer).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_STEER: '1' }, '/h', '/repo').steer).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_STEER: '0' }, '/h', '/repo').steer).toBe(false);
  });

  it('prompt suggestions are on unless DECK_PROMPT_SUGGEST=0', () => {
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').promptSuggestions).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_PROMPT_SUGGEST: '0' }, '/h', '/repo').promptSuggestions).toBe(false);
  });

  it('the Claude /usage poll is on unless DECK_CLAUDE_USAGE_POLL=0, and a service carries the switch over', () => {
    expect(loadConfig({ PATH: '/nonexistent' }, '/h', '/repo').claudeUsagePoll).toBe(true);
    expect(loadConfig({ PATH: '/nonexistent', DECK_CLAUDE_USAGE_POLL: '0' }, '/h', '/repo').claudeUsagePoll).toBe(false);
    expect(SERVICE_DECK_KEYS).toContain('DECK_CLAUDE_USAGE_POLL');
  });
});
