import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cookieValueFor } from '../auth';
import { AttachmentStore } from '../attachments/AttachmentStore';
import { createRequestHandler, SECURITY_HEADERS } from '../http';
import { SessionIndex } from '../sessions/SessionIndex';
import { UsageService } from '../usage/UsageService';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';
import { LAB_EMBED_CSP, LAB_EMBED_MAX_BYTES, LAB_GATEWAY_PORT, LAB_OFFLINE_TEXT, labPathVerdict, neutralizeLabLinks } from './labEmbed';

const TOKEN = 'e'.repeat(64);
const COOKIE = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
let upstream: http.Server, server: http.Server, deadServer: http.Server;
let base = '', deadBase = '';

/** The raw request-target matters here, so no client that would normalise it first. */
const rawGet = (url: string, target: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  const u = new URL(url);
  const r = http.request({ host: u.hostname, port: u.port, path: target, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  r.on('error', reject);
  r.end();
});

async function handlerFor(labEmbedPort: number, withHub = true) {
  const uiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-labembed-'));
  await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html>shell');
  const index = new SessionIndex({ roots: rootsOf({ a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') }), pinnedFile: path.join(uiDir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const attachments = new AttachmentStore(path.join(uiDir, 'att'));
  await attachments.init();
  return createRequestHandler({
    token: TOKEN, uiDir, usage, index, attachments, build: () => null, version: '0.1.0-test',
    ...(withHub ? { hub: { status: { status: async () => ({ modes: [], host: 'h', generated_at: '2026-11-02T00:00:00.000Z' }) }, labEmbedPort } } : {}),
  });
}
const listen = async (s: http.Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return (s.address() as { port: number }).port; };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p === '/lab') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'lab_user=dev; Path=/lab', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'", etag: '"1"', server: 'py', 'x-summary-cache': 'hit', location: '/elsewhere' });
      res.end('<a href="/lab/live">탭</a><a class="chip hide-m" href="/lab/dev-login?u=dev">로그인(스텁)</a><a class="chip" href="http://127.0.0.1:8783/app" target="_blank" rel="noopener">v5</a>');
      return;
    }
    if (p === '/lab/api/summary') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":"<a href=\\"http://127.0.0.1:1/\\">"}'); return; }
    if (p === '/lab/moved') { res.writeHead(302, { location: 'http://evil.example/', 'set-cookie': 'x=1' }); res.end(); return; }
    if (p === '/lab/huge') { res.writeHead(200, { 'content-type': 'text/plain' }); const c = 'a'.repeat(1024 * 1024); for (let i = 0; i < 17; i += 1) res.write(c); res.end(); return; }
    if (p === '/lab/sized') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(LAB_EMBED_MAX_BYTES + 1) }); res.flushHeaders(); return; }
    if (p === '/lab/gone') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' }); res.write('part'); setTimeout(() => res.destroy(), 10); return; }
    if (p === '/lab/api/coach/api/coach') { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"error":"입력 오류"}'); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  const port = await listen(upstream);
  server = http.createServer(await handlerFor(port));
  base = `http://127.0.0.1:${await listen(server)}`;
  deadServer = http.createServer(await handlerFor(1));
  deadBase = `http://127.0.0.1:${await listen(deadServer)}`;
});
afterAll(() => { server.close(); deadServer.close(); upstream.closeAllConnections(); upstream.close(); });

describe('/lab relay gates', () => {
  it('needs the session cookie: a bearer or the lab cookie does not open it, and nothing reaches the gateway', async () => {
    const before = seen.length;
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }, { cookie: 'lab_user=dev' }] as Record<string, string>[]) {
      for (const p of ['/lab', '/lab/live', '/lab/api/summary']) expect((await fetch(`${base}${p}`, { headers })).status).toBe(401);
    }
    expect(seen.length).toBe(before);
  });
  it('is GET only, signed in or not, and never passes another method on', async () => {
    const before = seen.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      for (const headers of [{}, { ...COOKIE, origin: base }]) {
        const res = await fetch(`${base}/lab/api/coach/api/coach`, { method, headers });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET');
      }
    }
    expect(seen.length).toBe(before);
  });
  it('does not take over neighbouring paths', async () => {
    const res = await fetch(`${base}/laboratory`, { headers: COOKIE });
    expect(await res.text()).toContain('shell');
    expect(res.headers.get('content-security-policy')).toBe(SECURITY_HEADERS['content-security-policy']);
  });
  it('answers 404 when the hub is not configured', async () => {
    const off = http.createServer(await handlerFor(1, false));
    const res = await fetch(`http://127.0.0.1:${await listen(off)}/lab`, { headers: COOKIE });
    off.close();
    expect(res.status).toBe(404);
  });
});

