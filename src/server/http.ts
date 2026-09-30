import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import type { SessionEntry } from '../shared/session-types';
import { AttachmentTooLarge, MAX_ATTACHMENT_BYTES, type AttachmentStore } from './attachments/AttachmentStore';
import { isAllowedHost, isAllowedOrigin, isAuthed, loginCookieHeader, logoutCookieHeader, tokenMatches } from './auth';
import type { SessionIndex } from './sessions/SessionIndex';
import type { UsageService } from './usage/UsageService';

/** Deviation (added per review I5): devOrigins/extraHosts feed the Origin+Host checks below. */
export type HttpDeps = { token: string; uiDir: string; usage: UsageService; index: SessionIndex; devOrigins?: string[]; extraHosts?: string[]; extraSessions?: () => SessionEntry[]; attachments?: AttachmentStore };

/**
 * Review I8: sent on every response. Only documents are governed by CSP; in dev the page is
 * served by Vite (its own origin, no CSP from here), so no relaxed dev policy is needed.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Deviation (added per review I5): SameSite=Strict doesn't separate ports, so every
 * state-changing /api/* request must also prove it came from our own origin (or an
 * explicit dev origin) — a matching Sec-Fetch-Site: same-origin is accepted too. */
function stateChangingOriginOk(req: http.IncomingMessage, devOrigins: string[]): boolean {
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  return isAllowedOrigin(req.headers.origin, req.headers.host, devOrigins);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

class BodyTooLarge extends Error {}

/**
 * PF6: on overflow we must NOT call req.destroy() before the 413 response is written — the
 * client then sees "other side closed" and never gets the size message. Instead: stop
 * buffering (discard further chunks) and reject so the caller can respond immediately; the
 * caller is responsible for draining and eventually closing the socket (see drainAndClose).
 */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) { cleanup(); reject(new BodyTooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Fix round 1 finding 1: a real oversized upload (tens of MiB) got ECONNRESET/EPIPE instead of
 * seeing the 413 — writing the response with a `connection: close` header makes Node's own
 * http server auto-destroy the socket on `res` 'finish' (`res._last`/`shouldKeepAlive=false`),
 * which races the still-arriving request body: whatever is left unread in the kernel receive
 * buffer at that moment triggers a TCP RST instead of a clean close, and the client sees the
 * RST before it has necessarily read the 413 body. So the 413 response here never sets
 * `connection: close` (keeping Node's own auto-close path from firing at all), and this
 * function alone owns closing the socket: it keeps consuming (discarding) the body — so the
 * client's still-in-flight upload finishes writing instead of hitting EPIPE — until 'end'
 * (then a graceful half-close), or until a bound (time or bytes) is hit (then a hard destroy).
 * Memory stays flat throughout: chunks are counted, never buffered.
 */
function drainAndClose(req: http.IncomingMessage, opts: { maxDrainBytes?: number; timeoutMs?: number } = {}): void {
  const maxDrainBytes = opts.maxDrainBytes ?? 64 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let drained = 0;
  let done = false;
  const finish = (force: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
    const sock = req.socket;
    if (!sock || sock.destroyed) return;
    if (force) sock.destroy();
    else sock.end();
  };
  const onData = (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > maxDrainBytes) finish(true);
  };
  const onEnd = () => finish(false);
  const onError = () => finish(true);
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  const timer = setTimeout(() => finish(true), timeoutMs);
  timer.unref?.();
  req.resume();
}

/** Writes the 413 (deliberately without `connection: close` — see drainAndClose) then drains. */
function tooLarge(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  json(res, 413, { error: message });
  drainAndClose(req);
}

function serveStatic(uiDir: string, urlPath: string, res: http.ServerResponse): void {
  const root = path.resolve(uiDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = path.resolve(root, '.' + normalized);
  if (!file.startsWith(root + path.sep) && file !== root) { json(res, 404, { error: 'not found' }); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) { json(res, 503, { error: 'UI 빌드가 없습니다. `npm run build` 를 먼저 실행하세요.' }); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

export function createRequestHandler(deps: HttpDeps) {
  const devOrigins = deps.devOrigins ?? [];
  const extraHosts = deps.extraHosts ?? [];
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Deviation (added per review I5): DNS-rebinding defence — reject any Host deck
    // doesn't itself bind to, even though an attacker-controlled Host would still
    // equal its own Origin and pass the check below.
    if (!isAllowedHost(req.headers.host, extraHosts)) { json(res, 421, { error: `host ${req.headers.host ?? ''} not allowed` }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authed = isAuthed(req.headers.cookie, deps.token);
    if (url.pathname.startsWith('/api/') && MUTATING_METHODS.has(req.method ?? '') && !stateChangingOriginOk(req, devOrigins)) {
      json(res, 403, { error: '허용되지 않은 출처입니다' });
      return;
    }
    void (async () => {
      if (url.pathname === '/api/login' && req.method === 'POST') {
        let token = '';
        try { token = String((JSON.parse(await readBody(req)) as { token?: unknown }).token ?? ''); } catch { /* fallthrough */ }
        if (!token || !tokenMatches(token, deps.token)) { json(res, 401, { error: '토큰이 올바르지 않습니다' }); return; }
        json(res, 200, { ok: true }, { 'set-cookie': loginCookieHeader(deps.token) });
        return;
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { json(res, 200, { ok: true }, { 'set-cookie': logoutCookieHeader() }); return; }
      if (url.pathname.startsWith('/api/')) {
        if (!authed) { json(res, 401, { error: '로그인이 필요합니다' }); return; }
        if (url.pathname === '/api/me') { json(res, 200, { ok: true }); return; }
        if (url.pathname === '/api/bootstrap') { json(res, 200, { usage: deps.usage.snapshot(), projects: deps.index.projects(deps.extraSessions?.() ?? []) }); return; }
        if (url.pathname === '/api/attachments' && req.method === 'POST') {
          if (!deps.attachments) { json(res, 404, { error: 'not found' }); return; }
          // Fix round 1 finding 1(a): a declared Content-Length over the limit is rejected
          // before reading any of the body at all.
          const declaredLength = Number(req.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
            tooLarge(req, res, new AttachmentTooLarge().message);
            return;
          }
          let data: Buffer;
          try {
            data = await readRaw(req, MAX_ATTACHMENT_BYTES);
          } catch (err) {
            if (err instanceof BodyTooLarge) { tooLarge(req, res, new AttachmentTooLarge().message); return; }
            throw err;
          }
          let name = 'file';
          try { name = decodeURIComponent(String(req.headers['x-deck-filename'] ?? '')) || 'file'; } catch { /* keep default */ }
          try {
            const a = await deps.attachments.save(name, data);
            json(res, 201, { id: a.id, name: a.name, mediaType: a.mediaType, size: a.size, isImage: a.isImage });
          } catch (err) {
            if (err instanceof AttachmentTooLarge) { json(res, 413, { error: err.message }); return; }
            throw err;
          }
          return;
        }
        json(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
      serveStatic(deps.uiDir, url.pathname, res);
    })().catch((err: unknown) => {
      // Review M5: details (paths, messages) stay in the server log.
      console.error('deck http: 500', req.method, url.pathname, err);
      if (!res.headersSent) json(res, 500, { error: '서버 내부 오류' });
      else res.destroy();
    });
  };
}
