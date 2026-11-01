import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieValueFor } from '../auth';
import { createRequestHandler, type HttpDeps } from '../http';
import { srPaperVerdict } from '../../shared/sr-types';
import { createSrService, fetchSrJson, filterSr, mapSr, mapSrStatus, SR_ALLOWED_URLS, SR_CACHE_MS, SR_STATUS_CACHE_MS, SR_STATUS_URL, SR_URL, serveSr, SrHttpError, validSrBody, validStatusBody } from './sr';
import { HUB_TIMEOUTS, LOOPBACK_MAX_BYTES, SECRET_FIELD_RE } from './shared';

const range = (o: Record<string, unknown>) => ({
  range_id: 'r1', symbol: 'BTCUSDT', side: 'SUPPORT', low: 100, high: 110, timeframe: 'MTF(1m/5m/15m/1h/4h/1d)', source: 'vpvr_sr_mtf_v1:perp',
  created_at: '2026-10-31T01:00:00+09:00', available_at: '2026-10-31T01:00:00+09:00', expires_at: '2026-11-01T01:00:00+09:00',
  invalidate_below: 98, invalidate_above: null, schema_version: 'SRRange_v1', score: 4.1, confidence_tier: 4,
  tf_hits: { '1h': 1, '4h': 0.7, '1d': 0, sma200_4h: 1.4 }, notes: ['tier=4 raw=4.1 dist=-0.07%', 'tf_hits=1h,4h'], ...o,
});

const BODY = {
  source: '/home/max/trading/state/sr_ranges.json', source_path_rel: 'state/sr_ranges.json', snapshot_mtime_kst: '2026-10-31T06:00:00+09:00', snapshot_age_h: 2.5,
  created_at_kst: '2026-10-31T06:00:00+09:00', schema_version: 'SRRangesFile_v1', policy: 'paper_only; auto MTF VPVR+pivot zones; observe_only_until_absorption',
  method: { tfs: [{ tf: '1h', profile_days: 14, pivot_days: 7, fractal_n: 3, weight: 1.0 }, { nope: 1 }], tiers: 'raw>=4.2:5, >=3.2:4, >=2.2:3, >=1.2:2, else 1', unresolved: [] },
  filter: { symbol: null, min_tier: 1 }, symbol_count: 3, range_count: 4, symbols: ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'bad symbol'],
  ranges: [
    range({}),
    range({ range_id: 'r2', side: 'RESISTANCE', low: 130, high: 132, confidence_tier: 9, score: 6, api_key: 'sk-should-not-pass', notes: ['see /home/max/trading/x.json'] }),
    range({ range_id: 'r3', symbol: 'ETHUSDT', side: 'support', low: 10, high: 11, confidence_tier: 2 }),
    range({ range_id: 'r4', side: 'SIDEWAYS' }), range({ range_id: 'r5', low: 120, high: 100 }), 'junk',
  ],
  generated_at: '2026-10-31T08:30:00+09:00',
  wallet: { address: '0xabc' },
};

