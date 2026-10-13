import { describe, expect, it } from 'vitest';
import { PANE_MIN_PX, paneColumns, paneSize, resizePair } from './paneResize';

describe('paneResize', () => {
  it('paneSize: absent / bad values are an equal column (1)', () => {
    expect(paneSize(undefined)).toBe(1);
    expect(paneSize('2')).toBe(1);
    expect(paneSize(Number.NaN)).toBe(1);
    expect(paneSize(-1)).toBe(1);
    expect(paneSize(0)).toBe(1);
    expect(paneSize(Infinity)).toBe(1);
    expect(paneSize(1e9)).toBe(1);
    expect(paneSize(1.5)).toBe(1.5);
    expect(paneSize(0.001)).toBe(0.05);
  });

  it('paneColumns: one minmax track per pane, a 6px splitter track between neighbours', () => {
    expect(paneColumns([1])).toBe('minmax(var(--pane-min), 1fr)');
    expect(paneColumns([1.5, 0.5, 1])).toBe('minmax(var(--pane-min), 1.5fr) 6px minmax(var(--pane-min), 0.5fr) 6px minmax(var(--pane-min), 1fr)');
  });

  it('resizePair: the two neighbours trade width, their weight sum stays', () => {
    const [a, b] = resizePair([1, 1], [500, 500], 100);
    expect(a + b).toBeCloseTo(2);
    expect(a).toBeCloseTo(1.2);
    expect(b).toBeCloseTo(0.8);
    const [c, d] = resizePair([2, 1], [600, 300], -150);
    expect(c + d).toBeCloseTo(3);
    expect(c).toBeCloseTo(1.5); // 450 / 900 × 3
  });

  it('resizePair: neither side goes below the minimum width', () => {
    const [a, b] = resizePair([1, 1], [500, 500], 10_000);
    expect(b).toBeCloseTo((2 * PANE_MIN_PX) / 1000);
    expect(a).toBeCloseTo(2 - (2 * PANE_MIN_PX) / 1000);
    const [c] = resizePair([1, 1], [500, 500], -10_000);
    expect(c).toBeCloseTo((2 * PANE_MIN_PX) / 1000);
  });

  it('resizePair: no room to trade (both at the minimum) or a bad delta leaves the weights', () => {
    expect(resizePair([1, 1], [300, 300], 50)).toEqual([1, 1]);
    expect(resizePair([1.2, 0.8], [500, 500], Number.NaN)).toEqual([1.2, 0.8]);
  });
});
