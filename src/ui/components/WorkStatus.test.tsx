// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HighlightsBadge, ServerChip, ServerUpdateChip, WorkStatus, idleLabel, restartConfirmText, uptimeLabel } from './WorkStatus';
import type { SessionActivity } from '../../shared/protocol';

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

  it('draining: a click lists the sessions it waits for (status, task titles); a row opens it; Esc and outside clicks close', () => {
    const onOpen = vi.fn();
    const activity = [
      { sessionId: 's1', cwd: '/w/alpha', turnId: 't1', running: true, bg: 0, forMs: 0 },
      { sessionId: 's2', cwd: '/w/beta', turnId: 't2', running: false, bg: 2, forMs: 0, tasks: ['npm run dev', 'sleep 20'] },
      { sessionId: 's3', cwd: '/w/idle', turnId: 't3', running: false, bg: 0, forMs: 0 },
    ];
    render(<ServerChip {...base} startedAt={1} draining busy={2} activity={activity} titleOf={(id) => (id === 's1' ? '첫 세션' : `t-${id}`)} onOpen={onOpen} />);
    const chip = screen.getByRole('button', { name: /재시작 대기 중/ });
    expect(chip.getAttribute('title')).toBe('서버가 재시작을 준비 중입니다 — 돌고 있는 작업이 끝나면 다시 시작합니다');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const pop = screen.getByRole('dialog', { name: '재시작이 기다리는 작업' });
    expect(pop.textContent).toContain('첫 세션');
    expect(pop.textContent).toContain('턴 진행 중');
    expect(pop.textContent).toContain('백그라운드 작업 2개');
    expect(pop.textContent).toContain('npm run dev');
    expect(pop.textContent).toContain('sleep 20');
    expect(pop.textContent).not.toContain('t-s3');
    // Esc closes; an outside click closes.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(chip);
    fireEvent.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A row opens its session and closes the list.
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: /t-s2/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2', cwd: '/w/beta', title: 't-s2' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('HighlightsBadge', () => {
  const asks = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => u === '/api/highlights?hours=24').length;

  it('counts outcomes, not background task events', async () => {
    const list = [{ at: 1, kind: 'turn' }, { at: 2, kind: 'task' }, { at: 3, kind: 'task' }, { at: 4, kind: 'interrupted' }, { at: 5, kind: 'permission' }];
    const f = vi.fn(async () => new Response(JSON.stringify({ hours: 24, events: list }), { status: 200 }));
    render(<HighlightsBadge ready running={0} onOpen={() => {}} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    expect(badgeText()).toBe('하이라이트 3');
  });

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

describe('ServerUpdateChip', () => {
  const act1 = (over: Partial<SessionActivity>): SessionActivity => ({ sessionId: 's', cwd: '/p', turnId: 't', running: false, bg: 0, forMs: 0, ...over });
  const upd = (changedFiles: number, supervised = true) => new Response(JSON.stringify({ changedFiles, newestAt: 1, supervised, draining: false }), { status: 200 });

  it('restartConfirmText: turns plus background tasks, or 바로 when idle', () => {
    expect(restartConfirmText([])).toBe('바로 재시작합니다');
    expect(restartConfirmText([act1({ running: true, bg: 2 }), act1({ sessionId: 'b', bg: 1 })])).toBe('진행 중 작업 4개가 끝나면 재시작합니다');
  });

  it('shows 서버 업데이트 대기 · 파일 N when code changed under a supervisor; hidden unsupervised, unchanged or draining', async () => {
    const f = vi.fn(async () => upd(3));
    const { rerender } = render(<ServerUpdateChip ready draining={false} activity={[]} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    expect(f).toHaveBeenCalledWith('/api/server-update');
    expect(screen.getByTestId('update-chip').querySelector('.chip-long')!.textContent).toBe('서버 업데이트 대기 · 파일 3개 지금 재시작');
    rerender(<ServerUpdateChip ready draining activity={[]} fetchFn={f as unknown as typeof fetch} />);
    expect(screen.queryByTestId('update-chip')).toBeNull();
    cleanup();
    for (const r of [() => upd(2, false), () => upd(0)]) {
      render(<ServerUpdateChip ready draining={false} activity={[]} fetchFn={(async () => r()) as unknown as typeof fetch} />);
      await flush();
      expect(screen.queryByTestId('update-chip')).toBeNull();
      cleanup();
    }
  });

  it('지금 재시작 → a confirm with what it waits for; 재시작 posts /api/restart, 취소 does not', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return url === '/api/restart' ? new Response('{"ok":true,"draining":true}', { status: 200 }) : upd(1); });
    render(<ServerUpdateChip ready draining={false} activity={[act1({ running: true })]} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    fireEvent.click(screen.getByTestId('update-chip'));
    expect(screen.getByRole('dialog', { name: '서버 재시작' }).textContent).toContain('진행 중 작업 1개가 끝나면 재시작합니다');
    fireEvent.click(screen.getByText('취소'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url === '/api/restart')).toBe(false);
    fireEvent.click(screen.getByTestId('update-chip'));
    fireEvent.click(screen.getByText('재시작'));
    await flush();
    expect(calls.filter((c) => c.url === '/api/restart').map((c) => c.init?.method)).toEqual(['POST']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a refused restart shows the server\'s message and keeps the confirm open', async () => {
    const f = async (url: string) => (url === '/api/restart' ? new Response(JSON.stringify({ error: '관리자 없이 실행 중' }), { status: 409 }) : upd(1));
    render(<ServerUpdateChip ready draining={false} activity={[]} fetchFn={f as unknown as typeof fetch} />);
    await flush();
    fireEvent.click(screen.getByTestId('update-chip'));
    expect(screen.getByRole('dialog').textContent).toContain('바로 재시작합니다');
    fireEvent.click(screen.getByText('재시작'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('관리자 없이 실행 중');
  });
});
