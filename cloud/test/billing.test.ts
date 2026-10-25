import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAST_DUE_GRACE_MS, RENEWAL_GRACE_MS } from '../src/entitled';
import { checkConfig, deps } from '../src/index';
import type { Env } from '../src/env';
import { type PaddleApi, paddleApi } from '../src/paddle/api';
import { verifyUserRef } from '../src/paddle/userRef';
import { APP, RELAY, call, linkHost, loginAs, pairedDevice, post } from './helpers';

const CHECKOUT_SECRET = 'k'.repeat(32); // TEST_VARS
const DAY = 86_400_000;

class FakePaddle implements PaddleApi {
  portalCalls: [string, string[]][] = [];
  async cancelSubscription(): Promise<void> {}
  async portalSession(customerId: string, subscriptionIds: string[]): Promise<{ url: string }> {
    this.portalCalls.push([customerId, subscriptionIds]);
    return { url: 'https://customer-portal.paddle.test/cpl_x' };
  }
}
let paddle: FakePaddle;
const realDeps = { ...deps };
beforeEach(() => { paddle = new FakePaddle(); deps.paddle = () => paddle; });
afterEach(() => { Object.assign(deps, realDeps); });

let seq = 0;
/** A signed-in user with its own email; `id` read back from D1. */
async function user(): Promise<{ id: string; email: string; cookie: string }> {
  const email = `billing${seq++}@example.test`;
  const cookie = await loginAs(email);
  const id = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<string>('id'))!;
  return { id, email, cookie };
}
const web = (u: { cookie: string }) => ({ headers: { cookie: u.cookie } });
const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] ?? null;
async function subscribe(userId: string, o: { status?: string; sub?: string; customer?: string; price?: string } = {}): Promise<string> {
  const sub = o.sub ?? `sub_b${seq++}`;
  await env.DB.prepare('INSERT INTO subscriptions (id, user_id, customer_id, status, price_id, period_end, past_due_since, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(sub, userId, o.customer ?? null, o.status ?? 'active', o.price ?? 'pri_monthly_test', Date.now() + 30 * DAY, o.status === 'past_due' ? Date.now() : null, Date.now(), Date.now()).run();
  return sub;
}
const setCustomer = (userId: string, ctm: string) => env.DB.prepare('UPDATE users SET paddle_customer_id = ? WHERE id = ?').bind(ctm, userId).run();

describe('/checkout (app origin)', () => {
  it('/checkout without a session → login with next', async () => {
    const r = await call('/checkout?plan=pro-monthly');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/login?next=%2Fcheckout%3Fplan%3Dpro-monthly');
  });

  it('/checkout renders data-* only, no user id or ref in the page, no inline script, Paddle only in its CSP', async () => {
    const u = await user();
    const r = await call('/checkout?plan=pro-monthly', web(u));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toMatch(/<script>(?!<\/script>)|<script[^>]*>[^<]+<\/script>/);
    expect(html).not.toContain('data-user-id');
    expect(html).not.toContain(u.id);
    expect(attr(html, 'data-ref')).toBeNull(); // the ref is issued by POST /v1/billing/intent, after the intent row exists
    expect(attr(html, 'data-token')).toBe('test_client_token');
    expect(attr(html, 'data-price')).toBe('pri_monthly_test');
    expect(attr(html, 'data-email')).toBe(u.email);
    expect(attr(html, 'data-env')).toBe('sandbox');
    expect(html).toContain('src="https://cdn.paddle.com/paddle/v2/paddle.js"');
    expect(html).toContain('src="/static/checkout.js"');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' https://cdn.paddle.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect((await call('/checkout?plan=pro-yearly', web(u))).status).toBe(200);
    expect((await call('/checkout?plan=lifetime', web(u))).status).toBe(400);
  });

  it('intent issues the signed ref only after writing the intent row', async () => {
    const u = await user();
    const r = await post('/v1/billing/intent', { plan: 'pro-yearly' }, { cookie: u.cookie });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ref: string };
    expect(await verifyUserRef(CHECKOUT_SECRET, body.ref)).toBe(u.id);
    const row = await env.DB.prepare('SELECT plan, completed_at, expires_at FROM checkout_intents WHERE user_id = ?').bind(u.id).first<{ plan: string; completed_at: number | null; expires_at: number }>();
    expect(row).toMatchObject({ plan: 'pro-yearly', completed_at: null });
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await post('/v1/billing/intent', { plan: 'pro-weekly' }, { cookie: u.cookie })).status).toBe(400);
  });

  it('checkout pages are 404 on the relay origin and Paddle never appears in relay CSP', async () => {
    const u = await user();
    for (const p of ['/checkout?plan=pro-monthly', '/account', '/static/checkout.js', '/static/account.js', '/static/pages.css']) {
      const r = await call(p, web(u), RELAY);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-security-policy')).not.toMatch(/paddle/i);
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    for (const p of ['/v1/billing/intent', '/v1/billing/intent/complete', '/v1/billing/portal']) {
      expect((await post(p, {}, { cookie: u.cookie }, RELAY)).status, p).toBe(404);
    }
  });

  it('static files: the three names only, right types; boot.js is not served on the app origin', async () => {
    const js = await call('/static/checkout.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await js.text()).toContain('Paddle.Checkout.open');
    expect((await call('/static/account.js')).headers.get('content-type')).toMatch(/^text\/javascript/);
    expect((await call('/static/pages.css')).headers.get('content-type')).toMatch(/^text\/css/);
    expect((await call('/static/boot.js')).status).toBe(404);
  });

  it('/checkout with an active, trialing or past_due subscription → /account; intent says already_subscribed', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      const u = await user();
      await subscribe(u.id, { status });
      const r = await call('/checkout?plan=pro-monthly', web(u));
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/account');
      const i = await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie });
      expect(i.status).toBe(409);
      expect(await i.json()).toMatchObject({ code: 'already_subscribed' });
    }
  });

  it('a live subscription blocks checkout even when a longer comp grant wins the plan; the account page offers no Subscribe', async () => {
    const u = await user();
    await subscribe(u.id);
    await env.DB.prepare("INSERT INTO grants (user_id, plan, until) VALUES (?, 'comp', ?)").bind(u.id, Date.now() + 365 * DAY).run();
    expect((await call('/checkout?plan=pro-yearly', web(u))).headers.get('location')).toBe('/account');
    const i = await post('/v1/billing/intent', { plan: 'pro-yearly' }, { cookie: u.cookie });
    expect(i.status).toBe(409);
    expect(await i.json()).toMatchObject({ code: 'already_subscribed' });
    expect(await (await call('/account', web(u))).text()).not.toContain('/checkout?plan=');
  });

  it('a canceled subscription does not block checkout', async () => {
    const u = await user();
    await subscribe(u.id, { status: 'canceled' });
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie })).status).toBe(200);
  });

  it('an active subscription past period_end + the entitlement renewal grace (missed cancel webhook) or a past_due one past its 7 days does not block checkout', async () => {
    const u = await user();
    const sub = await subscribe(u.id);
    await env.DB.prepare('UPDATE subscriptions SET period_end = ? WHERE id = ?').bind(Date.now() - RENEWAL_GRACE_MS - 60_000, sub).run();
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie })).status).toBe(200);
    expect(await (await call('/account', web(u))).text()).toContain('href="/checkout?plan=pro-monthly"');

    const d = await user();
    const due = await subscribe(d.id, { status: 'past_due' });
    await env.DB.prepare('UPDATE subscriptions SET past_due_since = ? WHERE id = ?').bind(Date.now() - PAST_DUE_GRACE_MS - 60_000, due).run();
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: d.cookie })).status).toBe(200);

    const recent = await user();
    const r = await subscribe(recent.id);
    await env.DB.prepare('UPDATE subscriptions SET period_end = ? WHERE id = ?').bind(Date.now() - RENEWAL_GRACE_MS + 60 * 60_000, r).run(); // still inside the grace: Pro holds, so checkout stays blocked
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: recent.cookie })).status).toBe(409);
  });

  it('an open intent lasts 60 minutes (time on the Paddle overlay); complete cannot revive an expired one', async () => {
    const u = await user();
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie })).status).toBe(200);
    const exp = await env.DB.prepare('SELECT expires_at FROM checkout_intents WHERE user_id = ?').bind(u.id).first<number>('expires_at');
    expect(exp! - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(exp! - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    await env.DB.prepare('UPDATE checkout_intents SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1, u.id).run();
    const r = await post('/v1/billing/intent/complete', {}, { cookie: u.cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'no_intent' });
    const row = await env.DB.prepare('SELECT completed_at FROM checkout_intents WHERE user_id = ?').bind(u.id).first<number | null>('completed_at');
    expect(row).toBeNull();
  });

  it('completed intent within 15 min → /account?pending=1; intent API returns payment_pending; account shows it', async () => {
    const u = await user();
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie })).status).toBe(200);
    expect((await post('/v1/billing/intent/complete', {}, { cookie: u.cookie })).status).toBe(200);
    expect((await call('/checkout?plan=pro-yearly', web(u))).headers.get('location')).toBe('/account?pending=1');
    const again = await post('/v1/billing/intent', { plan: 'pro-yearly' }, { cookie: u.cookie });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'payment_pending' });
    expect(await (await call('/account?pending=1', web(u))).text()).toContain('Payment received — confirming. This takes up to a minute.');
    // Past its 15 minutes the lock lifts (the webhook never came: Task 9's second_subscription alert is the last net).
    await env.DB.prepare('UPDATE checkout_intents SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1, u.id).run();
    expect((await post('/v1/billing/intent', { plan: 'pro-yearly' }, { cookie: u.cookie })).status).toBe(200);
  });

  it('complete without an open intent is 409 no_intent', async () => {
    const u = await user();
    const r = await post('/v1/billing/intent/complete', {}, { cookie: u.cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'no_intent' });
  });

  it('an abandoned (not completed) intent does not block a retry', async () => {
    const u = await user();
    expect((await post('/v1/billing/intent', { plan: 'pro-monthly' }, { cookie: u.cookie })).status).toBe(200);
    expect((await post('/v1/billing/intent', { plan: 'pro-yearly' }, { cookie: u.cookie })).status).toBe(200);
    expect((await call('/checkout?plan=pro-yearly', web(u))).status).toBe(200);
  });

  it('checkout is 503 when Paddle is not configured', async () => {
    const u = await user();
    const saved = env.PADDLE_CLIENT_TOKEN;
    try {
      (env as { PADDLE_CLIENT_TOKEN?: string }).PADDLE_CLIENT_TOKEN = '';
      expect((await call('/checkout?plan=pro-monthly', web(u))).status).toBe(503);
    } finally {
      (env as { PADDLE_CLIENT_TOKEN?: string }).PADDLE_CLIENT_TOKEN = saved;
    }
  });
});

