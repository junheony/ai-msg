import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { CloudStatus, EntitlementRes } from '../../shared/cloud/api-types';
import type { ServerMessage } from '../../shared/protocol';
import { loadConfig } from '../config';
import { startServer } from '../server';
import { CLOSE } from '../../shared/cloud/envelope';
import { CloudState } from './CloudState';
import { RelayClient, type RelayState } from './RelayClient';
import { FakeRelay, waitFor } from './testkit';

/**
 * The cloud failing never takes the local server with it — on a real `startServer` with a temporary config dir each.
 * Servers are left running (startServer has no stop handle); the test worker ends with the file.
 */

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

async function freePort(): Promise<number> {
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await cond()) return;
  throw new Error('eventually: condition not met');
}

const PLAN: EntitlementRes = { plan: 'pro', st: 'active', untilMs: 4_102_444_800_000, checkedAt: 1_700_000_000_000 };

type Booted = { base: string; cookie: string; cfgDir: string };

/** startServer on a fresh config dir with the cloud pointed at `cloudUrl`/`relayUrl`; `linked` pre-writes a linked cloud state. */
async function boot(o: { cloudUrl: string; relayUrl: string; linked?: boolean }): Promise<Booted> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-faults-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const cfgDir = path.join(root, 'cfg');
  if (o.linked) {
    const st = await CloudState.load(cfgDir);
    await st.update({ hostId: 'host-1', hostToken: 'h'.repeat(43), email: 'a@example.test', plan: PLAN });
  }
  const port = await freePort();
  const keys = ['DECK_CLOUD', 'DECK_CLOUD_URL', 'DECK_RELAY_URL'] as const;
  const saved = keys.map((k) => process.env[k]);
  Object.assign(process.env, { DECK_CLOUD: 'on', DECK_CLOUD_URL: o.cloudUrl, DECK_RELAY_URL: o.relayUrl });
  const cfg = loadConfig({ DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(port), DECK_LOOPBACK_ONLY: '1', PATH: '' }, home, root, () => {});
  try {
    await startServer({ cfg });
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
  const base = `http://127.0.0.1:${port}`;
  const token = (await fsp.readFile(cfg.tokenFile, 'utf8')).trim();
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token }) });
  expect(login.status).toBe(200);
  return { base, cookie: String(login.headers.get('set-cookie')).split(';')[0]!, cfgDir };
}