/** The shape of :8830/api/status on 2026-11-01 (../.brief4/status.json): paper flags, SR snapshot meta, no DCA fields at all. */
const STATUS = {
  id: 'trading', state: 'warn', stage: 'paper', lastActivity: '2026-11-01T19:00:49+09:00', generated_at: '2026-11-01T19:00:49+09:00',
  alerts: [{ level: 'warn', msg: 'box snapshot stale >24h', ts: '2026-11-01T19:00:49+09:00' }, { level: 'nope', msg: 'see /home/max/x', ts: 'bad' }, 'junk'],
  sources: ['/home/max/trading/a.json', '/home/max/trading/b.json'],
  metrics: {
    dwf_basket_count: 12, dwf_basket_coins: ['VELVET', 'BICO', 'bad coin', 7], dwf_watch_total: 63, dwf_watch_mtime: '2026-10-20T14:51:33+09:00',
    shadow_heartbeat_age_s: 5, shadow_files: ['/home/max/trading/shadow/a.jsonl'], onchain_alerts_count: 2405, last_onchain_alert_ts: '2026-11-01T04:18:45Z', onchain_alerts_source: 'server',
    dwf_maker_paper_enabled: true, dwf_maker_paper_mode: 'paper', promotion_eligible: false, maker_universe_count: 8, maker_updated_at: '2026-10-28T03:18:41+09:00',
    adaptive_paper_only: true, adaptive_live: false, maker_graft_smoke_rows: 25, maker_graft_promotion_eligible: false, ops_docs_count: 17,
    snapshot_age_h: 51.27, snapshot_generated_at: '2026-10-30T15:44:35+09:00',
    sr_snapshot: { endpoint: '/api/sr', source: '/home/max/trading/state/sr_ranges_vpvr_mtf_20261031b.json', mtime: '2026-10-31T19:58:54+09:00', age_h: 23.03, range_count: 269, symbol_count: 37, created_at_kst: '2026-10-31T19:43:23.173879+09:00' },
    // not in the real feed — future fields must survive, secrets and layout must not
    new_metric_rows: 3, new_note: 'runs from /home/max/trading', api_key: 'sk-nope', state_dir: '/home/max/trading/state', nested: { a: 1 },
  },
};

