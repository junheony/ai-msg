import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';
import { WidgetTokenStore } from './mini/widgetToken';
import { createMiniStatus } from './mini/status';
import { MiniTracker } from './mini/MiniTracker';
import type { MiniStatus } from '../shared/mini-types';

const TOKEN = 'e'.repeat(64);
let base = '';
let server: http.Server;
let dir: string;
let widgetToken: WidgetTokenStore;
const cookie = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-mini-'));
  const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  widgetToken = new WidgetTokenStore(path.join(dir, 'cfg', 'widget-token'));
  const tracker = new MiniTracker();
  tracker.observe({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: path.join(dir, 'work'), account: 'a', model: 'opus', reason: 'r', attempt: 1, prompt: { text: 'hello widget', attachments: [] } });
  const status = createMiniStatus({ tracked: () => tracker.list(), running: () => [{ turnId: 't1', sessionId: 's1', cwd: path.join(dir, 'work') }], usage: () => usage.snapshot(), accounts: testRegistry(), titleOf: () => null, home: dir, hub: { status: async () => ({ host: 'h', generated_at: 'x', modes: [] }) } });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, mini: { status, widgetToken }, hub: { status: { status: async () => ({ host: 'h', generated_at: 'x', modes: [] }) } } }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('GET /api/mini/status', () => {
  it('answers the mini shape to the session cookie, without a path or the login token', async () => {
    const res = await fetch(`${base}/api/mini/status`, { headers: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const body = JSON.parse(text) as MiniStatus;
    expect(body).toMatchObject({ running: 1, waiting: 0, generated_at: expect.any(String) });
    expect(body.sessions[0]).toMatchObject({ title: 'hello widget', state: 'running', model: 'opus' });
    expect(body.seats.map((s) => s.id)).toEqual(['a', 'b', 'c', 'gpt']);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(dir);
  });

  it('is the one route the widget token opens: as a bearer, GET only; the login token is no bearer', async () => {
    expect((await fetch(`${base}/api/mini/status`)).status).toBe(401);
    const wt = await widgetToken.current();
    expect(wt).toMatch(/^[0-9a-f]{64}$/);
    expect(wt).not.toBe(TOKEN);
    expect(((await fs.stat(path.join(dir, 'cfg', 'widget-token'))).mode & 0o777)).toBe(0o600);
    expect((await fetch(`${base}/api/mini/status`, { headers: bearer(wt) })).status).toBe(200);
    expect((await fetch(`${base}/api/mini/status`, { headers: bearer(TOKEN) })).status).toBe(401);
    expect((await fetch(`${base}/api/mini/status`, { headers: bearer('f'.repeat(64)) })).status).toBe(401);
    expect((await fetch(`${base}/api/mini/status`, { headers: { authorization: wt } })).status).toBe(401);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const res = await fetch(`${base}/api/mini/status`, { method, headers: { ...bearer(wt), origin: base } });
      expect(res.status, method).toBe(405);
    }
  });

  it('the widget token is refused on every other route (cookie routes, the hub, the token routes themselves)', async () => {
    const wt = await widgetToken.current();
    for (const p of ['/api/me', '/api/build', '/api/hub/status', '/api/usage', '/api/sessions', '/api/mini/widget-token', '/api/mini', '/api/mini/']) {
      expect((await fetch(`${base}${p}`, { headers: bearer(wt) })).status, p).toBe(401);
    }
    expect((await fetch(`${base}/api/mini/widget-token/rotate`, { method: 'POST', headers: { ...bearer(wt), origin: base } })).status).toBe(401);
    expect((await fetch(`${base}/hub/p/quant/`, { headers: bearer(wt) })).status).toBe(401);
  });
});

describe('widget token routes (session cookie only)', () => {
  it('GET /api/mini/widget-token answers the current token; POST …/rotate makes a new one and the old stops working', async () => {
    expect((await fetch(`${base}/api/mini/widget-token`)).status).toBe(401);
    const before = (await (await fetch(`${base}/api/mini/widget-token`, { headers: cookie })).json()) as { token: string };
    expect(before.token).toBe(await widgetToken.current());
    expect((await fetch(`${base}/api/mini/widget-token/rotate`, { method: 'POST', headers: cookie })).status).toBe(403); // no Origin: CSRF gate
    const res = await fetch(`${base}/api/mini/widget-token/rotate`, { method: 'POST', headers: { ...cookie, origin: base } });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { token: string };
    expect(after.token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.token).not.toBe(before.token);
    expect(after.token).not.toBe(TOKEN);
    expect((await fetch(`${base}/api/mini/status`, { headers: bearer(before.token) })).status).toBe(401);
    expect((await fetch(`${base}/api/mini/status`, { headers: bearer(after.token) })).status).toBe(200);
    expect(((await fs.stat(path.join(dir, 'cfg', 'widget-token'))).mode & 0o777)).toBe(0o600);
    expect((await fs.readFile(path.join(dir, 'cfg', 'widget-token'), 'utf8')).trim()).toBe(after.token);
    expect((await fetch(`${base}/api/mini/widget-token/rotate`, { method: 'GET', headers: cookie })).status).toBe(405);
    expect((await fetch(`${base}/api/mini/widget-token`, { method: 'POST', headers: { ...cookie, origin: base } })).status).toBe(405);
  });
});

describe('/mini page', () => {
  it('GET /mini serves mini.html (no-store) and /mini.webmanifest is revalidated', async () => {
    await fs.writeFile(path.join(dir, 'mini.html'), '<html>mini</html>');
    await fs.writeFile(path.join(dir, 'mini.webmanifest'), '{}');
    await fs.writeFile(path.join(dir, 'index.html'), '<html>deck</html>');
    for (const p of ['/mini', '/mini/']) {
      const res = await fetch(`${base}${p}`, { headers: cookie });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>mini</html>');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    const m = await fetch(`${base}/mini.webmanifest`, { headers: cookie });
    expect(m.status).toBe(200);
    expect(m.headers.get('cache-control')).toBe('no-cache');
    // any other extension-less path is still the React shell
    const other = await fetch(`${base}/minimal`, { headers: cookie });
    expect(await other.text()).toBe('<html>deck</html>');
  });
});
