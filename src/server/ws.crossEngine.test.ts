import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import type { EngineEvent } from './engine/Engine';
import { StubEngine, failResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner, type TurnRunnerDeps } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

// 다른 AI 로 이어가기 through ws: the pane (and every device showing the session) moves to the new engine's session; sends
// to the old session follow it.

const TOKEN = 'f'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
/** A question 자동 may give Gemini (explain: Gemini is in that cell only). */
const EXPLAIN = '이 함수가 무엇을 하는지 설명해 줘';

let server: http.Server;
let origin = '';
let wsUrl = '';
let wsApi: ReturnType<typeof attachWebSocket>;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let deps: TurnRunnerDeps;

/** An engine turn held until the test lets it finish: init at once, the result on `open()`. */
type Gate = { prompt: string; resume: string | null; open: () => void };
let codexGates: Gate[] = [];
let geminiGates: Gate[] = [];
/** The result each engine turn ends with (by its prompt). */
let codexOk: (prompt: string) => boolean = () => true;
const held = (gates: Gate[], sid: string, prompt: string, resume: string | null, ok: boolean, limit: string): AsyncIterable<EngineEvent> => ({
  async *[Symbol.asyncIterator]() {
    let open = () => {};
    const go = new Promise<void>((r) => { open = r; });
    gates.push({ prompt, resume, open });
    yield { kind: 'init', sessionId: sid, model: 'm' } as EngineEvent;
    await go;
    yield { kind: 'result', sessionId: sid, ok, text: ok ? 'ok' : '', usage: ZERO, errorText: ok ? null : limit, stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null } as EngineEvent;
  },
});

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsx-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsx-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const now = Date.now();
  const resetsAt = new Date(now + 36 * 3_600_000).toISOString();
  const card = (id: string, s: number, w: number) => ({ id, status: 'ok', fetchedAt: new Date(now - 10_000).toISOString(), rows: [{ label: 'Session (5h)', used: s, resetsAt }, { label: 'Weekly (7d)', used: w, resetsAt }, { label: 'Fable (7d)', used: 0, resetsAt }] });
  const cards = [card('claude:main', 13, 7), card('claude:second', 2, 3), card('claude:third', 0, 91), { id: 'codex', status: 'ok', fetchedAt: new Date(now - 10_000).toISOString(), rows: [{ label: 'Weekly (7d)', used: 10 }] }];
  const usage = new UsageService({ mode: 'usage-deck', accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards }) }) });
  await usage.pollOnce();
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  // Every Claude turn hits the limit (same-vendor rotation off: no other Claude account is tried).
  const claude = new StubEngine((req) => [{ kind: 'init', sessionId: req.resumeSessionId ?? 'n-new', model: 'm' }, failResult('usage limit reached', { sessionId: req.resumeSessionId ?? 'n-new' })]);
  deps = {
    accounts: testRegistry(), attachments: null, engine: claude, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codexSessionsRoot: path.join(base, 'codex'),
    sameVendorRotation: () => false, crossEngineFailover: () => true, findRollout: async () => null, readRateLimits: async () => null,
    codex: { runTurn: (req) => held(codexGates, req.resumeThreadId ?? 'tid-x', req.prompt, req.resumeThreadId, codexOk(req.prompt), 'usage limit reached for this week') },
    gemini: { loggedIn: (a) => a === 'g1', engine: { runTurn: (req) => held(geminiGates, req.resumeSessionId ?? 'gem-1', req.prompt, req.resumeSessionId, true, '') } },
    autoRoute: () => ({ autoEngines: ['claude', 'codex', 'gemini', 'grok'], autoConsent: ['gemini'], grokFast: false, crossEngineFailover: true }),
  };
  const runner = new TurnRunner(deps);
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: true, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), activityFile: path.join(base, 'activity.json') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

