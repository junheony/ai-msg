import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entitledState } from '../src/entitled';
import { deps } from '../src/index';
import type { PaddleApi } from '../src/paddle/api';
import { paddleIpAllowed, webhookSecretProblem } from '../src/paddle/webhook';
import { signUserRef } from '../src/paddle/userRef';
import adjustmentCreated from './fixtures/paddle/adjustment.created.json?raw';
import customerCreated from './fixtures/paddle/customer.created.json?raw';
import subscriptionActivated from './fixtures/paddle/subscription.activated.json?raw';
import subscriptionCanceled from './fixtures/paddle/subscription.canceled.json?raw';
import subscriptionCreated from './fixtures/paddle/subscription.created.json?raw';
import subscriptionPastDue from './fixtures/paddle/subscription.past_due.json?raw';
import subscriptionUpdated from './fixtures/paddle/subscription.updated.json?raw';
import transactionCompleted from './fixtures/paddle/transaction.completed.json?raw';
import { APP, call, linkHost, openWs, pairedDevice, relayPost, waitFor } from './helpers';

const WEBHOOK_SECRET = `pdl_ntfset_${'a'.repeat(26)}_${'w'.repeat(32)}`; // TEST_VARS (synthetic, Paddle's format)
const CHECKOUT_SECRET = 'k'.repeat(32); // TEST_VARS
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const FIXTURES = {
  'subscription.created': subscriptionCreated,
  'subscription.activated': subscriptionActivated,
  'subscription.updated': subscriptionUpdated,
  'subscription.past_due': subscriptionPastDue,
  'subscription.canceled': subscriptionCanceled,
  'transaction.completed': transactionCompleted,
  'adjustment.created': adjustmentCreated,
  'customer.created': customerCreated,
} as const;
type FxName = keyof typeof FIXTURES;
type Json = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;

/**
 * A fixture with fresh ids: `event_id` unique unless given, `occurred_at` = now unless `at`, a billing period that
 * ends 30 days from now (when the fixture has one). `ref`/`user_id` go into `custom_data`; every other key
 * overrides a `data` field.
 */
function fx(name: FxName, o: { ref?: string; user_id?: string; event_id?: string; at?: number } & Json = {}): Json {
  const ev = JSON.parse(FIXTURES[name]) as Json & { data: Json };
  const { ref, user_id, event_id, at, ...data } = o;
  ev.event_id = event_id ?? `evt_t${seq++}`;
  ev.occurred_at = iso(at ?? Date.now());
  if (ev.data.current_billing_period) ev.data.current_billing_period = { starts_at: iso(Date.now() - DAY), ends_at: iso(Date.now() + 30 * DAY) };
  if (ref !== undefined || user_id !== undefined) ev.data.custom_data = { ...(ref !== undefined ? { ref } : {}), ...(user_id !== undefined ? { user_id } : {}) };
  Object.assign(ev.data, data);
  return ev;
}

async function sigFor(raw: string, ts = Math.floor(Date.now() / 1000), key = WEBHOOK_SECRET): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}:${raw}`)));
  return `ts=${ts};h1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function deliver(ev: Json | string, o: { sig?: string; ip?: string } = {}): Promise<Response> {
  const raw = typeof ev === 'string' ? ev : JSON.stringify(ev, null, 1); // pretty: the raw body is what is signed
  const headers: Record<string, string> = { 'content-type': 'application/json', 'paddle-signature': o.sig ?? (await sigFor(raw)) };
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  return call('/v1/paddle/webhook', { method: 'POST', headers, body: raw }, APP);
}

const refFor = (userId: string) => signUserRef(CHECKOUT_SECRET, userId);
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'))!;
const sub = (id: string) => env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<Json>();
const refund = (id: string) => env.DB.prepare('SELECT * FROM refunds WHERE adjustment_id = ?').bind(id).first<Json>();
const alerts = async () => (await env.DB.prepare('SELECT kind, ref, detail FROM ops_alerts ORDER BY id').all<Json>()).results;
const eventRow = (id: string) => env.DB.prepare('SELECT * FROM paddle_events WHERE event_id = ?').bind(id).first<Json>();

