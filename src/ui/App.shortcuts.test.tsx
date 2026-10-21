// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';

Element.prototype.scrollIntoView = () => {};

const sock = vi.hoisted(() => ({ frames: [] as unknown[], onMessage: null as ((m: unknown) => void) | null }));
vi.mock('./ws', () => ({
  createSocket: (onMessage: (m: unknown) => void, onStatus: (v: boolean) => void) => {
    sock.onMessage = onMessage;
    onStatus(true);
    return { send: (m: unknown) => { sock.frames.push(m); }, close: () => {} };
  },
}));

import { App } from './App';

const usage = { generatedAt: 'x', deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, b: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null }, c: { status: 'ok', fetchedAt: null, fiveHour: null, weekly: null, fable: null } } } as const;
const T = Date.now();
const entry = (sessionId: string, title: string, ago: number) => ({ sessionId, account: 'b' as const, cwd: '/w', projectDir: '/p', title, lastModified: T - ago, sizeBytes: 1 });
const OLD = 400 * 86_400_000;

async function boot() {
  render(<App />);
  await waitFor(() => expect(sock.onMessage).not.toBeNull());
  server({ type: 'hello', usage, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [entry('s1', 'one', 0), entry('s2', 'two', 1000), entry('s3', 'ancient', OLD)] }], running: [], codex: { available: false } } as unknown as ServerMessage);
}
function server(msg: ServerMessage) { act(() => sock.onMessage!(msg)); }
const frames = () => sock.frames as ClientMessage[];
const opened = () => frames().filter((f) => f.type === 'open_session').map((f) => (f as { sessionId: string }).sessionId);
const sidebar = () => document.querySelector('.sidebar') as HTMLElement;
/** jsdom has no Mac platform: the modifier is Ctrl. */
const press = (code: string, extra: Record<string, unknown> = {}, target: Element | Window = window) => fireEvent.keyDown(target, { code, key: '', ctrlKey: true, ...extra });
let fetchMock: ReturnType<typeof vi.fn>;

