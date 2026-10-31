import { describe, expect, it } from 'vitest';
import { BINANCE_FUTURES, BINANCE_SPOT, BYBIT, createMarketService, fromBinanceKline, fromBybitKline, serveReplay, type FetchLike } from './market';

const binRow = (t: number, c = 100) => [t, '99', '101', '98', String(c), '12.5', t + 59_999, '1250', 40, '7.5', '750', '0'];
const bybitRow = (t: number, c = 100) => [String(t), '99', '101', '98', String(c), '12.5', '1250'];

function stub(routes: Record<string, (u: URL) => { status?: number; body: unknown } | Error>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const r = hit[1](u);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  return { calls, fetchImpl };
}
const q = (s: string) => new URLSearchParams(s);

describe('kline rows', () => {
  it('normalises a Binance row (taker buy kept) and a Bybit row (taker buy null)', () => {
    expect(fromBinanceKline(binRow(1000))).toEqual({ t: 1000, o: 99, h: 101, l: 98, c: 100, v: 12.5, q: 1250, tb: 7.5 });
    expect(fromBybitKline(bybitRow(1000))).toEqual({ t: 1000, o: 99, h: 101, l: 98, c: 100, v: 12.5, q: 1250, tb: null });
  });
  it('refuses a malformed row with a 502-grade error', () => {
    expect(() => fromBinanceKline([1, 'x'])).toThrow();
    expect(() => fromBinanceKline('nope')).toThrow();
  });
});

