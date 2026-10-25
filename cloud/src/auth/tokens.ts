import { fromB64u, randomToken, sha256B64u, toB64u } from '../../../src/shared/cloud/b64';
import type { Env } from '../env';

/** Secret tokens: 32 random bytes, base64url. D1 only ever sees `hashToken(token)`. */
export const newToken = (): string => randomToken(32);
export const hashToken = (token: string): Promise<string> => sha256B64u(token);
/** Row ids (also relay peer ids: ASCII, ≤ 64). */
export const newId = (): string => randomToken(16);

/** No 0/O/1/I. 32 symbols, so `byte & 31` is unbiased. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newUserCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(b, (x) => USER_CODE_ALPHABET[x & 31]).join('');
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function hmacB64u(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

/** A base64url string that decodes to exactly `n` bytes. */
export function isB64uBytes(s: unknown, n: number): s is string {
  if (typeof s !== 'string' || s.length > 4 * n) return false;
  try { return fromB64u(s).length === n; } catch { return false; }
}

export function bearer(req: Request): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

export type HostAuth = { id: string; userId: string };
export type DeviceAuth = { id: string; userId: string; hostId: string; state: 'claimed' | 'active' | 'revoked' };

/** The linked, not-unlinked host behind a host Bearer token. */
export async function hostAuth(env: Env, req: Request): Promise<HostAuth | null> {
  const t = bearer(req);
  if (!t) return null;
  const row = await env.DB.prepare('SELECT id, user_id FROM hosts WHERE token_hash = ? AND revoked_at IS NULL').bind(await hashToken(t)).first<{ id: string; user_id: string }>();
  return row ? { id: row.id, userId: row.user_id } : null;
}

/** The device behind a device Bearer token (any state — callers decide), on a host that is still linked. */
export async function deviceAuth(env: Env, req: Request): Promise<DeviceAuth | null> {
  const t = bearer(req);
  if (!t) return null;
  const row = await env.DB.prepare(
    'SELECT d.id, d.user_id, d.host_id, d.state FROM devices d JOIN hosts h ON h.id = d.host_id WHERE d.token_hash = ? AND h.revoked_at IS NULL',
  ).bind(await hashToken(t)).first<{ id: string; user_id: string; host_id: string; state: DeviceAuth['state'] }>();
  return row ? { id: row.id, userId: row.user_id, hostId: row.host_id, state: row.state } : null;
}
