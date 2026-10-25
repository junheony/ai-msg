import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieValueFor } from '../auth';
import { EnvKind, decodeEnvelope } from '../../shared/cloud/frames';
import { CloudService } from './CloudService';
import { CloudState } from './CloudState';
import { RelayBridge } from './RelayBridge';
import { RelayClient } from './RelayClient';
import { FakeDevice, FakeLoopback, FakeRelay, waitFor } from './testkit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls `cond` on real time (for waits that span a reconnect backoff). */
async function eventually(cond: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return;
  throw new Error('eventually: condition not met');
}
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A fake of the cloud's host API: `/v1/devices` lists `devices`, revoke fails while `failRevoke`. */
function fakeCloud(devices: string[]) {
  const c = { devices, failRevoke: false, calls: [] as string[] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    c.calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/v1/devices') return json(200, c.devices.map((id) => ({ id, name: 'iPhone', pub: 'x', addedAt: 1, lastSeen: null })));
    const m = /^\/v1\/devices\/([^/]+)\/revoke$/.exec(u.pathname);
    if (m) return c.failRevoke ? json(500, { error: 'boom', code: 'boom' }) : json(200, { ok: true });
    return json(404, { error: 'not_found', code: 'not_found' });
  }) as typeof fetch;
  return { c, fetchImpl };
}

type Setup = { relay: FakeRelay; loop: FakeLoopback; state: CloudState; device: FakeDevice; dir: string; bridge: RelayBridge | null; svc: CloudService | null; cloud: ReturnType<typeof fakeCloud>['c'] };

type BridgeExtra = Partial<Pick<ConstructorParameters<typeof RelayBridge>[0], 'limits' | 'log' | 'settings'>>;

async function setup(o: { withService?: boolean; trusted?: boolean; cloudDevices?: string[]; bridge?: BridgeExtra; buffered?: () => number } = {}): Promise<Setup> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-bridge-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const relay = await FakeRelay.start();
  cleanups.push(() => relay.close());
  const loop = await FakeLoopback.start('tok');
  cleanups.push(() => loop.close());
  const state = await CloudState.load(dir);
  await state.update({ hostId: 'host-1', hostToken: relay.token, email: 'a@example.test' });
  const device = await FakeDevice.create(relay);
  if (o.trusted !== false) await device.trust(state);
  const { c, fetchImpl } = fakeCloud(o.cloudDevices ?? [device.id]);
  if (o.withService) {
    const svc = new CloudService({
      cfg: { enabled: true, baseUrl: 'http://127.0.0.1:9', relayUrl: relay.url.replace('ws://', 'http://').replace('/relay/host', '') },
      configDir: dir, port: loop.port, token: () => 'tok', hostVersion: '1.2.3', hostName: 'mac', log: () => {}, fetch: fetchImpl,
    });
    cleanups.push(() => svc.stop());
    svc.start();
    await waitFor(() => svc.status().relay === 'up');
    return { relay, loop, state, device, dir, bridge: null, svc, cloud: c };
  }
  const client = new RelayClient({ url: relay.url, token: () => relay.token });
  const relayPort = o.buffered
    ? { send: (e: Uint8Array) => client.send(e), on: client.on.bind(client), bufferedAmount: o.buffered }
    : client;
  const bridge = new RelayBridge({ relay: relayPort as RelayClient, state, loopback: { port: loop.port, token: () => 'tok' }, hostVersion: '1.2.3', ...o.bridge });
  cleanups.push(() => { client.stop(); bridge.close(); });
  client.start();
  await new Promise<void>((r) => client.once('state', function on(s) { if (s === 'up') r(); else client.once('state', on); }));
  return { relay, loop, state, device, dir, bridge, svc: null, cloud: c };
}

async function connected(o: Parameters<typeof setup>[0] = {}): Promise<Setup> {
  const s = await setup(o);
  await s.device.connect(s.state);
  return s;
}

