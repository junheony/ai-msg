/** Synthetic test data only: every field is deliberately distinct for attribution assertions. */
export const LAB_NOW = Date.parse('2026-11-01T17:00:00+09:00');
export const labFixture = () => ({
  schema: 'cblabx_lab_summary/v1', generated_at: '2026-11-01T17:00:00+09:00', live: false, read_only: true,
  sources: {} as Record<string, unknown>, errors: [] as string[],
  engine: { paper: { ok: true, ready: true, live: false }, ledger: { ok: true } },
  books: [{ id: 'kpb_15m', label: 'KPB 피벗 돌파 · 15m', equity: 60170.39, return_pct: 0.284,
    pnl: { realized: 272.86, unrealized: -102.48 }, n_trades: 9, wins: 7, open_positions: 1, max_dd_pct: 0.41,
    open: [{ sym: 'LINK', side: 'short', entry_kst: '2026-11-01 16:15', entry: 11.329, mark: 11.505, upnl: -16.46, upnl_pct: -1.55 }],
  }],
  open_positions_total: 1,
  recent_closed_trades: [{ book: 'kpb_15m', sym: 'SOL', side: 'long', exit_kst: '2026-11-01 16:45', reason: 'tp', pnl: 42.25, r: 1.7, ledger_certifiable: true }],
  ledger: { certifiable_closed_trades: 3, span_days: 0.9, all_pass: false, expectancy: { ci95_lower: -2.88, reason: null as string | null } },
  verify: { ok: true, msg: 'verified', entries: 98, head: 'a'.repeat(64), last_merkle_root: 'b'.repeat(64), last_merkle_root_date: '2026-10-31', last_ots_status: 'submitted', gap_count: 14, gap_seconds_total: 5481 },
});
