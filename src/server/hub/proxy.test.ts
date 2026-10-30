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
import { HUB_PROXY_CSP, parseHubProxyPath, rewriteProxiedText, upstreamPath } from './proxy';
import type { HubStatus } from '../../shared/hub-types';

const TOKEN = 'f'.repeat(64);
let base = '';
let server: http.Server;
let upstream: http.Server;
let upstreamPort = 0;
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
const COOKIE = { cookie: `deck_session=${cookieValueFor(TOKEN)}` };
const STATUS: HubStatus = { modes: [], host: 'deck-host.example.ts.net', generated_at: '2026-10-30T10:00:00.000Z' };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url === '/ops') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'up=1', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'" }); res.end('<html><a href="/ops/strategy">s</a><script>fetch(\'/api/ops\')</script><link href="/css/a.css"><p>x = a/b</p></html>'); return; }
    if (req.url === '/api/snapshot.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"tabs":[]}'); return; }
    if (req.url === '/app.js?v=1') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end('fetch("/api/snapshot.json", { cache: "no-store" })'); return; }
    if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0, 1, 2, 3])); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as { port: number }).port;
  const uiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-hub-'));
  const roots = { a: path.join(uiDir, 'a'), b: path.join(uiDir, 'b'), c: path.join(uiDir, 'c') };
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(uiDir, 'p.json') });
  await index.refresh();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: true, json: async () => ({ cards: [] }) }) });
  const attachments = new AttachmentStore(path.join(uiDir, 'att'));
  await attachments.init();
  server = http.createServer(createRequestHandler({
    token: TOKEN, uiDir, usage, index, attachments, build: () => null, version: '0.1.0-test',
    hub: { status: { status: async () => STATUS }, proxyTargets: { quant: { port: upstreamPort }, ops: { port: upstreamPort, root: '/ops' }, dead: { port: 1 } } },
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); upstream.close(); });

describe('GET /api/hub/status', () => {
  it('needs the cookie, answers the aggregator JSON, and is GET only', async () => {
    expect((await fetch(`${base}/api/hub/status`)).status).toBe(401);
    const res = await fetch(`${base}/api/hub/status`, { headers: COOKIE });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(STATUS);
    expect((await fetch(`${base}/api/hub/status`, { method: 'POST', headers: { ...COOKIE, origin: base }, body: '{}' })).status).toBe(405);
  });
});

