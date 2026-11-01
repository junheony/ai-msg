// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReplayCandle } from '../../../shared/replay-types';
import type { SrRange, SrSnapshot } from '../../../shared/sr-types';
import type { SrApi } from './api';
import { SrPanel, sortRows } from './SrPanel';

// The chart is a canvas library; the panel test only needs to see what it was asked to draw.
vi.mock('./SrChart', () => ({
  SrChart: (p: { candles: unknown[]; ranges: SrRange[] }) => <div data-testid="sr-chart" data-candles={p.candles.length} data-ranges={p.ranges.map((r) => r.id).join(',')} />,
}));

const NOW = Date.parse('2026-10-31T09:00:00Z');
const zone = (id: string, symbol: string, side: SrRange['side'], low: number, high: number, tier: number, tfHits: Record<string, number> = { '1h': 1, '4h': 0.7, '1m': 0.2 }): SrRange => ({
  id, symbol, side, low, high, mid: (low + high) / 2, score: tier + 0.1, tier, tfHits, timeframe: 'MTF', createdAt: null, expiresAt: null, invalidateBelow: null, invalidateAbove: null, notes: [`tier=${tier}`],
});
const ZONES: SrRange[] = [
  zone('far-res', 'BTCUSDT', 'resistance', 118_000, 118_400, 5),
  zone('near-sup', 'BTCUSDT', 'support', 109_300, 109_700, 3),
  zone('near-res', 'BTCUSDT', 'resistance', 110_900, 111_100, 2, { '1d': 1 }),
  zone('far-sup', 'BTCUSDT', 'support', 100_000, 101_000, 4, {}),
  zone('eth', 'ETHUSDT', 'support', 3_000, 3_050, 1),
];
const snap = (symbol: string | null): SrSnapshot => {
  const ranges = symbol ? ZONES.filter((z) => z.symbol === symbol) : ZONES;
  return {
    source: 'sr_ranges.json', snapshotAt: null, createdAt: null, ageHours: 2.5, policy: 'paper_only; observe_only_until_absorption', schemaVersion: 'SRRangesFile_v1',
    method: { tiers: 'raw>=4.2:5, else 1', tfs: [] }, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], symbol, ranges, rangeCount: ranges.length,
    splitBuy: { reported: false, note: '트레이딩룸(:8830)이 분할매수 페이퍼 상태를 내보내지 않음 — 미보고' }, generatedAt: new Date(NOW - 60_000).toISOString(),
  };
};
const candles = (last: number, n = 5): ReplayCandle[] => Array.from({ length: n }, (_, i) => { const c = last - (n - 1 - i) * 10; return { t: NOW - (n - i) * 3_600_000, o: c - 5, h: c + 20, l: c - 20, c, v: 1, q: c, tb: null }; });

function api(over: Partial<SrApi> = {}): SrApi {
  return { sr: vi.fn(async (s: string | null) => { if (s && !snap(null).symbols.includes(s)) throw new Error(`${s}: 스냅샷에 없는 심볼`); return snap(s); }), klines: vi.fn(async () => candles(110_000)), ...over };
}
const rows = () => within(screen.getByTestId('sr-table')).getAllByRole('row').slice(1);

afterEach(cleanup);

describe('srTick', () => {
  const AT = Date.parse('2026-10-29T00:00:00Z'); // 09:00 KST
  it('keeps the full label on a wide chart, only the time or the date on a narrow one', async () => {
    const { srTick } = await vi.importActual<typeof import('./SrChart')>('./SrChart');
    expect(srTick(AT, true, false)).toBe('29/10, 09:00');
    expect(srTick(AT, true, true)).toBe('09:00');
    expect(srTick(AT, false, true)).toBe('29/10');
  });
});

describe('sortRows', () => {
  it('nearest to the last close first, signed by side of price; strongest first when there is no price', () => {
    const btc = ZONES.filter((z) => z.symbol === 'BTCUSDT');
    const byDist = sortRows(btc, 110_000);
    expect(byDist.map((x) => x.r.id)).toEqual(['near-sup', 'near-res', 'far-res', 'far-sup']);
    expect(byDist[0]!.dist).toBeCloseTo(-0.4545, 3);
    expect(byDist[1]!.dist).toBeCloseTo(0.909, 3);
    expect(byDist[0]!.hits).toEqual(['1h', '4h']);
    expect(sortRows(btc, null).map((x) => x.r.id)).toEqual(['far-res', 'far-sup', 'near-sup', 'near-res']);
    expect(sortRows(btc, null)[0]!.dist).toBeNull();
  });
});

