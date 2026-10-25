import type { PairClaimRes, PairStartRes, PairState, PairStatusRes } from '../../src/shared/cloud/api-types';
import { sha256B64u, timingSafeEqual } from '../../src/shared/cloud/b64';
import { type HostAuth, hashToken, hostAuth, isB64uBytes, newId, newToken } from './auth/tokens';
import { HttpError, json, problem, readBody, str } from './http';
import { MINUTE, hit } from './rate';
import type { Ctx } from './router';

const PAIR_TTL_MS = 5 * MINUTE;
const MAX_OPEN_PER_HOST = 3;
const MAX_BAD_CLAIMS = 5;

type PairingRow = { id: string; host_id: string; claim_hash: string; state: PairState; device_id: string | null; mac: string | null; bad_claims: number; expires_at: number };

/** An `open` pairing past its 5 minutes reads as `expired`; nothing else expires by time. */
const effectiveState = (p: PairingRow, nowMs: number): PairState => (p.state === 'open' && p.expires_at <= nowMs ? 'expired' : p.state);

async function requireHost(c: Ctx): Promise<HostAuth> {
  const host = await hostAuth(c.env, c.req);
  if (!host) throw new HttpError(401, 'unauthorized');
  return host;
}

async function ownPairing(c: Ctx, host: HostAuth): Promise<PairingRow> {
  const p = await c.env.DB.prepare('SELECT * FROM pairings WHERE id = ? AND host_id = ?').bind(c.params.id, host.id).first<PairingRow>();
  if (!p) throw new HttpError(404, 'unknown_pairing');
  return p;
}

/** `POST /v1/pair/start {claimHash}` (host) → `{pairingId, expiresAt}`; at most 3 open per host. */
export async function pairStart(c: Ctx): Promise<Response> {
  const host = await requireHost(c);
  const body = await readBody(c.req);
  if (!isB64uBytes(body.claimHash, 32)) throw new HttpError(400, 'bad_request');
  const db = c.env.DB;
  const open = await db.prepare("SELECT count(*) AS n FROM pairings WHERE host_id = ? AND state = 'open' AND expires_at > ?").bind(host.id, c.nowMs).first<number>('n');
  if ((open ?? 0) >= MAX_OPEN_PER_HOST) return problem(429, 'too_many_pairings');
  const pairingId = newId();
  const expiresAt = c.nowMs + PAIR_TTL_MS;
  await db.prepare("INSERT INTO pairings (id, host_id, claim_hash, state, expires_at) VALUES (?, ?, ?, 'open', ?)").bind(pairingId, host.id, body.claimHash, expiresAt).run();
  return json(200, { pairingId, expiresAt } satisfies PairStartRes);
}

/**
 * `POST /v1/pair/claim` (relay, no auth, `Origin === RELAY_ORIGIN`, 10/min per IP).
 * - wrong secret: `bad_claims++`, 5 on an open pairing → `expired`.
 * - right secret, open: a `claimed` device (device limit per user).
 * - right secret again with the same `devicePub`·`mac` (lost response): new token for the same device while
 *   `claimed`, `already_paired` once `confirmed` — never a burn.
 * - right secret again from anything else: `burned`, every device of the pairing revoked (Task 3 adds the DO notice).
 */
