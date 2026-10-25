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

/** A refund cancel still failing this long after its event stops being retried (one last alert). */
const REFUND_GIVE_UP_MS = 30 * DAY;
/** `cancel_done_at` once the cron gave up: neither NULL nor negative, so nothing retries it (and the webhook skips it). */
const GAVE_UP = 0;

/** Paddle has no such subscription (404): nothing left to cancel. */
const notFound = (err: unknown) => typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;

/**
 * Refund cancels a webhook delivery could not finish (Task 9 claim: NULL, or a negative `-claimedAt` over 10 min old).
 * Each retry claims the row with the same conditional UPDATE as the webhook (old value → -now). Already canceled
 * locally, or unknown to Paddle → done. Other failures alert once a day; after 30 days the row is given up (last alert).
 */
async function retryRefundCancels(db: D1Database, nowMs: number, paddle: PaddleApi, counts: Record<string, number>): Promise<void> {
  counts.refund_cancel_done = 0;
  counts.refund_cancel_failed = 0;
  counts.refund_cancel_gave_up = 0;
  const refunds = await db.prepare(`SELECT r.adjustment_id, r.subscription_id, r.cancel_done_at, r.last_event_at, s.status AS sub_status FROM refunds r
    LEFT JOIN subscriptions s ON s.id = r.subscription_id
    WHERE r.full = 1 AND r.subscription_id IS NOT NULL AND r.last_event_at < ?1 - ${REFUND_SETTLE_MS}
      AND (r.cancel_done_at IS NULL OR (r.cancel_done_at < 0 AND -r.cancel_done_at < ?1 - ${REFUND_SETTLE_MS})) LIMIT 100`)
    .bind(nowMs).all<{ adjustment_id: string; subscription_id: string; cancel_done_at: number | null; last_event_at: number; sub_status: string | null }>();
  const failedToday = await alertedToday(db, 'refund_cancel_failed', nowMs);
  for (const r of refunds.results) {
    const giveUp = r.sub_status !== 'canceled' && r.last_event_at < nowMs - REFUND_GIVE_UP_MS;
    const claim = await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ? AND cancel_done_at IS ?').bind(giveUp ? GAVE_UP : -nowMs, r.adjustment_id, r.cancel_done_at).run();
    if (claim.meta.changes !== 1) continue; // a webhook delivery took it meanwhile
    if (giveUp) {
      counts.refund_cancel_gave_up++;
      await alertStmt(db, 'refund_cancel_failed', r.subscription_id, `${r.adjustment_id}: cron gave up after 30 days — cancel by hand`, nowMs).run();
      continue;
    }
    try {
      if (r.sub_status !== 'canceled') await paddle.cancelSubscription(r.subscription_id);
    } catch (err) {
      if (!notFound(err)) {
        counts.refund_cancel_failed++;
        if (failedToday.has(r.subscription_id)) continue;
        failedToday.add(r.subscription_id);
        const why = err instanceof Error ? err.message.slice(0, 200) : 'error';
        await alertStmt(db, 'refund_cancel_failed', r.subscription_id, `${r.adjustment_id}: cron retry: ${why}`, nowMs).run();
        continue;
      }
    }
    await db.prepare('UPDATE refunds SET cancel_done_at = ? WHERE adjustment_id = ?').bind(nowMs, r.adjustment_id).run();
    counts.refund_cancel_done++;
  }
}

/**
 * The daily cron (`17 3 * * *`): deletes expired rows, retries refund cancels, alerts on customer links pending over a
 * day (deleted after 30 days) and on subscriptions left running past their grace (a missed cancel webhook). Each step
 * runs on its own: a failing one sets its counts to -1 and adds to `errors`, and the rest still run. Logs counts only.
 */
export async function runCleanup(env: Env, nowMs: number, deps: { paddle: PaddleApi }): Promise<Record<string, number>> {
  const db = env.DB;
  const counts: Record<string, number> = { errors: 0 };
  const step = async (keys: readonly string[], fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      for (const k of keys) counts[k] = -1;
      counts.errors!++;
      console.error(JSON.stringify({ cron: 'cleanup', failed: keys[0], error: err instanceof Error ? err.name : 'error' }));
    }
  };

  for (const [table, where] of EXPIRED) {
    await step([table], async () => {
      const r = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${BATCH})`).bind(nowMs).run();
      counts[table] = r.meta.changes;
    });
  }

  await step(['refund_cancel_done', 'refund_cancel_failed', 'refund_cancel_gave_up'], () => retryRefundCancels(db, nowMs, deps.paddle, counts));

  // Customer links waiting for a `customer.created` that may never come (an existing Paddle customer).
  await step(['paddle_link_pending'], async () => {
    const gone = await db.prepare(`DELETE FROM paddle_link_pending WHERE rowid IN (SELECT rowid FROM paddle_link_pending WHERE created_at < ?1 - ${PENDING_KEEP_MS} LIMIT ${BATCH})`).bind(nowMs).run();
    counts.paddle_link_pending = gone.meta.changes;
  });
  await step(['customer_pending_stale'], async () => {
    const pendingToday = await alertedToday(db, 'customer_pending_stale', nowMs);
    const pending = await db.prepare(`SELECT DISTINCT customer_id FROM paddle_link_pending WHERE created_at < ?1 - ${PENDING_ALERT_MS} LIMIT 100`).bind(nowMs).all<{ customer_id: string }>();
    const alerts = pending.results.filter((p) => !pendingToday.has(p.customer_id))
      .map((p) => alertStmt(db, 'customer_pending_stale', p.customer_id, 'customer link pending over 24 h (no customer.created)', nowMs));
    if (alerts.length) await db.batch(alerts);
    counts.customer_pending_stale = alerts.length;
  });

  // Subscriptions still `active`·`trialing`·`past_due` that liveSql no longer counts: a cancel/past-due webhook was missed.
  await step(['subscription_stale'], async () => {
    const staleToday = await alertedToday(db, 'subscription_stale', nowMs);
    const stale = await db.prepare(`SELECT id, status FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due') AND NOT ${liveSql('?1')} LIMIT 100`)
      .bind(nowMs).all<{ id: string; status: string }>();
    const alerts = stale.results.filter((s) => !staleToday.has(s.id))
      .map((s) => alertStmt(db, 'subscription_stale', s.id, `${s.status} past its grace (missed webhook?)`, nowMs));
    if (alerts.length) await db.batch(alerts);
    counts.subscription_stale = alerts.length;
  });

  console.log(JSON.stringify({ cron: 'cleanup', ...counts }));
  return counts;
}
