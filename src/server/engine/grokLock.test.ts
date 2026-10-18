import { describe, expect, it } from 'vitest';
import { GrokLock, GrokLockAbortError, GrokLockTimeoutError, grokLockKey } from './grokLock';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('GrokLock', () => {
  it('serializes holders of one key in order; other keys do not wait', async () => {
    const lock = new GrokLock();
    const order: string[] = [];
    const r1 = await lock.acquire('a', { timeoutMs: 1000 });
    const p2 = lock.acquire('a', { timeoutMs: 1000 }).then((r) => { order.push('a2'); return r; });
    const p3 = lock.acquire('a', { timeoutMs: 1000 }).then((r) => { order.push('a3'); return r; });
    const rb = await lock.acquire('b', { timeoutMs: 1000 });
    order.push('b');
    await tick();
    expect(order).toEqual(['b']);
    r1();
    const r2 = await p2;
    await tick();
    expect(order).toEqual(['b', 'a2']);
    r2();
    (await p3)();
    rb();
    await tick();
    expect(order).toEqual(['b', 'a2', 'a3']);
    expect(lock.size).toBe(0);
  });

  it('times out with the user-facing text; a waiter that gave up does not jump or stall the queue', async () => {
    const lock = new GrokLock();
    const r1 = await lock.acquire('k', { timeoutMs: 1000 });
    const e = await lock.acquire('k', { timeoutMs: 30 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GrokLockTimeoutError);
    expect((e as Error).message).toBe('이전 Grok 프로세스가 아직 끝나지 않음');
    let got = false;
    const p3 = lock.acquire('k', { timeoutMs: 1000 }).then((r) => { got = true; return r; });
    await tick(20);
    expect(got).toBe(false);
    r1();
    (await p3)();
    expect(got).toBe(true);
  });

  it('abort while waiting rejects; release is idempotent', async () => {
    const lock = new GrokLock();
    const r1 = await lock.acquire('k', { timeoutMs: 1000 });
    const ac = new AbortController();
    const p = lock.acquire('k', { timeoutMs: 1000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(GrokLockAbortError);
    r1();
    r1();
    const r3 = await lock.acquire('k', { timeoutMs: 100 });
    r3();
  });

  it('keys: (GROK_HOME, session); a new session gets its own temporary key', () => {
    expect(grokLockKey('/g', 's1', 'x')).toBe(grokLockKey('/g', 's1', 'y'));
    expect(grokLockKey('/g', null, 'x')).not.toBe(grokLockKey('/g', null, 'y'));
    expect(grokLockKey('/g', 's1', 'x')).not.toBe(grokLockKey('/h', 's1', 'x'));
  });
});
