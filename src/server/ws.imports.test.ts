import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import { cookieValueFor } from './auth';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { GROKBOT_READONLY_NOTICE } from './sessions/GrokBotImports';
import { GROK_HELD_NOTICE } from './sessions/GrokImports';
import type { ImportIndex } from './sessions/ImportIndex';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'i'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let work: string;
let host: string;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;

const list = (entries: SessionEntry[]): ImportIndex => ({ refresh: async () => {}, list: () => entries, lookup: (id) => entries.find((e) => e.sessionId === id) ?? null, activeAgeMs: async () => null });

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-imports-')));
  work = path.join(base, 'work');
  await fs.mkdir(work);
  const grokFile = path.join(base, 'chat_history.jsonl');
  await fs.writeFile(grokFile, [{ type: 'user', content: [{ type: 'text', text: '<user_query>안녕</user_query>' }] }, { type: 'assistant', content: '반가워요' }].map((l) => JSON.stringify(l)).join('\n'));
  const botFile = path.join(base, 'transcript.blob');
  await fs.writeFile(botFile, '{}');
  const geminiDb = path.join(base, 'conversation_summaries.db');
  await fs.writeFile(geminiDb, '');
  const common = { cwd: work, projectDir: base, lastModified: 1, sizeBytes: 0, imported: true as const };
  const accounts = testRegistry(path.join(base, 'home'));
  const roots = accounts.projectsRoots();
  for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
  const index = new SessionIndex({
    roots, pinnedFile: path.join(base, 'p.json'),
    grokImports: list([{ ...common, sessionId: 'g-1', account: 'x1', engine: 'grok', file: grokFile, title: 'CLI 대화' }, { ...common, sessionId: 'g-held', account: 'x1', engine: 'grok', file: grokFile, title: '잡힌 대화' }]),
    geminiImports: list([{ ...common, sessionId: 'conv-1', account: 'g2', engine: 'gemini', file: geminiDb, title: 'agy 대화' }]),
    grokBotImports: list([{ ...common, sessionId: 'grokbot-a', account: 'x1', engine: 'grok', source: 'grokbot', readOnly: true, file: botFile, title: '봇 대화' }]),
  });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], {
    token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base], accounts,
    holders: { refresh: async () => false, grokHeldBy: (id) => (id === 'g-held' ? 'other' : null), grokCwdHeld: () => false },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { api.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); });

async function client() {
  const ws = new WebSocket(`ws://${host}/ws`, { headers: { Origin: `http://${host}`, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const until = async <T extends ServerMessage>(pred: (m: ServerMessage) => boolean, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = got.find(pred);
      if (hit) return hit as T;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout; got ${JSON.stringify(got)}`);
  };
  const say = (m: ClientMessage) => ws.send(JSON.stringify(m));
  await until((m) => m.type === 'hello');
  return { ws, got, until, say };
}
type History = Extract<ServerMessage, { type: 'history' }>;
type Notice = Extract<ServerMessage, { type: 'turn_notice' }>;

describe('ws: open_session for conversations made outside deck', () => {
  it('a Grok CLI session: its chat_history as history, engine grok', async () => {
    const c = await client();
    c.say({ type: 'open_session', sessionId: 'g-1' });
    const h = await c.until<History>((m) => m.type === 'history' && m.sessionId === 'g-1');
    expect(h).toMatchObject({ engine: 'grok', account: 'x1', cwd: work });
    expect(h.messages.map((m) => [m.kind, 'text' in m ? m.text : ''])).toEqual([['user', '안녕'], ['assistant', '반가워요']]);
    c.ws.close();
  });

  it('a Grok CLI session a terminal grok holds: the held notice', async () => {
    const c = await client();
    c.say({ type: 'open_session', sessionId: 'g-held' });
    await c.until((m) => m.type === 'history' && m.sessionId === 'g-held');
    expect(await c.until<Notice>((m) => m.type === 'turn_notice' && m.sessionId === 'g-held')).toMatchObject({ message: GROK_HELD_NOTICE });
    c.ws.close();
  });

  it('an agy conversation: empty history on its account, engine gemini', async () => {
    const c = await client();
    c.say({ type: 'open_session', sessionId: 'conv-1' });
    expect(await c.until<History>((m) => m.type === 'history' && m.sessionId === 'conv-1')).toMatchObject({ engine: 'gemini', account: 'g2', messages: [] });
    c.ws.close();
  });

  it('a Grok Bot conversation: history plus the read-only notice', async () => {
    const c = await client();
    c.say({ type: 'open_session', sessionId: 'grokbot-a' });
    expect(await c.until<History>((m) => m.type === 'history' && m.sessionId === 'grokbot-a')).toMatchObject({ engine: 'grok', messages: [] });
    expect(await c.until<Notice>((m) => m.type === 'turn_notice' && m.sessionId === 'grokbot-a')).toMatchObject({ message: GROKBOT_READONLY_NOTICE });
    c.ws.close();
  });
});
