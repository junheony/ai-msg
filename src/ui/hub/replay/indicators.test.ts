import { describe, expect, it } from 'vitest';
import type { ReplayCandle } from '../../../shared/replay-types';
import { atr, bollinger, cvd, ema, emaOf, macd, rsi, sma, smaOf, trueRange } from './indicators';

const candle = (c: number, i: number, extra: Partial<ReplayCandle> = {}): ReplayCandle => ({ t: i * 60_000, o: c, h: c + 1, l: c - 1, c, v: 10, q: 10 * c, tb: 6, ...extra });
const fromCloses = (xs: number[]) => xs.map((c, i) => candle(c, i));
const near = (a: number | null | undefined, b: number, dp = 4) => { expect(a).not.toBeNull(); expect(a!).toBeCloseTo(b, dp); };

describe('SMA / EMA', () => {
  it('SMA is null until the window fills, then the window mean', () => {
    expect(smaOf([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(sma(fromCloses([2, 4, 6, 8]), 2)).toEqual([null, 3, 5, 7]);
    expect(smaOf([1, 2], 0)).toEqual([null, null]);
  });
  it('EMA seeds with the SMA and smooths with k = 2/(n+1)', () => {
    const e = emaOf([1, 2, 3, 4, 5, 6], 3);
    expect(e.slice(0, 3)).toEqual([null, null, 2]);
    near(e[3], 2 + 0.5 * (4 - 2));
    near(e[4], 3 + 0.5 * (5 - 3));
    near(e[5], 4 + 0.5 * (6 - 4));
    expect(emaOf([1, 2], 3)).toEqual([null, null]);
    expect(ema(fromCloses([10, 10, 10, 10]), 2)).toEqual([null, 10, 10, 10]);
  });
});

describe('RSI (Wilder)', () => {
  it('matches a hand-computed 14-period series', () => {
    // the classic worked example (Wilder / StockCharts spreadsheet closes), RSI 70.53, 66.32, 66.55, 69.41, …, 37.77
    const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
    const want = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];
    const r = rsi(fromCloses(closes), 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    want.forEach((w, i) => near(r[14 + i], w, 1));
  });
  it('is 100 with no losses and 0 with no gains, and stays within 0..100', () => {
    expect(rsi(fromCloses([1, 2, 3, 4]), 3)[3]).toBe(100);
    expect(rsi(fromCloses([4, 3, 2, 1]), 3)[3]).toBe(0);
    const r = rsi(fromCloses(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 7)), 14);
    for (const v of r) if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });
});

describe('MACD(12,26,9)', () => {
  it('is EMA12 − EMA26, defined from index 25, with the signal from index 33 and hist = macd − signal', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3) * 3);
    const cs = fromCloses(closes);
    const m = macd(cs);
    const e12 = ema(cs, 12); const e26 = ema(cs, 26);
    expect(m.macd[24]).toBeNull();
    near(m.macd[25], e12[25]! - e26[25]!, 8);
    expect(m.signal[32]).toBeNull();
    near(m.signal[33], (m.macd.slice(25, 34) as number[]).reduce((a, b) => a + b, 0) / 9, 8);
    near(m.hist[40], m.macd[40]! - m.signal[40]!, 8);
  });
  it('is flat zero on a constant series', () => {
    const m = macd(fromCloses(new Array(40).fill(50)));
    expect(m.macd[39]).toBe(0); expect(m.signal[39]).toBe(0); expect(m.hist[39]).toBe(0);
  });
});

describe('Bollinger(20,2)', () => {
  it('mid is the SMA and the bands sit ±2 population standard deviations away', () => {
    const closes = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 10 : 14));
    const b = bollinger(fromCloses(closes), 20, 2);
    expect(b.mid[18]).toBeNull();
    near(b.mid[19], 12);
    near(b.upper[19], 12 + 2 * 2); // sd of {10,14} alternating = 2
    near(b.lower[19], 12 - 2 * 2);
  });
  it('collapses onto the mid line when price does not move', () => {
    const b = bollinger(fromCloses(new Array(22).fill(7)), 20, 2);
    expect(b.upper[21]).toBe(7); expect(b.lower[21]).toBe(7);
  });
});

describe('ATR (Wilder)', () => {
  it('true range uses the gap to the previous close', () => {
    const cs: ReplayCandle[] = [candle(10, 0, { h: 11, l: 9 }), candle(20, 1, { h: 21, l: 19 }), candle(20, 2, { h: 20.5, l: 19.8 })];
    const tr = trueRange(cs);
    expect(tr[0]).toBe(2); expect(tr[1]).toBe(11); near(tr[2], 0.7);
  });
  it('seeds with the mean TR and smooths à la Wilder', () => {
    const cs = fromCloses(new Array(5).fill(100)); // every TR = 2
    cs[4] = candle(100, 4, { h: 106, l: 100 }); // TR = 6
    const a = atr(cs, 3);
    expect(a.slice(0, 2)).toEqual([null, null]);
    near(a[2], 2); near(a[3], 2); near(a[4], (2 * 2 + 6) / 3);
  });
});

describe('CVD from taker volume', () => {
  it('accumulates 2·takerBuy − volume', () => {
    const cs = [candle(1, 0, { v: 10, tb: 7 }), candle(1, 1, { v: 10, tb: 3 }), candle(1, 2, { v: 4, tb: 4 })];
    expect(cvd(cs)).toEqual([4, 0, 4]);
  });
  it('is unavailable (all null) when any candle lacks the taker split', () => {
    expect(cvd([candle(1, 0), candle(1, 1, { tb: null })])).toEqual([null, null]);
  });
});
