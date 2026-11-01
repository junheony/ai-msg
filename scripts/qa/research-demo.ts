/**
 * Isolated screenshot host for the 리서치 panel.
 * Run with node --import tsx scripts/qa/research-demo.ts [state-file]   (QA_PORT, default 9381; 9377 is the live demo).
 * The research files are the real ones (MSG_RESEARCH_DIR, default ~/.msg/research), read through the production route.
 * The hub status above the panel is the test fixture, not live data. Everything except GET is refused.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRequestHandler } from '../../src/server/http';
import { checkUpgrade, isAuthed, loadOrCreateToken } from '../../src/server/auth';
import { createResearchService, researchDir } from '../../src/server/hub/research';
import { SessionIndex } from '../../src/server/sessions/SessionIndex';
import { UsageService } from '../../src/server/usage/UsageService';
import { rootsOf, testRegistry } from '../../src/shared/accounts.testkit';
import { accountInfos, type ServerMessage } from '../../src/shared/protocol';
import { hubStatusFixture } from '../../src/ui/hub/__fixtures__/status';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.QA_PORT ?? 9381);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 9377) throw new Error('QA_PORT must be a free unprivileged port other than 9377 (the live demo)');
const serverUrl = `http://127.0.0.1:${port}`;
const uiDir = path.resolve(process.env.DIST ?? path.join(repo, 'dist/ui'));
const stateFile = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `msg-research-qa-state-${process.pid}.json`));
await fs.access(path.join(uiDir, 'index.html'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-research-qa-'));
await fs.chmod(dir, 0o700);
const tokenFile = path.join(dir, 'token');
const token = await loadOrCreateToken(tokenFile);
const registry = testRegistry(dir);
const index = new SessionIndex({ roots: rootsOf(Object.fromEntries(['a', 'b', 'c'].map((id) => [id, path.join(dir, id)]))), pinnedFile: path.join(dir, 'pins.json') });
await index.refresh();
const usage = new UsageService({
  accounts: registry, mode: 'cli', deckUrl: serverUrl,
  fetchFn: async () => { throw new Error('QA usage network access is disabled'); },
});
const status = hubStatusFixture(Date.now());
const handler = createRequestHandler({
  token, uiDir, home: dir, index, usage,
  research: createResearchService(researchDir(os.homedir())),
  hub: { status: { status: async () => status }, proxyTargets: {}, fileRoots: {} },
});
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', serverUrl).pathname;
  // The UI sends layout diagnostics automatically; a no-storage sink keeps the console quiet.
  if (pathname === '/api/diag' && req.method === 'POST' && isAuthed(req.headers.cookie, token)) {
    req.resume(); res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return;
  }
  if (req.method !== 'GET' || pathname.startsWith('/hub/p/')) {
    req.resume(); res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'isolated read-only QA host' })); return;
  }
  handler(req, res);
});

// Authenticated hello only, with no turns, commands or mutation handlers.
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

async function close() {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(stateFile, { force: true });
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
await fs.writeFile(stateFile, JSON.stringify({ server: serverUrl, tokenFile }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ready: true, server: serverUrl, stateFile }));
