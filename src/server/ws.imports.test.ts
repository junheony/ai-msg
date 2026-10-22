import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { SessionEntry } from '../shared/session-types';
import { cookieValueFor } from './auth';
import type { EngineEvent } from './engine/Engine';
import type { GeminiTurnRequest } from './engine/GeminiEngine';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { GEMINI_RUNNING_NOTICE } from './sessions/GeminiImports';
import { GROKBOT_READONLY_NOTICE, GROKBOT_SEND_REFUSED } from './sessions/GrokBotImports';
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

// `conv-1`'s simulated "agy is running it" state, read by the gemini import's heldReason — null except while the
// held-notice-suppression tests below flip it on, so the other tests above are unaffected.
let geminiHeldReason: string | null = null;
/** Parks a turn open until a test calls it — holds `t.current` truthy on the ws side without a real agy process. */
let releaseGemini: (() => void) | null = null;
async function* hangingGeminiTurn(req: GeminiTurnRequest): AsyncIterable<EngineEvent> {
  await new Promise<void>((r) => { releaseGemini = r; });
  yield { kind: 'result', sessionId: req.resumeSessionId ?? 'conv-1', ok: true, text: '됐어요', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, errorText: null, stderr: null, errorKind: null, terminalReason: 'completed' };
}

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
    geminiImports: { ...list([{ ...common, sessionId: 'conv-1', account: 'g2', engine: 'gemini', file: geminiDb, title: 'agy 대화' }]), heldReason: async () => geminiHeldReason },
    grokBotImports: list([{ ...common, sessionId: 'grokbot-a', account: 'x1', engine: 'grok', source: 'grokbot', readOnly: true, file: botFile, title: '봇 대화' }]),
  });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => []), gemini: { loggedIn: () => true, engine: { runTurn: hangingGeminiTurn } }, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], {
    token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base], accounts,
    holders: { refresh: async () => false, grokHeldBy: (id) => (id === 'g-held' ? 'other' : null), grokCwdHeld: async () => false },
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
type Err = Extract<ServerMessage, { type: 'error' }>;

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

  it('an agy conversation agy also reports running: the notice shows when deck is not the one running it, but not while deck itself runs its turn', async () => {
    try {
      // Nothing of deck's is running conv-1 yet: agy's own report stands.
      geminiHeldReason = GEMINI_RUNNING_NOTICE;
      const before = await client();
      before.say({ type: 'open_session', sessionId: 'conv-1' });
      expect(await before.until<Notice>((m) => m.type === 'turn_notice' && m.sessionId === 'conv-1')).toMatchObject({ message: GEMINI_RUNNING_NOTICE });
      before.ws.close();

      // deck itself starts a turn on conv-1 (held open by the hanging gemini engine); its own send is not refused by
      // the same report, since TurnRunner's own held gate reads it fresh and agy is about to go quiet again, below.
      geminiHeldReason = null;
      const sender = await client();
      sender.say({ type: 'send', sessionId: 'conv-1', cwd: work, text: '계속' });
      await sender.until((m) => m.type === 'turn_started' && m.sessionId === 'conv-1');

      // ... agy now also reports the conversation running (its own, separate signal) while deck's turn is still open ...
      geminiHeldReason = GEMINI_RUNNING_NOTICE;

      // ... and a second device opening the same session while deck runs it gets no "agy 실행 중" notice: deck running it is not agy running it elsewhere.
      const during = await client();
      during.say({ type: 'open_session', sessionId: 'conv-1' });
      await during.until<History>((m) => m.type === 'history' && m.sessionId === 'conv-1');
      await new Promise((r) => setTimeout(r, 100));
      expect(during.got.some((m) => m.type === 'turn_notice' && m.sessionId === 'conv-1' && m.message === GEMINI_RUNNING_NOTICE)).toBe(false);
      during.ws.close();

      releaseGemini?.();
      await sender.until((m) => m.type === 'turn_result' && m.sessionId === 'conv-1');
      sender.ws.close();
    } finally {
      geminiHeldReason = null;
    }
  });
});

describe('ws: a Grok Bot conversation is never written to', () => {
  const errors = (got: ServerMessage[]) => got.filter((m): m is Err => m.type === 'error');
  const nothingRan = (got: ServerMessage[]) => expect(got.some((m) => m.type === 'turn_started' || m.type === 'turn_result')).toBe(false);

  it('send, its retry (new ref, other model) and a resend of the same ref are all refused; nothing runs', async () => {
    const c = await client();
    c.say({ type: 'send', sessionId: 'grokbot-a', cwd: work, text: '이어서', clientRef: 'gb-1' });
    await c.until((m) => m.type === 'error' && m.message === GROKBOT_SEND_REFUSED);
    c.say({ type: 'send', sessionId: 'grokbot-a', cwd: work, text: '이어서', model: 'grok-4.7', clientRef: 'gb-2' });
    await c.until(() => errors(c.got).length >= 2);
    c.say({ type: 'send', sessionId: 'grokbot-a', cwd: work, text: '이어서', clientRef: 'gb-1' });
    await c.until(() => errors(c.got).length >= 3);
    expect(errors(c.got).map((m) => m.message)).toEqual([GROKBOT_SEND_REFUSED, GROKBOT_SEND_REFUSED, GROKBOT_SEND_REFUSED]);
    await new Promise((r) => setTimeout(r, 50));
    nothingRan(c.got);
    c.ws.close();
  });

  it('복제 (duplicate_session) is refused', async () => {
    const c = await client();
    c.say({ type: 'duplicate_session', sessionId: 'grokbot-a' });
    expect(await c.until<Err>((m) => m.type === 'error')).toMatchObject({ sessionId: 'grokbot-a', message: 'Grok Bot 대화는 복제할 수 없어요 — “새 Grok 세션으로 이어가기”를 쓰세요' });
    c.ws.close();
  });

  it('새 세션으로 이어가기 (handoff) is refused: only Claude conversations hand off', async () => {
    const c = await client();
    c.say({ type: 'send', sessionId: 'grokbot-a', cwd: work, text: 'x', handoff: true, clientRef: 'gb-h' });
    expect(await c.until<Err>((m) => m.type === 'error')).toMatchObject({ message: '이어서 새 세션은 Claude 대화에서만 돼요' });
    await new Promise((r) => setTimeout(r, 50));
    nothingRan(c.got);
    c.ws.close();
  });
});
