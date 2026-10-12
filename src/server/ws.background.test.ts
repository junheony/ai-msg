import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { ClaudeEngine, type QueryFn } from './engine/ClaudeEngine';
import { fakeSdk, sdk } from './engine/fakeSdk';
import { createRequestHandler } from './http';
import { AcceptedRefs } from './sessions/AcceptedRefs';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { DRAINING_MESSAGE, attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let wsApi: ReturnType<typeof attachWebSocket>;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let runner: TurnRunner;
/** Each test installs its own fake CLI process. */
let fake = fakeSdk();
const queryFn: QueryFn = (p) => fake.queryFn(p);

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsbg-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsbg-work-')));
  index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), activityFile: path.join(base, 'activity.json') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

/** A socket that buffers everything from connection time; `next(pred)` waits for the next matching message. */
async function client(url = wsUrl, org = origin) {
  const ws = new WebSocket(url, { headers: { Origin: org, Cookie: COOKIE } });
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

async function seed(sid: string, name: string): Promise<string> {
  const cwd = path.join(work, name);
  await fs.mkdir(cwd, { recursive: true });
  const dir = path.join(base, 'b', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seed' } }) + '\n');
  await index.refresh();
  await store.set({ sessionId: sid, cwd, account: 'b', projectDir: dir, lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });
  return cwd;
}

describe('ws: sessions held open for background work', () => {
  it('a send while waiting becomes a follow-up of the same process; the continuation streams as 백그라운드 계속', async () => {
    const S = '33333333-3333-4333-8333-333333333333';
    const cwd = await seed(S, 'bg1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const base1 = await a.next('turn_started');
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'explore' }]), sdk.result('launched', S));
    expect(await a.next('turn_background')).toMatchObject({ turnId: base1.turnId, tasks: ['explore'] });
    await a.next('turn_result', (m) => m.turnId === base1.turnId);
    // What restart.sh reads: the session's live background work, written a moment after it changed.
    const activity = async () => JSON.parse(await fs.readFile(path.join(base, 'activity.json'), 'utf8')) as { pid: number; updatedAt: string; sessions: unknown[] };
    await vi.waitFor(async () => expect((await activity()).sessions).toEqual([{ sessionId: S, cwd, running: false, bg: 1, tasks: ['explore'] }]), { timeout: 2000 });
    expect(await activity()).toMatchObject({ pid: process.pid, updatedAt: expect.any(String) });

    // A second tab opening the session sees the pending work, but no running turn.
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    expect(await b.next('history')).toMatchObject({ runningTurnId: null });
    expect(await b.next('turn_background')).toMatchObject({ tasks: ['explore'] });

    b.send({ type: 'send', sessionId: S, cwd, text: 'status?', clientRef: 'ref-1' });
    const fu = await b.next('turn_started', (m) => m.clientRef === 'ref-1');
    expect(fu.turnId).not.toBe(base1.turnId);
    expect(fu.reason).toBe('백그라운드 대기 중 이어 보냄');
    fake.push(sdk.delta('still going'), sdk.result('still going', S));
    expect(await a.next('turn_result', (m) => m.turnId === fu.turnId)).toMatchObject({ ok: true, text: 'still going' });
    expect(fake.state.calls).toBe(1);

    fake.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('found'), sdk.result('found', S));
    await a.next('turn_background', (m) => m.tasks.length === 0);
    const cont = await a.next('turn_started', (m) => m.reason === '백그라운드 계속');
    expect(await a.next('turn_result', (m) => m.turnId === cont.turnId)).toMatchObject({ ok: true, text: 'found' });

    // The process ended → the session is free again: a new send starts a new process.
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    fake = fakeSdk();
    fake.push(sdk.init(S), sdk.result('fresh', S));
    a.send({ type: 'send', sessionId: S, cwd, text: 'again' });
    expect(await a.next('turn_result', (m) => m.text === 'fresh')).toMatchObject({ ok: true });
    a.close();
    b.close();
  });

  it('steer: refused with no running turn; into a running turn it reaches every viewer as steer_delivered with its prompt', async () => {
    const S = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(S, 'steer1');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'steer', turnId: 'no-such-turn', steerId: 'k0', text: 'x' });
    expect(await a.next('steer_rejected')).toMatchObject({ steerId: 'k0', turnId: 'no-such-turn' });
    a.send({ type: 'steer', turnId: 'no-such-turn', steerId: 'k0', text: '' });
    expect((await a.next('error')).message).toContain('형식 오류');

    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    await b.next('history');
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k1', text: 'also this' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    const steer = fake.inputs[1]!;
    expect(steer.priority).toBe('next');
    fake.push({ type: 'user', isReplay: true, uuid: steer.uuid, parent_tool_use_id: null, message: steer.message, session_id: S });
    const want = { type: 'steer_delivered', turnId: t.turnId, sessionId: S, steerId: 'k1', prompt: { text: 'also this', attachments: [] } };
    expect(await a.next('steer_delivered')).toMatchObject(want);
    expect(await b.next('steer_delivered')).toMatchObject(want);
    // A device opening the session mid-turn gets it again after history (marked replay).
    const c = await client();
    await c.next('hello');
    c.send({ type: 'open_session', sessionId: S });
    await c.next('history');
    expect(await c.next('steer_delivered')).toMatchObject({ ...want, replay: true });
    c.close();
    // A repeated steerId is refused as already in (D) and never reaches the process again.
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k1', text: 'also this' });
    expect(await a.next('steer_rejected', (m) => m.steerId === 'k1')).toMatchObject({ code: 'already_accepted' });
    fake.push({ ...sdk.result('done', S), user_message_uuids: [fake.inputs[0]!.uuid, steer.uuid] });
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    expect(a.got.filter((m) => m.type === 'turn_result')).toHaveLength(1);
    expect(a.got.filter((m) => m.type === 'steer_rejected' && m.steerId === 'k1')).toHaveLength(1);
    expect(fake.inputs).toHaveLength(2);
    a.close();
    b.close();
  });

  it('A: a steer handed to the process but never delivered is pending, not accepted — after the process dies it is in neither list', async () => {
    const S = '66666666-6666-4666-8666-666666666666';
    const cwd = await seed(S, 'steer2');
    fake = fakeSdk();
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'g1' });
    const t = await a.next('turn_started');
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k2', text: 'late' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    const b = await client();
    await b.next('hello');
    b.send({ type: 'open_session', sessionId: S });
    const h = await b.next('history');
    expect(h).toMatchObject({ acceptedRefs: ['g1'] });
    expect(h.pendingRefs).toEqual(['k2']);
    // While pending, a resend of the steer is refused too, as in_flight: it may still go in — or fail, so the device keeps it.
    b.send({ type: 'steer', turnId: t.turnId, steerId: 'k2', text: 'late' });
    expect(await b.next('steer_rejected', (m) => m.steerId === 'k2')).toMatchObject({ code: 'in_flight', message: '아직 처리 중인 메시지 — 멈춰 둠' });
    b.close();
    fake.end();
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
    const c = await client();
    await c.next('hello');
    c.send({ type: 'open_session', sessionId: S });
    const h2 = await c.next('history');
    expect(h2.acceptedRefs).toEqual(['g1']);
    expect(h2.pendingRefs).toEqual([]);
    c.close();
  });

  it('a steer the runner rejects (retry, process gone) is no longer pending; an error carrying a clientRef takes back its accepted ref', async () => {
    const S = '67676767-6767-4767-8767-676767676767';
    const cwd = await seed(S, 'steer3');
    fake = fakeSdk();
    let sink: Parameters<TurnRunner['run']>[1] | null = null;
    const run = runner.run.bind(runner);
    const spy = vi.spyOn(runner, 'run').mockImplementation((p, s) => { sink = s; return run(p, s); });
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'g3' });
    const t = await a.next('turn_started');
    spy.mockRestore();
    fake.push(sdk.init(S));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    a.send({ type: 'steer', turnId: t.turnId, steerId: 'k3', text: 'late' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    // What the runner sends for a steer a retry dropped, and for a follow-up it could not write after its turn_started.
    sink!.emit({ type: 'steer_rejected', turnId: t.turnId, sessionId: S, cwd, steerId: 'k3', message: '재시도 중이라 턴이 끝난 뒤 보냅니다' });
    sink!.emit({ type: 'error', turnId: t.turnId, message: '메시지를 보내지 못했습니다', clientRef: 'g3' });
    a.send({ type: 'open_session', sessionId: S });
    const h = await a.next('history');
    expect(h.pendingRefs).toEqual([]);
    expect(h.acceptedRefs).toEqual([]);
    fake.end();
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });

  it('D: a send whose clientRef the session already accepted is refused with already_accepted and never runs again; a follow-up is recorded at its turn_started', async () => {
    const S = '77777777-7777-4777-8777-777777777777';
    const cwd = await seed(S, 'dedupe');
    fake = fakeSdk();
    let sink: Parameters<TurnRunner['run']>[1] | null = null;
    const run = runner.run.bind(runner);
    const spy = vi.spyOn(runner, 'run').mockImplementation((p, s) => { sink = s; return run(p, s); });
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'd1' });
    const t = await a.next('turn_started');
    spy.mockRestore();
    fake.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', S));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    a.send({ type: 'send', sessionId: S, cwd, text: 'go', clientRef: 'd1' });
    expect(await a.next('error', (m) => m.clientRef === 'd1')).toMatchObject({ turnId: null, code: 'already_accepted' });
    a.send({ type: 'send', sessionId: S, cwd, text: 'more', clientRef: 'd2' });
    const fu = await a.next('turn_started', (m) => m.clientRef === 'd2');
    a.send({ type: 'send', sessionId: S, cwd, text: 'more', clientRef: 'd2' });
    expect(await a.next('error', (m) => m.clientRef === 'd2')).toMatchObject({ code: 'already_accepted' });
    a.send({ type: 'open_session', sessionId: S });
    expect((await a.next('history')).acceptedRefs).toEqual(['d1', 'd2']);
    expect(fake.inputs).toHaveLength(2);
    // The follow-up's write failing after its turn_started: the ref is taken back, and no second (app-wide) error goes out —
    // its failed turn_result is the one place the user sees it.
    sink!.emit({ type: 'error', turnId: fu.turnId, message: '메시지를 보내지 못했습니다', clientRef: 'd2' });
    a.send({ type: 'open_session', sessionId: S });
    expect((await a.next('history')).acceptedRefs).toEqual(['d1']);
    expect(a.got.some((m) => m.type === 'error' && m.message === '메시지를 보내지 못했습니다')).toBe(false);
    a.send({ type: 'interrupt', turnId: t.turnId });
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
  it('drain waits on running turns and live background work, ends only processes waiting with nothing left, and still takes messages into live processes', async () => {
    const S = '44444444-4444-4444-8444-444444444444';
    const cwd = await seed(S, 'bg2');
    const f1 = (fake = fakeSdk());
    const a = await client();
    await a.next('hello');
    a.send({ type: 'send', sessionId: S, cwd, text: 'go' });
    const t = await a.next('turn_started');
    f1.push(sdk.init(S), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', S));
    await a.next('turn_background');
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    expect(wsApi.activeTurns()).toBe(1);

    a.send({ type: 'send', sessionId: S, cwd, text: 'next', clientRef: 'r2' });
    const fu = await a.next('turn_started', (m) => m.clientRef === 'r2');
    // More sessions: one held open for live background work, one held open with its work already done (waiting for a
    // continuation that may never come), one still running its prompt.
    const hold = async (id: string, name: string, ref: string) => {
      const f = (fake = fakeSdk());
      a.send({ type: 'send', sessionId: id, cwd: await seed(id, name), text: 'go', clientRef: ref });
      const t = await a.next('turn_started', (m) => m.clientRef === ref);
      f.push(sdk.init(id), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', id));
      await a.next('turn_result', (m) => m.turnId === t.turnId);
      return { id, f, turnId: t.turnId };
    };
    const held = await hold('55555555-5555-4555-8555-555555555555', 'bg3', 'h');
    const idle = await hold('57575757-5757-4757-8757-575757575757', 'bg5', 'i');
    idle.f.push(sdk.bgLevel([]));
    await a.next('turn_background', (m) => m.turnId === idle.turnId && m.tasks.length === 0);
    const S3 = '56565656-5656-4656-8656-565656565656';
    const fake3 = (fake = fakeSdk());
    a.send({ type: 'send', sessionId: S3, cwd: await seed(S3, 'bg4'), text: 'busy', clientRef: 'r3b' });
    const t3 = await a.next('turn_started', (m) => m.clientRef === 'r3b');
    fake3.push(sdk.init(S3), sdk.delta('working'));
    await a.next('delta', (m) => m.turnId === t3.turnId);
    expect(wsApi.activeTurns()).toBe(4);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    wsApi.drain();
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^deck: 재시작 대기 — 백그라운드 작업이 있는 세션 2개: 44444444\(build\) 55555555\(build\)$/)]);
    log.mockRestore();
    expect(await a.next('error', (m) => m.message === DRAINING_MESSAGE)).toMatchObject({ turnId: null, code: 'draining' });
    // Only the process with nothing left to wait for is ended (without failing any turn); live background work stays.
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(3));
    await new Promise((r) => setTimeout(r, 30));
    expect(wsApi.activeTurns()).toBe(3);
    expect(held.f.inputs.length).toBe(1);
    expect(a.got.filter((m) => m.type === 'turn_result' && !m.ok)).toEqual([]);
    // A turn that finishes with background work while draining stays held open too.
    fake3.push(sdk.bgLevel([{ id: 'y', desc: 'later' }]), sdk.result('launched too', S3));
    expect(await a.next('turn_result', (m) => m.turnId === t3.turnId)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(wsApi.activeTurns()).toBe(3);
    // A send that needs a new process is refused…
    a.send({ type: 'send', sessionId: null, cwd, text: 'new', clientRef: 'r3' });
    expect(await a.next('error', (m) => m.clientRef === 'r3')).toMatchObject({ message: DRAINING_MESSAGE, code: 'draining' });
    // …but one to a process held open goes in as its follow-up.
    a.send({ type: 'send', sessionId: held.id, cwd, text: 'status?', clientRef: 'h2' });
    expect(await a.next('turn_started', (m) => m.clientRef === 'h2')).toMatchObject({ reason: '백그라운드 대기 중 이어 보냄' });
    await vi.waitFor(() => expect(held.f.inputs.length).toBe(2));
    // A steer into a running turn is not refused for the restart.
    a.send({ type: 'steer', turnId: fu.turnId, steerId: 'k9', text: 'more' });
    await vi.waitFor(() => expect(f1.inputs.length).toBe(3));
    expect(a.got.some((m) => m.type === 'steer_rejected' && m.steerId === 'k9')).toBe(false);

    a.send({ type: 'interrupt', turnId: fu.turnId });
    expect(await a.next('turn_background', (m) => m.tasks.length === 0 && m.turnId === fu.turnId)).toMatchObject({ turnId: fu.turnId });
    expect(await a.next('turn_result', (m) => m.turnId === fu.turnId)).toMatchObject({ ok: false, errorText: '중단됨' });
    a.send({ type: 'interrupt', turnId: held.turnId });
    a.send({ type: 'interrupt', turnId: t3.turnId });
    await vi.waitFor(() => expect(wsApi.activeTurns()).toBe(0));
    a.close();
  });
});

