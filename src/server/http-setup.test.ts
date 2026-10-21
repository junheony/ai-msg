import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler, type SetupDeps } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { ProfileError } from './setup/profiles';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';
import type { SetupStatus } from '../shared/setup-types';

const TOKEN = 's'.repeat(64);
let base = '';
let server: http.Server;
let dir: string;
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
const status: SetupStatus = { engines: [], claudeProfiles: [], addresses: [], needed: true, supervised: false, restartNeeded: false, accountsFile: false, checkedAt: '2026-10-21T00:00:00.000Z' };
const seen: { force: boolean[]; added: Array<[string, string | undefined]>; done: number } = { force: [], added: [], done: 0 };
const setup: SetupDeps = {
  status: async (force) => { seen.force.push(force === true); return status; },
  addProfile: async (id, label) => {
    if (id === 'b') throw new ProfileError(409, '이미 있는 계정입니다: b');
    seen.added.push([id, label]);
    return { profile: { id, label: label ?? id.toUpperCase(), dir: `~/.claude-${id}`, home: false, active: false, login: 'unknown', loginCommand: `CLAUDE_CONFIG_DIR=~/.claude-${id} claude auth login` }, restartNeeded: true };
  },
  markDone: async () => { seen.done++; },
};
const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-setup-'));
  const index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a') }), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, setup }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

describe('/api/setup', () => {
  it('GET /api/setup requires login', async () => {
    expect((await fetch(`${base}/api/setup`)).status).toBe(401);
    const r = await fetch(`${base}/api/setup`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(status);
    expect(seen.force.at(-1)).toBe(false);
  });

  it('POST /api/setup/refresh forces a probe', async () => {
    const r = await post('/api/setup/refresh', {});
    expect(r.status).toBe(200);
    expect(seen.force.at(-1)).toBe(true);
  });

  it('POST /api/setup/profiles from a foreign Origin is 403', async () => {
    expect((await post('/api/setup/profiles', { id: 'd' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect(seen.added).toEqual([]);
  });

  it('POST /api/setup/profiles adds and answers restartNeeded', async () => {
    const r = await post('/api/setup/profiles', { id: 'd', label: 'Side' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, restartNeeded: true, profile: { id: 'd', label: 'Side' } });
    expect(seen.added).toEqual([['d', 'Side']]);
  });

  it('POST /api/setup/profiles returns the Korean error and status', async () => {
    const r = await post('/api/setup/profiles', { id: 'b' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: '이미 있는 계정입니다: b' });
  });

  it('a malformed body is 400', async () => {
    expect((await post('/api/setup/profiles', { id: 3 })).status).toBe(400);
    expect((await post('/api/setup/profiles', { id: 'e', label: 7 })).status).toBe(400);
  });

  it('POST /api/setup/done marks the wizard done', async () => {
    const r = await post('/api/setup/done', {});
    expect(r.status).toBe(200);
    expect(seen.done).toBe(1);
  });
});
