import type http from 'node:http';
import { authInputLine } from './spec';
import type { AuthLoginHub } from './hub';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /api/auth-login {seat} starts the allowlisted login. GET …/:id/stream is the terminal text (SSE).
 * POST …/:id/input writes one line (the code) or a bare Enter. POST …/:id/cancel stops it.
 * Returns true when the path belonged to this feature.
 */
export async function handleAuthLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  hub: AuthLoginHub,
  readBody: (req: http.IncomingMessage, limit?: number) => Promise<string>,
  json: (res: http.ServerResponse, status: number, body: unknown) => void,
): Promise<boolean> {
  if (url.pathname === '/api/auth-login' && req.method === 'POST') {
    let body: { seat?: unknown } = {};
    try { body = JSON.parse(await readBody(req, 1024)) as typeof body; } catch { json(res, 400, { error: '잘못된 요청입니다' }); return true; }
    if (typeof body.seat !== 'string') { json(res, 400, { error: '자리를 지정하세요' }); return true; }
    const started = hub.start(body.seat);
    if (!started.ok) { json(res, started.status, { error: started.error }); return true; }
    json(res, 200, { id: started.id, label: started.label, seat: started.seat });
    return true;
  }
  const m = /^\/api\/auth-login\/([^/]+)\/(stream|input|cancel)$/.exec(url.pathname);
  if (!m) return false;
  const id = m[1]!;
  const action = m[2]!;
  if (!ID_RE.test(id)) { json(res, 404, { error: '로그인 창이 없습니다' }); return true; }
  if (action === 'stream' && req.method === 'GET') {
    // Headers first. subscribe replays what the login program already printed, and that write must not
    // happen before writeHead (it would send implicit headers and then throw).
    if (!hub.has(id)) { json(res, 404, { error: '로그인 창이 없습니다' }); return true; }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    // This comment goes out immediately so the client can open the stream before the first login line.
    res.write(':\n\n');
    const sub = hub.subscribe(id, (ev) => {
      if (ev.type === 'out') sse(res, 'out', { text: ev.text });
      else if (ev.type === 'error') sse(res, 'error', { message: ev.message });
      else { sse(res, 'exit', { code: ev.code }); if (!res.writableEnded) res.end(); }
    });
    if (!sub.ok) { sse(res, 'error', { message: '로그인 창이 없습니다' }); if (!res.writableEnded) res.end(); return true; }
    req.on('close', () => sub.unsub());
    return true;
  }
  if (action === 'input' && req.method === 'POST') {
    let body: { text?: unknown; enter?: unknown } = {};
    try { body = JSON.parse(await readBody(req, 8192)) as typeof body; } catch { json(res, 400, { error: '잘못된 요청입니다' }); return true; }
    const line = authInputLine(body);
    if ('error' in line) { json(res, 400, { error: line.error }); return true; }
    const wrote = hub.write(id, line.line);
    if (!wrote.ok) { json(res, wrote.status, { error: wrote.error }); return true; }
    json(res, 200, { ok: true });
    return true;
  }
  if (action === 'cancel' && req.method === 'POST') {
    if (!hub.cancel(id)) { json(res, 404, { error: '로그인 창이 없습니다' }); return true; }
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
