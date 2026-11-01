// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { SrRange } from '../../../shared/sr-types';
import { SR_NOW, SR_ZONES, srCandles, srRoom, srSnap, srZone, SR_SYMBOLS } from '../../../test/srFixture';
import type { SrApi } from './api';
import { paperBadge, SrPanel, sortRows, visibleSymbols, SYMBOLS_SHOWN } from './SrPanel';

// The chart is a canvas library; the panel test only needs to see what it was asked to draw.
vi.mock('./SrChart', () => ({
  SrChart: (p: { candles: unknown[]; ranges: SrRange[] }) => <div data-testid="sr-chart" data-candles={p.candles.length} data-ranges={p.ranges.map((r) => r.id).join(',')} />,
}));

const NOW = SR_NOW;
function api(over: Partial<SrApi> = {}): SrApi {
  return { sr: vi.fn(async (s: string | null) => { if (s && !SR_SYMBOLS.includes(s)) throw new Error(`${s}: 스냅샷에 없는 심볼`); return srSnap(s); }), klines: vi.fn(async () => srCandles(110_000)), ...over };
}
const rows = () => within(screen.getByTestId('sr-table')).getAllByRole('row').slice(1);
const go = (hash: string) => act(() => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); });

beforeEach(() => { window.location.hash = ''; });
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

