export type OpsKind = 'unmatched' | 'customer_conflict' | 'second_subscription' | 'invalid_event' | 'bad_payload' | 'refund_cancel_failed';

/**
 * The statement that records an operator alert (`ops_alerts`, put it in the same batch as the change it is about),
 * plus one `console.error` line `{alert, ref}`. `ref` is an id (subscription, event, hash), never an email or token.
 * The operator reads `resolved_at IS NULL` rows with `wrangler d1 execute` (README).
 */
export function alertStmt(db: D1Database, kind: OpsKind, ref: string | null, detail: string, now: number): D1PreparedStatement {
  console.error(JSON.stringify({ alert: kind, ref }));
  return db.prepare('INSERT INTO ops_alerts (kind, ref, detail, created_at) VALUES (?, ?, ?, ?)').bind(kind, ref, detail, now);
}