let userSeq = 0;
async function newUser(customerId: string | null = null): Promise<string> {
  const id = `u_wh_${userSeq++}`;
  await env.DB.prepare('INSERT INTO users (id, email, created_at, paddle_customer_id) VALUES (?, ?, ?, ?)').bind(id, `${id}@example.test`, Date.now(), customerId).run();
  return id;
}
/** Unique subscription / customer ids per test (storage is shared inside this file). */
/** A checkout intent that was open when the event happened (Task 10 writes these). */
const intent = (userId: string, expiresAt = Date.now() + HOUR) =>
  env.DB.prepare("INSERT INTO checkout_intents (user_id, plan, expires_at) VALUES (?, 'month', ?) ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at").bind(userId, expiresAt).run();
/** Paddle's customer entity (email) for `ctm`; by default the address of `userId`'s account. */
const customerEvent = (ctm: string, email: string, at?: number) => deliver(fx('customer.created', { id: ctm, email, at }));
const emailOf = (userId: string) => `${userId}@example.test`; // newUser()
const pending = async (ctm: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM paddle_link_pending WHERE customer_id = ?').bind(ctm).first<number>('n'))!;
const customerOf = (userId: string) => env.DB.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(userId).first<string | null>('paddle_customer_id');
const ids = () => { const n = seq++; return { sub: `sub_t${n}`, ctm: `ctm_t${n}`, adj: `adj_t${n}`, txn: `txn_t${n}` }; };

class FakePaddle implements PaddleApi {
  calls: [string, string][] = [];
  fail = false;
  async cancelSubscription(id: string): Promise<void> {
    this.calls.push(['cancelSubscription', id]);
    if (this.fail) throw new Error('paddle down');
  }
  async portalSession(): Promise<{ url: string }> { throw new Error('Task 10'); }
}
let paddle: FakePaddle;
const realDeps = { ...deps };
beforeEach(() => { paddle = new FakePaddle(); deps.paddle = () => paddle; });
afterEach(() => { Object.assign(deps, realDeps); });

describe('Paddle webhook — delivery', () => {
  it('duplicate event_id: second delivery is answered from paddle_events, state applied once', async () => {
    const u = await newUser();
    const x = ids();
    const before = await count('paddle_events');
    const a = await deliver(fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, event_id: 'evt_dup' }));
    const b = await deliver(fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, event_id: 'evt_dup' }));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual({ outcome: 'applied' });
    expect(await b.json()).toEqual({ outcome: 'duplicate' });
    expect(await count('paddle_events')).toBe(before + 1);
    expect(await eventRow('evt_dup')).toMatchObject({ event_type: 'subscription.activated', outcome: 'applied' });
  });

  it('replaying the same event after its row was lost gives the same state (all upserts)', async () => {
    const u = await newUser();
    const x = ids();
    const ev1 = fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm });
    expect((await deliver(ev1)).status).toBe(200);
    const first = await sub(x.sub);
    await env.DB.prepare('DELETE FROM paddle_events WHERE event_id = ?').bind(ev1.event_id as string).run();
    expect((await deliver(ev1)).status).toBe(200);
    expect(await sub(x.sub)).toMatchObject({ status: 'active', user_id: u });
    expect({ ...(await sub(x.sub)), updated_at: 0 }).toEqual({ ...first, updated_at: 0 });
  });

  it('older occurred_at cannot undo a newer state', async () => {
    const u = await newUser();
    const x = ids();
    const t10 = Date.now() - HOUR;
    await deliver(fx('subscription.canceled', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: t10, canceled_at: iso(t10) }));
    const r = await deliver(fx('subscription.updated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: t10 - HOUR, scheduled_change: null }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outcome: 'stale' });
    expect(await sub(x.sub)).toMatchObject({ status: 'canceled', last_event_at: t10 });
  });

  it('bad signature → 401, nothing stored; IP check on: non-Paddle IP → 403', async () => {
    const before = [await count('paddle_events'), await count('ops_alerts')];
    const ev = fx('subscription.activated', { id: ids().sub });
    const raw = JSON.stringify(ev);
    expect((await deliver(raw, { sig: await sigFor(raw, undefined, 'x'.repeat(32)) })).status).toBe(401);
    expect((await deliver(raw, { sig: await sigFor(raw, Math.floor(Date.now() / 1000) - 60) })).status).toBe(401);
    const noSig = await call('/v1/paddle/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }, APP);
    expect(noSig.status).toBe(401);
    expect([await count('paddle_events'), await count('ops_alerts')]).toEqual(before);

    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '0', PADDLE_ENV: 'production' }, '198.51.100.1')).toBe(true);
    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '1', PADDLE_ENV: 'production' }, '198.51.100.1')).toBe(false);
    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '1', PADDLE_ENV: 'production' }, '34.232.58.13')).toBe(true);
    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '1', PADDLE_ENV: 'production' }, '34.194.127.46')).toBe(false); // sandbox IP on live
    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '1', PADDLE_ENV: 'sandbox' }, '34.194.127.46')).toBe(true);
    expect(paddleIpAllowed({ PADDLE_IP_CHECK: '1', PADDLE_ENV: 'sandbox' }, null)).toBe(false);

    const e = env as unknown as { PADDLE_IP_CHECK: string };
    e.PADDLE_IP_CHECK = '1';
    try {
      const signed = JSON.stringify(fx('subscription.activated', { id: ids().sub }));
      expect((await deliver(signed, { ip: '198.51.100.7' })).status).toBe(403);
      expect([await count('paddle_events'), await count('ops_alerts')]).toEqual(before);
    } finally {
      e.PADDLE_IP_CHECK = '0';
    }
  });

  it('signed but unparseable body → 200 bad_payload + alert; missing data.status → 200 invalid + alert', async () => {
    const bad = await deliver('{"event_id": ');
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ outcome: 'bad_payload' });
    const noType = await deliver(JSON.stringify({ event_id: 'evt_x', occurred_at: iso(Date.now()), data: {} }));
    expect(await noType.json()).toEqual({ outcome: 'bad_payload' });
    expect((await alerts()).filter((a) => a.kind === 'bad_payload')).toHaveLength(2);
    expect((await alerts()).find((a) => a.kind === 'bad_payload')!.ref).toMatch(/^[0-9a-f]{16}$/);

    const ev = fx('subscription.updated', { id: ids().sub });
    delete (ev.data as Json).status;
    const r = await deliver(ev);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outcome: 'invalid' });
    expect(await eventRow(ev.event_id as string)).toMatchObject({ outcome: 'invalid' });
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'invalid_event', ref: ev.event_id }));
  });

  it('webhook secret missing or under 32 chars blocks only the webhook (503); other routes keep working', async () => {
    expect(webhookSecretProblem(undefined)).toBe('missing');
    expect(webhookSecretProblem('')).toBe('missing');
    expect(webhookSecretProblem('x'.repeat(31))).toBe('short');
    expect(webhookSecretProblem('x'.repeat(32))).toBe('prefix'); // only a warning
    expect(webhookSecretProblem(WEBHOOK_SECRET)).toBeNull();
    const e = env as unknown as { PADDLE_WEBHOOK_SECRET?: string };
    for (const bad of ['x'.repeat(31), '']) {
      e.PADDLE_WEBHOOK_SECRET = bad;
      try {
        const ev = fx('subscription.activated', { id: ids().sub });
        const raw = JSON.stringify(ev);
        expect((await deliver(raw, { sig: await sigFor(raw, undefined, bad || 'x') })).status).toBe(503);
        expect((await call('/login', {}, APP)).status).toBe(200);
      } finally {
        e.PADDLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
      }
    }
    e.PADDLE_WEBHOOK_SECRET = 'x'.repeat(40); // unusual prefix: works, warns
    try {
      const raw = JSON.stringify(fx('subscription.activated', { id: ids().sub }));
      expect((await deliver(raw, { sig: await sigFor(raw, undefined, 'x'.repeat(40)) })).status).toBe(200);
    } finally {
      e.PADDLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    }
  });

  it('body over 64 KB → 413 before anything is stored, even when signed', async () => {
    const before = [await count('paddle_events'), await count('ops_alerts')];
    const ev = fx('subscription.activated', { id: ids().sub, pad: 'x'.repeat(70_000) });
    const r = await deliver(ev);
    expect(r.status).toBe(413);
    expect([await count('paddle_events'), await count('ops_alerts')]).toEqual(before);
  });

  it('signature covers the raw bytes (non-ASCII body)', async () => {
    const u = await newUser();
    const r = await deliver(fx('subscription.activated', { ref: await refFor(u), id: ids().sub, note: 'é—한글' }));
    expect(await r.json()).toEqual({ outcome: 'applied' });
  });

  it('D1 failure during apply → 500 and no paddle_events row', async () => {
    const failing = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'batch') return async () => { throw new Error('D1_ERROR: simulated'); };
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    deps.db = () => failing;
    const u = await newUser();
    const ev = fx('subscription.activated', { ref: await refFor(u), id: ids().sub });
    const r = await deliver(ev);
    expect(r.status).toBe(500);
    expect(await eventRow(ev.event_id as string)).toBeNull();
    deps.db = realDeps.db;
    expect((await deliver(ev)).status).toBe(200); // Paddle's retry starts over
    expect(await eventRow(ev.event_id as string)).toMatchObject({ outcome: 'applied' });
  });
});

