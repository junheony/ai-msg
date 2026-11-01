/**
 * 게임 스튜디오 preview: the built game-studio page plus the few read-only routes it needs, and nothing else.
 *
 *   npm run build && npm run studio:preview
 *
 * Routes (GET/HEAD only):
 *   /                        dist/ui/game-studio.html
 *   /assets/*, /icons/*      static files of dist/ui (path-contained)
 *   /api/hub/status          { modes: [the 게임 mode only] } — what the page polls
 *   /api/hub/game-studio     the GameStudio payload alone
 *   /api/hub/file/<root>/…   serveHubFile over the studio roots (+ ~/games), the same allowlist as the live hub
 *   /api/hub/game-pipeline   docs/GAME_PIPELINE.md as text
 * No sessions, engines, auth, push, restart or WebSocket: this process never writes and never spawns an agent.
 * Binds 127.0.0.1 and the tailnet address only (STUDIO_PREVIEW_HOSTS, comma-separated), port STUDIO_PREVIEW_PORT (9395).
 */
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGameStudioCached, studioFileRoots } from '../src/server/hub/gameStudio';
import { GAME_PIPELINE_PATH, HUB_FILE_PREFIX, serveHubFile, serveTextDoc } from '../src/server/hub/files';
import { collectGameMode, liveHubDeps, stripSecrets } from '../src/server/hub/status';
import type { HubStatus } from '../src/shared/hub-types';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(repo, 'dist', 'ui');
const home = os.homedir();
const studioDir = path.join(repo, 'studio');
const port = Number(process.env.STUDIO_PREVIEW_PORT ?? 9395);
const hosts = (process.env.STUDIO_PREVIEW_HOSTS ?? '127.0.0.1,100.125.168.94').split(',').map((h) => h.trim()).filter(Boolean);

const deps = liveHubDeps({ home, host: os.hostname(), studioDir, self: () => ({ uptimeMs: process.uptime() * 1000, sessions: null, activeTurns: null }) });
const fileRoots = { game: path.join(home, 'games'), ...studioFileRoots(home) };
const pipelineDoc = path.join(repo, 'docs', 'GAME_PIPELINE.md');

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

let cached: { at: number; body: HubStatus } | null = null;
async function gameStatus(): Promise<HubStatus> {
  if (cached && Date.now() - cached.at < 15_000) return cached.body;
  const mode = stripSecrets(await collectGameMode(deps));
  cached = { at: Date.now(), body: { modes: [mode], host: deps.host, generated_at: new Date().toISOString() } };
  return cached.body;
}

function json(res: http.ServerResponse, status: number, body: unknown, head: boolean): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(head ? undefined : JSON.stringify(body));
}

async function serveStatic(rel: string, head: boolean, res: http.ServerResponse): Promise<void> {
  const file = path.resolve(uiDir, rel);
  if (!file.startsWith(uiDir + path.sep)) return json(res, 403, { error: 'forbidden' }, head);
  const type = TYPES[path.extname(file).toLowerCase()];
  let size = -1;
  try { const st = await fs.stat(file); if (st.isFile()) size = st.size; } catch { /* missing */ }
  if (!type || size < 0) return json(res, 404, { error: 'not found' }, head);
  const isPage = type.startsWith('text/html');
  res.writeHead(200, { 'content-type': type, 'content-length': String(size), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': isPage ? 'no-store' : 'public, max-age=3600', ...(isPage ? { 'content-security-policy': PAGE_CSP } : {}) });
  if (head) { res.end(); return; }
  createReadStream(file).pipe(res);
}

const handler: http.RequestListener = (req, res) => {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  let pathname: string;
  try { pathname = new URL(req.url ?? '/', 'http://x').pathname; } catch { json(res, 400, { error: 'bad request' }, head); return; }
  const done = (p: Promise<void>) => { p.catch((err: unknown) => { console.error('[studio-preview]', pathname, err); if (!res.headersSent) json(res, 500, { error: 'internal' }, head); else res.end(); }); };
  if (pathname === '/' || pathname === '/index.html') return done(serveStatic('game-studio.html', head, res));
  if (pathname === '/api/hub/status') return done(gameStatus().then((s) => json(res, 200, s, head)));
  if (pathname === '/api/hub/game-studio') return done(collectGameStudioCached(deps, { studioDir }).then((s) => json(res, s ? 200 : 503, s ? stripSecrets(s) : { error: '수집 실패' }, head)));
  if (pathname === GAME_PIPELINE_PATH) return done(serveTextDoc(pipelineDoc, head, res));
  if (pathname.startsWith(HUB_FILE_PREFIX)) return done(serveHubFile(fileRoots, pathname, req.headers.range, head, res));
  if (/^\/(assets|icons)\/[\w./-]+$/.test(pathname) && !pathname.includes('..')) return done(serveStatic(pathname.slice(1), head, res));
  json(res, 404, { error: 'not found' }, head);
};

for (const host of hosts) {
  const server = http.createServer(handler);
  server.on('error', (err) => { console.error(`[studio-preview] ${host}:${port} ${String(err)}`); });
  server.listen(port, host, () => console.log(`[studio-preview] http://${host}:${port}/ (ui ${uiDir}, studio ${studioDir})`));
}
