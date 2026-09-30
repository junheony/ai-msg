import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from './auth';
import { AttachmentStore } from './attachments/AttachmentStore';
import { createRequestHandler } from './http';
import { SessionIndex } from './sessions/SessionIndex';
import { UsageService } from './usage/UsageService';

const TOKEN = 'e'.repeat(64);
let base = '';
let server: http.Server;
let uiDir: string;

beforeAll(async () => {
  uiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-ui-'));
  const roots = { a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') };
  const index = new SessionIndex({ roots, pinnedFile: path.join(uiDir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const attachments = new AttachmentStore(path.join(uiDir, 'att'));
  await attachments.init();
  server = http.createServer(createRequestHandler({ token: TOKEN, uiDir, usage, index, devOrigins: ['http://dev.local'], attachments }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

describe('http', () => {
  it('refuses API without a cookie', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
  });

  // Deviation (added per review I5): SameSite=Strict doesn't separate ports, so every
  // state-changing /api/* request must also carry a same-origin Origin (or Sec-Fetch-Site).
  it('rejects state-changing requests with a missing or foreign-port Origin', async () => {
    const missing = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(missing.status).toBe(403);
    const foreignPort = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' }, body: JSON.stringify({ token: TOKEN }) });
    expect(foreignPort.status).toBe(403);
    const foreignHost = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ token: TOKEN }) });
    expect(foreignHost.status).toBe(403);
  });

  // Deviation (added per review I5): DNS-rebinding defence — a Host deck doesn't bind to is
  // rejected outright, even for a plain GET, even though the request's own Origin would match it.
  // fetch() treats Host as a forbidden header and silently drops an override, so this uses
  // node:http directly (setHost: false) to actually send a foreign Host.
  it('rejects a foreign Host outright', async () => {
    const addr = server.address() as { port: number };
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/me', method: 'GET', setHost: false, headers: { host: 'evil.example', cookie: `deck_session=${cookieValueFor(TOKEN)}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('login with a wrong token → 401, right token → cookie, then API works', async () => {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const good = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: TOKEN }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`deck_session=${cookieValueFor(TOKEN)}`);
    expect(cookie).toContain('HttpOnly');
    const me = await fetch(`${base}/api/me`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
    expect(me.status).toBe(200);
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
    expect(boot.status).toBe(200);
    const body = (await boot.json()) as { usage: { accounts: object }; projects: unknown[] };
    expect(Object.keys(body.usage.accounts)).toEqual(['a', 'b', 'c']);
    expect(body.projects).toEqual([]);
    // A dev origin (Vite) must also be accepted for a state-changing request.
    const devLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://dev.local' }, body: JSON.stringify({ token: TOKEN }) });
    expect(devLogin.status).toBe(200);
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { origin: base } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('serves the UI when built, 503 when not, never outside uiDir', async () => {
    expect((await fetch(`${base}/`)).status).toBe(503);
    await fs.writeFile(path.join(uiDir, 'index.html'), '<html>deck</html>');
    await fs.mkdir(path.join(uiDir, 'assets'));
    await fs.writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)');
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>deck</html>');
    expect(await (await fetch(`${base}/some/spa/route`)).text()).toBe('<html>deck</html>');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    // fetch() normalizes '..' itself; the encoded form reaches the server as-is. Either way only index.html comes back, never package.json.
    expect(await (await fetch(`${base}/assets/../../package.json`)).text()).toBe('<html>deck</html>');
    expect(await (await fetch(`${base}/assets/%2e%2e/%2e%2e/package.json`)).text()).toBe('<html>deck</html>');
  });

  it('every response carries CSP, nosniff and no-referrer — static, API, and error responses', async () => {
    const CSP = "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
    await fs.writeFile(path.join(uiDir, 'index.html'), '<html>deck</html>');
    const cookie = `deck_session=${cookieValueFor(TOKEN)}`;
    for (const r of [await fetch(`${base}/`), await fetch(`${base}/api/me`), await fetch(`${base}/api/bootstrap`, { headers: { cookie } }), await fetch(`${base}/api/nope`, { headers: { cookie } })]) {
      expect(r.headers.get('content-security-policy')).toBe(CSP);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('a 500 returns a generic body and keeps the detail in the server log', async () => {
    const roots = { a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') };
    const index = new SessionIndex({ roots, pinnedFile: path.join(uiDir, 'p.json') });
    const usage = { snapshot: () => { throw new Error('SECRET-DETAIL /Users/max/.claude-b'); } } as unknown as UsageService;
    const s2 = http.createServer(createRequestHandler({ token: TOKEN, uiDir, usage, index }));
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const logged: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const r = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/api/bootstrap`, { headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` } });
      expect(r.status).toBe(500);
      const body = await r.text();
      expect(body).not.toContain('SECRET-DETAIL');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(JSON.stringify(logged.map(String))).toContain('SECRET-DETAIL');
    } finally {
      console.error = orig;
      s2.close();
    }
  });
});

describe('POST /api/attachments (D7)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `deck_session=${cookieValueFor(TOKEN)}`, origin: base, 'content-type': 'application/octet-stream', ...extra });

  it('needs a cookie and a same-origin Origin', async () => {
    expect((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { origin: base }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie: `deck_session=${cookieValueFor(TOKEN)}` }, body: PNG })).status).toBe(403);
  });

  it('stores an upload and returns its id; the name is sanitized; oversize is 413', async () => {
    const res = await fetch(`${base}/api/attachments`, { method: 'POST', headers: headers({ 'x-deck-filename': encodeURIComponent('../스크린샷.png') }), body: PNG });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; mediaType: string; size: number; isImage: boolean };
    expect(body).toMatchObject({ name: '스크린샷.png', mediaType: 'image/png', size: PNG.length, isImage: true });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    const big = await fetch(`${base}/api/attachments`, { method: 'POST', headers: headers({ 'x-deck-filename': 'big.bin' }), body: Buffer.alloc(10 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  /**
   * Fix round 1 finding 1 regression: a *realistic* oversized upload — tens of MiB, written to
   * the socket in chunks like a real client, rather than fetch()'s single in-memory Buffer body
   * — used to get ECONNRESET/EPIPE instead of ever seeing the 413 (a `connection: close`
   * header made Node auto-destroy the socket on `res` 'finish' while the body was still
   * arriving, RSTing the still-unread bytes). Drives node:http directly so both a declared
   * Content-Length and a chunked (no Content-Length) transfer can be exercised, and streams
   * the body progressively rather than handing it to fetch() as one Buffer.
   */
  function uploadRaw(size: number, opts: { declareLength?: boolean } = {}): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const addr = server.address() as { port: number };
      const reqHeaders: Record<string, string> = {
        cookie: `deck_session=${cookieValueFor(TOKEN)}`,
        origin: base,
        'content-type': 'application/octet-stream',
        'x-deck-filename': 'big.bin',
      };
      if (opts.declareLength !== false) reqHeaders['content-length'] = String(size);
      const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/api/attachments', method: 'POST', headers: reqHeaders }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
      const chunkSize = 1024 * 1024;
      let remaining = size;
      const writeNext = () => {
        if (remaining <= 0) { req.end(); return; }
        const n = Math.min(chunkSize, remaining);
        remaining -= n;
        const ok = req.write(Buffer.alloc(n));
        if (ok) setImmediate(writeNext);
        else req.once('drain', writeNext);
      };
      writeNext();
    });
  }

  const OVERSIZE = 21 * 1024 * 1024; // > MAX_ATTACHMENT_BYTES (10 MiB), well above the brief's 20 MiB floor

  it('a realistic oversized upload with a declared Content-Length gets a clean 413, not ECONNRESET', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await uploadRaw(OVERSIZE, { declareLength: true });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text)).toMatchObject({ error: expect.stringContaining('MiB') });
    }
  }, 30000);

  it('a realistic oversized upload sent chunked (no Content-Length) also gets a clean 413, not ECONNRESET', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await uploadRaw(OVERSIZE, { declareLength: false });
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text)).toMatchObject({ error: expect.stringContaining('MiB') });
    }
  }, 30000);
});
