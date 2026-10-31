/**
 * 트레이딩-ver2 (cblabx-lab), read-only: the paper engine (:8771 /api/paper/state, /trades, /equity, /events) and its
 * hash-chained ledger (:8793 /health, /ledger, /ledger/stats, /ledger/verify). GET only; nothing here starts, stops or
 * writes anything. The equity series (~6k rows for four books) and the trade/event lists are fetched once a minute.
 * Upstream `key` fields (row ids) are never forwarded: stripSecrets would drop them anyway, and nothing needs them.
 */
import type { HubChartSeries, HubSource, Ver2Book, Ver2Event, Ver2Ledger, Ver2LedgerRecord, Ver2LedgerStat, Ver2Paper, Ver2Position, Ver2Trade } from '../../shared/hub-types';
import { HUB_TIMEOUTS, HUB_URLS, SLOW_CACHE_MS, arr, bool, errorText, fmtClock, fmtKst, isObj, num, objs, probe, scrub, slowCache, str, toIso, type HubDeps } from './shared';

/** Points on the shared equity axis; sparklines keep the last SPARK_N of a book's own series. */
export const EQUITY_POINTS = 120;
export const SPARK_N = 60;
const MAX_TRADES = 40;
const MAX_EVENTS = 30;
const MAX_RECORDS = 40;

const kst = (v: unknown): string | null => str(v, 30);

/* ───────── paper engine ───────── */

export interface EquityRow { ts: number; book: string; value: number }

