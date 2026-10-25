import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { CloudService } from './cloud/CloudService';
import { CloudState } from './cloud/CloudState';
import { SettingsStore } from './settings';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'c'.repeat(64);
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
let dir: string;
let withCloud = '';
let without = '';
const servers: http.Server[] = [];
const sockets: ReturnType<typeof attachWebSocket>[] = [];
let svc: CloudService;
const cloudCalls: string[] = [];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-cloud-'));
  const accounts = testRegistry(path.join(dir, 'acc'));
  const roots = rootsOf({ a: path.join(dir, 'a') });
  const index = new SessionIndex({ roots, pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts, deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const store = new SessionStateStore(path.join(dir, 'state.json'));
  await store.load();
  svc = new CloudService({
    cfg: { enabled: true, baseUrl: 'http://127.0.0.1:9', relayUrl: 'http://127.0.0.1:8' },
    configDir: path.join(dir, 'cfg'), port: 1, token: () => TOKEN, hostVersion: '1.2.3', hostName: 'mac', log: () => {},
    fetch: (async (u: string | URL | Request) => {
      const p = new URL(String(u)).pathname;
      cloudCalls.push(p);
      if (p === '/v1/host/link/start') return new Response(JSON.stringify({ deviceCode: 'dc', userCode: 'WXYZ-1234', verifyUrl: 'http://127.0.0.1:9/link', interval: 5, expiresIn: 600 }), { status: 200 });
      return new Response('{"state":"pending"}', { status: 202 });
    }) as typeof fetch,
  });
  svc.start();
  const start = async (cloud: boolean): Promise<string> => {
    const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => [okResult('s', 'ok')]), usage, index, store, cooldownDir: path.join(dir, 'cd'), protectedAccount: null, auditFile: path.join(dir, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(dir, 'codex'), accounts });
    const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, ...(cloud ? { cloud: { service: svc } } : {}) }));
    sockets.push(attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [dir], accounts, ...(cloud ? { cloud: () => true } : {}) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  withCloud = await start(true);
  without = await start(false);
});
afterAll(async () => {
  await svc.stop();
  for (const s of sockets) s.close();
  for (const s of servers) s.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const post = (base: string, p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, ...headers }, body: '{}' });

function rawStatus(method: string, p: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(withCloud);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

async function helloFeatures(base: string): Promise<string[]> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, origin: base } });
  const hello = await new Promise<ServerMessage>((resolve, reject) => {
    ws.on('message', (d) => { const m = JSON.parse(String(d)) as ServerMessage; if (m.type === 'hello') resolve(m); });
    ws.on('error', reject);
  });
  ws.close();
  return (hello as Extract<ServerMessage, { type: 'hello' }>).features ?? [];
}

