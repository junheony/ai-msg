import { describe, expect, it, vi } from 'vitest';
import { createSrService, filterSr, mapSr, SR_CACHE_MS, SR_URL, serveSr, SrHttpError } from './sr';
import { HUB_TIMEOUTS, SECRET_FIELD_RE } from './shared';

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

describe('mapSr', () => {
  it('keeps the zones the panel can draw, drops the rest, and never a secret or a home path', () => {
    const s = mapSr(BODY);
    expect(s.source).toBe('sr_ranges.json');
    expect(s.ageHours).toBe(2.5);
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

describe('createSrService', () => {
  const make = (answer: () => Promise<unknown>) => {
    let t = 1_000_000;
    const fetchJson = vi.fn(async (url: string, timeout: number) => { expect(url).toBe(SR_URL); expect(timeout).toBe(HUB_TIMEOUTS.default); return answer(); });
    return { fetchJson, svc: createSrService({ fetchJson, now: () => t }), tick: (ms: number) => { t += ms; } };
  };

  it('reads the bot once a minute and filters every symbol from that one read', async () => {
    const { fetchJson, svc, tick } = make(async () => BODY);
    const all = await svc.get(null);
    expect(all.symbol).toBeNull();
    expect((await svc.get('BTCUSDT')).rangeCount).toBe(2);
    expect((await svc.get('ETHUSDT')).ranges[0]!.id).toBe('r3');
    expect(fetchJson).toHaveBeenCalledTimes(1);
    tick(SR_CACHE_MS + 1);
    await svc.get('BTCUSDT');
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('400 on a bad symbol, 404 on an unknown one, 503 when the bot is silent (and lowercase is upper-cased by the route)', async () => {
    const { svc } = make(async () => BODY);
    await expect(svc.get('btc')).rejects.toMatchObject({ status: 400 });
    await expect(svc.get('../x')).rejects.toMatchObject({ status: 400 });
    await expect(svc.get('DOGEUSDT')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('DOGEUSDT') });
    const down = make(async () => { throw new Error('fetch failed: ECONNREFUSED'); });
    const err = await down.svc.get(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SrHttpError);
    expect((err as SrHttpError).status).toBe(503);
    expect((err as SrHttpError).message).toContain('연결 실패');
  });

  it('keeps the last good snapshot when a later read fails', async () => {
    let ok = true;
    const { svc, tick } = make(async () => { if (ok) return BODY; throw new Error('timeout'); });
    await svc.get(null);
    ok = false; tick(SR_CACHE_MS + 1);
    expect((await svc.get('BTCUSDT')).rangeCount).toBe(2);
  });
});

describe('serveSr', () => {
  const res = () => {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const r = { writeHead: (s: number, h: Record<string, string>) => { out.status = s; out.headers = h; }, end: (b: string) => { out.body = b; } };
    return { r: r as unknown as import('node:http').ServerResponse, out };
  };
  const svc = createSrService({ fetchJson: async () => BODY });

  it('GET only; ?symbol= is trimmed and upper-cased; answers are JSON with a short private max-age', async () => {
    const a = res();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol=%20btcusdt%20'), 'GET', a.r);
    expect(a.out.status).toBe(200);
    expect(a.out.headers['cache-control']).toBe('private, max-age=30');
    expect(JSON.parse(a.out.body).symbol).toBe('BTCUSDT');
    const b = res();
    await serveSr(svc, new URL('http://x/api/hub/sr'), 'POST', b.r);
    expect(b.out.status).toBe(405);
    const c = res();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol=NOPE'), 'GET', c.r);
    expect(c.out.status).toBe(404);
    expect(c.out.headers['cache-control']).toBe('no-store');
    const d = res();
    await serveSr(svc, new URL('http://x/api/hub/sr?symbol='), 'GET', d.r);
    expect(JSON.parse(d.out.body).symbol).toBeNull();
  });

  it('a throwing service becomes a 503 with a label, never a stack', async () => {
    const a = res();
    await serveSr({ get: async () => { throw new TypeError('boom at /home/max/x.ts:1'); } }, new URL('http://x/api/hub/sr'), 'GET', a.r);
    expect(a.out.status).toBe(503);
    expect(a.out.body).not.toContain('/home/max');
    expect(JSON.parse(a.out.body).error).toContain('오류');
  });
});
