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
import { createRequestHandler } from './http';
import { BottleneckWatch } from './push/BottleneckWatch';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore, type ClaudeSessionState } from './turn/SessionState';
import { TurnRunner, type TurnParams, type TurnSink } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { SettingsStore } from './settings';
import { attachWebSocket, type WsCommander, type WsHandle } from './ws';
import type { SegmentDigest } from './commander/types';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let wsApi: WsHandle;
let runner: TurnRunner;
let store: SessionStateStore;
let watch: BottleneckWatch;
let wsUrl: string;
let origin: string;
let bridge: PermissionBridge;
let close: () => Promise<void>;
const notified: ServerMessage[] = [];
const userSends: string[] = [];
const idles: { sid: string; digest: SegmentDigest }[] = [];
const cards: string[] = [];
const booked: { sid: string; atMs: number }[] = [];
const cmd = {
  enabled: true,
  active: false,
  status: 'running' as string,
  setCalls: [] as unknown[],
  stopCalls: [] as unknown[],
  disableAllCalls: 0,
  onDisableAll: null as null | (() => void),
  refuse: null as null | { code: 'commander_active'; message: string },
};
const commander: WsCommander = {
  enabled: () => cmd.enabled,
  set: (sid, a) => { cmd.setCalls.push({ sid, ...a }); return cmd.refuse ? { ok: false, ...cmd.refuse } : { ok: true }; },
  stop: (sid, epoch) => { cmd.stopCalls.push({ sid, epoch }); return { ok: true }; },
  disableAll: () => { cmd.disableAllCalls++; cmd.onDisableAll?.(); },
  pause: () => ({ ok: true }),
  resume: () => ({ ok: true }),
  view: () => ({ state: { status: cmd.status as 'running', hop: 1, maxTurns: 20, epoch: 1, goal: 'g', done: 'd', budget: { maxAutoTurns: 20, autoTurnsUsed: 1, maxTokens: 1, tokensUsed: 0, maxWallClockMs: 1, maxInternalRetries: 5, internalRetriesUsed: 0 } } }),
  isActive: () => cmd.active,
  cardAnswered: (sid) => { cards.push(sid); },
  onSessionIdle: (sid, digest) => { idles.push({ sid, digest }); },
  retryBooked: (sid, atMs) => { booked.push({ sid, atMs }); },
};

beforeAll(async () => {
  bridge = await PermissionBridge.open();
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wscmd-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const fake = fakeClaudeCli();
  runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ bin: 'claude', spawnFn: fake.spawnFn, bridge, killGraceMs: 50, accounts: testRegistry(), readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  watch = new BottleneckWatch({ sendPush: () => {}, titleOf: () => 't', store, retry: (r) => wsApi.submitRetry(r), setTimer: () => 0, clearTimer: () => {} });
  const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], {
    accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base],
    notify: (m) => { notified.push(m); watch.observe(m); }, onUserSend: (sid) => { userSends.push(sid); watch.userSent(sid); },
    commander, retryDue: (sid) => watch.retryDue(sid), settings: new SettingsStore(path.join(base, 'settings.json')),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  origin = `http://127.0.0.1:${port}`;
  close = async () => { watch.stop(); wsApi.close(); await new Promise<void>((r) => server.close(() => r())); };
});
afterEach(() => { vi.restoreAllMocks(); cmd.onDisableAll = null; cmd.enabled = true; cmd.active = false; cmd.status = 'running'; cmd.refuse = null; });
afterAll(async () => { await close(); await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); await bridge.close(); });

