import type { Env } from './env';
import type { Side } from './origins';

export type Ctx = { req: Request; env: Env; url: URL; params: Record<string, string>; nowMs: number; ip: string };
export type Handler = (c: Ctx) => Promise<Response>;
/** `[side, method, pattern, handler]`; pattern segments starting with `:` capture one path segment. */
export type Route = readonly [Side, string, string, Handler];

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith(':')) {
      if (!s[i]) return null;
      try { params[seg.slice(1)] = decodeURIComponent(s[i]!); } catch { return null; }
    } else if (seg !== s[i]) return null;
  }
  return params;
}

/**
 * The handler for this side, method and path, else `null` (404). A route that exists only on the other side,
 * or only with another method, is the same plain miss — so neither origin reveals the other's routes
 * (`POST /v1/pair/claim` on the app origin would otherwise hit `GET /v1/pair/:id` and answer 405).
 */
export function route(routes: readonly Route[], side: Side, method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  for (const [s, m, pattern, handler] of routes) {
    if (s !== side || (m !== method && !(m === 'GET' && method === 'HEAD'))) continue;
    const params = matchPath(pattern, path);
    if (params) return { handler, params };
  }
  return null;
}