describe('RelayBridge', () => {
  it('a trusted device reaches the loopback with the server cookie; the phone never sees it', async () => {
    const { relay, loop, device } = await connected();
    const res = await device.http('GET', '/api/me');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(loop.lastCookie).toBe(`deck_session=${cookieValueFor('tok')}`);
    expect(res.headers['set-cookie']).toBeUndefined();
    const seen = Buffer.concat(relay.binReceived.map((b) => Buffer.from(b))).toString('latin1');
    expect(seen).not.toContain('deck_session'); // the relay only ever sees ciphertext
    expect(seen).not.toContain(cookieValueFor('tok'));
    expect(JSON.stringify(device.framesReceived)).not.toContain(cookieValueFor('tok'));
  });

  it('untrusted device key: no hs_ack', async () => {
    const { relay, loop, device, state } = await setup({ trusted: false });
    void device.connect(state).catch(() => undefined);
    await sleep(150);
    expect(device.hsAcks).toBe(0);
    expect(relay.binReceived).toEqual([]);
    expect(loop.hits).toBe(0);
  });

  it('frames before the device ready are ignored', async () => {
    const { loop, device, state } = await setup();
    await device.connect(state, { sendReady: false });
    void device.http('GET', '/api/me');
    await device.frame({ t: 'ws.open', s: 9 });
    await sleep(150);
    expect(loop.hits).toBe(0);
    expect(loop.sockets).toHaveLength(0);
    expect(device.framesReceived).toEqual([]); // the Mac's ready waits for the device's
    await device.ready();
    expect((await device.http('GET', '/api/me')).status).toBe(200);
  });

  it('no device ready within 5 s: the pending session is dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { loop, device, state } = await setup();
      await device.connect(state, { sendReady: false });
      vi.advanceTimersByTime(5_001);
      await device.frame({ t: 'ready' });
      void device.http('GET', '/api/me');
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      expect(loop.hits).toBe(0);
      expect(device.framesReceived).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a replayed msg1 never displaces the live session', async () => {
    const { relay, loop, device, state } = await setup();
    const { msg1Envelope } = await device.connect(state);
    relay.envelope(msg1Envelope); // the relay replays the old hs_init
    await waitFor(() => device.hsAcks === 2);
    const res = await device.http('GET', '/api/me');
    expect(res.status).toBe(200);
    expect(loop.hits).toBe(1);
  });

  it('a new handshake whose ready opens replaces the old session', async () => {
    const { loop, device, state } = await connected();
    const s = await device.wsOpen();
    s.send('a');
    expect(await s.next()).toBe('echo:a');
    await device.connect(state); // the phone reconnected
    await waitFor(() => loop.wsClosed === 1);
    expect((await device.http('GET', '/api/me')).status).toBe(200);
  });

  it('mac-confirm paths never touch the loopback', async () => {
    const { loop, device } = await connected();
    const r = await device.http('POST', '/api/restart');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'mac_confirm_required' });
    const d = await device.http('GET', '/index.html');
    expect(d.status).toBe(403);
    expect(JSON.parse(d.body)).toEqual({ error: 'forbidden' });
    expect(loop.hits).toBe(0);
  });

  it('ws permission raise is answered with mac_confirm_required and not forwarded', async () => {
    const { loop, device } = await connected();
    const s = await device.wsOpen();
    s.send(JSON.stringify({ type: 'set_permission_mode', sessionId: 's1', mode: 'bypassPermissions' }));
    const back = JSON.parse(await s.next());
    expect(back).toMatchObject({ type: 'error', turnId: null, code: 'mac_confirm_required', sessionId: 's1' });
    expect(typeof back.message).toBe('string');
    expect(loop.wsReceived).toEqual([]);
  });

  it('fragments are put together before the policy looks at them', async () => {
    const { loop, device } = await connected();
    const s = await device.wsOpen();
    const msg = JSON.stringify({ type: 'send', text: 'x'.repeat(10), clientRef: 'c1', sandbox: 'workspace-write' });
    await device.frame({ t: 'ws.msg', s: s.s, d: msg.slice(0, 20), more: true });
    await device.frame({ t: 'ws.msg', s: s.s, d: msg.slice(20) });
    expect(JSON.parse(await s.next())).toMatchObject({ code: 'mac_confirm_required', clientRef: 'c1' });
    await device.frame({ t: 'ws.msg', s: s.s, d: '{"type":', more: true });
    await device.frame({ t: 'ws.msg', s: s.s, d: '"ping"}' });
    expect(await s.next()).toBe('echo:{"type":"ping"}');
    expect(loop.wsReceived).toEqual(['{"type":"ping"}']);
  });

  it('fragments over 1 MiB close the stream', async () => {
    const { loop, device } = await connected();
    const s = await device.wsOpen();
    const piece = 'a'.repeat(30_000);
    for (let i = 0; i < 36; i++) await device.frame({ t: 'ws.msg', s: s.s, d: piece, more: true });
    expect(await s.closed).toBe(1009);
    await waitFor(() => loop.wsClosed === 1);
    expect(loop.wsReceived).toEqual([]);
  });

  it('phone-supplied cookie/origin headers are dropped', async () => {
    const { loop, device } = await connected();
    const r = await device.http('POST', '/api/echo', { h: { cookie: 'deck_session=evil', origin: 'https://evil.test', host: 'evil.test', authorization: 'Bearer x', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: '{"a":1}' });
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.body) as { body: string; headers: Record<string, string> };
    expect(echoed.body).toBe('{"a":1}');
    expect(echoed.headers.cookie).toBe(`deck_session=${cookieValueFor('tok')}`);
    expect(echoed.headers.origin).toBe(`http://127.0.0.1:${loop.port}`);
    expect(echoed.headers.host).toBe(`127.0.0.1:${loop.port}`);
    expect(echoed.headers.authorization).toBeUndefined();
    expect(echoed.headers['x-forwarded-proto']).toBeUndefined();
    expect(echoed.headers['content-type']).toBe('application/json');
  });

  it('ws stream proxied both ways and closed with the session', async () => {
    const { relay, loop, device } = await connected();
    const s = await device.wsOpen();
    s.send('{"type":"hello"}');
    expect(await s.next()).toBe('echo:{"type":"hello"}');
    expect(loop.wsReceived).toEqual(['{"type":"hello"}']);
    loop.sockets[0]!.send('from-server');
    expect(await s.next()).toBe('from-server');
    relay.control({ t: 'peer', dev: device.id, up: false });
    await waitFor(() => loop.wsClosed === 1);
  });

  it('a loopback close reaches the phone as ws.close', async () => {
    const { loop, device } = await connected();
    const s = await device.wsOpen();
    s.send('x');
    await s.next();
    loop.sockets[0]!.close(4000);
    expect(await s.closed).toBe(4000);
  });

  it('large response comes back in 32 KiB chunks', async () => {
    const { device } = await connected();
    const r = await device.http('GET', '/api/big');
    expect(r.status).toBe(200);
    expect(r.frames.map((f) => f.t)).toEqual(['http.res', 'http.chunk', 'http.chunk', 'http.chunk', 'http.chunk']);
    expect(r.frames[0]).toMatchObject({ more: true });
    expect(r.frames.at(-1)).toMatchObject({ more: false });
    expect(r.body.length).toBe(100 * 1024);
    for (const f of r.frames.slice(1, -1)) expect(Buffer.from((f as { b: string }).b, 'base64').length).toBe(32 * 1024);
  });

  it('replayed frame ends the device session', async () => {
    const { relay, loop, device } = await connected();
    const s = await device.wsOpen();
    s.send('x');
    await s.next();
    relay.envelope(device.sent.at(-1)!); // the same ciphertext again
    await waitFor(() => loop.wsClosed === 1);
    s.send('y');
    await sleep(100);
    expect(loop.wsReceived).toEqual(['x']);
  });

  it('control messages of the wrong shape are ignored', async () => {
    const { relay, loop, device, state } = await connected();
    const s = await device.wsOpen();
    for (const m of [{ t: 'revoked', dev: 42 }, { t: 'revoked', dev: 'x'.repeat(65) }, { t: 'revoked' }, { t: 'peer', dev: device.id, up: 'no' }, { t: 'peer', dev: device.id }, { t: 'revoked', dev: `${device.id}\n` }, { t: 'other', dev: device.id }]) relay.control(m);
    s.send('still');
    expect(await s.next()).toBe('echo:still');
    expect(loop.wsClosed).toBe(0);
    expect(state.get().devices.map((d) => d.id)).toEqual([device.id]);
  });

  it('local revoke closes the open channel at once', async () => {
    const { svc, loop, device, state } = await setup({ withService: true });
    await device.connect(state);
    const s = await device.wsOpen();
    s.send('x');
    await s.next();
    const slow = device.http('GET', '/api/slow'); // the loopback holds this request
    const slowFails = expect(slow).rejects.toThrow();
    await waitFor(() => loop.hits === 1);
    await svc!.revokeDevice(device.id);
    await waitFor(() => loop.wsClosed === 1 && loop.aborted === 1);
    await slowFails;
    expect(svc!.status().devices.map((d) => d.id)).not.toContain(device.id);
    expect(device.closedByHost).toBe(true);
    s.send('{"type":"ping"}');
    await sleep(100);
    expect(loop.wsReceived).toEqual(['x']);
  });

  it('cloud revoke notice removes the device locally and closes it', async () => {
    const { relay, state, loop, device } = await connected();
    const s = await device.wsOpen();
    s.send('x');
    await s.next(); // the loopback socket is open
    relay.control({ t: 'revoked', dev: device.id });
    await waitFor(() => loop.wsClosed === 1);
    await waitFor(() => state.get().devices.length === 0);
    expect(state.get().devices.find((d) => d.id === device.id)).toBeUndefined();
    // and it cannot come back with its old key
    void device.connect(state).catch(() => undefined);
    await sleep(150);
    expect(device.hsAcks).toBe(1);
  });

  it('revoke works even when the cloud call fails, and is retried on the next connection', async () => {
    const { svc, relay, device, dir, cloud } = await setup({ withService: true });
    cloud.failRevoke = true;
    await svc!.revokeDevice(device.id);
    expect(svc!.status().devices).toEqual([]);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { pendingRevokes: string[] };
    expect(onDisk.pendingRevokes).toEqual([device.id]);
    cloud.failRevoke = false;
    const before = cloud.calls.filter((c) => c === `POST /v1/devices/${device.id}/revoke`).length;
    relay.closeHost(1011);
    await eventually(() => cloud.calls.filter((c) => c === `POST /v1/devices/${device.id}/revoke`).length > before);
    await eventually(() => (JSON.parse(readFileSync(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { pendingRevokes: string[] }).pendingRevokes.length === 0);
  });

  it('on connect, devices no longer active in the cloud are dropped locally', async () => {
    const { svc } = await setup({ withService: true, cloudDevices: [] });
    await waitFor(() => svc!.status().devices.length === 0);
  });

  it('the close envelope for a revoked device goes to that device only', async () => {
    const { relay, device } = await connected();
    const n = relay.binReceived.length;
    relay.control({ t: 'revoked', dev: device.id });
    await device.whenClosed();
    const sentAfter = relay.binReceived.slice(n).map((b) => decodeEnvelope(b)!);
    expect(sentAfter.map((e) => [e.kind, e.peer])).toEqual([[EnvKind.Close, device.id]]);
  });

  it('x-deck-filename reaches the loopback (attachment uploads)', async () => {
    const { device, loop } = await connected();
    const r = await device.http('POST', '/api/echo', { h: { 'X-Deck-Filename': 'a%20b.png', 'x-evil': '1' }, body: 'x' });
    expect(r.status).toBe(200);
    expect(loop.lastHeaders['x-deck-filename']).toBe('a%20b.png');
    expect(loop.lastHeaders['x-evil']).toBeUndefined();
  });

  it('request bodies in flight are capped per session: the one that crosses gets 413', async () => {
    const { device, loop } = await connected({ bridge: { limits: { sessionBodyBytes: 64 * 1024 } } });
    const kib = (n: number) => Buffer.alloc(n * 1024, 1);
    const a = device.httpChunks('POST', '/api/echo', [kib(30), kib(10)], { end: false }); // held open, 40 KiB
    const b = await device.httpChunks('POST', '/api/echo', [kib(20), kib(10)]); // 70 KiB in flight at its second chunk
    expect(b.status).toBe(413);
    void a.catch(() => undefined);
    // the cap frees with the stream: the session still works
    expect((await device.http('POST', '/api/echo', { body: 'ok' })).status).toBe(200);
    expect(loop.hits).toBe(1);
  });

  it('a request whose last chunk never comes times out with 504 and is dropped', async () => {
    const { device, loop } = await connected({ bridge: { limits: { httpTimeoutMs: 200 } } });
    const r = await device.httpChunks('POST', '/api/echo', [Buffer.from('half')], { end: false });
    expect(r.status).toBe(504);
    expect(loop.hits).toBe(0);
    // a late last chunk for that id does nothing
    await device.frame({ t: 'http.chunk', id: 1, b: '', more: false });
    await sleep(50);
    expect(loop.hits).toBe(0);
  });

  it('the 60 s limit runs until the response starts, then it is an idle limit', async () => {
    const { device } = await connected({ bridge: { limits: { httpTimeoutMs: 250 } } });
    const r = await device.http('GET', '/api/trickle?n=6&gap=100'); // 600 ms in all, never 250 ms quiet
    expect(r.status).toBe(200);
    expect(r.body).toBe('tttttt');
  });

  it('a response that goes quiet past the idle limit is aborted', async () => {
    const { device, loop } = await connected({ bridge: { limits: { httpTimeoutMs: 200 } } });
    await expect(device.http('GET', '/api/stall')).rejects.toThrow('aborted');
    await waitFor(() => loop.aborted === 1);
  });

  it('a response over the size cap is cut off', async () => {
    const { device } = await connected({ bridge: { limits: { responseBytes: 64 * 1024 } } });
    await expect(device.http('GET', '/api/big')).rejects.toThrow('aborted'); // 100 KiB
  });

  it('the response stops reading while the relay socket is backed up', async () => {
    let backed = true;
    const { device } = await connected({ buffered: () => (backed ? 8 << 20 : 0) });
    let done = false;
    const r = device.http('GET', '/api/big').then((x) => { done = true; return x; });
    await sleep(200);
    expect(done).toBe(false);
    expect(device.framesReceived.filter((f) => f.t === 'http.chunk')).toHaveLength(0);
    backed = false;
    expect((await r).body.length).toBe(100 * 1024);
  });

  it('a relay socket that stays backed up past the drain limit cuts the response', async () => {
    const { device } = await connected({ buffered: () => 8 << 20, bridge: { limits: { drainMs: 200 } } });
    await expect(device.http('GET', '/api/big')).rejects.toThrow('aborted');
  });

  it('a body being forwarded still counts toward the session budget until the response starts', async () => {
    const { device, loop } = await connected({ bridge: { limits: { sessionBodyBytes: 64 * 1024 } } });
    const kib = (n: number) => Buffer.alloc(n * 1024, 1);
    const a = device.httpChunks('POST', '/api/slow', [kib(40)]); // complete, but the loopback never answers
    void a.catch(() => undefined);
    await waitFor(() => loop.hits === 1);
    expect((await device.httpChunks('POST', '/api/echo', [kib(30)])).status).toBe(413);
  });

  it('a finished request id is not reused: a late chunk or a repeated http.req is dropped', async () => {
    const { device, loop } = await connected();
    expect((await device.http('POST', '/api/echo', { body: 'one' })).status).toBe(200); // id 1
    await device.frame({ t: 'http.req', id: 1, m: 'POST', p: '/api/echo', h: {}, b: Buffer.from('again').toString('base64'), more: false });
    await device.frame({ t: 'http.chunk', id: 1, b: '', more: false });
    await sleep(100);
    expect(loop.hits).toBe(1);
    expect(device.framesReceived.filter((f) => f.t === 'http.res')).toHaveLength(1);
  });

  it('autoConsent: widening is refused, narrowing goes through (from the Mac settings)', async () => {
    const { device, loop } = await connected({ bridge: { settings: () => ({ autoConsent: ['gemini'] }) } });
    const s = await device.wsOpen();
    s.send(JSON.stringify({ type: 'set_settings', autoConsent: ['gemini', 'grok'] }));
    expect(JSON.parse(await s.next())).toMatchObject({ code: 'mac_confirm_required' });
    s.send(JSON.stringify({ type: 'set_settings', autoConsent: ['gemini'] }));
    expect(await s.next()).toBe('echo:{"type":"set_settings","autoConsent":["gemini"]}');
    expect(loop.wsReceived).toHaveLength(1);
  });

  it('untrusted handshakes are logged a few times a minute at most', async () => {
    const logs: string[] = [];
    const { relay, state } = await setup({ trusted: false, bridge: { log: (l) => logs.push(l) } });
    const device = await FakeDevice.create(relay);
    for (let i = 0; i < 20; i++) void device.connect(state).catch(() => undefined);
    await sleep(300);
    expect(device.hsAcks).toBe(0);
    const n = logs.filter((l) => l.includes('not trusted')).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(5);
  });
});

