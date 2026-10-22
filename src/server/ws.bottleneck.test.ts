import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { fakeClaudeCli } from './engine/claudeCli/fakeClaudeCli';
import { PermissionBridge } from './engine/claudeCli/bridge';
import type { ClaudeSpawnFn } from './engine/claudeCli/spawnTypes';
import { createRequestHandler } from './http';
import { BottleneckWatch } from './push/BottleneckWatch';
import type { PushPayload } from './push/PushNotifier';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore, type ClaudeSessionState } from './turn/SessionState';
import { TurnRunner, type TurnParams, type TurnSink } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket, type WsHandle } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'f'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let wsApi: WsHandle;
let runner: TurnRunner;
let store: SessionStateStore;
let watch: BottleneckWatch;
let wsUrl: string;
let origin: string;
/** The engine's permission bridge. */
let bridge: PermissionBridge;
let close: () => Promise<void>;
const sends: string[] = [];
const pushes: PushPayload[] = [];
/** The watch's timers, fired by hand (`fire`). */
const timers = new Map<number, () => void>();
let seq = 0;
const fire = () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); };

beforeAll(async () => {
  bridge = await PermissionBridge.open();
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsbottle-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const fake = fakeClaudeCli();
  runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ bin: 'claude', spawnFn: fake.spawnFn, bridge, killGraceMs: 50, accounts: testRegistry(), readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  watch = new BottleneckWatch({
    sendPush: (p) => pushes.push(p), titleOf: () => 't', store, retry: (r) => wsApi.submitRetry(r),
    setTimer: (fn) => { const id = ++seq; timers.set(id, fn); return id; }, clearTimer: (t) => { timers.delete(t as number); },
  });
  const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base], notify: (m) => watch.observe(m), onUserSend: (sid) => { sends.push(sid); watch.userSent(sid); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  origin = `http://127.0.0.1:${port}`;
  close = async () => { watch.stop(); wsApi.close(); await new Promise<void>((r) => server.close(() => r())); };
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await close(); await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); await bridge.close(); });

const state = (sessionId: string, over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({ sessionId, cwd: base, account: 'a', projectDir: base, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', ...over });
const startedOf = (p: TurnParams): ServerMessage => ({ type: 'turn_started', turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, account: 'a', model: 'opus', reason: 'r', attempt: 0, engine: 'claude' });
const resultOf = (p: TurnParams, ok = true, errorText: string | null = null): ServerMessage => ({ type: 'turn_result', turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, ok, text: '', badge: null, errorText });
async function connect() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  await new Promise<void>((r) => ws.once('open', () => r()));
  return ws;
}
/** A run that answers and then keeps its process open (background work) until `release`, or until aborted. */
function heldRun() {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  const calls: TurnParams[] = [];
  const run = vi.spyOn(runner, 'run').mockImplementation(async (p: TurnParams, sink: TurnSink) => {
    calls.push(p);
    sink.emit(startedOf(p));
    sink.emit(resultOf(p));
    if (calls.length > 1) return;
    await Promise.race([done, new Promise<void>((r) => sink.signal.addEventListener('abort', () => r()))]);
  });
  return { run, calls, release };
}

describe('ws: 병목 알림 · the user acting', () => {
  it('a send is reported; opening a session is not (a reconnecting tab reopens its sessions)', async () => {
    const S = '71717171-7171-4717-8717-717171717171';
    vi.spyOn(runner, 'run').mockImplementation(async (p, sink) => { sink.emit(startedOf(p)); sink.emit(resultOf(p)); });
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'open_session', sessionId: S }));
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: 'hi' }));
    await vi.waitFor(() => expect(sends).toEqual([S]));
    ws.close();
  });

  it('after a restart (rearm), tabs reconnecting with open_session leave the blocked record and its reminder alone', async () => {
    const S = '72727272-7272-4727-8727-727272727272';
    await store.set(state(S, { blocked: { kind: 'turn_failed', atMs: Date.now() - 60_000, lastPushAtMs: Date.now() - 60_000, n: 0, summary: 'boom' } }));
    watch.rearm([store.get(S)!]);
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'open_session', sessionId: S }));
    await new Promise((r) => setTimeout(r, 100));
    expect(store.get(S)?.blocked).toMatchObject({ n: 0 });
    fire();
    expect(pushes.at(-1)).toMatchObject({ tag: `turn-${S}`, body: '턴이 실패한 채 멈춰 있습니다 · boom' });
    ws.close();
  });
});

