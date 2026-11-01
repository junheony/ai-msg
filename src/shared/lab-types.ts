/** Allowlisted, read-only lab summary. Null is never zero; issues are keyed by field path. */
export interface LabPosition {
  sym: string | null; side: string | null; entry_kst: string | null;
  entry: number | null; mark: number | null; upnl: number | null; upnl_pct: number | null;
}
export interface LabBook {
  id: string | null; label: string | null; equity: number | null; return_pct: number | null;
  pnl: { realized: number | null; unrealized: number | null };
  n_trades: number | null; wins: number | null; open_positions: number | null; max_dd_pct: number | null;
  open: LabPosition[] | null;
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
}
export type LabState = 'ok' | 'partial' | 'loading' | 'stale' | 'error' | 'offline' | 'verify-failed';
export interface LabResponse {
  snapshot: LabSnapshot | null; state: LabState; stale: boolean; ageSeconds: number | null;
  failures: number; error: string | null; lastSuccessAt: string | null;
}
