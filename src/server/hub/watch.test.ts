import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubStatus } from '../../shared/hub-types';
import type { ServerMessage } from '../../shared/protocol';
import { createHubWatch } from './watch';

const status = (at: string): HubStatus => ({ modes: [], host: 'h', generated_at: at });

describe('hub watch (push)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the current status to a new watcher at once, then only when generated_at changes', async () => {
    let current = status('t1');
    let calls = 0;
    const sent: [string, ServerMessage][] = [];
    const w = createHubWatch<string>({ status: { status: async () => { calls++; return current; } }, send: (s, m) => sent.push([s, m]), intervalMs: 1000 });
    w.watch('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([['a', { type: 'hub_status', status: status('t1') }]]);
    await vi.advanceTimersByTimeAsync(1000); // unchanged: nothing
    expect(sent).toHaveLength(1);
    w.watch('b'); // a second watcher gets the current one even though it is unchanged
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[1]).toEqual(['b', { type: 'hub_status', status: status('t1') }]);
    current = status('t2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.slice(2)).toEqual([['a', { type: 'hub_status', status: status('t2') }], ['b', { type: 'hub_status', status: status('t2') }]]);
    expect(calls).toBe(4);
    w.unwatch('a'); w.unwatch('b');
    expect(w.size()).toBe(0);
    current = status('t3');
    await vi.advanceTimersByTimeAsync(5000); // timer stopped with the last watcher
    expect(calls).toBe(4);
  });

  it('a failing pass is swallowed and the loop keeps going; stop() drops everyone', async () => {
    let fail = true;
    const sent: string[] = [];
    const w = createHubWatch<string>({ status: { status: async () => { if (fail) throw new Error('boom'); return status('ok'); } }, send: (s) => sent.push(s), intervalMs: 500 });
    w.watch('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual(['a']);
    w.stop();
    expect(w.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(['a']);
  });
});
