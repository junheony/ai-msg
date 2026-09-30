import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/protocol';
import { cookieValueFor } from '../../src/server/auth';
import { projectSlug } from '../../src/server/sessions/slug';

const PORT = 9400 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let cfgDir: string;
let workDir: string;
let cookie: string;
const home = os.homedir();
const roots = [path.join(home, '.claude/projects'), path.join(home, '.claude-b/projects'), path.join(home, '.claude-c/projects')];

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout');
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: BASE } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Deviation (evidence-based fix, not a plan/review item — see src/server/ws.test.ts for the
// full analysis): the server's first WS frame can be delivered in the same client-side read
// as the upgrade response, so 'open' and 'message' can fire in one synchronous turn, before a
// listener attached after `await connect()` sees it. Buffer from connection time to avoid the
// race; behaviour and all assertions below are unchanged.
const buffers = new WeakMap<WebSocket, unknown[]>();

function collect(ws: WebSocket, until: (m: ServerMessage) => boolean, timeoutMs = 150_000): Promise<ServerMessage[]> {
  if (!buffers.has(ws)) {
    const buf: unknown[] = [];
    buffers.set(ws, buf);
    ws.on('message', (d) => buf.push(d));
  }
  return new Promise((resolve, reject) => {
    const out: ServerMessage[] = [];
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error(`timeout after ${out.length} msgs: ${JSON.stringify(out.slice(-3)).slice(0, 500)}`)); } }, timeoutMs);
    const consume = (d: unknown) => {
      if (done) return;
      const m = JSON.parse(String(d)) as ServerMessage;
      out.push(m);
      if (until(m)) { done = true; clearTimeout(t); resolve(out); }
    };
    const buf = buffers.get(ws)!;
    const pending = buf.splice(0, buf.length);
    for (const d of pending) consume(d);
    if (!done) ws.on('message', consume);
  });
}

beforeAll(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-cfg-'));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-e2e-work-'));
  // Deviation (evidence-based fix, not a plan/review item): on macOS os.tmpdir() is under
  // /var/folders, a symlink to /private/var/folders. The Claude Code CLI resolves cwd to its
  // real path before recording it (confirmed: the session's jsonl "cwd" field and its project
  // dir slug both use /private/var/...), so comparing against the unresolved workDir made the
  // project lookup below always miss. Resolving once up front keeps every later comparison and
  // the projectSlug-based cleanup consistent with what the CLI actually wrote.
  workDir = await fs.realpath(workDir);
  child = spawn('npx', ['tsx', 'src/server/main.ts'], {
    cwd: process.cwd(), // npm run test:e2e runs from the repo root
    env: { ...process.env, DECK_CONFIG_DIR: cfgDir, DECK_PORT: String(PORT), DECK_LOOPBACK_ONLY: '1', DECK_UI_DIR: cfgDir, CLAUDE_PICK_COOLDOWN_DIR: path.join(cfgDir, 'cooldown') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(async () => (await fetch(`${BASE}/api/me`)).status === 401, 30_000);
  const token = (await fs.readFile(path.join(cfgDir, 'token'), 'utf8')).trim();
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ token }) });
  expect(res.status).toBe(200);
  cookie = `deck_session=${cookieValueFor(token)}`;
});

afterAll(async () => {
  child.kill('SIGTERM');
  for (const r of roots) await fs.rm(path.join(r, projectSlug(workDir)), { recursive: true, force: true });
  await fs.rm(cfgDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('deck e2e (real accounts)', () => {
  let sessionId = '';

  it('new session: "Reply with exactly: ok" → reply ok, badge names the account, session appears in the index', async () => {
    const ws = await connect();
    await collect(ws, (m) => m.type === 'hello');
    const p = collect(ws, (m) => m.type === 'index');
    ws.send(JSON.stringify({ type: 'send', sessionId: null, cwd: workDir, text: 'Reply with exactly: ok', model: 'sonnet' }));
    const msgs = await p;
    const result = msgs.find((m) => m.type === 'turn_result') as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(['a', 'b', 'c']).toContain(result.badge!.account);
    expect(result.badge!.model).toBe('sonnet');
    expect(result.badge!.usage.outputTokens).toBeGreaterThan(0);
    expect(result.badge!.reason.length).toBeGreaterThan(0);
    console.log(`e2e turn 1 ran on ${result.badge!.account.toUpperCase()} — ${result.badge!.reason}`);
    sessionId = result.sessionId ?? '';
    const index = msgs.at(-1) as Extract<ServerMessage, { type: 'index' }>;
    const project = index.projects.find((pj) => pj.cwd === workDir);
    expect(project?.sessions.map((s) => s.sessionId)).toContain(sessionId);
    ws.close();
  });

  it('open the imported session, then resume it with another turn', async () => {
    const ws = await connect();
    await collect(ws, (m) => m.type === 'hello');
    const ph = collect(ws, (m) => m.type === 'history');
    ws.send(JSON.stringify({ type: 'open_session', sessionId }));
    const history = (await ph).at(-1) as Extract<ServerMessage, { type: 'history' }>;
    expect(history.messages.some((m) => m.kind === 'user' && m.text.includes('Reply with exactly: ok'))).toBe(true);
    expect(history.messages.some((m) => m.kind === 'assistant' && m.text.trim().toLowerCase() === 'ok')).toBe(true);
    const pr = collect(ws, (m) => m.type === 'turn_result');
    ws.send(JSON.stringify({ type: 'send', sessionId, cwd: workDir, text: 'Reply with exactly: ok', model: 'sonnet' }));
    const result = (await pr).at(-1) as Extract<ServerMessage, { type: 'turn_result' }>;
    expect(result.ok).toBe(true);
    expect(result.text.trim().toLowerCase()).toBe('ok');
    expect(result.sessionId).toBe(sessionId);
    console.log(`e2e turn 2 ran on ${result.badge!.account.toUpperCase()} — ${result.badge!.reason}`);
    ws.close();
  });
});