describe('Paddle webhook — subscriptions', () => {
  it('active keeps entitlement 48 h past period_end (late renewal webhook)', async () => {
    const u = await newUser();
    const x = ids();
    const end = Date.now() + 10 * DAY;
    await deliver(fx('subscription.created', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, current_billing_period: { starts_at: iso(Date.now()), ends_at: iso(end) } }));
    expect(await sub(x.sub)).toMatchObject({ status: 'active', period_end: end, price_id: 'pri_month', customer_id: x.ctm, scheduled_cancel: 0 });
    expect((await entitledState(env.DB, u, Date.now())).untilMs).toBe(end + 48 * HOUR);
    expect(await entitledState(env.DB, u, end + 47 * HOUR)).toMatchObject({ plan: 'pro', st: 'active' });
  });

  it('past_due: 7 days from the first past_due event, a later past_due update does not move it', async () => {
    const u = await newUser();
    const x = ids();
    const T = Date.now() - 3 * DAY;
    await deliver(fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T - DAY, current_billing_period: { starts_at: iso(T - 31 * DAY), ends_at: iso(T - DAY) } }));
    await deliver(fx('subscription.past_due', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T, current_billing_period: { starts_at: iso(T - 31 * DAY), ends_at: iso(T - DAY) } }));
    await deliver(fx('subscription.updated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T + 2 * DAY, status: 'past_due', scheduled_change: null, current_billing_period: { starts_at: iso(T - 31 * DAY), ends_at: iso(T - DAY) } }));
    expect(await sub(x.sub)).toMatchObject({ status: 'past_due', past_due_since: T });
    expect(await entitledState(env.DB, u, Date.now())).toEqual({ plan: 'pro', st: 'past_due', untilMs: T + 7 * DAY });
    // paid again → active clears past_due_since
    await deliver(fx('subscription.updated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T + 3 * DAY, scheduled_change: null }));
    expect(await sub(x.sub)).toMatchObject({ status: 'active', past_due_since: null });
  });

  it('forged custom_data.user_id is ignored; unknown customer → unmatched + ops alert, 200', async () => {
    const victim = await newUser();
    const x = ids();
    const r = await deliver(fx('subscription.activated', { user_id: victim, id: x.sub, customer_id: x.ctm }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outcome: 'unmatched' });
    expect(await sub(x.sub)).toMatchObject({ user_id: null });
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'unmatched', ref: x.sub }));
    expect((await entitledState(env.DB, victim, Date.now())).plan).toBe('none');
    // A forged ref (signed with another secret) is no better.
    const y = ids();
    const forged = await signUserRef('z'.repeat(32), victim);
    expect(await (await deliver(fx('subscription.activated', { ref: forged, id: y.sub, customer_id: y.ctm }))).json()).toEqual({ outcome: 'unmatched' });
  });

  it('an owned subscription never changes user: another ref → customer_conflict alert; a lost ref keeps the owner, not the customer owner', async () => {
    const a = await newUser();
    const b = await newUser();
    const x = ids();
    await deliver(fx('subscription.activated', { ref: await refFor(a), id: x.sub, customer_id: x.ctm }));
    const r = await deliver(fx('subscription.updated', { ref: await refFor(b), id: x.sub, customer_id: x.ctm, scheduled_change: null }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outcome: 'customer_conflict' });
    expect(await sub(x.sub)).toMatchObject({ user_id: a, status: 'active' });
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'customer_conflict', ref: x.sub }));
    expect((await entitledState(env.DB, b, Date.now())).plan).toBe('none');

    // CHECKOUT_SECRET rotated (ref no longer verifies) and the customer id belongs to someone else
    const y = ids();
    const a2 = await newUser();
    const c = await newUser(y.ctm);
    await deliver(fx('subscription.activated', { ref: await refFor(a2), id: y.sub, customer_id: x.ctm }));
    const r2 = await deliver(fx('subscription.updated', { ref: await signUserRef('z'.repeat(32), a2), id: y.sub, customer_id: y.ctm, scheduled_change: null }));
    expect(await r2.json()).toEqual({ outcome: 'applied' });
    expect(await sub(y.sub)).toMatchObject({ user_id: a2 });
    expect((await entitledState(env.DB, c, Date.now())).plan).toBe('none');
  });

  it('subscription with a ref and an open checkout intent links the customer id; without the intent it does not', async () => {
    const u = await newUser();
    const x = ids();
    await intent(u);
    await customerEvent(x.ctm, emailOf(u));
    await deliver(fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm }));
    expect(await customerOf(u)).toBe(x.ctm);
    const v = await newUser();
    const y = ids();
    await customerEvent(y.ctm, emailOf(v));
    expect(await (await deliver(fx('subscription.activated', { ref: await refFor(v), id: y.sub, customer_id: y.ctm }))).json()).toEqual({ outcome: 'applied' });
    expect(await customerOf(v)).toBeNull();
    expect(await sub(y.sub)).toMatchObject({ user_id: v }); // the subscription itself still counts
  });

  it('a late, older past_due is ignored (never shortens the grace)', async () => {
    const u = await newUser();
    const x = ids();
    const T = Date.now() - 2 * DAY;
    const period = { starts_at: iso(T - 31 * DAY), ends_at: iso(T - DAY) };
    await deliver(fx('subscription.past_due', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T + DAY, current_billing_period: period }));
    expect(await (await deliver(fx('subscription.past_due', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: T, current_billing_period: period }))).json()).toEqual({ outcome: 'stale' });
    expect(await sub(x.sub)).toMatchObject({ status: 'past_due', past_due_since: T + DAY, last_event_at: T + DAY });
    expect((await entitledState(env.DB, u, Date.now())).untilMs).toBe(T + 8 * DAY);
  });

  it('a known paddle_customer_id finds the user without a ref', async () => {
    const x = ids();
    const u = await newUser(x.ctm);
    const r = await deliver(fx('subscription.activated', { id: x.sub, customer_id: x.ctm }));
    expect(await r.json()).toEqual({ outcome: 'applied' });
    expect(await sub(x.sub)).toMatchObject({ user_id: u });
  });

  it('second active subscription for the same user → applied + second_subscription alert', async () => {
    const u = await newUser();
    const a = ids();
    const b = ids();
    expect(await (await deliver(fx('subscription.activated', { ref: await refFor(u), id: a.sub, customer_id: a.ctm }))).json()).toEqual({ outcome: 'applied' });
    const r = await deliver(fx('subscription.activated', { ref: await refFor(u), id: b.sub, customer_id: a.ctm }));
    expect(await r.json()).toEqual({ outcome: 'second_subscription' });
    expect(await sub(b.sub)).toMatchObject({ status: 'active', user_id: u });
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'second_subscription', ref: b.sub }));
  });

  it('active subscription clears the checkout intent', async () => {
    const u = await newUser();
    await env.DB.prepare("INSERT INTO checkout_intents (user_id, plan, expires_at) VALUES (?, 'month', ?)").bind(u, Date.now() + HOUR).run();
    await deliver(fx('subscription.activated', { ref: await refFor(u), id: ids().sub }));
    expect(await env.DB.prepare('SELECT 1 FROM checkout_intents WHERE user_id = ?').bind(u).first()).toBeNull();
  });

  it('scheduled cancel keeps entitlement until period_end + 48 h, even after the canceled webhook', async () => {
    for (const refunded of [false, true]) {
      const u = await newUser();
      const x = ids();
      const P = Date.now() + 2 * HOUR;
      const period = { starts_at: iso(P - 30 * DAY), ends_at: iso(P) };
      await deliver(fx('subscription.updated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: Date.now() - HOUR, current_billing_period: period, scheduled_change: { action: 'cancel', effective_at: iso(P), resume_at: null } }));
      expect(await sub(x.sub)).toMatchObject({ scheduled_cancel: 1, period_end: P });
      if (refunded) await deliver(fx('adjustment.created', { id: x.adj, action: 'refund', type: 'full', status: 'approved', subscription_id: x.sub, transaction_id: x.txn, customer_id: x.ctm }));
      await deliver(fx('subscription.canceled', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, at: Date.now(), canceled_at: iso(Date.now()), current_billing_period: null }));
      expect(await sub(x.sub)).toMatchObject({ status: 'canceled', scheduled_cancel: 1, period_end: P });
      const s = await sub(x.sub);
      expect((await entitledState(env.DB, u, Date.now())).untilMs).toBe(refunded ? 0 : P + 48 * HOUR);
      if (refunded) expect(s!.canceled_at).toBeLessThanOrEqual(Date.now());
    }
  });
});

