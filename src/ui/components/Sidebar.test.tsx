// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Sidebar } from './Sidebar';

const noop = () => {};

describe('Sidebar 폴더 열기 (F1)', () => {
  afterEach(cleanup);

  it('opens the folder picker and hands the server-validated path to onOpenFolder', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ path: '/Users/u/x', recent: ['/Users/u/x'] }), { status: 200 });
      if (url === '/api/recent-folders') return new Response(JSON.stringify({ recent: [] }), { status: 200 });
      return new Response(JSON.stringify({ path: '/Users/u', parent: null, dirs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const onOpenFolder = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenFolder={onOpenFolder} fetchFn={fetchFn} />);
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
    fireEvent.click(screen.getByText('폴더 열기'));
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByText('열기'));
    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith('/Users/u/x'));
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
  });
});

describe('Sidebar pins (F2)', () => {
  afterEach(cleanup);
  const s = (id: string, cwd: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd, projectDir: '/p', file: '/f', title, lastModified: Date.now(), sizeBytes: 1 });
  const projects = [
    { cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first'), s('s2', '/w/one', 'second')] },
    { cwd: '/w/two', name: 'two', pinned: false, sessions: [s('s3', '/w/two', 'third')] },
  ];

  it('shows a 고정됨 group at the top in pin order across projects, skipping unknown ids', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s3', 'gone', 's1']} onTogglePin={noop} />);
    const group = screen.getByTestId('pinned-group');
    expect(group.textContent).toContain('고정됨');
    const titles = [...group.querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(titles).toEqual(['third', 'first']);
  });

  it('no 고정됨 group without pins; the pin toggle reports the new state and does not open the session', () => {
    const onTogglePin = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={[]} onTogglePin={onTogglePin} />);
    expect(screen.queryByTestId('pinned-group')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '고정' })[0]!);
    expect(onTogglePin).toHaveBeenCalledWith('s1', true);
    expect(onOpen).not.toHaveBeenCalled();
    rerender(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s1']} onTogglePin={onTogglePin} />);
    fireEvent.click(screen.getAllByRole('button', { name: '고정 해제' })[0]!);
    expect(onTogglePin).toHaveBeenLastCalledWith('s1', false);
  });

  it('clicking a pinned row opens its session', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s3']} onTogglePin={noop} />);
    fireEvent.click(screen.getByTestId('pinned-group').querySelector('li')!);
    expect(onOpen).toHaveBeenCalledWith('s3', '/w/two', 'third');
  });
});

describe('Sidebar folding and search', () => {
  afterEach(cleanup);
  const s = (i: number) => ({ sessionId: `s${i}`, account: 'a' as const, cwd: '/w', projectDir: '/p', file: '/f', title: `session ${i}`, lastModified: Date.now() - 3 * 3_600_000, sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: Array.from({ length: 8 }, (_, i) => s(i)) }];

  it('shows 5 sessions then 더 보기; the project header collapses its list; rows carry "A · 3시간 전"', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelector('.session-meta')?.textContent).toBe('A · 3시간 전');
    fireEvent.click(screen.getByText('더 보기 (3)'));
    expect(container.querySelectorAll('li')).toHaveLength(8);
    fireEvent.click(screen.getByText('접기'));
    expect(container.querySelectorAll('li')).toHaveLength(5);
    fireEvent.click(screen.getByText('w'));
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('the search box filters sessions by title across the fold', () => {
    const onNew = vi.fn();
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={onNew} onRefresh={noop} />);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'session 7' } });
    expect([...container.querySelectorAll('.session-title')].map((e) => e.textContent)).toEqual(['session 7']);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'nothing' } });
    expect(screen.getByText(/맞는 세션이 없습니다/)).toBeTruthy();
    expect(screen.queryByLabelText('w 새 세션')).toBeNull(); // the project hides while nothing in it matches
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('w 새 세션'));
    expect(onNew).toHaveBeenCalledWith('/w', 'w');
  });
});

describe('Sidebar 최근 Desktop 세션 / 자동 승인', () => {
  afterEach(cleanup);
  const d = (n: number, title: string, project: string) => ({ sessionId: `d${n}`, account: 'a' as const, title, cwd: `/Users/u/${project}`, project, lastModified: Date.now() - n * 3_600_000 });

  it('lists the Desktop sessions with project and relative time; a click opens it like any session; search filters them', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} desktop={[d(1, 'Fix login', 'deck'), d(2, 'Write docs', 'harness')]} />);
    const group = screen.getByTestId('desktop-group');
    expect(group.textContent).toContain('최근 Desktop 세션');
    expect(group.textContent).toContain('deck · 1시간 전');
    fireEvent.click(screen.getByText('Write docs'));
    expect(onOpen).toHaveBeenCalledWith('d2', '/Users/u/harness', 'Write docs');
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'harness' } });
    expect(screen.queryByText('Fix login')).toBeNull();
    expect(screen.getByText('Write docs')).toBeTruthy();
  });

  it('no Desktop sessions → no section', () => {
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
  });

});

