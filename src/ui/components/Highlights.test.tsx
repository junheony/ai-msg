// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Highlights, groupHighlights, summaryOf } from './Highlights';
import type { HighlightEvent } from '../../shared/highlights';

const NOW = new Date(2026, 9, 13, 12, 0).getTime();
const M = 60_000;
const ev = (minAgo: number, over: Partial<HighlightEvent>): HighlightEvent => ({ at: NOW - minAgo * M, kind: 'turn', sessionId: 's1', cwd: '/p/app', title: 'App 작업', body: '완료 · 끝', ok: true, ...over });

const events: HighlightEvent[] = [
  ev(5, { body: '완료 · 최신' }),
  ev(30, { ok: false, body: '실패 · 에러' }),
  ev(10, { sessionId: 's2', cwd: '/p/web', title: 'Web 고치기', kind: 'permission', body: '권한 요청 · Bash', ok: undefined }),
  ev(2, { sessionId: 's3', cwd: '/p/api', title: 'API', kind: 'interrupted', body: '서버가 다시 시작되어 중단됨', ok: undefined }),
  ev(60, { sessionId: null, cwd: '', title: '서버', kind: 'server', body: '서버 시작', ok: undefined }),
];

const fetchOf = (list: HighlightEvent[]) => vi.fn(async () => new Response(JSON.stringify({ hours: 24, events: list }), { status: 200 })) as unknown as typeof fetch;

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe('groupHighlights', () => {
  it('groups per session, newest session first, the server card on top; summary counts', () => {
    const cards = groupHighlights(events, 'all');
    expect(cards.map((c) => c.key)).toEqual(['server', 's3', 's1', 's2']);
    expect(cards[2]!.events.map((e) => e.body)).toEqual(['완료 · 최신', '실패 · 에러']);
    expect(summaryOf(cards[2]!)).toBe('완료 1 · 실패 1');
    expect(summaryOf(cards[0]!)).toBe('1건');
  });

  it('filters by kind', () => {
    expect(groupHighlights(events, 'failed').map((c) => c.key)).toEqual(['s1']);
    expect(groupHighlights(events, 'ask').map((c) => c.key)).toEqual(['s2']);
    expect(groupHighlights(events, 'interrupted').map((c) => c.key)).toEqual(['s3']);
    expect(groupHighlights(events, 'task')).toEqual([]);
  });
});

describe('Highlights', () => {
  it('fetches the default 24h, shows cards, opens a session on click, expands a timeline', async () => {
    const fetchFn = fetchOf(events);
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Highlights onClose={onClose} onOpenSession={onOpen} fetchFn={fetchFn} now={NOW} engineOf={() => 'claude'} />);
    await waitFor(() => expect(screen.getAllByTestId('hl-card')).toHaveLength(4));
    expect(fetchFn).toHaveBeenCalledWith('/api/highlights?hours=24');
    const cards = screen.getAllByTestId('hl-card');
    expect(cards[0]!.textContent).toContain('서버');
    expect(within(cards[0]!).queryByTitle('이 세션 열기')).toBeNull();
    const app = cards[2]!;
    expect(app.textContent).toContain('App 작업');
    expect(app.textContent).toContain('app');
    expect(app.textContent).toContain('완료 1 · 실패 1');
    expect(app.textContent).toContain('5분 전');
    fireEvent.click(within(app).getByTitle('이 세션 열기'));
    expect(onOpen).toHaveBeenCalledWith('s1', '/p/app', 'App 작업');
    fireEvent.click(within(app).getByRole('button', { name: '타임라인 2건' }));
    expect(app.querySelectorAll('.hl-timeline li')).toHaveLength(2);
    expect(app.querySelector('.hl-timeline time')!.textContent).toBe('11:55');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('period buttons refetch and are remembered; filter chips narrow the cards', async () => {
    const fetchFn = fetchOf(events);
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(screen.getAllByTestId('hl-card')).toHaveLength(4));
    fireEvent.click(screen.getByRole('tab', { name: '6시간' }));
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/highlights?hours=6'));
    expect(sessionStorage.getItem('deck.highlightsHours')).toBe('6');
    fireEvent.click(screen.getByRole('button', { name: '승인·질문' }));
    expect(screen.getAllByTestId('hl-card').map((c) => c.textContent)).toEqual([expect.stringContaining('Web 고치기')]);
    fireEvent.click(screen.getByRole('button', { name: '작업' }));
    expect(screen.getByText('지난 6시간 동안 기록된 일이 없습니다')).toBeTruthy();
    cleanup();
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/highlights?hours=6'));
  });

  it('a late answer for an earlier period is ignored; a new period shows 불러오는 중 rather than the old cards', async () => {
    const pending = new Map<string, (list: HighlightEvent[]) => void>();
    const fetchFn = vi.fn((url: string) => new Promise<Response>((resolve) => {
      pending.set(url, (list) => resolve(new Response(JSON.stringify({ events: list }), { status: 200 })));
    })) as unknown as typeof fetch;
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(pending.has('/api/highlights?hours=24')).toBe(true));
    pending.get('/api/highlights?hours=24')!(events);
    await waitFor(() => expect(screen.getAllByTestId('hl-card')).toHaveLength(4));
    pending.clear();
    fireEvent.click(screen.getByRole('tab', { name: '12시간' }));
    await waitFor(() => expect(pending.has('/api/highlights?hours=12')).toBe(true));
    expect(screen.queryAllByTestId('hl-card')).toHaveLength(0);
    expect(screen.getByText('불러오는 중…')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '6시간' }));
    await waitFor(() => expect(pending.has('/api/highlights?hours=6')).toBe(true));
    pending.get('/api/highlights?hours=6')!([]);
    await waitFor(() => expect(screen.getByText('지난 6시간 동안 기록된 일이 없습니다')).toBeTruthy());
    pending.get('/api/highlights?hours=12')!(events);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryAllByTestId('hl-card')).toHaveLength(0);
    expect(screen.getByText('지난 6시간 동안 기록된 일이 없습니다')).toBeTruthy();
  });

  it('empty and error states', async () => {
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={fetchOf([])} now={NOW} />);
    await waitFor(() => expect(screen.getByText('지난 24시간 동안 기록된 일이 없습니다')).toBeTruthy());
    cleanup();
    const bad = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={bad} now={NOW} />);
    await waitFor(() => expect(screen.getByText('하이라이트를 불러오지 못했습니다 (500)')).toBeTruthy());
  });
});
