/** BRIEF6: isolated, read-only real-transcript host. No runner or production services. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { checkUpgrade, isAuthed, loadOrCreateToken } from '../../src/server/auth';
import { readHead, readTranscriptUncached } from '../../src/server/sessions/transcript';
import { redactSecrets } from '../../src/server/engine/redact';
import { UsageService } from '../../src/server/usage/UsageService';
import { testRegistry } from '../../src/shared/accounts.testkit';
import { accountInfos, type ServerMessage } from '../../src/shared/protocol';
import type { ProjectEntry, SessionEntry, TranscriptMessage } from '../../src/shared/session-types';
import { hermesFixtureId, hermesFixtureMessages, terminalFixtureSessions } from './terminal-fixtures';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const uiDir = path.resolve(process.env.DIST ?? path.join(repo, 'dist/ui'));
const stateFile = process.argv[2] ?? '/tmp/msg-terminal-qa-state.json';
const serverUrl = 'http://127.0.0.1:9381';
const root = '/home/max/.claude/projects';
const synthetic = process.env.FIXTURE === 'hermes';
if (process.env.FIXTURE && !synthetic) throw new Error('Unknown terminal QA fixture');
const selectedId = synthetic ? hermesFixtureId : '3640bba1-fb7e-4021-aead-07c8953df686';
const folders = ['-home-max-agentic-harness', '-home-max-msg-hub-design-repo', '-home-max-arbitrage-nexus', '-home-max-msg-mini', '-home-max-feeback'];
await fs.access(path.join(uiDir, 'index.html'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-terminal-qa-'));
await fs.chmod(dir, 0o700);
const tokenFile = path.join(dir, 'token');
const token = await loadOrCreateToken(tokenFile);
const registry = testRegistry(dir);
const usage = new UsageService({ accounts: registry, mode: 'cli', deckUrl: serverUrl, fetchFn: async () => { throw new Error('QA network disabled'); } });
const metadata = synthetic ? {} : await fs.readFile('/home/max/.config/deck/session-meta.json', 'utf8').then((s) => JSON.parse(s) as { titles?: Record<string, string> }).catch(() => ({} as { titles?: Record<string, string> }));
const projects: ProjectEntry[] = [];
const entries = new Map<string, SessionEntry>();
for (const folder of synthetic ? [] : folders) {
  const projectDir = path.join(root, folder);
  const names = await fs.readdir(projectDir).catch(() => []);
  const files = (await Promise.all(names.filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)).map(async (name) => ({ file: path.join(projectDir, name), stat: await fs.stat(path.join(projectDir, name)) })))).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 6);
  const sessions: SessionEntry[] = [];
  for (const { file, stat } of files) {
    const head = await readHead(file);
    const sessionId = path.basename(file, '.jsonl');
    const entry: SessionEntry = { sessionId, account: 'a', engine: 'claude', cwd: head.cwd ?? '/home/max', projectDir, file, title: redactSecrets(metadata.titles?.[sessionId] ?? head.title ?? sessionId.slice(0, 8)), preview: redactSecrets(head.preview ?? ''), lastModified: stat.mtimeMs, sizeBytes: stat.size };
    sessions.push(entry); entries.set(sessionId, entry);
  }
  if (sessions.length) projects.push({ cwd: sessions[0]!.cwd, name: path.basename(sessions[0]!.cwd), pinned: false, sessions });
}
if (synthetic) {
  const sessions = terminalFixtureSessions();
  for (const entry of sessions) entries.set(entry.sessionId, entry);
  projects.push({ cwd: sessions[0]!.cwd, name: 'Agentic Harness', pinned: false, sessions });
}
const selected = entries.get(selectedId);
if (!selected) throw new Error('Required QA session missing');
// Preserve parser message ordering, text, thinking and call metadata; redact visible strings.
// Tool input and result payloads are withheld in this display-only host; call names/ids and result flags remain.
const safeString = (s: string) => redactSecrets(s);
function displayMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((m) => {
    if (m.kind === 'tool_result') return { ...m, content: '[QA: real tool output withheld]', truncated: true };
    if (m.kind === 'assistant') return { ...m, text: safeString(m.text), ...(m.thinking ? { thinking: safeString(m.thinking) } : {}), toolCalls: m.toolCalls.map((t) => ({ ...t, input: { description: '[QA: real tool input withheld]' } })) };
    return { ...m, text: safeString(m.text) };
  });
}
const histories = new Map<string, TranscriptMessage[]>();
const messages = synthetic ? hermesFixtureMessages : displayMessages(await readTranscriptUncached(selected.file, { maxMessages: 1000, maxToolResultChars: 0 }));
histories.set(selectedId, messages);
if (synthetic) for (const entry of entries.values()) histories.set(entry.sessionId, messages);
const pins = projects.flatMap((p) => p.sessions.slice(0, 2)).map((s) => s.sessionId);
const bootstrap = { usage: usage.snapshot(), projects, pins, desktop: [], sessionIcons: {} };
const json = (res: http.ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', serverUrl);
  if (url.pathname.startsWith('/api/')) {
    if (!isAuthed(req.headers.cookie, token)) { req.resume(); json(res, 401, { error: 'unauthorized' }); return; }
    if (url.pathname === '/api/diag' && req.method === 'POST') { req.resume(); res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { req.resume(); json(res, 405, { error: 'read-only QA host' }); return; }
    if (url.pathname === '/api/me') { json(res, 200, { ok: true }); return; }
    if (url.pathname === '/api/session-fork') { json(res, 200, { diverged: false }); return; }
    if (url.pathname === '/api/build') { json(res, 200, { build: null }); return; }
    if (url.pathname === '/api/bootstrap' || url.pathname === '/api/sessions') { json(res, 200, bootstrap); return; }
    if (url.pathname === '/api/usage') { json(res, 200, usage.snapshot()); return; }
    if (url.pathname === '/api/hub/status') { json(res, 200, { generatedAt: new Date().toISOString(), modes: [], alerts: [], sources: [] }); return; }
    json(res, 404, { error: 'Not available in terminal QA' }); return;
  }
  if (req.method !== 'GET') { req.resume(); json(res, 405, { error: 'read-only QA host' }); return; }
  const file = path.resolve(uiDir, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(uiDir + path.sep)) { json(res, 403, {}); return; }
  try { const body = await fs.readFile(file); const ext = path.extname(file); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[ext] ?? 'application/octet-stream' }); res.end(body); }
  catch { json(res, 404, {}); }
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !checkUpgrade(req, token).ok) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (msg: ServerMessage) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
    send({ type: 'hello', ...bootstrap, running: [], activity: [], codex: { available: synthetic }, hermes: { available: synthetic }, features: ['accounts', 'sessionModel'], accounts: accountInfos(registry), build: null });
    ws.on('error', () => {});
    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (['close_session', 'hello', 'route_preview', 'hub_watch', 'watch_turn'].includes(msg.type)) return;
      if (msg.type === 'refresh_index') { send({ type: 'index', projects, pins, desktop: [], sessionIcons: {} }); return; }
      if (msg.type !== 'open_session') { send({ type: 'error', message: 'Read-only QA: this action is disabled.' }); return; }
      const entry = entries.get(msg.sessionId);
      if (!entry) return;
      try {
        let history = histories.get(entry.sessionId);
        if (!history) { history = displayMessages(await readTranscriptUncached(entry.file, { maxMessages: 1000, maxToolResultChars: 0 })); histories.set(entry.sessionId, history); }
        send({ type: 'history', sessionId: entry.sessionId, cwd: entry.cwd, account: entry.account, engine: entry.engine, sandbox: null, accountPin: null, permissionMode: 'bypassPermissions', sessionModel: synthetic ? 'gpt-6-astra' : 'opus', messages: history, runningTurnId: null });
      } catch { send({ type: 'error', message: 'Transcript unavailable' }); }
    });
  });
});
let ownsState = false;
async function close() { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); if (ownsState) await fs.rm(stateFile, { force: true }); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(9381, '127.0.0.1', resolve); });
  const counts = { messages: messages.length, user: messages.filter((m) => m.kind === 'user').length, assistant: messages.filter((m) => m.kind === 'assistant').length, toolCalls: messages.reduce((n, m) => n + (m.kind === 'assistant' ? m.toolCalls.length : 0), 0), sessions: entries.size };
  await fs.writeFile(stateFile, JSON.stringify({ server: serverUrl, tokenFile, uiDir, pid: process.pid, selectedId, fixture: synthetic ? 'hermes-synthetic' : 'claude-real-redacted', sourceFile: synthetic ? 'scripts/qa/terminal-fixtures.ts' : selected.file, counts }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); ownsState = true;
  console.log(JSON.stringify({ ready: true, stateFile, counts }));
} catch (e) { await close(); throw e; }