describe('mapSr', () => {
  it('keeps the zones the panel can draw, drops the rest, and never a secret or a home path', () => {
    const s = mapSr(BODY);
    expect(s.source).toBe('sr_ranges.json');
    expect(s.ageHours).toBe(2.5);
    expect(s.snapshotAt).toBe('2026-10-30T21:00:00.000Z');
    expect(s.generatedAt).toBe('2026-10-30T23:30:00.000Z');
    expect(s.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(s.ranges.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(s.rangeCount).toBe(3);
    const r1 = s.ranges[0]!;
    expect(r1).toMatchObject({ side: 'support', low: 100, high: 110, mid: 105, tier: 4, score: 4.1, invalidateBelow: 98, invalidateAbove: null, timeframe: 'MTF(1m/5m/15m/1h/4h/1d)' });
    expect(r1.tfHits).toEqual({ '1h': 1, '4h': 0.7, '1d': 0, sma200_4h: 1 });
    expect(r1.createdAt).toBe('2026-10-30T16:00:00.000Z');
    const r2 = s.ranges[1]!;
    expect(r2.tier).toBe(5);
    expect(r2.notes[0]).toBe('see …');
    expect(s.method.tfs).toEqual([{ tf: '1h', profileDays: 14, pivotDays: 7, weight: 1 }]);
    expect(s.splitBuy).toEqual({ reported: false, note: expect.stringContaining('미보고') });
    expect(s.room).toBeNull();
    expect(s.feeds.sr.ok).toBe(false);
    const text = JSON.stringify(s);
    expect(text).not.toContain('sk-should');
    expect(text).not.toContain('0xabc');
    expect(text).not.toContain('/home/max');
    for (const k of Object.keys(s)) expect(k).not.toMatch(SECRET_FIELD_RE);
    for (const k of Object.keys(s.ranges[0]!)) expect(k).not.toMatch(SECRET_FIELD_RE);
  });

  it('survives garbage', () => {
    const s = mapSr(null);
    expect(s.ranges).toEqual([]);
    expect(s.symbols).toEqual([]);
    expect(mapSr({ ranges: 'x', symbols: 7, method: [] }).method.tfs).toEqual([]);
  });

  it('a valid body carries a ranges list (empty counts); anything else is a malformed envelope', () => {
    expect(validSrBody(BODY)).toBe(true);
    expect(validSrBody({ ranges: [], symbols: [] })).toBe(true);
    for (const bad of [null, 'x', [], {}, { ranges: 'x' }, { symbols: ['BTCUSDT'] }]) expect(validSrBody(bad)).toBe(false);
  });

  it('split-buy rows the SR feed may one day report are passed through as text, secrets and paths excluded', () => {
    const s = mapSr({ ...BODY, split_buy: { stage: 2, filled: 3, api_key: 'sk-x', log: '/home/max/dca.log' }, dca_enabled: true });
    expect(s.splitBuy.reported).toBe(true);
    const rows = s.splitBuy.reported ? s.splitBuy.rows : [];
    expect(rows).toEqual(expect.arrayContaining([['split_buy.stage', '2'], ['split_buy.filled', '3'], ['dca_enabled', 'true']]));
    expect(JSON.stringify(rows)).not.toMatch(/sk-x|\/home\//);
  });

  it('filterSr narrows to one symbol; unknown → null', () => {
    const all = mapSr(BODY);
    const btc = filterSr(all, 'BTCUSDT')!;
    expect(btc.symbol).toBe('BTCUSDT');
    expect(btc.ranges.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(btc.rangeCount).toBe(2);
    expect(btc.symbols).toEqual(all.symbols);
    expect(filterSr(all, 'SOLUSDT')!.ranges).toEqual([]);
    expect(filterSr(all, 'DOGEUSDT')).toBeNull();
  });
});

describe('mapSrStatus', () => {
  it('reports exactly the paper flags, SR snapshot meta and counters the bot sends; DCA is 미보고, nothing invented', () => {
    const r = mapSrStatus(STATUS);
    expect(r).toMatchObject({ state: 'warn', stage: 'paper', generatedAt: '2026-11-01T10:00:49.000Z', lastActivity: '2026-11-01T10:00:49.000Z' });
    expect(r.paper).toEqual({ adaptivePaperOnly: true, adaptiveLive: false, makerPaperEnabled: true, makerPaperMode: 'paper', promotionEligible: false, makerGraftPromotionEligible: false });
    expect(r.srSnapshot).toEqual({ endpoint: '/api/sr', source: 'sr_ranges_vpvr_mtf_20261031b.json', mtime: '2026-10-31T10:58:54.000Z', ageHours: 23.03, rangeCount: 269, symbolCount: 37, createdAt: '2026-10-31T10:43:23.173Z' });
    expect(r.snapshotAgeH).toBe(51.27);
    expect(r.snapshotGeneratedAt).toBe('2026-10-30T06:44:35.000Z');
    expect(r.maker).toEqual({ universeCount: 8, updatedAt: '2026-10-27T18:18:41.000Z', graftSmokeRows: 25 });
    expect(r.onchain).toEqual({ alertsCount: 2405, lastAlertAt: '2026-11-01T04:18:45.000Z', source: 'server' });
    expect(r.dwf).toEqual({ basketCount: 12, watchTotal: 63, watchMtime: '2026-10-20T05:51:33.000Z', basketCoins: ['VELVET', 'BICO'] });
    expect(r.shadowHeartbeatAgeS).toBe(5);
    expect(r.opsDocsCount).toBe(17);
    expect(r.alerts).toEqual([{ level: 'warn', text: 'box snapshot stale >24h', at: '2026-11-01T10:00:49.000Z' }, { level: 'info', text: 'see …', at: null }]);
    expect(r.dca).toEqual({ reported: false, note: expect.stringContaining('DCA') });
    expect(srPaperVerdict({ room: r })).toBe('paper');
  });

  it('unknown scalar metrics survive as extra rows; secrets, file lists, directories and nested blocks do not', () => {
    const r = mapSrStatus(STATUS);
    expect(r.extra).toEqual([['new_metric_rows', 3], ['new_note', 'runs from …']]);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/sk-nope|\/home\/|shadow\/|api_key|state_dir/);
  });

  it('DCA-looking metrics, when the bot ever reports them, land in the DCA block; missing fields stay null', () => {
    const r = mapSrStatus({ state: 'ok', metrics: { dca_stage: 2, split_buy_fills: 0, adaptive_live: 'yes' } });
    expect(r.dca).toEqual({ reported: true, rows: [['dca_stage', 2], ['split_buy_fills', 0]] });
    expect(r.paper.adaptiveLive).toBeNull();
    expect(r.stage).toBeNull();
    expect(r.srSnapshot).toBeNull();
    expect(r.generatedAt).toBeNull();
    expect(srPaperVerdict({ room: r })).toBe('unverified');
  });

  it('a body without metrics or state is not a status; the verdict turns live-risk the moment a flag says so', () => {
    expect(validStatusBody(STATUS)).toBe(true);
    expect(validStatusBody({ state: 'ok' })).toBe(true);
    for (const bad of [null, [], {}, { foo: 1 }, { metrics: 'x' }]) expect(validStatusBody(bad)).toBe(false);
    expect(srPaperVerdict({ room: mapSrStatus({ ...STATUS, metrics: { ...STATUS.metrics, adaptive_live: true } }) })).toBe('live-risk');
    expect(srPaperVerdict({ room: mapSrStatus({ ...STATUS, stage: 'live' }) })).toBe('live-risk');
    expect(srPaperVerdict({ room: mapSrStatus({ ...STATUS, metrics: { ...STATUS.metrics, dwf_maker_paper_mode: 'live' } }) })).toBe('live-risk');
    expect(srPaperVerdict({ room: null })).toBe('unverified');
  });
});

describe('createSrService', () => {
  type Answer = () => Promise<unknown>;
  /** A fake transport routed by URL (the only two the service may ask for), with a controllable clock. */
  const make = (sr: Answer, status: Answer = async () => STATUS) => {
    let t = 1_000_000;
    const fetchJson = vi.fn(async (url: string, timeout: number) => {
      expect(timeout).toBe(HUB_TIMEOUTS.default);
      if (url === SR_URL) return sr();
      if (url === SR_STATUS_URL) return status();
      throw new Error(`unexpected url ${url}`);
    });
    const calls = (url: string) => fetchJson.mock.calls.filter(([u]) => u === url).length;
    return { fetchJson, calls, svc: createSrService({ fetchJson, now: () => t }), tick: (ms: number) => { t += ms; } };
  };

  it('reads each feed on its own clock and filters every symbol from the one SR read', async () => {
    const { calls, svc, tick } = make(async () => BODY);
    const all = await svc.get(null);
    expect(all.symbol).toBeNull();
    expect(all.room?.stage).toBe('paper');
    expect(all.feeds.sr).toMatchObject({ endpoint: '/api/sr', ok: true, stale: false, error: null });
    expect(all.feeds.status).toMatchObject({ endpoint: '/api/status', ok: true, stale: false, error: null });
    expect((await svc.get('BTCUSDT')).rangeCount).toBe(2);
    expect((await svc.get('ETHUSDT')).ranges[0]!.id).toBe('r3');
    expect(calls(SR_URL)).toBe(1);
    expect(calls(SR_STATUS_URL)).toBe(1);
    tick(SR_STATUS_CACHE_MS + 1);
    await svc.get('BTCUSDT');
    expect(calls(SR_URL)).toBe(1);
    expect(calls(SR_STATUS_URL)).toBe(2);
    tick(SR_CACHE_MS - SR_STATUS_CACHE_MS);
    await svc.get('BTCUSDT');
    expect(calls(SR_URL)).toBe(2);
  });

  it('400 on a bad symbol, 404 on an unknown one, 503 only when both feeds are silent', async () => {
    const { svc } = make(async () => BODY);
    await expect(svc.get('btc')).rejects.toMatchObject({ status: 400 });
    await expect(svc.get('../x')).rejects.toMatchObject({ status: 400 });
    await expect(svc.get('DOGEUSDT')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('DOGEUSDT') });
    const down = make(async () => { throw new Error('fetch failed: ECONNREFUSED'); }, async () => { throw new Error('fetch failed: ECONNREFUSED'); });
    const err = await down.svc.get(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SrHttpError);
    expect((err as SrHttpError).status).toBe(503);
    expect((err as SrHttpError).message).toContain('연결 실패');
  });

  it('partial outage · SR silent, status alive: the room flags still answer with empty zones and the SR error named', async () => {
    const { svc } = make(async () => { throw new Error('timeout'); });
    const all = await svc.get(null);
    expect(all.ranges).toEqual([]);
    expect(all.symbols).toEqual([]);
    expect(all.room?.paper.adaptivePaperOnly).toBe(true);
    expect(all.feeds.sr).toMatchObject({ ok: false, error: '시간 초과', lastGoodAt: null });
    expect(all.feeds.status.ok).toBe(true);
    // a symbol link still answers (no 404 — the symbol list is unknown, not empty)
    const one = await svc.get('BTCUSDT');
    expect(one.symbol).toBe('BTCUSDT');
    expect(one.ranges).toEqual([]);
  });

  it('partial outage · status silent, SR alive: the zones answer and room is null with the status error named', async () => {
    const { svc } = make(async () => BODY, async () => { throw new Error('HTTP 502') ; });
    const all = await svc.get('BTCUSDT');
    expect(all.rangeCount).toBe(2);
    expect(all.room).toBeNull();
    expect(all.feeds.status).toMatchObject({ ok: false, error: 'HTTP 502', lastGoodAt: null });
    expect(srPaperVerdict(all)).toBe('unverified');
  });

  it('keeps the last good value of each feed independently when a later read fails, flagged stale with its lastGoodAt', async () => {
    let srOk = true, stOk = true;
    const { svc, tick } = make(async () => { if (srOk) return BODY; throw new Error('timeout'); }, async () => { if (stOk) return STATUS; throw new Error('timeout'); });
    const first = await svc.get(null);
    expect(first.feeds.sr.lastGoodAt).toBe(new Date(1_000_000).toISOString());
    srOk = false; tick(SR_CACHE_MS + 1);
    const second = await svc.get('BTCUSDT');
    expect(second.rangeCount).toBe(2);
    expect(second.feeds.sr).toMatchObject({ ok: true, stale: true, error: '시간 초과', lastGoodAt: new Date(1_000_000).toISOString() });
    expect(second.feeds.status).toMatchObject({ ok: true, stale: false, error: null });
    stOk = false; tick(SR_STATUS_CACHE_MS + 1);
    const third = await svc.get(null);
    expect(third.room?.stage).toBe('paper');
    expect(third.feeds.status).toMatchObject({ ok: true, stale: true, error: '시간 초과' });
  });

  it('a malformed envelope keeps the previous zones; a valid empty snapshot replaces them', async () => {
    let body: unknown = BODY;
    const { svc, tick } = make(async () => body);
    expect((await svc.get(null)).rangeCount).toBe(3);
    body = { oops: true }; tick(SR_CACHE_MS + 1);
    const kept = await svc.get(null);
    expect(kept.rangeCount).toBe(3);
    expect(kept.feeds.sr).toMatchObject({ stale: true, error: '응답 형식 오류' });
    body = { ranges: [], symbols: [] }; tick(SR_CACHE_MS + 1);
    const cleared = await svc.get(null);
    expect(cleared.rangeCount).toBe(0);
    expect(cleared.symbols).toEqual([]);
    expect(cleared.feeds.sr).toMatchObject({ ok: true, stale: false, error: null });
  });
});

function responseMock() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = { setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; }, writeHead: (s: number, h: Record<string, string>) => { out.status = s; Object.assign(out.headers, h); }, end: (v: string) => { out.body = v; finish(); } } as unknown as ServerResponse;
  return { out, res, done };
}

