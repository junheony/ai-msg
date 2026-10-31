// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReplayCandle } from '../../../shared/replay-types';
import { REPLAY_INTERVAL_MS } from '../../../shared/replay-types';
import type { ReplayApi } from './api';
import { DEFAULT_REPLAY_PREFS, HISTORY_KEY, PREFS_KEY, type ReplaySession } from './history';
import { planAt, snapToInterval, startIndexFor, TAIL } from './scene';
import { pnlPct } from './scoring';
import { ReplayTrainer } from './ReplayTrainer';

// The chart is a canvas library; the trainer test only needs to see what it was asked to draw.
vi.mock('./ReplayChart', () => ({
  ReplayChart: (p: { visibleEnd: number; hidePrice: boolean; hideDate: boolean; markers: unknown[]; indicators: string[] }) => (
    <div data-testid="replay-chart" data-visible-end={p.visibleEnd} data-hide-price={String(p.hidePrice)} data-hide-date={String(p.hideDate)} data-markers={p.markers.length} data-ind={p.indicators.join(',')} />
  ),
  precisionOf: () => 2,
  fmtFull: { format: (d: Date) => d.toISOString() },
}));

const MS = REPLAY_INTERVAL_MS['15m'];
const EARLIEST = Date.parse('2020-01-01T00:00:00Z');
const NOW = Date.parse('2026-10-30T12:00:00Z');

/** Deterministic candles: close climbs 1 per candle, so a long over h candles is +h/entry. */
function candlesEndingAt(endTime: number, limit: number): ReplayCandle[] {
  const lastOpen = Math.floor(endTime / MS) * MS;
  const out: ReplayCandle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const t = lastOpen - i * MS;
    const c = 1000 + (t - EARLIEST) / MS;
    out.push({ t, o: c - 0.5, h: c + 1, l: c - 1, c, v: 10, q: 10 * c, tb: 6 });
  }
  return out;
}

function makeApi(over: Partial<ReplayApi> = {}) {
  const api: ReplayApi = {
    klines: vi.fn(async (q) => ({ source: 'binance' as const, market: q.market, symbol: q.symbol, interval: q.interval, candles: candlesEndingAt(q.endTime ?? NOW, q.limit) })),
    earliest: vi.fn(async () => EARLIEST),
    oi: vi.fn(async (symbol) => ({ symbol, period: '15m', points: [] })),
    funding: vi.fn(async (symbol) => ({ symbol, points: [] })),
    symbols: vi.fn(async () => ['BTCUSDT', 'ETHUSDT']),
    ...over,
  };
  return api;
}

const setPrefs = (p: Partial<typeof DEFAULT_REPLAY_PREFS>) => localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_REPLAY_PREFS, ...p }));
const visibleEnd = () => Number(screen.getByTestId('replay-chart').getAttribute('data-visible-end'));
const open = async (api: ReplayApi, extra: { random?: () => number } = {}) => {
  const r = render(<ReplayTrainer api={api} now={() => NOW} random={extra.random ?? (() => 0.5)} />);
  fireEvent.click(screen.getByTestId('replay-start'));
  await waitFor(() => expect(screen.queryByTestId('replay-chart')).not.toBeNull());
  return r;
};

beforeEach(() => { localStorage.removeItem(HISTORY_KEY); setPrefs({ market: 'spot', interval: '15m', horizon: 3, rounds: 5, indicators: ['ema20'] }); });
afterEach(cleanup);

