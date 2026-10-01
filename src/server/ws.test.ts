import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { AttachmentStore } from './attachments/AttachmentStore';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { PinStore } from './sessions/PinStore';
import { SettingsStore } from './settings';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { PermissionBroker, QuestionBroker, attachWebSocket } from './ws';

const TOKEN = 'f'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let stub: StubEngine;
let wsApi: ReturnType<typeof attachWebSocket>;
let pins: PinStore;
let settings: SettingsStore;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
let store2: AttachmentStore;
let gate: Promise<void> = Promise.resolve();
let release: () => void = () => {};
const hold = () => { gate = new Promise<void>((r) => { release = r; }); };

function card(id: string) {
  return { id, status: 'ok', fetchedAt: new Date().toISOString(), rows: [{ label: 'Session (5h)', used: 1 }, { label: 'Weekly (7d)', used: 1, resetsAt: new Date(Date.now() + 36e5).toISOString() }] };
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-work-')));
  index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [card('claude:main'), card('claude:second'), card('claude:third')] }) }) });
  await usage.pollOnce();
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  stub = new StubEngine(async (req) => {
    if (req.prompt === 'ask-scoped') {
      const d = await req.onPermission({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu2', title: 'Claude wants to run ls', decisionReason: 'r', blockedPath: '/b', defaultToNo: true, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'session' }] });
      return [{ kind: 'init', sessionId: 'sess-scoped', model: 'm' }, okResult('sess-scoped', `decision=${d}`)];
    }
    if (req.prompt === 'ask') {
      const d = await req.onPermission({ toolName: 'Write', input: { file_path: '/x' }, toolUseId: 'tu1' });
      return [{ kind: 'init', sessionId: 'sess-ask', model: 'm' }, { kind: 'delta', text: `decision=${d}` }, okResult('sess-ask', `decision=${d}`)];
    }
    if (req.prompt === 'question') {
      const a = await req.onQuestion?.({ toolUseId: 'q1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] });
      return [{ kind: 'init', sessionId: 'sess-q', model: 'm' }, okResult('sess-q', `answer=${a ? a['Which color?'] : 'none'}`)];
    }
    if (req.prompt === 'att') return [{ kind: 'init', sessionId: 'sess-att', model: 'm' }, okResult('sess-att', `n=${req.attachments?.length ?? 0}`)];
    if (req.prompt === 'whereami') return [{ kind: 'init', sessionId: 'sess-cwd', model: 'm' }, okResult('sess-cwd', `cwd=${req.cwd}`)];
    if (req.prompt === 'throw') throw new Error('engine exploded');
    if (req.prompt === 'hold') await gate;
    const sid = req.resumeSessionId ?? 'sess-1';
    return [{ kind: 'init', sessionId: sid, model: 'm' }, { kind: 'delta', text: 'o' }, { kind: 'delta', text: 'k' }, okResult(sid, 'ok')];
  });
  store2 = new AttachmentStore(path.join(base, 'att'));
  await store2.init();
  const runner = new TurnRunner({ attachments: store2, engine: stub, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions') });
  pins = new PinStore(path.join(base, 'pins.json'));
  await pins.load();
  settings = new SettingsStore(path.join(base, 'settings.json'));
  await settings.load();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { token: TOKEN, devOrigins: ['http://dev.local'], runner, index, usage, store, codexAvailable: false, cwdRoots: [path.dirname(work)], pins, settings });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); });

// Deviation (evidence-based fix, not a plan/review item): on this machine the HTTP
// upgrade response and the server's first WS frame (sent synchronously on 'connection')
// can be coalesced into a single client-side read, so 'open' and 'message' fire
// back-to-back in one synchronous turn — before the `await connect()` continuation
// below gets a chance to attach collect()'s listener, silently dropping the message
// (confirmed by attaching a raw 'message' listener at socket-creation time and seeing
// it fire while collect() still timed out). Buffering from connection time and
// draining that buffer in collect() removes the race without changing any assertion.
function connect(headers: Record<string, string>): Promise<{ ok: boolean; ws: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    const buffered: unknown[] = [];
    (ws as WebSocket & { _buffered: unknown[] })._buffered = buffered;
    ws.on('message', (d) => buffered.push(d));
    ws.once('open', () => resolve({ ok: true, ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ ok: false, ws, status: res.statusCode }));
    ws.once('error', () => resolve({ ok: false, ws }));
  });
}

