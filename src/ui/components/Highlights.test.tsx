// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Highlights, digestLine, digestOf, groupHighlights, summaryOf } from './Highlights';
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

  it('summary leaves tasks out unless the card has nothing else; digest = turn/interrupted lines without the prefix, newest first, 3 at most', () => {
    const busy: HighlightEvent[] = [
      ev(1, { body: '완료 · 로그인 버그 고침' }), ev(2, { kind: 'task', body: '작업 끝 · 빌드', ok: undefined }),
      ev(3, { kind: 'permission', body: '권한 요청 · Bash', ok: undefined }), ev(4, { ok: false, body: '실패 · 타임아웃' }),
      ev(5, { body: '완료' }), ev(6, { kind: 'interrupted', body: '서버가 다시 시작되어 중단됨', ok: undefined }),
      ev(7, { body: '완료 · 테스트 추가' }), ev(8, { body: '완료 · 맨 오래된 것' }),
    ];
    const card = groupHighlights(busy, 'all')[0]!;
    expect(summaryOf(card)).toBe('완료 4 · 실패 1 · 승인 1 · 끊김 1');
    expect(digestOf(card).map(digestLine)).toEqual(['로그인 버그 고침', '타임아웃', '서버가 다시 시작되어 중단됨']);
    const onlyTasks = groupHighlights(busy, 'task')[0]!;
    expect(summaryOf(onlyTasks)).toBe('작업 1');
    expect(digestOf(onlyTasks)).toEqual([]);
    expect(digestOf(groupHighlights(busy, 'all').find((c) => c.server) ?? groupHighlights(events, 'all')[0]!).map(digestLine)).toEqual(['서버 시작']);
  });

  it('filters by kind', () => {
    expect(groupHighlights(events, 'failed').map((c) => c.key)).toEqual(['s1']);
    expect(groupHighlights(events, 'ask').map((c) => c.key)).toEqual(['s2']);
    expect(groupHighlights(events, 'interrupted').map((c) => c.key)).toEqual(['s3']);
    expect(groupHighlights(events, 'task')).toEqual([]);
  });
});

describe('Highlights', () => {
  it('fetches the default 24h, sorts into 확인 필요 / 진행 중 / 끝남 with the server card last; opens and unfolds', async () => {
    const fetchFn = fetchOf(events);
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const live = { waiting: [{ sessionId: 's2', kind: 'permission' as const }], activity: [] };
    render(<Highlights onClose={onClose} onOpenSession={onOpen} fetchFn={fetchFn} now={NOW} engineOf={() => 'claude'} live={live} />);
    await waitFor(() => expect(screen.getByTestId('hl-sec-attention')).toBeTruthy());
    expect(fetchFn).toHaveBeenCalledWith('/api/highlights?hours=24');
    const attention = screen.getByTestId('hl-sec-attention');
    expect(attention.querySelector('h3')!.textContent).toBe('확인 필요 2');
    expect(within(attention).getAllByTestId('hl-need').map((n) => n.textContent)).toEqual(['승인 대기 · 10분', '서버 재시작으로 끊김']);
    fireEvent.click(within(attention).getAllByTitle('이 세션 열기')[0]!);
    expect(onOpen).toHaveBeenCalledWith('s2', '/p/web', 'Web 고치기');
    expect(screen.queryByTestId('hl-sec-progress')).toBeNull();
    const done = screen.getByTestId('hl-sec-done');
    expect(done.querySelector('h3')!.textContent).toBe('끝남 1');
    const row = within(done).getByTestId('hl-done');
    expect(row.textContent).toContain('App 작업');
    expect(row.textContent).toContain('app');
    expect(row.textContent).toContain('완료 1 · 실패 1');
    expect(row.textContent).toContain('최신');
    expect(row.textContent).toContain('5분 전');
    expect(within(row).queryByTestId('hl-card')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const app = within(row).getByTestId('hl-card');
    expect(within(app).getByTestId('hl-digest').textContent).toBe('✓최신✕에러');
    fireEvent.click(within(app).getByTitle('이 세션 열기'));
    expect(onOpen).toHaveBeenLastCalledWith('s1', '/p/app', 'App 작업');
    fireEvent.click(within(app).getByRole('button', { name: '타임라인 2건' }));
    expect(app.querySelectorAll('.hl-timeline li')).toHaveLength(2);
    expect(app.querySelector('.hl-timeline time')!.textContent).toBe('11:55');
    const cards = screen.getAllByTestId('hl-card');
    expect(cards[cards.length - 1]!.textContent).toContain('서버');
    expect(within(cards[cards.length - 1]!).queryByTitle('이 세션 열기')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a session at work goes under 진행 중 as a small row', async () => {
    const live = { waiting: [], activity: [{ sessionId: 's1', running: false, bg: 2 }] };
    const onOpen = vi.fn();
    render(<Highlights onClose={() => {}} onOpenSession={onOpen} fetchFn={fetchOf(events)} now={NOW} live={live} />);
    await waitFor(() => expect(screen.getByTestId('hl-sec-progress')).toBeTruthy());
    const row = screen.getByTestId('hl-progress');
    expect(row.textContent).toContain('App 작업');
    expect(row.textContent).toContain('백그라운드 2');
    fireEvent.click(within(row).getByTitle('이 세션 열기'));
    expect(onOpen).toHaveBeenCalledWith('s1', '/p/app', 'App 작업');
  });

  it('period buttons refetch and are remembered; filter chips narrow the cards', async () => {
    const fetchFn = fetchOf(events);
    render(<Highlights onClose={() => {}} onOpenSession={() => {}} fetchFn={fetchFn} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('hl-sec-done')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: '6시간' }));
    await waitFor(() => expect(fetchFn).toHaveBeenLastCalledWith('/api/highlights?hours=6'));
    expect(sessionStorage.getItem('deck.highlightsHours')).toBe('6');
    fireEvent.click(screen.getByRole('button', { name: '승인·질문' }));
    expect(screen.getAllByTestId('hl-card').map((c) => c.textContent)).toEqual([expect.stringContaining('Web 고치기')]);
    expect(screen.queryByTestId('hl-sec-done')).toBeNull();
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
    await waitFor(() => expect(screen.getAllByTestId('hl-card')).toHaveLength(2));
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
