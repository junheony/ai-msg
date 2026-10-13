// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HighlightsBadge, ServerChip, WorkStatus, idleLabel, uptimeLabel } from './WorkStatus';

const M = 60_000;
const ok = (n: number) => new Response(JSON.stringify({ hours: 24, events: Array.from({ length: n }, (_, i) => ({ at: i })) }), { status: 200 });
const badgeText = () => screen.getByTestId('hl-badge').querySelector('.hl-badge-long')!.textContent;
/** Lets pending fetch promises (and the state they set) settle. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('labels', () => {
  it('idleLabel: 한가함, with the last work end time when known', () => {
    expect(idleLabel(null)).toBe('한가함');
    expect(idleLabel(new Date(2026, 9, 13, 14, 2).getTime())).toBe('한가함 · 14:02 까지 작업');
  });

  it('uptimeLabel: 방금 시작 / 분 / 시간 / 일', () => {
    expect(uptimeLabel(30_000)).toBe('서버 · 방금 시작');
    expect(uptimeLabel(-5)).toBe('서버 · 방금 시작');
    expect(uptimeLabel(5 * M)).toBe('서버 · 5분째');
    expect(uptimeLabel(3 * 60 * M + 59 * M)).toBe('서버 · 3시간째');
    expect(uptimeLabel(50 * 60 * M)).toBe('서버 · 2일째');
  });
});

describe('WorkStatus idle chip', () => {
  const props = { waiting: [], titleOf: (id: string) => id, onOpen: () => {} };
  const run = { sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 0, forMs: 0 };

  it('shows 한가함 from the start, and the end time once this tab saw work end', () => {
    const { rerender } = render(<WorkStatus {...props} activity={[]} />);
    const chip = screen.getByTestId('work-chip');
    expect(chip.querySelector('.chip-long')!.textContent).toBe('한가함');
    expect(chip.querySelector('.chip-short')!.textContent).toBe('한가함');
    rerender(<WorkStatus {...props} activity={[run]} />);
    expect(chip.classList.contains('idle')).toBe(false);
    rerender(<WorkStatus {...props} activity={[]} />);
    expect(chip.classList.contains('idle')).toBe(true);
    expect(chip.querySelector('.chip-long')!.textContent).toMatch(/^한가함 · \d\d:\d\d 까지 작업$/);
  });

  it('the idle popover offers 새 대화', () => {
    const onNewChat = vi.fn();
    render(<WorkStatus {...props} activity={[]} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByTestId('work-chip'));
    expect(screen.getByText('지금 실행 중인 작업이 없어요')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '새 대화' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: '작업 현황' })).toBeNull();
  });
});

describe('ServerChip', () => {
  const base = { restartedAt: null, draining: false, busy: 0, onDismissRestart: () => {} };

  it('uptime ticks by the minute; the uptime form is the one narrow bars hide (class)', () => {
    vi.useFakeTimers();
    render(<ServerChip {...base} startedAt={Date.now() - 59 * M} />);
    const chip = screen.getByTestId('server-chip');
    expect(chip.textContent).toBe('서버 · 59분째');
    expect(chip.classList.contains('server-uptime')).toBe(true);
    act(() => { vi.advanceTimersByTime(M); });
    expect(chip.textContent).toBe('서버 · 1시간째');
  });

  it('no start time → nothing, unless draining', () => {
    const { container, rerender } = render(<ServerChip {...base} startedAt={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<ServerChip {...base} startedAt={null} draining busy={0} />);
    expect(screen.getByRole('status').querySelector('.chip-long')!.textContent).toBe('재시작 중…');
  });

  it('재시작됨 HH:MM: a click dismisses; it is not the uptime form (stays on narrow bars)', () => {
    const onDismissRestart = vi.fn();
    render(<ServerChip {...base} startedAt={1} restartedAt={new Date(2026, 9, 13, 9, 5).getTime()} onDismissRestart={onDismissRestart} />);
    const btn = screen.getByText('재시작됨 09:05');
    expect(btn.classList.contains('server-uptime')).toBe(false);
    fireEvent.click(btn);
    expect(onDismissRestart).toHaveBeenCalledOnce();
  });
});

describe('HighlightsBadge', () => {
  const asks = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => u === '/api/highlights?hours=24').length;

  it('waits for the connection, then asks every 5 minutes; 0 shows just 하이라이트', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok(0));
    const { rerender } = render(<HighlightsBadge ready={false} running={0} onOpen={() => {}} fetchFn={f as unknown as typeof fetch} />);
    expect(asks(f)).toBe(0);
    rerender(<HighlightsBadge ready running={0} onOpen={() => {}} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    expect(asks(f)).toBe(1);
    expect(badgeText()).toBe('하이라이트');
    expect(screen.getByTestId('hl-badge').querySelector('.hl-badge-short')!.textContent).toBe('✦');
    act(() => { vi.advanceTimersByTime(5 * M); });
    expect(asks(f)).toBe(2);
  });

  it('a turn ending (running drops) asks 2s later, once for several; a rise does not ask', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok(3));
    const fetchFn = f as unknown as typeof fetch;
    const { rerender } = render(<HighlightsBadge ready running={2} onOpen={() => {}} fetchFn={fetchFn} />);
    await flush();
    expect(asks(f)).toBe(1);
    rerender(<HighlightsBadge ready running={3} onOpen={() => {}} fetchFn={fetchFn} />);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(asks(f)).toBe(1);
    rerender(<HighlightsBadge ready running={2} onOpen={() => {}} fetchFn={fetchFn} />);
    act(() => { vi.advanceTimersByTime(1_000); });
    rerender(<HighlightsBadge ready running={1} onOpen={() => {}} fetchFn={fetchFn} />);
    act(() => { vi.advanceTimersByTime(1_999); });
    expect(asks(f)).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(asks(f)).toBe(2);
  });

  it('a failed ask keeps the number; a stale answer does not overwrite a newer one; click opens', async () => {
    vi.useFakeTimers();
    let release: (r: Response) => void = () => {};
    const f = vi.fn()
      .mockResolvedValueOnce(ok(4))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
      .mockResolvedValueOnce(ok(7));
    const onOpen = vi.fn();
    render(<HighlightsBadge ready running={0} onOpen={onOpen} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    expect(badgeText()).toBe('하이라이트 4');
    act(() => { vi.advanceTimersByTime(5 * M); });
    await flush();
    act(() => { vi.advanceTimersByTime(5 * M); });
    await flush();
    expect(badgeText()).toBe('하이라이트 4');
    act(() => { vi.advanceTimersByTime(5 * M); }); // slow ask
    act(() => { vi.advanceTimersByTime(5 * M); }); // newer ask lands first
    await flush();
    expect(badgeText()).toBe('하이라이트 7');
    release(ok(1));
    await flush();
    expect(badgeText()).toBe('하이라이트 7');
    fireEvent.click(screen.getByTestId('hl-badge'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