/** Everything that arrives within `ms` (for asserting that something is NOT sent). */
function quiet(ws: WebSocket, ms: number): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const out: ServerMessage[] = [];
    const on = (d: unknown) => out.push(JSON.parse(String(d)) as ServerMessage);
    ws.on('message', on);
    setTimeout(() => { ws.off('message', on); resolve(out); }, ms);
  });
}

/** A session on account b whose jsonl exists and whose state is warm, so turns stay on b. */
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

function collect(ws: WebSocket, until: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const out: ServerMessage[] = [];
    let done = false;
    let t: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      ws.off('message', onMessage);
      resolve(out);
    };
    const consume = (d: unknown) => {
      if (done) return;
      const m = JSON.parse(String(d)) as ServerMessage;
      out.push(m);
      if (until(m)) finish();
    };
    const onMessage = (d: unknown) => consume(d);
    const buffered = (ws as WebSocket & { _buffered?: unknown[] })._buffered ?? [];
    (ws as WebSocket & { _buffered?: unknown[] })._buffered = [];
    for (const d of buffered) consume(d);
    if (!done) {
      t = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`timeout; got ${JSON.stringify(out)}`)); }, timeoutMs);
      ws.on('message', onMessage);
    }
  });
}

describe('ws', () => {
  it('refuses upgrades without a cookie, with a bad cookie, or with a foreign origin', async () => {
    expect((await connect({ Origin: origin })).status).toBe(401);
    expect((await connect({ Origin: origin, Cookie: 'deck_session=bad' })).status).toBe(401);
    expect((await connect({ Origin: 'http://evil.example', Cookie: COOKIE })).status).toBe(403);
  });

  it('accepts cookie + own origin (and a dev origin), sends hello', async () => {
    const c = await connect({ Origin: origin, Cookie: COOKIE });
    expect(c.ok).toBe(true);
    const [hello] = await collect(c.ws, (m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', projects: [] });
    c.ws.close();
    const d = await connect({ Origin: 'http://dev.local', Cookie: COOKIE });
    expect(d.ok).toBe(true);
    d.ws.close();
  });

  it('runs a turn: turn_started, deltas, turn_result, then index refresh', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'hello' }));
    const msgs = await p;
    expect(msgs.map((m) => m.type)).toEqual(['turn_started', 'delta', 'delta', 'turn_result', 'index']);
    expect(msgs[3]).toMatchObject({ type: 'turn_result', ok: true, text: 'ok', sessionId: 'sess-1', badge: { model: 'opus' } });
    ws.close();
  });

  it('a rejected run ends with a terminal turn_result, not a bare error', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'turn_result' || m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'throw' }));
    const last = (await p).at(-1);
    expect(last).toMatchObject({ type: 'turn_result', ok: false, errorText: expect.stringContaining('engine exploded') });
    ws.close();
  });

  it('relays permission requests and resumes after the answer', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    expect(req).toMatchObject({ toolName: 'Write', input: { file_path: '/x' }, cwd: work, title: null, allowSession: false, sessionLabel: null });
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'session' }));
    const msgs = await p2;
    expect(msgs.find((m) => m.type === 'permission_resolved')).toMatchObject({ requestId: req.requestId, decision: 'session' });
    expect(msgs.at(-1)).toMatchObject({ type: 'turn_result', text: 'decision=session' });
    ws.close();
  });

  it('permission_request relays title, reason, blocked path, defaultToNo, and offers 이 세션 when a scoped rule was suggested', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask-scoped' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    expect(req).toMatchObject({ title: 'Claude wants to run ls', decisionReason: 'r', blockedPath: '/b', defaultToNo: true, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' });
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'deny' }));
    await p2;
    ws.close();
  });

  it('an interrupted turn leaves no pending prompt, and a reconnecting client gets no stale card', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'permission_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'ask' }));
    const req = (await p1).at(-1) as Extract<ServerMessage, { type: 'permission_request' }>;
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'interrupt', turnId: req.turnId }));
    const msgs = await p2;
    expect(msgs.find((m) => m.type === 'permission_resolved')).toMatchObject({ requestId: req.requestId, decision: 'deny' });
    ws.close();
    const again = await connect({ Origin: origin, Cookie: COOKIE });
    const seen = await collect(again.ws, () => false, 300).catch((e: Error) => e.message);
    expect(String(JSON.stringify(seen))).not.toContain('permission_request');
    again.ws.close();
  });

  it('a second send for a busy session is rejected; hello lists the running turn; the lock is released after', async () => {
    const SX = '22222222-2222-4222-8222-222222222222';
    const cwd = await seed(SX, 'lock');
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'hold' }));
    const ts = (await started).at(-1) as Extract<ServerMessage, { type: 'turn_started' }>;

    const b = await connect({ Origin: origin, Cookie: COOKIE });
    const [hello] = await collect(b.ws, (m) => m.type === 'hello');
    expect((hello as Extract<ServerMessage, { type: 'hello' }>).running).toContainEqual({ turnId: ts.turnId, sessionId: SX, cwd });
    const pe = collect(b.ws, (m) => m.type === 'error');
    b.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'second' }));
    expect((await pe).at(-1)).toMatchObject({ type: 'error', message: '이 세션은 이미 실행 중입니다' });

    const done = collect(a.ws, (m) => m.type === 'turn_result');
    release();
    await done;
    const again = collect(b.ws, (m) => m.type === 'turn_result' || m.type === 'error');
    b.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'third' }));
    expect((await again).at(-1)).toMatchObject({ type: 'turn_result', ok: true });
    a.ws.close();
    b.ws.close();
  });

  it('clientRef is echoed on the send\'s turn_started and on errors refusing a send (busy, missing attachment, schema)', async () => {
    const SX = '55555555-5555-4555-8555-555555555555';
    const cwd = await seed(SX, 'ref');
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'hold', clientRef: 'p0-1' }));
    expect((await started).at(-1)).toMatchObject({ type: 'turn_started', sessionId: SX, clientRef: 'p0-1' });

    const busyErr = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd, text: 'second', clientRef: 'p1-1' }));
    expect((await busyErr).at(-1)).toMatchObject({ type: 'error', message: '이 세션은 이미 실행 중입니다', clientRef: 'p1-1' });

    const schemaErr = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative', text: 'x', clientRef: 'p2-1' }));
    expect((await schemaErr).at(-1)).toMatchObject({ type: 'error', clientRef: 'p2-1' });
    const tooLong = collect(a.ws, (m) => m.type === 'error');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative', text: 'x', clientRef: 'r'.repeat(65) }));
    expect((await tooLong).at(-1)).not.toHaveProperty('clientRef');

    const done = collect(a.ws, (m) => m.type === 'turn_result');
    release();
    await done;
    const attErr = collect(a.ws, (m) => m.type === 'error' || m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd, text: 'x', attachments: ['99999999-9999-4999-8999-999999999999'], clientRef: 'p3-1' }));
    expect((await attErr).at(-1)).toMatchObject({ type: 'error', clientRef: 'p3-1' });
    a.ws.close();
  });

  it('turn events go to the originating socket and sockets viewing that session only', async () => {
    const SX = '33333333-3333-4333-8333-333333333333';
    const SY = '44444444-4444-4444-8444-444444444444';
    const cwdX = await seed(SX, 'route-x');
    await seed(SY, 'route-y');
    const viewerY = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(viewerY.ws, (m) => m.type === 'hello');
    const hy = collect(viewerY.ws, (m) => m.type === 'history');
    viewerY.ws.send(JSON.stringify({ type: 'open_session', sessionId: SY }));
    await hy;
    const viewerX = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(viewerX.ws, (m) => m.type === 'hello');
    const hx = collect(viewerX.ws, (m) => m.type === 'history');
    viewerX.ws.send(JSON.stringify({ type: 'open_session', sessionId: SX }));
    await hx;

    const sender = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(sender.ws, (m) => m.type === 'hello');
    const onY = quiet(viewerY.ws, 400);
    const onX = collect(viewerX.ws, (m) => m.type === 'turn_result');
    const own = collect(sender.ws, (m) => m.type === 'turn_result');
    sender.ws.send(JSON.stringify({ type: 'send', sessionId: SX, cwd: cwdX, text: 'hello' }));
    const mine = await own;
    expect(mine.filter((m) => m.type === 'delta')).toHaveLength(2);
    expect(mine.find((m) => m.type === 'delta')).toMatchObject({ sessionId: SX, cwd: cwdX });
    expect((await onX).filter((m) => m.type === 'delta')).toHaveLength(2);
    expect((await onY).filter((m) => m.type === 'delta' || m.type === 'turn_started' || m.type === 'turn_result')).toEqual([]);
    for (const c of [viewerX, viewerY, sender]) c.ws.close();
  });

  it('a reconnected tab can watch its in-flight new-session turn and gets the result', async () => {
    hold();
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(a.ws, (m) => m.type === 'hello');
    const started = collect(a.ws, (m) => m.type === 'turn_started');
    a.ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'hold' }));
    const ts = (await started).at(-1) as Extract<ServerMessage, { type: 'turn_started' }>;
    a.ws.close();
    const b = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(b.ws, (m) => m.type === 'hello');
    const done = collect(b.ws, (m) => m.type === 'turn_result');
    b.ws.send(JSON.stringify({ type: 'watch_turn', turnId: ts.turnId }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect((await done).at(-1)).toMatchObject({ type: 'turn_result', turnId: ts.turnId, ok: true });
    b.ws.close();
  });

  it('cwd must be an absolute, existing directory', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: 'relative/dir', text: 'x' }));
    expect((await p1).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cwd') });
    const p2 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/' + 'x'.repeat(4100), text: 'x' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cwd') });
    const p3 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'does-not-exist'), text: 'x' }));
    expect((await p3).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('작업 폴더') });
    ws.close();
  });

  it('a new session\'s cwd must lie under the allowed roots (home), symlink escapes included (F1)', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p1 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/usr', text: 'x', clientRef: 'out-1' }));
    expect((await p1).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('홈 폴더'), clientRef: 'out-1' });
    await fs.symlink('/usr', path.join(work, 'usr-link')).catch(() => {});
    const p2 = collect(ws, (m) => m.type === 'error' || m.type === 'turn_started');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'usr-link'), text: 'x' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('홈 폴더') });
    ws.close();
  });

  it('a new session runs in the validated real path, not the raw (symlinked) cwd it was sent (review fix 3)', async () => {
    await fs.mkdir(path.join(work, 'real-dir'), { recursive: true });
    await fs.symlink(path.join(work, 'real-dir'), path.join(work, 'alias-dir')).catch(() => {});
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: path.join(work, 'alias-dir'), text: 'whereami' }));
    expect((await p).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: `cwd=${path.join(work, 'real-dir')}` });
    ws.close();
  });

  it('broadcastIndex sends the project index and the pins to every client; hello carries the pins (F2)', async () => {
    await pins.set('pinned-1', true);
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    expect((await collect(ws, (m) => m.type === 'hello')).at(-1)).toMatchObject({ type: 'hello', pins: ['pinned-1'] });
    await pins.set('pinned-1', false);
    const p = collect(ws, (m) => m.type === 'index');
    wsApi.broadcastIndex();
    expect((await p).at(-1)).toMatchObject({ type: 'index', projects: expect.any(Array), pins: [] });
    ws.close();
  });

  it('hello carries 자동 승인 (default on); set_settings persists it and broadcasts to every client', async () => {
    const a = await connect({ Origin: origin, Cookie: COOKIE });
    const b = await connect({ Origin: origin, Cookie: COOKIE });
    expect((await collect(a.ws, (m) => m.type === 'hello')).at(-1)).toMatchObject({ type: 'hello', settings: { autoApprove: true } });
    await collect(b.ws, (m) => m.type === 'hello');
    const pa = collect(a.ws, (m) => m.type === 'settings');
    const pb = collect(b.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', autoApprove: false }));
    expect((await pa).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: false } });
    expect((await pb).at(-1)).toEqual({ type: 'settings', settings: { autoApprove: false } });
    expect(JSON.parse(await fs.readFile(path.join(base, 'settings.json'), 'utf8'))).toEqual({ autoApprove: false });
    const pc = collect(a.ws, (m) => m.type === 'settings');
    a.ws.send(JSON.stringify({ type: 'set_settings', autoApprove: true }));
    expect((await pc).at(-1)).toMatchObject({ settings: { autoApprove: true } });
    a.ws.close(); b.ws.close();
  });

  it('rejects invalid messages with an error and keeps the socket open', async () => {
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'error');
    ws.send('not json');
    expect((await p).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('메시지') });
    const p2 = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: '/w', text: 'x', model: 'haiku' }));
    expect((await p2).at(-1)).toMatchObject({ type: 'error' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('open_session returns history for a stored session and an error for an unknown one', async () => {
    const dir = path.join(base, 'c', '-w-y');
    await fs.mkdir(dir, { recursive: true });
    const SID = '99999999-9999-4999-8999-999999999999';
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/y', message: { role: 'user', content: 'first' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply' }] } }) + '\n');
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const pi = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'refresh_index' }));
    await pi;
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: SID }));
    const h = (await p).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(h).toMatchObject({ sessionId: SID, cwd: '/w/y', account: 'c' });
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    const pe = collect(ws, (m) => m.type === 'error');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: 'nope' }));
    expect((await pe).at(-1)).toMatchObject({ type: 'error' });
    ws.close();
  });

  // Regression: a session written after the server's initial index scan (e.g. by Claude
  // Desktop) is not yet in the in-memory index. open_session must rescan once and still
  // find it, without the client ever triggering refresh_index itself.
  it('open_session rescans the index once for a session written after the initial scan', async () => {
    const dir = path.join(base, 'c', '-w-z');
    await fs.mkdir(dir, { recursive: true });
    const SID = '88888888-8888-4888-8888-888888888888';
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/z', message: { role: 'user', content: 'first' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply' }] } }) + '\n');
    const { ws } = await connect({ Origin: origin, Cookie: COOKIE });
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId: SID }));
    const h = (await p).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(h).toMatchObject({ sessionId: SID, cwd: '/w/z', account: 'c' });
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    ws.close();
  });

  it('survives an invalid-UTF-8 frame and an oversized frame, then serves another client', async () => {
    const { port } = server.address() as { port: number };
    const rawFrame = (frame: Buffer) => new Promise<void>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${COOKIE}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let upgraded = false;
      s.on('data', (d) => { if (!upgraded && String(d).startsWith('HTTP/1.1 101')) { upgraded = true; s.write(frame); } });
      s.on('error', () => {});
      s.on('close', () => resolve());
      setTimeout(() => { s.destroy(); resolve(); }, 1500);
    });
    const mask = Buffer.from([1, 2, 3, 4]);
    // masked FIN text frame whose single payload byte is 0xff (invalid UTF-8)
    await rawFrame(Buffer.concat([Buffer.from([0x81, 0x80 | 1]), mask, Buffer.from([0xff ^ 1])]));
    // masked FIN text frame header announcing a 2 MiB payload (over maxPayload)
    const len = Buffer.alloc(8); len.writeBigUInt64BE(2n * 1024n * 1024n);
    await rawFrame(Buffer.concat([Buffer.from([0x81, 0x80 | 127]), len, mask, Buffer.alloc(1024)]));
    const c = await connect({ Origin: origin, Cookie: COOKIE });
    expect(c.ok).toBe(true);
    const [hello] = await collect(c.ws, (m) => m.type === 'hello');
    expect(hello?.type).toBe('hello');
    c.ws.close();
  });

  it('send.attachments ids reach the engine as Attachment objects', async () => {
    const a = await store2.save('p.png', Buffer.from('89504e470d0a1a0a00', 'hex'));
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    await collect(ws, (m) => m.type === 'hello');
    const r = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'att', attachments: [a.id] }));
    expect((await r).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'n=1' });
    ws.close();
  });
});

