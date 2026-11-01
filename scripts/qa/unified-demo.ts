/**
 * Isolated BRIEF4 screenshot host for the unified read-only Trading room.
 * Run with node --import tsx scripts/qa/unified-demo.ts [state-file]   (QA_PORT, default 9379; 9377 is the live demo).
 * Live upstreams, GET only, through the production transports: :8792 /lab/api/summary (lab), :8830 /api/sr and
 * /api/status (SR + room status, allowlisted, no redirects, no credentials, bounded JSON). Everything else is frozen.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRequestHandler } from '../../src/server/http';
import { checkUpgrade, isAuthed, loadOrCreateToken } from '../../src/server/auth';
import { SessionIndex } from '../../src/server/sessions/SessionIndex';
import { UsageService } from '../../src/server/usage/UsageService';
import { rootsOf, testRegistry } from '../../src/shared/accounts.testkit';
import { accountInfos, type ServerMessage } from '../../src/shared/protocol';
import type { HubStatus } from '../../src/shared/hub-types';
import { createLabService, fetchLabJson } from '../../src/server/hub/lab';
import { createSrService, fetchSrJson, SR_ALLOWED_URLS } from '../../src/server/hub/sr';
import { createMarketService } from '../../src/server/replay/market';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.QA_PORT ?? 9379);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 9377) throw new Error('QA_PORT must be a free unprivileged port other than 9377 (the live demo)');
const serverUrl = `http://127.0.0.1:${port}`;
const summaryUrl = 'http://127.0.0.1:8792/lab/api/summary';
const statusFile = path.resolve(process.env.STATUS_JSON ?? path.join(repo, '../.demo/status.json'));
const uiDir = path.resolve(process.env.DIST ?? path.join(repo, 'dist/ui'));
const stateFile = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `msg-unified-qa-state-${process.pid}.json`));
const status = JSON.parse(await fs.readFile(statusFile, 'utf8')) as HubStatus;
if (!Array.isArray(status.modes)) throw new Error('STATUS_JSON must be a frozen hub status snapshot');
await fs.access(path.join(uiDir, 'index.html'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-unified-qa-'));
await fs.chmod(dir, 0o700);
const tokenFile = path.join(dir, 'token');
const token = await loadOrCreateToken(tokenFile);
const registry = testRegistry(dir);
const roots = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, path.join(dir, id)]));
const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(dir, 'pins.json') });
await index.refresh();
const usage = new UsageService({
  accounts: registry, mode: 'cli', deckUrl: serverUrl,
  fetchFn: async () => { throw new Error('QA usage network access is disabled'); },
});

// The production services and transports read the live upstreams; this host only pins the allowlist once more.
const lab = createLabService({ fetchJson: (url: string, timeoutMs: number) => {
  if (url !== summaryUrl) throw new Error('QA upstream is not allowlisted');
  return fetchLabJson(url, timeoutMs);
} });
const sr = createSrService({ fetchJson: (url: string, timeoutMs: number) => {
  if (!SR_ALLOWED_URLS.includes(url)) throw new Error('QA upstream is not allowlisted');
  return fetchSrJson(url, timeoutMs);
} });
// Replay candles come from the production market service with an empty in-memory upstream: the SR chart shows its
// "no candles" state and the table still renders. No exchange is contacted from this host.
const replay = createMarketService(async (url) => ({
  ok: true, status: 200,
  json: async () => url.includes('exchangeInfo') ? { symbols: [] } : [],
}));
const handler = createRequestHandler({
  token, uiDir, home: dir, index, usage, replay,
  hub: { status: { status: async () => status }, sr, lab, proxyTargets: {}, fileRoots: {} },
});
const readPaths = new Set(['/api/me', '/api/build', '/api/bootstrap', '/api/usage', '/api/sessions', '/api/hub/status', '/api/hub/sr', '/api/health', '/api/version']);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', serverUrl).pathname;
  // The UI sends layout diagnostics automatically. A no-storage sink avoids console noise;
  // it does not invoke the production POST route or record its payload.
  if (pathname === '/api/diag' && req.method === 'POST' && isAuthed(req.headers.cookie, token)) {
    req.resume(); res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return;
  }
  // The lab and SR routes enforce their own authentication, validation and GET-only behaviour (tested in sr.test.ts).
  if (pathname === '/api/hub/lab' || pathname === '/api/hub/sr') { handler(req, res); return; }
  if (req.method !== 'GET' || pathname.startsWith('/hub/p/') ||
      (pathname.startsWith('/api/') && !readPaths.has(pathname) && !pathname.startsWith('/api/replay/'))) {
    req.resume(); res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'isolated read-only QA host' })); return;
  }
  handler(req, res);
});

// No production WS runner: authenticated hello only, with no turns, commands or mutation handlers.
// Omit the hub feature so the UI obtains its frozen status through GET /api/hub/status.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !checkUpgrade(req, token).ok) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const hello: ServerMessage = {
      type: 'hello', usage: usage.snapshot(), projects: [], pins: [], desktop: [],
      running: [], activity: [], sessionIcons: {}, codex: { available: false },
      features: ['accounts'], accounts: accountInfos(registry), build: null,
    };
    ws.send(JSON.stringify(hello));
    ws.on('error', () => { /* an abandoned screenshot tab is harmless */ });
  });
});

let ownsStateFile = false;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
  if (ownsStateFile) await fs.rm(stateFile, { force: true });
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await fs.writeFile(stateFile, JSON.stringify({ server: serverUrl, tokenFile, statusFile, uiDir, pid: process.pid }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  ownsStateFile = true;
  console.log(JSON.stringify({ ready: true, server: serverUrl, stateFile, tokenFile }));
} catch (error) {
  await close();
  throw error;
}
