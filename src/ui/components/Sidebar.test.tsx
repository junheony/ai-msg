// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AVATAR_COLORS, DECK_VERSION_LINE, META_TICK_MS, ROW_PRESS_MS, Sidebar, avatarIndex } from './Sidebar';
import { SessionChipHead } from './SessionChipHead';
import { useSessionAvatar, useSessionIconStore } from './SessionIcon';
import type { SessionActivity } from '../../shared/protocol';

const noop = () => {};
/** The head's search icon opens the 세션 검색 box (it is not on screen until then). */
const openSearch = () => fireEvent.click(screen.getByRole('button', { name: '검색' }));
/** The head's + menu (새 세션 · 폴더 열기… · 지금 / 최근 폴더 · 세션 목록 다시 읽기). */
const openNewMenu = () => fireEvent.click(screen.getByRole('button', { name: '새 세션' }));
/** Fixture times: now, each one 1 ms older, so the 최근 view's newest-first order is the creation order (equal / ms-apart Date.now() made it flaky). */
const stamp = (() => { const base = Date.now(); let k = 0; return () => base - k++; })();

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
    openNewMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '폴더 열기…' }));
    fireEvent.change(screen.getByLabelText('폴더 경로'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByText('열기'));
    await waitFor(() => expect(onOpenFolder).toHaveBeenCalledWith('/Users/u/x'));
    expect(screen.queryByLabelText('폴더 경로')).toBeNull();
  });
});

describe('Sidebar pins (F2)', () => {
  afterEach(cleanup);
  const s = (id: string, cwd: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd, projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
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

  it('no 고정됨 group without pins; pinning is a ⋯ menu item (no pin button in the row) and does not open the session', () => {
    const onTogglePin = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={[]} onTogglePin={onTogglePin} />);
    expect(screen.queryByTestId('pinned-group')).toBeNull();
    expect(screen.queryByRole('button', { name: '고정' })).toBeNull();
    const menuOf = (title: string) => fireEvent.click(screen.getByText(title).closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
    menuOf('first');
    fireEvent.click(screen.getByRole('menuitem', { name: '맨 위에 고정' }));
    expect(onTogglePin).toHaveBeenCalledWith('s1', true);
    expect(onOpen).not.toHaveBeenCalled();
    rerender(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s1']} onTogglePin={onTogglePin} />);
    menuOf('first');
    fireEvent.click(screen.getByRole('menuitem', { name: '고정 해제' }));
    expect(onTogglePin).toHaveBeenLastCalledWith('s1', false);
  });

  it('each session once — pinned rows leave the date groups; a pinned row still names its project in the meta', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s1', 's3']} onTogglePin={noop} />);
    const pinned = screen.getByTestId('pinned-group');
    expect([...pinned.querySelectorAll('.session-title')].map((e) => e.textContent)).toEqual(['first', 'third']);
    expect([...pinned.querySelectorAll('.session-meta')].map((e) => e.textContent)).toEqual(['one', 'two']);
    expect([...container.querySelectorAll('.date-group .session-title')].map((e) => e.textContent)).toEqual(['second']);
  });

  it('clicking a pinned row opens its session', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={['s3']} onTogglePin={noop} />);
    fireEvent.click(screen.getByTestId('pinned-group').querySelector('.row-open')!);
    expect(onOpen).toHaveBeenCalledWith('s3', '/w/two', 'third');
  });
});