describe('desktop-like navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    sock.frames = [];
    sock.onMessage = null;
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/session-trash') return new Response(JSON.stringify({ ok: true, trashId: `20261002-120000-s2` }), { status: 200 });
      if (url === '/api/session-trash/restore') return new Response(JSON.stringify({ ok: true, sessionId: 's2' }), { status: 200 });
      if (String(url).startsWith('/api/search')) return new Response(JSON.stringify({ hits: [], truncated: false }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('Ctrl+K palette: fuzzy session search, arrows + Enter open it, Esc closes, Enter mid-IME is ignored', async () => {
    await boot();
    press('KeyK');
    const input = screen.getByLabelText('세션 검색 또는 명령');
    fireEvent.change(input, { target: { value: 'tw' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).not.toBeNull();
    const options = screen.getAllByRole('option');
    expect(options[0]!.textContent).toContain('two');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).toBeNull();
    expect(opened()).toEqual(['s2']);

    press('KeyK');
    fireEvent.change(screen.getByLabelText('세션 검색 또는 명령'), { target: { value: '사용량' } });
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: '사용량' })).toBeTruthy();
  });

  it('palette actions dispatch the settings / theme events; Esc and Ctrl+K close it', async () => {
    await boot();
    const seen: string[] = [];
    const on = (e: Event) => seen.push(e.type);
    window.addEventListener('deck:open-settings', on);
    window.addEventListener('deck:cycle-theme', on);
    press('KeyK');
    fireEvent.click(screen.getByText('설정 열기'));
    press('KeyK');
    fireEvent.click(screen.getByText('테마 전환'));
    expect(seen).toEqual(['deck:open-settings', 'deck:cycle-theme']);
    press('KeyK');
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Escape' });
    // One Esc closes only the topmost: the palette took it, 설정 (opened under it) waits for the next one.
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    press('KeyK');
    press('KeyK', {}, screen.getByLabelText('세션 검색 또는 명령'));
    expect(screen.queryByRole('dialog')).toBeNull();
    window.removeEventListener('deck:open-settings', on);
    window.removeEventListener('deck:cycle-theme', on);
  });

  it('설정 열기 opens Settings, 테마 전환 cycles 시스템 → 라이트 → 다크 → 시스템, Ctrl+, toggles Settings', async () => {
    await boot();
    press('KeyK');
    fireEvent.click(screen.getByText('설정 열기'));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    const theme = () => document.documentElement.getAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme'); // an earlier test's 테마 전환 (prefs were reset by localStorage.clear)
    for (const want of ['light', 'dark', null]) {
      press('KeyK');
      fireEvent.click(screen.getByText('테마 전환'));
      expect(theme()).toBe(want);
    }
    press('Comma');
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
    press('Comma');
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    press('Slash');
    const help = screen.getByRole('dialog', { name: '단축키' }).textContent ?? '';
    expect(help).toContain('Ctrl+,');
    expect(help).toContain('⇧Tab');
  });

  it('Ctrl+/ cheat sheet, Ctrl+\\ hides the sidebar, Ctrl+] / Ctrl+[ walk the list (not from a text field)', async () => {
    await boot();
    press('Slash');
    expect(screen.getByRole('dialog', { name: '단축키' }).textContent).toContain('Ctrl+K');
    press('BracketRight'); // blocked while a dialog is open
    expect(opened()).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    press('Backslash');
    expect(document.querySelector('.sidebar-wrap')!.classList.contains('hidden')).toBe(true);
    press('Backslash');
    expect(document.querySelector('.sidebar-wrap')!.classList.contains('hidden')).toBe(false);

    press('BracketRight'); // nothing open → the newest
    press('BracketRight');
    expect(opened()).toEqual(['s1', 's2']);
    press('BracketLeft', {}, screen.getByPlaceholderText(/메시지/));
    expect(opened()).toEqual(['s1', 's2']);
    press('BracketLeft');
    expect(opened()).toEqual(['s1', 's2', 's1']);
  });

  it('Ctrl+N: the pane shows the new-chat screen for its project; the start box opens and sends', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('one'));
    press('KeyN');
    const pane = screen.getAllByTestId(/^pane-/)[0]!;
    // The project is in the session chip's sheet.
    fireEvent.click(within(pane).getByTestId('session-chip'));
    const sheet = within(pane).getByRole('dialog', { name: '세션 설정' });
    expect((within(sheet).getByLabelText('프로젝트') as HTMLSelectElement).value).toBe('/w');
    fireEvent.click(within(sheet).getByLabelText('닫기'));
    expect(within(pane).getByText('two')).toBeTruthy(); // recent card
    const box = within(pane).getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '안녕' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(frames().some((f) => f.type === 'send')).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(frames().find((f) => f.type === 'send')).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '안녕' });
  });

  it('new-chat screen: an attachment picked before the first message rides its send frame', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/attachments'
      ? new Response(JSON.stringify({ id: 'att-1', name: 'shot.png', size: 1, isImage: true }), { status: 200 })
      : new Response('{}', { status: 200 })));
    await boot();
    const pane = screen.getAllByTestId(/^pane-/)[0]!;
    fireEvent.change(within(pane).getByTestId('attachment-gallery'), { target: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] } });
    await waitFor(() => expect(within(pane).getByText(/shot\.png/)).toBeTruthy());
    const box = within(pane).getByLabelText('첫 메시지');
    fireEvent.change(box, { target: { value: '봐줘' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(frames().find((f) => f.type === 'send')).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '봐줘', attachments: ['att-1'] });
  });

  it('sidebar groups by date (no 프로젝트 view); 삭제 asks, moves to trash, offers undo', async () => {
    await boot();
    expect(within(sidebar()).getByTestId('date-group-오늘').textContent).toContain('two');
    expect(within(sidebar()).getByTestId('date-group-이전').textContent).toContain('ancient');
    // The + menu has no view switch any more.
    fireEvent.click(within(sidebar()).getByRole('button', { name: '새 세션' }));
    expect(within(sidebar()).queryByRole('menuitem', { name: '프로젝트별로 묶기' })).toBeNull();
    fireEvent.keyDown(within(sidebar()).getByRole('menu'), { key: 'Escape' });

    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('삭제…'));
    const dlg = screen.getByRole('alertdialog', { name: '대화 삭제' });
    fireEvent.click(within(dlg).getByText('삭제'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('삭제됨'));
    expect(fetchMock.mock.calls.find((c) => c[0] === '/api/session-trash')![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ sessionId: 's2' }) });
    fireEvent.click(screen.getByText('되돌리기'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/session-trash/restore')).toBe(true));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('보관 offers 되돌리기 for 8 s; 되돌리기 unarchives through the same meta call', async () => {
    await boot();
    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('보관'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('보관했어요'));
    const metas = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/meta') || String(c[0]).includes('session-meta'));
    expect(metas().length).toBe(1);
    expect(String(metas()[0]![1]?.body)).toContain('"archived":true');
    fireEvent.click(screen.getByText('되돌리기'));
    await waitFor(() => expect(metas().length).toBe(2));
    expect(String(metas()[1]![1]?.body)).toContain('"archived":false');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('보관 while a 삭제 undo shows keeps the 삭제 toast (the archive can be undone from the archived list)', async () => {
    await boot();
    const two = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(two).getByLabelText('세션 메뉴'));
    fireEvent.click(within(two).getByText('삭제…'));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '대화 삭제' })).getByText('삭제'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('삭제됨'));
    const metas = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/meta') || String(c[0]).includes('session-meta'));
    const one = within(sidebar()).getByText('one').closest('li')!;
    fireEvent.click(within(one).getByLabelText('세션 메뉴'));
    fireEvent.click(within(one).getByText('보관'));
    await waitFor(() => expect(metas().length).toBe(1));
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toContain('삭제됨');
    expect(screen.getByRole('status').textContent).not.toContain('보관했어요');
  });

  it('보관 toast goes away by itself after 8 s', async () => {
    // Fake the clock before boot so every timer the app arms (including the toast's) is on the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await boot();
      const row = within(sidebar()).getByText('two').closest('li')!;
      fireEvent.click(within(row).getByLabelText('세션 메뉴'));
      fireEvent.click(within(row).getByText('보관'));
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('보관했어요'));
      // The toast is in the DOM before its passive effect (which arms the 8 s timer) has run; under load that effect
      // can lag until the next scheduler tick. Flush it first so the clock below actually counts against the timer.
      await act(async () => {});
      act(() => { vi.advanceTimersByTime(7_000); });
      expect(screen.queryByRole('status')).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1_500); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('⋯ 새 탭에서 열기 opens the session link in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await boot();
    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('새 탭에서 열기'));
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/?session=s2`, '_blank', 'noopener');
    expect(within(row).queryByRole('menu')).toBeNull();
  });

  it('Ctrl+Alt+[ / ] step the active pane (wrapping); Ctrl+⇧X closes it, never the last one', async () => {
    await boot();
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    const panes = () => screen.getAllByTestId(/^pane-/);
    const activeIndex = () => panes().findIndex((p) => p.classList.contains('active'));
    expect(panes()).toHaveLength(3);
    expect(activeIndex()).toBe(2);
    press('BracketRight', { altKey: true });
    expect(activeIndex()).toBe(0);
    press('BracketLeft', { altKey: true });
    expect(activeIndex()).toBe(2);
    press('BracketLeft', { altKey: true });
    expect(activeIndex()).toBe(1);
    const middle = panes()[1]!.dataset.testid;
    press('KeyX', { shiftKey: true });
    expect(panes()).toHaveLength(2);
    expect(panes().some((p) => p.dataset.testid === middle)).toBe(false);
    press('KeyX', { shiftKey: true });
    press('KeyX', { shiftKey: true });
    expect(panes()).toHaveLength(1);
    press('Slash');
    const help = screen.getByRole('dialog', { name: '단축키' }).textContent ?? '';
    expect(help).toContain('Ctrl+Alt+[');
    expect(help).toContain('Ctrl+⇧X');
  });

  it('refuses 삭제 of a session with a turn running here', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('two'));
    server({ type: 'history', sessionId: 's2', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, runningTurnId: null, messages: [] } as ServerMessage);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('보내기'));
    const row = within(sidebar()).getByText('two').closest('li')!;
    fireEvent.click(within(row).getByLabelText('세션 메뉴'));
    fireEvent.click(within(row).getByText('삭제…'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText(/실행 중인 대화는 삭제할 수 없어요/)).toBeTruthy();
  });

  it('⇧Esc focuses the active pane composer (caret at the end); an open palette keeps its Esc', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('one'));
    press('KeyN');
    const pane = screen.getAllByTestId(/^pane-/)[0]!;
    const box = within(pane).getByLabelText('첫 메시지') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '안녕' } });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape', shiftKey: true });
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    (document.activeElement as HTMLElement).blur();
    press('KeyK');
    fireEvent.keyDown(document.body, { key: 'Escape', shiftKey: true });
    expect(document.activeElement).not.toBe(box);
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).not.toBeNull();
  });

  it('Ctrl+Alt+1…9 focus the nth split pane (missing numbers ignored); Ctrl+⇧Enter shows the active pane alone and back', async () => {
    await boot();
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    const panes = () => screen.getAllByTestId(/^pane-/);
    const activeIndex = () => panes().findIndex((p) => p.classList.contains('active'));
    expect(activeIndex()).toBe(2);
    expect(press('Digit1', { altKey: true, key: '¡' })).toBe(false); // taken (preventDefault)
    expect(activeIndex()).toBe(0);
    press('Digit2', { altKey: true });
    expect(activeIndex()).toBe(1);
    expect(press('Digit4', { altKey: true })).toBe(true); // no 4th pane: left to the browser
    expect(activeIndex()).toBe(1);
    // Mid-IME: taken at once, the focus moves a tick later (after the blur commits the composition).
    expect(press('Digit3', { altKey: true, isComposing: true })).toBe(false);
    expect(activeIndex()).toBe(1);
    await waitFor(() => expect(activeIndex()).toBe(2));
    press('Digit2', { altKey: true });
    expect(activeIndex()).toBe(1);

    const hidden = () => panes().map((p) => p.hidden);
    press('Enter', { shiftKey: true });
    expect(hidden()).toEqual([true, false, true]);
    expect(document.querySelector('.panes')!.getAttribute('data-count')).toBe('1');
    expect(document.querySelector('.pane-splitter')).toBeNull();
    press('Enter', { shiftKey: true });
    expect(hidden()).toEqual([false, false, false]);
    // Another pane coming forward ends the maximize.
    press('Enter', { shiftKey: true });
    press('Digit1', { altKey: true });
    expect(activeIndex()).toBe(0);
    expect(hidden()).toEqual([false, false, false]);
    press('Slash');
    const help = screen.getByRole('dialog', { name: '단축키' }).textContent ?? '';
    for (const k of ['Ctrl+Alt+1–9', 'Ctrl+⇧Enter', 'Ctrl+Alt+⇧[', 'Ctrl+Alt+⇧]', 'Ctrl+⇧E']) expect(help).toContain(k);
  });

  it('Ctrl+Alt+⇧[ / ] move the active pane left / right, as ⋯ 왼쪽으로 / 오른쪽으로 이동', async () => {
    await boot();
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    fireEvent.click(screen.getByRole('button', { name: '새 분할' }));
    const ids = () => screen.getAllByTestId(/^pane-/).map((p) => p.dataset.testid);
    const [a, b, c] = ids();
    press('BracketLeft', { altKey: true, shiftKey: true });
    expect(ids()).toEqual([a, c, b]);
    press('BracketLeft', { altKey: true, shiftKey: true });
    expect(ids()).toEqual([c, a, b]);
    press('BracketLeft', { altKey: true, shiftKey: true }); // already leftmost
    expect(ids()).toEqual([c, a, b]);
    press('BracketRight', { altKey: true, shiftKey: true });
    expect(ids()).toEqual([a, c, b]);
    expect(screen.getAllByTestId(/^pane-/)[1]!.classList.contains('active')).toBe(true);
  });

  it('Ctrl+⇧E opens the active pane\'s side panel (file picker) and closes it again', async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByText('one'));
    const pane = () => screen.getAllByTestId(/^pane-/)[0]!;
    expect(pane().classList.contains('with-side')).toBe(false);
    press('KeyE', { shiftKey: true });
    expect(pane().classList.contains('with-side')).toBe(true);
    press('KeyE', { shiftKey: true });
    await waitFor(() => expect(pane().classList.contains('with-side')).toBe(false));
  });

  it('palette: Ctrl+Enter opens the session in a new split pane, ⇧Enter as a floating card', async () => {
    await boot();
    press('KeyK');
    expect(document.querySelector('.palette-foot')!.textContent).toContain('Ctrl+Enter 새 분할');
    fireEvent.change(screen.getByLabelText('세션 검색 또는 명령'), { target: { value: 'tw' } });
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Enter', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: '명령 팔레트' })).toBeNull();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(2);
    expect(opened()).toEqual(['s2']);
    expect(screen.getAllByTestId(/^pane-/)[1]!.classList.contains('active')).toBe(true);
    press('KeyK');
    fireEvent.change(screen.getByLabelText('세션 검색 또는 명령'), { target: { value: 'one' } });
    fireEvent.keyDown(screen.getByLabelText('세션 검색 또는 명령'), { key: 'Enter', shiftKey: true });
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(3);
    expect(opened()).toEqual(['s2', 's1']);
    const card = document.querySelector('.float-card');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getAllByText('one').length).toBeGreaterThan(0);
  });

  it('new-chat screen: Ctrl+Enter starts the chat in a new split pane; this one stays, emptied', async () => {
    await boot();
    const box = within(screen.getAllByTestId(/^pane-/)[0]!).getByLabelText('첫 메시지') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '안녕' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    const panes = screen.getAllByTestId(/^pane-/);
    expect(panes).toHaveLength(2);
    expect(frames().find((f) => f.type === 'send')).toMatchObject({ type: 'send', sessionId: null, cwd: '/w', text: '안녕' });
    expect((within(panes[0]!).getByLabelText('첫 메시지') as HTMLTextAreaElement).value).toBe('');
    expect(within(panes[1]!).queryByLabelText('첫 메시지')).toBeNull();
    // Ctrl+⇧Enter is the maximize, not a start.
    fireEvent.change(within(panes[0]!).getByLabelText('첫 메시지'), { target: { value: '둘' } });
    fireEvent.keyDown(within(panes[0]!).getByLabelText('첫 메시지'), { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(frames().filter((f) => f.type === 'send')).toHaveLength(1);
  });
});