describe('PermissionBroker', () => {
  const req = (requestId: string, turnId = 't1') => ({ type: 'permission_request' as const, turnId, sessionId: null, cwd: '/w', requestId, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: '이 세션 동안 `Bash(ls)` 허용' });

  it('an aborted signal resolves deny, drops the prompt and tells every client', async () => {
    const sent: ServerMessage[] = [];
    const b = new PermissionBroker((m) => sent.push(m));
    const ac = new AbortController();
    const p = b.ask(req('r1'), ac.signal);
    expect(b.pending()).toHaveLength(1);
    ac.abort();
    expect(await p).toBe('deny');
    expect(b.pending()).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: 'permission_resolved', requestId: 'r1', decision: 'deny' });
  });

  it('cancelTurn denies only that turn\'s prompts', async () => {
    const sent: ServerMessage[] = [];
    const b = new PermissionBroker((m) => sent.push(m));
    const p1 = b.ask(req('r1', 't1'));
    void b.ask(req('r2', 't2'));
    b.cancelTurn('t1');
    expect(await p1).toBe('deny');
    expect(b.pending().map((m) => (m as { requestId: string }).requestId)).toEqual(['r2']);
  });

  it('an unanswered prompt is auto-denied after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const b = new PermissionBroker(() => {}, { timeoutMs: 1000 });
      const p = b.ask(req('r1'));
      vi.advanceTimersByTime(1001);
      expect(await p).toBe('deny');
      expect(b.pending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('multi-session viewing and Codex sessions (D4, D6)', () => {
  it('hello reports codex availability', async () => {
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    expect(hello).toMatchObject({ type: 'hello', codex: { available: false } });
    ws.close();
  });

  it('one socket can view two sessions; close_session stops the events for that session only', async () => {
    const sidA = '66666666-6666-4666-8666-666666666666';
    const sidB = '77777777-7777-4777-8777-777777777777';
    const cwdA = await seed(sidA, 'view-a');
    const cwdB = await seed(sidB, 'view-b');
    const viewer = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(viewer, (m) => m.type === 'hello');
    viewer.send(JSON.stringify({ type: 'open_session', sessionId: sidA }));
    await collect(viewer, (m) => m.type === 'history');
    viewer.send(JSON.stringify({ type: 'open_session', sessionId: sidB }));
    await collect(viewer, (m) => m.type === 'history');
    const sender = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(sender, (m) => m.type === 'hello');
    const seenA = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidA);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidA, cwd: cwdA, text: 'hi' }));
    expect((await seenA).some((m) => m.type === 'delta')).toBe(true);
    const seenB = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidB);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidB, cwd: cwdB, text: 'hi' }));
    await seenB;
    viewer.send(JSON.stringify({ type: 'close_session', sessionId: sidB }));
    await new Promise((r) => setTimeout(r, 50));
    const q = quiet(viewer, 400);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidB, cwd: cwdB, text: 'hi' }));
    expect((await q).filter((m) => 'sessionId' in m && m.sessionId === sidB)).toEqual([]);
    const stillA = collect(viewer, (m) => m.type === 'turn_result' && m.sessionId === sidA);
    sender.send(JSON.stringify({ type: 'send', sessionId: sidA, cwd: cwdA, text: 'hi' }));
    await stillA;
    viewer.close(); sender.close();
  });

  it('open_session on a Codex session reads its rollout file and reports engine codex', async () => {
    const tid = '01a0f2d3-0000-7c92-aeea-000000000009';
    const rollout = path.join(base, `rollout-2026-09-30T23-59-26-${tid}.jsonl`);
    await fs.writeFile(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: tid, cwd: work } }),
      JSON.stringify({ timestamp: '2026-09-30T14:59:28.268Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: ok' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    ].join('\n') + '\n');
    await store.set({ engine: 'codex', sessionId: tid, cwd: work, lastTurnAtMs: 5, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: rollout, createdAtMs: 1, title: 'Reply with exactly: ok' });
    const { ws } = await connect({ Cookie: COOKIE, Origin: origin });
    const [hello] = await collect(ws, (m) => m.type === 'hello');
    expect(hello?.type === 'hello' && hello.projects.flatMap((p) => p.sessions).find((s) => s.sessionId === tid)).toMatchObject({ account: 'gpt', engine: 'codex' });
    ws.send(JSON.stringify({ type: 'open_session', sessionId: tid }));
    const h = (await collect(ws, (m) => m.type === 'history')).at(-1);
    expect(h).toMatchObject({ type: 'history', sessionId: tid, cwd: work, account: 'gpt', engine: 'codex', sandbox: 'read-only', runningTurnId: null });
    expect(h && h.type === 'history' ? h.messages : []).toEqual([
      { kind: 'user', text: 'Reply with exactly: ok', ts: '2026-09-30T14:59:28.268Z' },
      { kind: 'assistant', text: 'ok', model: null, toolCalls: [], ts: null },
    ]);
    ws.close();
  });
});