describe('/api/cloud', () => {
  it('/api/cloud/* needs the cookie and a same-origin Origin', async () => {
    expect((await fetch(`${withCloud}/api/cloud/status`)).status).toBe(401);
    expect((await post(withCloud, '/api/cloud/unlink', { cookie: '' })).status).toBe(401);
    expect((await post(withCloud, '/api/cloud/link/start', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${withCloud}/api/cloud/devices/d1/revoke`, { method: 'POST', headers: { cookie } })).status).toBe(403); // no Origin at all
    expect(cloudCalls).toEqual([]);
    const r = await fetch(`${withCloud}/api/cloud/status`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ enabled: true, linked: false, relay: 'off', link: null, devices: [] });
  });

  it('a malicious page cannot reach the routes: wrong Origin, wrong Host, no cookie', async () => {
    // A page on another site posting to the Mac (CSRF): the browser sends its own Origin.
    expect((await post(withCloud, '/api/cloud/unlink', { origin: 'http://127.0.0.1.evil.test' })).status).toBe(403);
    expect((await post(withCloud, '/api/cloud/devices/d1/revoke', { origin: 'null' })).status).toBe(403);
    // DNS rebinding: the page's own name in Host (and a matching Origin) is refused before anything else.
    // (fetch replaces a Host header, so these go through node:http.)
    expect(await rawStatus('POST', '/api/cloud/link/start', { cookie, host: 'evil.test', origin: 'http://evil.test', 'content-type': 'application/json' })).toBe(421);
    expect(await rawStatus('GET', '/api/cloud/status', { cookie, host: 'evil.test' })).toBe(421);
    // No cookie (a page that cannot read it): refused even with a good Origin.
    const noCookie = await fetch(`${withCloud}/api/cloud/link/start`, { method: 'POST', headers: { origin: withCloud }, body: '{}' });
    expect(noCookie.status).toBe(401);
    expect((await fetch(`${withCloud}/api/cloud/status`, { headers: { cookie: 'deck_session=forged' } })).status).toBe(401);
    expect(cloudCalls).toEqual([]);
  });

  it('link/start answers the code, the same one while it is in progress', async () => {
    const a = await post(withCloud, '/api/cloud/link/start');
    expect(a.status).toBe(200);
    const body = await a.json() as { userCode: string; verifyUrl: string; expiresAt: number };
    expect(body).toMatchObject({ userCode: 'WXYZ-1234', verifyUrl: 'http://127.0.0.1:9/link' });
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'userCode', 'verifyUrl']);
    expect(await (await post(withCloud, '/api/cloud/link/start')).json()).toEqual(body);
    expect(cloudCalls.filter((p) => p === '/v1/host/link/start')).toHaveLength(1);
  });

  it('revoke takes a well-formed id; unlink answers ok', async () => {
    expect((await post(withCloud, `/api/cloud/devices/${'x'.repeat(65)}/revoke`)).status).toBe(400);
    expect((await post(withCloud, '/api/cloud/devices/%0A/revoke')).status).toBe(400);
    const r = await post(withCloud, '/api/cloud/devices/d1/revoke');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await (await post(withCloud, '/api/cloud/unlink')).json()).toEqual({ ok: true });
    expect((await fetch(`${withCloud}/api/cloud/nope`, { headers: { cookie } })).status).toBe(404);
  });

  it('plan/refresh: cookie and Origin checked; not linked → null with no cloud request', async () => {
    const before = cloudCalls.length;
    expect((await post(withCloud, '/api/cloud/plan/refresh', { cookie: '' })).status).toBe(401);
    expect((await post(withCloud, '/api/cloud/plan/refresh', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${withCloud}/api/cloud/plan/refresh`, { method: 'POST', headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${withCloud}/api/cloud/plan/refresh`, { headers: { cookie } })).status).toBe(404); // GET is not a route
    const r = await post(withCloud, '/api/cloud/plan/refresh');
    expect(r.status).toBe(200);
    expect(await r.json()).toBeNull();
    expect(cloudCalls.slice(before).filter((p) => p === '/v1/entitlement')).toEqual([]);
    expect((await post(without, '/api/cloud/plan/refresh')).status).toBe(404);
  });

  it('the cloud feature is advertised only with the service', async () => {
    expect(await helloFeatures(withCloud)).toContain('cloud');
  });

  it('DECK_CLOUD=off: no routes, no cloud feature', async () => {
    expect((await fetch(`${without}/api/cloud/status`, { headers: { cookie } })).status).toBe(404);
    expect((await post(without, '/api/cloud/link/start')).status).toBe(404);
    expect(await helloFeatures(without)).not.toContain('cloud');
  });
});

describe('the plan is display only (D6)', () => {
  it('with plan none: rotation, routing, 총사령탑, handoff settings and /api routes work as before', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-plan-'));
    const none = { plan: 'none', st: 'none', untilMs: 0, checkedAt: Date.now() } as const;
    const st = await CloudState.load(path.join(d, 'cfg'));
    await st.update({ hostId: 'h1', hostToken: 'host-token', email: 'a@example.test', plan: none });
    const plan = new CloudService({
      cfg: { enabled: true, baseUrl: 'http://127.0.0.1:9', relayUrl: 'http://127.0.0.1:8' },
      configDir: path.join(d, 'cfg'), port: 1, token: () => TOKEN, hostVersion: '1.2.3', hostName: 'mac', log: () => {},
      fetch: (async (u: string | URL | Request) => new URL(String(u)).pathname === '/v1/entitlement'
        ? new Response(JSON.stringify(none), { status: 200 })
        : new Response('[]', { status: 200 })) as typeof fetch,
    });
    const accounts = testRegistry(path.join(d, 'acc'));
    const roots = rootsOf({ a: path.join(d, 'a') });
    const index = new SessionIndex({ roots, pinnedFile: path.join(d, 'p.json') });
    await index.refresh();
    const usage = new UsageService({ accounts, deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    const store = new SessionStateStore(path.join(d, 'state.json'));
    await store.load();
    const settings = new SettingsStore(path.join(d, 'settings.json'));
    await settings.load();
    const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => [okResult('s', 'ok')]), usage, index, store, cooldownDir: path.join(d, 'cd'), protectedAccount: null, auditFile: path.join(d, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(d, 'codex'), accounts });
    const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: d, usage, index, cloud: { service: plan } }));
    const wss = attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store, settings, codexAvailable: false, cwdRoots: [d], accounts, cloud: () => true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await post(base, '/api/cloud/plan/refresh');
      expect(await r.json()).toEqual(none);
      expect((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${base}/api/cloud/status`, { headers: { cookie } })).status).toBe(200);

      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, origin: base } });
      const inbox: ServerMessage[] = [];
      ws.on('message', (m) => inbox.push(JSON.parse(String(m)) as ServerMessage));
      await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'set_settings', sameVendorRotation: true, routingPolicy: 'drain', commanderEnabled: true, crossEngineFailover: true, autoResume: true }));
      const deadline = Date.now() + 3000;
      while (!inbox.some((m) => m.type === 'settings') && Date.now() < deadline) await new Promise((res) => setTimeout(res, 10));
      const got = inbox.find((m) => m.type === 'settings') as Extract<ServerMessage, { type: 'settings' }> | undefined;
      expect(got?.settings).toMatchObject({ sameVendorRotation: true, routingPolicy: 'drain', commanderEnabled: true, crossEngineFailover: true, autoResume: true });
      expect(inbox.filter((m) => m.type === 'error')).toEqual([]);
      ws.close();
    } finally {
      await plan.stop();
      wss.close();
      server.close();
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
