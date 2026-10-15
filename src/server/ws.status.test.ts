import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { ClaudeEngine } from './engine/ClaudeEngine';
import { fakeClaudeCli, cli } from './engine/claudeCli/fakeClaudeCli';
import { PermissionBridge } from './engine/claudeCli/bridge';
import type { ClaudeSpawnFn } from './engine/claudeCli/spawnTypes';
import { createRequestHandler } from './http';
import { PinStore } from './sessions/PinStore';
import { SessionIndex } from './sessions/SessionIndex';
import { SettingsStore } from './settings';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'e'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let work: string;
/** Each test installs its own fake CLI process. */
let fake = fakeClaudeCli();
const spawnFn: ClaudeSpawnFn = (bin, args, o) => fake.spawnFn(bin, args, o);
/** The engines' permission bridge (one for the file). */
let bridge: PermissionBridge;
const closers: (() => Promise<void>)[] = [];

/** A deck server of its own (a test that drains it leaves the others alone). */
async function makeServer(serverStartedAt: number) {
  const dir = await fs.mkdtemp(path.join(base, 'srv-'));
  const roots = { a: path.join(dir, 'a'), b: path.join(dir, 'b'), c: path.join(dir, 'c') };
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: ([['claude:main', 30], ['claude:second', 10], ['claude:third', 50]] as const).map(([id, u]) => ({ id, status: 'ok', fetchedAt: new Date().toISOString(), rows: [{ label: 'Session (5h)', used: u, resetsAt: null }, { label: 'Weekly (7d)', used: u, resetsAt: null }, { label: 'Fable (7d)', used: 10, resetsAt: null }] })) }) }) });
  await usage.pollOnce();
  const store = new SessionStateStore(path.join(dir, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ accounts: testRegistry(), attachments: null, engine: new ClaudeEngine({ bin: 'claude', spawnFn, bridge, killGraceMs: 50, accounts: testRegistry(), readFile: async () => Buffer.from('') }), usage, index, store, cooldownDir: path.join(dir, 'cd'), protectedAccount: null, auditFile: path.join(dir, 'audit.log'), projectsRoots: rootsOf(roots), codex: null, codexSessionsRoot: path.join(dir, 'codex') });
  const pins = new PinStore(path.join(dir, 'pins.json'));
  await pins.load();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  await settings.load();
  const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index }));
  const wsApi = attachWebSocket([server], { accounts: testRegistry(), token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, build: 'build-1', cwdRoots: [path.dirname(work)], pins, settings, serverStartedAt });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  closers.push(async () => { wsApi.close(); await new Promise<void>((r) => server.close(() => r())); });
  return { wsApi, usage, runner, origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}
type Srv = Awaited<ReturnType<typeof makeServer>>;
let shared: Srv;

