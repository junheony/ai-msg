import { liveSql } from './billing';
import type { Env } from './env';
import { alertStmt, type OpsKind } from './ops';
import type { PaddleApi } from './paddle/api';
import { DAY, HOUR, MINUTE } from './rate';

const BATCH = 5000;
/** A refund cancel younger than this may still be running in its webhook delivery — leave it alone. */
const REFUND_SETTLE_MS = 10 * MINUTE;
const PENDING_ALERT_MS = DAY;
const PENDING_KEEP_MS = 30 * DAY;

/** Table → the rows past their keep time (`?1` = now). At most 5,000 rows per table per run. */
const EXPIRED: readonly (readonly [string, string])[] = [
  ['magic_links', `expires_at < ?1 - ${DAY}`],
  ['relay_tickets', `expires_at < ?1 - ${HOUR}`],
  ['rate', `window_start < ?1 - ${2 * DAY}`], // the longest window is a day
  ['pairings', `expires_at < ?1 - ${DAY} AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.pairing_id = pairings.id)`],
  ['host_links', `expires_at < ?1 - ${DAY}`],
  ['web_sessions', 'expires_at < ?1'],
  ['outbox', `created_at < ?1 - ${DAY}`], // log mail only
  ['checkout_intents', 'expires_at < ?1'],
  ['paddle_events', `received_at < ?1 - ${90 * DAY}`], // Paddle retries for about 2 days
  ['ops_alerts', `resolved_at IS NOT NULL OR created_at < ?1 - ${90 * DAY}`],
];

/** Refs that already have an alert of `kind` in the last day (one alert per row per day). */
async function alertedToday(db: D1Database, kind: OpsKind, nowMs: number): Promise<Set<string>> {
  const rows = await db.prepare('SELECT ref FROM ops_alerts WHERE kind = ? AND created_at > ? AND ref IS NOT NULL').bind(kind, nowMs - DAY).all<{ ref: string }>();
  return new Set(rows.results.map((r) => r.ref));
}

/**
 * The daily cron (`17 3 * * *`): deletes expired rows, retries refund cancels a webhook delivery could not finish
 * (Task 9 claim: NULL or a negative `-claimedAt`), alerts on customer links pending over a day (deleted after 30 days)
 * and on subscriptions left running past their period (a missed cancel webhook). Logs counts only — no ids.
 */
export async function runCleanup(env: Env, nowMs: number, deps: { paddle: PaddleApi }): Promise<Record<string, number>> {
  const db = env.DB;
  const counts: Record<string, number> = {};

  for (const [table, where] of EXPIRED) {
    const r = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`).bind(nowMs).run();
    counts[table] = r.meta.changes;
  }

  // Refund cancels. Each retry claims the row with the same conditional UPDATE as the webhook (old value → -now).
  counts.refund_cancel_done = 0;
  counts.refund_cancel_failed = 0;
  const refunds = await db.prepare(`SELECT adjustment_id, subscription_id, cancel_done_at FROM refunds
    WHERE full = 1 AND subscription_id IS NOT NULL AND last_event_at < ?1 - ${REFUND_SETTLE_MS}
      AND (cancel_done_at IS NULL OR (cancel_done_at < 0 AND -cancel_done_at < ?1 - ${REFUND_SETTLE_MS})) LIMIT 100`)
    .bind(nowMs).all<{ adjustment_id: string; subscription_id: string; cancel_done_at: number | null }>();
  const failedToday = await alertedToday(db, 'refund_cancel_failed', nowMs);
  for (const r of refunds.results) {
    const claim = await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ? AND cancel_done_at IS ?').bind(-nowMs, r.adjustment_id, r.cancel_done_at).run();
    if (claim.meta.changes !== 1) continue; // a webhook delivery took it meanwhile
    try {
      await deps.paddle.cancelSubscription(r.subscription_id);
      await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ?').bind(nowMs, r.adjustment_id).run();
      counts.refund_cancel_done++;
    } catch (err) {
      counts.refund_cancel_failed++;
      if (failedToday.has(r.subscription_id)) continue;
      failedToday.add(r.subscription_id);
      const why = err instanceof Error ? err.message.slice(0, 200) : 'error';
      await alertStmt(db, 'refund_cancel_failed', r.subscription_id, `${r.adjustment_id}: cron retry: ${why}`, nowMs).run();
    }
  }

  // Customer links waiting for a `customer.created` that may never come (an existing Paddle customer).
  const gone = await db.prepare(`DELETE FROM paddle_link_pending WHERE rowid IN (SELECT rowid FROM paddle_link_pending WHERE created_at < ?1 - ${PENDING_KEEP_MS} LIMIT ${BATCH})`).bind(nowMs).run();
  counts.paddle_link_pending = gone.meta.changes;
  const pendingToday = await alertedToday(db, 'customer_pending_stale', nowMs);
  const pending = await db.prepare(`SELECT DISTINCT customer_id FROM paddle_link_pending WHERE created_at < ?1 - ${PENDING_ALERT_MS} LIMIT 100`).bind(nowMs).all<{ customer_id: string }>();
  const pendingAlerts = pending.results.filter((p) => !pendingToday.has(p.customer_id))
    .map((p) => alertStmt(db, 'customer_pending_stale', p.customer_id, 'customer link pending over 24 h (no customer.created)', nowMs));
  if (pendingAlerts.length) await db.batch(pendingAlerts);
  counts.customer_pending_stale = pendingAlerts.length;

  // Subscriptions still `active`·`trialing`·`past_due` that liveSql no longer counts: a cancel/past-due webhook was missed.
  const staleToday = await alertedToday(db, 'subscription_stale', nowMs);
  const stale = await db.prepare(`SELECT id, status FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND NOT ${liveSql('?1')} LIMIT 100`)
    .bind(nowMs).all<{ id: string; status: string }>();
  const staleAlerts = stale.results.filter((s) => !staleToday.has(s.id))
    .map((s) => alertStmt(db, 'subscription_stale', s.id, `${s.status} past its period (missed webhook?)`, nowMs));
  if (staleAlerts.length) await db.batch(staleAlerts);
  counts.subscription_stale = staleAlerts.length;

  console.log(JSON.stringify({ cron: 'cleanup', ...counts }));
  return counts;
}