describe('serveSr', () => {
  const svc = createSrService({ fetchJson: async (url) => (url === SR_URL ? BODY : STATUS) });

  it('GET only; ?symbol= is trimmed and upper-cased; answers are JSON with a short private max-age', async () => {
    const a = responseMock();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol=%20btcusdt%20'), 'GET', a.res);
    expect(a.out.status).toBe(200);
    expect(a.out.headers['cache-control']).toBe('private, max-age=30');
    expect(JSON.parse(a.out.body).symbol).toBe('BTCUSDT');
    expect(JSON.parse(a.out.body).room.stage).toBe('paper');
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', undefined]) {
      const b = responseMock();
      await serveSr(svc, new URL('http://x/api/hub/sr'), method, b.res);
      expect(b.out.status).toBe(405);
      expect(b.out.headers.allow).toBe('GET');
    }
    const c = responseMock();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol=NOPE'), 'GET', c.res);
    expect(c.out.status).toBe(404);
    expect(c.out.headers['cache-control']).toBe('no-store');
    const d = responseMock();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol='), 'GET', d.res);
    expect(JSON.parse(d.out.body).symbol).toBeNull();
  });

  it('a throwing service becomes a 503 with a label, never a stack', async () => {
    const a = responseMock();
    await serveSr({ get: async () => { throw new TypeError('boom at /home/max/x.ts:1'); } }, new URL('http://x/api/hub/sr'), 'GET', a.res);
    expect(a.out.status).toBe(503);
    expect(a.out.body).not.toContain('/home/max');
    expect(JSON.parse(a.out.body).error).toContain('오류');
  });

  it('sits behind the existing session boundary: no cookie, no answer and no upstream read', async () => {
    const fetchJson = vi.fn(async (url: string) => (url === SR_URL ? BODY : STATUS));
    const service = createSrService({ fetchJson });
    const token = 'test-only-sr-cookie';
    const handler = createRequestHandler({ token, uiDir: '/unused', hub: { sr: service } } as HttpDeps);
    for (const authed of [false, true]) {
      const { out, res, done } = responseMock();
      handler({ url: '/api/hub/sr?symbol=BTCUSDT&url=http://evil.example', method: 'GET', headers: { host: 'localhost', ...(authed ? { cookie: `deck_session=${cookieValueFor(token)}` } : {}) } } as IncomingMessage, res);
      await done;
      expect(out.status).toBe(authed ? 200 : 401);
      expect(fetchJson).toHaveBeenCalledTimes(authed ? 2 : 0);
      expect(out.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(fetchJson.mock.calls.map(([u]) => u).sort()).toEqual([SR_STATUS_URL, SR_URL].sort());
  });
});

describe('SR transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('GETs only the two fixed loopback URLs, without redirects or credentials, under a timeout', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(STATUS))); vi.stubGlobal('fetch', fetch);
    expect(SR_ALLOWED_URLS).toEqual([SR_URL, SR_STATUS_URL]);
    expect(await fetchSrJson(SR_STATUS_URL, 1000)).toMatchObject({ stage: 'paper' });
    expect(fetch).toHaveBeenCalledWith(SR_STATUS_URL, expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal) }));
    await expect(fetchSrJson('http://127.0.0.1:8830/api/orders', 1000)).rejects.toThrow('allowlisted');
    await expect(fetchSrJson('http://evil.example/api/sr', 1000)).rejects.toThrow('allowlisted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects, non-200 and oversized bodies; a parse failure logs only a redacted prefix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'http://evil.example' } }))
      .mockResolvedValueOnce(new Response('x'.repeat(LOOPBACK_MAX_BYTES + 1)))
      .mockResolvedValueOnce(new Response('{"api_key":"sk-secret","path":"/home/max/private","broken":"' + 'secret'.repeat(100))));
    await expect(fetchSrJson(SR_URL, 1000)).rejects.toThrow('HTTP 302');
    await expect(fetchSrJson(SR_URL, 1000)).rejects.toThrow('too large');
    await expect(fetchSrJson(SR_URL, 1000)).rejects.toBeInstanceOf(SyntaxError);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-secret|api_key|\/home\/|private/);
  });
});
