import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { buildRegistry, type AccountRegistry } from '../shared/accounts';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import { cookieValueFor } from './auth';
import { StubEngine, okResult } from './engine/StubEngine';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { SessionStateStore } from './turn/SessionState';
import { TurnRunner } from './turn/TurnRunner';
import { UsageService } from './usage/UsageService';
import { attachWebSocket } from './ws';

const TOKEN = 'a'.repeat(64);
const COOKIE = `deck_session=${cookieValueFor(TOKEN)}`;
const SID = '21212121-2121-4212-8212-212121212121';
let base: string;
let work: string;
let store: SessionStateStore;
let engineAccounts: string[] = [];
const servers: http.Server[] = [];
const apis: ReturnType<typeof attachWebSocket>[] = [];
/** A server with the four-account registry (`reg`) and one without any (the a/b/c defaults). */
let withReg = '';
let legacy = '';

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ws-accounts-')));
  work = path.join(base, 'work');
  await fs.mkdir(work);
  // Profile dirs under the temp dir only: a = <base>/.claude, the others <base>/.claude-<id>.
  const reg = buildRegistry({ version: 1, accounts: [{ id: 'a' }, { id: 'b', label: 'Work' }, { id: 'old', retired: true }, { id: 'd' }] }, { homeDir: base });
  const start = async (accounts: AccountRegistry | undefined, name: string): Promise<string> => {
    const roots: Record<string, string> = accounts ? accounts.projectsRoots() : { a: path.join(base, name, 'a'), b: path.join(base, name, 'b'), c: path.join(base, name, 'c') };
    for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
    const index = new SessionIndex({ roots, pinnedFile: path.join(base, `${name}-p.json`) });
    await index.refresh();
    const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), ...(accounts ? { accounts } : {}) });
    const st = new SessionStateStore(path.join(base, `${name}-state.json`));
    await st.load();
    if (accounts) {
      store = st;
      await st.set({ sessionId: SID, cwd: work, account: 'b', projectDir: path.join(roots.b!, 'p'), lastTurnAtMs: Date.now(), justCompacted: false, defaultModel: 'opus' });
    }
    const engine = new StubEngine(async (req) => { engineAccounts.push(req.account); return [{ kind: 'init', sessionId: 'sess-new', model: 'm' }, okResult('sess-new', 'ok')]; });
    const runner = new TurnRunner({ attachments: null, engine, usage, index, store: st, cooldownDir: path.join(base, `${name}-cd`), protectedAccount: null, auditFile: path.join(base, `${name}-audit.log`), projectsRoots: roots, codex: null, codexSessionsRoot: path.join(base, 'codex-sessions'), ...(accounts ? { accounts } : {}) });
    const server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: base, usage, index }));
    apis.push(attachWebSocket([server], { token: TOKEN, devOrigins: [], runner, index, usage, store: st, codexAvailable: false, cwdRoots: [base], ...(accounts ? { accounts } : {}) }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  withReg = await start(reg, 'reg');
  legacy = await start(undefined, 'legacy');
});
afterAll(async () => { for (const a of apis) a.close(); for (const s of servers) s.close(); await fs.rm(base, { recursive: true, force: true }); });

/** A socket buffering every message from connection time. */
async function client(host: string) {
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
  const say = (m: ClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(m));
  return { ws, got, until, say };
}
type Err = Extract<ServerMessage, { type: 'error' }>;
type Hello = Extract<ServerMessage, { type: 'hello' }>;