describe('Paddle webhook — transactions', () => {
  it('links the customer id only with a signed ref and an intent open at occurred_at', async () => {
    const u = await newUser();
    const x = ids();
    const r0 = await deliver(fx('transaction.completed', { ref: await refFor(u), id: x.txn, customer_id: x.ctm, subscription_id: x.sub }));
    expect(await r0.json()).toEqual({ outcome: 'customer_unlinked' });
    expect(await customerOf(u)).toBeNull();
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'customer_unlinked', ref: x.txn }));
    await intent(u, Date.now() - HOUR); // expired before the event
    expect(await (await deliver(fx('transaction.completed', { ref: await refFor(u), id: x.txn, customer_id: x.ctm }))).json()).toEqual({ outcome: 'customer_unlinked' });
    expect(await customerOf(u)).toBeNull();
    await intent(u);
    await customerEvent(x.ctm, ` ${emailOf(u).toUpperCase()} `); // compared normalized
    const r = await deliver(fx('transaction.completed', { ref: await refFor(u), id: x.txn, customer_id: x.ctm, subscription_id: x.sub }));
    expect(await r.json()).toEqual({ outcome: 'applied' });
    expect(await env.DB.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(u).first('paddle_customer_id')).toBe(x.ctm);
  });

  it('Paddle customer email ≠ account email (someone else\'s email at checkout) → customer_unlinked, not linked', async () => {
    const attacker = await newUser();
    const victim = await newUser();
    const x = ids();
    await intent(attacker);
    await customerEvent(x.ctm, emailOf(victim));
    const r = await deliver(fx('transaction.completed', { ref: await refFor(attacker), id: x.txn, customer_id: x.ctm }));
    expect(await r.json()).toEqual({ outcome: 'customer_unlinked' });
    expect(await customerOf(attacker)).toBeNull();
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'customer_unlinked', ref: x.txn }));
  });

  it('customer event arriving late: link waits (customer_pending), then the customer event links on a match only', async () => {
    const u = await newUser();
    const x = ids();
    await intent(u);
    const r = await deliver(fx('transaction.completed', { ref: await refFor(u), id: x.txn, customer_id: x.ctm }));
    expect(await r.json()).toEqual({ outcome: 'customer_pending' });
    expect(await customerOf(u)).toBeNull();
    expect(await pending(x.ctm)).toBe(1);
    await env.DB.prepare('DELETE FROM checkout_intents WHERE user_id = ?').bind(u).run(); // the activation already cleared it
    expect(await (await customerEvent(x.ctm, emailOf(u))).json()).toEqual({ outcome: 'applied' });
    expect(await customerOf(u)).toBe(x.ctm);
    expect(await pending(x.ctm)).toBe(0);

    const attacker = await newUser();
    const victim = await newUser();
    const y = ids();
    await intent(attacker);
    await deliver(fx('subscription.activated', { ref: await refFor(attacker), id: y.sub, customer_id: y.ctm }));
    expect(await pending(y.ctm)).toBe(1);
    expect(await (await customerEvent(y.ctm, emailOf(victim))).json()).toEqual({ outcome: 'customer_unlinked' });
    expect(await customerOf(attacker)).toBeNull();
    expect(await pending(y.ctm)).toBe(0);
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'customer_unlinked', ref: y.ctm }));
    // an older customer event cannot overwrite a newer email
    expect(await (await customerEvent(y.ctm, emailOf(attacker), Date.now() - DAY)).json()).toEqual({ outcome: 'stale' });
  });

  it('customer id already owned by another user → 200 customer_conflict, users unchanged, alert', async () => {
    const x = ids();
    const owner = await newUser(x.ctm);
    const other = await newUser();
    await intent(other);
    const r = await deliver(fx('transaction.completed', { ref: await refFor(other), id: x.txn, customer_id: x.ctm }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ outcome: 'customer_conflict' });
    expect(await env.DB.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(other).first('paddle_customer_id')).toBeNull();
    expect(await env.DB.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(owner).first('paddle_customer_id')).toBe(x.ctm);
    expect(await alerts()).toContainEqual(expect.objectContaining({ kind: 'customer_conflict' }));

    // the user already has a different customer id → unchanged too
    const y = ids();
    await intent(owner);
    const r2 = await deliver(fx('transaction.completed', { ref: await refFor(owner), id: y.txn, customer_id: y.ctm }));
    expect(await r2.json()).toEqual({ outcome: 'customer_conflict' });
    expect(await env.DB.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(owner).first('paddle_customer_id')).toBe(x.ctm);
  });
});

