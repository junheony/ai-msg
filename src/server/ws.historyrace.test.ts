import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner, type TurnSink } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

/**
 * A transcript read that finished, then waits (once, for the file named): what a slow read of a big transcript looks
 * like to the turn events that keep coming meanwhile.
 */
const hook = vi.hoisted(() => ({ hold: null as null | { file: string; reached: () => void; until: Promise<void> } }));
vi.mock('./sessions/transcript', async (orig) => {
  const m = await orig<typeof import('./sessions/transcript')>();
  return {
    ...m,
    readTranscript: async (...args: Parameters<typeof m.readTranscript>) => {
      const out = await m.readTranscript(...args);
      const h = hook.hold;
      if (h && args[0].endsWith(h.file)) { hook.hold = null; h.reached(); await h.until; }
      return out;
    },
  };
});

const TOKEN = 'h'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;
let origin = '';
let wsUrl = '';
/** The parked process's sink: the test plays its background continuation through it. */
let parked: { sink: TurnSink; turnId: string; sessionId: string | null; cwd: string } | null = null;
let unpark: () => void = () => {};

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wshr-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wshr-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  // The turn answers, then its process stays open for background work until the test lets it go.
  const run = async (p: Parameters<TurnRunner['run']>[0], sink: TurnSink): Promise<void> => {
    const scope = { turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd };
    sink.emit({ type: 'turn_started', ...scope, account: 'b', model: 'opus', reason: '', attempt: 1 });
    sink.emit({ type: 'turn_result', ...scope, ok: true, text: 'launched', badge: null, errorText: null });
    parked = { sink, ...scope };
    await new Promise<void>((r) => { unpark = r; });
  };
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner: Object.assign(Object.create(runner) as TurnRunner, { run }), index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), outsidePollMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => {
  unpark();
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
      const deadline = Date.now() + 3000;
      for (;;) {
        while (read < got.length) {
          const m = got[read++]!;
          if (m.type === type && pred(m as Extract<ServerMessage, { type: T }>)) return m as Extract<ServerMessage, { type: T }>;
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}; got ${JSON.stringify(got)}`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
      }
    },
  };
  await c.next('hello');
  return c;
}

const texts = (h: Extract<ServerMessage, { type: 'history' }>) => h.messages.flatMap((m) => (m.kind === 'assistant' ? [m.text] : []));

describe('history read while the session streams', () => {
  it('a background continuation that ends during the read is in the history that claims its events', async () => {
    const sid = 'b9b9b9b9-0000-4000-8000-000000000001';
    const cwd = path.join(work, 'race');
    await fs.mkdir(cwd, { recursive: true });
    const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    const line = (o: unknown) => fs.appendFile(file, JSON.stringify(o) + '\n');
    await line({ type: 'user', cwd, message: { role: 'user', content: 'go' } });
    await index.refresh();
    await store.set({ sessionId: sid, cwd, account: 'b', projectDir: dir, lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });

    const a = await client();
    a.send({ type: 'send', sessionId: sid, cwd, text: 'go' });
    const first = await a.next('turn_result');
    await line({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'launched' }] } });
    await vi.waitFor(() => expect(parked).not.toBeNull());

    // Another tab opens the session; its transcript read is slow.
    let reached!: () => void;
    const atHold = new Promise<void>((r) => { reached = r; });
    let go!: () => void;
    hook.hold = { file: `${sid}.jsonl`, reached, until: new Promise<void>((r) => { go = r; }) };
    const b = await client();
    b.send({ type: 'open_session', sessionId: sid });
    await atHold;

    // Meanwhile the background work ends and the process carries on: a whole segment, written to the transcript as it ends.
    const p = parked!;
    const scope = { turnId: `${first.turnId}:bg1`, sessionId: sid, cwd };
    p.sink.emit({ type: 'turn_started', ...scope, account: 'b', model: 'opus', reason: '백그라운드 계속', attempt: 0 });
    p.sink.emit({ type: 'delta', ...scope, text: 'found it' });
    await line({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'found it' }] } });
    p.sink.emit({ type: 'turn_result', ...scope, ok: true, text: 'found it', badge: null, errorText: null });
    const end = await b.next('turn_result', (m) => m.turnId === scope.turnId);
    go();

    // The history comes after those events and says the tab has them (its pos): so it must show them.
    const h = await b.next('history');
    expect(h.pos!.seq).toBeGreaterThanOrEqual((end as { pos?: { seq: number } }).pos!.seq);
    expect(texts(h)).toContain('found it');

    // A fresh open shows it either way (the transcript has it).
    const c = await client();
    c.send({ type: 'open_session', sessionId: sid });
    expect(texts(await c.next('history'))).toContain('found it');
    for (const x of [a, b, c]) x.close();
  });
});
