import { cookieRoute, endSession } from '../auth/session';
import { type Entitled, entitledState } from '../entitled';
import type { Env } from '../env';
import { NO_CUSTOMER_MESSAGE, deleteBlock, liveSubscription } from '../billing';
import { redirect } from '../http';
import { PRO_LINE, day, esc, page } from './layout';

const DAY_MS = 86_400_000;

type SubRow = { price_id: string | null; period_end: number | null; scheduled_cancel: number };

/** The plan line: trial days left / Pro monthly·yearly · next payment / payment needs attention / canceled · until / expired. */
function planLine(e: Entitled, sub: SubRow | null, env: Env, everHad: boolean, nowMs: number): string {
  if (e.plan === 'trial') {
    const n = Math.max(1, Math.ceil((e.untilMs - nowMs) / DAY_MS));
    return `Trial · ${n} ${n === 1 ? 'day' : 'days'} left`;
  }
  if (e.plan === 'comp') return `Pro (invited) · until ${day(e.untilMs)}`;
  if (e.plan === 'pro') {
    if (e.st === 'past_due') return `Payment needs attention · Pro kept until ${day(e.untilMs)}`;
    if (e.st === 'canceled') return `Canceled · until ${day(e.untilMs)}`;
    if (sub?.scheduled_cancel && sub.period_end !== null) return `Canceled · until ${day(sub.period_end)}`;
    const cycle = sub?.price_id && sub.price_id === env.PADDLE_PRICE_YEARLY ? 'yearly' : 'monthly';
    return sub?.period_end ? `Pro · ${cycle} · next payment ${day(sub.period_end)}` : `Pro · ${cycle}`;
  }
  return everHad ? 'Expired' : 'No plan yet';
}

/**
 * `GET /account` (web session, else `/login?next=/account`): email, plan, linked Macs [Unlink], phones [Revoke],
 * [Subscribe monthly]·[Subscribe yearly] (no live subscription) or [Manage billing] (a linked Paddle customer),
 * [Sign out], and "Delete account" (what goes, what stays; blocked while a subscription renews). No third-party script — Paddle.js lives on /checkout only.
 */
export const accountGet = cookieRoute({ session: 'page' }, async (c) => {
  const db = c.env.DB;
  const e = await entitledState(db, c.userId, c.nowMs);
  const [user, hosts, devices, sub, pending, history] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT email, paddle_customer_id FROM users WHERE id = ?').bind(c.userId),
    db.prepare('SELECT id, name, created_at FROM hosts WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at').bind(c.userId),
    db.prepare("SELECT id, name, created_at FROM devices WHERE user_id = ? AND state = 'active' ORDER BY created_at").bind(c.userId),
    db.prepare("SELECT price_id, period_end, scheduled_cancel FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY period_end DESC LIMIT 1").bind(c.userId),
    db.prepare('SELECT 1 AS x FROM checkout_intents WHERE user_id = ? AND completed_at IS NOT NULL AND expires_at > ?').bind(c.userId, c.nowMs),
    db.prepare('SELECT (EXISTS (SELECT 1 FROM trials WHERE user_id = ?1) OR EXISTS (SELECT 1 FROM subscriptions WHERE user_id = ?1) OR EXISTS (SELECT 1 FROM grants WHERE user_id = ?1)) AS x').bind(c.userId),
  ]);
  const u = user!.results[0] as { email: string; paddle_customer_id: string | null } | undefined;
  const live = await liveSubscription(db, c.userId, c.nowMs); // same rule as checkoutBlock
  const isPending = !live && pending!.results.length > 0;
  const hostRows = hosts!.results as { id: string; name: string; created_at: number }[];
  const deviceRows = devices!.results as { id: string; name: string; created_at: number }[];
  const line = planLine(e, (sub!.results[0] as SubRow | undefined) ?? null, c.env, Boolean((history!.results[0] as { x: number } | undefined)?.x), c.nowMs);

  const hostList = hostRows.length
    ? `<ul class="items">${hostRows.map((h) => `<li><span>${esc(h.name)}</span><small>linked ${day(h.created_at)}</small><button type="button" data-host="${esc(h.id)}">Unlink</button></li>`).join('')}</ul>`
    : '<p class="muted">No Mac linked yet. Start linking from AI msg on your Mac.</p>';
  const deviceList = deviceRows.length
    ? `<ul class="items">${deviceRows.map((d) => `<li><span>${esc(d.name)}</span><small>added ${day(d.created_at)}</small><button type="button" data-device="${esc(d.id)}">Revoke</button></li>`).join('')}</ul>`
    : '<p class="muted">No phone paired yet.</p>';
  const actions = [
    !live && !isPending ? '<a class="button" href="/checkout?plan=pro-monthly">Subscribe monthly</a><a class="button" href="/checkout?plan=pro-yearly">Subscribe yearly</a>' : '',
    u?.paddle_customer_id ? '<button type="button" id="manage-billing">Manage billing</button>' : '',
  ].join('');
  // A subscription with no linked customer (paid under someone else's Paddle customer): say so instead of a dead button.
  const unlinked = !u?.paddle_customer_id && live ? `<p class="muted" id="billing-unavailable">${esc(NO_CUSTOMER_MESSAGE)}</p>` : '';
  // Same rule as POST /v1/account/delete (deleteBlock).
  const block = await deleteBlock(db, c.userId, c.nowMs);
  const deletion = block === 'active_subscription'
    ? '<p id="delete-blocked">You have a subscription that renews. Cancel it under Manage billing first, then delete your account.</p>'
    : block === 'payment_pending'
      ? '<p id="delete-blocked">A payment is still being processed. Try again in a few minutes.</p>'
      : `<div id="delete-account"><label for="delete-confirm">To confirm, type DELETE</label>
<input id="delete-confirm" autocomplete="off" spellcheck="false">
<button type="button" id="delete-button">Delete my account</button></div>`;

  return page('Account', `<h1>Your account</h1>
<p>Signed in as <strong>${esc(u?.email ?? '')}</strong></p>
<section><h2>Plan</h2>
<p id="plan">${esc(line)}</p>
${isPending ? '<p id="pending" role="status">Payment received — confirming. This takes up to a minute.</p>' : ''}
<p class="muted">${PRO_LINE}</p>
<div class="actions">${actions}</div>
${unlinked}
</section>
<section><h2>Macs</h2>${hostList}</section>
<section><h2>Phones</h2>${deviceList}</section>
<section><h2>Delete account</h2>
<ul>
<li>Deleted: your email address, sign-in sessions and links, linked Macs and paired phones (they stop working at once), trial and invitation.</li>
<li>Kept: a one-way key of your email address, so the free trial stays used if you sign up again.</li>
<li>Kept: subscription records, without your account — Paddle keeps payment records as the seller.</li>
</ul>
${deletion}
</section>
<p id="result" role="status"></p>
<form method="post" action="/logout"><button type="submit">Sign out</button></form>`, { scripts: ['/static/account.js'] });
});