describe('ws: submitRetry keeps its hop on every path', () => {
  it('into a process held open for background work (after the foreign-write check): as a follow-up with the hop', async () => {
    const S = '73737373-7373-4737-8737-737373737373';
    const h = heldRun();
    const check = vi.spyOn(runner, 'foreignWrites').mockResolvedValue(false);
    const follow = vi.spyOn(runner, 'followUp').mockReturnValue({ queuedBehind: null });
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'first', hop: 1 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    wsApi.submitRetry({ sessionId: S, cwd: base, text: '이어서 진행해 주세요.', hop: 2 });
    await vi.waitFor(() => expect(follow).toHaveBeenCalledWith(S, expect.objectContaining({ text: '이어서 진행해 주세요.', retryHop: 2 })));
    expect(check).toHaveBeenCalled();
    h.release();
  });

  it('the conversation went on outside deck: the held process is ended and the retry waits for it, then runs with the hop', async () => {
    const S = '74747474-7474-4747-8747-747474747474';
    const h = heldRun();
    vi.spyOn(runner, 'foreignWrites').mockResolvedValue(true);
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'first', hop: 1 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'again', hop: 2 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]).toMatchObject({ sessionId: S, text: 'again', retryHop: 2 });
  });

  it('the process is only closing (no follow-up taken): it is ended (it may only wait for its prompt suggestion), then the retry runs with the hop', async () => {
    const S = '75757575-7575-4757-8757-757575757575';
    const h = heldRun();
    vi.spyOn(runner, 'foreignWrites').mockResolvedValue(false);
    vi.spyOn(runner, 'followUp').mockReturnValue(false);
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'first', hop: 1 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const firstSignal = h.run.mock.calls[0]![1].signal;
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'again', hop: 2 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(firstSignal.aborted).toBe(true);
    expect(h.calls[1]).toMatchObject({ text: 'again', retryHop: 2 });
    h.release();
  });
});

describe('ws: 새 세션으로 이어가기 into a process that only waits for its prompt suggestion', () => {
  it('the held process is ended, then the handoff note runs; no error', async () => {
    const S = '76767676-7676-4767-8767-767676767676';
    const h = heldRun();
    const ws = await connect();
    const got: ServerMessage[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMessage));
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: 'first' }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await vi.waitFor(() => expect(got.some((m) => m.type === 'turn_result')).toBe(true));
    const firstSignal = h.run.mock.calls[0]![1].signal;
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: 'x', handoff: true }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(firstSignal.aborted).toBe(true);
    expect(h.calls[1]).toMatchObject({ sessionId: S, handoff: true });
    expect(got.filter((m) => m.type === 'error')).toEqual([]);
    h.release();
    ws.close();
  });
});

describe('ws: an automatic (commander) turn\'s retry stays gated (보안 #3)', () => {
  it('a new turn carries commanderHop with the hop', async () => {
    const S = '78787878-7878-4787-8787-787878787878';
    const calls: TurnParams[] = [];
    vi.spyOn(runner, 'run').mockImplementation(async (p, sink) => { calls.push(p); sink.emit(startedOf(p)); sink.emit(resultOf(p)); });
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'go', hop: 1, commanderHop: 3 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ sessionId: S, text: 'go', retryHop: 1, commanderHop: 3 });
  });

  it('a busy session refuses it with a log line (no follow-up into a process that may be ungated); a person\'s retry still joins', async () => {
    const S = '79797979-7979-4797-8797-797979797979';
    const h = heldRun();
    vi.spyOn(runner, 'foreignWrites').mockResolvedValue(false);
    const follow = vi.spyOn(runner, 'followUp').mockReturnValue({ queuedBehind: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'first', hop: 1 });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'auto', hop: 2, commanderHop: 2 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^deck: retry deferred — /));
    await new Promise((r) => setTimeout(r, 50));
    expect(follow).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    wsApi.submitRetry({ sessionId: S, cwd: base, text: 'person', hop: 2 });
    await vi.waitFor(() => expect(follow).toHaveBeenCalledWith(S, expect.objectContaining({ text: 'person', retryHop: 2 })));
    expect(follow.mock.calls.every(([, f]) => !('commanderHop' in f))).toBe(true);
    h.release();
  });
});

describe('ws: 자동 재시도 end to end', () => {
  it('a limit failure with a booking → the watch fires it through ws → its turn_started settles the booking and the reminder', async () => {
    const S = '76767676-7676-4767-8767-767676767676';
    await store.set(state(S));
    const calls: TurnParams[] = [];
    vi.spyOn(runner, 'run').mockImplementation(async (p, sink) => {
      calls.push(p);
      sink.emit(startedOf(p));
      if (calls.length === 1) {
        // What the runner does on 대안 계정 없음 (TurnRunner tests): the booking first, then the failed result.
        await store.set({ ...store.get(S)!, pendingRetry: { text: p.text, atMs: Date.now() + 60_000, hops: 1 } });
        sink.emit(resultOf(p, false, '한도 도달 · 대안 계정 없음'));
      } else sink.emit(resultOf(p));
    });
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: '고쳐 줘' }));
    await vi.waitFor(() => expect(store.get(S)?.blocked).toBeDefined());
    expect(store.get(S)?.pendingRetry).toMatchObject({ hops: 1 });
    fire();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ sessionId: S, text: '고쳐 줘', retryHop: 1 });
    await vi.waitFor(() => expect(store.get(S)).not.toHaveProperty('pendingRetry'));
    expect(store.get(S)).not.toHaveProperty('blocked');
    ws.close();
  });

  // Last: drained stays drained.
  it('while draining, a due retry is refused with a log line and its booking is kept for the restart', async () => {
    const S = '77777777-7777-4777-8777-777777777777';
    await store.set(state(S, { pendingRetry: { text: 'go', atMs: Date.now() - 1000, hops: 1 } }));
    const run = vi.spyOn(runner, 'run');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wsApi.drain();
    watch.rearm([store.get(S)!]);
    fire();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^deck: retry deferred — /));
    expect(run).not.toHaveBeenCalled();
    expect(store.get(S)?.pendingRetry).toMatchObject({ text: 'go', hops: 1 });
  });
});