describe('Paddle webhook — refunds', () => {
  it('full refund → cancelSubscription called once; partial refund only recorded', async () => {
    const x = ids();
    const r = await deliver(fx('adjustment.created', { id: x.adj, action: 'refund', type: 'full', status: 'approved', subscription_id: x.sub, transaction_id: x.txn, customer_id: x.ctm }));
    expect(await r.json()).toEqual({ outcome: 'refund_cancel' });
    await waitFor(async () => (await refund(x.adj))?.cancel_done_at != null);
    expect(paddle.calls).toEqual([['cancelSubscription', x.sub]]);
    expect(await refund(x.adj)).toMatchObject({ full: 1, action: 'refund', status: 'approved', subscription_id: x.sub, transaction_id: x.txn });

    const y = ids();
    const p = await deliver(fx('adjustment.created', { id: y.adj, subscription_id: y.sub, transaction_id: y.txn }));
    expect(await p.json()).toEqual({ outcome: 'refund_recorded' });
    expect(await refund(y.adj)).toMatchObject({ full: 0, status: 'pending_approval', cancel_done_at: null });
    // a full refund still waiting for approval does not cancel
    const z = ids();
    expect(await (await deliver(fx('adjustment.created', { id: z.adj, type: 'full', subscription_id: z.sub }))).json()).toEqual({ outcome: 'refund_recorded' });
    await new Promise((res) => setTimeout(res, 50));
    expect(paddle.calls).toHaveLength(1);
  });

  it('chargeback → cancel; cancel failure → refund_cancel_failed alert, negative claim left for the cron', async () => {
    paddle.fail = true;
    const x = ids();
    const r = await deliver(fx('adjustment.created', { id: x.adj, action: 'chargeback', type: 'full', status: 'approved', subscription_id: x.sub, customer_id: x.ctm }));
    expect(await r.json()).toEqual({ outcome: 'refund_cancel' });
    await waitFor(async () => (await alerts()).some((a) => a.kind === 'refund_cancel_failed' && a.ref === x.sub));
    expect(paddle.calls).toEqual([['cancelSubscription', x.sub]]);
    expect(Number((await refund(x.adj))!.cancel_done_at)).toBeLessThan(0); // claimed, failed: the Task 12 cron retries
  });

  it('chargeback rejected/reversed and chargeback reversals do not cancel', async () => {
    const out: unknown[] = [];
    for (const [action, status] of [['chargeback', 'rejected'], ['chargeback', 'reversed'], ['chargeback_reverse', 'approved'], ['chargeback_reversal', 'approved'], ['chargeback_warning', 'approved']]) {
      const x = ids();
      out.push(await (await deliver(fx('adjustment.created', { id: x.adj, action, type: 'full', status, subscription_id: x.sub }))).json());
      expect(await refund(x.adj)).toMatchObject({ full: 0 });
    }
    expect(out.every((o) => (o as Json).outcome === 'refund_recorded')).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(paddle.calls).toEqual([]);
  });

  it('the same full refund delivered twice at once → cancel called once, one alert at most', async () => {
    const x = ids();
    const ev = fx('adjustment.created', { id: x.adj, action: 'refund', type: 'full', status: 'approved', subscription_id: x.sub });
    await Promise.all([deliver(ev), deliver(ev)]);
    await waitFor(async () => Number((await refund(x.adj))?.cancel_done_at) > 0);
    await new Promise((res) => setTimeout(res, 50));
    expect(paddle.calls).toEqual([['cancelSubscription', x.sub]]);

    paddle.fail = true;
    const y = ids();
    const ev2 = fx('adjustment.created', { id: y.adj, action: 'chargeback', type: 'full', status: 'approved', subscription_id: y.sub });
    await Promise.all([deliver(ev2), deliver({ ...ev2, event_id: `evt_t${seq++}` })]);
    await waitFor(async () => (await alerts()).some((a) => a.kind === 'refund_cancel_failed' && a.ref === y.sub));
    await new Promise((res) => setTimeout(res, 50));
    expect(paddle.calls.filter(([, id]) => id === y.sub)).toHaveLength(1);
    expect((await alerts()).filter((a) => a.kind === 'refund_cancel_failed' && a.ref === y.sub)).toHaveLength(1);
  });

  it('refund event delivered twice → one refunds row, no SQL error', async () => {
    const x = ids();
    const ev = fx('adjustment.created', { id: x.adj, subscription_id: x.sub });
    expect((await deliver(ev)).status).toBe(200);
    await env.DB.prepare('DELETE FROM paddle_events WHERE event_id = ?').bind(ev.event_id as string).run();
    expect((await deliver(ev)).status).toBe(200);
    expect((await deliver({ ...ev, event_id: `evt_t${seq++}` })).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds WHERE adjustment_id = ?').bind(x.adj).first('n')).toBe(1);
  });
});

describe('Paddle webhook — relay', () => {
  const stubFor = (hostId: string) => env.RELAY.get(env.RELAY.idFromName(hostId));
  const userOf = async (hostId: string) => (await env.DB.prepare('SELECT user_id FROM hosts WHERE id = ?').bind(hostId).first<string>('user_id'))!;
  /** Runs the room's alarm (armed by the webhook's `/internal/recheck`) until `cond` holds. */
  const pump = (hostId: string, cond: () => boolean) => waitFor(async () => { await runDurableObjectAlarm(stubFor(hostId)); return cond(); });
  const ents = (s: { inbox: (string | ArrayBuffer)[] }) => s.inbox.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m) as Json).filter((m) => m.t === 'ent');

  it('canceled closes device sockets at recheck, host stays attached and gets ent:false', async () => {
    const h = await linkHost('wh-cancel@example.test');
    const u = await userOf(h.hostId);
    const x = ids();
    await deliver(fx('subscription.activated', { ref: await refFor(u), id: x.sub, customer_id: x.ctm }));
    await env.DB.prepare('UPDATE trials SET ends_at = 0 WHERE user_id = ?').bind(u).run();
    const d = await pairedDevice(h);
    const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
    const t = (await (await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d.deviceToken}` })).json()) as { ticket: string };
    const dev = await openWs(`/relay/device?ticket=${t.ticket}`);
    expect([host.status, dev.status]).toEqual([101, 101]);
    await waitFor(() => ents(host).length === 1);
    expect(ents(host)[0]!.ok).toBe(true);

    expect((await deliver(fx('subscription.canceled', { ref: await refFor(u), id: x.sub, customer_id: x.ctm, canceled_at: iso(Date.now()) }))).status).toBe(200);
    await pump(h.hostId, () => dev.closes.includes(4402));
    await waitFor(() => ents(host).some((m) => m.ok === false));
    expect(host.closes).toEqual([]);
  });

  it('Mac attached while not_entitled → webhook → recheck → ticket within seconds (2차 필수 1)', async () => {
    const h = await linkHost('wh-pay@example.test');
    const u = await userOf(h.hostId);
    const d1 = await pairedDevice(h);
    await env.DB.prepare('UPDATE trials SET ends_at = 0 WHERE user_id = ?').bind(u).run();
    const host = await openWs('/relay/host', { authorization: `Bearer ${h.hostToken}` });
    expect(host.status).toBe(101); // attaches without an entitlement
    await waitFor(() => ents(host).length === 1);
    expect(ents(host)[0]!.ok).toBe(false);
    expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(402);
    const t0 = Date.now();
    // payment on the phone → webhook → effects (/internal/recheck)
    expect((await deliver(fx('subscription.activated', { ref: await refFor(u), id: ids().sub }))).status).toBe(200);
    await pump(h.hostId, () => ents(host).some((m) => m.ok === true));
    expect(host.closes).toEqual([]);
    expect((await relayPost('/v1/relay/ticket', {}, { authorization: `Bearer ${d1.deviceToken}` })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000); // no backoff wait
  });
});