describe('sortRows / visibleSymbols / paperBadge', () => {
  it('nearest to the last close first, signed by side of price; strongest first when there is no price', () => {
    const btc = SR_ZONES.filter((z) => z.symbol === 'BTCUSDT');
    const byDist = sortRows(btc, 110_000);
    expect(byDist.map((x) => x.r.id)).toEqual(['near-sup', 'near-res', 'far-res', 'far-sup']);
    expect(byDist[0]!.dist).toBeCloseTo(-0.4545, 3);
    expect(byDist[0]!.hits).toEqual(['1h', '4h']);
    expect(sortRows(btc, null).map((x) => x.r.id)).toEqual(['far-res', 'far-sup', 'near-sup', 'near-res']);
  });
  it('shows the first dozen symbols plus the current one, or all after #sr-all', () => {
    const many = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}USDT`);
    const v = visibleSymbols(many, 'S25USDT', false);
    expect(v.shown.length).toBe(SYMBOLS_SHOWN + 1);
    expect(v.shown.at(-1)).toBe('S25USDT');
    expect(v.hidden).toBe(30 - SYMBOLS_SHOWN - 1);
    expect(visibleSymbols(many, null, true)).toEqual({ shown: many, hidden: 0 });
    expect(visibleSymbols(SR_SYMBOLS, 'ETHUSDT', false)).toEqual({ shown: SR_SYMBOLS, hidden: 0 });
  });
  it('the badge is a verdict on the reported flags: paper, unverified without a status feed, live-risk on a live flag', () => {
    expect(paperBadge(srSnap(null))).toMatchObject({ text: 'PAPER ONLY', tone: 'ok' });
    expect(paperBadge(srSnap(null, { room: null })).tone).toBe('warn');
    expect(paperBadge(null).text).toContain('상태 미확인');
    expect(paperBadge(srSnap(null, { room: srRoom({ paper: { ...srRoom().paper, adaptiveLive: true } }) })).tone).toBe('bad');
    expect(paperBadge(srSnap(null, { room: srRoom({ stage: 'live' }) })).tone).toBe('bad');
    expect(paperBadge(srSnap(null, { room: srRoom({ stage: null, paper: { ...srRoom().paper, adaptivePaperOnly: null } }) })).tone).toBe('warn');
  });
});

describe('SrPanel', () => {
  it('reads the unfiltered snapshot, then one symbol server-filtered: symbol links, chart with its zones, distance-sorted table', async () => {
    const a = api();
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(a.sr).toHaveBeenCalledWith(null);
    expect(a.sr).toHaveBeenCalledWith('BTCUSDT');
    expect(a.klines).toHaveBeenCalledWith('BTCUSDT');
    const nav = screen.getByRole('navigation', { name: '심볼' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['#sr=BTCUSDT', '#sr=ETHUSDT', '#sr=SOLUSDT']);
    expect(links[0]!.getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('far-res,near-sup,near-res,far-sup');
    expect(screen.getByTestId('sr-chart').dataset.candles).toBe('5');
    const r = rows();
    expect(r.map((tr) => tr.getAttribute('title'))).toEqual(['tier=3', 'tier=2', 'tier=5', 'tier=4']);
    expect(r[0]!.textContent).toContain('지지');
    expect(r[0]!.textContent).toContain('109,300.0 – 109,700.0');
    expect(r[0]!.textContent).toContain('−0.45%');
    expect(r[1]!.textContent).toContain('+0.91%');
    expect(r[0]!.querySelector('.sr-tier')!.textContent).toBe('●●●○○');
    expect(screen.getByText(/마지막/).textContent).toContain('110,000.0');
  });

  it('is links only: no button, select, input, details or iframe; the dashboard opens in a new tab; every time is KST', async () => {
    const { container } = render(<SrPanel api={api()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(container.querySelectorAll('button, input, select, textarea, form, details, summary, iframe, [contenteditable]').length).toBe(0);
    const out = container.querySelectorAll('a[target="_blank"]');
    expect(out.length).toBe(1);
    expect(out[0]!.getAttribute('rel')).toContain('noopener');
    expect(out[0]!.getAttribute('href')).toMatch(/^https:\/\/cursor\.com\/canvas\//);
    for (const a of container.querySelectorAll('a[href]')) expect(a.getAttribute('href')).toMatch(/^(#sr=[A-Z0-9]+|#sr-all|https:\/\/cursor\.com\/)/);
    const clock = screen.getByTestId('sr-clock').textContent!;
    expect(clock).toContain('스냅샷 2026-10-31 15:30 KST');
    expect(clock).toContain('룸 상태 2026-10-31 17:58 KST');
    expect(screen.getByTestId('sr-paper').textContent).toBe('PAPER ONLY');
    expect(container.textContent).toContain('출처 트레이딩룸 :8830');
    expect(container.textContent).toContain('읽기 전용');
  });

  it('shows the room\'s reported paper flags and metrics and says DCA fills are 미보고 instead of inventing them', async () => {
    const { container } = render(<SrPanel api={api()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-room')).toBeTruthy());
    const room = screen.getByTestId('sr-room').textContent!;
    expect(room).toContain('ok · paper');
    expect(room).toContain('adaptive 페이퍼 전용예');
    expect(room).toContain('adaptive 라이브아니오');
    expect(room).toContain('40종목');
    expect(room).toContain('SOL · LINK');
    expect(room).toContain('maker smoke rows low');
    expect(room).toContain('new_metric_rows3');
    expect(room).toContain('runs from …');
    const dca = screen.getByTestId('sr-dca').textContent!;
    expect(dca).toContain('분할매수(DCA) 체결 · 단계 미보고');
    expect(dca).toContain('stage paper');
    expect(dca).toContain('adaptive_paper_only true');
    expect(dca).toContain('maker paper');
    expect(dca).not.toMatch(/체결 \d|평단|회차 \d/);
    expect(container.textContent).not.toMatch(/knn|시나리오|확률|scenario|probab/i);
  });

  it('a symbol link changes the hash; the panel asks the server for that symbol and swaps the table', async () => {
    const a = api();
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    go('#sr=ETHUSDT');
    await waitFor(() => expect(a.sr).toHaveBeenCalledWith('ETHUSDT'));
    await waitFor(() => expect(rows().length).toBe(1));
    expect(rows()[0]!.getAttribute('title')).toBe('tier=1');
    expect(a.klines).toHaveBeenLastCalledWith('ETHUSDT');
    expect(within(screen.getByRole('navigation', { name: '심볼' })).getByText('ETHUSDT').getAttribute('aria-current')).toBe('true');
    go('#sr=solusdt');
    await waitFor(() => expect(screen.getByText('SOLUSDT: 스냅샷에 구간이 없어요.')).toBeTruthy());
    go('#sr=DOGEUSDT');
    await waitFor(() => expect(screen.getByText(/DOGEUSDT: 스냅샷에 없는 심볼/)).toBeTruthy());
    expect(a.sr).not.toHaveBeenCalledWith('DOGEUSDT');
  });

  it('switching symbols drops the old zones at once, so new candles never meet the previous symbol\'s bands', async () => {
    let release: (() => void) | null = null;
    const a = api({ sr: vi.fn(async (s: string | null) => { if (s === 'ETHUSDT') await new Promise<void>((r) => { release = r; }); return srSnap(s); }) });
    render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    go('#sr=ETHUSDT');
    await waitFor(() => expect(screen.getByTestId('sr-chart')).toBeTruthy());
    expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('');
    expect(screen.queryByTestId('sr-table')).toBeNull();
    release!();
    await waitFor(() => expect(screen.getByTestId('sr-chart').dataset.ranges).toBe('eth'));
  });

  it('a long symbol list is a dozen links plus the current one and a #sr-all link that opens the rest', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(2, '0')}USDT`);
    const a = api({ sr: vi.fn(async (s: string | null) => ({ ...srSnap(null, { symbols: many }), symbol: s, ranges: [], rangeCount: 0 })) });
    window.location.hash = '#sr=S25USDT';
    render(<SrPanel api={a} now={NOW} />);
    const nav = await screen.findByRole('navigation', { name: '심볼' });
    expect(within(nav).getAllByRole('link').length).toBe(SYMBOLS_SHOWN + 2);
    expect(within(nav).getByText(`+${30 - SYMBOLS_SHOWN - 1} 전체`).getAttribute('href')).toBe('#sr-all');
    go('#sr-all');
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: '심볼' })).getAllByRole('link').length).toBe(31));
  });

  it('without candles the table still shows, strongest first, with no distance', async () => {
    render(<SrPanel api={api({ klines: vi.fn(async () => { throw new Error('HTTP 503'); }) })} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(screen.queryByTestId('sr-chart')).toBeNull();
    expect(screen.getByText(/캔들을 받지 못했어요/)).toBeTruthy();
    expect(rows().map((tr) => tr.getAttribute('title'))).toEqual(['tier=5', 'tier=4', 'tier=3', 'tier=2']);
    expect(rows()[0]!.querySelector('.sr-dist')!.textContent).toBe('—');
  });

  it('status feed down: zones still show, the badge says 상태 미확인 and the room column says so — no stack, no guess', async () => {
    const a = api({ sr: vi.fn(async (s: string | null) => srSnap(s, { room: null })) });
    const { container } = render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(screen.getByTestId('sr-paper').textContent).toBe('PAPER ONLY · 상태 미확인');
    expect(container.textContent).toContain('룸 상태(/api/status) 응답 없음');
    expect(container.textContent).toContain('시간 초과');
    expect(container.textContent).toContain('룸 상태 미보고');
    expect(screen.getByTestId('sr-dca').textContent).toContain('미보고');
    expect(screen.getByTestId('sr-clock').textContent).toContain('룸 상태 — 미보고');
  });

  it('SR feed down but status up: no symbols, no table, the room\'s flags still read', async () => {
    const a = api({ sr: vi.fn(async (s: string | null) => ({ ...srSnap(s, { srOk: false }), symbols: [], ranges: [], rangeCount: 0, snapshotAt: null, ageHours: null })) });
    const { container } = render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-room')).toBeTruthy());
    expect(container.textContent).toContain('SR 스냅샷 응답 없음');
    expect(screen.queryByRole('navigation', { name: '심볼' })).toBeNull();
    expect(screen.queryByTestId('sr-table')).toBeNull();
    expect(screen.getByTestId('sr-paper').textContent).toBe('PAPER ONLY');
  });

  it('the next poll refreshes the selected symbol\'s zones without a symbol change: new ranges reach the chart and the table', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const added = srZone('new-sup', 'BTCUSDT', 'support', 109_900, 109_950, 4);
      const a = api({ sr: vi.fn(async (s: string | null) => { if (s === null) polls += 1; const snap = srSnap(s); return polls > 1 ? { ...snap, snapshotAt: '2026-10-31T08:30:00Z', ranges: [...snap.ranges, added], rangeCount: snap.rangeCount + 1 } : snap; }) });
      render(<SrPanel api={a} now={NOW} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(rows().length).toBe(4);
      expect(screen.getByTestId('sr-clock').textContent).toContain('스냅샷 2026-10-31 15:30 KST');
      expect((a.sr as ReturnType<typeof vi.fn>).mock.calls.filter(([s]) => s === 'BTCUSDT').length).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(polls).toBe(2);
      expect((a.sr as ReturnType<typeof vi.fn>).mock.calls.filter(([s]) => s === 'BTCUSDT').length).toBe(2);
      expect(screen.getByTestId('sr-clock').textContent).toContain('스냅샷 2026-10-31 17:30 KST');
      expect(rows().length).toBe(5);
      expect(rows()[0]!.textContent).toContain('109,900.0 – 109,950.0');
      expect(screen.getByTestId('sr-chart').dataset.ranges).toContain('new-sup');
      expect(a.klines).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('sr-client-stale')).toBeNull();
      expect(screen.queryByTestId('sr-zones-stale')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a failed poll keeps the zones and shows a client stale band; a failed zone refresh keeps the previous zones and says so', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0, zoneReads = 0;
      const a = api({ sr: vi.fn(async (s: string | null) => {
        if (s === null) { if (++polls === 2) throw new Error('연결 실패'); return srSnap(null); }
        if (++zoneReads === 2) throw new Error('구간 시간 초과');
        return srSnap(s);
      }) });
      const { container } = render(<SrPanel api={a} now={NOW} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(rows().length).toBe(4);
      // poll 2 fails: the unfiltered snapshot is kept, the band says so, the zones are not re-read (nothing new to read)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('sr-client-stale').textContent).toContain('연결 실패');
      expect(rows().length).toBe(4);
      expect(zoneReads).toBe(1);
      // poll 3 succeeds, the zone refresh fails: previous zones stay, with their own band
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId('sr-client-stale')).toBeNull();
      expect(zoneReads).toBe(2);
      expect(rows().length).toBe(4);
      expect(screen.getByTestId('sr-zones-stale').textContent).toContain('BTCUSDT 구간 갱신 실패 · 이전 값 표시 중');
      expect(screen.getByTestId('sr-zones-stale').textContent).toContain('구간 시간 초과');
      // poll 4 and its zone read succeed: both bands go
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId('sr-zones-stale')).toBeNull();
      expect(container.querySelectorAll('button, select, input').length).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('a stale SR feed keeps the last zones and says so with the last-good time in KST', async () => {
    const a = api({ sr: vi.fn(async (s: string | null) => srSnap(s, { srStale: true })) });
    const { container } = render(<SrPanel api={a} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('sr-table')).toBeTruthy());
    expect(container.textContent).toContain('SR 스냅샷 이전 값 표시 중');
    expect(container.textContent).toContain('마지막 정상 2026-10-31 17:59 KST');
  });

  it('a silent server is one calm line, never a throw', async () => {
    const { container } = render(<SrPanel api={api({ sr: vi.fn(async () => { throw new Error('연결 실패'); }) })} now={NOW} />);
    await waitFor(() => expect(screen.getByText('SR 스냅샷 응답 없음')).toBeTruthy());
    expect(container.textContent).toContain('연결 실패');
    expect(container.textContent).not.toContain('Error');
    expect(screen.queryByTestId('sr-table')).toBeNull();
    expect(container.querySelectorAll('button, select, input').length).toBe(0);
  });
});
