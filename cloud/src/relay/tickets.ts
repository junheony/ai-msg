import type { TicketRes } from '../../../src/shared/cloud/api-types';
import { deviceAuth, hashToken, newToken } from '../auth/tokens';
import { entitledState } from '../entitled';
import { json, problem } from '../http';
import { MINUTE, hit } from '../rate';
import type { Ctx } from '../router';

export const TICKET_TTL_MS = 60_000;

/**
 * `POST /v1/relay/ticket` (relay, device Bearer, `Origin === RELAY_ORIGIN`).
 * - unknown token, revoked device or unlinked host → 401 `revoked` (the phone offers re-pairing);
 * - `claimed` while its pairing is still waiting for the Mac → 403 `pending_confirm` (the phone asks again);
 *   once that pairing expired the device can never be confirmed → 401 `pairing_expired`, not an endless 403;
 * - more than 10 tickets per device per minute → 429 `rate_limited` (keeps `relay_tickets` from being flooded;
 *   expired rows are deleted by the Task 12 cleanup cron);
 * - no entitlement (`untilMs` already carries the 48 h / 7 day grace) → 402 `not_entitled`;
 * - else a 60 s one-time ticket for `GET /relay/device?ticket=`. Only its sha256 is stored.
 */
export async function relayTicket(c: Ctx): Promise<Response> {
  if (c.req.headers.get('origin') !== c.env.RELAY_ORIGIN) return problem(403, 'bad_origin');
  const db = c.env.DB;
  const dev = await deviceAuth(c.env, c.req);
  if (!dev || dev.state === 'revoked') return problem(401, 'revoked');
  if (dev.state === 'claimed') {
    const waiting = await db.prepare("SELECT 1 FROM pairings WHERE id = (SELECT pairing_id FROM devices WHERE id = ?) AND state = 'claimed' AND expires_at > ?")
      .bind(dev.id, c.nowMs).first();
    return waiting ? problem(403, 'pending_confirm') : problem(401, 'pairing_expired');
  }
  if (!(await hit(db, `relay:ticket:dev:${dev.id}`, 10, MINUTE, c.nowMs))) return problem(429, 'rate_limited');
  const ent = await entitledState(db, dev.userId, c.nowMs);
  if (!(ent.untilMs > c.nowMs)) return problem(402, 'not_entitled');
  const ticket = newToken();
  await db.prepare('INSERT INTO relay_tickets (ticket_hash, device_id, host_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashToken(ticket), dev.id, dev.hostId, dev.userId, c.nowMs + TICKET_TTL_MS).run();
  return json(200, { ticket, hostId: dev.hostId, expiresIn: TICKET_TTL_MS / 1000 } satisfies TicketRes);
}

export type Redeemed = { deviceId: string; hostId: string; userId: string };

/**
 * Uses a ticket up: one statement, so of two racing connects only one wins (`used_at IS NULL`). A ticket of a device
 * revoked (or a host unlinked) after it was issued is refused too — the DO revoke notice had nothing to close then.
 */
export async function redeemTicket(c: Ctx, ticket: string): Promise<Redeemed | null> {
  const row = await c.env.DB.prepare(
    `UPDATE relay_tickets SET used_at = ?1
      WHERE ticket_hash = ?2 AND used_at IS NULL AND expires_at > ?1
        AND EXISTS (SELECT 1 FROM devices WHERE id = relay_tickets.device_id AND state = 'active')
        AND EXISTS (SELECT 1 FROM hosts WHERE id = relay_tickets.host_id AND revoked_at IS NULL)
      RETURNING device_id, host_id, user_id`,
  ).bind(c.nowMs, await hashToken(ticket)).first<{ device_id: string; host_id: string; user_id: string }>();
  return row ? { deviceId: row.device_id, hostId: row.host_id, userId: row.user_id } : null;
}
