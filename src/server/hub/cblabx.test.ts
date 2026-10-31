import { describe, expect, it } from 'vitest';
import { BOT_HOME, BOT_NOW, LEDGER_HEALTH, LEDGER_RECORDS, LEDGER_STATS, LEDGER_VERIFY, PAPER_EQUITY, PAPER_EVENTS, PAPER_STATE, PAPER_TRADES, botUrls } from './__fixtures__/trading-bots';
import { EQUITY_POINTS, SPARK_N, buildLedger, buildPaper, collectVer2, equityChart, kstToIso, parseEquity, parseEvents, parseTrades } from './cblabx';
import { HUB_URLS, stripSecrets, type HubDeps } from './shared';

const noHome = (v: unknown): void => { const s = JSON.stringify(v); expect(s).not.toContain(BOT_HOME); expect(s).not.toMatch(/\/home\/[a-z]/); };

describe('ver2 mapping', () => {
  it('parses the paper state into books (with open positions counted per book) and never forwards a `key`', () => {
    const p = buildPaper(PAPER_STATE, null, PAPER_TRADES, parseEquity(PAPER_EQUITY), PAPER_EVENTS);
    expect(p.ok).toBe(true);
    expect(p.live).toBe(false);
    expect(p.mode).toBe('PAPER (모의 체결 · 실주문 없음)');
    expect(p.books.map((b) => [b.id, b.openN, b.nTrades, b.wins])).toEqual([['kpb_15m', 2, 8, 7], ['kpb_1h', 0, 1, 1], ['fcv_1h', 0, 2, 0], ['fcv_4h', 0, 0, 0]]);
    expect(p.books[0]).toMatchObject({ label: '① KPB 피벗 돌파 · 15m', strategy: 'kpb', tf: '15m', cashStart: 60000, equity: 60187.61, realized: 289.73, unrealized: -102.12, avgR: 1.16, maxDdPct: 0.57, lastBarKst: '2026-10-31 15:00', signalsSeen: 13 });
    expect(p.books[0]!.spark).toHaveLength(50);
    expect(p.books[0]!.spark[49]).toBe(60000 + 49 * 4);
    expect(p.open.map((o) => [o.book, o.sym, o.side, o.upnl])).toEqual([['kpb_15m', 'BTC', 'short', 9.12], ['kpb_15m', 'ETH', 'long', -150]]);
    expect(p.trades.map((t) => [t.book, t.sym, t.reason, t.pnl])).toEqual([['fcv_1h', 'LINK', 'stop', -27.07], ['kpb_15m', 'XRP', 'tp', 41.34]]); // newest exit first
    expect(p.events.map((e) => e.kind)).toEqual(['exit', 'entry', 'start']);
    expect(p.events[0]!.msg).toBe('XRP tp 청산 +41.34 (…)');
    expect(p.equity!.series.map((s) => s.name)).toEqual(['kpb_15m', 'kpb_1h', 'fcv_1h', 'fcv_4h']);
    expect(JSON.stringify(stripSecrets(p))).toBe(JSON.stringify(p));
    expect(JSON.stringify(p)).not.toContain('"key"');
    noHome(p);
  });
  it('is a down paper view with empty lists when the state is missing', () => {
    const p = buildPaper(null, '연결 실패', null, null, null);
    expect(p).toMatchObject({ ok: false, error: '연결 실패', live: null, books: [], open: [], trades: [], events: [], equity: null });
    expect(parseTrades(null)).toEqual([]);
    expect(parseEvents('x')).toEqual([]);
  });
  it('equityChart puts every book on one axis of at most EQUITY_POINTS ticks, stepping each book forward from its last value', () => {
    const rows = parseEquity(PAPER_EQUITY);
    expect(rows).toHaveLength(200);
    const c = equityChart(rows, ['kpb_15m', 'kpb_1h'])!;
    expect(c.x).toHaveLength(50); // 50 distinct stamps < 120: all kept
    expect(c.x[0]).toBe('00:34'); // one-day range → clock labels (KST)
    expect(c.series.map((s) => s.name)).toEqual(['kpb_15m', 'kpb_1h', 'fcv_1h', 'fcv_4h']); // given order first, the rest appended
    expect(c.series[1]!.values[25]).toBe(60000);
    expect(c.series[1]!.values[26]).toBe(60010.79);
    const many = equityChart(Array.from({ length: 1000 }, (_, i) => ({ ts: 1793288040000 + i * 600_000, book: 'a', value: i })), ['a'])!;
    expect(many.x).toHaveLength(EQUITY_POINTS);
    expect(many.series[0]!.values[0]).toBe(0);
    expect(many.series[0]!.values[EQUITY_POINTS - 1]).toBe(999);
    expect(many.last.a).toHaveLength(SPARK_N);
    expect(many.x[0]).toBe('10-30 00:34'); // a multi-day range → day + clock
    const late = equityChart([{ ts: 10, book: 'a', value: 1 }, { ts: 20, book: 'b', value: 5 }, { ts: 30, book: 'a', value: 2 }], [])!;
    expect(late.series.find((s) => s.name === 'b')!.values).toEqual([null, 5, 5]);
    expect(equityChart([], [])).toBeNull();
  });
  it('maps the ledger: health, per-book stats, verify without the chain head hash, newest records first', () => {
    const l = buildLedger(LEDGER_HEALTH, null, LEDGER_RECORDS, LEDGER_STATS, LEDGER_VERIFY);
    expect(l).toMatchObject({ ok: true, records: 26, engineReady: true, lastPollKst: '2026-10-31 15:16:10', errors: 0, maxLatencyS: 90 });
    expect(l.stats.map((s) => [s.book, s.signals, s.exits, s.latencyMedianS, s.progress])).toEqual([['kpb_15m', 2, 2, 633.8, '0/100'], ['fcv_1h', 1, 1, 134.7, '0/100']]);
    expect(l.verify).toEqual({ ok: true, msg: 'ok (26 records)', n: 26, warnings: [] });
    expect(l.recent.map((r) => [r.seq, r.kind, r.sym, r.pnlPaper, r.certifiable])).toEqual([[24, 'exit', 'LINK', -27.0718, false], [2, 'exit', 'XRP', 41.34, false], [1, 'signal', 'XRP', null, false]]);
    expect(JSON.stringify(l)).not.toContain('7e06f40d');
    const down = buildLedger(null, '시간 초과', null, null, null);
    expect(down).toMatchObject({ ok: false, error: '시간 초과', records: null, stats: [], verify: null, recent: [] });
  });
  it("kstToIso reads the bots' KST stamps and rejects anything else", () => {
    expect(kstToIso('2026-10-31 15:16')).toBe('2026-10-31T06:16:00.000Z');
    expect(kstToIso('2026-10-31 15:16:10')).toBe('2026-10-31T06:16:10.000Z');
    expect(kstToIso('yesterday')).toBeNull();
    expect(kstToIso(null)).toBeNull();
  });
});

