import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler, UNSUPERVISED_MESSAGE, type ServerUpdateDeps } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'r'.repeat(64);
let base = '';
let server: http.Server;
let dir: string;
let restarts = 0;
let draining = false;
let supervised = true;
const su: ServerUpdateDeps = { check: async () => ({ changedFiles: 3, newestAt: 123 }), supervised: async () => supervised, draining: () => draining, restart: () => { restarts++; draining = true; } };
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
const post = (headers: Record<string, string>) => fetch(`${base}/api/restart`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-restart-'));
  const index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') }), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, serverUpdate: su }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

describe('server update / restart', () => {
  it('GET /api/server-update needs the cookie and answers changed files, supervision and draining', async () => {
    expect((await fetch(`${base}/api/server-update`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/server-update`, { headers: { cookie } })).json()).toEqual({ changedFiles: 3, newestAt: 123, supervised: true, draining: false });
  });

  it('POST /api/restart needs the cookie and our own origin', async () => {
    expect((await post({ origin: base })).status).toBe(401);
    expect((await post({ cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ cookie })).status).toBe(403);
    expect(restarts).toBe(0);
  });

  it('starts the drain once; while draining it is a no-op that answers the state', async () => {
    const r = await post({ cookie, origin: base });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, draining: true });
    expect(restarts).toBe(1);
    const again = await post({ cookie, origin: base });
    expect(await again.json()).toEqual({ ok: true, draining: true });
    expect(restarts).toBe(1);
    draining = false;
  });

  it('unsupervised: refused with a Korean message, nothing started', async () => {
    supervised = false;
    try {
      const r = await post({ cookie, origin: base });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: UNSUPERVISED_MESSAGE });
      expect(UNSUPERVISED_MESSAGE).toMatch(/재시작/);
      expect(restarts).toBe(1);
      expect((await (await fetch(`${base}/api/server-update`, { headers: { cookie } })).json()).supervised).toBe(false);
    } finally { supervised = true; }
  });
});
