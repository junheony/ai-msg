// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UsageSheet } from './UsageSheet';
import { dailyStacks, fmtCost, fmtTokens, sumRows, weeklyRows } from './UsageView';
import type { UsageHistory, UsageRow } from '../../shared/token-usage';
import { emptyAccountUsage, type UsageSnapshot } from '../../shared/usage-types';

const row = (day: string, source: UsageRow['source'], family: UsageRow['family'], input: number, output: number, cacheRead = 0, cacheWrite = 0): UsageRow =>
  ({ day, source, family, input, output, cacheRead, cacheWrite, messages: 1 });

// 2026-10-02 is a Friday; its week starts Monday 2026-09-28.
const NOW = new Date(2026, 9, 2, 12);
const rows: UsageRow[] = [
  row('2026-10-02', 'all', 'opus', 1_000_000, 100_000, 9_000_000, 0),
  row('2026-10-02', 'a', 'opus', 1_000_000, 100_000, 9_000_000, 0),
  row('2026-09-29', 'all', 'gpt', 500_000, 0),
  row('2026-09-29', 'codex', 'gpt', 500_000, 0),
  row('2026-09-20', 'all', 'sonnet', 2_000_000, 0),
  row('2026-09-20', 'b', 'sonnet', 2_000_000, 0),
];

afterEach(cleanup);

describe('UsageView helpers', () => {
  it('formats and sums with family prices', () => {
    expect(fmtTokens(1_234_567_890)).toBe('1.23B');
    expect(fmtTokens(45_600)).toBe('45.6K');
    expect(fmtCost(1234.4)).toBe('$1,234');
    const today = sumRows(rows, 'all', (d) => d === '2026-10-02');
    // opus: 1M×$4 + 0.1M×$20 + 9M×$4×0.1 = 4 + 2 + 3.6
    expect(today.cost).toBeCloseTo(9.6);
    expect(weeklyRows(rows, 'all').map((w) => w.week)).toEqual(['2026-09-28', '2026-09-14']);
    const stacks = dailyStacks(rows, 'all', '2026-10-02', 30);
    expect(stacks).toHaveLength(30);
    expect(stacks.at(-1)).toMatchObject({ day: '2026-10-02', total: 10_100_000 });
  });
});

describe('usage sheet · history', () => {
  const usage: UsageSnapshot = { generatedAt: 'x', deckReachable: true, accounts: { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() } };
  it('renders totals, weekly table and chart; switches account; closes on Escape', async () => {
    const body: UsageHistory = { generatedAt: 'x', days: 84, lastScanAt: '2026-10-02T03:00:00Z', scanning: false, rows };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const onClose = vi.fn();
    render(<UsageSheet usage={usage} current={null} initialHistory onClose={onClose} fetchFn={fetchFn} now={NOW.getTime()} />);
    await waitFor(() => expect(screen.getByTestId('usage-weekly').textContent).toContain('2026-09-28 (이번 주)'));
    expect(screen.getByText('오늘').parentElement!.textContent).toContain('10.1M');
    expect(screen.getByText('이번 주').parentElement!.textContent).toContain('10.6M');
    expect(screen.getByText('30일').parentElement!.textContent).toContain('12.6M');
    expect(screen.getByTestId('usage-chart').querySelectorAll('rect.fam-opus')).toHaveLength(1);
    expect(screen.getByText('캐시 적중 90.0%')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByTestId('usage-weekly').textContent).toContain('2026-09-14');
    expect(screen.getByTestId('usage-weekly').textContent).not.toContain('이번 주');

    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/usage/history?days=84&refresh=1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('is a sheet: ↻ refreshes, ✕ closes, a backdrop press closes and a press in the card does not', async () => {
    const body: UsageHistory = { generatedAt: 'x', days: 84, lastScanAt: null, scanning: false, rows };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const onClose = vi.fn();
    render(<UsageSheet usage={usage} current={null} initialHistory onClose={onClose} fetchFn={fetchFn} now={NOW.getTime()} />);
    const close = screen.getByRole('button', { name: '닫기' });
    expect(close.textContent).toBe('✕');
    expect(close.getAttribute('title')).toBe('닫기 (Esc)');
    expect(document.activeElement).toBe(close);
    expect(screen.queryByRole('button', { name: '새로고침' })?.textContent).toBe('↻');
    await waitFor(() => expect((screen.getByRole('button', { name: '새로고침' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/usage/history?days=84&refresh=1'));

    const dialog = screen.getByRole('dialog', { name: '사용량' });
    fireEvent.mouseDown(dialog);
    fireEvent.mouseDown(screen.getByTestId('usage-weekly'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Esc yields to a popup opened over the sheet, an Esc already taken, a held key and IME', () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const onClose = vi.fn();
    render(<UsageSheet usage={usage} current={null} initialHistory onClose={onClose} fetchFn={fetchFn} now={NOW.getTime()} />);
    const over = document.body.appendChild(document.createElement('div'));
    over.setAttribute('role', 'dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    over.remove();
    const taken = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', taken, true);
    fireEvent.keyDown(window, { key: 'Escape' });
    window.removeEventListener('keydown', taken, true);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the error when the API fails', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    render(<UsageSheet usage={usage} current={null} initialHistory onClose={() => {}} fetchFn={fetchFn} now={NOW.getTime()} />);
    await waitFor(() => expect(screen.getByText('사용량을 불러오지 못했습니다 (500)')).toBeTruthy());
  });
});

describe('usage sheet · the 기록 toggle', () => {
  it('starts closed from the chip (no fetch), opens on 기록 and fetches; from settings it opens expanded', async () => {
    const usage: UsageSnapshot = { generatedAt: 'x', deckReachable: true, accounts: { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() } };
    const body: UsageHistory = { generatedAt: 'x', days: 84, lastScanAt: null, scanning: false, rows };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const { unmount } = render(<UsageSheet usage={usage} current={null} onClose={() => {}} fetchFn={fetchFn} now={NOW.getTime()} />);
    const toggle = screen.getByRole('button', { name: /토큰 사용량 기록/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('usage-weekly')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(screen.getByTestId('usage-weekly').textContent).toContain('2026-09-28 (이번 주)'));
    expect(document.querySelector('.sheet.usage-sheet')!.className).toContain('with-history');
    unmount();
    render(<UsageSheet usage={usage} current={null} initialHistory onClose={() => {}} fetchFn={fetchFn} now={NOW.getTime()} />);
    expect(screen.getByRole('button', { name: /토큰 사용량 기록/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('Tab wraps inside the sheet (focus trap)', () => {
    const usage: UsageSnapshot = { generatedAt: 'x', deckReachable: true, accounts: { a: emptyAccountUsage() } };
    render(<UsageSheet usage={usage} current={null} onClose={() => {}} now={NOW.getTime()} />);
    const close = screen.getByRole('button', { name: '닫기' });
    const toggle = screen.getByRole('button', { name: /토큰 사용량 기록/ });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(toggle);
    fireEvent.keyDown(toggle, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });
});
