import type { Env } from '../env';
import { alertStmt } from '../ops';
import { verifyUserRef } from './userRef';

/** A verified, parsed webhook event. `occurred_at` is ms. */
export type PaddleEvent = { event_id: string; event_type: string; occurred_at: number; data: unknown };
export type Outcome = 'applied' | 'stale' | 'unmatched' | 'customer_conflict' | 'customer_unlinked' | 'second_subscription' | 'refund_recorded' | 'refund_cancel' | 'ignored' | 'invalid';
/** Work done after the batch commits (`ctx.waitUntil`): a room recheck, or the immediate cancel after a full refund/chargeback. */
export type Effect = { kind: 'recheck'; hostId: string } | { kind: 'cancel'; subscriptionId: string; adjustmentId: string };
export type EventPlan = { outcome: Outcome; stmts: D1PreparedStatement[]; alerts: D1PreparedStatement[]; effects: Effect[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const idStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : null);

/** Paddle RFC 3339 timestamps carry up to 6 fractional digits; ms precision is enough. `null` if absent or unparseable. */
export function paddleTime(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : null;
}

const SUB_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused', 'canceled']);
/** A subscription in one of these still bills or grants Pro (second subscription check, checkout intent). */
const ACTIVE = ['active', 'trialing', 'past_due'];

const UPSERT_SUBSCRIPTION = `INSERT INTO subscriptions (id, user_id, customer_id, status, price_id, period_end, canceled_at, past_due_since, scheduled_cancel, last_event_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?4 = 'past_due' THEN ?8 END, ?9, ?8, ?10)
ON CONFLICT(id) DO UPDATE SET
  user_id = COALESCE(subscriptions.user_id, excluded.user_id),
  customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
  period_end = COALESCE(excluded.period_end, subscriptions.period_end), canceled_at = excluded.canceled_at,
  past_due_since = CASE WHEN excluded.status = 'past_due' THEN MIN(COALESCE(subscriptions.past_due_since, excluded.last_event_at), excluded.last_event_at) END,
  scheduled_cancel = CASE WHEN excluded.status = 'canceled' THEN MAX(subscriptions.scheduled_cancel, excluded.scheduled_cancel) ELSE excluded.scheduled_cancel END,
  last_event_at = excluded.last_event_at, updated_at = excluded.updated_at
WHERE excluded.last_event_at >= subscriptions.last_event_at`;

const UPSERT_REFUND = `INSERT INTO refunds (adjustment_id, transaction_id, subscription_id, action, status, full, last_event_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(adjustment_id) DO UPDATE SET
  transaction_id = excluded.transaction_id, subscription_id = excluded.subscription_id, action = excluded.action,
  status = excluded.status, full = excluded.full, last_event_at = excluded.last_event_at
WHERE excluded.last_event_at >= refunds.last_event_at`;

type PlanEnv = Pick<Env, 'DB' | 'CHECKOUT_SECRET'>;

/**
 * The user the server-signed `custom_data.ref` (userRef) names, if it verifies and the user still exists. An unsigned
 * `custom_data.user_id` is never read.
 */
async function refUser(env: PlanEnv, d: Obj): Promise<string | null> {
  const byRef = await verifyUserRef(env.CHECKOUT_SECRET, isObj(d.custom_data) ? d.custom_data.ref : undefined);
  return byRef && (await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(byRef).first()) ? byRef : null;
}

async function customerOwner(db: D1Database, customer: string | null): Promise<string | null> {
  if (!customer) return null;
  return (await db.prepare('SELECT id FROM users WHERE paddle_customer_id = ?').bind(customer).first<string>('id')) ?? null;
}

/**
 * Whether `customer` may be linked to `userId` (who came from a verified ref). Paddle reuses a customer whose email
 * matches at checkout, so anyone can end up holding someone else's customer id: a new link needs a checkout intent of
 * this user that was open when the event happened, and never takes a customer id another user holds.
 */
async function customerLink(db: D1Database, userId: string, customer: string, at: number): Promise<{ stmt: D1PreparedStatement | null; problem: 'owned' | 'other' | 'no_intent' | null }> {
  const ownerId = await customerOwner(db, customer);
  if (ownerId && ownerId !== userId) return { stmt: null, problem: 'owned' };
  const current = await db.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(userId).first<string | null>('paddle_customer_id');
  if (current === customer) return { stmt: null, problem: null };
  if (current) return { stmt: null, problem: 'other' };
  if (!(await db.prepare('SELECT 1 FROM checkout_intents WHERE user_id = ? AND expires_at > ?').bind(userId, at).first())) return { stmt: null, problem: 'no_intent' };
  // Same conditions again inside the write, so a concurrent event cannot slip past them.
  const stmt = db.prepare(`UPDATE users SET paddle_customer_id = ?1 WHERE id = ?2 AND paddle_customer_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM users WHERE paddle_customer_id = ?1)
    AND EXISTS (SELECT 1 FROM checkout_intents WHERE user_id = ?2 AND expires_at > ?3)`).bind(customer, userId, at);
  return { stmt, problem: null };
}

async function rechecks(db: D1Database, userId: string | null): Promise<Effect[]> {
  if (!userId) return [];
  const rows = await db.prepare('SELECT id FROM hosts WHERE user_id = ? AND revoked_at IS NULL').bind(userId).all<{ id: string }>();
  return rows.results.map((r) => ({ kind: 'recheck', hostId: r.id }));
}

const plan = (outcome: Outcome, stmts: D1PreparedStatement[] = [], alerts: D1PreparedStatement[] = [], effects: Effect[] = []): EventPlan => ({ outcome, stmts, alerts, effects });

/**
 * Reads only, and returns the statements to write in one batch with the event row. Every statement is an upsert
 * guarded by `occurred_at`, so a replay or a concurrent duplicate ends in the same state and an older event cannot
 * undo a newer one. A business conflict is an `outcome` plus an `ops_alerts` row (200, no Paddle retry); a data
 * shape it cannot use is `invalid` (never a throw).
 */
export async function planEvent(env: PlanEnv, ev: PaddleEvent, now: number): Promise<EventPlan> {
  const db = env.DB;
  const d = ev.data;
  const invalid = (why: string) => plan('invalid', [], [alertStmt(db, 'invalid_event', ev.event_id, `${ev.event_type}: ${why}`, now)]);
  if (ev.event_type.startsWith('subscription.')) {
    if (!isObj(d)) return invalid('data');
    const id = idStr(d.id);
    const status = typeof d.status === 'string' && SUB_STATUSES.has(d.status) ? d.status : null;
    if (!id) return invalid('data.id');
    if (!status) return invalid('data.status');
    const customer = idStr(d.customer_id);
    const period = isObj(d.current_billing_period) ? paddleTime(d.current_billing_period.ends_at) : null;
    const canceledAt = paddleTime(d.canceled_at);
    const scheduled = isObj(d.scheduled_change) && d.scheduled_change.action === 'cancel' ? 1 : 0;
    const item = Array.isArray(d.items) && isObj(d.items[0]) && isObj(d.items[0].price) ? idStr(d.items[0].price.id) : null;

    const existing = await db.prepare('SELECT user_id, last_event_at FROM subscriptions WHERE id = ?').bind(id).first<{ user_id: string | null; last_event_at: number }>();
    const byRef = await refUser(env, d);
    // An owned subscription keeps its owner for good (the upsert's COALESCE too): a ref that stops verifying
    // (CHECKOUT_SECRET rotated) must not hand it to whoever holds the customer id.
    const owner = existing?.user_id ?? null;
    const userId = owner ?? byRef ?? (await customerOwner(db, customer));
    const upsert = db.prepare(UPSERT_SUBSCRIPTION).bind(id, userId, customer, status, item, period, canceledAt, ev.occurred_at, scheduled, now);
    if (existing && existing.last_event_at > ev.occurred_at) {
      // The WHERE blocks the upsert. A late past_due may still only move past_due_since earlier, never later.
      const stmts = [upsert];
      if (status === 'past_due') stmts.push(db.prepare(`UPDATE subscriptions SET past_due_since = ?1 WHERE id = ?2 AND status = 'past_due' AND past_due_since > ?1`).bind(ev.occurred_at, id));
      return plan('stale', stmts);
    }
    if (!userId) return plan('unmatched', [upsert], [alertStmt(db, 'unmatched', id, ev.event_type, now)]);

    const stmts = [upsert];
    const alerts: D1PreparedStatement[] = [];
    let outcome: Outcome = 'applied';
    if (owner && byRef && byRef !== owner) {
      outcome = 'customer_conflict';
      alerts.push(alertStmt(db, 'customer_conflict', id, 'ref names another user than the subscription owner', now));
    }
    if (ACTIVE.includes(status)) {
      if (byRef === userId && customer) {
        const link = await customerLink(db, userId, customer, ev.occurred_at);
        if (link.stmt) stmts.push(link.stmt); // before the intent is deleted below
        if (link.problem === 'owned') alerts.push(alertStmt(db, 'customer_conflict', id, 'customer id owned by another user', now));
      }
      const other = await db.prepare(`SELECT id FROM subscriptions WHERE user_id = ? AND id <> ? AND status IN ('active','trialing','past_due') LIMIT 1`)
        .bind(userId, id).first<string>('id');
      if (other) {
        outcome = 'second_subscription';
        alerts.push(alertStmt(db, 'second_subscription', id, `user also has ${other}`, now));
      }
      stmts.push(db.prepare('DELETE FROM checkout_intents WHERE user_id = ?').bind(userId)); // Task 10's lock
    }
    return plan(outcome, stmts, alerts, await rechecks(db, userId));
  }

  if (ev.event_type === 'transaction.completed') {
    if (!isObj(d)) return invalid('data');
    const txn = idStr(d.id);
    if (!txn) return invalid('data.id');
    const customer = idStr(d.customer_id);
    if (!customer) return plan('ignored');
    const userId = await refUser(env, d);
    if (!userId) {
      // Without a verified ref nothing is linked; a customer already linked is fine as it is.
      return (await customerOwner(db, customer)) ? plan('applied') : plan('unmatched', [], [alertStmt(db, 'unmatched', txn, ev.event_type, now)]);
    }
    const link = await customerLink(db, userId, customer, ev.occurred_at);
    // Never overwrite, and never let the UNIQUE index turn this into a 500 (Paddle would retry for days).
    if (link.problem === 'owned' || link.problem === 'other') {
      return plan('customer_conflict', [], [alertStmt(db, 'customer_conflict', txn, link.problem === 'owned' ? 'customer id owned by another user' : 'user has another customer id', now)]);
    }
    if (link.problem === 'no_intent') return plan('customer_unlinked', [], [alertStmt(db, 'customer_unlinked', txn, 'no checkout intent open at occurred_at', now)]);
    return plan('applied', link.stmt ? [link.stmt] : []);
  }

  if (ev.event_type === 'adjustment.created' || ev.event_type === 'adjustment.updated') {
    if (!isObj(d)) return invalid('data');
    const id = idStr(d.id);
    const action = idStr(d.action);
    const status = idStr(d.status);
    if (!id || !action || !status) return invalid('data.id/action/status');
    const type = d.type === 'full' ? 'full' : 'partial'; // Paddle's default is partial
    const sub = idStr(d.subscription_id);
    // A chargeback cancels unless it was rejected/reversed. Reversal actions (`chargeback_reverse` and
    // `chargeback_reversal` — the docs spell it both ways) and `chargeback_warning` only get recorded.
    const full = (action === 'refund' && type === 'full' && status === 'approved') || (action === 'chargeback' && status !== 'rejected' && status !== 'reversed');
    const existing = await db.prepare('SELECT last_event_at, cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(id).first<{ last_event_at: number; cancel_done_at: number | null }>();
    const upsert = db.prepare(UPSERT_REFUND).bind(id, idStr(d.transaction_id), sub, action, status, full ? 1 : 0, ev.occurred_at);
    if (existing && existing.last_event_at > ev.occurred_at) return plan('stale', [upsert]);
    if (!full || !sub) return plan('refund_recorded', [upsert]);
    // A full refund also ends the scheduled-cancel grace (entitled.ts), so the user's rooms recheck now.
    const owner = await db.prepare('SELECT user_id FROM subscriptions WHERE id = ?').bind(sub).first<string | null>('user_id');
    const effects = await rechecks(db, owner ?? (await refUser(env, d)) ?? (await customerOwner(db, idStr(d.customer_id))));
    if (existing?.cancel_done_at == null) effects.push({ kind: 'cancel', subscriptionId: sub, adjustmentId: id });
    return plan('refund_cancel', [upsert], [], effects);
  }

  return plan('ignored');
}
