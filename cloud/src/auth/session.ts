import { timingSafeEqual } from '../../../src/shared/cloud/b64';
import { HttpError, problem, redirect } from '../http';
import type { Ctx } from '../router';
import { hashToken, hmacB64u, newToken } from './tokens';

/** Host-only (`__Host-`, no `Domain`), so it never reaches the relay origin. */
export const COOKIE_NAME = '__Host-aimsg_web';
const MAX_AGE_S = 30 * 24 * 3600;

/** Creates a web session for `userId`; returns the `Set-Cookie` value. The cookie is `<id>.<HMAC(SESSION_SECRET,id)>`. */
export async function newSessionCookie(c: Ctx, userId: string): Promise<string> {
  const id = newToken();
  await c.env.DB.prepare('INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hashToken(id), userId, c.nowMs + MAX_AGE_S * 1000).run();
  const value = `${id}.${await hmacB64u(c.env.SESSION_SECRET, id)}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return null;
}

/** The signed-in user, or `null` (no cookie, bad signature, unknown or expired session). */
export async function sessionUser(c: Ctx): Promise<string | null> {
  const v = cookieValue(c.req);
  const dot = v?.indexOf('.') ?? -1;
  if (!v || dot <= 0) return null;
  const id = v.slice(0, dot);
  if (!timingSafeEqual(v.slice(dot + 1), await hmacB64u(c.env.SESSION_SECRET, id))) return null;
  const row = await c.env.DB.prepare('SELECT user_id FROM web_sessions WHERE id_hash = ? AND expires_at > ?').bind(await hashToken(id), c.nowMs).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export type CookieCtx = Ctx & { userId: string };
type CookieOpts = {
  /** `required` (API: 401 without a session), `page` (GET page: redirect to /login), `none` (sign-in itself). */
  session: 'required' | 'page' | 'none';
  /** Also accept a same-origin urlencoded form (the sign-in pages only). The body is still read by the handler. */
  form?: boolean;
};

/**
 * The only way a route reads the `__Host-aimsg_web` cookie. Non-GET requests need `Origin === PUBLIC_ORIGIN`
 * (403 `bad_origin`, no Referer fallback) and a JSON body (415), or a form where `form` allows it.
 */
export function cookieRoute(opts: CookieOpts, handler: (c: CookieCtx) => Promise<Response>): (c: Ctx) => Promise<Response> {
  return async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (c.req.headers.get('origin') !== c.env.PUBLIC_ORIGIN) return problem(403, 'bad_origin');
      const type = (c.req.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
      if (type !== 'application/json' && !(opts.form && type === 'application/x-www-form-urlencoded')) return problem(415, 'bad_content_type');
    }
    const userId = opts.session === 'none' ? '' : await sessionUser(c);
    if (userId === null) {
      if (opts.session === 'page') return redirect(`/login?next=${encodeURIComponent(c.url.pathname + c.url.search)}`);
      throw new HttpError(401, 'unauthorized');
    }
    return handler({ ...c, userId });
  };
}
