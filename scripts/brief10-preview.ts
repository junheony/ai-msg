/** BRIEF10: actual built App + live read-only yapping/quant data; empty shell fixtures. */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { collectYapping } from '../src/server/hub/yapping';
import { collectQuant } from '../src/server/hub/quant';
import { liveHubDeps, stripSecrets } from '../src/server/hub/status';
import type { HubStatus } from '../src/shared/hub-types';
import type { ServerMessage } from '../src/shared/protocol';
import { HUB_URLS } from '../src/server/hub/shared';
import { risingFixture } from '../tests/fixtures/yapping-rising';
import { dailyFixture } from '../tests/fixtures/yapping-daily';

const repo = fileURLToPath(new URL('../', import.meta.url));
const uiDir = path.join(repo, 'dist/ui');
const port = Number(process.env.BRIEF10_PORT ?? 9410);
if (!Number.isInteger(port) || port < 9400 || port > 9499) throw new Error('BRIEF10_PORT must be an unused port in 9400–9499');
const origin = `http://127.0.0.1:${port}`;
const risingFixtureMode = process.env.BRIEF10B_RISING_FIXTURE ?? 'live';
if (!['live', 'success', 'error'].includes(risingFixtureMode)) throw new Error('BRIEF10B_RISING_FIXTURE must be success or error (unset = live)');
const dailyFixtureMode = process.env.BRIEF10C_DAILY_FIXTURE ?? 'live';
if (!['live', 'success', 'error'].includes(dailyFixtureMode)) throw new Error('BRIEF10C_DAILY_FIXTURE must be success or error (unset = live)');
await fs.access(path.join(uiDir, 'index.html'));
const startedAt = Date.now();
const deps = liveHubDeps({ home: os.homedir(), host: os.hostname(), self: () => ({ uptimeMs: Date.now() - startedAt, sessions: null, activeTurns: null }) });
const upstreamReads = new Set<string>();
const upstreamAllowed = new Set([
  'http://127.0.0.1:8810/api/snapshot.json',
  HUB_URLS.yappingRising,
  HUB_URLS.yappingDaily,
]);
// Yapping's production collector reads its local SQLite/state with read-only dependencies.
// Only the exact read-only Rising/daily URLs are allowed on :8095; other GETs can write state.
// Redirects cannot bypass the allowlist. No credentials, proxy routes, trading API, or mutation methods.
deps.fetchJson = async (url, timeoutMs) => {
  if (!upstreamAllowed.has(url)) throw new Error('BRIEF10 preview blocked a non-allowlisted upstream');
  if (url === HUB_URLS.yappingRising && risingFixtureMode !== 'live') {
    if (risingFixtureMode === 'error') throw new DOMException('BRIEF10b fixture timeout', 'TimeoutError');
    return risingFixture();
  }
  if (url === HUB_URLS.yappingDaily && dailyFixtureMode !== 'live') {
    if (dailyFixtureMode === 'error') throw new DOMException('BRIEF10c fixture timeout', 'TimeoutError');
    // Keep the production clock intact while ending the synthetic series on today's KST date.
    return dailyFixture(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10));
  }
  upstreamReads.add(url);
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
let cached: { at: number; value: HubStatus } | null = null;
let inflight: Promise<HubStatus> | null = null;
function status(): Promise<HubStatus> {
  if (cached && Date.now() - cached.at < 15_000) return Promise.resolve(cached.value);
  return inflight ??= Promise.all([collectYapping(deps), collectQuant(deps)]).then(modes => {
    const value = stripSecrets({ modes, host: deps.host, generated_at: new Date().toISOString() });
    cached = { at: Date.now(), value };
    return value;
  }).finally(() => { inflight = null; });
}
const hello: Extract<ServerMessage, { type: 'hello' }> = {
  type: 'hello', usage: { generatedAt: new Date().toISOString(), deckReachable: false, accounts: {}, usageSource: 'none', usageMode: 'cli' },
  projects: [], pins: [], desktop: [], running: [], activity: [], sessionIcons: {},
  codex: { available: false }, features: ['accounts'], accounts: [], build: null,
};
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function json(res: http.ServerResponse, code: number, body: unknown, head = false) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : JSON.stringify(body));
}
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const head = req.method === 'HEAD';
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'loopback preview only' }, head);
  if (req.method !== 'GET' && !head) { req.resume(); return json(res, 405, { error: 'read-only preview' }); }
  const pathname = new URL(req.url ?? '/', origin).pathname;
  if (pathname === '/api/me') return json(res, 200, { ok: true, preview: 'brief10-live-read-only' }, head);
  if (pathname === '/api/build') return json(res, 200, { build: null }, head);
  if (pathname === '/api/hub/status') return json(res, 200, await status(), head);
  if (pathname === '/api/brief10/manifest') return json(res, 200, { preview: 'brief10-live-read-only', ui: 'dist/ui/index.html', modes: ['yapping', 'quant'], shell: 'empty fixture; no real sessions/accounts', rising: risingFixtureMode === 'live' ? 'live' : `SYNTHETIC FIXTURE: ${risingFixtureMode}`, daily: dailyFixtureMode === 'live' ? 'live' : `SYNTHETIC FIXTURE: ${dailyFixtureMode}`, upstreamReads: [...upstreamReads], startedAt }, head);
  if (pathname === '/api/usage') return json(res, 200, hello.usage, head);
  if (pathname === '/api/sessions') return json(res, 200, { projects: [], pins: [], desktop: [] }, head);
  if (pathname.startsWith('/api/') || pathname.startsWith('/hub/')) return json(res, 404, { error: 'route outside BRIEF10 preview' }, head);
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const file = path.resolve(uiDir, rel);
  if (!file.startsWith(uiDir + path.sep) || !types[path.extname(file)]) return json(res, 404, { error: 'not found' }, head);
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) return json(res, 404, { error: 'not found' }, head);
  res.writeHead(200, { 'content-type': types[path.extname(file)]!, 'content-length': String(st.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  if (head) res.end(); else createReadStream(file).pipe(res);
}
const server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'preview request failed' }); else res.end(); }); });
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== origin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => {});
    ws.send(JSON.stringify(hello));
    // Deliberately no message handler: shell requests cannot start turns or alter anything.
  });
});
function close() { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close(); }
process.once('SIGINT', close);
process.once('SIGTERM', close);
server.on('error', () => { console.error('BRIEF10 preview could not bind its isolated port'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`BRIEF10 live-data preview ready: ${origin} (empty shell fixtures)`));
