/**
 * 연구소 embed relay: `/lab…` on MSG's own origin → the lab gateway on a fixed loopback port, GET only, for the logged-in
 * page. Mounted at the gateway's own path rather than under `/hub/p/`: its pages hardcode `/lab/…` in scripts and the coach
 * picks its API from `location.pathname`, so nothing but two kinds of dead link needs rewriting. The gateway stays on
 * localhost; nothing about the caller (cookie, authorization, forwarded headers) reaches it.
 */
import http from 'node:http';
import { PROXY_DENY_RE } from './proxy';

export const LAB_GATEWAY_PORT = 8792;
export const LAB_EMBED_MAX_BYTES = 16 * 1024 * 1024;
export const LAB_EMBED_TIMEOUT_MS = 30_000;
/** The gateway gives the coach API 180s of its own; a little more lets its explanation arrive instead of a bare timeout. */
export const LAB_COACH_TIMEOUT_MS = 185_000;
export const LAB_OFFLINE_TEXT = '연구소 서버에 연결할 수 없습니다 — cblabx-labgw 상태 확인';

/** Replaces the global policy on this path only: the lab's inline scripts run, nothing leaves the origin, only MSG may embed. */
export const LAB_EMBED_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

const PATH_RE = /^\/lab(?:\/[A-Za-z0-9._~-]+)*\/?$/;

export const isLabEmbedPath = (pathname: string): boolean => pathname === '/lab' || pathname.startsWith('/lab/');

/**
 * Whether the gateway may be asked for this path. Plain characters only, so there is no encoding to see through (a `;` or
 * `%2F` means something else to the gateway's parser than to this check) and no dot segment to climb out with.
 */
export function labPathVerdict(pathname: string): 'ok' | 'bad' | 'denied' {
  if (!PATH_RE.test(pathname) || pathname.split('/').some((s) => s.startsWith('.'))) return 'bad';
  // The theme's static files are the gateway's own fixed list, and one of them is named tokens.css.
  return !pathname.startsWith('/lab/static/') && PROXY_DENY_RE.test(pathname) ? 'denied' : 'ok';
}

/** The gateway's stub login (refused here) and its links to other localhost ports (the phone or laptop looking at MSG has none). */
export function neutralizeLabLinks(html: string): string {
  return html.replace(/<a\b([^>]*?)\shref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (whole: string, before: string, href: string, after: string, inner: string) => {
    if (href.startsWith('/lab/dev-login')) return '';
    if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?:[:/]|$)/i.test(href)) return whole;
    const cls = /\bclass="[^"]*"|\bclass=[^\s>]+/.exec(`${before} ${after}`)?.[0];
    return `<span${cls ? ` ${cls}` : ''} title="서버 안에서만 열리는 주소입니다">${inner}</span>`;
  });
}

const offlinePage = (): string => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>연구소</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;text-align:center}</style></head><body><main><p>${LAB_OFFLINE_TEXT}</p><p><a href="">다시 시도</a></p></main></body></html>`;

/** Serves one request. The caller has already checked the method (GET) and the login cookie. */
export function relayLabRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, port: number = LAB_GATEWAY_PORT): Promise<void> {
  return new Promise((resolve) => {
    const base = { 'content-security-policy': LAB_EMBED_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (status: number, type: string, body: string | Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      res.writeHead(status, { ...base, 'content-type': type, 'content-length': String(bytes.length) });
      res.end(bytes);
      resolve();
    };
    const json = (status: number, error: string) => send(status, 'application/json; charset=utf-8', JSON.stringify({ error }));
    // A frame navigating to a page reads a sentence; the lab's own scripts asking for data get JSON they can handle.
    const offline = () => (String(req.headers.accept ?? '').includes('text/html') ? send(503, 'text/html; charset=utf-8', offlinePage()) : json(503, LAB_OFFLINE_TEXT));

    const verdict = labPathVerdict(url.pathname);
    if (verdict === 'bad') return json(400, '잘못된 경로입니다');
    if (verdict === 'denied') return json(403, '허용되지 않은 경로입니다');

    const up = http.request({
      host: '127.0.0.1', port, method: 'GET', path: url.pathname + url.search,
      headers: { host: `127.0.0.1:${port}`, accept: String(req.headers.accept ?? '*/*').slice(0, 256), 'accept-encoding': 'identity' },
    }, (ur) => {
      const status = ur.statusCode ?? 502;
      if (status >= 300 && status < 400) { up.destroy(); return json(502, '연구소 서버가 다른 주소로 보냈습니다'); }
      if (Number(ur.headers['content-length'] ?? 0) > LAB_EMBED_MAX_BYTES) { up.destroy(); return json(502, '연구소 응답이 너무 큽니다'); }
      const chunks: Buffer[] = [];
      let size = 0;
      ur.on('data', (c: Buffer) => {
        size += c.length;
        if (size > LAB_EMBED_MAX_BYTES) { up.destroy(); json(502, '연구소 응답이 너무 큽니다'); return; }
        chunks.push(c);
      });
      ur.on('error', offline);
      ur.on('end', () => {
        const type = ur.headers['content-type'] ?? 'application/octet-stream';
        const body = Buffer.concat(chunks);
        send(status, type, /^text\/html\b/i.test(type) ? neutralizeLabLinks(body.toString('utf8')) : body);
      });
    });
    up.on('error', offline);
    // A whole-request deadline, so a gateway that drips bytes cannot hold the relay open either.
    timer = setTimeout(() => { up.destroy(); offline(); }, url.pathname.startsWith('/lab/api/coach/') ? LAB_COACH_TIMEOUT_MS : LAB_EMBED_TIMEOUT_MS);
    res.on('close', () => { clearTimeout(timer); up.destroy(); done = true; resolve(); });
    up.end();
  });
}