async function client() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  ws.on('message', (d) => { got.push(JSON.parse(String(d)) as ServerMessage); wake?.(); });
  await new Promise<void>((r) => ws.once('open', () => r()));
  return {
    got,
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
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function seed(sid: string, name: string): Promise<string> {
  const cwd = path.join(work, name);
  await fs.mkdir(cwd, { recursive: true });
  const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seed question' } }) + '\n');
  await index.refresh();
  await store.set({ sessionId: sid, cwd, account: 'b', projectDir: dir, lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });
  return cwd;
}

describe('ws: 다른 AI 로 이어가기', () => {
  it('every device showing the session moves (and one coming back follows); a send to the old session while GPT runs waits, then goes to the GPT session', async () => {
    codexGates = [];
    codexOk = () => true;
    const S = '44444444-4444-4444-8444-444444444444';
    const cwd = await seed(S, 'x1');
    const a = await client();
    const b = await client();
    await a.next('hello');
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    await b.next('history');
    a.send({ type: 'send', sessionId: S, cwd, text: 'hi', clientRef: 'r1' });
    // The sender and the device only viewing the session both get the handover, saying what went over.
    const ha = await a.next('session_handoff');
    const hb = await b.next('session_handoff');
    expect(ha).toMatchObject({ from: S, engine: 'codex', cwd, notice: expect.stringContaining('이전 대화는 요약 발췌만 넘어갑니다') });
    expect(hb).toEqual(ha);
    await waitFor(() => codexGates.length === 1, 'GPT turn');
    expect(codexGates[0]).toMatchObject({ prompt: 'hi', resume: null });
    // The old turn's result is out (the crossing switch): the old session is free, the turn is the new session's.
    await a.next('turn_result', (m) => m.sessionId === S && !m.ok);

    // A device that was away opens the old session: it gets the handover again and follows the new turn.
    const c = await client();
    await c.next('hello');
    c.send({ type: 'open_session', sessionId: S });
    expect(await c.next('session_handoff')).toEqual(ha);

    // A send to the old session while GPT still runs: not refused as busy, it waits for the turn.
    b.send({ type: 'send', sessionId: S, cwd, text: 'later', clientRef: 'r2' });
    await new Promise((r) => setTimeout(r, 100));
    expect(codexGates).toHaveLength(1);
    expect([...a.got, ...b.got].filter((m) => m.type === 'error')).toEqual([]);

    codexGates[0]!.open();
    expect(await c.next('turn_result', (m) => m.turnId === ha.turnId)).toMatchObject({ ok: true, sessionId: 'tid-x' });
    // Released: the send that waited goes to the GPT session (resumed), under its own ref.
    await waitFor(() => codexGates.length === 2, 'the send that waited');
    expect(codexGates[1]).toMatchObject({ prompt: 'later', resume: 'tid-x' });
    expect(await b.next('turn_started', (m) => m.clientRef === 'r2')).toMatchObject({ sessionId: 'tid-x' });
    codexGates[1]!.open();
    await b.next('turn_result', (m) => m.sessionId === 'tid-x' && m.turnId !== ha.turnId);
    expect([...a.got, ...b.got, ...c.got].filter((m) => m.type === 'error')).toEqual([]);
    a.close(); b.close(); c.close();
  });

  it('two handovers (Claude → GPT → Gemini): a send to the first session reaches the last one', async () => {
    codexGates = [];
    geminiGates = [];
    codexOk = (p) => p !== EXPLAIN;
    const S = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(S, 'x2');
    const a = await client();
    await a.next('hello');
    a.send({ type: 'open_session', sessionId: S });
    await a.next('history');
    a.send({ type: 'send', sessionId: S, cwd, text: EXPLAIN, clientRef: 'r1' });
    const first = await a.next('session_handoff', (m) => m.engine === 'codex');
    await waitFor(() => codexGates.length === 1, 'GPT turn');
    codexGates[0]!.open();
    const second = await a.next('session_handoff', (m) => m.engine === 'gemini');
    // Nothing readable of the GPT session (no rollout file here): the notice says so instead of implying a carry-over.
    expect(second).toMatchObject({ from: 'tid-x', fromTurnId: first.turnId, notice: expect.stringContaining('이전 대화를 넘기지 못했습니다') });
    await waitFor(() => geminiGates.length === 1, 'Gemini turn');

    a.send({ type: 'send', sessionId: S, cwd, text: 'and then?', clientRef: 'r2' });
    await new Promise((r) => setTimeout(r, 100));
    geminiGates[0]!.open();
    await waitFor(() => geminiGates.length === 2, 'the send to the first session');
    expect(geminiGates[1]).toMatchObject({ resume: 'gem-1' });
    expect(geminiGates[1]!.prompt).toContain('and then?');
    expect(codexGates).toHaveLength(1);
    geminiGates[1]!.open();
    await a.next('turn_result', (m) => m.sessionId === 'gem-1' && m.turnId !== second.turnId);
    expect(a.got.filter((m) => m.type === 'error')).toEqual([]);
    a.close();
  });
});
