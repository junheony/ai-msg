/** Allowlisted, read-only lab summary. Null is never zero; issues are keyed by field path. */
/**
 * Fields the feed reports that this hub does not know by name (a new strategy's metrics, a new `cache` block…): kept as
 * a small plain tree so they still show, bounded in depth, breadth and text length, with kNN/scenario/probability
 * material and secret-looking names dropped at the server. Text only — never markup, URLs or home paths.
 */
export type LabExtraValue = string | number | boolean | null | LabExtraValue[] | { [k: string]: LabExtraValue };
export type LabExtra = Record<string, LabExtraValue>;
export interface LabPosition {
  sym: string | null; side: string | null; entry_kst: string | null;
  entry: number | null; mark: number | null; upnl: number | null; upnl_pct: number | null;
}
export interface LabBook {
  id: string | null; label: string | null; equity: number | null; return_pct: number | null;
  pnl: { realized: number | null; unrealized: number | null };
  n_trades: number | null; wins: number | null; open_positions: number | null; max_dd_pct: number | null;
  open: LabPosition[] | null;
  /** The book's fields this hub does not know by name (strategy, tf, avg_r…), kept generically. */
  extra: LabExtra;
}
export interface LabTrade {
  book: string | null; sym: string | null; side: string | null; exit_kst: string | null; reason: string | null;
  pnl: number | null; r: number | null; ledger_certifiable: boolean | null;
}
export interface LabSnapshot {
  schema: 'cblabx_lab_summary/v1'; live: false; read_only: true; generated_at: string | null;
  engine: { paper: { ok: boolean | null; ready: boolean | null }; ledger: { ok: boolean | null } };
  books: LabBook[] | null; open_positions_total: number | null; recent_closed_trades: LabTrade[] | null;
  ledger: { certifiable_closed_trades: number | null; span_days: number | null; all_pass: boolean | null; expectancy: { ci95_lower: number | null; reason: string | null } };
  verify: { ok: boolean | null; msg: string | null; entries: number | null; head: string | null; last_merkle_root: string | null; last_merkle_root_date: string | null; last_ots_status: string | null; gap_count: number | null; gap_seconds_total: number | null };
  errors: string[]; issues: Record<string, string>; loading: boolean;
  /** Unknown top-level blocks, plus unknown sub-fields of `ledger`, `verify` and `engine` nested under those names. */
  extra: LabExtra;
}
export type LabState = 'ok' | 'partial' | 'loading' | 'stale' | 'error' | 'offline' | 'verify-failed';
export interface LabResponse {
  snapshot: LabSnapshot | null; state: LabState; stale: boolean; ageSeconds: number | null;
  failures: number; error: string | null; lastSuccessAt: string | null;
}

/** Words of the old kNN scenario-probability output: a key or string carrying one is never mapped and never rendered. */
export const LAB_SUPPRESS_RE = /knn|k_nn|k-nn|scenario|probab|시나리오|확률/i;
