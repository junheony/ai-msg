import { hostAuth } from '../auth/tokens';
import { entitledState } from '../entitled';
import { problem } from '../http';
import type { Ctx } from '../router';
import { relayLog } from './RelayRoom';
import { redeemTicket } from './tickets';

const isUpgrade = (req: Request) => (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

/**
 * Hands the upgrade to the host's room. Client `x-relay-*` headers are dropped and ours set; the credentials
 * (`authorization`, `cookie`) stay behind — the DO trusts only what the Worker put there.
 */
function toRoom(c: Ctx, hostId: string, relay: Record<string, string>): Promise<Response> {
  const h = new Headers(c.req.headers);
  for (const k of [...h.keys()]) if (k.startsWith('x-relay-')) h.delete(k);
  h.delete('authorization');
  h.delete('cookie');
  for (const [k, v] of Object.entries(relay)) h.set(k, v);
  return c.env.RELAY.get(c.env.RELAY.idFromName(hostId)).fetch(new Request(c.req.url, { method: 'GET', headers: h }));
}

/**
 * `GET /relay/host` (Upgrade, host Bearer). No entitlement check (2차 필수 1): a Mac without one stays attached
 * so a payment's recheck reaches it; tickets (402) and the room's `{t:'ent'}`·alarm carry the entitlement.
 */
export async function relayHost(c: Ctx): Promise<Response> {
  if (!isUpgrade(c.req)) return problem(426, 'upgrade_required');
  const host = await hostAuth(c.env, c.req);
  if (!host) return problem(401, 'unauthorized');
  const ent = await entitledState(c.env.DB, host.userId, c.nowMs);
  return toRoom(c, host.id, { 'x-relay-role': 'host', 'x-relay-host': host.id, 'x-relay-user': host.userId, 'x-relay-until': String(ent.untilMs) });
}

/** `GET /relay/device?ticket=` (Upgrade). `Origin`, when sent, must be the relay origin; the ticket is used up first. */
export async function relayDevice(c: Ctx): Promise<Response> {
  if (!isUpgrade(c.req)) return problem(426, 'upgrade_required');
  const origin = c.req.headers.get('origin');
  if (origin !== null && origin !== c.env.RELAY_ORIGIN) return problem(403, 'bad_origin');
  const ticket = c.url.searchParams.get('ticket') ?? '';
  const t = /^[A-Za-z0-9_-]{1,128}$/.test(ticket) ? await redeemTicket(c, ticket) : null;
  if (!t) return problem(401, 'bad_ticket');
  const ent = await entitledState(c.env.DB, t.userId, c.nowMs);
  // The room arms no alarm for a socket already past `until`, so it would never be closed: refuse it here.
  if (!(ent.untilMs > c.nowMs)) return problem(402, 'not_entitled');
  await c.env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(c.nowMs, t.deviceId).run();
  return toRoom(c, t.hostId, { 'x-relay-role': 'device', 'x-relay-device': t.deviceId, 'x-relay-host': t.hostId, 'x-relay-user': t.userId, 'x-relay-until': String(ent.untilMs) });
}

/**
 * Tells the host's room after the D1 write (`ctx.waitUntil`, the response does not wait; a failure is retried once): `revoke` closes the
 * device with 4403 and tells the host, `unlink` closes everything with 4401, `recheck` re-reads the entitlement.
 */
export function notifyRelay(c: Ctx, hostId: string, what: 'revoke' | 'unlink' | 'recheck', dev?: string): void {
  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(hostId));
  const once = async (): Promise<boolean> => {
    try {
      const r = await stub.fetch(`https://relay/internal/${what}`, { method: 'POST', body: JSON.stringify(dev ? { dev } : {}) });
      await r.body?.cancel();
      return r.ok;
    } catch {
      return false;
    }
  };
  // One retry; a notice lost twice is only logged (metadata) — the DO's own D1 re-read on accept covers new sockets.
  c.exec.waitUntil((async () => {
    if ((await once()) || (await once())) return;
    relayLog(`notify_failed_${what}`, { host: hostId, dev });
  })());
}
