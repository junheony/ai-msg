import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { PermissionBroker, attachWebSocket } from './ws';

const TOKEN = 'f'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let stub: StubEngine;
let wsApi: ReturnType<typeof attachWebSocket>;
let base: string;
let work: string;
let store: SessionStateStore;
let index: SessionIndex;
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
    if (req.prompt === 'ask') {
      const d = await req.onPermission({ toolName: 'Write', input: { file_path: '/x' }, toolUseId: 'tu1' });
      return [{ kind: 'init', sessionId: 'sess-ask', model: 'm' }, { kind: 'delta', text: `decision=${d}` }, okResult('sess-ask', `decision=${d}`)];
    }
    if (req.prompt === 'throw') throw new Error('engine exploded');
    if (req.prompt === 'hold') await gate;
    const sid = req.resumeSessionId ?? 'sess-1';
    return [{ kind: 'init', sessionId: sid, model: 'm' }, { kind: 'delta', text: 'o' }, { kind: 'delta', text: 'k' }, okResult(sid, 'ok')];
  });
  const runner = new TurnRunner({ engine: stub, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { token: TOKEN, devOrigins: ['http://dev.local'], runner, index, usage, store });
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
    expect(req).toMatchObject({ toolName: 'Write', input: { file_path: '/x' } });
    const p2 = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'permission_response', requestId: req.requestId, decision: 'session' }));
    const msgs = await p2;
    expect(msgs.find((m) => m.type === 'permission_resolved')).toMatchObject({ requestId: req.requestId, decision: 'session' });
    expect(msgs.at(-1)).toMatchObject({ type: 'turn_result', text: 'decision=session' });
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
});

describe('PermissionBroker', () => {
  const req = (requestId: string, turnId = 't1') => ({ type: 'permission_request' as const, turnId, sessionId: null, cwd: '/w', requestId, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true });

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