export function parseEquity(raw: unknown): EquityRow[] {
  const rows = isObj(raw) ? objs(raw.equity) : objs(raw);
  const out: EquityRow[] = [];
  for (const r of rows) { const ts = num(r.ts), v = num(r.value), b = str(r.book, 30); if (ts !== null && v !== null && b) out.push({ ts, book: b, value: v }); }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * One time axis for every book: at most `points` evenly spaced timestamps over the whole range; a book's value at a tick
 * is its last value at or before it (null before its first). Labels: clock when the range is one day, day+clock otherwise.
 */
export function equityChart(rows: EquityRow[], bookOrder: string[], points = EQUITY_POINTS): { x: string[]; series: HubChartSeries[]; last: Record<string, (number | null)[]> } | null {
  if (rows.length === 0) return null;
  const stamps = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
  const pick = stamps.length <= points ? stamps : Array.from({ length: points }, (_, i) => stamps[Math.round((i / (points - 1)) * (stamps.length - 1))]!);
  const books = [...bookOrder, ...[...new Set(rows.map((r) => r.book))].filter((b) => !bookOrder.includes(b))];
  const byBook = new Map<string, EquityRow[]>();
  for (const r of rows) { const l = byBook.get(r.book); if (l) l.push(r); else byBook.set(r.book, [r]); }
  const oneDay = pick[pick.length - 1]! - pick[0]! < 86_400_000;
  const x = pick.map((t) => { const iso = new Date(t).toISOString(); return oneDay ? fmtClock(iso) : fmtKst(iso); });
  const series: HubChartSeries[] = [];
  const last: Record<string, (number | null)[]> = {};
  for (const b of books) {
    const l = byBook.get(b) ?? [];
    let j = 0; let cur: number | null = null;
    const values = pick.map((t) => { while (j < l.length && l[j]!.ts <= t) { cur = l[j]!.value; j++; } return cur; });
    series.push({ name: b, values });
    last[b] = l.length <= SPARK_N ? l.map((r) => r.value) : Array.from({ length: SPARK_N }, (_, i) => l[Math.round((i / (SPARK_N - 1)) * (l.length - 1))]!.value);
  }
  return { x, series, last };
}

export function parseBooks(state: Record<string, unknown> | null, spark: Record<string, (number | null)[]>): { books: Ver2Book[]; open: Ver2Position[] } {
  const books: Ver2Book[] = []; const open: Ver2Position[] = [];
  for (const b of objs(state?.books).slice(0, 12)) {
    const id = str(b.id, 30) ?? '?';
    const pos = objs(b.open).slice(0, 20).map((p): Ver2Position => ({ book: id, sym: scrub(p.sym, 12) || '?', side: scrub(p.side, 8), entry: num(p.entry), stop: num(p.stop), tp: num(p.tp), qty: num(p.qty), entryKst: kst(p.entry_kst), mark: num(p.mark), upnl: num(p.upnl), upnlPct: num(p.upnl_pct) }));
    open.push(...pos);
    books.push({
      id, label: scrub(b.label, 60) || id, strategy: scrub(b.strategy, 20), tf: scrub(b.tf, 8), symbols: arr(b.symbols).filter((s): s is string => typeof s === 'string').slice(0, 12).map((s) => scrub(s, 12)),
      cashStart: num(b.cash_start), equity: num(b.equity), realized: num(b.realized), unrealized: num(b.unrealized), nTrades: num(b.n_trades), wins: num(b.wins), netPnl: num(b.net_pnl_trades), avgR: num(b.avg_r), maxDdPct: num(b.max_dd_pct),
      openN: pos.length, lastBarKst: kst(b.last_bar_kst), signalsSeen: num(b.signals_seen), spark: spark[id] ?? [],
    });
  }
  return { books, open };
}

export const parseTrades = (raw: unknown): Ver2Trade[] => objs(isObj(raw) ? raw.trades : raw).map((t): Ver2Trade => ({ book: scrub(t.book, 30) || '?', sym: scrub(t.sym, 12) || '?', side: scrub(t.side, 8), entryKst: kst(t.entry_kst), exitKst: kst(t.exit_kst), entry: num(t.entry), exit: num(t.exit), reason: scrub(t.reason, 20), pnl: num(t.pnl), r: num(t.r) })).sort((a, b) => (b.exitKst ?? '').localeCompare(a.exitKst ?? '')).slice(0, MAX_TRADES);
export const parseEvents = (raw: unknown): Ver2Event[] => objs(isObj(raw) ? raw.events : raw).map((e): Ver2Event => ({ kst: kst(e.kst), kind: scrub(e.kind, 12), msg: scrub(e.msg, 160) })).reverse().slice(0, MAX_EVENTS);

export function buildPaper(state: Record<string, unknown> | null, error: string | null, trades: unknown, equity: EquityRow[] | null, events: unknown): Ver2Paper {
  const bookOrder = objs(state?.books).map((b) => str(b.id, 30) ?? '?');
  const chart = equity ? equityChart(equity, bookOrder) : null;
  const { books, open } = parseBooks(state, chart?.last ?? {});
  return {
    ok: state !== null, error: state ? null : (error ?? '오류'),
    live: bool(state?.live), mode: state ? scrub(state.mode, 60) || null : null, exchangeData: state ? scrub(state.exchange_data, 60) || null : null,
    startedKst: kst(state?.started_kst), firstStartKst: kst(state?.first_start_kst), nowKst: kst(state?.now_kst), uptimeS: num(state?.uptime_s), loops: num(state?.loops), errors: num(state?.errors), lastError: state ? scrub(state.last_error, 160) || null : null, lastPollKst: kst(state?.last_poll_kst), pollS: num(state?.poll_s), feePct: num(state?.fee_pct), notionalFrac: num(state?.notional_frac),
    books, open, trades: parseTrades(trades), events: parseEvents(events),
    equity: chart ? { x: chart.x, series: chart.series } : null,
    rules: state ? scrub(state.rules, 300) || null : null, disclaimer: state ? scrub(state.disclaimer, 160) || null : null,
  };
}

/* ───────── ledger ───────── */

export function parseStats(raw: unknown): { stats: Ver2LedgerStat[]; maxLatencyS: number | null } {
  const s = isObj(raw) && isObj(raw.stats) ? raw.stats : {};
  const stats = Object.entries(s).filter((e): e is [string, Record<string, unknown>] => isObj(e[1])).slice(0, 12).map(([book, v]): Ver2LedgerStat => ({ book: scrub(book, 30), signals: num(v.signals), signalsCert: num(v.signals_cert), exits: num(v.exits), exitsCert: num(v.exits_cert), rCertSum: num(v.r_cert_sum), latencyMedianS: num(v.latency_median_s), progress: str(v.progress, 12) }));
  return { stats, maxLatencyS: isObj(raw) ? num(raw.max_latency_s) : null };
}

export const parseRecords = (raw: unknown): Ver2LedgerRecord[] => objs(isObj(raw) ? raw.records : raw).map((r): Ver2LedgerRecord => {
  const b = isObj(r.body) ? r.body : {};
  return { seq: num(r.seq), tsKst: kst(r.ts_kst), kind: scrub(b.kind, 12), strategy: scrub(b.strategy, 20), sym: scrub(b.sym, 12), side: scrub(b.side, 8), reason: scrub(b.reason, 20), pnlPaper: num(b.pnl_paper), rPaper: num(b.r_paper), rCert: num(b.r_cert), certifiable: bool(b.certifiable) };
}).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, MAX_RECORDS);

