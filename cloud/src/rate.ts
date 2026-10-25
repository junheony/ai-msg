/** Fixed-window counters in D1 (`rate` table). Windows are aligned to multiples of `windowMs`. */

export const windowStart = (windowMs: number, nowMs: number) => nowMs - (nowMs % windowMs);

/** The statement that counts one hit; returns the new count via `RETURNING count`. Usable inside a batch. */
export function hitStmt(db: D1Database, key: string, windowMs: number, nowMs: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rate (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
                                      window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart(windowMs, nowMs));
}

/** Counts a hit and says whether it is still within `limit` for this window. */
export async function hit(db: D1Database, key: string, limit: number, windowMs: number, nowMs: number): Promise<boolean> {
  const n = await hitStmt(db, key, windowMs, nowMs).first<number>('count');
  return (n ?? 0) <= limit;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
