import type { DeviceInfo } from '../../src/shared/cloud/api-types';
import { cookieRoute } from './auth/session';
import { bearer, hostAuth } from './auth/tokens';
import { json, problem } from './http';
import { notifyRelay } from './relay/routes';
import type { Ctx } from './router';

/** `GET /v1/devices` (host) — the host's active devices; the Mac reconciles its trust list with this. */
export async function listDevices(c: Ctx): Promise<Response> {
  const host = await hostAuth(c.env, c.req);
  if (!host) return problem(401, 'unauthorized');
  const rows = await c.env.DB.prepare("SELECT id, name, pub, created_at, last_seen FROM devices WHERE host_id = ? AND state = 'active' ORDER BY created_at")
    .bind(host.id).all<{ id: string; name: string; pub: string; created_at: number; last_seen: number | null }>();
  return json(200, rows.results.map((r): DeviceInfo => ({ id: r.id, name: r.name, pub: r.pub, addedAt: r.created_at, lastSeen: r.last_seen })));
}

/** After the revoke is written, the host's relay room closes the device (4403) and tells the Mac `{t:'revoked'}`. */
function revoked(c: Ctx, row: { id: string; host_id: string } | null): Response {
  if (!row) return problem(404, 'unknown_device');
  notifyRelay(c, row.host_id, 'revoke', row.id);
  return json(200, { ok: true });
}

/** Web-session variant (account page): cookie route rules, the device must belong to the signed-in user. */
const revokeByUser = cookieRoute({ session: 'required' }, async (c) => {
  const r = await c.env.DB.prepare("UPDATE devices SET state = 'revoked' WHERE id = ? AND user_id = ? AND state != 'revoked' RETURNING id, host_id")
    .bind(c.params.id, c.userId).first<{ id: string; host_id: string }>();
  return revoked(c, r);
});

/**
 * `POST /v1/devices/:id/revoke` — with a Bearer token it is a host route (the host's own devices); without
 * one it is a cookie route (Origin check). Either way the device's open relay channel is closed.
 */
export async function revokeDevice(c: Ctx): Promise<Response> {
  if (!c.req.headers.has('authorization')) return revokeByUser(c);
  const host = bearer(c.req) ? await hostAuth(c.env, c.req) : null;
  if (!host) return problem(401, 'unauthorized');
  const r = await c.env.DB.prepare("UPDATE devices SET state = 'revoked' WHERE id = ? AND host_id = ? AND state != 'revoked' RETURNING id, host_id")
    .bind(c.params.id, host.id).first<{ id: string; host_id: string }>();
  return revoked(c, r);
}
