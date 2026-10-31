/** Canned answers of the two trading bots, shapes verified against the live services on 2026-10-31. `HOME` paths are planted to prove they never leave. */
import { HUB_URLS } from '../shared';

export const BOT_NOW = Date.parse('2026-10-31T06:16:00Z'); // 15:16 KST
export const BOT_HOME = '/Users/alice';

export const STATUS_8830 = {
  id: 'trading', state: 'ok', stage: 'paper', lastActivity: '2026-10-31T15:16:06+09:00',
  metrics: {
    dwf_basket_count: 12, dwf_basket_coins: ['VELVET', 'BICO', 'ARIA', 'FF'], dwf_watch_total: 63, dwf_watch_mtime: '2026-10-20T14:51:33+09:00',
    shadow_heartbeat_age_s: 5, shadow_files: [{ path: `${BOT_HOME}/.local/state/mmp_pump_shadow.db`, mtime: '2026-10-31T13:46:55+09:00', size: 5148672 }],
    onchain_alerts_count: 1113, last_onchain_alert_ts: '2026-10-31T06:09:40Z', onchain_alerts_source: 'server',
    dwf_maker_paper_enabled: true, dwf_maker_paper_mode: 'paper', promotion_eligible: false, maker_universe_count: 8, maker_updated_at: '2026-10-28T03:18:41+09:00',
    adaptive_paper_only: true, adaptive_live: false, maker_graft_smoke_rows: 25, maker_graft_promotion_eligible: false, ops_docs_count: 17,
    snapshot_age_h: 23.53, snapshot_generated_at: '2026-10-30T15:44:35+09:00',
  },
  alerts: [{ level: 'warn', msg: `스냅샷 오래됨 ${BOT_HOME}/trading-status/snapshot`, ts: '2026-10-31T15:16:06+09:00' }],
  sources: [`${BOT_HOME}/arbitrage-nexus/config/dwf_watch.json`],
  generated_at: '2026-10-31T15:16:11+09:00',
};

export const SNAPSHOT_8830 = {
  source: 'trading_room_box',
  dwf_maker_paper: { enabled: true, mode: 'paper', promotion_eligible: false, updated_at: '2026-10-28T03:18:41+09:00', symbols: ['AAA', 'BBB', 'CCC'] },
  dwf_maker_paper_file: { path: `${BOT_HOME}/.local/state/dwf_maker_paper.json`, exists: true, mtime: '2026-10-28T03:18:41+09:00', size: 100 },
  adaptive_freeze: { paper_only: true, live: false, promotion: false, onchain_feed_found: true, freeze: true, path: `${BOT_HOME}/x`, exists: true },
  maker_graft_smoke: { n_rows: 25, n_symbols: 5, symbols: ['AAA'], maker_model: 'graft-v1', promotion_eligible: false, claim_oos_validation: false, note: `스모크만 (${BOT_HOME}/arbitrage-nexus)`, path: `${BOT_HOME}/y` },
  onchain_sell_alerts: { path: `${BOT_HOME}/.local/state/adaptive_onchain/onchain_sell_alerts.jsonl`, exists: true, count: 1100, last_ts: '2026-10-30T06:09:40Z' },
  ops_docs_20261028: [],
  snapshot_generated_at: '2026-10-30T15:44:35+09:00',
};