describe('SrPanel', () => {
  it('fills the picker from the unfiltered read, then shows one symbol server-filtered: chart with its zones and the distance-sorted table', async () => {
    const a = api();
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(a.sr).toHaveBeenCalledWith(null);
    expect(a.sr).toHaveBeenCalledWith('BTCUSDT');
    expect(a.klines).toHaveBeenCalledWith('BTCUSDT');
    const select = screen.getByLabelText('심볼') as HTMLSelectElement;
    expect(select.value).toBe('BTCUSDT');
    expect([...select.options].map((o) => o.value)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('far-res,near-sup,near-res,far-sup');
    expect(screen.getByTestId('sr-chart').dataset.candles).toBe('5');
    const r = rows();
    expect(r.map((tr) => tr.getAttribute('title'))).toEqual(['tier=3', 'tier=2', 'tier=5', 'tier=4']);
    expect(r[0]!.textContent).toContain('지지');
    expect(r[0]!.textContent).toContain('109,300.0 – 109,700.0');
    expect(r[0]!.textContent).toContain('−0.45%');
    expect(r[1]!.textContent).toContain('+0.91%');
    expect(r[0]!.textContent).toContain('1h 4h');
    expect(r[0]!.querySelector('.sr-tier')!.textContent).toBe('●●●○○');
    expect(screen.getByText(/마지막/).textContent).toContain('110,000.0');
    expect(screen.getByText(/스냅샷 2\.5시간 전/)).toBeTruthy();
  });

  it('split-buy paper status is 미보고 (the bot reports none) and the panel has not a single button or text input', async () => {
    const { container } = render(<SrPanel api={api()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(screen.getByTestId('sr-splitbuy').textContent).toContain('분할매수 페이퍼');
    expect(screen.getByTestId('sr-splitbuy').textContent).toContain('미보고');
    expect(container.querySelectorAll('button, input, textarea, a[href]').length).toBe(0);
    expect(container.querySelectorAll('select').length).toBe(1);
    expect(container.textContent).toContain('읽기 전용');
  });

  it('changing the symbol asks the server for that symbol and swaps the table', async () => {
    const a = api();
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('심볼'), { target: { value: 'ETHUSDT' } });
    await waitFor(() => expect(a.sr).toHaveBeenCalledWith('ETHUSDT'));
    await waitFor(() => expect(rows().length).toBe(1));
    expect(rows()[0]!.getAttribute('title')).toBe('tier=1');
    expect(a.klines).toHaveBeenLastCalledWith('ETHUSDT');
    fireEvent.change(screen.getByLabelText('심볼'), { target: { value: 'SOLUSDT' } });
    await waitFor(() => expect(screen.getByText('SOLUSDT: 스냅샷에 구간이 없어요.')).toBeTruthy());
  });

  it('switching symbols drops the old zones at once, so new candles never meet the previous symbol\'s bands', async () => {
    let release: (() => void) | null = null;
    const a = api({ sr: vi.fn(async (s: string | null) => { if (s === 'ETHUSDT') await new Promise<void>((r) => { release = r; }); return snap(s); }) });
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('심볼'), { target: { value: 'ETHUSDT' } });
    await waitFor(() => expect(screen.getByTestId('sr-chart')).toBeTruthy());
    expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('');
    expect(screen.queryByTestId('sr-table')).toBeNull();
    release!();
    await waitFor(() => expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('eth'));
  });

  it('without candles the table still shows, strongest first, with no distance', async () => {
    render(<SrPanel api={api({ klines: vi.fn(async () => { throw new Error('HTTP 503'); }) })} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(screen.queryByTestId('sr-chart')).toBeNull();
    expect(screen.getByText(/캔들을 받지 못했어요/)).toBeTruthy();
    expect(rows().map((tr) => tr.getAttribute('title'))).toEqual(['tier=5', 'tier=4', 'tier=3', 'tier=2']);
    expect(rows()[0]!.querySelector('.sr-dist')!.textContent).toBe('—');
  });

  it('a silent bot is one calm line, never a throw', async () => {
    const { container } = render(<SrPanel api={api({ sr: vi.fn(async () => { throw new Error('연결 실패'); }) })} now={NOW} />);
    await waitFor(() => expect(screen.getByText('SR 스냅샷 응답 없음')).toBeTruthy());
    expect(container.textContent).toContain('연결 실패');
    expect(container.textContent).not.toContain('Error');
    expect(screen.queryByTestId('sr-table')).toBeNull();
    expect((screen.getByLabelText('심볼') as HTMLSelectElement).disabled).toBe(true);
  });
});