describe('ReplayTrainer', () => {
  it('is read-only: no order, buy or sell controls anywhere, and says so', () => {
    render(<ReplayTrainer api={makeApi()} now={() => NOW} />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const l of labels) expect(l).not.toMatch(/주문|매수|매도|체결|order|buy|sell/i);
    expect(screen.getByTestId('replay-trainer').textContent).toContain('실제 주문 없음');
    expect(screen.getByTestId('replay-empty')).toBeTruthy();
  });

  it('asks for exactly the planned window and opens with the future hidden', async () => {
    const api = makeApi();
    await open(api);
    const plan = planAt(0, '15m', 3, 5);
    const q = (api.klines as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { endTime: number; limit: number; symbol: string; market: string };
    expect(q.limit).toBe(plan.limit);
    expect(q.symbol).toBe('BTCUSDT');
    expect(q.market).toBe('spot');
    expect((q.endTime + 1) % MS).toBe(0); // ends on a candle boundary
    expect(visibleEnd()).toBe(startIndexFor(plan.limit, 3, 5));
    expect(visibleEnd()).toBe(plan.startIndex);
    const chart = screen.getByTestId('replay-chart');
    expect(chart.getAttribute('data-hide-price')).toBe('true');
    expect(chart.getAttribute('data-hide-date')).toBe('true');
    expect(api.oi).not.toHaveBeenCalled();
    expect(api.funding).not.toHaveBeenCalled();
  });

  it('reveals the horizon on each call, scores it, and files the session after the last round', async () => {
    const api = makeApi();
    await open(api);
    const start = visibleEnd();
    fireEvent.click(screen.getByTestId('call-long'));
    expect(visibleEnd()).toBe(start + 3);
    const rows = () => Array.from(screen.getByTestId('replay-rounds').querySelectorAll('li:not(.none)'));
    expect(rows().length).toBe(1);
    // closes rise by 1 per candle: long over 3 candles from the entry close
    const r1 = rows()[0]!;
    expect(r1.textContent).toContain('롱');
    expect(r1.textContent).toMatch(/\+0\.\d+%/);
    expect(screen.getByTestId('replay-chart').getAttribute('data-markers')).toBe('2');

    fireEvent.click(screen.getByTestId('call-short'));
    expect(rows()[1]!.textContent).toMatch(/−0\.\d+%/);
    fireEvent.click(screen.getByTestId('call-skip'));
    expect(rows()[2]!.textContent).toContain('건너뜀');
    expect(rows()[2]!.textContent).toContain('—');
    expect(screen.getByTestId('replay-chart').getAttribute('data-markers')).toBe('4'); // skips leave no marker
    fireEvent.click(screen.getByTestId('call-long'));
    expect(screen.queryByTestId('replay-result')).toBeNull();
    fireEvent.click(screen.getByTestId('call-long'));

    // done: everything revealed, result panel up, session saved
    const result = screen.getByTestId('replay-result');
    expect(result.textContent).toContain('이 브라우저에 저장됨');
    const chart = screen.getByTestId('replay-chart');
    expect(chart.getAttribute('data-hide-price')).toBe('false');
    expect(chart.getAttribute('data-hide-date')).toBe('false');
    const limit = planAt(0, '15m', 3, 5).limit;
    expect(visibleEnd()).toBe(limit - 1);
    expect((screen.getByTestId('call-long') as HTMLButtonElement).disabled).toBe(true);

    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY)!) as ReplaySession[];
    expect(saved.length).toBe(1);
    const s = saved[0]!;
    expect(s.symbol).toBe('BTCUSDT');
    expect(s.rounds.length).toBe(5);
    expect(s.rounds.map((r) => r.dir)).toEqual(['long', 'short', 'skip', 'long', 'long']);
    expect(s.rounds[2]!.pnlPct).toBeNull();
    expect(s.rounds[4]!.exitIndex).toBe(limit - 1 - TAIL);
    for (const r of s.rounds) {
      expect(r.exitIndex - r.entryIndex).toBe(3);
      if (r.dir !== 'skip') expect(r.pnlPct).toBeCloseTo(pnlPct(r.dir, r.entry, r.exit)!, 10);
    }
    expect(s.summary.trades).toBe(4);
    expect(s.summary.wins).toBe(3);
    expect(s.summary.skips).toBe(1);
    expect(screen.getByRole('button', { name: /연습 기록 1/ })).toBeTruthy();
  });

  it('takes L / S / N from the keyboard while playing, not while typing', async () => {
    await open(makeApi());
    const start = visibleEnd();
    fireEvent.keyDown(window, { key: 'l' });
    expect(visibleEnd()).toBe(start + 3);
    fireEvent.keyDown(window, { key: 'S' });
    expect(visibleEnd()).toBe(start + 6);
    fireEvent.keyDown(screen.getByLabelText('심볼'), { key: 'n' });
    expect(visibleEnd()).toBe(start + 6);
    fireEvent.keyDown(window, { key: 'n' });
    expect(visibleEnd()).toBe(start + 9);
  });

  it('snaps a chosen start to the candle grid and skips the earliest lookup', async () => {
    const api = makeApi();
    render(<ReplayTrainer api={api} now={() => NOW} />);
    fireEvent.change(screen.getByLabelText('시작 시점 (비우면 무작위)'), { target: { value: '2025-03-01T10:07' } });
    fireEvent.click(screen.getByTestId('replay-start'));
    await waitFor(() => expect(screen.queryByTestId('replay-chart')).not.toBeNull());
    expect(api.earliest).not.toHaveBeenCalled();
    const q = (api.klines as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { endTime: number };
    expect(q.endTime).toBe(planAt(snapToInterval(Date.parse('2025-03-01T10:07'), '15m'), '15m', 3, 5).endTime);
  });

  it('shows the server message when a scene cannot be loaded and stays usable', async () => {
    const api = makeApi({ klines: vi.fn(async () => { throw new Error('거래소에 닿지 않아요'); }) });
    render(<ReplayTrainer api={api} now={() => NOW} />);
    fireEvent.click(screen.getByTestId('replay-start'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('거래소에 닿지 않아요'));
    expect(screen.queryByTestId('replay-chart')).toBeNull();
    expect((screen.getByTestId('replay-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fetches open interest and funding only for futures scenes with those overlays on', async () => {
    setPrefs({ market: 'futures', interval: '15m', horizon: 3, rounds: 5, indicators: ['oi', 'funding'] });
    const api = makeApi();
    render(<ReplayTrainer api={api} now={() => NOW} />);
    // a scene straddling the 29-day line: open interest is clamped to Binance's window, funding gets the whole span
    fireEvent.change(screen.getByLabelText('시작 시점 (비우면 무작위)'), { target: { value: '2026-10-02T09:00' } });
    fireEvent.click(screen.getByTestId('replay-start'));
    await waitFor(() => expect(screen.queryByTestId('replay-chart')).not.toBeNull());
    await waitFor(() => expect(api.oi).toHaveBeenCalledTimes(1));
    const q = (api.klines as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { endTime: number };
    const lastOpen = Math.floor(q.endTime / MS) * MS;
    const [sym, period, from, to] = (api.oi as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, number, number];
    expect(sym).toBe('BTCUSDT');
    expect(period).toBe('15m');
    expect(to).toBe(lastOpen);
    expect(lastOpen - (planAt(0, '15m', 3, 5).limit - 1) * MS).toBeLessThan(NOW - 29 * 86_400_000); // the scene really starts before the window
    expect(from).toBe(NOW - 29 * 86_400_000);
    expect(api.funding).toHaveBeenCalledTimes(1);
    const [, fFrom, fTo] = (api.funding as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, number];
    expect(fTo - fFrom).toBe((planAt(0, '15m', 3, 5).limit - 1) * MS);
    expect(screen.getByTestId('replay-chart').getAttribute('data-ind')).toBe('oi,funding');
  });

  it('skips the open-interest call when the whole scene is older than Binance keeps', async () => {
    setPrefs({ market: 'futures', interval: '15m', horizon: 3, rounds: 5, indicators: ['oi'] });
    const api = makeApi();
    await open(api); // random start lands in 2023
    await waitFor(() => expect(screen.queryByTestId('replay-chart')).not.toBeNull());
    await act(async () => {});
    expect(api.oi).not.toHaveBeenCalled();
  });

  it('drops futures-only overlays when switching to spot and remembers settings', async () => {
    setPrefs({ market: 'futures', indicators: ['ema20', 'oi'] });
    render(<ReplayTrainer api={makeApi()} now={() => NOW} />);
    expect(screen.getByTestId('ind-oi').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '현물' }));
    expect(screen.queryByTestId('ind-oi')).toBeNull();
    fireEvent.click(screen.getByTestId('ind-rsi'));
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY)!) as typeof DEFAULT_REPLAY_PREFS;
    expect(prefs.market).toBe('spot');
    expect(prefs.indicators).toEqual(['ema20', 'rsi']);
  });

  it('rejects a malformed symbol before calling anything', async () => {
    const api = makeApi();
    render(<ReplayTrainer api={api} now={() => NOW} />);
    fireEvent.change(screen.getByLabelText('심볼'), { target: { value: 'btc' } });
    fireEvent.click(screen.getByTestId('replay-start'));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('심볼');
    expect(api.klines).not.toHaveBeenCalled();
  });
});
