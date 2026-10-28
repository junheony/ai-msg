import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';
import { rootsOf, testRegistry } from '../shared/accounts.testkit';
import { AuthLoginHub, type AuthPty } from './authLogin/hub';
import type { AuthAccounts } from './authLogin/spec';

const TOKEN = 't'.repeat(64);
let base = '';
let server: http.Server;
let dir: string;
const cookie = `deck_session=${cookieValueFor(TOKEN)}`;

class FakePty implements AuthPty {
  written = '';
  private data: ((s: string) => void) | null = null;
  private exit: ((c: number | null) => void) | null = null;
  write(text: string): void {
    this.written += text;
    this.data?.(`echo:${text}`);
    if (text.startsWith('OK')) this.exit?.(0);
  }
  kill(): void { this.exit?.(null); }
  onData(cb: (text: string) => void): void { this.data = cb; }
  onExit(cb: (code: number | null) => void): void { this.exit = cb; }
  push(text: string): void { this.data?.(text); }
}

let pty: FakePty | null = null;
const accounts: AuthAccounts = {
  has: (id) => id === 'a' || id === 'b',
  isRetired: () => false,
  isHome: (id) => id === 'a',
  profileDir: (id) => (id === 'a' ? '/h/.claude' : `/h/.claude-${id}`),
  label: (id) => id.toUpperCase(),
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-http-auth-'));
  const index = new SessionIndex({ roots: rootsOf({ a: path.join(dir, 'a') }), pinnedFile: path.join(dir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const authLogin = new AuthLoginHub({
    accounts, home: '/h', bins: { claude: '/usr/bin/claude', codex: null, grok: null }, baseEnv: { PATH: '/bin', HOME: '/h' },
    spawn: () => { pty = new FakePty(); return pty; },
  });
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir: dir, usage, index, authLogin }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, ...headers }, body: JSON.stringify(body),
});

describe('/api/auth-login', () => {
  it('requires login and a same-origin POST', async () => {
    expect((await fetch(`${base}/api/auth-login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"seat":"a"}' })).status).toBe(401);
    expect((await post('/api/auth-login', { seat: 'a' }, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('runs only the seat\'s login command: the pasted code is stdin, a second line is refused, the URL is streamed', async () => {
    const started = await post('/api/auth-login', { seat: 'b' });
    expect(started.status).toBe(200);
    const body = await started.json() as { id: string; label: string };
    expect(body.label).toBe('CLAUDE_CONFIG_DIR=~/.claude-b claude auth login');
    expect((await post('/api/auth-login', { seat: 'a' })).status).toBe(409);

    pty!.push('open https://claude.ai/login?code=1\n');
    const stream = await fetch(`${base}/api/auth-login/${body.id}/stream`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const bad = await post(`/api/auth-login/${body.id}/input`, { text: 'rm -rf /\nid' });
    expect(bad.status).toBe(400);
    expect(pty!.written).toBe('');

    const reader = stream.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readSome = async () => {
      const step = await reader.read();
      if (!step.done) text += dec.decode(step.value, { stream: true });
    };
    await readSome();
    expect(text).toContain('https://claude.ai/login');

    expect((await post(`/api/auth-login/${body.id}/input`, { text: 'OK-CODE' })).status).toBe(200);
    expect(pty!.written).toBe('OK-CODE\n');
    const deadline = Date.now() + 2000;
    while (!text.includes('event: exit') && Date.now() < deadline) await readSome();
    expect(text).toContain('event: exit');
    await reader.cancel();
  });

  it('a missing window is 404', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await fetch(`${base}/api/auth-login/${id}/stream`, { headers: { cookie } })).status).toBe(404);
    expect((await post(`/api/auth-login/${id}/cancel`, {})).status).toBe(404);
  });
});