beforeAll(async () => {
  bridge = await PermissionBridge.open();
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsstat-'));
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-wsstat-work-')));
  shared = await makeServer(12345);
});
afterAll(async () => { for (const c of closers) await c(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(work, { recursive: true, force: true }); await bridge.close(); });

/** A socket that buffers everything from connection time; `next(pred)` waits for the next matching message. */
async function client(srv: Srv = shared) {
  const ws = new WebSocket(srv.wsUrl, { headers: { Origin: srv.origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  ws.on('message', (d) => { got.push(JSON.parse(String(d)) as ServerMessage); wake?.(); });
  await new Promise<void>((r) => ws.once('open', () => r()));
  return {
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => new Promise<void>((r) => { ws.once('close', () => r()); ws.close(); }),
    /** Everything after the last message `next` returned, without consuming it. */
    rest: () => got.slice(read),
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

describe('ws: server status and 다음 턴 미리보기', () => {
  it('route_preview: announced as a feature, answered for a Claude ask, resent when usage changes, none for an unknown session', async () => {
    const { usage } = shared;
    const c = await client();
    expect((await c.next('hello')).features).toContain('routePreview');
    c.send({ type: 'route_preview', sessionId: '99999999-9999-4999-8999-999999999999' });
    c.send({ type: 'route_preview', sessionId: null, cwd: work, model: 'opus' });
    const first = await c.next('route_preview');
    expect(first).toMatchObject({ type: 'route_preview', sessionId: null });
    expect(['a', 'b', 'c']).toContain(first.account);
    expect(first.reason).toBeTruthy();
    usage.applyTurn(first.account as 'a', { fiveHour: { usedPct: 99, resetsAt: null }, weekly: { usedPct: 99, resetsAt: null } });
    await c.next('usage');
    const again = await c.next('route_preview');
    expect(again.sessionId).toBeNull();
    expect(again.account).not.toBe(first.account); // the fuller account is left: the preview follows usage
    await c.close();
  });

  it('route_preview: a usage change that leaves the answer as it is sends nothing; a fresh ask is answered anyway', async () => {
    const srv = await makeServer(1);
    const c = await client(srv);
    await c.next('hello');
    c.send({ type: 'route_preview', sessionId: null, cwd: work, model: 'sonnet' });
    const first = await c.next('route_preview');
    srv.usage.applyTurn('gpt', { fiveHour: { usedPct: 5, resetsAt: null } }); // GPT usage: no Claude route changes
    await c.next('usage');
    c.send({ type: 'route_preview', sessionId: null, cwd: work, model: 'sonnet' });
    const fresh = await c.next('route_preview');
    expect(fresh).toEqual(first);
    // Server sends are ordered: a resend for the usage change would sit between that usage and the fresh answer.
    expect(c.got.filter((m) => m.type === 'route_preview')).toHaveLength(2);
    await c.close();
  });

  it('route_preview: { sessionId: null } with no cwd withdraws the ask (no answer after a usage change); a closed socket is forgotten', async () => {
    const srv = await makeServer(1);
    const spy = vi.spyOn(srv.runner, 'previewRoute');
    const c = await client(srv);
    await c.next('hello');
    c.send({ type: 'route_preview', sessionId: null, cwd: work });
    const first = await c.next('route_preview');
    c.send({ type: 'route_preview', sessionId: null });
    // A round trip after the withdrawal: once its answer is in, the withdrawal has been handled.
    c.send({ type: 'refresh_index' });
    await c.next('index');
    spy.mockClear();
    srv.usage.applyTurn(first.account as 'a', { fiveHour: { usedPct: 99, resetsAt: null }, weekly: { usedPct: 99, resetsAt: null } });
    await c.next('usage');
    expect(spy).not.toHaveBeenCalled();
    expect(c.rest().some((m) => m.type === 'route_preview')).toBe(false);

    const d = await client(srv);
    await d.next('hello');
    d.send({ type: 'route_preview', sessionId: null, cwd: work });
    await d.next('route_preview');
    await d.close();
    await new Promise((r) => setTimeout(r, 50)); // the server's close handler runs after the client sees its close
    spy.mockClear();
    srv.usage.applyTurn('b', { fiveHour: { usedPct: 98, resetsAt: null } });
    await c.next('usage');
    expect(spy).not.toHaveBeenCalled();
    await c.close();
  });

  it('a new device gets activity with serverStartedAt right after hello; drain broadcasts draining at once', async () => {
    const srv = await makeServer(12345);
    const c = await client(srv);
    await c.next('hello');
    const a = await c.next('activity');
    expect(a).toMatchObject({ serverStartedAt: 12345, sessions: [] });
    expect(a.draining).toBeUndefined();
    expect(c.got.findIndex((m) => m.type === 'hello')).toBeLessThan(c.got.indexOf(a));
    srv.wsApi.drain();
    expect(await c.next('activity', (m) => m.draining === true)).toMatchObject({ serverStartedAt: 12345 });
    const late = await client(srv);
    await late.next('hello');
    expect(await late.next('activity')).toMatchObject({ draining: true, serverStartedAt: 12345 });
    await c.close();
    await late.close();
  });
});
