import { describe, expect, it } from 'vitest';
import { futureCandles, planAt, randomPlayStart, sceneCandles, snapToInterval, startIndexFor, TAIL, VISIBLE, WARMUP } from './scene';

const H = 3_600_000;

describe('scene planning', () => {
  it('sizes the request from warm-up, visible window, rounds × horizon and the tail, within one request', () => {
    expect(futureCandles(5, 10)).toBe(50 + TAIL);
    expect(sceneCandles(5, 10)).toBe(WARMUP + VISIBLE + 50 + TAIL);
    expect(planAt(0, '1h', 20, 20).limit).toBeLessThanOrEqual(1000);
  });
  it('plans a request that ends after the last future candle and starts play at the visible edge', () => {
    const p = planAt(10 * H, '1h', 5, 10);
    expect(p.startIndex).toBe(WARMUP + VISIBLE - 1);
    expect(p.playStartT).toBe(10 * H);
    expect(p.endTime).toBe(10 * H + futureCandles(5, 10) * H + H - 1);
  });
  it('random start stays inside [earliest + warm-up + visible, now − future] on the interval grid', () => {
    const earliest = 1_000 * H; const now = 5_000 * H;
    for (const r of [0, 0.37, 0.999999, 1 - 1e-12]) {
      const t = randomPlayStart(earliest, now, '1h', 5, 10, () => r)!;
      expect(t).toBeGreaterThanOrEqual(earliest + (WARMUP + VISIBLE) * H);
      expect(t).toBeLessThanOrEqual(now - (futureCandles(5, 10) + 1) * H);
      expect(t % H).toBe(0);
    }
    expect(randomPlayStart(earliest, now, '1h', 5, 10, () => 0)).toBe(earliest + (WARMUP + VISIBLE) * H);
  });
  it('random start is null when the symbol is too young for a full scene', () => {
    expect(randomPlayStart(0, 300 * H, '1h', 5, 10)).toBeNull();
  });
  it('snaps a date to the interval grid', () => {
    expect(snapToInterval(H + 1234, '1h')).toBe(H);
    expect(snapToInterval(86_400_000 * 3 + 5, '1d')).toBe(86_400_000 * 3);
  });
  it('places the start index from the end of what came back, giving up when there is no room', () => {
    expect(startIndexFor(sceneCandles(5, 10), 5, 10)).toBe(WARMUP + VISIBLE - 1);
    expect(startIndexFor(VISIBLE + 50 + futureCandles(5, 10), 5, 10)).toBe(VISIBLE + 49);
    expect(startIndexFor(VISIBLE + futureCandles(5, 10), 5, 10)).toBeNull();
  });
});
