import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, GrokStatus, ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { GrokEngineLock } from './engine/GrokEngine';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { testRegistry } from '../shared/accounts.testkit';

// §14.9-3: settings' 잠금 해제 for a tripped Grok engine goes over the socket as `grok_unlock`.

const TOKEN = 'g'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let base: string;
let host: string;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;
const lock = new GrokEngineLock();
let unlocks = 0;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-grok-')));
  const accounts = testRegistry(path.join(base, 'home'));
  const roots = accounts.projectsRoots();
  for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  const grokStatus = (): GrokStatus => ({ bin: true, locked: lock.reason });
  api = attachWebSocket([server], {
    token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: false, cwdRoots: [base], accounts,
    grokStatus, grokUnlock: () => { unlocks++; lock.unlock(); },
  });
  // As main.ts wires it: a lock change is broadcast at once.
  lock.onChange(() => api.broadcast({ type: 'grok_status', grok: grokStatus() }));
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
type Hello = Extract<ServerMessage, { type: 'hello' }>;
type Status = Extract<ServerMessage, { type: 'grok_status' }>;

describe('ws: grok_unlock (§14.9-3)', () => {
  it('a locked engine shows in hello; grok_unlock unlocks it and every device gets grok_status with locked null', async () => {
    lock.lock('grok:write (edit) ran with no permission request');
    const a = await client();
    const b = await client();
    expect((a.got.find((m) => m.type === 'hello') as Hello).grok).toEqual({ bin: true, locked: 'grok:write (edit) ran with no permission request' });
    a.say({ type: 'grok_unlock' });
    for (const c of [a, b]) {
      const s = await c.until<Status>((m) => m.type === 'grok_status');
      expect(s.grok).toEqual({ bin: true, locked: null });
    }
    expect(unlocks).toBe(1);
    expect(lock.reason).toBeNull();
    a.ws.close();
    b.ws.close();
  });
});