describe('/hub/p/<id>/ embed proxy', () => {
  it('refuses every method but GET/HEAD with 405, before and regardless of login', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect((await fetch(`${base}/hub/p/quant/api/snapshot.json`, { method, headers: { ...COOKIE, origin: base } })).status).toBe(405);
      expect((await fetch(`${base}/hub/p/quant/api/snapshot.json`, { method, headers: { origin: base } })).status).toBe(405);
    }
    expect(seen.filter((s) => s.method !== 'GET' && s.method !== 'HEAD')).toEqual([]);
  });

  it('needs the session cookie (401) and knows only the configured ids (404)', async () => {
    expect((await fetch(`${base}/hub/p/quant/api/snapshot.json`)).status).toBe(401);
    expect((await fetch(`${base}/hub/p/nexus/`, { headers: COOKIE })).status).toBe(404);
    expect((await fetch(`${base}/hub/p/`, { headers: COOKIE })).status).toBe(404);
  });

  it('passes a GET through without the cookie, drops upstream Set-Cookie, and answers with the embed CSP', async () => {
    seen.length = 0;
    const res = await fetch(`${base}/hub/p/quant/api/snapshot.json`, { headers: { ...COOKIE, authorization: 'Bearer x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tabs: [] });
    expect(res.headers.get('content-security-policy')).toBe(HUB_PROXY_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/snapshot.json' });
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it('rewrites root-absolute paths in HTML and JS under the prefix and maps the ops root to /ops', async () => {
    const html = await fetch(`${base}/hub/p/ops/`, { headers: COOKIE });
    expect(html.status).toBe(200);
    expect(html.headers.get('x-frame-options')).toBeNull();
    expect(html.headers.get('set-cookie')).toBeNull();
    expect(html.headers.get('content-security-policy')).toBe(HUB_PROXY_CSP);
    const text = await html.text();
    expect(text).toContain('href="/hub/p/ops/ops/strategy"');
    expect(text).toContain("fetch('/hub/p/ops/api/ops')");
    expect(text).toContain('href="/hub/p/ops/css/a.css"');
    expect(text).toContain('x = a/b');
    expect(Number(html.headers.get('content-length'))).toBe(Buffer.byteLength(text));
    const js = await (await fetch(`${base}/hub/p/quant/app.js?v=1`, { headers: COOKIE })).text();
    expect(js).toBe('fetch("/hub/p/quant/api/snapshot.json", { cache: "no-store" })');
    // The rewritten page's own fetch then lands on the right upstream path.
    expect((await fetch(`${base}/hub/p/ops/api/snapshot.json`, { headers: COOKIE })).status).toBe(200);
  });

  it('streams non-text bodies untouched, supports HEAD, redirects the bare id, and refuses credential-looking paths', async () => {
    const bin = await fetch(`${base}/hub/p/quant/bin`, { headers: COOKIE });
    expect(Buffer.from(await bin.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3]));
    const head = await fetch(`${base}/hub/p/quant/api/snapshot.json`, { method: 'HEAD', headers: COOKIE });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const bare = await fetch(`${base}/hub/p/quant`, { headers: COOKIE, redirect: 'manual' });
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toBe('/hub/p/quant/');
    for (const p of ['/hub/p/ops/api/risex/oi/opener/key', '/hub/p/ops/api/token', '/hub/p/quant/wallet.json', '/hub/p/ops/login']) {
      expect((await fetch(`${base}${p}`, { headers: COOKIE })).status).toBe(403);
    }
    expect(seen.some((s) => /key|token|wallet|login/.test(s.url))).toBe(false);
    expect((await fetch(`${base}/hub/p/quant/missing`, { headers: COOKIE })).status).toBe(404);
  });

  it('answers 502 when the upstream is down, and the global CSP is untouched for the hub page itself', async () => {
    const res = await fetch(`${base}/hub/p/dead/`, { headers: COOKIE });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: '업스트림 연결 실패' });
    expect(SECURITY_HEADERS['content-security-policy']).toContain("frame-src 'self'");
    expect((await fetch(`${base}/api/me`, { headers: COOKIE })).headers.get('content-security-policy')).toBe(SECURITY_HEADERS['content-security-policy']);
  });
});

describe('proxy helpers', () => {
  it('parses hub paths and maps the root', () => {
    expect(parseHubProxyPath('/hub/p/quant/api/x')).toEqual({ id: 'quant', rest: '/api/x' });
    expect(parseHubProxyPath('/hub/p/quant')).toEqual({ id: 'quant', rest: '' });
    expect(parseHubProxyPath('/hub/p/Quant/')).toBeNull();
    expect(parseHubProxyPath('/hub/x')).toBeNull();
    expect(upstreamPath({ port: 1, root: '/ops' }, '/')).toBe('/ops');
    expect(upstreamPath({ port: 1 }, '/')).toBe('/');
    expect(upstreamPath({ port: 1, root: '/ops' }, '/api/ops')).toBe('/api/ops');
  });
  it('rewrites only known root-absolute prefixes', () => {
    expect(rewriteProxiedText('url(/img/a.png) "/api/x" \'/css/y\' "/" "/other" a/b "/favicon.ico"', '/hub/p/q/')).toBe('url(/hub/p/q/img/a.png) "/hub/p/q/api/x" \'/hub/p/q/css/y\' "/" "/other" a/b "/hub/p/q/favicon.ico"');
  });
});