describe('Sidebar ⌘1 … ⌘9 hints', () => {
  afterEach(cleanup);
  const s = (i: number) => ({ sessionId: `s${i}`, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title: `session ${i}`, lastModified: stamp(), sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: Array.from({ length: 12 }, (_, i) => s(i)) }];
  // 11 pinned; the first is a Desktop-only session.
  const desktop = [{ sessionId: 'd1', account: 'a' as const, cwd: '/d', title: 'desk', project: 'd', lastModified: stamp() }];
  const pins = ['d1', ...Array.from({ length: 10 }, (_, i) => `s${i}`)];
  const hints = () => [...screen.getByTestId('pinned-group').querySelectorAll('li')].map((li) => li.querySelector('.pin-key')?.textContent ?? null);
  /** jsdom has no Mac platform: the modifier is Ctrl. */
  const hold = (extra: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key: 'Control', ctrlKey: true, ...extra });
  const nine = [...Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`), null, null];
  const none = Array.from({ length: 11 }, () => null);
  const setup = (onOpen: (id: string, cwd: string, title: string) => void = noop) => {
    const pinShortcut = { current: (_: number) => false };
    render(<Sidebar projects={projects} desktop={desktop} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} pins={pins} pinShortcut={pinShortcut} onTogglePin={noop} />);
    return pinShortcut;
  };

  it('shows the number on the first nine pinned rows only, while Ctrl is held alone', () => {
    setup();
    expect(hints()).toEqual(none);
    hold();
    expect(hints()).toEqual(nine);
    fireEvent.keyUp(window, { key: 'Control' });
    expect(hints()).toEqual(none);
    hold({ shiftKey: true });
    expect(hints()).toEqual(none);
    hold({ altKey: true });
    expect(hints()).toEqual(none);
    // Only pinned rows carry it.
    hold();
    expect(document.querySelectorAll('.pin-key')).toHaveLength(9);
  });

  it('cannot stick: window blur and a hidden page clear it', () => {
    setup();
    hold();
    fireEvent.blur(window);
    expect(hints()).toEqual(none);
    hold();
    fireEvent(document, new Event('visibilitychange'));
    expect(hints()).toEqual(none);
  });

  it('no hints without the shortcut wired; with a filter the numbers follow the rows shown, and the opener opens that row', () => {
    const onOpen = vi.fn();
    const pinShortcut = setup(onOpen);
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'session 1' } }); // "session 1" (s10 is not pinned)
    hold();
    expect(hints()).toEqual(['Ctrl+1']);
    expect(pinShortcut.current(0)).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith('s1', '/w', 'session 1');
    expect(pinShortcut.current(1)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: '' } });
    expect(pinShortcut.current(0)).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith('d1', '/d', 'desk');
    cleanup();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={pins} onTogglePin={noop} />);
    hold();
    expect(document.querySelector('.pin-key')).toBeNull();
  });
});

describe('Sidebar date list and search', () => {
  afterEach(cleanup);
  const s = (i: number) => ({ sessionId: `s${i}`, account: 'a' as const, cwd: '/w', projectDir: '/p', file: '/f', title: `session ${i}`, lastModified: Date.now() - 3 * 3_600_000, sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: Array.from({ length: 8 }, (_, i) => s(i)) }];

  it('lists every session in date groups (no per-project fold); the time is in the tooltip only, the meta names the project, no account letter', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(container.querySelectorAll('li')).toHaveLength(8);
    expect(container.querySelectorAll('.date-group')).not.toHaveLength(0);
    expect(screen.queryByText(/더 보기/)).toBeNull();
    const li = container.querySelector('li')!;
    expect(li.querySelector('.row-time')).toBeNull();
    expect(li.getAttribute('title')).toContain('3시간 전');
    expect(li.querySelector('.session-meta')?.textContent).toBe('w'); // turns are spread over accounts, so a per-session letter would mislead
  });

  it('the search box filters sessions by title', () => {
    const { container } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'session 7' } });
    expect([...container.querySelectorAll('.session-title')].map((e) => e.textContent)).toEqual(['session 7']);
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'nothing' } });
    expect(screen.getByText(/맞는 세션이 없습니다/)).toBeTruthy();
  });
});

describe('Sidebar 최근 Desktop 세션 / 자동 승인', () => {
  afterEach(cleanup);
  const d = (n: number, title: string, project: string) => ({ sessionId: `d${n}`, account: 'a' as const, title, cwd: `/Users/u/${project}`, project, lastModified: Date.now() - n * 3_600_000 });

  it('lists the Desktop sessions with project and relative time; a click opens it like any session; search filters them', () => {
    const onOpen = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} desktop={[d(1, 'Fix login', 'deck'), d(2, 'Write docs', 'harness')]} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
    const row = screen.getByText('Fix login').closest('li')!;
    expect(row.querySelector('.session-meta')?.textContent).toBe('deck');
    expect(row.getAttribute('title')).toContain('deck · Desktop · 1시간 전');
    fireEvent.click(screen.getByText('Write docs'));
    expect(onOpen).toHaveBeenCalledWith('d2', '/Users/u/harness', 'Write docs');
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'harness' } });
    expect(screen.queryByText('Fix login')).toBeNull();
    expect(screen.getByText('Write docs')).toBeTruthy();
  });

  it('최근 view: each session once — pinned rows leave the date groups, Desktop sessions merge into them, no separate Desktop section', () => {
    const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w/one', projectDir: '/p', file: '/f', title, lastModified: Date.now() - 60_000, sizeBytes: 1 });
    const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', 'first'), s('s2', 'second'), s('d1', 'Fix login')] }];
    const onTogglePin = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s1', 'd3']} onTogglePin={onTogglePin}
      desktop={[d(1, 'Fix login', 'one'), d(2, 'Write docs', 'harness'), d(3, 'Pinned desktop', 'x')]} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
    const titles = [...document.querySelectorAll('.session-title')].map((e) => e.textContent);
    // every title exactly once
    expect([...titles].sort()).toEqual(['Fix login', 'Pinned desktop', 'Write docs', 'first', 'second']);
    const pinnedTitles = [...screen.getByTestId('pinned-group').querySelectorAll('.session-title')].map((e) => e.textContent);
    expect(pinnedTitles).toEqual(['first', 'Pinned desktop']);
    // a Desktop-only row sits in its date group (which one depends on the clock), labelled, and can be pinned too
    const docs = [...document.querySelectorAll('.date-group li')].find((li) => li.textContent?.includes('Write docs'))!;
    expect(docs.getAttribute('title')).toContain('harness · Desktop');
    fireEvent.click(docs.querySelector('button[aria-label="세션 메뉴"]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '맨 위에 고정' }));
    expect(onTogglePin).toHaveBeenCalledWith('d2', true);
  });

  it('a Desktop session a project already lists shows once, as that project\'s row', () => {
    const s = { sessionId: 'd1', account: 'a' as const, cwd: '/w/deck', projectDir: '/p', file: '/f', title: 'Fix login', lastModified: Date.now(), sizeBytes: 1 };
    render(<Sidebar projects={[{ cwd: '/w/deck', name: 'deck', pinned: true, sessions: [s] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      desktop={[d(1, 'Fix login', 'deck'), d(2, 'Write docs', 'harness')]} />);
    expect(screen.getAllByText('Fix login')).toHaveLength(1);
    expect(screen.getByText('Fix login').closest('li')!.querySelector('.session-meta')?.textContent).toBe('deck');
    expect(screen.getByText('Write docs')).toBeTruthy();
  });

  it('no Desktop sessions → no section', () => {
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByTestId('desktop-group')).toBeNull();
  });

});

describe('Sidebar rename / archive / 대화 내용 검색', () => {
  afterEach(cleanup);
  const s = (id: string, title: string, archived = false) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...(archived ? { archived } : {}) });
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

    // 보관됨 N: one folded row at the end of the list; pressing it lists them in place, under the rest.
    const archived = screen.getByTestId('archived-group');
    const toggle = within(archived).getByRole('button', { name: '보관됨 1' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Pinned but archived: listed once, in 보관됨 (고정됨 stays empty).
    expect(titles()).toEqual(['Alpha', 'Beta', 'Old']);
    expect(screen.queryByTestId('pinned-group')).toBeNull();
    expect(archived.textContent).toContain('Old');
    fireEvent.click(within(archived).getByLabelText('세션 메뉴'));
    fireEvent.click(screen.getByRole('menuitem', { name: '보관 해제' }));
    expect(onArchive).toHaveBeenLastCalledWith('s3', false);
    fireEvent.click(within(archived).getByLabelText('세션 메뉴'));
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
    const hit = (sessionId: string, snippet: string, matchStart: number) => ({ sessionId, title: `T ${sessionId}`, cwd: '/w', account: 'b', engine: 'claude' as const, lastModified: Date.now(), role: 'assistant' as const, snippet, matchStart, matchLength: 5 });
    const searchFn = vi.fn(async (q: string) => ({ hits: [hit('s1', '…fix the flaky test…', 9), hit('s3', 'flaky old', 0), hit('zz', 'other flaky', 6)], truncated: q === 'flaky' }));
    const onOpenHit = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenHit={onOpenHit} searchFn={searchFn} onArchive={noop} />);
    openSearch();
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
    fireEvent.click(group.querySelector('.search-hit button')!);
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    fireEvent.change(box, { target: { value: 'f' } });
    expect(screen.queryByTestId('search-group')).toBeNull();
  });
});

describe('Sidebar activity dots', () => {
  afterEach(cleanup);
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  it('running / background / unread: one mark at the row end, its label says the status in words', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      activity={[{ sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 0, forMs: 0 }, { sessionId: 's2', cwd: '/w', turnId: 't2', running: false, bg: 2, forMs: 0 }]}
      unread={['s3']} />);
    const dotOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.row-status');
    expect(dotOf('one')?.classList.contains('running')).toBe(true);
    expect(dotOf('one')?.getAttribute('aria-label')).toBe('응답 중');
    expect(dotOf('two')?.classList.contains('bg')).toBe(true);
    expect(dotOf('two')?.getAttribute('aria-label')).toBe('백그라운드 2개');
    expect(dotOf('two')?.getAttribute('role')).toBe('img');
    expect(screen.getByText('two').closest('li')!.querySelector('.session-meta')?.textContent).toBe('w');
    expect(dotOf('three')?.classList.contains('unread')).toBe(true);
    expect(dotOf('four')).toBeNull();
  });
});

describe('Sidebar row status and time', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const s = (id: string, title: string, lastModified = Date.now() - 2 * 60_000) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified, sizeBytes: 1 });
  const metaOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.session-meta')?.textContent;
  const markOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.row-status');
  const tipOf = (title: string) => screen.getByText(title).closest('li')!.getAttribute('title');

  it('승인 대기 → 응답 중 → 백그라운드 N개 → 안 읽음: the mark shows the first, its label names all; the meta stays the project', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s0', 'zero'), s('s1', 'one'), s('s2', 'two'), s('s3', 'three'), s('s4', 'four')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop}
      activity={[{ sessionId: 's0', cwd: '/w', turnId: 't0', running: true, bg: 0, forMs: 0 }, { sessionId: 's1', cwd: '/w', turnId: 't1', running: true, bg: 1, forMs: 0 }, { sessionId: 's2', cwd: '/w', turnId: 't2', running: false, bg: 2, forMs: 0 }]}
      unread={['s2', 's3']} waiting={['s0']} />);
    expect(markOf('zero')?.className).toBe('row-status waiting');
    expect(markOf('zero')?.getAttribute('aria-label')).toBe('승인 대기 · 응답 중');
    expect(markOf('one')?.className).toBe('row-status running');
    expect(markOf('one')?.getAttribute('aria-label')).toBe('응답 중 · 백그라운드 1개');
    expect(markOf('two')?.className).toBe('row-status bg');
    expect(markOf('two')?.getAttribute('aria-label')).toBe('백그라운드 2개 · 안 읽음');
    expect(markOf('three')?.className).toBe('row-status unread');
    expect(markOf('four')).toBeNull();
    for (const t of ['zero', 'one', 'two', 'three', 'four']) expect(metaOf(t)).toBe('w');
    expect(tipOf('zero')).toContain('2분 전');
  });

  it('"N분 전" advances every minute without a new index', () => {
    vi.useFakeTimers();
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one', Date.now() - 2 * 60_000)] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(tipOf('one')).toContain('2분 전');
    act(() => { vi.advanceTimersByTime(META_TICK_MS * 3); });
    expect(tipOf('one')).toContain('5분 전');
  });
});

describe('Sidebar imported Codex threads', () => {
  afterEach(cleanup);

  it('marks a Codex app/CLI thread with the Codex mark (no redundant meta text) and opens it like any session', () => {
    const onOpen = vi.fn();
    const e = { sessionId: 'tid', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', title: 'from codex', lastModified: Date.now(), sizeBytes: 1, imported: true };
    render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [e] }]} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} />);
    const li = screen.getByText('from codex').closest('li')!;
    expect(li.querySelector('.session-meta > .meta-engine.codex')).not.toBeNull();
    expect(li.querySelector('.session-meta')?.textContent).toBe('w');
    expect(li.getAttribute('title')).toContain('Codex (GPT)');
    expect(li.getAttribute('title')).toContain('방금');
    fireEvent.click(screen.getByText('from codex'));
    expect(onOpen).toHaveBeenCalledWith('tid', '/w', 'from codex');
  });

  it('tags a `codex exec` thread 자동 실행 in the tooltip', () => {
    const e = { sessionId: 'x1', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', title: 'You are the docs lane', lastModified: Date.now() - 120_000, sizeBytes: 1, imported: true, codexExec: true };
    const { container } = render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [e] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(container.querySelector('.session-meta')?.textContent).toBe('w');
    expect(container.querySelector('li')?.getAttribute('title')).toContain('자동 실행');
    expect(container.querySelector('.meta-engine.codex')).not.toBeNull();
  });

  it('tags a gone-folder thread 폴더 없음 and a Codex-archived one Codex 보관 (no 보관 해제: only Codex can)', () => {
    const base = { account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '/r', file: '/r/f', lastModified: Date.now() - 120_000, sizeBytes: 1, imported: true };
    const gone = { ...base, sessionId: 'x2', title: 'gone', cwdMissing: true };
    const arch = { ...base, sessionId: 'x3', title: 'arch', archived: true, codexArchived: true };
    render(<Sidebar projects={[{ cwd: '/w', name: 'w', pinned: false, sessions: [gone, arch] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onArchive={noop} />);
    const goneMeta = screen.getByText('gone').closest('li')!.querySelector('.session-meta')!;
    expect(goneMeta.querySelector('.meta-tag')?.textContent).toBe('폴더 없음');
    expect(goneMeta.querySelector('.meta-text')?.textContent).toBe('w');
    expect(goneMeta.getAttribute('title')).toContain('폴더가 없어 이어서 보낼 수 없음');
    fireEvent.click(screen.getByRole('button', { name: '보관됨 1' }));
    const li = screen.getByText('arch').closest('li')!;
    expect(li.querySelector('.meta-tag')?.textContent).toBe('읽기 전용');
    expect(li.getAttribute('title')).toContain('Codex 보관');
    fireEvent.click(li.querySelector('.row-more-btn')!);
    expect(screen.queryByRole('menuitem', { name: '보관 해제' })).toBeNull();
  });
});

describe('Sidebar engine marks', () => {
  afterEach(cleanup);
  const claude = { sessionId: 'c1', account: 'a' as const, cwd: '/w', projectDir: '/p', file: '/f', title: 'claude chat', lastModified: stamp(), sizeBytes: 1 };
  const codex = { sessionId: 'g1', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w', projectDir: '', file: '', title: 'codex chat', lastModified: stamp(), sizeBytes: 1 };
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [claude, codex] }];
  const markOf = (title: string) => screen.getByText(title).closest('li')!.querySelector('.meta-engine');

  it('Claude rows carry no engine mark; other engines get a small glyph at the start of line 2, never on the avatar', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(markOf('claude chat')).toBeNull();
    expect(markOf('codex chat')?.classList.contains('codex')).toBe(true);
    expect(markOf('codex chat')?.parentElement?.classList.contains('session-meta')).toBe(true);
    expect(markOf('codex chat')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.row-avatar .meta-engine, .row-avatar .engine-mark')).toBeNull();
    const title = screen.getByText('claude chat');
    expect(title.classList.contains('session-title')).toBe(true);
    expect(title.children).toHaveLength(0);
    expect(screen.getByText('claude chat').closest('li')!.querySelector('.session-meta')?.textContent).not.toMatch(/^[ABC] · /);
  });

  it('pinned and Desktop Claude rows stay unmarked; the status mark sits at the row end', () => {
    const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk chat', cwd: '/d', project: 'd', lastModified: stamp() }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['c1']} onTogglePin={noop}
      desktop={desktop} unread={['g1']} activity={[{ sessionId: 'c1', cwd: '/w', turnId: 't', running: true, bg: 0, forMs: 0 }]} />);
    expect(screen.getByTestId('pinned-group').querySelector('.meta-engine')).toBeNull();
    expect(markOf('desk chat')).toBeNull();
    expect(screen.getByText('codex chat').closest('li')!.querySelector('.row-open > .row-status.unread')).not.toBeNull();
    expect(screen.getByText('claude chat').closest('li')!.querySelector('.row-open > .row-status.running')).not.toBeNull();
  });

  it('marks 대화 내용 search hits by engine; Gemini gets none', async () => {
    const hit = (id: string, engine: 'claude' | 'codex' | 'gemini') => ({ sessionId: id, title: `hit ${id}`, cwd: '/w', account: 'a', engine, lastModified: Date.now(), role: 'assistant' as const, snippet: 'abc', matchStart: 0, matchLength: 2 });
    const searchFn = vi.fn(async () => ({ hits: [hit('h1', 'claude'), hit('h2', 'codex'), hit('h3', 'gemini')], truncated: false }));
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenHit={noop} searchFn={searchFn} />);
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'ab' } });
    await waitFor(() => expect(screen.getByText('hit h2')).toBeTruthy());
    expect(screen.getByText('hit h1').querySelector('.engine-mark')?.getAttribute('title')).toBe('Claude');
    expect(screen.getByText('hit h2').querySelector('.engine-mark')?.getAttribute('title')).toBe('Codex (GPT)');
    expect(screen.getByText('hit h3').querySelector('.engine-mark')?.getAttribute('title')).toBe('Gemini');
  });
});

describe('Sidebar: Desktop parity (새 세션, avatar menu, empty copy, menu keyboard, 삭제 reasons)', () => {
  afterEach(cleanup);
  const e = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...extra });

  it('새 세션 is the first item of the head\'s + menu and calls onNewChat; the foot keeps only the avatar', () => {
    const onNewChat = vi.fn();
    const { container } = render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onNewChat={onNewChat} onOpenSettings={noop} />);
    const foot = container.querySelector('.sidebar')!.lastElementChild!;
    expect(foot.className).toBe('sidebar-foot');
    expect(Array.from(foot.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['설정 및 계정']);
    const plus = screen.getByRole('button', { name: '새 세션' });
    expect(container.querySelector('.sidebar-head')!.contains(plus)).toBe(true);
    expect(plus.getAttribute('aria-haspopup')).toBe('menu');
    openNewMenu();
    expect(screen.getAllByRole('menuitem')[0]!.textContent).toMatch(/^새 세션/);
    fireEvent.click(screen.getByRole('menuitem', { name: /^새 세션/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('the empty list points at 폴더 열기 / 새 세션, not a config file', () => {
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const text = document.querySelector('.sidebar-empty')!.textContent!;
    expect(text).toContain('새 세션');
    expect(text.indexOf('폴더 열기')).toBeGreaterThan(-1);
    expect(text.indexOf('폴더 열기')).toBeLessThan(text.indexOf('새 세션')); // no folder yet: picking one comes first
    expect(text).not.toContain('projects.json');
  });

  it('avatar (bottom left) opens 설정 및 계정: header, items with hints, keyboard, Esc back to the avatar', () => {
    const settings = vi.fn();
    const usage = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onNewChat={noop} avatar="B" avatarTitle="deck · 계정 B"
      footMenu={[{ label: '설정', hint: '⌘,', run: settings }, { label: '사용량 기록', run: usage }]} />);
    const avatar = screen.getByRole('button', { name: '설정 및 계정' });
    expect(avatar.textContent).toBe('B');
    expect(avatar.getAttribute('aria-haspopup')).toBe('menu');
    expect(avatar.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(avatar);
    expect(avatar.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: '설정 및 계정' });
    expect(menu.querySelector('.foot-menu-head')?.textContent).toBe('deck · 계정 B');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['설정⌘,', '사용량 기록', DECK_VERSION_LINE]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(avatar);
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole('menuitem', { name: /사용량 기록/ }));
    expect(usage).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the avatar menu ends with "deck v…": an information row (aria-disabled) that closes nothing and runs nothing', () => {
    const settings = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} footMenu={[{ label: '설정', run: settings }]} />);
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    const items = screen.getAllByRole('menuitem');
    const version = items.at(-1)!;
    expect(version).toBe(screen.getByTestId('foot-menu-version'));
    // Under vitest there is no __DECK_VERSION__; the build has `deck v<package.json version>`.
    expect(DECK_VERSION_LINE).toMatch(/^AI-MSG (v\d+\.\d+\.\d+|개발 모드)$/);
    expect(version.textContent).toBe(DECK_VERSION_LINE);
    expect(version.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(version);
    expect(screen.getByRole('menu', { name: '설정 및 계정' })).toBeTruthy();
    expect(settings).not.toHaveBeenCalled();
  });

  it('without footMenu the avatar menu still offers 설정 (onOpenSettings)', () => {
    const settings = vi.fn();
    render(<Sidebar projects={[]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: '설정 및 계정' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /설정/ }));
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it('⋯ menu: first item focused, ↑/↓ rove (wrapping), Esc closes and refocuses ⋯', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [e('s1', 'one')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} onArchive={noop} onTogglePin={noop} onDelete={noop} />);
    const more = screen.getByLabelText('세션 메뉴');
    fireEvent.click(more);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((b) => b.textContent)).toEqual(['이름 바꾸기', '새 탭에서 열기', '맨 위에 고정', '보관', '삭제…']);
    expect(document.activeElement).toBe(items[0]);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[4]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('삭제 stays visible but disabled, with the reason, for GPT / Gemini / Codex-app sessions', () => {
    const onDelete = vi.fn();
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [
      e('i1', 'imported', { account: 'gpt', engine: 'codex', imported: true }),
      e('g1', 'gpt', { account: 'gpt', engine: 'codex' }),
      e('m1', 'gem', { engine: 'gemini' }),
      e('c1', 'claude'),
    ] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onDelete={onDelete} />);
    const del = (title: string) => {
      fireEvent.click(screen.getByText(title).closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
      const b = screen.getByRole('menuitem', { name: '삭제…' });
      return b;
    };
    const imported = del('imported');
    expect(imported.getAttribute('aria-disabled')).toBe('true');
    expect(imported.getAttribute('title')).toBe('Codex 앱 기록은 AI-MSG에서 지울 수 없어요');
    // touch screens show no tooltip: the reason is also on screen, under the item
    expect(imported.querySelector('.menu-note')?.textContent).toBe('Codex 앱 기록은 AI-MSG에서 지울 수 없어요');
    expect(imported.getAttribute('aria-describedby')).toBe(imported.querySelector('.menu-note')!.id);
    fireEvent.click(imported);
    expect(onDelete).not.toHaveBeenCalled();
    expect(del('gpt').getAttribute('title')).toContain('GPT');
    expect(del('gem').getAttribute('title')).toContain('Gemini');
    const claude = del('claude');
    expect(claude.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(claude);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'c1' }), undefined);
  });
});

describe('Sidebar rows: list rows (avatar, title + time, meta, ⋯ on demand)', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const s = (id: string, cwd: string, title: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, account: 'b' as const, cwd, projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...extra });
  const projects = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first')] }];
  const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk chat', cwd: '/d', project: 'd', lastModified: stamp() }];

  it('open button (avatar · title / meta · one status mark) then ⋯ alone; nothing sits on the avatar', () => {
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onTogglePin={noop} onRename={noop}
      desktop={desktop} unread={['s1']} openPanes={new Map([['s1', 1]])} />);
    for (const title of ['first', 'desk chat']) {
      const li = screen.getByText(title).closest('li')!;
      expect(Array.from(li.children).map((el) => el.className.split(' ')[0])).toEqual(['row-open', 'row-end']);
      const open = li.querySelector('.row-open')!;
      expect(open.tagName).toBe('BUTTON');
      expect(open.getAttribute('aria-haspopup')).toBeNull(); // the ⋯ menu's trigger is ⋯, not the row
      const kids = Array.from(open.children).map((el) => el.className.split(' ')[0]);
      expect(kids.slice(0, 2)).toEqual(['row-avatar', 'row-text']);
      expect(kids.slice(2).every((k) => k === 'row-status' || k === 'sr-only')).toBe(true);
      const text = open.querySelector('.row-text')!;
      expect(Array.from(text.children).map((el) => el.className.split(' ')[0])).toEqual(['session-title', 'session-meta']);
      expect(Array.from(open.querySelectorAll('.row-avatar > *')).map((el) => el.className)).toEqual(['avatar-mono']);
      // ⋯ only (pinning is in its menu); hidden it stays in the tab order
      const btns = Array.from(li.querySelectorAll('.row-end button'));
      expect(btns.map((b) => b.getAttribute('aria-label'))).toEqual(['세션 메뉴']);
      expect(btns[0]!.getAttribute('tabindex')).toBeNull();
    }
    const first = screen.getByText('first').closest('li')!;
    // Unread wins the one slot; the split it is open in is still in the mark's label.
    expect(first.querySelector('.row-open > .row-status.unread')?.getAttribute('aria-label')).toBe('안 읽음 · 1번 칸에 열림');
    expect(first.querySelector('.open-mark')).toBeNull();
    expect(first.querySelector('.session-meta')!.textContent).toBe('one');
    // The letter is decoration (the title and meta name session and project): hidden from the accessibility tree, nothing else in the circle.
    const mono = first.querySelector('.row-avatar > .avatar-mono')!;
    expect(mono.getAttribute('aria-hidden')).toBe('true');
    expect(first.querySelector('.row-avatar')!.textContent).toBe('F'); // the title's first letter, no badge
    expect(first.getAttribute('title')).toMatch(/^first\none · /);
  });

  it('line 2 shows the last reply when the server has one, else the project', () => {
    const withPreview = { ...s('p1', '/w/one', 'chat'), preview: 'Tests  pass,\n ready to merge' };
    render(<Sidebar projects={[{ cwd: '/w/one', name: 'one', pinned: false, sessions: [withPreview, s('p2', '/w/one', 'plain')] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.getByText('chat').closest('li')!.querySelector('.meta-text')?.textContent).toBe('Tests pass, ready to merge');
    expect(screen.getByText('plain').closest('li')!.querySelector('.meta-text')?.textContent).toBe('one');
  });

  it('screen readers get what the tooltip says: folder (when a preview hides it), engine, 자동 실행, time — in the button', () => {
    const e = { sessionId: 'x1', account: 'gpt' as const, engine: 'codex' as const, cwd: '/w/one', projectDir: '/r', file: '/r/f', title: 'lane', lastModified: Date.now() - 120_000, sizeBytes: 1, imported: true, codexExec: true, preview: 'all done' };
    render(<Sidebar projects={[{ cwd: '/w/one', name: 'one', pinned: false, sessions: [e, s('p2', '/w/one', 'plain')] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const spoken = screen.getByText('lane').closest('li')!.querySelector('.row-open > .sr-only')!.textContent!;
    for (const f of ['one', 'Codex (GPT)', '자동 실행', '2분 전']) expect(spoken).toContain(f);
    // Without a preview line 2 already says the folder: not repeated.
    expect(screen.getByText('plain').closest('li')!.querySelector('.row-open > .sr-only')!.textContent).not.toContain('one');
  });

  it('a Grok Bot roster waiting on the user shows the warn mark, labelled 답장 대기', () => {
    const bot = { ...s('g1', '/w/one', 'bot chat'), source: 'grokbot' as const, grokBot: { awaitingUserResponse: true, unreadCount: 2, isGroup: false } };
    render(<Sidebar projects={[{ cwd: '/w/one', name: 'one', pinned: false, sessions: [bot] }]} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const mark = screen.getByText('bot chat').closest('li')!.querySelector('.row-status')!;
    expect(mark.className).toBe('row-status waiting');
    expect(mark.getAttribute('aria-label')).toBe('답장 대기 · 안 읽음 2');
  });

  it('the status mark steps aside for ⋯ by opacity only: hidden by visibility it would drop out of the button\'s name', () => {
    const css = readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
    const rules = css.split('}').filter((r) => r.includes('.row-status') && /visibility:\s*hidden/.test(r));
    expect(rules).toEqual([]);
  });

  it('avatar colour: the same slug always gets the same palette slot, in 1 … AVATAR_COLORS, on every row of that project', () => {
    const slugs = ['deck', 'my-app', 'one', 'two', '.dotfiles', '한글 프로젝트', 'x', ''];
    for (const slug of slugs) {
      const n = avatarIndex(slug);
      expect(n).toBe(avatarIndex(slug));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(AVATAR_COLORS);
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(avatarIndex)).size).toBeGreaterThan(3); // spread, not one colour
    const two = [{ cwd: '/w/deck', name: 'deck', pinned: false, sessions: [s('a1', '/w/deck', 'alpha'), s('a2', '/w/deck', 'beta')] }];
    render(<Sidebar projects={two} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const av = (t: string) => screen.getByText(t).closest('li')!.querySelector<HTMLElement>('.row-avatar')!;
    expect(av('alpha').dataset.avatar).toBe(String(avatarIndex('deck')));
    expect(av('alpha').style.getPropertyValue('--av')).toBe(`var(--avatar-${avatarIndex('deck')})`);
    expect(av('beta').dataset.avatar).toBe(av('alpha').dataset.avatar);
  });

  it('the session head shows the row\'s own avatar (the sidebar shares colour + letters, two-letter clashes included)', () => {
    const ids = ['hd0', 'hd1'];
    const one = [{ cwd: '/w/deck', name: 'deck', pinned: false, sessions: [s(ids[0]!, '/w/deck', '백테스트 A'), s(ids[1]!, '/w/deck', '백업 B')] }];
    const groups = () => [[<button key="x" type="button">x</button>]];
    render(<><Sidebar projects={one} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />
      {ids.map((id) => <div key={id} data-head={id}><SessionChipHead title={`head ${id}`} sessionKey={id} cwd="/w/deck" groups={groups} /></div>)}</>);
    const mono = (el: Element) => el.querySelector('.avatar-mono')!.textContent;
    const rowOf = (t: string) => screen.getByText(t, { selector: '.session-title' }).closest('li')!.querySelector<HTMLElement>('.row-avatar')!;
    const heads = ids.map((id) => document.querySelector<HTMLElement>(`[data-head="${id}"] .head-avatar`)!);
    ['백테스트 A', '백업 B'].forEach((t, k) => {
      expect(heads[k]!.dataset.avatar).toBe(rowOf(t).dataset.avatar);
      expect(mono(heads[k]!)).toBe(mono(rowOf(t)));
    });
    expect([mono(heads[0]!), mono(heads[1]!)]).toEqual(['백테', '백업']); // the clash took two letters on both, and the head followed
  });

  it('avatar letters on the row: every clashing row of a project (pinned or below) takes two; a reorder or a search moves none', () => {
    const pinIds = ['p0', 'p1', 'p2'];
    const sessions = [
      s('p0', '/w/dev', 'paper a'), s('p1', '/w/dev', 'pine b'), s('p2', '/w/dev', 'zeta'),
      s('r0', '/w/dev', 'keep a'), s('o1', '/w/dev', 'drop b'), s('r1', '/w/dev', 'kale c'), s('r2', '/w/dev', 'kilo d'), s('r3', '/w/dev', 'zoo e'),
    ];
    const p = [{ cwd: '/w/dev', name: 'dev', pinned: false, sessions }];
    const view = (pins = pinIds) => <Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={pins} onTogglePin={noop} />;
    const { rerender } = render(view());
    const mono = (t: string) => screen.getByText(t).closest('li')!.querySelector('.avatar-mono')!.textContent;
    // A pinned Z and a Z below clash too; D has no twin.
    const rows = ['paper a', 'pine b', 'zeta', 'keep a', 'drop b', 'kale c', 'kilo d', 'zoo e'];
    const before = rows.map(mono);
    expect(before).toEqual(['Pa', 'Pi', 'Ze', 'Ke', 'D', 'Ka', 'Ki', 'Zo']);
    rerender(view([...pinIds].reverse()));
    expect(rows.map(mono)).toEqual(before);
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'k' } });
    expect(['keep a', 'kale c', 'kilo d'].map(mono)).toEqual([before[3], before[5], before[6]]);
  });

  it('직접 고르기: tapping the avatar opens the picker without opening the session; a choice calls back, renders, and resets', () => {
    const onOpen = vi.fn();
    const onSetSessionIcon = vi.fn();
    const p = [{ cwd: '/w/dev', name: 'dev', pinned: false, sessions: [s('s1', '/w/dev', 'fx backtest')] }];
    const view = (icons: Record<string, string>) => <Sidebar projects={p} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} sessionIcons={icons} onSetSessionIcon={onSetSessionIcon} />;
    const { rerender } = render(view({}));
    const li = screen.getByText('fx backtest').closest('li')!;
    expect(li.querySelector('.avatar-mono')!.textContent).toBe('F');
    const pick = within(li).getByRole('button', { name: '아이콘 바꾸기' });
    fireEvent.click(pick);
    expect(onOpen).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: '세션 아이콘' });
    fireEvent.click(within(dialog).getByRole('button', { name: '🚀' }));
    expect(onSetSessionIcon).toHaveBeenCalledWith('s1', '🚀');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pick);
    rerender(view({ s1: '🚀' }));
    expect(li.querySelector('[data-testid="avatar-emoji"]')!.textContent).toBe('🚀');
    expect(li.querySelector('.avatar-mono')).toBeNull();
    // A line glyph from the second section.
    fireEvent.click(pick);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'leaf' }));
    expect(onSetSessionIcon).toHaveBeenLastCalledWith('s1', 'glyph:leaf');
    rerender(view({ s1: 'glyph:leaf' }));
    expect(li.querySelector('.row-avatar svg')!.getAttribute('data-icon')).toBe('leaf');
    // Reset, Esc and an outside press.
    fireEvent.click(pick);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '기본으로 (첫 글자)' }));
    expect(onSetSessionIcon).toHaveBeenLastCalledWith('s1', null);
    rerender(view({}));
    expect(li.querySelector('.avatar-mono')!.textContent).toBe('F');
    fireEvent.click(pick);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pick);
    fireEvent.click(pick);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSetSessionIcon).toHaveBeenCalledTimes(3);
  });

  it('a 갈래 tree keeps one icon, under its entry: the pinned version and the tree row both read and set the root\'s', () => {
    const onSetSessionIcon = vi.fn();
    const now = Date.now();
    const sessions = [s('b0', '/w/dev', 'tree', { lastModified: now - 60_000 }), s('b1', '/w/dev', 'tree', { lastModified: now, branch: { parent: 'b0', n: 1 } })];
    const p = [{ cwd: '/w/dev', name: 'dev', pinned: false, sessions }];
    const ids = ['b0', 'b1'];
    render(<><Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['b1']} onTogglePin={noop} sessionIcons={{ b0: '🚀' }} onSetSessionIcon={onSetSessionIcon} />
      {ids.map((id) => <div key={id} data-head={id}><SessionChipHead title="tree" sessionKey={id} cwd="/w/dev" groups={() => [[<button key="x" type="button">x</button>]]} /></div>)}</>);
    const rows = screen.getAllByText('tree', { selector: '.session-title' }).map((t) => t.closest('li')!);
    expect(rows).toHaveLength(2); // 고정됨 (b1) and the tree row (b0, opening b1)
    for (const li of rows) {
      expect(li.querySelector('[data-testid="avatar-emoji"]')!.textContent).toBe('🚀');
      fireEvent.click(within(li).getByRole('button', { name: '아이콘 바꾸기' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: '세션 아이콘' })).getByRole('button', { name: '🧪' }));
      expect(onSetSessionIcon).toHaveBeenLastCalledWith('b0', '🧪');
    }
    for (const id of ids) {
      expect(document.querySelector(`[data-head="${id}"] [data-testid="avatar-emoji"]`)!.textContent).toBe('🚀');
      fireEvent.click(within(document.querySelector<HTMLElement>(`[data-head="${id}"]`)!).getByRole('button', { name: '아이콘 바꾸기' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: '세션 아이콘' })).getByRole('button', { name: '☕' }));
      expect(onSetSessionIcon).toHaveBeenLastCalledWith('b0', '☕');
    }
  });

  it('a re-render with the same data notifies no avatar subscriber', () => {
    const p = [{ cwd: '/w/dev', name: 'dev', pinned: false, sessions: [s('s1', '/w/dev', 'alpha'), s('s2', '/w/dev', 'apple')] }];
    const setIcon = vi.fn();
    const icons = { s1: '🚀' };
    let renders = 0;
    function Probe() { useSessionAvatar('s1'); useSessionIconStore(); renders++; return null; }
    const view = () => <><Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} sessionIcons={icons} onSetSessionIcon={setIcon} /><Probe /></>;
    const { rerender } = render(view());
    const after = renders;
    rerender(view());
    rerender(view());
    expect(renders).toBe(after + 2); // its own two renders from the parent, nothing from the store
  });

  it('no picker without onSetSessionIcon', () => {
    const p = [{ cwd: '/w/dev', name: 'dev', pinned: false, sessions: [s('s1', '/w/dev', 'alpha')] }];
    render(<Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    expect(screen.queryByRole('button', { name: '아이콘 바꾸기' })).toBeNull();
  });

  it('승인 대기: a warn mark at the row end, ahead of running / unread; screen readers get it from its label', () => {
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'asks'), s('s2', '/w/one', 'runs')] }];
    render(<Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} waiting={['s1']} unread={['s1']}
      activity={[{ sessionId: 's1', cwd: '/w/one', turnId: 't', running: true, bg: 0, forMs: 0 }, { sessionId: 's2', cwd: '/w/one', turnId: 't2', running: true, bg: 0, forMs: 0 }]} />);
    const dots = (t: string) => Array.from(screen.getByText(t).closest('li')!.querySelectorAll('.row-status'));
    expect(dots('asks')).toHaveLength(1);
    expect(dots('asks')[0]!.classList.contains('waiting')).toBe(true);
    expect(dots('asks')[0]!.getAttribute('aria-label')).toBe('승인 대기 · 응답 중 · 안 읽음');
    expect(screen.getByText('asks').closest('li')!.querySelector('.session-meta')?.textContent).toBe('one');
    expect(dots('runs')[0]!.classList.contains('running')).toBe(true);
  });

  it('touch: a long press on a row shows its ⋯ (one row at a time) and does not open it; a short tap opens', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first'), s('s2', '/w/one', 'second')] }];
    render(<Sidebar projects={p} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} onTogglePin={noop} onRename={noop} />);
    const li = (t: string) => screen.getByText(t).closest('li')!;
    const touch = (el: Element) => fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
    expect(li('first').hasAttribute('data-revealed')).toBe(false);
    touch(screen.getByText('first'));
    act(() => { vi.advanceTimersByTime(ROW_PRESS_MS - 1); });
    expect(li('first').hasAttribute('data-revealed')).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(li('first').hasAttribute('data-revealed')).toBe(true);
    fireEvent.pointerUp(screen.getByText('first'), { pointerType: 'touch', pointerId: 1 });
    fireEvent.click(screen.getByText('first'));
    expect(onOpen).not.toHaveBeenCalled(); // the click ending the long press is swallowed
    // Its ⋯ works from there (the menu keeps the .session-menu class).
    fireEvent.click(within(li('first')).getByLabelText('세션 메뉴'));
    expect(screen.getByRole('menu').classList.contains('session-menu')).toBe(true);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // A long press on another row moves the reveal there.
    touch(screen.getByText('second'));
    expect(li('first').hasAttribute('data-revealed')).toBe(false);
    act(() => { vi.advanceTimersByTime(ROW_PRESS_MS); });
    expect(li('second').hasAttribute('data-revealed')).toBe(true);
    fireEvent.pointerUp(screen.getByText('second'), { pointerType: 'touch', pointerId: 1 });
    fireEvent.click(screen.getByText('second'));
    // A short tap opens as before.
    touch(screen.getByText('first'));
    fireEvent.pointerUp(screen.getByText('first'), { pointerType: 'touch', pointerId: 1 });
    fireEvent.click(screen.getByText('first'));
    expect(onOpen).toHaveBeenCalledWith('s1', '/w/one', 'first');
    // A mouse press never reveals (hover does that).
    fireEvent.pointerDown(screen.getByText('first'), { pointerType: 'mouse', pointerId: 2 });
    act(() => { vi.advanceTimersByTime(ROW_PRESS_MS * 2); });
    expect(li('first').hasAttribute('data-revealed')).toBe(false);
  });

  it('보관됨 N: folded at the end of the list; pressing it lists the archived rows newest first, pressing again folds', () => {
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'live'), s('s2', '/w/one', 'old a', { archived: true }), s('s3', '/w/one', 'old b', { archived: true })] }];
    const { container } = render(<Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onArchive={noop} onOpenSettings={noop} />);
    const group = screen.getByTestId('archived-group');
    // Last in the list (only the foot after it).
    const sections = Array.from(container.querySelectorAll('.sidebar > section'));
    expect(sections[sections.length - 1]).toBe(group);
    const toggle = within(group).getByRole('button', { name: '보관됨 2' });
    expect(group.querySelectorAll('li')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(Array.from(group.querySelectorAll('.session-title')).map((e) => e.textContent)).toEqual(['old a', 'old b']);
    fireEvent.click(toggle);
    expect(group.querySelectorAll('li')).toHaveLength(0);
    // A search narrows the count; no match there and the row steps aside.
    openSearch();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'old b' } });
    expect(within(screen.getByTestId('archived-group')).getByRole('button', { name: '보관됨 1' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('세션 검색'), { target: { value: 'live' } });
    expect(screen.queryByTestId('archived-group')).toBeNull();
  });

  it('head: brand, 검색 opens / closes the box (Esc too, clearing it, focus back on 검색) with a 명령 팔레트 button', () => {
    const onOpenPalette = vi.fn();
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first')] }];
    const { container } = render(<Sidebar projects={p} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onOpenPalette={onOpenPalette} onOpenFolder={noop} />);
    const brand = container.querySelector('.sidebar-head .sidebar-brand')!;
    expect(brand.textContent).toBe('AI-MSG');
    expect(brand.querySelector('svg.brand-mark')).not.toBeNull();
    expect(screen.queryByLabelText('세션 검색')).toBeNull();
    openSearch();
    const box = screen.getByLabelText('세션 검색');
    expect(document.activeElement).toBe(box);
    const searchBtn = screen.getByRole('button', { name: '검색' });
    expect(searchBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '명령 팔레트' }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: 'zzz' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('세션 검색')).toBeNull();
    expect(document.activeElement).toBe(searchBtn);
    expect(screen.getByText('first')).toBeTruthy(); // the filter went with it
  });

  it('+ menu: 새 세션 ⌘N · 폴더 열기… | 지금 프로젝트 + 최근 폴더 3 (each a new session there) | 세션 목록 다시 읽기; focus back on +', () => {
    const onNew = vi.fn();
    const onRefresh = vi.fn();
    const proj = (name: string, age: number) => ({ cwd: `/w/${name}`, name, pinned: false, sessions: [s(`${name}1`, `/w/${name}`, `${name} chat`, { lastModified: Date.now() - age * 60_000 })] });
    // here = c (the current session's), the rest by their newest session: a, e, b; d is the oldest and left out.
    const p = [proj('a', 1), proj('b', 30), proj('c', 50), proj('d', 90), proj('e', 10)];
    render(<Sidebar projects={p} currentSessionId="c1" onOpen={noop} onNew={onNew} onRefresh={onRefresh} onNewChat={noop} onOpenFolder={noop} />);
    const plus = screen.getByRole('button', { name: '새 세션' });
    openNewMenu();
    const menu = screen.getByRole('menu', { name: '새 세션' });
    const parts = Array.from(menu.children).map((el) => (el.getAttribute('role') === 'separator' ? '|' : el.getAttribute('aria-label') ?? el.textContent));
    expect(parts).toEqual(['새 세션Ctrl+N', '폴더 열기…', '|', 'c 새 세션 (지금 프로젝트)', 'a 새 세션', 'e 새 세션', 'b 새 세션', '|', '세션 목록 다시 읽기']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'e 새 세션' }));
    expect(onNew).toHaveBeenCalledWith('/w/e', 'e');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(plus);
    openNewMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '세션 목록 다시 읽기' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(plus);
  });

  it('rows open from the keyboard: each is a button in the tab order; the current one says aria-current', () => {
    const onOpen = vi.fn();
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first'), s('s2', '/w/one', 'second')] }];
    render(<Sidebar projects={p} currentSessionId="s2" onOpen={onOpen} onNew={noop} onRefresh={noop} onRename={noop} />);
    const btn = (t: string) => screen.getByText(t).closest('button.row-open') as HTMLButtonElement;
    expect(btn('first').getAttribute('type')).toBe('button');
    expect(btn('first').getAttribute('aria-current')).toBeNull();
    expect(btn('second').getAttribute('aria-current')).toBe('page');
    btn('first').focus();
    expect(document.activeElement).toBe(btn('first'));
    // Enter / Space on a <button> fire its click (detail 0).
    fireEvent.click(btn('first'), { detail: 0 });
    expect(onOpen).toHaveBeenCalledWith('s1', '/w/one', 'first');
  });

  it('a shown ⋯ hides again on a press outside its row, a scroll of the list, opening a session or a new list', () => {
    vi.useFakeTimers();
    const p = [{ cwd: '/w/one', name: 'one', pinned: false, sessions: [s('s1', '/w/one', 'first'), s('s2', '/w/one', 'second')] }];
    const pinShortcut = { current: (_: number) => false };
    const props = { currentSessionId: null, onOpen: noop, onNew: noop, onRefresh: noop, onRename: noop, onTogglePin: noop, pins: ['s2'], pinShortcut };
    const { container, rerender } = render(<Sidebar projects={p} {...props} />);
    const li = () => screen.getByText('first').closest('li')!;
    const reveal = () => {
      fireEvent.pointerDown(screen.getByText('first'), { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(ROW_PRESS_MS); });
      fireEvent.pointerUp(screen.getByText('first'), { pointerType: 'touch', pointerId: 1 });
      fireEvent.click(screen.getByText('first')); // the click ending the long press (swallowed)
      expect(li().hasAttribute('data-revealed')).toBe(true);
    };
    reveal();
    fireEvent.pointerDown(li()); // inside the row: stays
    expect(li().hasAttribute('data-revealed')).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(li().hasAttribute('data-revealed')).toBe(false);
    reveal();
    fireEvent.scroll(container.querySelector('.sidebar')!);
    expect(li().hasAttribute('data-revealed')).toBe(false);
    reveal();
    act(() => { pinShortcut.current(0); });
    expect(li().hasAttribute('data-revealed')).toBe(false);
    reveal();
    rerender(<Sidebar projects={[...p]} {...props} />);
    expect(li().hasAttribute('data-revealed')).toBe(false);
  });
});

describe('Sidebar ⋯ 분할 보기로 열기', () => {
  afterEach(cleanup);
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one')] }];
  const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk', cwd: '/d', project: 'dp', lastModified: stamp() }];

  it('sits after 이름 바꾸기 and opens the row in a split; a Desktop row offers it too', () => {
    const onOpenSplit = vi.fn();
    const onOpen = vi.fn();
    render(<Sidebar projects={projects} desktop={desktop} currentSessionId={null} onOpen={onOpen} onNew={noop} onRefresh={noop} onRename={noop} onTogglePin={noop} onOpenSplit={onOpenSplit} />);
    fireEvent.click(screen.getByText('one').closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['이름 바꾸기', '분할 보기로 열기', '새 탭에서 열기', '맨 위에 고정']);
    fireEvent.click(screen.getByRole('menuitem', { name: '분할 보기로 열기' }));
    expect(onOpenSplit).toHaveBeenCalledWith('s1', '/w', 'one');
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByText('desk').closest('li')!.querySelector('[aria-label="세션 메뉴"]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: '분할 보기로 열기' }));
    expect(onOpenSplit).toHaveBeenLastCalledWith('d1', '/d', 'desk');
  });

  it('all panes in use: shown disabled with the reason; absent without onOpenSplit', () => {
    const onOpenSplit = vi.fn();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} onOpenSplit={onOpenSplit} splitBlocked="최대 5개" />);
    fireEvent.click(screen.getByLabelText('세션 메뉴'));
    const item = screen.getByRole('menuitem', { name: '분할 보기로 열기' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('최대 5개');
    fireEvent.click(item);
    expect(onOpenSplit).not.toHaveBeenCalled();
    cleanup();
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} onRename={noop} />);
    fireEvent.click(screen.getByLabelText('세션 메뉴'));
    expect(screen.queryByRole('menuitem', { name: '분할 보기로 열기' })).toBeNull();
  });
});

describe('Sidebar open-session markers', () => {
  afterEach(cleanup);
  const s = (id: string, title: string) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1 });
  const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'first'), s('s2', 'second'), s('s3', 'third'), s('s4', 'fourth')] }];
  const rowOf = (container: HTMLElement, title: string) => [...container.querySelectorAll('li')].find((li) => li.querySelector('.session-title')?.textContent === title)!;
  const mark = (container: HTMLElement, title: string) => rowOf(container, title).querySelector('.open-mark');

  it('marks every open session with its split number (◱ for a card), not just the focused one; the rest stay unmarked', () => {
    const openPanes = new Map<string, number | 'float'>([['s3', 1], ['s1', 2], ['s4', 'float']]);
    const { container } = render(<Sidebar projects={projects} currentSessionId="s1" onOpen={noop} onNew={noop} onRefresh={noop} openPanes={openPanes} />);
    expect(mark(container, 'third')?.textContent).toBe('1');
    expect(mark(container, 'first')?.textContent).toBe('2');
    expect(mark(container, 'fourth')?.textContent).toBe('◱');
    expect(mark(container, 'second')).toBeNull();
    expect(container.querySelectorAll('.open-mark')).toHaveLength(3);
    // The focused row keeps its stronger highlight and carries the marker too; other open rows are not highlighted.
    expect(rowOf(container, 'first').classList.contains('active')).toBe(true);
    expect(rowOf(container, 'third').classList.contains('active')).toBe(false);
  });

  it('names where the session is open (aria-label and tooltip)', () => {
    const openPanes = new Map<string, number | 'float'>([['s2', 3], ['s4', 'float']]);
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} openPanes={openPanes} />);
    const split = screen.getByRole('img', { name: '3번 칸에 열림' });
    expect(split.getAttribute('title')).toBe('3번 칸에 열림');
    expect(split.textContent).toBe('3');
    expect(screen.getByRole('img', { name: '떠 있는 카드에 열림' }).textContent).toBe('◱');
  });

  it('a pinned (and a Desktop) row is marked too; no openPanes = no markers', () => {
    const desktop = [{ sessionId: 'd1', account: 'a' as const, title: 'desk', cwd: '/elsewhere', project: 'elsewhere', lastModified: stamp() }];
    const openPanes = new Map<string, number | 'float'>([['s2', 1], ['d1', 2]]);
    const { container, rerender } = render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s2']} onTogglePin={noop} desktop={desktop} openPanes={openPanes} />);
    expect(screen.getByTestId('pinned-group').querySelector('.open-mark')?.textContent).toBe('1');
    expect(screen.getByText('desk').closest('li')!.querySelector('.open-mark')?.textContent).toBe('2');
    rerender(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s2']} onTogglePin={noop} desktop={desktop} />);
    expect(container.querySelectorAll('.open-mark')).toHaveLength(0);
  });
});

describe('Sidebar UX polish: status marks, 칸 번호, same titles, 고정됨 folding', () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  const s = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title, lastModified: stamp(), sizeBytes: 1, ...extra });
  const css = readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

  it('nothing spins: 응답 중 pulses (stopped under reduced motion), 백그라운드 is a still hollow circle', () => {
    expect(css).not.toMatch(/row-spin/);
    expect(css).toMatch(/\.row-status\.running::before \{[^}]*animation: row-pulse/);
    expect(css).toMatch(/\.row-status\.bg::before \{[^}]*border: 1\.5px solid var\(--muted\)/);
    expect(css.match(/\.row-status\.bg::before \{[^}]*\}/)![0]).not.toMatch(/animation/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .sidebar .row-end'));
    expect(reduced.slice(0, reduced.indexOf('\n}'))).toMatch(/\.row-status\.running::before \{ animation: none; \}/);
  });

  it('the open-pane number is a 칸 number (outlined square, "N번 칸에 열림"), not a count', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'one')] }];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} openPanes={new Map([['s1', 1]])} />);
    const mark = screen.getByRole('img', { name: '1번 칸에 열림' });
    expect(mark.getAttribute('title')).toBe('1번 칸에 열림');
    expect(mark.textContent).toBe('1');
    expect(css).toMatch(/\.row-status\.open \{[^}]*box-shadow: inset 0 0 0 1px var\(--line-strong\)/);
  });

  it('two rows with the same title lead line 2 with their folder; a unique title does not', () => {
    const projects = [
      { cwd: '/a/alpha', name: 'alpha', pinned: false, sessions: [s('s1', 'Same', { cwd: '/a/alpha', preview: '첫 답' }), s('s3', 'Only', { cwd: '/a/alpha', preview: '혼자' })] },
      { cwd: '/b/beta', name: 'beta', pinned: false, sessions: [s('s2', 'Same', { cwd: '/b/beta', preview: '둘째 답' })] },
    ];
    render(<Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} />);
    const folders = screen.getAllByTestId('meta-folder').map((x) => x.textContent).sort();
    expect(folders).toEqual(['alpha', 'beta']);
    expect(screen.getByText('Only').closest('li')!.querySelector('[data-testid="meta-folder"]')).toBeNull();
    expect(screen.getByText('첫 답').closest('.session-meta')!.textContent).toBe('alpha·첫 답');
  });

  it('고정됨 folds from its head (open by default) and the choice is kept in the prefs', () => {
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'pinned one'), s('s2', 'other')] }];
    const view = () => <Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s1']} onTogglePin={noop} />;
    const { unmount } = render(view());
    const head = within(screen.getByTestId('pinned-group')).getByRole('button', { name: '고정됨' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('pinned one')).toBeTruthy();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('pinned one')).toBeNull();
    expect(screen.getByTestId('pinned-group').classList.contains('collapsed')).toBe(true);
    expect(JSON.parse(localStorage.getItem('deck.prefs.v1')!).pinnedFolded).toBe(true);
    unmount();
    render(view());
    expect(screen.queryByText('pinned one')).toBeNull();
    fireEvent.click(within(screen.getByTestId('pinned-group')).getByRole('button', { name: '고정됨' }));
    expect(screen.getByText('pinned one')).toBeTruthy();
  });

  it('고정됨 folded: the list stays mounted (aria-controls) but hidden, the open session keeps its row', () => {
    localStorage.setItem('deck.prefs.v1', JSON.stringify({ pinnedFolded: true }));
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'pinned one'), s('s2', 'pinned two'), s('s3', 'other')] }];
    const view = (cur: string | null) => <Sidebar projects={projects} currentSessionId={cur} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s1', 's2']} onTogglePin={noop} />;
    const { rerender } = render(view(null));
    const list = document.getElementById('pinned-list')!;
    expect(list).toBeTruthy();
    expect(list.hidden).toBe(true);
    rerender(view('s2'));
    expect(document.getElementById('pinned-list')!.hidden).toBe(false);
    expect(screen.getByText('pinned two')).toBeTruthy();
    expect(screen.queryByText('pinned one')).toBeNull();
  });

  it('고정됨 folded: the head shows the hidden pins’ highest status (승인 대기 > 안 읽음 > 응답 중)', () => {
    localStorage.setItem('deck.prefs.v1', JSON.stringify({ pinnedFolded: true }));
    const projects = [{ cwd: '/w', name: 'w', pinned: false, sessions: [s('s1', 'a'), s('s2', 'b'), s('s3', 'c')] }];
    const run = [{ sessionId: 's1', running: true, bg: 0 }] as unknown as SessionActivity[];
    const view = (extra: { waiting?: string[]; unread?: string[]; activity?: SessionActivity[] }) => <Sidebar projects={projects} currentSessionId={null} onOpen={noop} onNew={noop} onRefresh={noop} pins={['s1', 's2', 's3']} onTogglePin={noop} {...extra} />;
    const mark = () => screen.queryByTestId('pinned-folded-status');
    const { rerender } = render(view({}));
    expect(mark()).toBeNull();
    rerender(view({ activity: run }));
    expect(mark()!.className).toBe('row-status running');
    expect(mark()!.getAttribute('aria-label')).toBe('고정됨에 응답 중');
    rerender(view({ activity: run, unread: ['s2'] }));
    expect(mark()!.className).toBe('row-status unread');
    expect(mark()!.getAttribute('aria-label')).toBe('고정됨에 안 읽음');
    rerender(view({ activity: run, unread: ['s2'], waiting: ['s3'] }));
    expect(mark()!.className).toBe('row-status waiting');
    expect(mark()!.getAttribute('aria-label')).toBe('고정됨에 승인 대기');
    // Unfolded: the rows carry their own marks, the head none.
    fireEvent.click(within(screen.getByTestId('pinned-group')).getByRole('button', { name: /고정됨/ }));
    expect(mark()).toBeNull();
  });

  it('the list keeps room under its last row for the avatar foot', () => {
    expect(css).toMatch(/\.sidebar \{ scroll-padding-bottom: \d+px; \}/);
    expect(css).toMatch(/\.sidebar > section:last-of-type \{ padding-bottom: var\(--s5\); \}/);
  });
});
