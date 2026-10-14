import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionMetaStore } from './sessions/SessionMetaStore';
import { projectSlug } from './sessions/slug';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';
import { testRegistry } from '../shared/accounts.testkit';

const TOKEN = 'c'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
const GPT = '51515151-5151-4515-8515-515151515151';
const CLAUDE = '52525252-5252-4525-8525-525252525252';
const NEW = '53535353-5353-4535-8535-535353535353';
let base: string;
let work: string;
let work2: string;
let projectsA: string;
let host: string;
let store: SessionStateStore;
let meta: SessionMetaStore;
let server: http.Server;
let api: ReturnType<typeof attachWebSocket>;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-ops-')));
  work = path.join(base, 'work');
  work2 = path.join(base, 'work2');
  await fs.mkdir(work);
  await fs.mkdir(work2);
  const accounts = testRegistry(path.join(base, 'home'));
  const roots = accounts.projectsRoots();
  for (const r of roots) await fs.mkdir(r.dir, { recursive: true });
  projectsA = accounts.projectsDir('a');
  const dir = path.join(projectsA, projectSlug(work));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${CLAUDE}.jsonl`), JSON.stringify({ type: 'user', cwd: work, message: { role: 'user', content: '원래 대화' } }) + '\n');
  meta = new SessionMetaStore(path.join(base, 'meta.json'));
  await meta.load();
  await meta.update(CLAUDE, { title: '원래 제목' });
  const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json'), meta });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), accounts });
  store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  await store.set({ engine: 'codex', sessionId: GPT, cwd: work, lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-astra', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
  await store.set({ sessionId: CLAUDE, cwd: work, account: 'a', projectDir: dir, lastTurnAtMs: 1, justCompacted: false, defaultModel: 'fable', accountPin: 'b', mode: 'acceptEdits' });
  const engine = new StubEngine(async () => [{ kind: 'init', sessionId: NEW, model: 'claude-opus-5-5' }, { kind: 'delta', text: 'ok' }, okResult(NEW)]);
  const runner = new TurnRunner({ attachments: null, engine, usage, index, store, cooldownDir: path.join(base, 'cd'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), accounts });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
  api = attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store, meta, codexAvailable: false, cwdRoots: [base], accounts });
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
type Err = Extract<ServerMessage, { type: 'error' }>;
type Dup = Extract<ServerMessage, { type: 'session_duplicate' }>;
type Result = Extract<ServerMessage, { type: 'turn_result' }>;
type Index = Extract<ServerMessage, { type: 'index' }>;

describe('ws: duplicate_session (복제)', () => {
  it('answers the sender only with the original\'s folder, engine, model, account settings and "<제목> (복사)"', async () => {
    const a = await client();
    const b = await client();
    expect((a.got.find((m) => m.type === 'hello') as Hello).features).toContain('sessionOps');
    a.say({ type: 'duplicate_session', sessionId: CLAUDE });
    expect(await a.until<Dup>((m) => m.type === 'session_duplicate')).toEqual({ type: 'session_duplicate', from: CLAUDE, cwd: work, engine: 'claude', model: 'fable', title: '원래 제목 (복사)', accountPin: 'b', permissionMode: 'acceptEdits' });
    a.got.length = 0;
    a.say({ type: 'duplicate_session', sessionId: GPT });
    expect(await a.until<Dup>((m) => m.type === 'session_duplicate')).toMatchObject({ from: GPT, cwd: work, engine: 'codex', model: 'gpt-6-astra', sandbox: 'read-only' });
    a.say({ type: 'duplicate_session', sessionId: '59595959-5959-4595-8595-595959595959' });
    await a.until<Err>((m) => m.type === 'error' && m.message.includes('복제할 수 없는'));
    await new Promise((r) => setTimeout(r, 50));
    expect(b.got.some((m) => m.type === 'session_duplicate')).toBe(false);
    a.ws.close(); b.ws.close();
  });

  it('a new session\'s send `title` names it once it has an id; turn_result carries the turn\'s model', async () => {
    const a = await client();
    a.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', engine: 'claude', title: '원래 제목 (복사)', clientRef: 'r-dup-1' });
    const res = await a.until<Result>((m) => m.type === 'turn_result');
    expect(res.ok).toBe(true);
    expect(res.model).toBe(res.badge?.model);
    expect(typeof res.model).toBe('string');
    const end = Date.now() + 2000;
    while (meta.title(NEW) === null && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(meta.title(NEW)).toBe('원래 제목 (복사)');
    a.ws.close();
  });
});

describe('ws: set_cwd (작업 폴더 바꾸기)', () => {
  it('refuses a missing folder and one outside the allowed roots; nothing changes', async () => {
    const a = await client();
    a.say({ type: 'set_cwd', sessionId: CLAUDE, cwd: path.join(base, 'nope') });
    await a.until<Err>((m) => m.type === 'error' && m.sessionId === CLAUDE);
    a.got.length = 0;
    a.say({ type: 'set_cwd', sessionId: CLAUDE, cwd: '/' });
    await a.until<Err>((m) => m.type === 'error' && m.sessionId === CLAUDE);
    expect(store.get(CLAUDE)).toMatchObject({ cwd: work });
    a.ws.close();
  });

  it('moves the Claude session to the new folder, tells every device (session_cwd + index) and the next history uses it', async () => {
    const a = await client();
    const b = await client();
    a.say({ type: 'set_cwd', sessionId: CLAUDE, cwd: work2 });
    expect(await b.until((m) => m.type === 'session_cwd')).toEqual({ type: 'session_cwd', sessionId: CLAUDE, cwd: work2 });
    await a.until((m) => m.type === 'session_cwd');
    expect(store.get(CLAUDE)).toMatchObject({ cwd: work2, projectDir: path.join(projectsA, projectSlug(work2)), accountPin: 'b' });
    expect(await fs.stat(path.join(projectsA, projectSlug(work2), `${CLAUDE}.jsonl`)).then(() => true, () => false)).toBe(true);
    expect(meta.cwd(CLAUDE)).toBe(work2);
    const idx = await b.until<Index>((m) => m.type === 'index' && m.projects.some((p) => p.cwd === work2));
    expect(idx.projects.find((p) => p.cwd === work2)!.sessions.map((s) => s.sessionId)).toContain(CLAUDE);
    a.ws.close(); b.ws.close();
  });

  it('a Codex session takes the new cwd too', async () => {
    const a = await client();
    a.say({ type: 'set_cwd', sessionId: GPT, cwd: work2 });
    await a.until((m) => m.type === 'session_cwd' && m.sessionId === GPT);
    expect(store.get(GPT)).toMatchObject({ cwd: work2 });
    a.ws.close();
  });
});
