import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { startServer } from '../server';
import { CloudState } from './CloudState';
import { RelayBridge } from './RelayBridge';
import { RelayClient } from './RelayClient';
import { FakeDevice, FakeLoopback, FakeRelay } from './testkit';

/**
 * Recommendation 1 of the security model: a malicious web page is already stopped by the local server — pinned here for
 * `/api/cloud/*` too, on a real `startServer` with a temporary config dir (cloud on, pointed at a closed loopback port,
 * not linked: no cloud request is ever made). The server is left running; the test worker ends with the file.
 * And the phone side: what the tunnel refuses (`mac_confirm_required`) never reaches the loopback.
 */

async function freePort(): Promise<number> {
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };
function raw(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body ?? (method === 'POST' ? '{}' : undefined));
  });
}

describe('local server guards on /api/cloud/*', () => {
  let root: string;
  let port: number;
  let cookie: string;
  let loginSetCookie: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-guards-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    port = await freePort();
    const closed = await freePort();
    Object.assign(process.env, { DECK_CLOUD: 'on', DECK_CLOUD_URL: `http://127.0.0.1:${closed}`, DECK_RELAY_URL: `http://localhost:${closed}` });
    const cfg = loadConfig({ DECK_CONFIG_DIR: path.join(root, 'cfg'), DECK_PORT: String(port), DECK_LOOPBACK_ONLY: '1', PATH: '' }, home, root, () => {});
    try {
      await startServer({ cfg });
    } finally {
      for (const k of ['DECK_CLOUD', 'DECK_CLOUD_URL', 'DECK_RELAY_URL']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    const token = (await fsp.readFile(cfg.tokenFile, 'utf8')).trim();
    const login = await raw(port, 'POST', '/api/login', { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, JSON.stringify({ token }));
    expect(login.status).toBe(200);
    loginSetCookie = String(login.headers['set-cookie'] ?? '');
    cookie = loginSetCookie.split(';')[0]!;
  }, 30_000);
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('a malicious page cannot drive /api/cloud/* on the local server', async () => {
    const self = `http://127.0.0.1:${port}`;
    expect((await raw(port, 'GET', '/api/cloud/status', { cookie })).status).toBe(200);
    // DNS rebinding: the page's own name as Host → 421 before anything else.
    expect((await raw(port, 'GET', '/api/cloud/status', { host: 'evil.test', cookie })).status).toBe(421);
    expect((await raw(port, 'POST', '/api/cloud/link/start', { host: 'evil.test', cookie, origin: 'http://evil.test', 'content-type': 'application/json' })).status).toBe(421);
    for (const p of ['/api/cloud/pair/start', '/api/cloud/link/start', '/api/cloud/devices/x/revoke', '/api/cloud/plan/refresh', '/api/cloud/unlink']) {
      expect((await raw(port, 'POST', p, { cookie, origin: 'https://evil.test', 'content-type': 'application/json' })).status, p).toBe(403);
      expect((await raw(port, 'POST', p, { cookie, 'content-type': 'application/json' })).status, `${p} (no Origin)`).toBe(403);
      expect((await raw(port, 'POST', p, { origin: self, 'content-type': 'application/json' })).status, `${p} (no cookie)`).toBe(401);
    }
    expect((await raw(port, 'GET', '/api/cloud/status', {})).status).toBe(401);
    expect(loginSetCookie).toContain('SameSite=Strict');
    expect(loginSetCookie).toContain('HttpOnly');
  });
});

describe('the tunnel', () => {
  const cleanups: (() => unknown)[] = [];
  afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

  it('the phone cannot approve its own pairing, restart or finish setup through the tunnel', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deck-guards-relay-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const relay = await FakeRelay.start();
    cleanups.push(() => relay.close());
    const loop = await FakeLoopback.start('tok');
    cleanups.push(() => loop.close());
    const state = await CloudState.load(dir);
    await state.update({ hostId: 'host-1', hostToken: relay.token, email: 'a@example.test' });
    const phone = await FakeDevice.create(relay);
    await phone.trust(state);
    const client = new RelayClient({ url: relay.url, token: () => relay.token });
    const bridge = new RelayBridge({ relay: client, state, loopback: { port: loop.port, token: () => 'tok' }, hostVersion: '1.2.3' });
    cleanups.push(() => { client.stop(); bridge.close(); });
    client.start();
    await new Promise<void>((r) => client.once('state', function on(s) { if (s === 'up') r(); else client.once('state', on); }));
    await phone.connect(state);

    for (const [m, p] of [
      ['POST', '/api/cloud/pair/p1/approve'], ['POST', '/api/cloud/pair/start'], ['POST', '/api/cloud/devices/x/revoke'], ['POST', '/api/cloud/unlink'],
      ['POST', '/api/restart'], ['POST', '/api/setup/finish'], ['POST', '/api/login'], ['POST', '/api/logout'],
    ] as const) {
      const r = await phone.http(m, p, { h: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status, p).toBe(403);
      expect((JSON.parse(r.body) as { code?: string }).code, p).toBe('mac_confirm_required');
    }
    expect(loop.hits).toBe(0);
    // The same tunnel still serves what the phone may do.
    expect((await phone.http('GET', '/api/me')).status).toBe(200);
    expect(loop.hits).toBe(1);
  });
});
