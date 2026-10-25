import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudService } from './CloudService';
import { CloudState } from './CloudState';
import { FakeDevice, FakeLoopback, FakeRelay, waitFor } from './testkit';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => boolean, ms = 4000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (cond()) return;
  throw new Error('eventually: condition not met');
}

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-cloudsvc-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
  await fs.rm(dir, { recursive: true, force: true });
});

type Call = { method: string; path: string; auth: string | null };
/** The cloud's host API on paper: `routes` maps "METHOD /path" to [status, body]. */
function cloudFetch(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: u.pathname, auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
    const [status, body] = routes[`${method} ${u.pathname}`] ?? [404, { error: 'not_found', code: 'not_found' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function service(o: { relayUrl?: string; fetch?: typeof fetch; port?: number; log?: (s: string) => void }): CloudService {
  const svc = new CloudService({
    cfg: { enabled: true, baseUrl: 'http://127.0.0.1:9', relayUrl: o.relayUrl ?? 'http://127.0.0.1:9' },
    configDir: dir, port: o.port ?? 9, token: () => 'tok', hostVersion: '1.2.3', hostName: 'mac', log: o.log ?? (() => {}), fetch: o.fetch,
  });
  cleanups.push(() => svc.stop());
  return svc;
}

const relayOrigin = (r: FakeRelay) => r.url.replace('ws://', 'http://').replace('/relay/host', '');

async function linkedState(token: string, devices: string[] = []): Promise<CloudState> {
  const st = await CloudState.load(dir);
  await st.update({ hostId: 'host-1', hostToken: token, email: 'a@example.test', devices: devices.map((id) => ({ id, name: 'iPhone', pub: 'AAAA', addedAt: 1 })) });
  return st;
}

describe('CloudService', () => {
  it('not linked: zero requests to the cloud', async () => {
    const calls: string[] = [];
    const svc = service({ fetch: (async (u: string | URL | Request) => { calls.push(String(u)); return new Response('{}'); }) as typeof fetch });
    svc.start();
    await sleep(50);
    expect(calls).toEqual([]);
    expect(svc.status()).toMatchObject({ enabled: true, linked: false, relay: 'off', link: null, devices: [] });
    await expect(fs.stat(path.join(dir, 'cloud'))).rejects.toThrow(); // nothing written either
  });

  it('cloud unreachable while linked: status down, start() never throws', async () => {
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    await linkedState('host-token');
    const logs: string[] = [];
    const svc = service({ relayUrl: `http://127.0.0.1:${port}`, log: (s) => logs.push(s) });
    expect(() => svc.start()).not.toThrow();
    await waitFor(() => svc.status().relay === 'down');
    expect(svc.status()).toMatchObject({ linked: true, email: 'a@example.test' });
    expect(JSON.stringify(svc.status())).not.toContain(String(port));
    expect(logs.join('\n')).not.toContain(String(port));
    expect(logs.join('\n')).not.toContain('host-token');
  });

  it('revokeDevice drops the session before the state file write finishes', async () => {
    const relay = await FakeRelay.start();
    cleanups.push(() => relay.close());
    const loop = await FakeLoopback.start('tok');
    cleanups.push(() => loop.close());
    const state = await linkedState(relay.token);
    const device = await FakeDevice.create(relay);
    await device.trust(state);
    const { fetchImpl } = cloudFetch({ 'GET /v1/devices': [200, [{ id: device.id, name: 'iPhone', pub: 'x', addedAt: 1, lastSeen: null }]], [`POST /v1/devices/${device.id}/revoke`]: [200, { ok: true }] });
    const svc = service({ relayUrl: relayOrigin(relay), port: loop.port, fetch: fetchImpl });
    svc.start();
    await waitFor(() => svc.status().relay === 'up');
    await device.connect(state);
    const s = await device.wsOpen();
    s.send('x');
    await s.next();
    vi.spyOn(CloudState.prototype, 'removeDevice').mockImplementation(() => new Promise<boolean>(() => {})); // the write never finishes
    void svc.revokeDevice(device.id);
    await device.whenClosed();
    await waitFor(() => loop.wsClosed === 1);
    s.send('y');
    await sleep(50);
    expect(loop.wsReceived).toEqual(['x']);
  });

  it('a single upgrade 401 does not forget the link while the API still accepts the token', async () => {
    const relay = await FakeRelay.start({ token: 'other' }); // answers 401 to our token, like a meddling proxy could
    cleanups.push(() => relay.close());
    await linkedState('host-token', ['d1']);
    const { calls, fetchImpl } = cloudFetch({ 'GET /v1/devices': [200, [{ id: 'd1', name: 'iPhone', pub: 'x', addedAt: 1, lastSeen: null }]] });
    const svc = service({ relayUrl: relayOrigin(relay), fetch: fetchImpl });
    svc.start();
    await eventually(() => calls.some((c) => c.path === '/v1/devices'));
    await sleep(50);
    expect(svc.status()).toMatchObject({ linked: true, devices: [{ id: 'd1' }] });
    expect(svc.status().relay).not.toBe('unlinked');
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { hostToken: string | null };
    expect(onDisk.hostToken).toBe('host-token');
  });

  it('upgrade 401 confirmed by the API: the link is forgotten', async () => {
    const relay = await FakeRelay.start({ token: 'other' });
    cleanups.push(() => relay.close());
    await linkedState('host-token', ['d1']);
    const { fetchImpl } = cloudFetch({ 'GET /v1/devices': [401, { error: 'unauthorized', code: 'unauthorized' }] });
    const svc = service({ relayUrl: relayOrigin(relay), fetch: fetchImpl });
    svc.start();
    await eventually(() => !svc.status().linked);
    expect(svc.status()).toMatchObject({ linked: false, email: null, devices: [], relay: 'off' });
    const read = () => JSON.parse(readFileSync(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { hostToken: string | null; hostKey: string };
    await eventually(() => read().hostToken === null); // the reset's write lands just after the in-memory state
    const onDisk = read();
    expect(onDisk.hostKey).toBeTruthy();
  });

  it('refreshPlan: not linked → null with zero cloud requests', async () => {
    const { calls, fetchImpl } = cloudFetch({});
    const svc = service({ fetch: fetchImpl });
    svc.start();
    expect(await svc.refreshPlan()).toBeNull();
    expect(svc.status().plan).toBeNull();
    expect(calls).toEqual([]);
  });

  it('refreshPlan: linked → the plan in the status; a token the cloud refuses forgets the link', async () => {
    const plan = { plan: 'trial', st: 'trialing', untilMs: Date.now() + 86_400_000, checkedAt: Date.now() };
    await linkedState('host-token');
    const routes: Record<string, [number, unknown]> = { 'GET /v1/entitlement': [200, plan] };
    const { calls, fetchImpl } = cloudFetch(routes);
    const logs: string[] = [];
    const svc = service({ relayUrl: 'http://127.0.0.1:9', fetch: fetchImpl, log: (s) => logs.push(s) });
    const seen: unknown[] = [];
    svc.onChange((s) => seen.push(s.plan));
    expect(await svc.refreshPlan()).toEqual(plan);
    expect(svc.status().plan).toEqual(plan);
    expect(seen).toContainEqual(plan);
    expect(calls.find((c) => c.path === '/v1/entitlement')).toMatchObject({ method: 'GET', auth: 'Bearer host-token' });
    routes['GET /v1/entitlement'] = [401, { error: 'unauthorized', code: 'unauthorized' }];
    expect(await svc.refreshPlan()).toBeNull();
    await eventually(() => !svc.status().linked);
    expect(svc.status().plan).toBeNull();
    expect(logs.join('\n')).not.toContain('host-token');
    expect(logs.join('\n')).not.toContain('a@example.test');
  });

  it('a new {t:ent} from the relay fetches the plan again', async () => {
    const relay = await FakeRelay.start();
    cleanups.push(() => relay.close());
    await linkedState(relay.token);
    const plan = { plan: 'pro', st: 'active', untilMs: Date.now() + 86_400_000, checkedAt: Date.now() };
    const { calls, fetchImpl } = cloudFetch({ 'GET /v1/devices': [200, []], 'GET /v1/entitlement': [200, plan] });
    const svc = service({ relayUrl: relayOrigin(relay), fetch: fetchImpl });
    svc.start();
    await waitFor(() => svc.status().relay === 'up');
    await eventually(() => svc.status().plan !== null); // start(): one fetch at once
    await sleep(100); // the first {t:ent} after attach may fetch once more; let it settle
    const before = calls.filter((c) => c.path === '/v1/entitlement').length;
    relay.control({ t: 'ent', ok: true, until: Date.now() + 2 * 86_400_000 });
    await eventually(() => calls.filter((c) => c.path === '/v1/entitlement').length === before + 1);
  });

  it('recheck reaches the relay at most once per 30 s', async () => {
    const relay = await FakeRelay.start();
    cleanups.push(() => relay.close());
    await linkedState(relay.token);
    const { fetchImpl } = cloudFetch({ 'GET /v1/devices': [200, []] });
    const svc = service({ relayUrl: relayOrigin(relay), fetch: fetchImpl });
    svc.start();
    await waitFor(() => svc.status().relay === 'up');
    svc.recheck();
    svc.recheck();
    svc.recheck();
    await relay.received((t) => t === '{"t":"recheck"}');
    await sleep(50);
    expect(relay.textsReceived.filter((t) => t === '{"t":"recheck"}')).toHaveLength(1);
  });

  it('startLink gives the same code while one is in progress; status carries it without the device code', async () => {
    const { calls, fetchImpl } = cloudFetch({
      'POST /v1/host/link/start': [200, { deviceCode: 'secret-device-code', userCode: 'ABCD-EFGH', verifyUrl: 'http://127.0.0.1:9/link?c=ABCD-EFGH', interval: 5, expiresIn: 600 }],
      'POST /v1/host/link/poll': [202, { state: 'pending' }],
    });
    const svc = service({ fetch: fetchImpl });
    svc.start();
    const [a, b] = await Promise.all([svc.startLink(), svc.startLink()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ userCode: 'ABCD-EFGH', verifyUrl: 'http://127.0.0.1:9/link?c=ABCD-EFGH' });
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(await svc.startLink()).toEqual(a);
    expect(calls.filter((c) => c.path === '/v1/host/link/start')).toHaveLength(1);
    expect(svc.status().link).toEqual(a);
    expect(JSON.stringify(svc.status())).not.toContain('secret-device-code');
  });

  it('unlink tells the cloud, stops the relay and forgets the link (host key kept)', async () => {
    const relay = await FakeRelay.start();
    cleanups.push(() => relay.close());
    await linkedState(relay.token, ['d1']);
    const { calls, fetchImpl } = cloudFetch({ 'GET /v1/devices': [200, [{ id: 'd1', name: 'iPhone', pub: 'x', addedAt: 1, lastSeen: null }]], 'POST /v1/host/unlink': [200, { ok: true }] });
    const svc = service({ relayUrl: relayOrigin(relay), fetch: fetchImpl });
    const changes: string[] = [];
    svc.onChange((s) => changes.push(s.relay));
    svc.start();
    await waitFor(() => svc.status().relay === 'up');
    const hostKey = (JSON.parse(await fs.readFile(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { hostKey: string }).hostKey;
    await svc.unlink();
    expect(calls.find((c) => c.path === '/v1/host/unlink')?.auth).toBe(`Bearer ${relay.token}`);
    expect(svc.status()).toMatchObject({ linked: false, relay: 'off', devices: [] });
    expect((JSON.parse(await fs.readFile(path.join(dir, 'cloud', 'state.json'), 'utf8')) as { hostKey: string }).hostKey).toBe(hostKey);
    await waitFor(() => relay.socket === null);
    expect(changes).toContain('up');
    expect(changes.at(-1)).toBe('off');
  });

  it('disabled config: status says so and start() does nothing', async () => {
    const svc = new CloudService({ cfg: { enabled: false, baseUrl: '', relayUrl: '' }, configDir: dir, port: 9, token: () => 'tok', hostVersion: '1.2.3', hostName: 'mac', log: () => {} });
    cleanups.push(() => svc.stop());
    svc.start();
    await sleep(20);
    expect(svc.status()).toMatchObject({ enabled: false, linked: false, relay: 'off' });
    await expect(svc.startLink()).rejects.toThrow();
  });
});
