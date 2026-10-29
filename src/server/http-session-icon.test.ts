import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionIconStore } from './sessions/SessionIconStore';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('POST /api/session-icon', () => {
  let base = '';
  let server: http.Server;
  let bare: http.Server;
  let bareBase = '';
  let icons: SessionIconStore;
  let dir: string;
  let changed = 0;
  const cookie = () => `deck_session=${cookieValueFor(TOKEN)}`;
  const post = (url: string, body: string, headers: Record<string, string> = { cookie: cookie(), origin: base }) =>
    fetch(url, { method: 'POST', headers, body });

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-iconhttp-'));
    const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
    const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
    await index.refresh();
    icons = new SessionIconStore(path.join(dir, 'session-icons.json'), 1);
    await icons.load();
    const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
    const trash = {
      trashSession: async () => ({ ok: true as const, trashId: 't1' }),
      restoreSession: async () => ({ ok: true as const, sessionId: ID }),
    };
    server = http.createServer(createRequestHandler({
      token: TOKEN, uiDir: dir, usage, index, sessionIcons: icons, trash, onIndexChanged: () => { changed++; },
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    bare = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index }));
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    bareBase = `http://127.0.0.1:${(bare.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    bare.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('needs auth and a same-origin Origin, and is absent without the store', async () => {
    const body = JSON.stringify({ sessionId: ID, icon: '🎯' });
    expect((await post(base + '/api/session-icon', body, { origin: base })).status).toBe(401);
    expect((await post(base + '/api/session-icon', body, { cookie: cookie() })).status).toBe(403);
    expect(icons.list()).toEqual({});
    expect((await post(bareBase + '/api/session-icon', body, { cookie: cookie(), origin: bareBase })).status).toBe(404);
  });

  it('rejects a bad id or an icon outside the allow-list', async () => {
    for (const body of ['{bad', JSON.stringify({ sessionId: '../x', icon: '🎯' }), JSON.stringify({ sessionId: ID, icon: 'glyph:nope' }), JSON.stringify({ sessionId: ID, icon: '😀' }), JSON.stringify({ sessionId: ID })]) {
      expect((await post(base + '/api/session-icon', body)).status).toBe(400);
    }
    expect(icons.list()).toEqual({});
  });

  it('sets an emoji or glyph:<name>, persists, notifies, and bootstrap carries the map', async () => {
    const before = changed;
    const r = await post(base + '/api/session-icon', JSON.stringify({ sessionId: ID, icon: '🎯' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sessionIcons: { [ID]: '🎯' } });
    expect(changed).toBe(before + 1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'session-icons.json'), 'utf8'))).toEqual({ [ID]: '🎯' });
    const leaf = await post(base + '/api/session-icon', JSON.stringify({ sessionId: ID, icon: 'glyph:leaf' }));
    expect(await leaf.json()).toEqual({ sessionIcons: { [ID]: 'glyph:leaf' } });
    const boot = (await (await fetch(`${base}/api/bootstrap`, { headers: { cookie: cookie() } })).json()) as { sessionIcons: Record<string, string> };
    expect(boot.sessionIcons).toEqual({ [ID]: 'glyph:leaf' });
    const same = await post(base + '/api/session-icon', JSON.stringify({ sessionId: ID, icon: 'glyph:leaf' }));
    expect(await same.json()).toEqual({ sessionIcons: { [ID]: 'glyph:leaf' } });
    expect(changed).toBe(before + 2); // an unchanged choice is not broadcast
  });

  it('answers 409 at the cap and still clears', async () => {
    const before = changed;
    const full = await post(base + '/api/session-icon', JSON.stringify({ sessionId: ID2, icon: '🐛' }));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toContain('1');
    expect(icons.list()).toEqual({ [ID]: 'glyph:leaf' });
    expect(changed).toBe(before);
    const cleared = await post(base + '/api/session-icon', JSON.stringify({ sessionId: ID, icon: null }));
    expect(await cleared.json()).toEqual({ sessionIcons: {} });
  });

  it('trashing a session clears its icon', async () => {
    await icons.set(ID, '🎯');
    const r = await post(base + '/api/session-trash', JSON.stringify({ sessionId: ID }));
    expect(r.status).toBe(200);
    expect(icons.list()).toEqual({});
  });
});
