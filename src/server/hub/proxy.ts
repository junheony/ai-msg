/**
 * MSG Hub embed proxy: `/hub/p/<id>/…` → a fixed localhost upstream, GET/HEAD only, for the logged-in page. The proxied
 * page becomes same-origin (so the hub's `frame-src 'self'` stays), gets its own CSP, and never sees MSG's cookie.
 * Absolute `/api/…`-style paths inside HTML/JS/CSS are rewritten under the prefix so the page keeps working.
 */
import http from 'node:http';

export const HUB_PROXY_PREFIX = '/hub/p/';

export interface ProxyTarget {
  port: number;
  host?: string;
  /** What `/hub/p/<id>/` itself maps to upstream (default `/`). */
  root?: string;
}

export const HUB_PROXY_TARGETS: Record<string, ProxyTarget> = {
  quant: { port: 8810 },
  ops: { port: 8765, root: '/ops' },
};

/** Upstream paths that look like they hand out credentials are refused (the StandX dashboard has a `…/key` route). */
export const PROXY_DENY_RE = /(^|[/._-])(key|keys|token|tokens|secret|secrets|vault|wallet|password|credential|credentials|login|logout)(?=$|[/._?-])/i;

export const HUB_PROXY_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** Request headers that may travel upstream. Cookie and authorization never do. */
const PASS_REQ = new Set(['accept', 'accept-language', 'user-agent', 'range', 'if-modified-since', 'if-none-match']);
/** Response headers passed back. Set-Cookie, CSP and X-Frame-Options from upstream are dropped. */
const PASS_RES = new Set(['content-type', 'content-length', 'last-modified', 'etag', 'content-range', 'accept-ranges', 'location']);
const TEXT_RE = /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/x-javascript|module)\b/i;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

/** `/hub/p/quant/api/x` → `{ id: 'quant', rest: '/api/x' }`; `/hub/p/quant` (no slash) → rest ''. Null outside the prefix. */
export function parseHubProxyPath(pathname: string): { id: string; rest: string } | null {
  if (!pathname.startsWith(HUB_PROXY_PREFIX)) return null;
  const tail = pathname.slice(HUB_PROXY_PREFIX.length);
  const slash = tail.indexOf('/');
  const id = slash < 0 ? tail : tail.slice(0, slash);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  return { id, rest: slash < 0 ? '' : tail.slice(slash) };
}

/** The upstream path for a hub path's tail (`rest`, '' or '/…'). */
export function upstreamPath(target: ProxyTarget, rest: string): string {
  if (rest === '' || rest === '/') return target.root ?? '/';
  return rest;
}

/** Rewrites root-absolute `"/api/…"`, `'/css/…'`, `url(/img/…)` references so they resolve under the hub prefix. */
export function rewriteProxiedText(text: string, prefix: string): string {
  return text.replace(/(["'(])\/(?=(?:api|ops|css|js|static|assets|img|images|fonts|font|data|media|public|_next|favicon)(?:[/"'?)#]|\.))/g, `$1${prefix}`);
}

const typeOf = (headers: http.IncomingHttpHeaders): string => String(headers['content-type'] ?? '');

/**
 * Serves one proxied request. The caller has already checked the method (GET/HEAD) and the login cookie.
 * Answers 404 for an unknown id, 403 for a refused path, 502 when the upstream is unreachable or too slow.
 */
export function proxyHubRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, targets: Record<string, ProxyTarget> = HUB_PROXY_TARGETS): Promise<void> {
  return new Promise((resolve) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); resolve(); };
    const parsed = parseHubProxyPath(url.pathname);
    const target = parsed ? targets[parsed.id] : undefined;
    if (!parsed || !target) return json(404, { error: 'not found' });
    if (parsed.rest === '') { res.writeHead(302, { location: `${HUB_PROXY_PREFIX}${parsed.id}/${url.search}`, 'cache-control': 'no-store' }); res.end(); return resolve(); }
    const path = upstreamPath(target, parsed.rest);
    if (PROXY_DENY_RE.test(path)) return json(403, { error: '허용되지 않은 경로입니다' });
    const prefix = `${HUB_PROXY_PREFIX}${parsed.id}/`;
    const headers: Record<string, string> = { host: `127.0.0.1:${target.port}`, 'accept-encoding': 'identity' };
    for (const [k, v] of Object.entries(req.headers)) if (PASS_REQ.has(k) && typeof v === 'string') headers[k] = v;
    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const up = http.request({ host: target.host ?? '127.0.0.1', port: target.port, method, path: path + url.search, headers, timeout: UPSTREAM_TIMEOUT_MS }, (ur) => {
      const out: Record<string, string> = { 'content-security-policy': HUB_PROXY_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      for (const [k, v] of Object.entries(ur.headers)) if (PASS_RES.has(k) && typeof v === 'string') out[k] = v;
      if (out.location) out.location = rewriteProxiedText(`"${out.location}`, prefix).slice(1);
      const status = ur.statusCode ?? 502;
      const rewrite = method === 'GET' && TEXT_RE.test(typeOf(ur.headers)) && Number(ur.headers['content-length'] ?? 0) <= MAX_REWRITE_BYTES;
      if (!rewrite) {
        res.writeHead(status, out);
        if (method === 'HEAD') { ur.resume(); res.end(); return resolve(); }
        ur.on('error', () => { res.destroy(); resolve(); });
        ur.pipe(res).on('finish', resolve).on('close', resolve);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      ur.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_REWRITE_BYTES) chunks.push(c); });
      ur.on('error', () => { if (!res.headersSent) json(502, { error: '업스트림 오류' }); else { res.destroy(); resolve(); } });
      ur.on('end', () => {
        const body = Buffer.from(rewriteProxiedText(Buffer.concat(chunks).toString('utf8'), prefix), 'utf8');
        delete out['content-length'];
        res.writeHead(status, { ...out, 'content-length': String(body.length) });
        res.end(body);
        resolve();
      });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) json(502, { error: '업스트림 연결 실패' }); else { res.destroy(); resolve(); } });
    req.on('close', () => { if (!up.destroyed) up.destroy(); });
    up.end();
  });
}
