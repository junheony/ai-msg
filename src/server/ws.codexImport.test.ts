import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { LIVE_ROLLOUT_NOTICE } from './sessions/CodexImports';
import { SessionIndex } from './sessions/SessionIndex';
import { CLI_ID, DESKTOP_ID, writeFixtures } from './sessions/codexFixtures';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';

const TOKEN = 'c'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
let server: http.Server;
let origin = '';
let wsUrl = '';
let wsApi: ReturnType<typeof attachWebSocket>;
let base: string;
let work: string;
let files: { desktop: string; cli: string };

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-import-'));
  work = path.join(base, 'work');
  await fs.mkdir(work);
  const root = path.join(base, 'codex-sessions');
  files = await writeFixtures(root, work);
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(files.cli, old, old);
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json'), codexRoot: root });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const runner = new TurnRunner({ attachments: null, engine: new StubEngine(async () => []), usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: root });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  wsApi = attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store, codexAvailable: true, cwdRoots: [base] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(async () => { wsApi.close(); server.close(); await fs.rm(base, { recursive: true, force: true }); });

/** A socket buffering every message from connection time. */
async function client() {
  const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: COOKIE } });
  const got: ServerMessage[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const until = async (pred: (m: ServerMessage) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = got.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout; got ${JSON.stringify(got.map((m) => m.type))}`);
  };
  return { ws, got, until };
}

describe('ws: imported Codex threads', () => {
  it('hello lists them under their project with the imported flag', async () => {
    const c = await client();
    const hello = (await c.until((m) => m.type === 'hello')) as Extract<ServerMessage, { type: 'hello' }>;
    const sessions = hello.projects.find((p) => p.cwd === work)?.sessions ?? [];
    expect(sessions.map((s) => [s.sessionId, s.account, s.engine, s.imported])).toEqual(expect.arrayContaining([[DESKTOP_ID, 'gpt', 'codex', true], [CLI_ID, 'gpt', 'codex', true]]));
    c.ws.close();
  });

  it('open_session renders the rollout as Codex history and warns when it changed in the last 2 minutes', async () => {
    const c = await client();
    await c.until((m) => m.type === 'hello');
    c.ws.send(JSON.stringify({ type: 'open_session', sessionId: DESKTOP_ID }));
    const h = (await c.until((m) => m.type === 'history')) as Extract<ServerMessage, { type: 'history' }>;
    expect(h).toMatchObject({ sessionId: DESKTOP_ID, cwd: work, account: 'gpt', engine: 'codex', sandbox: 'read-only', runningTurnId: null });
    expect(h.messages.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(h.messages[0]).toMatchObject({ kind: 'user', text: expect.stringContaining('스크린샷의 버그 고쳐줘') });
    expect(await c.until((m) => m.type === 'turn_notice')).toMatchObject({ sessionId: DESKTOP_ID, message: LIVE_ROLLOUT_NOTICE });
    c.ws.close();
  });

  it('no notice for a rollout idle for longer', async () => {
    const c = await client();
    await c.until((m) => m.type === 'hello');
    c.ws.send(JSON.stringify({ type: 'open_session', sessionId: CLI_ID }));
    const h = (await c.until((m) => m.type === 'history')) as Extract<ServerMessage, { type: 'history' }>;
    expect(h.messages).toEqual([{ kind: 'user', text: 'List the files', ts: null }, { kind: 'assistant', text: 'a.txt', model: null, toolCalls: [], ts: null }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(c.got.some((m) => m.type === 'turn_notice')).toBe(false);
    c.ws.close();
  });
});