describe('/lab relay paths', () => {
  it('classifies paths with no encoding or dot segment let through', () => {
    for (const p of ['/lab', '/lab/', '/lab/live', '/lab/static/ui_theme_v1/tokens.css', '/lab/api/ledger/ledger/verify']) expect(labPathVerdict(p)).toBe('ok');
    for (const p of ['/lab/..', '/lab/../x', '/lab/.', '/lab/.env', '/lab/a/../../b', '/lab/%2e%2e/x', '/lab/..%2f..%2fetc', '/lab/a%2Fb', '/lab/a;b', '/lab//x', '/lab/a\\b', '/lab/a b', '/lab/a%0d%0ab', '/labx', '/api/x']) expect(labPathVerdict(p)).toBe('bad');
    for (const p of ['/lab/dev-login', '/lab/dev-login/', '/lab/api/token']) expect(labPathVerdict(p)).toBe('denied');
  });
  it('refuses escapes and the stub login before contacting the gateway', async () => {
    const before = seen.length;
    expect((await fetch(`${base}/lab/..%2f..%2fetc%2fpasswd`, { headers: COOKIE })).status).toBe(400);
    expect((await fetch(`${base}/lab/a%2Fb`, { headers: COOKIE })).status).toBe(400);
    expect((await fetch(`${base}/lab/dev-login;x`, { headers: COOKIE })).status).toBe(400);
    expect((await fetch(`${base}/lab/dev-login?u=dev`, { headers: COOKIE })).status).toBe(403);
    expect((await fetch(`${base}/lab/dev%2Dlogin?u=dev`, { headers: COOKIE })).status).toBe(400);
    expect(seen.length).toBe(before);
  });
  it('cannot be pointed at another host, in the Host header or the request target', async () => {
    seen.length = 0;
    const port = new URL(base).port;
    expect(await rawGet(base, 'http://evil.example:9/lab', { ...COOKIE, host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawGet(base, '//evil.example/lab', { ...COOKIE, host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawGet(base, '/lab', { ...COOKIE, host: 'evil.example' })).toBe(421);
    expect(seen.map((s) => s.url)).toEqual(['/lab', '/lab']);
    expect(seen.every((s) => s.headers.host?.startsWith('127.0.0.1:'))).toBe(true);
    expect(LAB_GATEWAY_PORT).toBe(8792);
  });
});

describe('/lab relay requests and responses', () => {
  it('passes the query, but no credential or forwarded header, to the gateway', async () => {
    seen.length = 0;
    await fetch(`${base}/lab/api/summary?limit=5`, { headers: { ...COOKIE, authorization: 'Bearer secret', 'x-lab-user': 'admin', 'x-lab-tier': 'pro', 'x-forwarded-for': '1.2.3.4', 'user-agent': 'me', referer: `${base}/`, accept: 'application/json' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/lab/api/summary?limit=5' });
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host']);
  });
  it('sends only safe headers back: its own CSP, no Set-Cookie or upstream framing rules', async () => {
    const res = await fetch(`${base}/lab`, { headers: COOKIE, redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(LAB_EMBED_CSP);
    expect(LAB_EMBED_CSP).toContain("frame-ancestors 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    for (const h of ['set-cookie', 'x-frame-options', 'etag', 'server', 'x-summary-cache', 'location']) expect(res.headers.get(h)).toBeNull();
  });
  it('leaves the global CSP as it was', async () => {
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await fetch(`${base}/api/me`, { headers: COOKIE })).headers.get('content-security-policy')).toBe(SECURITY_HEADERS['content-security-policy']);
  });
  it('neutralizes dead links in pages only, and keeps the internal tabs', async () => {
    const page = await (await fetch(`${base}/lab`, { headers: COOKIE })).text();
    expect(page).toContain('<a href="/lab/live">탭</a>');
    expect(page).not.toContain('dev-login');
    expect(page).not.toContain('127.0.0.1');
    expect(page).toContain('<span class="chip" title="서버 안에서만 열리는 주소입니다">v5</span>');
    expect(await (await fetch(`${base}/lab/api/summary`, { headers: COOKIE })).json()).toEqual({ a: '<a href="http://127.0.0.1:1/">' });
    expect(neutralizeLabLinks('<a class=btn href="http://localhost:1/">x</a><a href="https://example.com">y</a>')).toBe('<span class=btn title="서버 안에서만 열리는 주소입니다">x</span><a href="https://example.com">y</a>');
  });
  it('does not follow or pass on a redirect', async () => {
    seen.length = 0;
    const res = await fetch(`${base}/lab/moved`, { headers: COOKIE, redirect: 'manual' });
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(seen.map((s) => s.url)).toEqual(['/lab/moved']);
  });
  it('refuses a body past the cap, sized or not, with an error rather than a truncated 200', async () => {
    for (const p of ['/lab/huge', '/lab/sized']) {
      const res = await fetch(`${base}${p}`, { headers: COOKIE });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: '연구소 응답이 너무 큽니다' });
    }
  });
  it('keeps the gateway\'s own error statuses', async () => {
    const res = await fetch(`${base}/lab/api/coach/api/coach?sym=X`, { headers: COOKIE });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '입력 오류' });
    expect((await fetch(`${base}/lab/missing`, { headers: COOKIE })).status).toBe(404);
  });
  it('answers 503 when the body breaks off midway', async () => {
    expect((await fetch(`${base}/lab/gone`, { headers: COOKIE })).status).toBe(503);
  });
});

describe('/lab relay offline', () => {
  it('answers 503: JSON for the lab\'s scripts, a sentence for a frame, embeddable either way', async () => {
    const api = await fetch(`${deadBase}/lab/health`, { headers: { ...COOKIE, accept: 'application/json' } });
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: LAB_OFFLINE_TEXT });
    const page = await fetch(`${deadBase}/lab/live`, { headers: { ...COOKIE, accept: 'text/html,*/*' } });
    expect(page.status).toBe(503);
    expect(page.headers.get('content-security-policy')).toBe(LAB_EMBED_CSP);
    const text = await page.text();
    expect(text).toContain(LAB_OFFLINE_TEXT);
    expect(text).toContain('다시 시도');
  });
  it('is still behind the login', async () => {
    expect((await fetch(`${deadBase}/lab/health`)).status).toBe(401);
  });
});
