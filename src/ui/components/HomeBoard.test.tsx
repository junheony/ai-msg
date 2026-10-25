// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectEntry, SessionEntry } from '../../shared/session-types';
import type { SessionActivity } from '../../shared/protocol';
import { clearHomeCache } from '../home';
import { initialState, newPane, reducer, type PendingPermission } from '../state';
import { NewChat, type NewChatHome } from './NewChat';
import { HomeLists, HomeSide, type HomeData } from './HomeBoard';
import { Pane } from './Pane';

Element.prototype.scrollIntoView = () => {};

const now = new Date(2026, 9, 25, 14, 20).getTime();
const sess = (sessionId: string, ago: number): SessionEntry =>
  ({ sessionId, account: 'a', engine: 'claude', cwd: '/w', projectDir: '/p', file: '/f', title: `t-${sessionId}`, lastModified: now - ago * 60_000, sizeBytes: 1 }) as SessionEntry;
const projects = [{ cwd: '/w', name: 'w', pinned: true, sessions: [sess('wait', 1), sess('run', 2), sess('done', 3), sess('old', 4)] }] as unknown as ProjectEntry[];
const pending = [{ sessionId: 'wait', cwd: '/w', turnId: 'p', toolName: 'Bash', title: null, requestId: 'r1', input: {}, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null }] as unknown as PendingPermission[];
const activity = [{ sessionId: 'run', cwd: '/w', turnId: 't', running: true, bg: 0, forMs: 60_000 }] as SessionActivity[];
const fixture: HomeData = { engines: [], rows: [], scanning: false };

describe('HomeLists: 모두 읽음', () => {
  afterEach(cleanup);

  it('sends every unread session the home shows — the waiting and running ones too — and the reducer drops them all', () => {
    const unread = ['wait', 'run', 'done'];
    const onMarkRead = vi.fn();
    render(<HomeLists projects={projects} activity={activity} unread={unread} pending={pending} questions={[]} pins={[]} now={now} onMarkRead={onMarkRead} />);
    fireEvent.click(screen.getByRole('button', { name: '모두 읽음' }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    const ids = onMarkRead.mock.calls[0]![0] as string[];
    expect([...ids].sort()).toEqual(['done', 'run', 'wait']);
    const after = reducer({ ...initialState, unread: [...unread, 'elsewhere'] }, { type: 'mark_read', sessionIds: ids });
    expect(after.unread).toEqual(['elsewhere']);
  });

  it('mark_read takes an id array: ids not unread are ignored, nothing to drop keeps the same state', () => {
    const s = { ...initialState, unread: ['a', 'b', 'c'] };
    expect(reducer(s, { type: 'mark_read', sessionIds: ['a', 'c', 'zz'] }).unread).toEqual(['b']);
    expect(reducer(s, { type: 'mark_read', sessionIds: ['zz'] })).toBe(s);
    expect(reducer(s, { type: 'mark_read', sessionIds: [] })).toBe(s);
  });

  it('pins show in pin order (a repeated id once) and stay out of 최근', () => {
    render(<HomeLists projects={projects} activity={[]} unread={[]} pending={[]} questions={[]} pins={['old', 'done', 'old']} now={now} />);
    const recent = screen.getByRole('region', { name: '최근' });
    const titles = Array.from(recent.querySelectorAll('.home-row-title')).map((e) => e.textContent);
    expect(titles).toEqual(['t-old', 't-done', 't-wait', 't-run']);
  });
});

describe('Home data: fetch', () => {
  beforeEach(clearHomeCache);
  afterEach(cleanup);
  const homeOf = (extra: Partial<NewChatHome> = {}): NewChatHome => ({ activity: [], unread: [], pending: [], questions: [], usage: null, ...extra });

  it('a fixture (home.data) is shown without a single fetch', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error('no')));
    render(<NewChat projects={projects} onStart={vi.fn()} now={now} fetchFn={fetchFn as unknown as typeof fetch} home={homeOf({ data: fixture })} />);
    expect(screen.getByTestId('home')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(fetchFn).toHaveBeenCalledTimes(0);
  });

  it('without a fixture it asks both endpoints once; typing in the composer asks nothing more', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ engines: [], rows: [] }), { status: 200 })));
    render(<NewChat projects={projects} onStart={vi.fn()} now={now} fetchFn={fetchFn as unknown as typeof fetch} home={homeOf()} />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('첫 메시지'), { target: { value: 'hello' } });
    await act(async () => { await Promise.resolve(); });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a setup answer that failed: Claude is shown with its status unknown, not as installed', () => {
    render(<HomeSide data={{ engines: null, rows: [], scanning: false }} usage={null} now={now} codexAvailable={false} gemini={null} grok={null} />);
    const claude = screen.getByTestId('home-provider-claude');
    expect(within(claude).getByText('상태 미상')).toBeTruthy();
    expect(within(claude).queryByText('준비됨')).toBeNull();
  });
});

