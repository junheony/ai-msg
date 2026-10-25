import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE, MAX_FRAME } from '../../shared/cloud/frames';
import { RelayClient, type RelayState } from './RelayClient';
import { FakeRelay, waitFor, type FakeRelayOpts } from './testkit';

// Only timeouts, intervals and Date are faked: sockets, setImmediate and nextTick stay real.
const clock = { advance: (ms: number) => vi.advanceTimersByTime(ms) };

let relay: FakeRelay;
let client: RelayClient | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  client?.stop();
  client = null;
  vi.useRealTimers();
  await relay?.close();
});

async function setupClient(o: FakeRelayOpts & { noToken?: boolean } = {}) {
  relay = await FakeRelay.start(o);
  const c = new RelayClient({ url: relay.url, token: () => (o.noToken ? null : relay.token) });
  client = c;
  const states: RelayState[] = [];
  c.on('state', (s: RelayState) => states.push(s));
  return { client: c, relay, clock, states };
}

/** Each retry lands in [base·0.8, base·1.2] (capped): not before 0.79·base, surely by 1.21·base. */
async function expectRetries(r: FakeRelay, states: RelayState[], plan: readonly (readonly [number, number])[]) {
  for (const [n, sec] of plan) {
    clock.advance(sec * 1000 * 0.79);
    expect(r.attempts, `attempt ${n} came early`).toBe(n - 1);
    clock.advance(sec * 1000 * 0.42);
    await r.attempted(n);
    await waitFor(() => states.at(-1) !== 'connecting'); // the client has seen the answer (and armed its next retry)
  }
}