/** A server of its own (a drained one stays drained) on the shared store and index; `foreign` = what foreignWrites answers. */
async function ownServer() {
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const r = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ accounts: testRegistry(), queryFn, readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(base, 'codex') });
  const own = { foreign: false };
  vi.spyOn(r, 'foreignWrites').mockImplementation(async () => own.foreign);
  const pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  const activityFile = path.join(await fs.mkdtemp(path.join(base, 'own-')), 'activity.json');
  const srv = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  const api = attachWebSocket([srv], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner: r, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings, acceptedRefs: new AcceptedRefs(null), activityFile });
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const { port } = srv.address() as { port: number };
  const org = `http://127.0.0.1:${port}`;
  return { api, own, activityFile, client: () => client(`ws://127.0.0.1:${port}/ws`, org), close: () => { api.close(); srv.close(); } };
}

describe('ws: drain and held processes', () => {
  /** A session whose process is held open for live background work ('build'). */
  async function held(s: Awaited<ReturnType<typeof ownServer>>, a: Awaited<ReturnType<typeof client>>, id: string, name: string) {
    const cwd = await seed(id, name);
    const f = (fake = fakeSdk());
    a.send({ type: 'send', sessionId: id, cwd, text: 'go', clientRef: `${name}-go` });
    const t = await a.next('turn_started', (m) => m.clientRef === `${name}-go`);
    f.push(sdk.init(id), sdk.bgLevel([{ id: 'x', desc: 'build' }]), sdk.result('launched', id));
    await a.next('turn_result', (m) => m.turnId === t.turnId);
    return { f, cwd, turnId: t.turnId };
  }

  it('a message queued behind the continuation of a drained held process is delivered when it ends without work (not cut as 중단됨)', async () => {
    const s = await ownServer();
    const a = await s.client();
    await a.next('hello');
    const S = '61616161-6161-4161-8161-616161616161';
    const h = await held(s, a, S, 'dr1');
    vi.spyOn(console, 'log').mockImplementationOnce(() => {});
    s.api.drain();
    await a.next('error', (m) => m.message === DRAINING_MESSAGE);
    // The background work ends; its continuation streams…
    h.f.push(sdk.bgLevel([]), sdk.notifyUser(), sdk.delta('built'));
    const bg = await a.next('turn_started', (m) => m.reason === '백그라운드 계속');
    await a.next('delta', (m) => m.turnId === bg.turnId);
    // …a message comes in meanwhile and is queued behind it…
    a.send({ type: 'send', sessionId: S, cwd: h.cwd, text: 'M', clientRef: 'm1' });
    await vi.waitFor(() => expect(s.api.activeTurns()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    // …and the continuation ends with no background work left: M goes in rather than the process being ended.
    h.f.push(sdk.result('built', S));
    expect(await a.next('turn_result', (m) => m.turnId === bg.turnId)).toMatchObject({ ok: true });
    const m = await a.next('turn_started', (x) => x.clientRef === 'm1');
    await vi.waitFor(() => expect(h.f.inputs.length).toBe(2));
    h.f.push(sdk.result('done M', S));
    expect(await a.next('turn_result', (x) => x.turnId === m.turnId)).toMatchObject({ ok: true, text: 'done M' });
    expect(a.got.filter((x) => x.type === 'error' && x.clientRef === 'm1')).toEqual([]);
    // Nothing left to wait for after M: the drained process ends now.
    await vi.waitFor(() => expect(s.api.activeTurns()).toBe(0));
    a.close();
    s.close();
  });

  it('a foreign write found while draining refuses the send (draining) and leaves the held process and its work alone; activity.json says draining; close removes it', async () => {
    const s = await ownServer();
    const a = await s.client();
    await a.next('hello');
    const S = '62626262-6262-4262-8262-626262626262';
    const h = await held(s, a, S, 'dr2');
    vi.spyOn(console, 'log').mockImplementationOnce(() => {});
    s.api.drain();
    await a.next('error', (m) => m.message === DRAINING_MESSAGE);
    // Written by drain itself (well inside the 200 ms debounce of a change), not with the next change.
    const activity = async () => JSON.parse(await fs.readFile(s.activityFile, 'utf8')) as { draining: boolean; sessions: unknown[] };
    await vi.waitFor(async () => expect(await activity()).toMatchObject({ draining: true, sessions: [{ sessionId: S, running: false, bg: 1, tasks: ['build'] }] }), { timeout: 150, interval: 5 });

    s.own.foreign = true;
    a.send({ type: 'send', sessionId: S, cwd: h.cwd, text: 'N', clientRef: 'n1' });
    expect(await a.next('error', (m) => m.clientRef === 'n1')).toMatchObject({ message: DRAINING_MESSAGE, code: 'draining' });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.api.activeTurns()).toBe(1);
    expect(h.f.state.inputClosed).toBe(false);
    expect(a.got.some((m) => m.type === 'turn_notice' && m.sessionId === S)).toBe(false);
    expect(a.got.filter((m) => m.type === 'turn_result' && !m.ok)).toEqual([]);

    a.send({ type: 'interrupt', turnId: h.turnId });
    await vi.waitFor(() => expect(s.api.activeTurns()).toBe(0));
    a.close();
    s.close();
    await expect(fs.stat(s.activityFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
