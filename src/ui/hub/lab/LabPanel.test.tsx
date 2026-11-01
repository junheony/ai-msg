// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { mapLab } from '../../../server/hub/lab';
import type { LabResponse, LabSnapshot } from '../../../shared/lab-types';
import { labFixture, LAB_NOW } from '../../../test/labFixture';
import { LabPanel } from './LabPanel';
const answer = (snapshot: LabSnapshot | null = mapLab(labFixture()), extra: Partial<LabResponse> = {}): LabResponse => ({ snapshot, state: 'ok', stale: false, ageSeconds: 0, failures: 0, error: null, lastSuccessAt: '2026-11-01T08:00:00Z', ...extra });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('LabPanel', () => {
  it('shows real book PnL, positions, trades, certification evidence, shortened root and KST without controls', async () => {
    const { container } = render(<LabPanel api={{ summary: async () => answer() }} now={LAB_NOW} />);
    await screen.findByText('60,170');
    expect(container.textContent).toContain('+272.86 USDT'); expect(container.textContent).toContain('-102.48 USDT');
    expect(container.textContent).toContain('2026-11-01 17:00:00 KST'); expect(container.textContent).toContain('PAPER ONLY · LIVE OFF'); expect(container.textContent).toContain('출처 트레이딩 ver2 · :8792');
    expect(container.textContent).toContain('bbbbbbbbbbbb…'); expect(container.textContent).not.toContain('b'.repeat(64));
    expect(screen.getByRole('progressbar', { name: '인증 가능 청산' }).getAttribute('value')).toBe('3');
    expect(screen.getByRole('progressbar', { name: '기록 기간' }).getAttribute('max')).toBe('90');
    expect(within(screen.getByRole('region', { name: '열린 모의 포지션' })).getByText('LINK')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '최근 청산' })).getByText('SOL')).toBeTruthy();
    expect(container.querySelectorAll('button,input,select,textarea,a,form')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/시나리오|probability|승률/);
  });
  it('shows null as unreported or a source-specific error, not zero; unrelated fields remain readable', async () => {
    const body = labFixture();
    const mapped = mapLab({ ...body, errors: ['ledger_stats: timeout'], books: [{ ...body.books[0], equity: null }], ledger: { ...body.ledger, certifiable_closed_trades: null, all_pass: null, expectancy: { ci95_lower: null, reason: '표본 부족' } } });
    const { container } = render(<LabPanel api={{ summary: async () => answer(mapped) }} now={LAB_NOW} />);
    await screen.findByText('표본 부족');
    expect(screen.getAllByLabelText('미보고').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('오류: ledger_stats: timeout').every(node => node.textContent?.includes('—'))).toBe(true);
    expect(screen.queryByRole('progressbar', { name: '인증 가능 청산' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: '기록 기간' }).getAttribute('value')).toBe('0.9');
    expect(container.textContent).not.toContain('0 / 100');
    expect(container.textContent).toContain('+272.86 USDT');
  });
  it('does not imply empty trades or positions when a source is unavailable', async () => {
    const mapped = mapLab({ ...labFixture(), books: null, recent_closed_trades: null, errors: ['paper_state: timeout', 'paper_trades: timeout'] });
    const { container } = render(<LabPanel api={{ summary: async () => answer(mapped) }} now={LAB_NOW} />);
    await screen.findByText('전략 북');
    expect(container.textContent).not.toContain('열린 포지션 없음'); expect(container.textContent).not.toContain('최근 청산 없음');
    expect(screen.getByLabelText('오류: paper_trades: timeout')).toBeTruthy();
  });
  it('puts failed verification first, keeps the last snapshot gray offline, and displays stale at exactly 90s', async () => {
    const s = mapLab({ ...labFixture(), verify: { ...labFixture().verify, ok: false, msg: 'broken chain' } });
    const { container } = render(<LabPanel api={{ summary: async () => answer(s, { state: 'verify-failed', failures: 3, error: '시간 초과', stale: true }) }} now={LAB_NOW + 90_000} />);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toBe('원장 검증 실패: broken chain');
    expect(container.querySelector('.lab-body')?.firstElementChild).toBe(alert);
    expect(screen.getByTestId('lab-panel').className).toContain('lab-offline');
    expect(screen.getByText('STALE (90초 전)')).toBeTruthy();
    expect(container.textContent).toContain('오프라인 · 마지막 갱신 2026-11-01 17:00:00 KST');
    expect(container.textContent).not.toContain('ssh');
  });
  it('polls once per minute after completion, clears previous positions on loading, and stops on unmount', async () => {
    vi.useFakeTimers();
    const summary = vi.fn().mockResolvedValueOnce(answer()).mockResolvedValue(answer(mapLab({ ...labFixture(), books: [] }), { state: 'loading' }));
    const { unmount } = render(<LabPanel api={{ summary }} now={LAB_NOW} />);
    await act(async () => { await Promise.resolve(); }); expect(summary).toHaveBeenCalledTimes(1);
    expect(screen.getByText('LINK')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); }); expect(summary).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('엔진 준비 중(1~2분)')).toBeTruthy(); expect(screen.queryByText('LINK')).toBeNull();
    unmount(); await vi.advanceTimersByTimeAsync(180_000); expect(summary).toHaveBeenCalledTimes(2);
  });
  it('preserves the last response when MSG itself fails and only labels offline after three failures', async () => {
    vi.useFakeTimers();
    const summary = vi.fn().mockResolvedValueOnce(answer()).mockRejectedValue(new Error('fetch failed'));
    render(<LabPanel api={{ summary }} now={LAB_NOW} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText('60,170')).toBeTruthy(); expect(screen.getByTestId('lab-panel').className).not.toContain('lab-offline');
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(screen.getByTestId('lab-panel').className).toContain('lab-offline'); expect(summary).toHaveBeenCalledTimes(4);
  });
  it('renders unknown future fields generically as text, never as links or markup, and never a kNN/scenario word', async () => {
    const body = labFixture() as Record<string, unknown>;
    const mapped = mapLab({
      ...body,
      books: [{ ...labFixture().books[0], strategy: 'vwap_rev', cash_start: 50000, targets: { daily_r: 0.5, criteria: ['pf >= 1.3', 'see <a href="http://x">x</a>'] } }],
      runtime: { hit_rate: 0.93, note: 'see https://evil.example/x now' },
      cache: { ttl_s: 15, upstream_timeout_s: 3 },
      backtests: { strategies: [{ id: 'zzz_4h', metrics: { sharpe: 1.42, by_tf: { '4h': { trades: 12 } } } }] },
      knn_forecast: { up_prob: 0.7 }, forecast: { scenario_probabilities: [0.2, 0.8], horizon: '4h' },
    });
    const { container } = render(<LabPanel api={{ summary: async () => answer(mapped) }} now={LAB_NOW} />);
    await screen.findByText('60,170');
    const extra = screen.getByTestId('lab-extra');
    expect(extra.textContent).toContain('hit_rate');
    expect(extra.textContent).toContain('0.93');
    expect(extra.textContent).toContain('see … now');
    expect(extra.textContent).toContain('horizon');
    expect(extra.textContent).toContain('4h');
    // a nested future backtest result is drawn down to its metrics; the feed's cache metadata is not strategy content
    expect(extra.textContent).toContain('sharpe');
    expect(extra.textContent).toContain('1.42');
    expect(extra.textContent).toContain('trades');
    expect(extra.textContent).toContain('12');
    expect(extra.textContent).not.toContain('ttl_s');
    expect(extra.textContent).not.toContain('upstream_timeout_s');
    const book = screen.getByTestId('lab-book-extra');
    expect(book.textContent).toContain('vwap_rev');
    expect(book.textContent).toContain('50,000');
    expect(book.textContent).toContain('pf >= 1.3');
    expect(book.textContent).toContain('see … plain'.replace(' plain', ''));
    expect(container.querySelectorAll('a, button, input, select, iframe, script').length).toBe(0);
    expect(container.innerHTML).not.toContain('evil.example');
    expect(container.innerHTML).not.toContain('<a href');
    expect(container.textContent).not.toMatch(/knn|scenario|probab|시나리오|확률|up_prob|0\.7\b/i);
  });
  it('shows a calm missing state without a prior snapshot', async () => {
    render(<LabPanel api={{ summary: async () => answer(null, { state: 'error', error: '연결 실패', failures: 1 }) }} now={LAB_NOW} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('요약 미보고'));
    expect(screen.queryByTestId('lab-books')).toBeNull();
  });
});