describe('billing API guards and portal', () => {
  it('intent / portal need session + Origin; portal is no-store', async () => {
    const u = await user();
    for (const p of ['/v1/billing/intent', '/v1/billing/intent/complete', '/v1/billing/portal']) {
      expect((await post(p, { plan: 'pro-monthly' })).status, p).toBe(401);
      expect((await post(p, { plan: 'pro-monthly' }, { cookie: u.cookie, origin: 'https://evil.example' })).status, p).toBe(403);
      expect((await post(p, { plan: 'pro-monthly' }, { cookie: u.cookie, origin: null })).status, p).toBe(403);
      expect((await post(p, { plan: 'pro-monthly' }, { cookie: u.cookie, origin: RELAY })).status, p).toBe(403);
    }
    expect(paddle.portalCalls).toEqual([]);
    await setCustomer(u.id, `ctm_g${seq++}`);
    const r = await post('/v1/billing/portal', {}, { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ url: 'https://customer-portal.paddle.test/cpl_x' });
  });

  it('portal: no linked customer → 409 no_customer, Paddle not called', async () => {
    const u = await user();
    const r = await post('/v1/billing/portal', {}, { cookie: u.cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ code: 'no_customer', error: "The billing page can't be opened for this account. This happens when the email used at checkout differs from your account email — contact support." });
    expect(paddle.portalCalls).toEqual([]);
  });

  it('a subscription without a linked customer (paid under another customer): portal 409, account page says contact support', async () => {
    const u = await user();
    await subscribe(u.id, { customer: `ctm_someone_else${seq++}` }); // Task 9: the subscription is theirs, the customer stays unlinked
    const r = await post('/v1/billing/portal', {}, { cookie: u.cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'no_customer' });
    expect(paddle.portalCalls).toEqual([]);
    const html = await (await call('/account', web(u))).text();
    expect(html).not.toContain('id="manage-billing"');
    expect(html).toContain('id="billing-unavailable"');
    expect(html).toContain('email used at checkout differs from your account email');
    expect(html).toContain('contact support');
  });

  it('checkout.js opens Paddle with the account email prefilled and email change hidden (allowLogout: false), ref only in customData', async () => {
    const u = await user();
    const html = await (await call('/checkout?plan=pro-yearly', web(u))).text();
    const src = await (await call('/static/checkout.js')).text();
    const opened: unknown[] = [];
    const posts: { path: string; body: string }[] = [];
    const el = (data: Record<string, string> = {}) => ({ dataset: data, disabled: false, textContent: '', addEventListener: () => {} });
    const nodes: Record<string, unknown> = {
      checkout: el({ plan: 'pro-yearly', token: attr(html, 'data-token')!, price: attr(html, 'data-price')!, email: attr(html, 'data-email')!, env: 'sandbox' }),
      'open-checkout': el(), result: el(),
    };
    const fakeWindow = { Paddle: { Environment: { set: () => {} }, Initialize: () => {}, Checkout: { open: (o: unknown) => opened.push(o) } } };
    const fakeFetch = async (path: string, init: { body: string }) => { posts.push({ path, body: init.body }); return new Response(JSON.stringify({ ref: 'signed-ref' }), { status: 200 }); };
    const run = new Function('window', 'Paddle', 'document', 'fetch', 'location', src);
    run(fakeWindow, fakeWindow.Paddle, { getElementById: (id: string) => nodes[id] ?? null }, fakeFetch, { href: '' });
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([{ path: '/v1/billing/intent', body: '{"plan":"pro-yearly"}' }]);
    expect(opened).toEqual([{ items: [{ priceId: 'pri_yearly_test', quantity: 1 }], customer: { email: u.email }, customData: { ref: 'signed-ref' }, settings: { displayMode: 'overlay', allowLogout: false } }]);
  });

  it("portal: only this user's subscriptions under its own customer — never another user's id", async () => {
    const a = await user();
    const b = await user();
    const ctmA = `ctm_a${seq++}`;
    const ctmB = `ctm_b${seq++}`;
    await setCustomer(a.id, ctmA);
    await setCustomer(b.id, ctmB);
    const mine = await subscribe(a.id, { customer: ctmA });
    const minePastDue = await subscribe(a.id, { customer: ctmA, status: 'past_due' });
    await subscribe(a.id, { customer: ctmA, status: 'canceled' }); // over: nothing to manage
    await subscribe(a.id, { customer: 'ctm_elsewhere' }); // a row whose customer is not this user's
    await subscribe(b.id, { customer: ctmB });
    await subscribe(b.id, { customer: ctmA }); // another user's row even under A's customer id
    expect((await post('/v1/billing/portal', {}, { cookie: a.cookie })).status).toBe(200);
    expect(paddle.portalCalls).toHaveLength(1);
    const [customer, subs] = paddle.portalCalls[0]!;
    expect(customer).toBe(ctmA);
    expect([...subs].sort()).toEqual([mine, minePastDue].sort());
  });

  it('portal: Paddle failure → 502 portal_unavailable', async () => {
    const u = await user();
    await setCustomer(u.id, `ctm_f${seq++}`);
    deps.paddle = () => ({ cancelSubscription: async () => {}, portalSession: async () => { throw new Error('down'); } });
    const r = await post('/v1/billing/portal', {}, { cookie: u.cookie });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: 'portal_unavailable' });
  });
});

