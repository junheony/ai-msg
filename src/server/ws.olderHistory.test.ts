import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { FEATURES, type ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { fileTag } from './historyCursor';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'o'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let work: string;
let index: SessionIndex;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;
let origin = '';
let wsUrl = '';

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsold-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsold-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), outsidePollMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => {
  api.close();
  server.close();
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

async function client() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  ws.on('message', (d) => { got.push(JSON.parse(String(d)) as ServerMessage); wake?.(); });
  await new Promise<void>((r) => ws.once('open', () => r()));
  const c = {
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    async next<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
      const deadline = Date.now() + 5000;
      for (;;) {
        while (read < got.length) {
          const m = got[read++]!;
          if (m.type === type && pred(m as Extract<ServerMessage, { type: T }>)) return m as Extract<ServerMessage, { type: T }>;
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${JSON.stringify(got.slice(-5))}`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
      }
    },
  };
  await c.next('hello');
  return c;
}

/** A Claude session on account b with `n` prompts (one message each: "p0" … "p<n-1>"). */
async function session(sid: string, n: number): Promise<void> {
  const cwd = path.join(work, sid.slice(-4));
  await fs.mkdir(cwd, { recursive: true });
  const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', uuid: `u${i}`, cwd, message: { role: 'user', content: `p${i}` } }));
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
  await index.refresh();
}
const fileOf = (sid: string) => path.join(base, 'b', path.join(work, sid.slice(-4)).replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
/** Session `sid`'s cursor at `n` (kind i): what the server hands out for its transcript. */
const cur = async (sid: string, n: number) => `i${n}.${await fileTag(fileOf(sid))}`;

const texts = (ms: { kind: string; text?: string }[]) => ms.map((m) => m.text);
const LONG = 'b0b0b0b0-0000-4000-8000-000000000001';
const SHORT = 'b0b0b0b0-0000-4000-8000-000000000002';

describe('load_older', () => {
  it('the feature is advertised', () => {
    expect(FEATURES).toContain('olderHistory');
  });

  it('history carries the cursor; pages go back to the start with hasMore, then null', async () => {
    await session(LONG, 450);
    await session(SHORT, 20);
    const c = await client();
    c.send({ type: 'open_session', sessionId: LONG });
    const h = await c.next('history', (m) => m.sessionId === LONG);
    expect(texts(h.messages)).toEqual(Array.from({ length: 200 }, (_, i) => `p${250 + i}`));
    expect(h.older).toBe(await cur(LONG, 250));
    expect(h.at).toBe(h.older);

    c.send({ type: 'load_older', sessionId: LONG, before: h.older, reqId: 'r1' });
    const p1 = await c.next('older_history', (m) => m.reqId === 'r1');
    expect(p1).toMatchObject({ sessionId: LONG, before: await cur(LONG, 250), older: await cur(LONG, 50), at: await cur(LONG, 50) });
    expect(p1.error).toBeUndefined();
    expect(texts(p1.messages)).toEqual(Array.from({ length: 200 }, (_, i) => `p${50 + i}`));

    c.send({ type: 'load_older', sessionId: LONG, before: p1.older, reqId: 'r2' });
    const p2 = await c.next('older_history', (m) => m.reqId === 'r2');
    expect(p2.older).toBeNull();
    expect(p2.at).toBe(await cur(LONG, 0));
    expect(texts(p2.messages)).toEqual(Array.from({ length: 50 }, (_, i) => `p${i}`));

    // A session that fits in one history: null = it is the start.
    c.send({ type: 'open_session', sessionId: SHORT });
    const s = await c.next('history', (m) => m.sessionId === SHORT);
    expect(s.messages).toHaveLength(20);
    expect(s.older).toBeNull();
    expect(s.at).toBe(await cur(SHORT, 0));
    c.close();
  });

  it('bad cursors: malformed, zero, past the end (e.g. another session\'s) → bad_cursor; unknown session → not_found', async () => {
    const c = await client();
    const ask = async (sessionId: string, before: string, reqId: string) => {
      c.send({ type: 'load_older', sessionId, before, reqId });
      return c.next('older_history', (m) => m.reqId === reqId);
    };
    const tag = (await cur(LONG, 0)).slice(3);
    for (const [i, before] of ['x250', 'i', 'i0', 'b10', 'i-3', 'i250', `i0.${tag}`, `b10.${tag}`, 'i250.00000000'].entries()) {
      expect(await ask(LONG, before, `m${i}`)).toMatchObject({ sessionId: LONG, before, messages: [], older: null, error: 'bad_cursor' });
    }
    // LONG's cursor asked of SHORT: the tag is another file's — refused, not read.
    expect(await ask(SHORT, await cur(LONG, 10), 'x1')).toMatchObject({ messages: [], older: null, error: 'bad_cursor' });
    expect(await ask('b0b0b0b0-0000-4000-8000-0000000000ff', await cur(LONG, 10), 'x2')).toMatchObject({ messages: [], older: null, error: 'not_found' });
    c.close();
  });

  it('a page while the transcript grows is unchanged (absolute indexes count from the start)', async () => {
    const c = await client();
    await fs.appendFile(fileOf(LONG), Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'user', uuid: `v${i}`, message: { role: 'user', content: `late${i}` } })).join('\n') + '\n');
    c.send({ type: 'load_older', sessionId: LONG, before: await cur(LONG, 250), reqId: 'g1' });
    const p = await c.next('older_history', (m) => m.reqId === 'g1');
    expect(texts(p.messages)).toEqual(Array.from({ length: 200 }, (_, i) => `p${50 + i}`));
    expect(p.older).toBe(await cur(LONG, 50));
    c.close();
  });

  it('a request without reqId is answered without one; a malformed request is rejected by the schema', async () => {
    const c = await client();
    const before = await cur(LONG, 5);
    c.send({ type: 'load_older', sessionId: LONG, before });
    const p = await c.next('older_history', (m) => m.before === before);
    expect(p.reqId).toBeUndefined();
    expect(texts(p.messages)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(p.older).toBeNull();
    c.send({ type: 'load_older', sessionId: LONG, before: 'i'.repeat(100), reqId: 'too-long' });
    await c.next('error');
    c.close();
  });

  it('open_session.from: the history reaches back to the pane\'s earliest page, not past HISTORY_FROM_MAX; another file\'s cursor is ignored', async () => {
    const c = await client();
    // LONG has 480 messages now (450 + 30 appended above).
    c.send({ type: 'open_session', sessionId: LONG, from: await cur(LONG, 50) });
    const h = await c.next('history', (m) => m.sessionId === LONG);
    expect(texts(h.messages)).toEqual([...Array.from({ length: 400 }, (_, i) => `p${50 + i}`), ...Array.from({ length: 30 }, (_, i) => `late${i}`)]);
    expect(h).toMatchObject({ older: await cur(LONG, 50), at: await cur(LONG, 50) });
    // A cursor inside the default window: the window as is.
    c.send({ type: 'open_session', sessionId: LONG, from: await cur(LONG, 400) });
    expect((await c.next('history', (m) => m.sessionId === LONG)).at).toBe(await cur(LONG, 280));
    // Another file's tag (SHORT's), or a malformed one: the default window.
    for (const from of [await cur(SHORT, 0), 'i50.00000000', 'b50']) {
      c.send({ type: 'open_session', sessionId: LONG, from });
      const d = await c.next('history', (m) => m.sessionId === LONG);
      expect(d.messages).toHaveLength(200);
      expect(d.at).toBe(await cur(LONG, 280));
    }
    // More than HISTORY_FROM_MAX (2000) from the cursor to the end: the default window.
    const HUGE = 'b0b0b0b0-0000-4000-8000-000000000003';
    await session(HUGE, 2300);
    c.send({ type: 'open_session', sessionId: HUGE, from: await cur(HUGE, 200) });
    const big = await c.next('history', (m) => m.sessionId === HUGE);
    expect(big.messages).toHaveLength(200);
    expect(big.at).toBe(await cur(HUGE, 2100));
    c.send({ type: 'open_session', sessionId: HUGE, from: await cur(HUGE, 300) });
    const fits = await c.next('history', (m) => m.sessionId === HUGE);
    expect(fits.messages).toHaveLength(2000);
    expect(fits.at).toBe(await cur(HUGE, 300));
    c.close();
  });
});
