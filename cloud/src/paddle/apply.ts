import type { Env } from '../env';
import { alertStmt } from '../ops';
import { verifyUserRef } from './userRef';

/** A verified, parsed webhook event. `occurred_at` is ms. */
export type PaddleEvent = { event_id: string; event_type: string; occurred_at: number; data: unknown };
export type Outcome = 'applied' | 'stale' | 'unmatched' | 'customer_conflict' | 'second_subscription' | 'refund_recorded' | 'refund_cancel' | 'ignored' | 'invalid';
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
  user_id = COALESCE(excluded.user_id, subscriptions.user_id),
  customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
  period_end = COALESCE(excluded.period_end, subscriptions.period_end), canceled_at = excluded.canceled_at,
  past_due_since = CASE WHEN excluded.status = 'past_due' THEN COALESCE(subscriptions.past_due_since, excluded.last_event_at) END,
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
 * The user an event belongs to: the server-signed `custom_data.ref` (userRef), else the user that already owns
 * `customer_id`. An unsigned `custom_data.user_id` is never read. A ref of a deleted user does not count.
 */
async function findUser(env: PlanEnv, d: Obj): Promise<string | null> {
  const byRef = await verifyUserRef(env.CHECKOUT_SECRET, isObj(d.custom_data) ? d.custom_data.ref : undefined);
  if (byRef && (await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(byRef).first())) return byRef;
  const customer = idStr(d.customer_id);
  if (!customer) return null;
  return (await env.DB.prepare('SELECT id FROM users WHERE paddle_customer_id = ?').bind(customer).first<string>('id')) ?? null;
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
    const userId = (await findUser(env, d)) ?? existing?.user_id ?? null;
    const upsert = db.prepare(UPSERT_SUBSCRIPTION).bind(id, userId, customer, status, item, period, canceledAt, ev.occurred_at, scheduled, now);
    if (existing && existing.last_event_at > ev.occurred_at) return plan('stale', [upsert]); // the WHERE blocks it too
    if (!userId) return plan('unmatched', [upsert], [alertStmt(db, 'unmatched', id, ev.event_type, now)]);

    const stmts = [upsert];
    const alerts: D1PreparedStatement[] = [];
    let outcome: Outcome = 'applied';
    if (ACTIVE.includes(status)) {
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
    const userId = await findUser(env, d);
    if (!userId) return plan('unmatched', [], [alertStmt(db, 'unmatched', txn, ev.event_type, now)]);
    const [owner, mine] = await db.batch<{ id: string; paddle_customer_id: string | null }>([
      db.prepare('SELECT id FROM users WHERE paddle_customer_id = ?').bind(customer),
      db.prepare('SELECT paddle_customer_id FROM users WHERE id = ?').bind(userId),
    ]);
    const ownerId = owner!.results[0]?.id;
    const current = mine!.results[0]?.paddle_customer_id ?? null;
    if ((ownerId && ownerId !== userId) || (current && current !== customer)) {
      // Never overwrite, and never let the UNIQUE index turn this into a 500 (Paddle would retry for days).
      return plan('customer_conflict', [], [alertStmt(db, 'customer_conflict', txn, ownerId && ownerId !== userId ? 'customer id owned by another user' : 'user has another customer id', now)]);
    }
    return plan('applied', [
      db.prepare('UPDATE users SET paddle_customer_id = ?1 WHERE id = ?2 AND paddle_customer_id IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE paddle_customer_id = ?1)').bind(customer, userId),
    ]);
  }

  if (ev.event_type === 'adjustment.created' || ev.event_type === 'adjustment.updated') {
    if (!isObj(d)) return invalid('data');
    const id = idStr(d.id);
    const action = idStr(d.action);
    const status = idStr(d.status);
    if (!id || !action || !status) return invalid('data.id/action/status');
    const type = d.type === 'full' ? 'full' : 'partial'; // Paddle's default is partial
    const sub = idStr(d.subscription_id);
    const full = (action === 'refund' && type === 'full' && status === 'approved') || action === 'chargeback';
    const existing = await db.prepare('SELECT last_event_at, cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(id).first<{ last_event_at: number; cancel_done_at: number | null }>();
    const upsert = db.prepare(UPSERT_REFUND).bind(id, idStr(d.transaction_id), sub, action, status, full ? 1 : 0, ev.occurred_at);
    if (existing && existing.last_event_at > ev.occurred_at) return plan('stale', [upsert]);
    if (!full || !sub) return plan('refund_recorded', [upsert]);
    // A full refund also ends the scheduled-cancel grace (entitled.ts), so the user's rooms recheck now.
    const owner = await db.prepare('SELECT user_id FROM subscriptions WHERE id = ?').bind(sub).first<string | null>('user_id');
    const effects = await rechecks(db, owner ?? (await findUser(env, d)));
    if (existing?.cancel_done_at == null) effects.push({ kind: 'cancel', subscriptionId: sub, adjustmentId: id });
    return plan('refund_cancel', [upsert], [], effects);
  }

  return plan('ignored');
}