describe('Home: keyboard', () => {
  afterEach(cleanup);

  it('사용량 tabs: ← / → move and select, one Tab stop, each tab controls the panel', () => {
    render(<HomeSide data={fixture} usage={null} now={now} codexAvailable={false} gemini={null} grok={null} />);
    const [today, week] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement];
    const panel = screen.getByRole('tabpanel');
    expect(today.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(today.id);
    expect([today.tabIndex, week.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(today, { key: 'ArrowRight' });
    expect(week.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(week);
    expect(panel.getAttribute('aria-labelledby')).toBe(week.id);
    fireEvent.keyDown(week, { key: 'ArrowRight' });
    expect(today.getAttribute('aria-selected')).toBe('true');
  });

  it('엔진 radiogroup: roving tabindex, ← / → pick the next engine', () => {
    const onEngine = vi.fn();
    const { rerender } = render(<NewChat projects={projects} onStart={vi.fn()} now={now} codexAvailable onEngine={onEngine} home={{ activity: [], unread: [], pending: [], questions: [], usage: null, data: fixture }} />);
    const group = screen.getByRole('radiogroup');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    expect(onEngine).toHaveBeenLastCalledWith('codex');
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[1]!, { key: 'ArrowLeft' });
    expect(onEngine).toHaveBeenLastCalledWith('claude');
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' });
    expect(onEngine).toHaveBeenLastCalledWith('auto');
    rerender(<NewChat projects={projects} onStart={vi.fn()} now={now} codexAvailable engine="codex" onEngine={onEngine} home={{ activity: [], unread: [], pending: [], questions: [], usage: null, data: fixture }} />);
    expect(within(screen.getByRole('radiogroup')).getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });
});

describe('Pane: when the empty pane is the home', () => {
  afterEach(cleanup);
  const app = { pending: [], questions: [], codexAvailable: false, projects };
  const fetchStub = vi.fn(() => Promise.reject(new Error('offline')));
  beforeEach(() => { clearHomeCache(); vi.stubGlobal('fetch', fetchStub); });
  afterEach(() => vi.unstubAllGlobals());

  it('a single, docked, not closable pane shows the home', () => {
    render(<Pane pane={newPane('p1')} app={app} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} onStartChat={vi.fn()} />);
    expect(screen.getByTestId('home')).toBeTruthy();
  });

  it('a split (closable) pane or a floating one keeps the plain new-chat screen', () => {
    render(<Pane pane={newPane('p1')} app={app} active closable dispatch={() => {}} send={() => {}} onClose={() => {}} onStartChat={vi.fn()} />);
    expect(screen.queryByTestId('home')).toBeNull();
    expect(document.querySelector('.newchat')).toBeTruthy();
    cleanup();
    render(<Pane pane={newPane('p1')} app={app} active closable={false} floating dispatch={() => {}} send={() => {}} onClose={() => {}} onStartChat={vi.fn()} />);
    expect(screen.queryByTestId('home')).toBeNull();
    expect(document.querySelector('.newchat')).toBeTruthy();
  });

  it('모두 읽음 in the home dispatches mark_read with the ids', () => {
    const dispatch = vi.fn();
    render(<Pane pane={newPane('p1')} app={{ ...app, unread: ['done', 'run'], activity }} active closable={false} dispatch={dispatch} send={() => {}} onClose={() => {}} onStartChat={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '모두 읽음' }));
    const call = dispatch.mock.calls.find((c) => (c[0] as { type: string }).type === 'mark_read');
    expect(call).toBeTruthy();
    expect([...(call![0] as { sessionIds: string[] }).sessionIds].sort()).toEqual(['done', 'run']);
  });
});