describe('collectVer2', () => {
  const deps = (urls: Record<string, unknown>): HubDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      fetchJson: async (url) => { calls.push(url); if (url in urls) return urls[url]; throw new Error('fetch failed: ECONNREFUSED'); },
      latestRender: async () => null, countEntries: async () => null, gitLastCommit: async () => null, readText: async () => null, readTail: async () => null, listDir: async () => null, fileMtime: async () => null, systemdShow: async () => null,
      now: () => BOT_NOW, self: () => ({ uptimeMs: 1, sessions: 0, activeTurns: 0 }), host: 'h', home: BOT_HOME,
    };
  };
  it('GETs the nine endpoints (never anything else), reports six sources, and caches equity/trades/events/records', async () => {
    const d = deps(botUrls());
    const r = await collectVer2(d);
    expect(r.paper.ok && r.ledger.ok).toBe(true);
    expect(r.sources.map((s) => [s.name, s.ok])).toEqual([['ver2 paper /api/paper/state', true], ['ver2 paper /api/health', true], ['ver2 paper equity/trades', true], ['ver2 ledger /health', true], ['ver2 ledger /ledger/stats', true], ['ver2 ledger /ledger/verify', true]]);
    const ver2Urls = [HUB_URLS.paperState, HUB_URLS.paperHealth, HUB_URLS.paperTrades, HUB_URLS.paperEquity, HUB_URLS.paperEvents, HUB_URLS.ledgerHealth, HUB_URLS.ledgerRecords, HUB_URLS.ledgerStats, HUB_URLS.ledgerVerify];
    expect([...d.calls].sort()).toEqual([...ver2Urls].sort());
    expect(d.calls.every((u) => u.startsWith('http://127.0.0.1:8771/') || u.startsWith('http://127.0.0.1:8793/'))).toBe(true);
    await collectVer2(d);
    expect(d.calls.filter((u) => u === HUB_URLS.paperEquity)).toHaveLength(1);
    expect(d.calls.filter((u) => u === HUB_URLS.paperState)).toHaveLength(2);
  });
  it('keeps the ledger when only the paper engine is down, and vice versa', async () => {
    const a = await collectVer2(deps(botUrls({ paperState: undefined, paperHealth: undefined, paperTrades: undefined, paperEquity: undefined, paperEvents: undefined })));
    expect(a.paper).toMatchObject({ ok: false, error: '연결 실패', books: [] });
    expect(a.ledger.ok).toBe(true);
    expect(a.sources.filter((s) => !s.ok).map((s) => [s.name, s.error])).toEqual([['ver2 paper /api/paper/state', '연결 실패'], ['ver2 paper /api/health', '연결 실패'], ['ver2 paper equity/trades', '자료 없음']]);
    const b = await collectVer2(deps(botUrls({ ledgerHealth: undefined, ledgerRecords: undefined, ledgerStats: undefined, ledgerVerify: undefined })));
    expect(b.paper.ok).toBe(true);
    expect(b.ledger).toMatchObject({ ok: false, error: '연결 실패', verify: null, stats: [], recent: [] });
    expect(b.sources.filter((s) => !s.ok)).toHaveLength(3);
  });
  it('flags health ok=false and a failed verify on the sources', async () => {
    const r = await collectVer2(deps(botUrls({ paperHealth: { ok: false }, ledgerHealth: { ...LEDGER_HEALTH, ok: false }, ledgerVerify: { ok: false, msg: 'broken', n: 3, warnings: [] } })));
    expect(r.sources.filter((s) => !s.ok).map((s) => [s.name, s.error])).toEqual([['ver2 paper /api/health', 'ok=false'], ['ver2 ledger /health', 'ok=false'], ['ver2 ledger /ledger/verify', '검증 실패']]);
    expect(r.ledger.verify).toMatchObject({ ok: false, msg: 'broken' });
  });
});