describe('RelayClient', () => {
  it('connects with the Bearer token, goes up on {t:ent,ok}, passes envelopes both ways', async () => {
    const { client, relay, states } = await setupClient();
    const got: Uint8Array[] = [];
    client.on('envelope', (e: Uint8Array) => got.push(e));
    const controls: unknown[] = [];
    client.on('control', (m: unknown) => controls.push(m));
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    expect(states).toEqual(['connecting', 'up']);
    expect(relay.authHeaders).toEqual(['Bearer host-token']);
    expect(client.entitled()?.ok).toBe(true);

    relay.envelope(new Uint8Array([1, 4, 100, 101, 118, 49, 9]));
    await waitFor(() => got.length === 1);
    expect(got[0]).toBeInstanceOf(Uint8Array);
    expect([...got[0]!]).toEqual([1, 4, 100, 101, 118, 49, 9]);

    relay.control({ t: 'peer', dev: 'dev1', up: true });
    relay.control({ t: 'revoked', dev: 'dev2' });
    await waitFor(() => controls.length === 2);
    expect(controls).toEqual([{ t: 'peer', dev: 'dev1', up: true }, { t: 'revoked', dev: 'dev2' }]);

    expect(client.send(new Uint8Array([4, 0]))).toBe(true);
    await waitFor(() => relay.binReceived.length === 1);
    expect([...relay.binReceived[0]!]).toEqual([4, 0]);
  });

  it('no token → unlinked, no request at all', async () => {
    const { client, relay, states } = await setupClient({ noToken: true });
    client.start();
    clock.advance(600_000);
    expect(states).toEqual(['unlinked']);
    expect(relay.attempts).toBe(0);
    expect(client.send(new Uint8Array([1]))).toBe(false);
  });

  it('backs off 1s→2s→4s… capped at 60s with jitter; resets after a good connection', async () => {
    const { client, relay, states } = await setupClient({ upgradeStatus: 503 });
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'down');
    await expectRetries(relay, states, [[2, 1], [3, 2], [4, 4], [5, 8], [6, 16], [7, 32], [8, 60], [9, 60]]);

    relay.upgradeStatus = null; // the next try is accepted
    clock.advance(60_000 * 1.21);
    await relay.attempted(10);
    await waitFor(() => states.at(-1) === 'up');
    // stay attached for 60 s (traffic halfway so the silence watchdog is not what we are testing)
    const controls: unknown[] = [];
    client.on('control', (m: unknown) => controls.push(m));
    clock.advance(30_000);
    relay.control({ t: 'peer', dev: 'd', up: false });
    await waitFor(() => controls.length === 1);
    clock.advance(31_000);
    expect(relay.attempts).toBe(10);

    relay.closeHost(1011);
    await waitFor(() => states.at(-1) === 'down');
    await expectRetries(relay, states, [[11, 1]]); // back to 1 s
  });

  it('ent control flips up ↔ not_entitled without reconnecting (2차 필수 1)', async () => {
    const { client, relay, states } = await setupClient();
    const ents: unknown[] = [];
    client.on('entitlement', (e: unknown) => ents.push(e));
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    relay.control({ t: 'ent', ok: false, until: 0 });
    await waitFor(() => states.at(-1) === 'not_entitled');
    expect(client.entitled()).toEqual({ ok: false, until: 0 });
    const until = Date.now() + 86_400_000;
    relay.control({ t: 'ent', ok: true, until }); // webhook → recheck result
    await waitFor(() => states.at(-1) === 'up');
    expect(relay.attempts).toBe(1); // did not drop and reconnect
    expect(ents.at(-1)).toEqual({ ok: true, until });
    expect(states).toEqual(['connecting', 'up', 'not_entitled', 'up']);
  });

  it('stays connecting until the first ent; ent ok:false on connect → not_entitled, socket kept', async () => {
    const { client, relay, states } = await setupClient({ ent: { ok: false, until: 0 } });
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'not_entitled');
    expect(states).toEqual(['connecting', 'not_entitled']);
    expect(client.send(new Uint8Array([1]))).toBe(true);
    clock.advance(20_000);
    expect(relay.attempts).toBe(1);
  });

  it('402 upgrade or 4402 → not_entitled, retries after 30 s, then 60, 120, 240, 300, 300 (cap 5 min)', async () => {
    const { client, relay, states } = await setupClient({ upgradeStatus: 402 });
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'not_entitled');
    await expectRetries(relay, states, [[2, 30], [3, 60], [4, 120], [5, 240], [6, 300], [7, 300]]);
  });

  it('4402 close → not_entitled and the entitlement backoff; a drop while not entitled stays within 5 min', async () => {
    const { client, relay, states } = await setupClient();
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    relay.ent = { ok: false, until: 0 };
    relay.closeHost(CLOSE.notEntitled);
    await waitFor(() => states.at(-1) === 'not_entitled');
    await expectRetries(relay, states, [[2, 30]]);
    await waitFor(() => states.at(-1) === 'not_entitled'); // attached again, still not entitled

    relay.upgradeStatus = 503;
    relay.closeHost(1011); // dropped while not entitled
    // No state change marks the moment the client sees this drop, so step the clock until the next try.
    await waitFor(() => relay.socket === null);
    let waited = 0;
    while (relay.attempts < 3 && waited < 400) {
      clock.advance(1000);
      waited++;
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    }
    expect(waited).toBeGreaterThanOrEqual(Math.floor(60 * 0.8));
    expect(waited).toBeLessThanOrEqual(Math.ceil(60 * 1.2) + 1);
    await relay.attempted(3);
    await waitFor(() => states.at(-1) !== 'connecting');
    await expectRetries(relay, states, [[4, 120], [5, 240], [6, 300], [7, 300]]);
    expect(states.at(-1)).toBe('not_entitled');
  });

  it('recheck(): sends {"t":"recheck"} when attached; skips the entitlement wait when backing off', async () => {
    const attached = await setupClient({ ent: { ok: false, until: 0 } });
    attached.client.start();
    await attached.relay.attempted(1);
    await waitFor(() => attached.states.at(-1) === 'not_entitled');
    attached.client.recheck();
    await attached.relay.received((t) => t === '{"t":"recheck"}');
    expect(attached.relay.attempts).toBe(1);
    attached.client.stop();
    await attached.relay.close();

    const waiting = await setupClient({ upgradeStatus: 402 });
    waiting.client.start();
    await waiting.relay.attempted(1);
    await waitFor(() => waiting.states.at(-1) === 'not_entitled');
    waiting.relay.upgradeStatus = null;
    waiting.client.recheck(); // no clock movement: connects at once
    await waiting.relay.attempted(2);
    await waitFor(() => waiting.states.at(-1) === 'up');
  });

  it('401 upgrade → unlinked and stops; 4409 → replaced and waits 10 min', async () => {
    const gone = await setupClient({ upgradeStatus: 401 });
    gone.client.start();
    await gone.relay.attempted(1);
    await waitFor(() => gone.states.at(-1) === 'unlinked');
    clock.advance(3_600_000);
    expect(gone.relay.attempts).toBe(1);
    gone.client.stop();
    await gone.relay.close();

    const { client, relay, states } = await setupClient();
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    relay.closeHost(CLOSE.replaced);
    await waitFor(() => states.at(-1) === 'replaced');
    await expectRetries(relay, states, [[2, 600]]); // 10 min ±20 %
    expect(states.at(-1)).toBe('up');
  });

  it('4409 three times in a row → stays replaced, no reconnect until start(); a non-4409 drop resets the count', async () => {
    const { client, relay, states } = await setupClient();
    const replacedOnce = async (n: number) => {
      relay.closeHost(CLOSE.replaced);
      await waitFor(() => states.at(-1) === 'replaced');
      await expectRetries(relay, states, [[n, 600]]);
    };
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    await replacedOnce(2);
    await replacedOnce(3);
    relay.closeHost(1011); // an ordinary drop: the count starts over
    await waitFor(() => states.at(-1) === 'down');
    await expectRetries(relay, states, [[4, 1]]);
    await replacedOnce(5);
    await replacedOnce(6);
    relay.closeHost(CLOSE.replaced); // third in a row since the reset
    await waitFor(() => states.at(-1) === 'replaced');
    clock.advance(3_600_000);
    expect(states.at(-1)).toBe('replaced'); // a reconnect timer would have moved it to 'connecting'
    expect(relay.attempts).toBe(6);
    client.start(); // resumes
    await relay.attempted(7);
    await waitFor(() => states.at(-1) === 'up');
  });

  it('two installs with one token taking turns (each attached > 60 s before the 4409) still stop at the third', async () => {
    const { client, relay, states } = await setupClient();
    let controls = 0;
    client.on('control', () => { controls++; });
    const stayAttached = async () => { // > 60 s with traffic halfway, so the silence watchdog stays quiet
      const before = controls;
      clock.advance(30_000);
      relay.control({ t: 'peer', dev: 'd', up: false });
      await waitFor(() => controls === before + 1);
      clock.advance(31_000);
    };
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    for (const n of [2, 3]) {
      await stayAttached();
      relay.closeHost(CLOSE.replaced);
      await waitFor(() => states.at(-1) === 'replaced');
      await expectRetries(relay, states, [[n, 600]]);
    }
    await stayAttached();
    relay.closeHost(CLOSE.replaced);
    await waitFor(() => states.at(-1) === 'replaced');
    clock.advance(3_600_000);
    expect(states.at(-1)).toBe('replaced'); // a reconnect timer would have moved it to 'connecting'
    expect(relay.attempts).toBe(3);
  });

  it('a server that accepts TCP but never answers the upgrade → handshake timeout, then the retry path', async () => {
    const net = await import('node:net');
    const held: import('node:net').Socket[] = [];
    let conns = 0;
    const srv = net.createServer((sock) => { conns++; held.push(sock); sock.on('error', () => {}); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    relay = await FakeRelay.start(); // only so afterEach has something to close
    const c = new RelayClient({ url: `ws://127.0.0.1:${port}/relay/host`, token: () => 'tok', handshakeTimeoutMs: 100 });
    client = c;
    const states: RelayState[] = [];
    c.on('state', (s: RelayState) => states.push(s));
    try {
      c.start();
      const t0 = performance.now();
      while (states.at(-1) !== 'down' && performance.now() - t0 < 5000) await new Promise((r) => setImmediate(r));
      expect(states).toEqual(['connecting', 'down']);
      expect(conns).toBe(1);
      clock.advance(1210);
      const t1 = performance.now();
      while (conns < 2 && performance.now() - t1 < 5000) await new Promise((r) => setImmediate(r));
      expect(conns).toBe(2);
    } finally {
      c.stop();
      for (const s of held) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('a frame over MAX_FRAME closes the connection and is not delivered', async () => {
    const { client, relay, states } = await setupClient();
    const got: Uint8Array[] = [];
    client.on('envelope', (e: Uint8Array) => got.push(e));
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    relay.envelope(new Uint8Array(MAX_FRAME + 1));
    await waitFor(() => states.at(-1) === 'down');
    expect(got).toEqual([]);
  });

  it('4401 close → unlinked, no reconnect', async () => {
    const { client, relay, states } = await setupClient();
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    relay.closeHost(CLOSE.unauthorized);
    await waitFor(() => states.at(-1) === 'unlinked');
    expect(client.entitled()).toBeNull();
    clock.advance(3_600_000);
    expect(relay.attempts).toBe(1);
  });

  it('pings every 25 s and reconnects after 60 s of silence', async () => {
    const { client, relay, states } = await setupClient({ autoPong: false });
    client.start();
    await relay.attempted(1);
    await waitFor(() => states.at(-1) === 'up');
    const pings = () => relay.textsReceived.filter((t) => t === 'ping').length;
    clock.advance(25_000);
    await waitFor(() => pings() === 1);
    clock.advance(25_000);
    await waitFor(() => pings() === 2);
    clock.advance(9_000);
    expect(relay.attempts).toBe(1);
    clock.advance(1_000); // 60 s since the last thing received
    await waitFor(() => states.at(-1) === 'down');
    await expectRetries(relay, states, [[2, 1]]);
  });

  it('stop() closes the socket and cancels any retry', async () => {
    const { client, relay } = await setupClient({ upgradeStatus: 503 });
    client.start();
    await relay.attempted(1);
    client.stop();
    clock.advance(600_000);
    expect(relay.attempts).toBe(1);
  });
});
