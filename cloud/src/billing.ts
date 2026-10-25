import { cookieRoute } from './auth/session';
import { entitledState } from './entitled';
import type { Env } from './env';
import { HttpError, json, problem, readBody } from './http';
import type { PaddleApi } from './paddle/api';
import { signUserRef } from './paddle/userRef';

/** The two plans the checkout sells, and the Paddle price id var each one reads. */
export const PLANS = { 'pro-monthly': 'PADDLE_PRICE_MONTHLY', 'pro-yearly': 'PADDLE_PRICE_YEARLY' } as const;
export type PlanName = keyof typeof PLANS;
export const isPlan = (v: unknown): v is PlanName => typeof v === 'string' && Object.hasOwn(PLANS, v);

/** How long an intent (open or completed) holds the checkout lock. */
export const INTENT_TTL_MS = 15 * 60_000;

/**
 * Why this user may not start another checkout: a live Pro subscription (`active`·`past_due`), or a checkout they
 * finished within the last 15 minutes whose webhook has not come yet. `null` → go ahead.
 */
export async function checkoutBlock(db: D1Database, userId: string, nowMs: number): Promise<'already_subscribed' | 'payment_pending' | null> {
  const e = await entitledState(db, userId, nowMs);
  if (e.plan === 'pro' && (e.st === 'active' || e.st === 'past_due')) return 'already_subscribed';
  const done = await db.prepare('SELECT 1 AS x FROM checkout_intents WHERE user_id = ? AND completed_at IS NOT NULL AND expires_at > ?').bind(userId, nowMs).first<number>('x');
  return done ? 'payment_pending' : null;
}

/**
 * `POST /v1/billing/intent {plan}` → `{ref}`. Writes the intent row first (open, 15 min), then signs the user ref the
 * checkout hands to Paddle as `customData.ref` — Task 9 links a customer only for a ref whose user has this row.
 * 409 `already_subscribed` / `payment_pending` instead while the lock holds.
 */
export const billingIntent = cookieRoute({ session: 'required' }, async (c) => {
  const body = await readBody(c.req);
  if (!isPlan(body.plan)) throw new HttpError(400, 'bad_request');
  const block = await checkoutBlock(c.env.DB, c.userId, c.nowMs);
  if (block) return problem(409, block);
  await c.env.DB.prepare(`INSERT INTO checkout_intents (user_id, plan, completed_at, expires_at) VALUES (?1, ?2, NULL, ?3)
    ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, completed_at = NULL, expires_at = excluded.expires_at`)
    .bind(c.userId, body.plan, c.nowMs + INTENT_TTL_MS).run();
  return json(200, { ref: await signUserRef(c.env.CHECKOUT_SECRET, c.userId) });
});

/**
 * `POST /v1/billing/intent/complete` — Paddle.js reported `checkout.completed`. Marks the intent done for 15 more
 * minutes (the webhook usually lands well inside that; Task 9 deletes the row then). No intent → 409 `no_intent`.
 */
export const billingIntentComplete = cookieRoute({ session: 'required' }, async (c) => {
  const row = await c.env.DB.prepare('UPDATE checkout_intents SET completed_at = ?1, expires_at = ?2 WHERE user_id = ?3 RETURNING user_id')
    .bind(c.nowMs, c.nowMs + INTENT_TTL_MS, c.userId).first<string>('user_id');
  return row ? json(200, { ok: true }) : problem(409, 'no_intent');
});

/** Why the portal won't open: usually the checkout used an email other than the account's (Task 9 links only on a match). */
export const NO_CUSTOMER_MESSAGE = "The billing page can't be opened for this account. This happens when the email used at checkout differs from your account email — contact support.";

/** Subscriptions the portal may name: still running, this user's, under this user's own customer. */
const PORTAL_STATUSES = "('active', 'trialing', 'past_due', 'paused')";

/**
 * `POST /v1/billing/portal` → `{url}` (no-store; the link carries a temporary token). Only the signed-in user's linked
 * Paddle customer, and only that user's subscriptions under that customer — another user's id can never ride along.
 */
export const billingPortal = (deps: { paddle: (env: Env) => PaddleApi }) => cookieRoute({ session: 'required' }, async (c) => {
  const db = c.env.DB;
  const customer = await db.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(c.userId).first<string | null>('paddle_customer_id');
  // No linked customer (never paid, or paid under another user's customer — Task 9 leaves that unlinked): no portal.
  if (!customer) return problem(409, 'no_customer', NO_CUSTOMER_MESSAGE);
  const subs = await db.prepare(`SELECT id FROM subscriptions WHERE user_id = ? AND customer_id = ? AND status IN ${PORTAL_STATUSES} ORDER BY updated_at DESC LIMIT 25`)
    .bind(c.userId, customer).all<{ id: string }>();
  try {
    const { url } = await deps.paddle(c.env).portalSession(customer, subs.results.map((r) => r.id));
    return json(200, { url }, { 'cache-control': 'no-store' });
  } catch (e) {
    console.error(`portal session failed: ${e instanceof Error ? e.message : 'error'}`);
    return problem(502, 'portal_unavailable');
  }
});