describe('ws: accounts from the registry', () => {
  it('hello names the feature and lists every configured account in order, retired included', async () => {
    const c = await client(withReg);
    const hello = await c.until<Hello>((m) => m.type === 'hello');
    expect(hello.features).toContain('accounts');
    expect(hello.accounts).toEqual([
      { id: 'a', label: 'A', home: true, retired: false },
      { id: 'b', label: 'Work', home: false, retired: false },
      { id: 'old', label: 'OLD', home: false, retired: true },
      { id: 'd', label: 'D', home: false, retired: false },
    ]);
    c.ws.close();
  });

  it('a server started without a registry lists a/b/c with a as home', async () => {
    const c = await client(legacy);
    const hello = await c.until<Hello>((m) => m.type === 'hello');
    expect(hello.accounts?.map((a) => [a.id, a.label, a.home, a.retired])).toEqual([['a', 'A', true, false], ['b', 'B', false, false], ['c', 'C', false, false]]);
    c.ws.close();
  });

  it('send.accountPin: an id that is not configured or is retired is refused before any turn starts, saying which and what can be used', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'zz', clientRef: 'r-unknown' });
    const unknown = await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-unknown');
    expect(unknown.message).toBe('설정에 없는 계정이라 고정할 수 없습니다: zz (쓸 수 있는 계정: a, b, d)');
    expect(unknown.turnId).toBeNull();
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'old', clientRef: 'r-retired' });
    const retired = await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-retired');
    expect(retired.message).toBe('설정에서 뺀(retired) 계정이라 고정할 수 없습니다: old (쓸 수 있는 계정: a, b, d)');
    // c is an account of the default three, not of this server.
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'c', clientRef: 'r-c' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-c')).message).toContain('설정에 없는 계정');
    expect(c.got.some((m) => m.type === 'turn_started')).toBe(false);
    expect(engineAccounts).toEqual([]);
    c.ws.close();
  });

  it('send.accountPin: a fourth account runs the turn on it; a malformed id is a schema error and the socket stays open', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'Bad Id', clientRef: 'r-shape' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-shape')).message).not.toContain('설정에 없는');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'd', clientRef: 'r-d' });
    await c.until((m) => m.type === 'turn_result');
    expect(engineAccounts).toEqual(['d']);
    c.ws.close();
  });

  it('set_account_pin: unknown and retired ids are refused with the session id and nothing is stored; a fourth account is stored and broadcast', async () => {
    const c = await client(withReg);
    await c.until((m) => m.type === 'hello');
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'zz' });
    const unknown = await c.until<Err>((m) => m.type === 'error' && m.message.includes('zz'));
    expect(unknown).toMatchObject({ sessionId: SID, turnId: null, message: '설정에 없는 계정이라 고정할 수 없습니다: zz (쓸 수 있는 계정: a, b, d)' });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'old' });
    const retired = await c.until<Err>((m) => m.type === 'error' && m.message.includes('old'));
    expect(retired).toMatchObject({ sessionId: SID, message: '설정에서 뺀(retired) 계정이라 고정할 수 없습니다: old (쓸 수 있는 계정: a, b, d)' });
    expect(store.get(SID)).not.toHaveProperty('accountPin');
    expect(c.got.some((m) => m.type === 'account_pin')).toBe(false);
    c.say({ type: 'set_account_pin', sessionId: SID, pin: 'd' });
    expect(await c.until((m) => m.type === 'account_pin')).toEqual({ type: 'account_pin', sessionId: SID, pin: 'd' });
    expect(store.get(SID)).toMatchObject({ accountPin: 'd' });
    c.say({ type: 'set_account_pin', sessionId: SID, pin: null });
    await c.until((m) => m.type === 'account_pin' && m.pin === null);
    c.ws.close();
  });

  it('the default a/b/c server: an old UI\'s pins still pass; a fourth id is refused', async () => {
    const c = await client(legacy);
    await c.until((m) => m.type === 'hello');
    engineAccounts = [];
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'c' });
    await c.until((m) => m.type === 'turn_result');
    expect(engineAccounts).toEqual(['c']);
    c.say({ type: 'send', sessionId: null, cwd: work, text: 'hi', accountPin: 'd', clientRef: 'r-d' });
    expect((await c.until<Err>((m) => m.type === 'error' && m.clientRef === 'r-d')).message).toBe('설정에 없는 계정이라 고정할 수 없습니다: d (쓸 수 있는 계정: a, b, c)');
    c.ws.close();
  });
});