const book = (id: string, strategy: string, tf: string, label: string, equity: number, realized: number, unrealized: number, n: number, wins: number, open: Record<string, unknown>[] = []) => ({
  id, strategy, tf, label, symbols: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK'], cash_start: 60000, equity, realized, unrealized, n_trades: n, wins, net_pnl_trades: realized + 2, avg_r: n ? 1.16 : 0, max_dd_pct: 0.57, open, last_bar_kst: '2026-10-31 15:00', signals_seen: 13,
});
export const PAPER_STATE = {
  live: false, mode: 'PAPER (모의 체결 · 실주문 없음)', exchange_data: 'OKX public REST (API 키 없음)', started_kst: '2026-10-31 02:47', first_start_kst: '2026-10-30 00:31', now_kst: '2026-10-31 15:16', uptime_s: 44914, loops: 2004, errors: 0, last_error: null, last_poll_kst: '2026-10-31 15:16', poll_s: 15, fee_pct: 0.04, notional_frac: 0.1,
  books: [
    book('kpb_15m', 'kpb', '15m', '① KPB 피벗 돌파 · 15m', 60187.61, 289.73, -102.12, 8, 7, [{ sym: 'BTC', side: 'short', entry: 77966.9, stop: 81944.4, tp: 72000.65, qty: 0.01286, entry_kst: '2026-10-30 08:45', mark: 77257.6, upnl: 9.12, upnl_pct: 0.91 }, { sym: 'ETH', side: 'long', entry: 2000, stop: 1900, tp: 2300, qty: 3, entry_kst: '2026-10-31 09:00', mark: 1950, upnl: -150, upnl_pct: -2.5 }]),
    book('kpb_1h', 'kpb', '1h', '② KPB 피벗 돌파 · 1h', 60010.79, 10.79, 0, 1, 1),
    book('fcv_1h', 'fcv', '1h', '③ FCV 거짓돌파 · 1h', 59930.5, -69.5, 0, 2, 0),
    book('fcv_4h', 'fcv', '4h', '④ FCV 거짓돌파 · 4h', 60000, 0, 0, 0, 0),
  ],
  feeds: { BTC_15m: { bars: 1050, last_closed_kst: '2026-10-31 15:00', live: 77257.6 } },
  rules: '확정 봉에서만 신호 · 신호 봉 종가로 모의 진입',
  disclaimer: '분석·연구용 모의 거래이며 투자 권유가 아닙니다. 실거래 OFF.',
};
export const PAPER_HEALTH = { ok: true, live: false, loops: 2004, ready: true, now_kst: '2026-10-31 15:16' };
export const PAPER_TRADES = {
  trades: [
    { key: 'kpb_15m:XRP', book: 'kpb_15m', sym: 'XRP', side: 'short', entry_ts: 1793298600000, entry: 1.2819, stop: 1.3179, tp: 1.2279, qty: 780.09, exit_ts: 1793306700000, exit: 1.2279, reason: 'tp', pnl: 41.34, r: 1.47, entry_kst: '2026-10-30 03:30', exit_kst: '2026-10-30 05:45' },
    { key: 'fcv_1h:LINK', book: 'fcv_1h', sym: 'LINK', side: 'short', entry_ts: 1793372400000, entry: 11.1, stop: 11.34, tp: 10.5, qty: 100, exit_ts: 1793401200000, exit: 11.337, reason: 'stop', pnl: -27.07, r: -1.03, entry_kst: '2026-10-30 23:00', exit_kst: '2026-10-31 07:00' },
  ],
};
/** Four books × 50 polls, interleaved like the live feed (6416 rows there). */
export const PAPER_EQUITY = {
  equity: Array.from({ length: 50 }, (_, i) => ['kpb_15m', 'kpb_1h', 'fcv_1h', 'fcv_4h'].map((b, k) => ({ ts: 1793288040000 + i * 180_000, book: b, value: 60000 + (k === 0 ? i * 4 : k === 2 ? -i * 1.4 : k === 1 ? (i > 25 ? 10.79 : 0) : 0) }))).flat(),
};
export const PAPER_EVENTS = {
  events: [
    { kst: '2026-10-30 00:31', kind: 'start', key: '', msg: '엔진 시작 (LIVE=False) · 북 kpb_15m,kpb_1h,fcv_1h,fcv_4h' },
    { kst: '2026-10-30 03:30', kind: 'entry', key: 'kpb_15m:XRP', msg: 'XRP short 진입 @1.2819' },
    { kst: '2026-10-30 05:45', kind: 'exit', key: 'kpb_15m:XRP', msg: `XRP tp 청산 +41.34 (${BOT_HOME}/cblabx-lab/paper.db)` },
  ],
};
export const LEDGER_HEALTH = { ok: true, host: 'box', records: 26, engine_ready: true, last_poll_kst: '2026-10-31 15:16:10', errors: 0, last_error: null };
export const LEDGER_RECORDS = {
  records: [
    { body: { kind: 'signal', strategy: 'kpb_15m', sym: 'XRP', side: 'short', sid: 'kpb_15m:XRP@1', certifiable: false }, hash: 'aa', prev: '00', seq: 1, ts_kst: '2026-10-30 03:30:10', ts_ms: 1793298610000 },
    { body: { kind: 'exit', strategy: 'kpb_15m', sym: 'XRP', side: 'short', reason: 'tp', pnl_paper: 41.34, r_paper: 1.47, r_cert: null, certifiable: false, trade_id: 1 }, hash: 'bb', prev: 'aa', seq: 2, ts_kst: '2026-10-30 05:45:12', ts_ms: 1793306712000 },
    { body: { kind: 'exit', strategy: 'fcv_1h', sym: 'LINK', side: 'short', reason: 'stop', pnl_paper: -27.0718, r_paper: -1.0309, r_cert: null, certifiable: false, trade_id: 10 }, hash: 'cc', prev: 'bb', seq: 24, ts_kst: '2026-10-31 08:00:24', ts_ms: 1793401224053 },
  ],
  total: 26,
};
export const LEDGER_STATS = { stats: { kpb_15m: { signals: 2, signals_cert: 0, exits: 2, exits_cert: 0, r_cert_sum: 0, latency_median_s: 633.8, progress: '0/100' }, fcv_1h: { signals: 1, signals_cert: 0, exits: 1, exits_cert: 0, r_cert_sum: 0, latency_median_s: 134.7, progress: '0/100' } }, max_latency_s: 90 };
export const LEDGER_VERIFY = { ok: true, msg: 'ok (26 records, head 7e06f40d3b1420ec…)', n: 26, head: '7e06f40d3b1420ec4e0959f82bde5ff1e256ad9caa17a9ee5b4c7ad5777a9cfe', warnings: [] };

/** URL → canned JSON for every bot endpoint (override or delete entries to simulate a bot down). */
export const botUrls = (over: Partial<Record<keyof typeof HUB_URLS, unknown>> = {}): Record<string, unknown> => {
  const m: Partial<Record<keyof typeof HUB_URLS, unknown>> = {
    trading: STATUS_8830, tradingHealth: { ok: true, generated_at: '2026-10-31T15:16:11+09:00' },
    paperState: PAPER_STATE, paperHealth: PAPER_HEALTH, paperTrades: PAPER_TRADES, paperEquity: PAPER_EQUITY, paperEvents: PAPER_EVENTS,
    ledgerHealth: LEDGER_HEALTH, ledgerRecords: LEDGER_RECORDS, ledgerStats: LEDGER_STATS, ledgerVerify: LEDGER_VERIFY,
    ...over,
  };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined).map(([k, v]) => [HUB_URLS[k as keyof typeof HUB_URLS], v]));
};
