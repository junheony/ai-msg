import type { LinkApproveRes, LinkPollRes, LinkStartRes } from '../../src/shared/cloud/api-types';
import { fromB64u, sha256B64u } from '../../src/shared/cloud/b64';
import { emailKey } from './auth/email';
import { cookieRoute } from './auth/session';
import { hashToken, hostAuth, isB64uBytes, newId, newToken, newUserCode } from './auth/tokens';
import { HttpError, json, problem, readBody, str } from './http';
import { linkLimitedPage, linkMissingPage, linkPage } from './pages/link';
import { DAY, HOUR, hit, windowStart } from './rate';
import { notifyRelay } from './relay/routes';
import type { Ctx } from './router';

const LINK_TTL_MS = 600_000;
const POLL_MIN_MS = 2000;
const TRIALS_PER_IP_PER_DAY = 3;
/** Same shape as `isSemver` in src/shared/cloud/noise.ts (the Worker does not import noise.ts). */
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

type LinkRow = { device_code_hash: string; user_code: string; host_name: string; host_pub: string; ui_version: string; state: string; user_id: string | null; last_poll: number | null; expires_at: number };

const normCode = (v: unknown): string | null => (typeof v === 'string' && v.length <= 16 ? v.trim().toUpperCase() : null);

/** `POST /v1/host/link/start {hostName, hostPub, uiVersion}` — 10 per hour per IP. */
export async function linkStart(c: Ctx): Promise<Response> {
  if (!(await hit(c.env.DB, `link:start:ip:${c.ip}`, 10, HOUR, c.nowMs))) return problem(429, 'rate_limited');
  const body = await readBody(c.req);
  const hostName = str(body, 'hostName', 64);
  const uiVersion = str(body, 'uiVersion', 40);
  if (!isB64uBytes(body.hostPub, 32) || !SEMVER.test(uiVersion)) throw new HttpError(400, 'bad_request');
  const deviceCode = newToken();
  const userCode = newUserCode();
  await c.env.DB.prepare("INSERT INTO host_links (device_code_hash, user_code, host_name, host_pub, ui_version, state, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
    .bind(await hashToken(deviceCode), userCode, hostName, body.hostPub, uiVersion, c.nowMs + LINK_TTL_MS).run();
  return json(200, { deviceCode, userCode, verifyUrl: `${c.env.PUBLIC_ORIGIN}/link?code=${userCode}`, interval: 3, expiresIn: LINK_TTL_MS / 1000 } satisfies LinkStartRes);
}

async function pendingLink(c: Ctx, userCode: string | null): Promise<LinkRow | null> {
  if (!userCode) return null;
  return c.env.DB.prepare("SELECT * FROM host_links WHERE user_code = ? AND state = 'pending' AND expires_at > ?").bind(userCode, c.nowMs).first<LinkRow>();
}

/** sha256 of the host key, first 8 bytes as four hex groups. */
async function fingerprint(hostPub: string): Promise<string> {
  const hex = Array.from(fromB64u(await sha256B64u(fromB64u(hostPub))).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join(' ');
}

/**
 * `GET /link?code=` — says whether a code exists, so it is limited like approve (20/h per user, 40/h per IP,
 * wrong codes included; own counters, so viewing then approving does not eat the approve budget).
 */
export const linkGet = cookieRoute({ session: 'page' }, async (c) => {
  const userOk = await hit(c.env.DB, `link:view:user:${c.userId}`, 20, HOUR, c.nowMs);
  const ipOk = await hit(c.env.DB, `link:view:ip:${c.ip}`, 40, HOUR, c.nowMs);
  if (!userOk || !ipOk) return linkLimitedPage();
  const link = await pendingLink(c, normCode(c.url.searchParams.get('code')));
  if (!link) return linkMissingPage();
  return linkPage({ userCode: link.user_code, hostName: link.host_name, fingerprint: await fingerprint(link.host_pub) });
});

/**
 * `POST /v1/host/link/approve {userCode}` (web session + Origin). 10/h per user and 20/h per IP, wrong codes
 * included. Grants the trial once per normalized email and at most 3 per IP per day.
 *
 * Every limit is checked inside the statement that writes, so concurrent approvals cannot pass a stale count:
 * - the approve UPDATE carries the MAX_HOSTS count in its WHERE (0 rows → `host_limit`, or the code went to
 *   someone else → 409 `link_taken`; no trial is looked at before this succeeds);
 * - the trial claim INSERT carries the per-IP count in its WHERE, and the trial row and the counter bump are
 *   conditional on that claim row in the same batch (one transaction).
 */
export const linkApprove = cookieRoute({ session: 'required' }, async (c) => {
  const userOk = await hit(c.env.DB, `link:approve:user:${c.userId}`, 10, HOUR, c.nowMs);
  const ipOk = await hit(c.env.DB, `link:approve:ip:${c.ip}`, 20, HOUR, c.nowMs);
  if (!userOk || !ipOk) return problem(429, 'rate_limited');
  const body = await readBody(c.req);
  const link = await pendingLink(c, normCode(body.userCode));
  if (!link) return problem(404, 'unknown_code');

  const db = c.env.DB;
  const approved = await db.prepare(
    `UPDATE host_links SET state = 'approved', user_id = ?1
      WHERE device_code_hash = ?2 AND state = 'pending' AND expires_at > ?3
        AND (SELECT count(*) FROM hosts WHERE user_id = ?1 AND revoked_at IS NULL)
          + (SELECT count(*) FROM host_links WHERE user_id = ?1 AND state = 'approved' AND expires_at > ?3) < ?4`,
  ).bind(c.userId, link.device_code_hash, c.nowMs, Number(c.env.MAX_HOSTS)).run();
  if (approved.meta.changes !== 1) return (await pendingLink(c, link.user_code)) ? problem(409, 'host_limit') : problem(409, 'link_taken');

  const email = await db.prepare('SELECT email FROM users WHERE id = ?').bind(c.userId).first<string>('email');
  const key = await emailKey(c.env.EMAIL_HASH_SECRET, email ?? '');
  if (await db.prepare('SELECT 1 FROM trial_claims WHERE email_key = ?').bind(key).first()) return json(200, { trial: 'already_used' } satisfies LinkApproveRes);
  const ipKey = `trial:ip:${c.ip}`;
  const claimed = 'EXISTS (SELECT 1 FROM trial_claims WHERE email_key = ?1 AND user_id = ?2 AND claimed_at = ?3)';
  try {
    const [claim] = await db.batch([
      db.prepare(
        `INSERT INTO trial_claims (email_key, user_id, claimed_at) SELECT ?1, ?2, ?3
          WHERE COALESCE((SELECT count FROM rate WHERE key = ?4 AND window_start = ?5), 0) < ?6`,
      ).bind(key, c.userId, c.nowMs, ipKey, windowStart(DAY, c.nowMs), TRIALS_PER_IP_PER_DAY),
      db.prepare(`INSERT INTO trials (user_id, started_at, ends_at) SELECT ?2, ?3, ?4 WHERE ${claimed}`)
        .bind(key, c.userId, c.nowMs, c.nowMs + Number(c.env.TRIAL_DAYS) * DAY),
      db.prepare(
        `INSERT INTO rate (key, window_start, count) SELECT ?4, ?5, 1 WHERE ${claimed}
           ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
                                          window_start = excluded.window_start`,
      ).bind(key, c.userId, c.nowMs, ipKey, windowStart(DAY, c.nowMs)),
    ]);
    return json(200, { trial: claim!.meta.changes === 1 ? 'granted' : 'unavailable' } satisfies LinkApproveRes);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return json(200, { trial: 'already_used' } satisfies LinkApproveRes); // lost a race with another approval for the same person
    // The approval above is already committed: answer it as a success without a trial rather than a 500 that makes
    // the user retry an approval that went through. Metadata only in the log — no email, no SQL text.
    console.error(JSON.stringify({ ev: 'trial_grant_failed', user: c.userId, err: e instanceof Error ? e.name : 'error' }));
    return json(200, { trial: 'unavailable' } satisfies LinkApproveRes);
  }
});

/** `POST /v1/host/link/poll {deviceCode}` — 202 pending, 200 linked (token once), 429 slow_down, 410 gone. */
export async function linkPoll(c: Ctx): Promise<Response> {
  const body = await readBody(c.req);
  const db = c.env.DB;
  const codeHash = await hashToken(str(body, 'deviceCode', 128));
  const link = await db.prepare('SELECT * FROM host_links WHERE device_code_hash = ?').bind(codeHash).first<LinkRow>();
  if (!link) return problem(404, 'unknown_device_code');
  if (link.state === 'consumed' || link.state === 'denied' || link.expires_at <= c.nowMs) return problem(410, 'expired');
  if (link.last_poll !== null && c.nowMs - link.last_poll < POLL_MIN_MS) return problem(429, 'slow_down');
  await db.prepare('UPDATE host_links SET last_poll = ? WHERE device_code_hash = ?').bind(c.nowMs, codeHash).run();
  if (link.state === 'pending') return json(202, { state: 'pending' } satisfies LinkPollRes);

  // approved: claim the row first so two racing polls cannot both mint a host.
  const won = await db.prepare("UPDATE host_links SET state = 'consumed' WHERE device_code_hash = ? AND state = 'approved' RETURNING user_id").bind(codeHash).first<{ user_id: string }>();
  if (!won) return problem(410, 'expired');
  const hostId = newId();
  const hostToken = newToken();
  await db.prepare('INSERT INTO hosts (id, user_id, name, host_pub, token_hash, ui_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(hostId, won.user_id, link.host_name, link.host_pub, await hashToken(hostToken), link.ui_version, c.nowMs).run();
  const email = await db.prepare('SELECT email FROM users WHERE id = ?').bind(won.user_id).first<string>('email');
  return json(200, { state: 'linked', hostId, hostToken, email: email ?? '' } satisfies LinkPollRes);
}

/** `POST /v1/host/unlink` (host) — the token stops working, every device of the host is revoked and its relay room closes all (4401). */
export async function hostUnlink(c: Ctx): Promise<Response> {
  const host = await hostAuth(c.env, c.req);
  if (!host) return problem(401, 'unauthorized');
  const db = c.env.DB;
  await db.batch([
    db.prepare('UPDATE hosts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(c.nowMs, host.id),
    db.prepare("UPDATE devices SET state = 'revoked' WHERE host_id = ?").bind(host.id),
    db.prepare("UPDATE pairings SET state = 'expired' WHERE host_id = ? AND state IN ('open', 'claimed')").bind(host.id),
  ]);
  notifyRelay(c, host.id, 'unlink');
  return json(200, { ok: true });
}