describe('createMarketService().klines', () => {
  it('asks Binance spot with validated params only, caches the answer', async () => {
    const { calls, fetchImpl } = stub({ [`${BINANCE_SPOT}/api/v3/klines`]: () => ({ body: [binRow(0), binRow(60_000, 101)] }) });
    let now = 0;
    const svc = createMarketService(fetchImpl, () => now);
    const a = await svc.klines(q('symbol=btcusdt&interval=1m&limit=2&endTime=120000'));
    expect(a.source).toBe('binance');
    expect(a.symbol).toBe('BTCUSDT');
    expect(a.candles.map((c) => c.c)).toEqual([100, 101]);
    expect(calls).toEqual([`${BINANCE_SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2&endTime=120000`]);
    await svc.klines(q('symbol=BTCUSDT&interval=1m&limit=2&endTime=120000'));
    expect(calls.length).toBe(1);
    now = 6 * 60_000;
    await svc.klines(q('symbol=BTCUSDT&interval=1m&limit=2&endTime=120000'));
    expect(calls.length).toBe(2);
  });
  it('routes futures to fapi and clamps the limit', async () => {
    const { calls, fetchImpl } = stub({ [`${BINANCE_FUTURES}/fapi/v1/klines`]: () => ({ body: [] }) });
    await createMarketService(fetchImpl).klines(q('market=futures&symbol=ETHUSDT&interval=4h&limit=5000'));
    expect(calls[0]).toBe(`${BINANCE_FUTURES}/fapi/v1/klines?symbol=ETHUSDT&interval=4h&limit=1000`);
  });
  it('rejects a bad symbol, interval, market or time before any request', async () => {
    const { calls, fetchImpl } = stub({});
    const svc = createMarketService(fetchImpl);
    await expect(svc.klines(q('symbol=../x&interval=1h'))).rejects.toMatchObject({ status: 400 });
    await expect(svc.klines(q('symbol=BTCUSDT&interval=7m'))).rejects.toMatchObject({ status: 400 });
    await expect(svc.klines(q('symbol=BTCUSDT&interval=1h&market=margin'))).rejects.toMatchObject({ status: 400 });
    await expect(svc.klines(q('symbol=BTCUSDT&interval=1h&endTime=now'))).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
  it('falls back to Bybit (oldest first) when Binance blocks the region, not on a Binance 400', async () => {
    const blocked = stub({
      [`${BINANCE_SPOT}/api/v3/klines`]: () => ({ status: 451, body: {} }),
      [`${BYBIT}/v5/market/kline`]: (u) => { expect(u.searchParams.get('category')).toBe('spot'); expect(u.searchParams.get('interval')).toBe('60'); return { body: { result: { list: [bybitRow(3_600_000, 2), bybitRow(0, 1)] } } }; },
    });
    const a = await createMarketService(blocked.fetchImpl).klines(q('symbol=BTCUSDT&interval=1h&limit=2'));
    expect(a.source).toBe('bybit');
    expect(a.candles.map((c) => c.c)).toEqual([1, 2]);
    expect(a.candles[0]!.tb).toBeNull();

    const bad = stub({ [`${BINANCE_SPOT}/api/v3/klines`]: () => ({ status: 400, body: { code: -1121 } }), [`${BYBIT}/v5/market/kline`]: () => ({ body: { result: { list: [] } } }) });
    await expect(createMarketService(bad.fetchImpl).klines(q('symbol=NOPEUSDT&interval=1h'))).rejects.toMatchObject({ status: 400 });
    expect(bad.calls.length).toBe(1);
  });
  it('keeps the Binance error when Bybit fails too, and turns a network failure into 502', async () => {
    const both = stub({ [`${BINANCE_SPOT}/api/v3/klines`]: () => ({ status: 429, body: {} }), [`${BYBIT}/v5/market/kline`]: () => new Error('ECONNRESET') });
    await expect(createMarketService(both.fetchImpl).klines(q('symbol=BTCUSDT&interval=1h'))).rejects.toMatchObject({ status: 429 });
    const dead = stub({ [`${BINANCE_SPOT}/api/v3/klines`]: () => new Error('ENOTFOUND'), [`${BYBIT}/v5/market/kline`]: () => new Error('ENOTFOUND') });
    await expect(createMarketService(dead.fetchImpl).klines(q('symbol=BTCUSDT&interval=1h'))).rejects.toMatchObject({ status: 502, message: '거래소에 닿지 않아요' });
  });
});

describe('oi · funding · symbols', () => {
  it('maps open interest history and funding settlements', async () => {
    const { calls, fetchImpl } = stub({
      [`${BINANCE_FUTURES}/futures/data/openInterestHist`]: () => ({ body: [{ symbol: 'BTCUSDT', sumOpenInterest: '80000.5', sumOpenInterestValue: '5000000000', timestamp: 1_700_000_000_000 }] }),
      [`${BINANCE_FUTURES}/fapi/v1/fundingRate`]: () => ({ body: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: 1_700_000_000_000 }] }),
    });
    const svc = createMarketService(fetchImpl);
    expect(await svc.oi(q('symbol=BTCUSDT&period=1h&limit=1'))).toEqual({ symbol: 'BTCUSDT', period: '1h', points: [{ t: 1_700_000_000_000, oi: 80000.5, oiValue: 5_000_000_000 }] });
    expect(await svc.funding(q('symbol=BTCUSDT&limit=1'))).toEqual({ symbol: 'BTCUSDT', points: [{ t: 1_700_000_000_000, rate: 0.0001 }] });
    await expect(svc.oi(q('symbol=BTCUSDT&period=3m'))).rejects.toMatchObject({ status: 400 });
    expect(calls.length).toBe(2);
  });
  it('lists USDT perpetuals that are trading, sorted, and caches for an hour', async () => {
    const { calls, fetchImpl } = stub({
      [`${BINANCE_FUTURES}/fapi/v1/exchangeInfo`]: () => ({ body: { symbols: [
        { symbol: 'ETHUSDT', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
        { symbol: 'BTCUSDT_251226', quoteAsset: 'USDT', status: 'TRADING', contractType: 'CURRENT_QUARTER' },
        { symbol: 'OLDUSDT', quoteAsset: 'USDT', status: 'SETTLING', contractType: 'PERPETUAL' },
        { symbol: 'BTCBUSD', quoteAsset: 'BUSD', status: 'TRADING', contractType: 'PERPETUAL' },
      ] } }),
    });
    const svc = createMarketService(fetchImpl);
    expect(await svc.symbols(q('market=futures'))).toEqual({ market: 'futures', symbols: ['BTCUSDT', 'ETHUSDT'] });
    await svc.symbols(q('market=futures'));
    expect(calls.length).toBe(1);
  });
});

describe('serveReplay', () => {
  function res() {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const r = { writeHead(s: number, h: Record<string, string>) { out.status = s; out.headers = h; }, end(b: string) { out.body = b; } };
    return { out, r: r as never };
  }
  const svc = createMarketService(stub({ [`${BINANCE_SPOT}/api/v3/klines`]: () => ({ body: [binRow(0)] }) }).fetchImpl);
  it('answers klines with a short private cache, 404 for an unknown kind, 405 for non-GET', async () => {
    const a = res();
    await serveReplay(svc, new URL('http://x/api/replay/klines?symbol=BTCUSDT&interval=1m'), 'GET', a.r);
    expect(a.out.status).toBe(200);
    expect(a.out.headers['cache-control']).toBe('private, max-age=60');
    expect(JSON.parse(a.out.body).candles.length).toBe(1);
    const b = res();
    await serveReplay(svc, new URL('http://x/api/replay/orders'), 'GET', b.r);
    expect(b.out.status).toBe(404);
    const c = res();
    await serveReplay(svc, new URL('http://x/api/replay/klines?symbol=BTCUSDT&interval=1m'), 'POST', c.r);
    expect(c.out.status).toBe(405);
  });
  it('turns a validation error into 400 JSON', async () => {
    const a = res();
    await serveReplay(svc, new URL('http://x/api/replay/klines?symbol=x'), 'GET', a.r);
    expect(a.out.status).toBe(400);
    expect(JSON.parse(a.out.body).error).toContain('symbol');
  });
});
