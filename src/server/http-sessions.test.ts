import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { SlashCommandCache } from './engine/slashCommands';
import { FileLister } from './files';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { TranscriptSearch } from './sessions/search';
import { UsageService } from './usage/UsageService';

const TOKEN = 'f'.repeat(64);
const ID1 = '11111111-1111-4111-8111-111111111111';
const cookie = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
let base = '';
let server: http.Server;
let dir: string;
let home: string;
let index: SessionIndex;
let changed = 0;

beforeAll(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-hs-')));
  home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, 'proj', 'src'), { recursive: true });
  await fs.writeFile(path.join(home, 'proj', 'src', 'main.ts'), '');
  const root = path.join(dir, 'b');
  await fs.mkdir(path.join(root, '-w-p'), { recursive: true });
  await fs.writeFile(path.join(root, '-w-p', `${ID1}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/p', message: { role: 'user', content: 'how do I rotate the token' } }) + '\n');
  const meta = new SessionMetaStore(path.join(dir, 'session-meta.json'));
  index = new SessionIndex({ roots: { a: path.join(dir, 'a'), b: root, c: path.join(dir, 'c') }, pinnedFile: path.join(dir, 'p.json'), meta });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const commands = new SlashCommandCache();
  commands.record(ID1, '/w/p', ['compact', 'mine']);
  server = http.createServer(createRequestHandler({
    token: TOKEN, uiDir: dir, usage, index, home, onIndexChanged: () => { changed++; }, meta,
    search: new TranscriptSearch({ sessions: () => index.projects().flatMap((p) => p.sessions) }),
    files: new FileLister({ home, roots: [home] }),
    commands,
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const post = (p: string, body: unknown, headers: Record<string, string> = cookie) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });

describe('session endpoints', () => {
  it('all require the login cookie', async () => {
    for (const p of ['/api/search?q=token', `/api/files?cwd=${encodeURIComponent(home)}`, '/api/commands']) expect((await fetch(`${base}${p}`)).status).toBe(401);
    expect((await post('/api/session-meta', { sessionId: ID1, title: 'x' }, {})).status).toBe(401);
  });

  it('session-meta renames and archives, broadcasts the index, and rejects bad input', async () => {
    const before = changed;
    const r = await post('/api/session-meta', { sessionId: ID1, title: 'Token rotation' });
    expect(r.status).toBe(200);
    expect(index.projects()[0]!.sessions[0]!.title).toBe('Token rotation');
    expect((await post('/api/session-meta', { sessionId: ID1, archived: true })).status).toBe(200);
    expect(index.projects()[0]!.sessions[0]!.archived).toBe(true);
    expect(changed).toBe(before + 2);
    for (const bad of [{ sessionId: '../etc', title: 'x' }, { sessionId: ID1 }, { sessionId: ID1, archived: 'yes' }, { sessionId: ID1, title: 'x'.repeat(201) }]) {
      expect((await post('/api/session-meta', bad)).status).toBe(400);
    }
    // Missing origin on a state change: refused like every other POST.
    const noOrigin = await fetch(`${base}/api/session-meta`, { method: 'POST', headers: { 'content-type': 'application/json', ...cookie }, body: JSON.stringify({ sessionId: ID1, title: 'y' }) });
    expect(noOrigin.status).toBe(403);
  });

  it('search returns hits with the deck title', async () => {
    const r = await fetch(`${base}/api/search?q=${encodeURIComponent('rotate the')}`, { headers: cookie });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hits: { sessionId: string; title: string }[] };
    expect(body.hits.map((h) => h.sessionId)).toEqual([ID1]);
    expect(body.hits[0]!.title).toBe('Token rotation');
    expect((await fetch(`${base}/api/search?q=${'q'.repeat(201)}`, { headers: cookie })).status).toBe(400);
  });

  it('files lists inside home only', async () => {
    const ok = await fetch(`${base}/api/files?cwd=${encodeURIComponent(path.join(home, 'proj'))}`, { headers: cookie });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { files: string[] }).files).toEqual(['src/main.ts']);
    for (const cwd of [dir, '/etc', 'proj', '']) {
      expect((await fetch(`${base}/api/files?cwd=${encodeURIComponent(cwd)}`, { headers: cookie })).status).toBe(400);
    }
  });

  it('commands per session, defaults otherwise', async () => {
    const r = (await (await fetch(`${base}/api/commands?sessionId=${ID1}`, { headers: cookie })).json()) as { commands: { name: string }[] };
    expect(r.commands.map((c) => c.name)).toEqual(['compact', 'mine']);
  });
});