describe('Sidebar rename / archive / 대화 내용 검색', () => {
  afterEach(cleanup);
  const s = (id: string, title: string, archived = false) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: Date.now(), sizeBytes: 1, ...(archived ? { archived } : {}) });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'Alpha'), s('s2', 'Beta'), s('s3', 'Old', true)] }];

  it('double-click renames inline: Enter saves, Esc cancels, empty resets to the transcript title; the 2nd click does not re-open', () => {
    const onRename = vi.fn();
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} onRename={onRename} onArchive={noop} />);
    const title = screen.getByText('Alpha');
    fireEvent.click(title, { detail: 1 });
    fireEvent.click(title, { detail: 2 });
    fireEvent.doubleClick(title);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const input = screen.getByLabelText('세션 이름') as HTMLInputElement;
    expect(input.value).toBe('Alpha');
    fireEvent.change(input, { target: { value: '  Release   notes ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('s1', 'Release notes');
    expect(screen.queryByLabelText('세션 이름')).toBeNull();

    fireEvent.doubleClick(screen.getByText('Beta'));
    fireEvent.change(screen.getByLabelText('세션 이름'), { target: { value: 'nope' } });
    fireEvent.keyDown(screen.getByLabelText('세션 이름'), { key: 'Escape' });
    fireEvent.doubleClick(screen.getByText('Beta'));
    fireEvent.change(screen.getByLabelText('세션 이름'), { target: { value: '   ' } });
    fireEvent.blur(screen.getByLabelText('세션 이름'));
    expect(onRename.mock.calls).toEqual([['s1', 'Release notes'], ['s2', null]]);
  });

  it('context menu archives; archived sessions only show under 보관됨, where they can be unarchived or renamed', () => {
    const onArchive = vi.fn();
    const onRename = vi.fn();
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={onRename} onArchive={onArchive} pins={['s3']} onTogglePin={noop} />);
    const titles = () => [...container.querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(titles()).toEqual(['Alpha', 'Beta']);
    expect(screen.queryByTestId('pinned-group')).toBeNull(); // a pinned but archived session hides too
    fireEvent.contextMenu(screen.getByText('Beta'));
    fireEvent.click(screen.getByRole('menuitem', { name: '보관' }));
    expect(onArchive).toHaveBeenCalledWith('s2', true);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByText('보관됨'));
    expect(titles()).toEqual(['Old', 'Old']);
    fireEvent.click(screen.getAllByLabelText('세션 메뉴')[1]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '보관 해제' }));
    expect(onArchive).toHaveBeenLastCalledWith('s3', false);
    fireEvent.click(screen.getAllByLabelText('세션 메뉴')[1]!);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('보관됨 with nothing archived says so; no menu without handlers', () => {
    render(<Sidebar projects={[{ ...projects[0]!, sessions: [s('s1', 'Alpha')] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onArchive={noop} />);
    fireEvent.click(screen.getByText('보관됨'));
    expect(screen.getByText('보관된 세션이 없습니다.')).toBeTruthy();
    cleanup();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByLabelText('세션 메뉴')).toBeNull();
    expect(screen.queryByText('보관됨')).toBeNull();
  });

  it('full-text search: debounced, highlighted snippet, archived-session hits hidden, click opens the hit', async () => {
    const hit = (sessionId: string, snippet: string, matchStart: number) => ({ sessionId, title: `T ${sessionId}`, cwd: '/w', account: 'b', engine: 'claude', lastModified: Date.now(), role: 'assistant' as const, snippet, matchStart, matchLength: 5 });
    const searchFn = vi.fn(async (q: string) => ({ hits: [hit('s1', '…fix the flaky test…', 9), hit('s3', 'flaky old', 0), hit('zz', 'other flaky', 6)], truncated: q === 'flaky' }));
    const onOpenHit = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenHit={onOpenHit} searchFn={searchFn} onArchive={noop} />);
    const box = screen.getByLabelText('세션 검색');
    fireEvent.change(box, { target: { value: 'f' } });
    fireEvent.change(box, { target: { value: 'fl' } });
    fireEvent.change(box, { target: { value: 'flaky' } });
    const group = await screen.findByTestId('search-group');
    await waitFor(() => expect(group.querySelectorAll('.search-hit')).toHaveLength(2));
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(searchFn).toHaveBeenCalledWith('flaky');
    expect([...group.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['flaky', 'flaky']);
    expect(group.querySelector('.search-snippet')!.textContent).toBe('…fix the flaky test…');
    expect(screen.getByText('결과 일부만 표시됩니다.')).toBeTruthy();
    fireEvent.click(group.querySelector('.search-hit')!);
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    fireEvent.change(box, { target: { value: 'f' } });
    expect(screen.queryByTestId('search-group')).toBeNull();
  });
});

describe('Sidebar activity dots', () => {
  afterEach(cleanup);
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: Date.now(), sizeBytes: 1 });
  it('running → spinner, background only → pulsing dot, finished unseen → unread dot', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      activity={[{ sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 0, forMs: 0 }, { sessionId: 's2', cwd: '/w', turnId: 't2', running: false, bg: 2, forMs: 0 }]}
      unread={['s3']} />);
    const dotOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.row-dot');
    expect(dotOf('one')?.classList.contains('running')).toBe(true);
    expect(dotOf('two')?.getAttribute('aria-label')).toBe('백그라운드 작업 2개');
    expect(dotOf('three')?.classList.contains('unread')).toBe(true);
    expect(dotOf('four')).toBeNull();
  });
});

describe('Sidebar imported Codex threads', () => {
  afterEach(cleanup);

  it('marks a Codex app/CLI thread next to the GPT badge and opens it like any session', () => {
    const onOpen = vi.fn();
    const e = { sessionId: 'tid', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', title: 'from codex', lastModified: Date.now(), sizeBytes: 1, imported: true };
    render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [e] }]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} />);
    expect(screen.getByText(/GPT · Codex ·/)).toBeTruthy();
    fireEvent.click(screen.getByText('from codex'));
    expect(onOpen).toHaveBeenCalledWith('tid', '/w', 'from codex');
  });
});