/** `POST /logout` — the account page's no-script form (same Origin check as every cookie route). */
export const signOut = cookieRoute({ session: 'required', form: true }, async (c) => redirect('/login', { 'set-cookie': await endSession(c) }));

/** `/static/account.js` — Unlink / Revoke / Manage billing / Delete account (JSON POSTs with the page's own Origin); while a payment confirms, reload every 10 s. */
export const ACCOUNT_JS = `(() => {
  const out = document.getElementById('result');
  const say = (t) => { if (out) out.textContent = t; };
  const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const act = async (button, path, question) => {
    if (!window.confirm(question)) return;
    button.disabled = true;
    try {
      const r = await post(path);
      if (r.ok) { location.reload(); return; }
      const body = await r.json().catch(() => ({}));
      say('That did not work (' + (body.code || r.status) + ').');
    } catch { say('Network error — try again.'); }
    button.disabled = false;
  };
  document.querySelectorAll('[data-host]').forEach((b) => b.addEventListener('click', () => act(b, '/v1/hosts/' + encodeURIComponent(b.dataset.host) + '/unlink', 'Unlink this Mac? Its phones stop working too.')));
  document.querySelectorAll('[data-device]').forEach((b) => b.addEventListener('click', () => act(b, '/v1/devices/' + encodeURIComponent(b.dataset.device) + '/revoke', 'Revoke this phone?')));
  const manage = document.getElementById('manage-billing');
  if (manage) manage.addEventListener('click', async () => {
    manage.disabled = true;
    try {
      const r = await post('/v1/billing/portal');
      const body = await r.json().catch(() => ({}));
      if (r.ok && typeof body.url === 'string' && body.url.startsWith('https://')) { location.href = body.url; return; }
      say(body.code === 'no_customer' && body.error ? body.error : 'Billing is not available right now (' + (body.code || r.status) + ').');
    } catch { say('Network error — try again.'); }
    manage.disabled = false;
  });
  const del = document.getElementById('delete-button');
  const confirmBox = document.getElementById('delete-confirm');
  if (del && confirmBox) del.addEventListener('click', async () => {
    if (confirmBox.value !== 'DELETE') { say('Type DELETE to confirm.'); return; }
    del.disabled = true;
    try {
      const r = await post('/v1/account/delete', { confirm: confirmBox.value });
      if (r.ok) { location.href = '/account/deleted'; return; }
      const body = await r.json().catch(() => ({}));
      say(body.code === 'active_subscription' ? 'Cancel your subscription under Manage billing first.' : body.code === 'payment_pending' ? 'A payment is still being processed. Try again in a few minutes.' : 'That did not work (' + (body.code || r.status) + ').');
    } catch { say('Network error — try again.'); }
    del.disabled = false;
  });
  if (document.getElementById('pending')) setTimeout(() => location.reload(), 10000);
})();
`;