const get = (b: Booted, p: string) => fetch(`${b.base}${p}`, { headers: { cookie: b.cookie } });
const post = (b: Booted, p: string, body: unknown) => fetch(`${b.base}${p}`, { method: 'POST', headers: { cookie: b.cookie, origin: b.base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = async (b: Booted) => (await (await get(b, '/api/cloud/status')).json()) as CloudStatus;

async function hello(b: Booted): Promise<Extract<ServerMessage, { type: 'hello' }>> {
  const ws = new WebSocket(`${b.base.replace('http', 'ws')}/ws`, { headers: { cookie: b.cookie, origin: b.base } });
  try {
    return await new Promise((resolve, reject) => {
      ws.on('message', (d) => { const m = JSON.parse(String(d)) as ServerMessage; if (m.type === 'hello') resolve(m as Extract<ServerMessage, { type: 'hello' }>); });
      ws.on('error', reject);
    });
  } finally { ws.close(); }
}

const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };

/** Everything local works: /api/me, ws hello, the session list, the local (VAPID) push key and subscription. */
async function localWorks(b: Booted): Promise<void> {
  expect((await get(b, '/api/me')).status).toBe(200);
  expect((await hello(b)).type).toBe('hello');
  const boot = (await (await get(b, '/api/bootstrap')).json()) as { projects: unknown };
  expect(Array.isArray(boot.projects)).toBe(true);
  expect(((await (await get(b, '/api/push/key')).json()) as { publicKey: string }).publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect((await post(b, '/api/push/subscribe', { subscription: SUB })).status).toBe(200);
  expect(((await (await post(b, '/api/push/status', { endpoint: SUB.endpoint })).json()) as { subscribed: boolean }).subscribed).toBe(true);
}

describe('cloud faults on a real server', () => {
  it('cloud address on a closed port, linked: the server comes up and everything local works; relay down, plan kept', async () => {
    const closed = await freePort();
    const b = await boot({ cloudUrl: `http://127.0.0.1:${closed}`, relayUrl: `http://localhost:${closed}`, linked: true });
    await localWorks(b);
    await eventually(async () => (await status(b)).relay === 'down');
    const s = await status(b);
    expect(s.linked).toBe(true);
    expect(s.plan).toEqual(PLAN);
  }, 30_000);

  it('cloud answering 5xx, linked: relay down, the stored plan is still shown, the link is kept, local push unaffected', async () => {
    const hits: string[] = [];
    const sick = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"down","code":"down"}'); });
    sick.on('upgrade', (req, sock) => { hits.push(`WS ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'); });
    sick.listen(0, '127.0.0.1');
    await once(sick, 'listening');
    const port = (sick.address() as AddressInfo).port;
    try {
      const b = await boot({ cloudUrl: `http://127.0.0.1:${port}`, relayUrl: `http://localhost:${port}`, linked: true });
      await eventually(async () => (await status(b)).relay === 'down');
      await eventually(() => hits.some((h) => h.startsWith('WS ')) && hits.some((h) => h.includes('/v1/entitlement')));
      expect(await (await post(b, '/api/cloud/plan/refresh', {})).json()).toEqual(PLAN);
      const s = await status(b);
      expect(s.linked).toBe(true);
      expect(s.plan).toEqual(PLAN);
      await localWorks(b);
      const saved = JSON.parse(await fsp.readFile(path.join(b.cfgDir, 'cloud', 'state.json'), 'utf8')) as { hostToken: string; plan: EntitlementRes };
      expect(saved.hostToken).toBe('h'.repeat(43));
      expect(saved.plan).toEqual(PLAN);
    } finally {
      sick.closeAllConnections();
      sick.close();
    }
  }, 30_000);

  it('an install never linked sends nothing to the cloud (no fetch, no socket), even when asked for the plan', async () => {
    let hits = 0;
    const counter = http.createServer((_req, res) => { hits++; res.writeHead(500); res.end(); });
    counter.on('upgrade', (_req, sock) => { hits++; sock.destroy(); });
    counter.listen(0, '127.0.0.1');
    await once(counter, 'listening');
    const port = (counter.address() as AddressInfo).port;
    const cloudOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const b = await boot({ cloudUrl: cloudOrigins[0]!, relayUrl: cloudOrigins[1]!, linked: false });
      await localWorks(b);
      expect(await status(b)).toMatchObject({ enabled: true, linked: false, relay: 'off', plan: null });
      expect((await post(b, '/api/cloud/plan/refresh', {})).status).toBe(200);
      await sleep(1500);
      const toCloud = spy.mock.calls.filter((c) => cloudOrigins.some((o) => String(c[0] instanceof Request ? c[0].url : c[0]).startsWith(o)));
      expect(toCloud).toEqual([]);
      expect(hits).toBe(0);
    } finally {
      spy.mockRestore();
      counter.close();
    }
  }, 30_000);
});

describe('sleep and wake', () => {
  it('the wall clock jumps 2 h while timers stood still (the Mac slept): the relay socket is redone at once, not after 60 s of silence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const relay = await FakeRelay.start({ autoPong: false });
    const client = new RelayClient({ url: relay.url, token: () => relay.token });
    try {
      const states: RelayState[] = [];
      client.on('state', (s: RelayState) => states.push(s));
      client.start();
      await relay.attempted(1);
      await waitFor(() => states.at(-1) === 'up');
      vi.setSystemTime(Date.now() + 2 * 3_600_000); // asleep: the date moved, no timer ran
      vi.advanceTimersByTime(5_000); // the first few seconds awake
      await relay.attempted(2);
      await waitFor(() => states.at(-1) === 'up');
      expect(states.slice(-2)).toEqual(['connecting', 'up']);
      // Once: the next ticks (awake, no jump) redo nothing.
      vi.advanceTimersByTime(15_000);
      await realPause();
      expect(relay.attempts).toBe(2);
    } finally {
      client.stop();
      vi.useRealTimers();
      await relay.close();
    }
  });

  /** Real time passing (performance is not faked) so a reconnect that would happen has had its chance. */
  const realPause = async (ms = 300) => { for (const end = performance.now() + ms; performance.now() < end;) await new Promise((r) => setImmediate(r)); };
  const sleepFor2h = () => { vi.setSystemTime(Date.now() + 2 * 3_600_000); vi.advanceTimersByTime(5_000); };

  it('waking during an ordinary backoff wait ends the wait at once (and only once)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const relay = await FakeRelay.start({ upgradeStatus: 503 });
    const client = new RelayClient({ url: relay.url, token: () => relay.token, backoff: { minMs: 60_000, maxMs: 60_000 }, random: () => 0.5 });
    try {
      const states: RelayState[] = [];
      client.on('state', (s: RelayState) => states.push(s));
      client.start();
      await relay.attempted(1);
      await waitFor(() => states.at(-1) === 'down');
      sleepFor2h(); // only 5 s of the 60 s wait have run
      await relay.attempted(2);
      await waitFor(() => states.at(-1) === 'down');
      vi.advanceTimersByTime(15_000); // awake ticks, still far inside the new 60 s wait
      await realPause();
      expect(relay.attempts).toBe(2);
    } finally {
      client.stop();
      vi.useRealTimers();
      await relay.close();
    }
  });

  it('waking does not cut the entitlement wait nor the replaced wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const relay = await FakeRelay.start({ upgradeStatus: 402 });
    const client = new RelayClient({ url: relay.url, token: () => relay.token, random: () => 0.5 });
    try {
      const states: RelayState[] = [];
      client.on('state', (s: RelayState) => states.push(s));
      client.start();
      await relay.attempted(1);
      await waitFor(() => states.at(-1) === 'not_entitled');
      sleepFor2h();
      await realPause();
      expect(relay.attempts).toBe(1);

      // Then up, and pushed out by another Mac (4409): the 10-minute wait stays too.
      relay.upgradeStatus = null;
      vi.advanceTimersByTime(300_000); // the entitlement wait's longest
      await relay.attempted(2);
      await waitFor(() => states.at(-1) === 'up');
      relay.closeHost(CLOSE.replaced, 'replaced');
      await waitFor(() => states.at(-1) === 'replaced');
      sleepFor2h();
      await realPause();
      expect(relay.attempts).toBe(2);
      expect(states.at(-1)).toBe('replaced');
    } finally {
      client.stop();
      vi.useRealTimers();
      await relay.close();
    }
  });
});
