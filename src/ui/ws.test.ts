// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocket } from './ws';

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWS.instances.push(this); }
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.({ code: 1006 }); }
}

describe('createSocket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWS);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('on a close caused by lost authentication, reports it and stops reconnecting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false })));
    const onUnauthed = vi.fn();
    createSocket(() => {}, () => {}, onUnauthed);
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.runAllTimersAsync();
    expect(onUnauthed).toHaveBeenCalledTimes(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('reconnect: a socket that stopped answering is dropped at once (its late events go nowhere) and a new one opened', () => {
    const status: boolean[] = [];
    const sock = createSocket(() => {}, (v) => status.push(v));
    const first = FakeWS.instances[0]!;
    first.readyState = 1;
    first.onopen?.();
    sock.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
    expect(status).toEqual([true, false]);
    expect(first.onmessage).toBeNull();
    expect(first.onclose).toBeNull();
    // After close(): nothing.
    sock.close();
    sock.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('still reconnects when the session is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const onUnauthed = vi.fn();
    createSocket(() => {}, () => {}, onUnauthed);
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(onUnauthed).not.toHaveBeenCalled();
    expect(FakeWS.instances.length).toBeGreaterThan(1);
  });

  it('send reports whether the message left: false until open', () => {
    const s = createSocket(() => {}, () => {});
    expect(s.send({ type: 'interrupt', turnId: 't' })).toBe(false);
    FakeWS.instances[0]!.readyState = FakeWS.OPEN;
    expect(s.send({ type: 'interrupt', turnId: 't' })).toBe(true);
  });

  it('open_session says which newer server message kinds this UI understands (sandbox, turn_queued); other messages go as they are', () => {
    const s = createSocket(() => {}, () => {});
    const w = FakeWS.instances[0]!;
    w.readyState = FakeWS.OPEN;
    s.send({ type: 'open_session', sessionId: 's1' });
    s.send({ type: 'interrupt', turnId: 't' });
    expect(w.sent.map((d) => JSON.parse(d))).toEqual([{ type: 'open_session', sessionId: 's1', accepts: ['sandbox', 'turn_queued'] }, { type: 'interrupt', turnId: 't' }]);
  });

  it('wake() during the backoff wait opens a new socket at once and resets the delay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(0); // the /api/me check is done; the 1 s wait is pending (the next one will be 2 s)
    expect(FakeWS.instances).toHaveLength(1);
    sock.wake();
    expect(FakeWS.instances).toHaveLength(2);
    // The delay is back to 1 s, and the cleared timer does not open a third socket.
    FakeWS.instances[1]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(3);
  });

  it('wake() while the /api/me check is still out opens as soon as it answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    sock.wake();
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('retry() during the backoff wait connects now, without a second socket from the cleared timer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.instances).toHaveLength(1);
    sock.retry();
    expect(FakeWS.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('retry() on a socket stuck in CONNECTING drops it and opens a new one (a tap on the 다시 시도 button)', () => {
    const status: boolean[] = [];
    const sock = createSocket(() => {}, (v) => status.push(v));
    const stuck = FakeWS.instances[0]!;
    expect(stuck.readyState).toBe(0);
    sock.retry();
    expect(FakeWS.instances).toHaveLength(2);
    expect(stuck.onclose).toBeNull();
    // The second one answers: connected once, no stray status from the first.
    FakeWS.instances[1]!.readyState = 1;
    FakeWS.instances[1]!.onopen?.();
    expect(status).toEqual([false, true]);
  });

  it('retry() while the /api/me check is out waits for it (one socket), and does nothing after close()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    sock.retry();
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.instances).toHaveLength(2);
    sock.close();
    sock.retry();
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('reconnect() during the backoff wait clears the wait: one new socket, not two', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(0);
    sock.reconnect();
    expect(FakeWS.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('wake() while connected does nothing', async () => {
    const sock = createSocket(() => {}, () => {});
    FakeWS.instances[0]!.readyState = 1;
    FakeWS.instances[0]!.onopen?.();
    sock.wake();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  describe('heartbeat', () => {
    const hello = { type: 'hello' } as const;
    const deliver = (w: FakeWS, m: object) => w.onmessage?.({ data: JSON.stringify(m) });
    const opened = (opts: Parameters<typeof createSocket>[3], onMessage: (m: unknown) => void = () => {}) => {
      const sock = createSocket(onMessage, () => {}, () => {}, opts);
      const w = FakeWS.instances[0]!;
      w.readyState = FakeWS.OPEN;
      w.onopen?.();
      return { sock, w };
    };

    it('a heartbeat server: subscribes after hello, beats keep the socket, 25 s of silence drops it for a new one', () => {
      const got: unknown[] = [];
      const { w } = opened({ heartbeat: () => true }, (m) => got.push(m));
      deliver(w, hello);
      expect(w.sent.map((d) => JSON.parse(d))).toEqual([{ type: 'heartbeat' }]);
      // Beats every 10 s: never dropped, and never handed on.
      for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(10_000); deliver(w, { type: 'heartbeat' }); }
      expect(FakeWS.instances).toHaveLength(1);
      expect(got).toEqual([hello]);
      // Any other message counts as life too.
      vi.advanceTimersByTime(20_000);
      deliver(w, { type: 'activity', sessions: [] });
      vi.advanceTimersByTime(20_000);
      expect(FakeWS.instances).toHaveLength(1);
      // Silent for 25 s: closed and reconnected (the old socket's late events go nowhere).
      vi.advanceTimersByTime(5_000);
      expect(FakeWS.instances).toHaveLength(2);
      expect(w.onmessage).toBeNull();
    });

    it('an older server (no heartbeat feature): nothing sent, no watch — a quiet socket stays', () => {
      const { w } = opened({ heartbeat: () => false });
      deliver(w, hello);
      expect(w.sent).toEqual([]);
      vi.advanceTimersByTime(120_000);
      expect(FakeWS.instances).toHaveLength(1);
    });

    it('M2: while an open_session waits for its history the deadline is longer (a big frame on a slow line), back to normal once it came', () => {
      const { sock, w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      expect(sock.send({ type: 'open_session', sessionId: 's1', cwd: '/w' } as never)).toBe(true);
      vi.advanceTimersByTime(80_000); // no beat gets past the big frame
      expect(FakeWS.instances).toHaveLength(1);
      deliver(w, { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [] });
      vi.advanceTimersByTime(24_000);
      expect(FakeWS.instances).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(FakeWS.instances).toHaveLength(2);
    });

    it('M2: a history that never comes still ends in a reconnect (the longer deadline is a deadline)', () => {
      const { sock, w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      sock.send({ type: 'open_session', sessionId: 's1', cwd: '/w' } as never);
      vi.advanceTimersByTime(100_000);
      expect(FakeWS.instances).toHaveLength(2);
    });

    it('M2: a tab frozen past the deadline gets 5 s for its queued messages before the socket is dropped', () => {
      const { w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      // Frozen for a minute: the clock moved, the timer had no chance to run.
      vi.setSystemTime(Date.now() + 60_000);
      vi.advanceTimersByTime(25_000);
      expect(FakeWS.instances).toHaveLength(1);
      deliver(w, { type: 'heartbeat' }); // what queued up while frozen
      vi.advanceTimersByTime(24_000);
      expect(FakeWS.instances).toHaveLength(1);
      // Frozen again, and nothing arrives in the grace: dropped then.
      vi.setSystemTime(Date.now() + 60_000);
      vi.advanceTimersByTime(1_000);
      expect(FakeWS.instances).toHaveLength(1);
      vi.advanceTimersByTime(5_000);
      expect(FakeWS.instances).toHaveLength(2);
    });

    it('M2: the socket the watchdog opened is not watched until its first message (its hello)', () => {
      const { w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      vi.advanceTimersByTime(25_000);
      expect(FakeWS.instances).toHaveLength(2);
      const next = FakeWS.instances[1]!;
      next.readyState = FakeWS.OPEN;
      next.onopen?.();
      vi.advanceTimersByTime(14_000); // a slow start: no hello yet, the heartbeat watch does not drop it
      expect(FakeWS.instances).toHaveLength(2);
      deliver(next, hello);
      expect(next.sent.map((d) => JSON.parse(d))).toEqual([{ type: 'heartbeat' }]);
      vi.advanceTimersByTime(25_000);
      expect(FakeWS.instances).toHaveLength(3);
    });

    it('M2: a catchup answers an open_session too — the deadline is back to normal (not 100 s for the rest of the socket)', () => {
      const { sock, w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      sock.send({ type: 'open_session', sessionId: 's1', cwd: '/w', after: { epoch: 't1', seq: 3 } } as never);
      deliver(w, { type: 'catchup', sessionId: 's1' });
      vi.advanceTimersByTime(25_000);
      expect(FakeWS.instances).toHaveLength(2);
    });

    it('M2: a session that cannot be opened (its error: turnId null, no clientRef) answers it too; another session\'s answer does not', () => {
      const { sock, w } = opened({ heartbeat: () => true });
      deliver(w, hello);
      sock.send({ type: 'open_session', sessionId: 's1', cwd: '/w' } as never);
      sock.send({ type: 'open_session', sessionId: 's2', cwd: '/w' } as never);
      deliver(w, { type: 'error', turnId: null, sessionId: 's1', message: 'gone', code: 'not_found' });
      vi.advanceTimersByTime(30_000); // s2 still on its way: the longer deadline
      expect(FakeWS.instances).toHaveLength(1);
      deliver(w, { type: 'error', turnId: null, sessionId: 's2', message: 'gone', code: 'not_found' });
      vi.advanceTimersByTime(25_000);
      expect(FakeWS.instances).toHaveLength(2);
    });

    it('M2: a socket that opened but sends no hello is dropped after 15 s (watched clients); an unwatched one waits', () => {
      const { sock, w } = opened({ heartbeat: () => true });
      vi.advanceTimersByTime(14_000);
      expect(FakeWS.instances).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(FakeWS.instances).toHaveLength(2);
      expect(w.onmessage).toBeNull();
      // its hello in time: no drop
      const next = FakeWS.instances[1]!;
      next.readyState = FakeWS.OPEN;
      next.onopen?.();
      vi.advanceTimersByTime(10_000);
      deliver(next, hello);
      vi.advanceTimersByTime(10_000);
      expect(FakeWS.instances).toHaveLength(2);
      sock.close();
      FakeWS.instances = [];
      createSocket(() => {}, () => {});
      const plain = FakeWS.instances[0]!;
      plain.readyState = FakeWS.OPEN;
      plain.onopen?.();
      vi.advanceTimersByTime(60_000);
      expect(FakeWS.instances).toHaveLength(1);
    });

    it('no watch before hello, and none after the socket closed or close()', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true })));
      const { sock, w } = opened({ heartbeat: () => true, timeoutMs: 1000 });
      vi.advanceTimersByTime(5000);
      expect(FakeWS.instances).toHaveLength(1);
      deliver(w, hello);
      sock.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWS.instances).toHaveLength(1);
    });
  });
});
