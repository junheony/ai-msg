import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { emailKey } from '../src/auth/email';
import { type Sock, bearer, call, linkHost, loginAs, openWs, pairedDevice, post, waitFor } from './helpers';

const DAY = 86_400_000;
let seq = 0;
const email = () => `del${seq++}@example.test`;
const userId = async (addr: string) => (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(addr).first<string>('id'))!;
const n = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<number>('n'))!;
const del = (cookie: string, body: unknown = { confirm: 'DELETE' }, headers: Record<string, string | null> = {}) => post('/v1/account/delete', body, { cookie, ...headers });
async function subscribe(uid: string, o: { status?: string; scheduledCancel?: number; periodEnd?: number; pastDueSince?: number | null } = {}): Promise<string> {
  const id = `sub_del${seq++}`;
  await env.DB.prepare('INSERT INTO subscriptions (id, user_id, status, period_end, past_due_since, scheduled_cancel, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, uid, o.status ?? 'active', o.periodEnd ?? Date.now() + 30 * DAY, o.pastDueSince ?? (o.status === 'past_due' ? Date.now() : null), o.scheduledCancel ?? 0, Date.now(), Date.now()).run();
  return id;
}

/** A user with a linked Mac, one paired phone and the Mac's relay socket open. */
async function linkedUserWithRelay(addr: string): Promise<{ id: string; cookie: string; hostId: string; hostWs: Sock }> {
  const h = await linkHost(addr);
  await pairedDevice(h);
  const hostWs = await openWs('/relay/host', bearer(h.hostToken));
  expect(hostWs.status).toBe(101);
  await waitFor(() => hostWs.inbox.length > 0);
  return { id: await userId(addr), cookie: h.cookie, hostId: h.hostId, hostWs };
}

describe('POST /v1/account/delete', () => {
  it('needs session, Origin and confirm', async () => {
    const addr = email();
    const cookie = await loginAs(addr);
    expect((await post('/v1/account/delete', { confirm: 'DELETE' })).status).toBe(401);
    expect((await del(cookie, { confirm: 'DELETE' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await del(cookie, { confirm: 'DELETE' }, { origin: null })).status).toBe(403);
    for (const body of [{}, { confirm: 'delete' }, { confirm: 'DELETE ' }, { confirm: true }]) {
      const r = await del(cookie, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'confirm_required' });
    }
    expect(await userId(addr)).toBeTruthy();
  });

  it('is rate limited per user (5 an hour)', async () => {
    const cookie = await loginAs(email());
    for (let i = 0; i < 5; i++) expect((await del(cookie, {})).status).toBe(400);
    const r = await del(cookie, {});
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('active subscription → 409 active_subscription, nothing deleted', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      const addr = email();
      const cookie = await loginAs(addr);
      const uid = await userId(addr);
      await subscribe(uid, { status });
      const r = await del(cookie);
      expect(r.status, status).toBe(409);
      expect(await r.json()).toMatchObject({ code: 'active_subscription' });
      expect(await n('SELECT count(*) AS n FROM users WHERE id = ?', uid)).toBe(1);
      expect(await n('SELECT count(*) AS n FROM web_sessions WHERE user_id = ?', uid)).toBe(1);
      const page = await (await call('/account', { headers: { cookie } })).text();
      expect(page).toContain('id="delete-blocked"');
      expect(page).not.toContain('id="delete-account"');
    }
  });

  it('a renewing subscription blocks deletion even when it looks stale (no time window)', async () => {
    for (const o of [{ periodEnd: Date.now() - 4 * DAY }, { status: 'past_due', pastDueSince: Date.now() - 8 * DAY }, { status: 'trialing', periodEnd: Date.now() - 30 * DAY }]) {
      const addr = email();
      const cookie = await loginAs(addr);
      const uid = await userId(addr);
      await subscribe(uid, o);
      const r = await del(cookie);
      expect(r.status, JSON.stringify(o)).toBe(409);
      expect(await r.json()).toMatchObject({ code: 'active_subscription' });
      expect(await n('SELECT count(*) AS n FROM users WHERE id = ?', uid)).toBe(1);
      expect(await (await call('/account', { headers: { cookie } })).text()).toContain('id="delete-blocked"');
    }
  });

  it('a finished checkout still waiting for its webhook blocks deletion (409 payment_pending)', async () => {
    const addr = email();
    const cookie = await loginAs(addr);
    const uid = await userId(addr);
    await env.DB.prepare("INSERT INTO checkout_intents (user_id, plan, completed_at, expires_at) VALUES (?, 'pro-monthly', ?, ?)").bind(uid, Date.now(), Date.now() + 15 * 60_000).run();
    const r = await del(cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'payment_pending' });
    expect(await n('SELECT count(*) AS n FROM users WHERE id = ?', uid)).toBe(1);
    const page = await (await call('/account', { headers: { cookie } })).text();
    expect(page).toContain('id="delete-blocked"');
    expect(page).toMatch(/payment is still being processed/i);
    expect(page).not.toContain('id="delete-account"');
    // An open (not finished) intent or an expired lock does not block.
    await env.DB.prepare('UPDATE checkout_intents SET completed_at = NULL, expires_at = ? WHERE user_id = ?').bind(Date.now() + 60 * 60_000, uid).run();
    expect((await del(cookie)).status).toBe(200);
  });

  it('a subscription set to cancel, or a canceled one, does not block deletion', async () => {
    for (const o of [{ scheduledCancel: 1 }, { status: 'past_due', scheduledCancel: 1 }, { status: 'canceled' }]) {
      const addr = email();
      const cookie = await loginAs(addr);
      const uid = await userId(addr);
      const sub = await subscribe(uid, o);
      expect((await del(cookie)).status, JSON.stringify(o)).toBe(200);
      expect(await env.DB.prepare('SELECT user_id FROM subscriptions WHERE id = ?').bind(sub).first()).toEqual({ user_id: null });
    }
  });

  it('deletes the account, keeps the trial claim, closes the relay', async () => {
    const addr = 'a.b+x@gmail.com';
    const { id, cookie, hostId, hostWs } = await linkedUserWithRelay(addr);
    await env.DB.prepare("INSERT INTO grants (user_id, plan, until) VALUES (?, 'comp', ?)").bind(id, Date.now() + DAY).run();
    await env.DB.prepare("INSERT INTO checkout_intents (user_id, plan, expires_at) VALUES (?, 'pro-monthly', ?)").bind(id, Date.now() + DAY).run();
    await env.DB.prepare('INSERT INTO paddle_link_pending (customer_id, user_id, created_at) VALUES (?, ?, ?)').bind('ctm_del', id, Date.now()).run();
    await env.DB.prepare("INSERT INTO ops_alerts (kind, ref, detail, created_at) VALUES ('unmatched', ?, 'x', ?)").bind(id, Date.now()).run();
    await env.DB.prepare('INSERT INTO relay_tickets (ticket_hash, device_id, host_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)').bind(`t_${id}`, 'd', hostId, id, Date.now() + 60_000).run();
    // Someone else's rows stay.
    const other = await linkHost(email());

    const r = await del(cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-aimsg_web=; .*Max-Age=0/);

    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first()).toBeNull();
    for (const t of ['hosts', 'devices', 'web_sessions', 'trials', 'grants', 'checkout_intents', 'paddle_link_pending', 'relay_tickets']) {
      expect(await n(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, id), t).toBe(0);
    }
    expect(await n('SELECT count(*) AS n FROM host_links WHERE user_id = ?', id)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM pairings WHERE host_id = ?', hostId)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM magic_links WHERE email = ?', addr)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM outbox WHERE to_addr = ?', addr)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM ops_alerts WHERE ref = ?', id)).toBe(0);
    expect(await n("SELECT count(*) AS n FROM rate WHERE key LIKE '%' || ?", id)).toBe(0);
    expect(await env.DB.prepare('SELECT user_id FROM trial_claims WHERE email_key = ?').bind(await emailKey(env.EMAIL_HASH_SECRET, addr)).first()).toEqual({ user_id: null });
    expect(await n('SELECT count(*) AS n FROM hosts WHERE id = ?', other.hostId)).toBe(1);

    await waitFor(() => hostWs.closes.includes(4401));
    // The cookie no longer signs anyone in.
    expect((await call('/account', { headers: { cookie } })).headers.get('location')).toBe('/login?next=%2Faccount');
    // The goodbye page needs no session.
    const bye = await call('/account/deleted');
    expect(bye.status).toBe(200);
    expect(await bye.text()).toContain('Your account has been deleted');
  });

  it('signing up again with an equivalent address gets trial already_used', async () => {
    const first = await linkHost('c.d+one@gmail.com');
    expect(first.trial).toBe('granted');
    expect((await del(first.cookie)).status).toBe(200);
    expect((await linkHost('cd@gmail.com')).trial).toBe('already_used');
  });

  it('the account page explains what is deleted and kept, and account.js confirms with DELETE', async () => {
    const cookie = await loginAs(email());
    const html = await (await call('/account', { headers: { cookie } })).text();
    expect(html).toContain('id="delete-account"');
    expect(html).toContain('id="delete-confirm"');
    expect(html).toMatch(/type DELETE/i);
    expect(html).toMatch(/trial/i);
    const js = await (await call('/static/account.js')).text();
    expect(js).toContain('/v1/account/delete');
    expect(js).toContain("'/account/deleted'");
  });
});