export function buildLedger(health: Record<string, unknown> | null, error: string | null, records: unknown, stats: unknown, verify: unknown): Ver2Ledger {
  const v = isObj(verify) ? verify : null;
  const st = parseStats(stats);
  return {
    ok: health !== null, error: health ? null : (error ?? '오류'),
    records: num(health?.records) ?? (isObj(records) ? num(records.total) : null), engineReady: bool(health?.engine_ready), lastPollKst: kst(health?.last_poll_kst), errors: num(health?.errors), lastError: health ? scrub(health.last_error, 160) || null : null,
    stats: st.stats, maxLatencyS: st.maxLatencyS,
    // the chain head hash is left out: it is an identifier of no use on a status card
    verify: v ? { ok: bool(v.ok), msg: scrub(v.msg, 120).replace(/,?\s*head [0-9a-f]+…?/i, ''), n: num(v.n), warnings: arr(v.warnings).filter((w): w is string => typeof w === 'string').slice(0, 10).map((w) => scrub(w, 160)) } : null,
    recent: parseRecords(records),
  };
}

/* ───────── collector (slow parts cached per deps) ───────── */

interface SlowBundle { trades: unknown; equity: EquityRow[]; events: unknown; records: unknown }
const slowByDeps = new WeakMap<HubDeps, () => Promise<{ value: SlowBundle | null; stale: boolean; error: string | null }>>();
function slowFor(deps: HubDeps): () => Promise<{ value: SlowBundle | null; stale: boolean; error: string | null }> {
  let s = slowByDeps.get(deps);
  if (!s) {
    s = slowCache(SLOW_CACHE_MS.ver2, async () => {
      const get = (url: string): Promise<unknown> => deps.fetchJson(url, HUB_TIMEOUTS.default).catch(() => null);
      const [trades, equity, events, records] = await Promise.all([get(HUB_URLS.paperTrades), get(HUB_URLS.paperEquity), get(HUB_URLS.paperEvents), get(HUB_URLS.ledgerRecords)]);
      return { trades, equity: parseEquity(equity), events, records };
    }, deps.now);
    slowByDeps.set(deps, s);
  }
  return s;
}

export interface Ver2Result { paper: Ver2Paper; ledger: Ver2Ledger; sources: HubSource[] }

export async function collectVer2(deps: HubDeps): Promise<Ver2Result> {
  const [state, pHealth, lHealth, stats, verify, slow] = await Promise.all([
    probe(deps, 'ver2 paper /api/paper/state', HUB_URLS.paperState, HUB_TIMEOUTS.default),
    probe(deps, 'ver2 paper /api/health', HUB_URLS.paperHealth, HUB_TIMEOUTS.default),
    probe(deps, 'ver2 ledger /health', HUB_URLS.ledgerHealth, HUB_TIMEOUTS.default),
    probe(deps, 'ver2 ledger /ledger/stats', HUB_URLS.ledgerStats, HUB_TIMEOUTS.default),
    probe(deps, 'ver2 ledger /ledger/verify', HUB_URLS.ledgerVerify, HUB_TIMEOUTS.default),
    slowFor(deps)().catch((err: unknown) => ({ value: null, stale: false, error: errorText(err) })),
  ]);
  const st = isObj(state.data) ? state.data : null;
  const lh = isObj(lHealth.data) ? lHealth.data : null;
  const bundle = slow.value;
  const paper = buildPaper(st, state.source.error ?? null, bundle?.trades ?? null, bundle?.equity ?? null, bundle?.events ?? null);
  const ledger = buildLedger(lh, lHealth.source.error ?? null, bundle?.records ?? null, stats.data, verify.data);
  const pHealthOk = isObj(pHealth.data) && pHealth.data.ok === true;
  const sources: HubSource[] = [
    state.source,
    { ...pHealth.source, ok: pHealth.source.ok && pHealthOk, ...(pHealth.source.ok && !pHealthOk ? { error: 'ok=false' } : {}) },
    { name: 'ver2 paper equity/trades', ok: bundle !== null && bundle.equity.length > 0 && !slow.stale, ms: 0, ...(bundle === null ? { error: slow.error ?? '오류' } : bundle.equity.length === 0 ? { error: '자료 없음' } : slow.stale ? { error: '이전 값' } : {}) },
    { ...lHealth.source, ok: lHealth.source.ok && lh?.ok === true, ...(lHealth.source.ok && lh?.ok !== true ? { error: 'ok=false' } : {}) },
    stats.source,
    { ...verify.source, ok: verify.source.ok && ledger.verify?.ok === true, ...(verify.source.ok && ledger.verify?.ok !== true ? { error: '검증 실패' } : {}) },
  ];
  return { paper, ledger, sources };
}

/** `2026-10-31 15:16` / `2026-10-31 15:16:10` (KST, as the bots print) → ISO; null otherwise. */
export const kstToIso = (v: string | null): string | null => (v && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? toIso(`${v.replace(' ', 'T')}${v.length === 16 ? ':00' : ''}+09:00`) : null);