const state = (sessionId: string, over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({ sessionId, cwd: base, account: 'a', projectDir: base, lastTurnAtMs: null, justCompacted: false, defaultModel: 'opus', ...over });
const startedOf = (p: TurnParams): ServerMessage => ({ type: 'turn_started', turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, account: 'a', model: 'opus', reason: 'r', attempt: 0, engine: 'claude' });
const resultOf = (p: TurnParams, ok = true): ServerMessage => ({ type: 'turn_result', turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, ok, text: '끝', badge: null, errorText: null });
const cmdSend = (sessionId: string, hop: number, sendKey = `1:${hop}`) => ({ kind: 'commander' as const, sessionId, cwd: base, text: `지시 ${hop}`, hop, sendKey, commanderNote: `[deck] note ${hop}` });
async function connect() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  const inbox: ServerMessage[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise<void>((r) => ws.once('open', () => r()));
  return { ws, inbox };
}
/** A run held until `release` (its turn still streaming: no turn_result yet). */
function heldRun(opts: { ask?: boolean; silent?: boolean } = {}) {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  const calls: TurnParams[] = [];
  const run = vi.spyOn(runner, 'run').mockImplementation(async (p: TurnParams, sink: TurnSink) => {
    calls.push(p);
    sink.emit(startedOf(p));
    if (calls.length > 1) { sink.emit(resultOf(p)); return; }
    if (opts.ask) void sink.askPermission({ turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu1' });
    await Promise.race([done, new Promise<void>((r) => sink.signal.addEventListener('abort', () => r()))]);
    if (!opts.silent) sink.emit(resultOf(p));
  });
  return { run, calls, release };
}

describe('ws: commander sends (§6)', () => {
  it('an idle Claude session: a new gated turn with the hop and note, its id marks the result auto; the idle hook gets the segment', async () => {
    const S = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
    await store.set(state(S));
    const calls: TurnParams[] = [];
    vi.spyOn(runner, 'run').mockImplementation(async (p, sink) => {
      calls.push(p);
      sink.emit(startedOf(p));
      sink.emit({ type: 'tool_call', turnId: p.turnId, sessionId: p.sessionId, cwd: p.cwd, toolUseId: 'e1', name: 'Edit', input: { file_path: path.join(base, 'x.ts') } });
      sink.emit(resultOf(p));
    });
    expect(wsApi.submitServerSend(cmdSend(S, 2))).toBe(true);
    await vi.waitFor(() => expect(idles.filter((i) => i.sid === S)).toHaveLength(1));
    expect(calls[0]).toMatchObject({ sessionId: S, text: '지시 2', commanderHop: 2, commanderNote: '[deck] note 2' });
    expect(calls[0]!.turnId).toMatch(/:cmd2$/);
    expect(notified.find((m) => m.type === 'turn_result' && m.sessionId === S)).toMatchObject({ auto: 'commander' });
    const d = idles.find((i) => i.sid === S)!.digest;
    expect(d).toMatchObject({ turns: 1, changedFiles: ['x.ts'] });
    // The same sendKey never starts a second turn.
    expect(wsApi.submitServerSend(cmdSend(S, 2))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('refused synchronously: busy session, booked retry, feature off, no / non-Claude state', async () => {
    const S = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
    await store.set(state(S));
    const h = heldRun();
    expect(wsApi.submitServerSend(cmdSend(S, 1))).toBe(true);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    expect(wsApi.isBusy(S)).toBe(true);
    expect(wsApi.submitServerSend(cmdSend(S, 2))).toBe(false);
    expect(h.calls).toHaveLength(1);
    h.release();
    await vi.waitFor(() => expect(wsApi.isBusy(S)).toBe(false));

    await store.set({ ...store.get(S)!, pendingRetry: { text: 't', atMs: Date.now() + 60_000, hops: 1 } });
    expect(wsApi.isBusy(S)).toBe(true);
    expect(wsApi.submitServerSend(cmdSend(S, 3))).toBe(false);
    const { pendingRetry: _p, ...rest } = store.get(S)!;
    await store.set(rest as ClaudeSessionState);

    cmd.enabled = false;
    expect(wsApi.submitServerSend(cmdSend(S, 4))).toBe(false);
    cmd.enabled = true;
    expect(wsApi.submitServerSend(cmdSend('c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9', 1))).toBe(false);
    const G = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
    await store.set({ sessionId: G, cwd: base, engine: 'codex', defaultModel: 'gpt-5.5', sandbox: 'workspace-write', rolloutFile: null, createdAtMs: 0, lastTurnAtMs: null, justCompacted: false } as never);
    expect(wsApi.submitServerSend(cmdSend(G, 1))).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('a commander retry runs only while the commander is running; otherwise its booking is dropped', async () => {
    const S = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4';
    await store.set(state(S, { pendingRetry: { text: 'x', atMs: Date.now(), hops: 1, commanderHop: 2 } }));
    const run = vi.spyOn(runner, 'run');
    cmd.status = 'paused';
    expect(wsApi.submitServerSend({ kind: 'retry', sessionId: S, cwd: base, text: 'x', hop: 1, commanderHop: 2 })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.get(S)).not.toHaveProperty('pendingRetry'));
  });
});

describe('ws: commander retry bookings', () => {
  it('a dropped commander retry (commander armed again) still ends the segment: the idle hook runs so armed goes on', async () => {
    const S = 'cbcbcbcb-cbcb-4bcb-8bcb-cbcbcbcbcbcb';
    await store.set(state(S, { pendingRetry: { text: 'x', atMs: Date.now(), hops: 1, commanderHop: 2 } }));
    const run = vi.spyOn(runner, 'run');
    cmd.status = 'armed';
    expect(wsApi.submitServerSend({ kind: 'retry', sessionId: S, cwd: base, text: 'x', hop: 1, commanderHop: 2 })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(store.get(S)).not.toHaveProperty('pendingRetry');
    expect(idles.filter((i) => i.sid === S)).toHaveLength(1);
  });

  it('an auto turn that ends with a booked retry tells the commander the retry time (no idle hook)', async () => {
    const S = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    await store.set(state(S));
    const h = heldRun({ silent: true });
    expect(wsApi.submitServerSend(cmdSend(S, 1))).toBe(true);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const atMs = Date.now() + 3 * 3600_000;
    await store.set({ ...store.get(S)!, pendingRetry: { text: '지시 1', atMs, hops: 1, commanderHop: 1 } });
    h.release();
    await vi.waitFor(() => expect(booked).toContainEqual({ sid: S, atMs }));
    expect(idles.filter((i) => i.sid === S)).toHaveLength(0);
  });
});

describe('ws: the person acting during a commander', () => {
  it('■중단 of an auto turn is reported as the user sending (commander pause)', async () => {
    const S = 'cececece-cece-4ece-8ece-cececececece';
    await store.set(state(S));
    const h = heldRun();
    wsApi.submitServerSend(cmdSend(S, 1));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const { ws } = await connect();
    ws.send(JSON.stringify({ type: 'interrupt', turnId: h.calls[0]!.turnId }));
    await vi.waitFor(() => expect(userSends).toContain(S));
    ws.close();
  });

  it('■중단 of the person\'s own turn is not (an armed commander still starts at idle)', async () => {
    const S = 'cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf';
    await store.set(state(S));
    const h = heldRun();
    const { ws } = await connect();
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: '사람' }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const before = userSends.filter((s) => s === S).length;
    ws.send(JSON.stringify({ type: 'interrupt', turnId: h.calls[0]!.turnId }));
    await vi.waitFor(() => expect(idles.some((i) => i.sid === S)).toBe(true));
    expect(userSends.filter((s) => s === S)).toHaveLength(before);
    ws.close();
  });

  it('a steer into the running turn is reported as the user sending (commander pause)', async () => {
    const S = 'c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5';
    await store.set(state(S));
    const h = heldRun();
    vi.spyOn(runner, 'steer').mockResolvedValue(true);
    wsApi.submitServerSend(cmdSend(S, 1));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    const { ws } = await connect();
    ws.send(JSON.stringify({ type: 'steer', turnId: h.calls[0]!.turnId, steerId: 'st1', text: '잠깐' }));
    await vi.waitFor(() => expect(userSends).toContain(S));
    h.release();
    ws.close();
  });

  it('answering a card of the session tells the commander', async () => {
    const S = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6';
    await store.set(state(S));
    const h = heldRun({ ask: true });
    const { ws, inbox } = await connect();
    wsApi.submitServerSend(cmdSend(S, 1));
    await vi.waitFor(() => expect(inbox.some((m) => m.type === 'permission_request')).toBe(true));
    const req = inbox.find((m) => m.type === 'permission_request') as Extract<ServerMessage, { type: 'permission_request' }>;
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'once' }));
    await vi.waitFor(() => expect(cards).toContain(S));
    h.release();
    ws.close();
  });

  it('no 모두 자동 승인 while a commander is active', async () => {
    const S = 'c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7';
    await store.set(state(S));
    cmd.active = true;
    const setMode = vi.spyOn(runner, 'setPermissionMode');
    const { ws, inbox } = await connect();
    ws.send(JSON.stringify({ type: 'set_permission_mode', sessionId: S, mode: 'bypassPermissions' }));
    await vi.waitFor(() => expect(inbox.some((m) => m.type === 'error' && m.code === 'commander_active')).toBe(true));
    expect(setMode).not.toHaveBeenCalled();
    ws.close();
  });
});

describe('ws: commander messages', () => {
  it('commander_set reaches the commander; a refusal comes back with its code; the feature off refuses everything', async () => {
    const S = 'c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c8c8';
    const { ws, inbox } = await connect();
    expect(inbox.find((m) => m.type === 'hello')).toMatchObject({ features: expect.arrayContaining(['commander']) });
    ws.send(JSON.stringify({ type: 'commander_set', sessionId: S, goal: ' 목표 ', done: '완료', maxTurns: 3 }));
    await vi.waitFor(() => expect(cmd.setCalls).toContainEqual({ sid: S, goal: '목표', done: '완료', maxTurns: 3 }));
    cmd.refuse = { code: 'commander_active', message: '이미' };
    ws.send(JSON.stringify({ type: 'commander_set', sessionId: S, goal: 'g', done: 'd' }));
    await vi.waitFor(() => expect(inbox.some((m) => m.type === 'error' && m.code === 'commander_active')).toBe(true));
    cmd.enabled = false;
    ws.send(JSON.stringify({ type: 'commander_set', sessionId: S, goal: 'g', done: 'd' }));
    await vi.waitFor(() => expect(inbox.some((m) => m.type === 'error' && m.code === 'commander_disabled')).toBe(true));
    const off = inbox.find((m) => m.type === 'error' && m.code === 'commander_disabled') as { message: string };
    expect(off.message).toContain('설정에서 총사령탑을 켜');
    expect(off.message).not.toContain('commanderEnabled');
    // ■ 정지 is still heard while off (a commander left from before is never stuck).
    ws.send(JSON.stringify({ type: 'commander_stop', sessionId: S, epoch: 4 }));
    await vi.waitFor(() => expect(cmd.stopCalls).toContainEqual({ sid: S, epoch: 4 }));
    expect(inbox.filter((m) => m.type === 'error' && m.code === 'commander_disabled')).toHaveLength(1);
    const late = await connect();
    expect(late.inbox.find((m) => m.type === 'hello') ?? (await vi.waitFor(() => late.inbox.find((m) => m.type === 'hello')!))).toMatchObject({ features: expect.not.arrayContaining(['commander']) });
    ws.close();
    late.ws.close();
  });
});

describe('ws: turning 총사령탑 off in the settings', () => {
  it('stops every active commander before the settings broadcast; turning it on does not', async () => {
    const { ws, inbox } = await connect();
    await vi.waitFor(() => expect(inbox.some((m) => m.type === 'hello')).toBe(true));
    let settingsSeenAtDisable = -1;
    cmd.onDisableAll = () => { settingsSeenAtDisable = inbox.filter((m) => m.type === 'settings').length; };
    const before = cmd.disableAllCalls;
    ws.send(JSON.stringify({ type: 'set_settings', commanderEnabled: true }));
    await vi.waitFor(() => expect(inbox.filter((m) => m.type === 'settings')).toHaveLength(1));
    expect(cmd.disableAllCalls).toBe(before);
    ws.send(JSON.stringify({ type: 'set_settings', commanderEnabled: false }));
    await vi.waitFor(() => expect(inbox.filter((m) => m.type === 'settings')).toHaveLength(2));
    expect(cmd.disableAllCalls).toBe(before + 1);
    expect(settingsSeenAtDisable).toBe(1);
    ws.close();
  });
});

describe('ws: a retry refused while busy runs once the session is idle', () => {
  it('a due booking is fired at idle instead of waiting for a restart', async () => {
    const S = 'cacacaca-caca-4aca-8aca-cacacacacaca';
    await store.set(state(S));
    // The held turn ends without a result line (a success would settle the booking).
    const h = heldRun({ silent: true });
    const { ws } = await connect();
    ws.send(JSON.stringify({ type: 'send', sessionId: S, cwd: base, text: '사람' }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    // Booked (and already due) while the turn runs: its timer fired into a busy session and was refused.
    await store.set({ ...store.get(S)!, pendingRetry: { text: '재시도', atMs: Date.now() - 1, hops: 1 } });
    h.release();
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1]).toMatchObject({ sessionId: S, text: '재시도', retryHop: 1 });
    ws.close();
  });
});