describe('/account', () => {
  it('without a session → login with next', async () => {
    expect((await call('/account')).headers.get('location')).toBe('/login?next=%2Faccount');
  });

  it('account page: Pro copy names only relay and push; lists hosts and devices; revoke works', async () => {
    const h = await linkHost(`acct${seq++}@example.test`);
    const d = await pairedDevice(h);
    const r = await call('/account', { headers: { cookie: h.cookie } });
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).not.toMatch(/paddle/i); // the account page loads no third-party script
    const html = await r.text();
    expect(html).toContain('AI-MSG Pro: a cloud relay to see and approve your Mac\'s sessions from your phone, with push notifications.');
    expect(html).toMatch(/relay/);
    expect(html).toMatch(/push/);
    expect(html).not.toMatch(/accounts|rotation|routing/i);
    expect(html).toContain('Test Mac');
    expect(html).toContain('Phone');
    expect(html).toContain(`data-device="${d.deviceId}"`);
    expect(html).toContain(`data-host="${h.hostId}"`);
    expect(html).toMatch(/Trial · \d+ days? left/);
    expect(html).toContain('href="/checkout?plan=pro-monthly"');
    expect(html).toContain('href="/checkout?plan=pro-yearly"');
    expect(html).not.toContain('id="manage-billing"');
    expect(html).not.toMatch(/<script>(?!<\/script>)|<script[^>]*>[^<]+<\/script>/);
    expect(html).toContain('src="/static/account.js"');
    expect(html).toContain('href="/static/pages.css"');
    const rev = await post(`/v1/devices/${d.deviceId}/revoke`, {}, { cookie: h.cookie });
    expect(rev.status).toBe(200);
    expect(await (await call('/account', { headers: { cookie: h.cookie } })).text()).not.toContain(`data-device="${d.deviceId}"`);
  });

  it('unlink from the account page: own host only, cookie + Origin', async () => {
    const h = await linkHost(`unl${seq++}@example.test`);
    const other = await user();
    expect((await post(`/v1/hosts/${h.hostId}/unlink`, {}, { cookie: other.cookie })).status).toBe(404);
    expect((await post(`/v1/hosts/${h.hostId}/unlink`, {}, { cookie: h.cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(`/v1/hosts/${h.hostId}/unlink`, {}, { cookie: h.cookie })).status).toBe(200);
    expect(await env.DB.prepare('SELECT revoked_at FROM hosts WHERE id = ?').bind(h.hostId).first<number>('revoked_at')).not.toBeNull();
    expect(await (await call('/account', { headers: { cookie: h.cookie } })).text()).not.toContain(`data-host="${h.hostId}"`);
    expect((await post(`/v1/hosts/${h.hostId}/unlink`, {}, { cookie: h.cookie })).status).toBe(404);
  });

  it('unlink from the account page is rate limited per user (20 an hour)', async () => {
    const u = await user();
    for (let i = 0; i < 20; i++) expect((await post('/v1/hosts/hst_none/unlink', {}, { cookie: u.cookie })).status).toBe(404);
    const r = await post('/v1/hosts/hst_none/unlink', {}, { cookie: u.cookie });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'rate_limited' });
  });

  it('plan lines: Pro monthly with next payment + Manage billing; past_due; canceled; expired', async () => {
    const u = await user();
    await setCustomer(u.id, `ctm_p${seq++}`);
    await subscribe(u.id, { customer: `ctm_p${seq - 1}` });
    let html = await (await call('/account', web(u))).text();
    expect(html).toMatch(/Pro · monthly · next payment /);
    expect(html).toContain('id="manage-billing"');
    expect(html).not.toContain('href="/checkout?plan=pro-monthly"');

    const y = await user();
    await subscribe(y.id, { price: 'pri_yearly_test' });
    expect(await (await call('/account', web(y))).text()).toMatch(/Pro · yearly · next payment /);

    const p = await user();
    await subscribe(p.id, { status: 'past_due' });
    expect(await (await call('/account', web(p))).text()).toContain('Payment needs attention');

    const c = await user();
    const sub = await subscribe(c.id);
    await env.DB.prepare("UPDATE subscriptions SET status = 'canceled', scheduled_cancel = 1, canceled_at = ? WHERE id = ?").bind(Date.now(), sub).run();
    html = await (await call('/account', web(c))).text();
    expect(html).toMatch(/Canceled · until /);
    expect(html).toContain('href="/checkout?plan=pro-monthly"');

    const e = await user();
    await env.DB.prepare('INSERT INTO trials (user_id, started_at, ends_at) VALUES (?, ?, ?)').bind(e.id, Date.now() - 9 * DAY, Date.now() - 2 * DAY).run();
    expect(await (await call('/account', web(e))).text()).toContain('Expired');
  });

  it('sign out ends the session (form POST, Origin checked)', async () => {
    const u = await user();
    const bad = await call('/logout', { method: 'POST', headers: { cookie: u.cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(bad.status).toBe(403);
    const r = await call('/logout', { method: 'POST', headers: { cookie: u.cookie, origin: APP, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/login');
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-aimsg_web=; .*Max-Age=0/);
    expect((await call('/account', web(u))).headers.get('location')).toBe('/login?next=%2Faccount');
  });
});

describe('PaddleApi.portalSession', () => {
  it('POST /customers/{id}/portal-sessions with Bearer key and subscription_ids; answers urls.general.overview', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: { id: 'cpls_1', urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1?token=t' }, subscriptions: [] } } }), { status: 201 });
    }) as unknown as typeof fetch;
    const api = paddleApi({ PADDLE_ENV: 'sandbox', PADDLE_API_KEY: 'pdl_sdbx_apikey_test' }, fake);
    expect(await api.portalSession('ctm_1', ['sub_1'])).toEqual({ url: 'https://customer-portal.paddle.com/cpl_1?token=t' });
    expect(seen[0]!.url).toBe('https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions');
    expect(seen[0]!.init.method).toBe('POST');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer pdl_sdbx_apikey_test');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ subscription_ids: ['sub_1'] });
    await api.portalSession('ctm_1', []);
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({});
  });

  it('non-2xx or a missing / non-https overview link throws', async () => {
    const answer = (status: number, body: unknown) => paddleApi({ PADDLE_ENV: 'production', PADDLE_API_KEY: 'k' }, (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    await expect(answer(403, {}).portalSession('ctm_1', [])).rejects.toThrow();
    await expect(answer(201, { data: { urls: { general: {} } } }).portalSession('ctm_1', [])).rejects.toThrow();
    await expect(answer(201, { data: { urls: { general: { overview: 'javascript:alert(1)' } } } }).portalSession('ctm_1', [])).rejects.toThrow();
  });
});

describe('checkConfig — Paddle client token', () => {
  it('a client token must match PADDLE_ENV (test_ for sandbox, live_ for production)', () => {
    const base = {
      PUBLIC_ORIGIN: 'https://app.aimsg.app', RELAY_ORIGIN: 'https://relay.aimsg.app', EMAIL_MODE: 'resend', EMAIL_FROM: 'x <a@example.com>',
      RESEND_API_KEY: 'k', DEV_ROUTES: '0', SESSION_SECRET: 's'.repeat(32), EMAIL_HASH_SECRET: 'e'.repeat(32),
      MAX_HOSTS: '3', MAX_DEVICES: '3', TRIAL_DAYS: '7', CHECKOUT_SECRET: 'k'.repeat(32), PADDLE_ENV: 'production', PADDLE_IP_CHECK: '1',
    } as Env;
    expect(checkConfig(base)).toEqual({ ok: true });
    expect(checkConfig({ ...base, PADDLE_CLIENT_TOKEN: 'live_abc' })).toEqual({ ok: true });
    expect(checkConfig({ ...base, PADDLE_CLIENT_TOKEN: 'test_abc' })).toMatchObject({ ok: false });
    expect(checkConfig({ ...base, PADDLE_ENV: 'sandbox', PADDLE_CLIENT_TOKEN: 'live_abc' })).toMatchObject({ ok: false });
  });
});
