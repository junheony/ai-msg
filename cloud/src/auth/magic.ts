import { emailSender } from '../email';
import { HttpError, json, readBody, redirect } from '../http';
import { loginPage, loginSentPage } from '../pages/login';
import { verifyFailedPage, verifyPage } from '../pages/verify';
import { HOUR, hit } from '../rate';
import type { Ctx } from '../router';
import { accountEmail, emailKey } from './email';
import { cookieRoute, newSessionCookie } from './session';
import { hashToken, newId, newToken } from './tokens';

const TTL_MS = 15 * 60_000;

/** A same-origin path (`/x`, not `//host` or `/\host`), else `null`. */
export function safeNext(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 512 && /^\/(?![/\\])[^\s\\]*$/.test(v) ? v : null;
}

/**
 * Sends a sign-in link unless a limit is hit: 5 per hour per normalized email, 20 per hour per IP.
 * The caller always answers the same way, so nobody learns whether an address has an account.
 */
async function sendMagic(c: Ctx, rawEmail: unknown, rawNext: unknown): Promise<void> {
  const email = accountEmail(rawEmail);
  if (!email) return;
  const key = await emailKey(c.env.EMAIL_HASH_SECRET, email);
  const ipOk = await hit(c.env.DB, `magic:ip:${c.ip}`, 20, HOUR, c.nowMs);
  const emailOk = await hit(c.env.DB, `magic:email:${key}`, 5, HOUR, c.nowMs);
  if (!ipOk || !emailOk) return;
  const token = newToken();
  await c.env.DB.prepare('INSERT INTO magic_links (token_hash, email, next, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), email, safeNext(rawNext), c.nowMs + TTL_MS).run();
  await emailSender(c.env).send({
    to: email,
    subject: 'Your AI msg sign-in link',
    text: `Sign in to AI msg:\n\n${c.env.PUBLIC_ORIGIN}/auth/verify?t=${token}\n\nThe link works once, for 15 minutes. If you did not ask for it, ignore this email.\n`,
  });
}

/** `POST /v1/auth/magic {email, next?}` → always 200 `{ok:true}`. */
export async function magicRequest(c: Ctx): Promise<Response> {
  const body = await readBody(c.req);
  await sendMagic(c, body.email, body.next);
  return json(200, { ok: true });
}

/** `GET /login?next=` */
export const loginGet = async (c: Ctx): Promise<Response> => loginPage(safeNext(c.url.searchParams.get('next')));

/** `POST /login` — the no-script form behind the login page; same Origin check as cookie routes. */
export const loginPost = cookieRoute({ session: 'none', form: true }, async (c) => {
  const body = await readBody(c.req, { form: true });
  await sendMagic(c, body.email, body.next);
  return loginSentPage();
});

/** `GET /auth/verify?t=` — renders a button only; never spends the token. */
export async function verifyGet(c: Ctx): Promise<Response> {
  const t = c.url.searchParams.get('t') ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? verifyPage(t) : verifyFailedPage();
}

/** `POST /auth/verify {t}` — spends the token once, upserts the user, sets the session cookie, 303 → next. */
export const verifyPost = cookieRoute({ session: 'none', form: true }, async (c) => {
  const body = await readBody(c.req, { form: true });
  const t = body.t;
  if (typeof t !== 'string' || t.length > 128) throw new HttpError(400, 'invalid_token');
  const row = await c.env.DB.prepare('UPDATE magic_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING email, next')
    .bind(c.nowMs, await hashToken(t)).first<{ email: string; next: string | null }>();
  if (!row) {
    if ((c.req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return verifyFailedPage();
    throw new HttpError(400, 'invalid_token');
  }
  await c.env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING').bind(newId(), row.email, c.nowMs).run();
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(row.email).first<{ id: string }>();
  return redirect(safeNext(row.next) ?? '/account', { 'set-cookie': await newSessionCookie(c, user!.id) });
});
