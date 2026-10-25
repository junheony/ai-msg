import type { DeviceInfo } from '../../src/shared/cloud/api-types';
import { cookieRoute } from './auth/session';
import { bearer, deviceAuth, hostAuth } from './auth/tokens';
import { json, problem } from './http';
import type { Ctx } from './router';

/** `GET /v1/devices` (host) — the host's active devices; the Mac reconciles its trust list with this. */
export async function listDevices(c: Ctx): Promise<Response> {
  const host = await hostAuth(c.env, c.req);
  if (!host) return problem(401, 'unauthorized');
  const rows = await c.env.DB.prepare("SELECT id, name, pub, created_at, last_seen FROM devices WHERE host_id = ? AND state = 'active' ORDER BY created_at")
    .bind(host.id).all<{ id: string; name: string; pub: string; created_at: number; last_seen: number | null }>();
  return json(200, rows.results.map((r): DeviceInfo => ({ id: r.id, name: r.name, pub: r.pub, addedAt: r.created_at, lastSeen: r.last_seen })));
}

const revokedOk = (changes: number) => (changes === 1 ? json(200, { ok: true }) : problem(404, 'unknown_device'));

/** Web-session variant (account page): cookie route rules, the device must belong to the signed-in user. */
const revokeByUser = cookieRoute({ session: 'required' }, async (c) => {
  const r = await c.env.DB.prepare("UPDATE devices SET state = 'revoked' WHERE id = ? AND user_id = ? AND state != 'revoked'").bind(c.params.id, c.userId).run();
  return revokedOk(r.meta.changes);
});

/**
 * `POST /v1/devices/:id/revoke` — with a Bearer token it is a host route (the host's own devices); without
 * one it is a cookie route (Origin check). Task 3 adds the DO notice that closes the device's channel.
 */
export async function revokeDevice(c: Ctx): Promise<Response> {
  if (!c.req.headers.has('authorization')) return revokeByUser(c);
  const host = bearer(c.req) ? await hostAuth(c.env, c.req) : null;
  if (!host) return problem(401, 'unauthorized');
  const r = await c.env.DB.prepare("UPDATE devices SET state = 'revoked' WHERE id = ? AND host_id = ? AND state != 'revoked'").bind(c.params.id, host.id).run();
  return revokedOk(r.meta.changes);
}

/**
 * `POST /v1/relay/ticket` (relay, device Bearer). This Task only gates the token: unknown / revoked → 401,
 * not yet confirmed on the Mac → 403 `pending_confirm`. Task 3 issues the one-time ticket (and 402 without
 * an entitlement) in place of the 501.
 */
export async function relayTicket(c: Ctx): Promise<Response> {
  const dev = await deviceAuth(c.env, c.req);
  if (!dev || dev.state === 'revoked') return problem(401, 'unauthorized');
  if (dev.state === 'claimed') return problem(403, 'pending_confirm');
  return problem(501, 'not_implemented');
}
