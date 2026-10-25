import { cookieRoute, endSession } from './auth/session';
import { liveSubscription } from './billing';
import { json, problem, readBody } from './http';
import { page } from './pages/layout';
import { HOUR, hit } from './rate';
import { notifyRelay } from './relay/routes';

/**
 * `POST /v1/account/delete {confirm: 'DELETE'}` (web session + Origin, 5 an hour per user). 409 `active_subscription`
 * while a subscription is running and set to renew (cancel it under Manage billing first). Otherwise one batch,
 * children first; kept: the `trial_claims` row (an irreversible email-key hash, so the trial stays used) and the
 * `subscriptions` rows (Paddle keeps the payment record as seller) — both with `user_id` NULL. Then every host's
 * relay room closes (4401) and the cookie is cleared.
 */
export const accountDelete = cookieRoute({ session: 'required' }, async (c) => {
  const db = c.env.DB;
  const uid = c.userId;
  if (!(await hit(db, `account:delete:user:${uid}`, 5, HOUR, c.nowMs))) return problem(429, 'rate_limited');
  const body = await readBody(c.req);
  if (body.confirm !== 'DELETE') return problem(400, 'confirm_required');
  if (await liveSubscription(db, uid, c.nowMs, { renewing: true })) return problem(409, 'active_subscription');

  const email = (await db.prepare('SELECT email FROM users WHERE id = ?').bind(uid).first<string>('email')) ?? '';
  const hosts = (await db.prepare('SELECT id FROM hosts WHERE user_id = ?').bind(uid).all<{ id: string }>()).results.map((h) => h.id);
  const rateKeys = ['link:approve', 'link:view', 'unlink', 'account:delete'].map((k) => `${k}:user:${uid}`);
  await db.batch([
    db.prepare('DELETE FROM relay_tickets WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM devices WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM pairings WHERE host_id IN (SELECT id FROM hosts WHERE user_id = ?)').bind(uid),
    db.prepare('DELETE FROM hosts WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM host_links WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM web_sessions WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM magic_links WHERE email = ?').bind(email),
    db.prepare('DELETE FROM outbox WHERE lower(to_addr) = ?').bind(email),
    db.prepare('DELETE FROM trials WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM grants WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM checkout_intents WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM paddle_link_pending WHERE user_id = ?').bind(uid),
    db.prepare('UPDATE trial_claims SET user_id = NULL WHERE user_id = ?').bind(uid),
    db.prepare('UPDATE subscriptions SET user_id = NULL WHERE user_id = ?').bind(uid),
    db.prepare('UPDATE ops_alerts SET ref = NULL WHERE ref = ?').bind(uid),
    db.prepare(`DELETE FROM rate WHERE key IN (${rateKeys.map(() => '?').join(', ')})`).bind(...rateKeys),
    db.prepare('DELETE FROM users WHERE id = ?').bind(uid),
  ]);
  for (const id of hosts) notifyRelay(c, id, 'unlink');
  return json(200, { ok: true }, { 'set-cookie': await endSession(c) });
});

/** `GET /account/deleted` — where account.js lands after a deletion; no session needed. */
export const accountDeletedGet = async (): Promise<Response> => page('Account deleted', `<h1>Your account has been deleted</h1>
<p>Your Macs, phones, sessions and sign-in links are gone. The trial stays used for this email address.</p>
<p><a href="/login">Back to sign in</a></p>`);