describe('AskUserQuestion over the socket (D8)', () => {
  it('broadcasts question_request, a question_response answers it, question_resolved closes it everywhere', async () => {
    const asker = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(asker, (m) => m.type === 'hello');
    const other = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(other, (m) => m.type === 'hello');
    const q = collect(other, (m) => m.type === 'question_request');
    asker.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'question' }));
    const reqMsg = (await q).at(-1);
    expect(reqMsg).toMatchObject({ type: 'question_request', cwd: work, questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] });
    const requestId = reqMsg && reqMsg.type === 'question_request' ? reqMsg.requestId : '';
    // a late socket sees the pending question replayed
    const late = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    const replay = await collect(late, (m) => m.type === 'question_request');
    expect(replay.at(-1)).toMatchObject({ requestId });
    const resolved = collect(asker, (m) => m.type === 'question_resolved');
    const result = collect(asker, (m) => m.type === 'turn_result');
    other.send(JSON.stringify({ type: 'question_response', requestId, answers: { 'Which color?': 'blue' } }));
    expect((await resolved).at(-1)).toMatchObject({ type: 'question_resolved', requestId, answers: { 'Which color?': 'blue' } });
    expect((await result).at(-1)).toMatchObject({ type: 'turn_result', ok: true, text: 'answer=blue' });
    const dup = collect(other, (m) => m.type === 'error');
    other.send(JSON.stringify({ type: 'question_response', requestId, answers: {} }));
    expect((await dup).at(-1)).toMatchObject({ type: 'error', message: '이미 처리된 질문입니다' });
    asker.close(); other.close(); late.close();
  });

  it('interrupt closes an open question as unanswered', async () => {
    const ws = (await connect({ Cookie: COOKIE, Origin: origin })).ws;
    await collect(ws, (m) => m.type === 'hello');
    const q = collect(ws, (m) => m.type === 'question_request');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: work, text: 'question' }));
    const reqMsg = (await q).at(-1);
    const resolved = collect(ws, (m) => m.type === 'question_resolved');
    ws.send(JSON.stringify({ type: 'interrupt', turnId: reqMsg && reqMsg.type === 'question_request' ? reqMsg.turnId : '' }));
    expect((await resolved).at(-1)).toMatchObject({ type: 'question_resolved', answers: null });
    await collect(ws, (m) => m.type === 'turn_result');
    ws.close();
  });
});

describe('QuestionBroker answer validation (D8)', () => {
  const Q = { type: 'question_request' as const, turnId: 't', sessionId: null, cwd: '/w', requestId: 'r1', questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }], multiSelect: false }] };

  it('keeps only answers to the questions that were asked', async () => {
    const sent: ServerMessage[] = [];
    const b = new QuestionBroker((m) => sent.push(m));
    const p = b.ask(Q);
    expect(b.resolve('r1', { 'Which color?': 'blue', injected: 'x' })).toBe(true);
    expect(await p).toEqual({ 'Which color?': 'blue' });
    expect(sent.at(-1)).toEqual({ type: 'question_resolved', requestId: 'r1', answers: { 'Which color?': 'blue' } });
  });

  it('an answer set with no asked question counts as unanswered (null)', async () => {
    const sent: ServerMessage[] = [];
    const b = new QuestionBroker((m) => sent.push(m));
    const p = b.ask(Q);
    expect(b.resolve('r1', { other: 'x' })).toBe(true);
    expect(await p).toBeNull();
    expect(sent.at(-1)).toEqual({ type: 'question_resolved', requestId: 'r1', answers: null });
  });
});