export async function pairClaim(c: Ctx): Promise<Response> {
  if (c.req.headers.get('origin') !== c.env.RELAY_ORIGIN) return problem(403, 'bad_origin');
  const db = c.env.DB;
  if (!(await hit(db, `pair:claim:ip:${c.ip}`, 10, MINUTE, c.nowMs))) return problem(429, 'rate_limited');
  const body = await readBody(c.req);
  const pairingId = str(body, 'pairingId', 64);
  const claim = str(body, 'claim', 128);
  const devicePub = str(body, 'devicePub', 64);
  const deviceName = str(body, 'deviceName', 64);
  const mac = str(body, 'mac', 128);

  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await db.prepare('SELECT * FROM pairings WHERE id = ?').bind(pairingId).first<PairingRow>();
    if (!p) return problem(404, 'unknown_pairing');
    const state = effectiveState(p, c.nowMs);
    if (state === 'expired' || state === 'rejected' || state === 'burned') return problem(410, state);

    if (!timingSafeEqual(await sha256B64u(claim), p.claim_hash)) {
      await db.prepare("UPDATE pairings SET bad_claims = bad_claims + 1, state = CASE WHEN state = 'open' AND bad_claims + 1 >= ?2 THEN 'expired' ELSE state END WHERE id = ?1")
        .bind(p.id, MAX_BAD_CLAIMS).run();
      return problem(403, 'bad_claim');
    }

    if (state === 'open') {
      if (!isB64uBytes(devicePub, 32)) throw new HttpError(400, 'bad_request');
      const host = await db.prepare('SELECT id, user_id FROM hosts WHERE id = ? AND revoked_at IS NULL').bind(p.host_id).first<{ id: string; user_id: string }>();
      if (!host) return problem(410, 'expired');
      const used = await db.prepare("SELECT count(*) AS n FROM devices WHERE user_id = ? AND state IN ('claimed', 'active')").bind(host.user_id).first<number>('n');
      if ((used ?? 0) >= Number(c.env.MAX_DEVICES)) return problem(409, 'device_limit');
      const deviceId = newId();
      const deviceToken = newToken();
      // One transaction: the device row exists only if this claim is the one that moved the pairing out of `open`.
      const [ins] = await db.batch([
        db.prepare(
          `INSERT INTO devices (id, user_id, host_id, pairing_id, name, pub, token_hash, state, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'claimed', ? WHERE EXISTS (SELECT 1 FROM pairings WHERE id = ? AND state = 'open')`,
        ).bind(deviceId, host.user_id, host.id, p.id, deviceName, devicePub, await hashToken(deviceToken), c.nowMs, p.id),
        db.prepare("UPDATE pairings SET state = 'claimed', device_id = ?, mac = ? WHERE id = ? AND state = 'open'").bind(deviceId, mac, p.id),
      ]);
      if (ins!.meta.changes === 1) return json(200, { deviceId, deviceToken, hostId: host.id } satisfies PairClaimRes);
      continue; // someone else claimed first — handle this as a second claim
    }

    // claimed or confirmed: the same phone resending, or a second use of the QR.
    const dev = p.device_id ? await db.prepare('SELECT id, host_id, pub FROM devices WHERE id = ?').bind(p.device_id).first<{ id: string; host_id: string; pub: string }>() : null;
    const samePhone = !!dev && timingSafeEqual(dev.pub, devicePub) && timingSafeEqual(p.mac ?? '', mac);
    if (samePhone && dev) {
      if (state === 'claimed') {
        const deviceToken = newToken();
        const r = await db.prepare("UPDATE devices SET token_hash = ? WHERE id = ? AND state = 'claimed'").bind(await hashToken(deviceToken), dev.id).run();
        if (r.meta.changes === 1) return json(200, { deviceId: dev.id, deviceToken, hostId: dev.host_id } satisfies PairClaimRes);
      }
      return problem(409, 'already_paired');
    }
    await db.batch([
      db.prepare("UPDATE pairings SET state = 'burned' WHERE id = ?").bind(p.id),
      db.prepare("UPDATE devices SET state = 'revoked' WHERE pairing_id = ?").bind(p.id),
    ]);
    return problem(409, 'pairing_burned');
  }
  return problem(409, 'pairing_burned');
}

/** `GET /v1/pair/:id` (host, own pairings only). */
export async function pairStatus(c: Ctx): Promise<Response> {
  const host = await requireHost(c);
  const p = await ownPairing(c, host);
  const res: PairStatusRes = { state: effectiveState(p, c.nowMs) };
  if (p.device_id) {
    const d = await c.env.DB.prepare('SELECT id, pub, name FROM devices WHERE id = ?').bind(p.device_id).first<{ id: string; pub: string; name: string }>();
    if (d) Object.assign(res, { deviceId: d.id, devicePub: d.pub, deviceName: d.name, mac: p.mac ?? undefined });
  }
  return json(200, res);
}

/** `POST /v1/pair/:id/confirm` (host) — only from `claimed`: pairing `confirmed`, device `active`; else 409 `{code: state}`. */
export async function pairConfirm(c: Ctx): Promise<Response> {
  const host = await requireHost(c);
  const db = c.env.DB;
  const id = c.params.id!;
  const [, upd] = await db.batch([
    db.prepare("UPDATE devices SET state = 'active' WHERE state = 'claimed' AND id = (SELECT device_id FROM pairings WHERE id = ? AND host_id = ? AND state = 'claimed')").bind(id, host.id),
    db.prepare("UPDATE pairings SET state = 'confirmed' WHERE id = ? AND host_id = ? AND state = 'claimed'").bind(id, host.id),
  ]);
  if (upd!.meta.changes === 1) return json(200, { ok: true });
  const p = await ownPairing(c, host);
  return problem(409, effectiveState(p, c.nowMs));
}

/** `POST /v1/pair/:id/reject` (host) — an `open` or `claimed` pairing becomes `rejected` and its device `revoked`. */
export async function pairReject(c: Ctx): Promise<Response> {
  const host = await requireHost(c);
  const db = c.env.DB;
  const id = c.params.id!;
  const [, upd] = await db.batch([
    db.prepare("UPDATE devices SET state = 'revoked' WHERE pairing_id = (SELECT id FROM pairings WHERE id = ? AND host_id = ? AND state IN ('open', 'claimed'))").bind(id, host.id),
    db.prepare("UPDATE pairings SET state = 'rejected' WHERE id = ? AND host_id = ? AND state IN ('open', 'claimed')").bind(id, host.id),
  ]);
  if (upd!.meta.changes === 1) return json(200, { ok: true });
  const p = await ownPairing(c, host);
  return problem(409, effectiveState(p, c.nowMs));
}
