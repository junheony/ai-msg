// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useReducer } from 'react';
import { Pane, startTaskFromPane, useQueueRunner } from './Pane';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { initialState, newPane, reducer, type Action, type AppState, type PaneState } from '../state';

Element.prototype.scrollIntoView = () => {};

describe('Pane (D6)', () => {
  afterEach(cleanup);

  it('a new GPT session sends engine, sandbox, model and attachment ids; dispatches sent with names; close button only when closable', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: null, cwd: '/w', account: null, title: '새 세션', engine: 'codex', sandbox: null }, engine: 'codex', sandbox: 'workspace-write', model: 'gpt-6-astra', attachments: [{ id: 'a1', name: 'shot.png', size: 1, isImage: true }] };
    const dispatch = vi.fn();
    const send = vi.fn();
    const onClose = vi.fn();
    render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: true }} active closable dispatch={dispatch} send={send} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'sent', text: 'hello', paneId: 'p1', attachments: [{ id: 'a1', name: 'shot.png', isImage: true }], clientRef: expect.any(String) });
    expect(send).toHaveBeenCalledWith({ type: 'send', sessionId: null, cwd: '/w', text: 'hello', model: 'gpt-6-astra', effort: 'medium', engine: 'codex', sandbox: 'workspace-write', attachments: ['a1'], clientRef: expect.any(String) });
    // T9 prerequisite (a): the frame carries the same clientRef the reducer waits for.
    const ref1 = (dispatch.mock.calls.find((c) => (c[0] as Action).type === 'sent')![0] as { clientRef: string }).clientRef;
    expect((send.mock.calls[0]![0] as { clientRef: string }).clientRef).toBe(ref1);
    fireEvent.click(screen.getByTestId('session-chip-head')); // 창 › 이 창 닫기 (a docked pane has no ✕)
    fireEvent.click(screen.getByRole('menuitem', { name: '이 창 닫기' }));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    render(<Pane pane={{ ...pane, session: { ...pane.session!, sessionId: 's1', engine: 'claude' } }} app={{ pending: [], questions: [], codexAvailable: true }} active={false} closable={false} dispatch={dispatch} send={send} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.queryByRole('menuitem', { name: '이 창 닫기' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'again' } });
    fireEvent.click(screen.getByText('보내기'));
    // PF13: a Claude session is never sent a GPT model; with none picked for it, it gets none (runs on its own default).
    expect(send).toHaveBeenLastCalledWith({ type: 'send', sessionId: 's1', cwd: '/w', text: 'again', effort: 'high', attachments: ['a1'], clientRef: expect.any(String) });
    const ref2 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    expect(ref2).not.toBe(ref1);
  });

  it('shows only the cards that belong to its session', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null } };
    const card = (requestId: string, sessionId: string) => ({ turnId: 'x' + requestId, sessionId, cwd: '/w', requestId, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null });
    render(<Pane pane={pane} app={{ pending: [card('r1', 's1'), card('r2', 's2')], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    expect(screen.getAllByText('허용 1회')).toHaveLength(1);
  });

  it('new-chat screen: engine picker shows with codex available and choosing GPT dispatches set_engine', () => {
    const dispatch = vi.fn();
    const pane: PaneState = { ...newPane('p1') };
    render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: true, projects: [{ cwd: '/w', name: 'w', pinned: true, sessions: [] }] }} active closable={false} dispatch={dispatch} send={() => {}} onClose={() => {}} onStartChat={vi.fn()} />);
    fireEvent.click(screen.getByTestId('session-chip'));
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'codex' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'set_engine', engine: 'codex', paneId: 'p1' });
  });

  it('PF11: switching the engine picker to GPT on a new session shows the sandbox picker and GPT models', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = { ...s, codexAvailable: true };
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s);
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={() => {}} onClose={() => {}} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('session-chip'));
    // A new pane starts on 자동 (it may land on GPT, so the sandbox picker shows); Claude hides it.
    expect((screen.getByTestId('engine-select') as HTMLSelectElement).value).toBe('auto');
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'claude' } });
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'codex' } });
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement).value).toBe('medium');
    const items = within(screen.getByTestId('model-menu')).getAllByRole('menuitemradio');
    expect(items.slice(0, 2).map((b) => b.textContent)).toEqual([expect.stringContaining('GPT-6.1-Sol'), expect.stringContaining('GPT-6-Astra')]);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('effort is kept per pane and per engine, and sent with each turn', () => {
    let s0: AppState = reducer(initialState, { type: 'add_pane' });
    s0 = reducer(s0, { type: 'open', sessionId: null, cwd: '/w', title: 'n0', paneId: 'p0' });
    s0 = reducer(s0, { type: 'open', sessionId: null, cwd: '/w', title: 'n1', paneId: 'p1' });
    // New panes start on 자동; this test is about Fable's effort.
    for (const paneId of ['p0', 'p1']) s0 = reducer(s0, { type: 'set_model', model: 'fable', picked: false, paneId });
    s0 = { ...s0, codexAvailable: true };
    const frames: ClientMessage[] = [];
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s0);
      return <>{state.panes.map((p) => <Pane key={p.id} pane={p} app={state} active={p.id === state.activePaneId} closable dispatch={dispatch} send={(m) => frames.push(m)} onClose={() => {}} />)}</>;
    }
    render(<Harness />);
    const p0 = within(screen.getByTestId('pane-p0'));
    const p1 = within(screen.getByTestId('pane-p1'));
    // The model the pane's menu has checked and the effort its select shows (four levels: a select, not a segment).
    const effortOf = (pane: typeof p0) => pane.getByRole('combobox', { name: '추론 수준' }) as HTMLSelectElement;
    const checked = (pane: typeof p0) => [
      ...within(pane.getByTestId('model-menu')).getAllByRole('menuitemradio').filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.querySelector('.mp-name')?.textContent ?? b.textContent),
      effortOf(pane).selectedOptions[0]?.textContent,
    ];
    fireEvent.click(p0.getByTestId('session-chip'));
    fireEvent.change(effortOf(p0), { target: { value: 'xhigh' } });
    expect(checked(p0)).toEqual(['Fable 5.1', '엑스트라']);
    // The other pane keeps the default.
    fireEvent.click(p1.getByTestId('session-chip'));
    expect(checked(p1)).toEqual(['Fable 5.1', '높음']);
    // GPT has its own effort (default 중간); switching back to Claude restores 엑스트라.
    fireEvent.change(p0.getByTestId('engine-select'), { target: { value: 'codex' } });
    expect(checked(p0)).toEqual(['GPT-6.1-Sol', '중간']);
    fireEvent.change(p0.getByTestId('engine-select'), { target: { value: 'claude' } });
    fireEvent.change(p0.getByPlaceholderText(/메시지/), { target: { value: 'go' } });
    fireEvent.click(p0.getByText('보내기'));
    expect(frames.at(-1)).toMatchObject({ type: 'send', model: 'fable', effort: 'xhigh', engine: 'claude' });
  });

  it('T9 (a): two panes sending into new sessions whose turn_started arrive in reverse order each get their own turn', () => {
    let s0: AppState = reducer(initialState, { type: 'add_pane' });
    s0 = reducer(s0, { type: 'open', sessionId: null, cwd: '/w', title: 'n0', paneId: 'p0' });
    s0 = reducer(s0, { type: 'open', sessionId: null, cwd: '/w', title: 'n1', paneId: 'p1' });
    const frames: ClientMessage[] = [];
    let serverDispatch: (a: Action) => void = () => {};
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s0);
      serverDispatch = dispatch;
      return <>{state.panes.map((p) => <Pane key={p.id} pane={p} app={state} active={p.id === state.activePaneId} closable dispatch={dispatch} send={(m) => frames.push(m)} onClose={() => {}} />)}</>;
    }
    render(<Harness />);
    const typeAndSend = (paneId: string, text: string) => {
      const pane = within(screen.getByTestId(`pane-${paneId}`));
      fireEvent.change(pane.getByPlaceholderText(/메시지/), { target: { value: text } });
      fireEvent.click(pane.getByText('보내기'));
    };
    typeAndSend('p0', 'first');
    typeAndSend('p1', 'second');
    const refOf = (text: string) => (frames.find((f) => f.type === 'send' && f.text === text) as { clientRef?: string }).clientRef!;
    const r0 = refOf('first');
    const r1 = refOf('second');
    expect(r0).toBeTruthy();
    expect(r1).not.toBe(r0);
    const server = (msg: ServerMessage) => act(() => serverDispatch({ type: 'server', msg }));
    const started = (turnId: string, clientRef: string): ServerMessage => ({ type: 'turn_started', turnId, sessionId: null, cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 0, clientRef });
    // The second pane's turn starts first.
    server(started('t1', r1));
    server(started('t0', r0));
    server({ type: 'delta', turnId: 't1', sessionId: null, cwd: '/w', text: 'reply-to-second' });
    server({ type: 'delta', turnId: 't0', sessionId: null, cwd: '/w', text: 'reply-to-first' });
    const p0 = within(screen.getByTestId('pane-p0'));
    const p1 = within(screen.getByTestId('pane-p1'));
    expect(p0.getByText('reply-to-first')).toBeTruthy();
    expect(p0.queryByText('reply-to-second')).toBeNull();
    expect(p1.getByText('reply-to-second')).toBeTruthy();
    expect(p1.queryByText('reply-to-first')).toBeNull();
  });

  describe('useQueueRunner', () => {
    const hello = { type: 'hello', usage: { generatedAt: 'x', deckReachable: true, accounts: {} }, projects: [], running: [], codex: { available: false } } as unknown as ServerMessage;
    const history: ServerMessage = { type: 'history', sessionId: 's1', cwd: '/w', account: null, runningTurnId: null, messages: [{ kind: 'user', text: 'old', ts: null, n: 0 }] };
    const harness = (start: AppState) => {
      const send = vi.fn<(m: ClientMessage) => void>();
      let out: (a: Action) => void = () => {};
      let state = start;
      function Harness() {
        const [s, dispatch] = useReducer(reducer, start);
        out = dispatch;
        state = s;
        useQueueRunner(s.panes, s.ready, dispatch, send);
        return null;
      }
      render(<Harness />);
      const sends = (text: string) => send.mock.calls.filter(([m]) => m.type === 'send' && m.text === text).map(([m]) => m);
      return { send, sends, act: (a: Action) => act(() => out(a)), server: (msg: ServerMessage) => act(() => out({ type: 'server', msg })), state: () => state };
    };

    it('a held message released after a restart goes out exactly once, under its old clientRef, and keeps the rest paused', () => {
      let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      s = reducer(s, { type: 'server', msg: hello });
      s = reducer(s, { type: 'server', msg: history });
      s = reducer(s, { type: 'queue_add', text: 'later' });
      s = reducer(s, { type: 'sent', text: 'mine', clientRef: 'r1' });
      s = reducer(s, { type: 'server', msg: { type: 'error', turnId: null, message: 'draining', clientRef: 'r1', code: 'draining' } });
      s = reducer(s, { type: 'queue_pause' });
      s = reducer(s, { type: 'connected', value: false });
      const h = harness(s);
      h.act({ type: 'connected', value: true });
      h.server(hello);
      expect(h.send).not.toHaveBeenCalled(); // waits for the history
      h.server(history);
      expect(h.sends('mine')).toEqual([expect.objectContaining({ clientRef: 'r1' })]);
      h.server({ type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', clientRef: 'r1' } as ServerMessage);
      h.server({ type: 'turn_result', turnId: 't1', sessionId: 's1', cwd: '/w', ok: true, text: 'ok', badge: null, errorText: null });
      h.server(history);
      expect(h.sends('mine')).toHaveLength(1);
      expect(h.sends('later')).toEqual([]);
      expect(h.state().panes[0]!.queuePaused).toBe(true);
    });

    it('M2: nothing goes out between the socket opening and its hello (the hello would requeue it)', () => {
      let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
      s = reducer(s, { type: 'queue_add', text: 'next' });
      const h = harness(s);
      h.act({ type: 'connected', value: true });
      expect(h.send).not.toHaveBeenCalled();
      h.server(hello);
      expect(h.sends('next')).toHaveLength(1);
      expect(h.state().panes[0]!.awaitingStart).toBe(true);
    });
  });
});

describe('Pane: Esc stops the running turn from anywhere in the pane', () => {
  afterEach(() => { cleanup(); document.body.innerHTML = ''; });
  const running: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null }, activeTurnId: 't1' };
  const mount = (active = true) => {
    const send = vi.fn();
    render(<Pane pane={running} app={{ pending: [], questions: [], codexAvailable: false }} active={active} closable={false} dispatch={() => {}} send={send} onClose={() => {}} />);
    return send;
  };

  it('Esc with nothing focused interrupts the active pane\'s turn (once)', () => {
    const send = mount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', turnId: 't1' });
  });

  it('the composer\'s own Esc is not doubled', () => {
    const send = mount();
    fireEvent.keyDown(screen.getByLabelText('메시지'), { key: 'Escape' });
    expect(send.mock.calls.filter((c) => (c[0] as ClientMessage).type === 'interrupt')).toHaveLength(1);
  });

  it('an open menu / dialog takes the Esc first; a field being edited keeps it; an inactive pane ignores it', () => {
    const send = mount();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    menu.remove();
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(send).not.toHaveBeenCalled();
    cleanup();
    const send2 = mount(false);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(send2).not.toHaveBeenCalled();
  });

  it('Esc that cancels a pin drag (swallowed in the capture phase, like pinOrder) does not stop the turn', () => {
    const send = mount();
    const drag = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
    window.addEventListener('keydown', drag, true); // added at drag start, after the pane mounted
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', drag, true);
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('Esc that closes the usage popover (or the phone drawer) does not stop the turn, even when its handler removes it first', () => {
    const send = mount();
    const pop = document.createElement('div');
    pop.setAttribute('role', 'tooltip');
    document.body.append(pop);
    // the popover's own handler runs before the pane's bubble listener and takes it off screen without preventDefault
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') pop.remove(); };
    document.addEventListener('keydown', close);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', close);
    expect(send).not.toHaveBeenCalled();
    const drawer = document.createElement('div');
    drawer.className = 'sidebar-wrap drawer open';
    document.body.append(drawer);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    drawer.remove();
    expect(send).not.toHaveBeenCalled();
  });

  it('a closed usage popover still in the DOM (aria-hidden="true") does not take the Esc: the turn stops', () => {
    const send = mount();
    const pop = document.createElement('div');
    pop.setAttribute('role', 'tooltip');
    pop.setAttribute('aria-hidden', 'true');
    pop.style.display = 'none';
    document.body.append(pop);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    pop.remove();
    expect(send).toHaveBeenCalledWith({ type: 'interrupt', turnId: 't1' });
  });

  it('focus outside the pane (top bar, sidebar) keeps Esc away from the turn', () => {
    const send = mount();
    const btn = document.createElement('button');
    document.body.append(btn);
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(send).not.toHaveBeenCalled();
    (screen.getByTestId('pane-p1').querySelector('button') as HTMLButtonElement).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Pane: chat title menu uses the sidebar actions', () => {
  afterEach(cleanup);
  it('acts on the listed session; a GPT one gets 삭제 disabled', () => {
    const entry = { sessionId: 's1', account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title: 't', lastModified: 1, sizeBytes: 1 };
    const actions = { pins: ['s1'], onRename: vi.fn(), onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null } };
    const app = { pending: [], questions: [], codexAvailable: false, projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: [entry] }] };
    const { rerender } = render(<Pane pane={pane} app={app} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} sessionActions={actions} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    fireEvent.click(screen.getByText('고정 해제'));
    expect(actions.onTogglePin).toHaveBeenCalledWith('s1', false);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    fireEvent.click(screen.getByText('삭제…'));
    expect(actions.onDelete).toHaveBeenCalledWith(entry);
    const gpt = { ...entry, account: 'gpt' as const, engine: 'codex' as const };
    rerender(<Pane pane={pane} app={{ ...app, projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: [gpt] }] }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} sessionActions={actions} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.getByRole('menuitem', { name: '삭제…' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('보관')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // archived in Codex: only the Codex app can unarchive it, so no 보관 item (as in the sidebar)
    rerender(<Pane pane={pane} app={{ ...app, projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: [{ ...gpt, codexArchived: true, archived: true }] }] }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} sessionActions={actions} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.queryByText('보관 해제')).toBeNull();
    const names = screen.getAllByRole('menuitem').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names.slice(0, 3)).toEqual(['폴더: w ›', '이름 바꾸기', '고정 해제']);
    expect(names).not.toContain('보관');
    expect(names.at(-1)).toBe('삭제…');
  });
});

describe('Pane: the socket is down', () => {
  afterEach(cleanup);
  const harness = (start: AppState, send: (m: ClientMessage) => boolean) => {
    let current = start;
    function Harness() {
      const [state, dispatch] = useReducer(reducer, start);
      current = state;
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={send} onClose={() => {}} />;
    }
    render(<Harness />);
    return () => current;
  };
  const opened = (): AppState => reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });

  it('sending while disconnected: no bubble, one held queue item', () => {
    const state = harness(opened(), () => false);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('보내기'));
    const p = state().panes[0]!;
    expect(p.items).toEqual([]);
    expect(p.awaitingStart).toBe(false);
    expect(p.queue.map((q) => [q.text, q.restart])).toEqual([['hello', 'hold']]);
    expect(screen.queryByTestId('turn-status')).toBeNull();
  });

  it('중단 while disconnected: not marked 중단됨, the queue keeps going, a notice says why', () => {
    let s = opened();
    s = reducer(s, { type: 'server', msg: { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'b', model: 'fable', reason: '', attempt: 1, prompt: { text: 'x', attachments: [] } } });
    s = reducer(s, { type: 'queue_add', text: 'next' });
    const state = harness(s, () => false);
    fireEvent.click(screen.getByTitle('중단 (Esc)'));
    const p = state().panes[0]!;
    expect(p.queuePaused).toBe(false);
    expect(p.items.some((it) => it.kind === 'assistant' && it.interrupted)).toBe(false);
    expect(screen.getByTestId('pane-notice').textContent).toContain('연결이 끊겨 중단을 보내지 못했습니다');
  });

  it('취소 on 시작하는 중… puts the text back into the composer', () => {
    const state = harness(opened(), () => true);
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('보내기'));
    expect(screen.getByTestId('turn-status').textContent).toContain('시작하는 중…');
    fireEvent.click(screen.getByText('취소'));
    expect(state().panes[0]!.awaitingStart).toBe(false);
    expect((screen.getByPlaceholderText(/메시지/) as HTMLTextAreaElement).value).toBe('hello');
  });
});

describe('Pane: route_fit card (자동 분배)', () => {
  afterEach(cleanup);

  it('shows 이 작업은 … 가 필요합니다; 그래도 보내기 resends the held message with ignoreFit', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'set_engine', engine: 'grok', paneId: 'p0' });
    s = reducer(s, { type: 'sent', text: '스크린샷 봐줘', paneId: 'p0', clientRef: 'r1', attachments: [{ id: 'a1', name: 'x.png', isImage: true }] });
    s = reducer(s, { type: 'server', msg: { type: 'route_fit', turnId: 't1', sessionId: null, engine: 'grok', need: '이미지 입력', clientRef: 'r1' } });
    const sent: ClientMessage[] = [];
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s);
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={(m) => { sent.push(m); }} onClose={() => {}} />;
    }
    render(<Harness />);
    expect(screen.getByTestId('route-fit').textContent).toContain('이 작업은 이미지 입력 가 필요합니다');
    fireEvent.click(screen.getByTestId('route-fit-send'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'send', sessionId: null, text: '스크린샷 봐줘', engine: 'grok', attachments: ['a1'], ignoreFit: true });
    expect(screen.queryByTestId('route-fit')).toBeNull();
    expect(screen.getAllByText('스크린샷 봐줘')).toHaveLength(1);
  });
});

describe('Pane: route_fit 그래도 보내기 double click (review #8)', () => {
  afterEach(cleanup);

  it('a second click on the same card (before the pane re-renders without it) sends nothing more', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = reducer(s, { type: 'set_engine', engine: 'grok', paneId: 'p0' });
    s = reducer(s, { type: 'sent', text: '스크린샷 봐줘', paneId: 'p0', clientRef: 'r1' });
    s = reducer(s, { type: 'server', msg: { type: 'route_fit', turnId: 't1', sessionId: null, engine: 'grok', need: '이미지 입력', clientRef: 'r1' } });
    const sent: ClientMessage[] = [];
    // The reducer's update has not reached this render yet: the card is still there for the second click.
    render(<Pane pane={s.panes[0]!} app={s} active closable={false} dispatch={() => {}} send={(m) => { sent.push(m); }} onClose={() => {}} />);
    const btn = screen.getByTestId('route-fit-send');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(sent).toHaveLength(1);
  });
});

describe('startTaskFromPane', () => {
  it('offline: false and nothing recorded (the composer keeps the draft); sent: the ref is kept for a refusal', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null } };
    const dispatch = vi.fn();
    expect(startTaskFromPane(pane, '로그 정리', dispatch, () => false)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    const sent: ClientMessage[] = [];
    expect(startTaskFromPane(pane, '로그 정리', dispatch, (m) => { sent.push(m); return true; })).toBe(true);
    const ref = (sent[0] as Extract<ClientMessage, { type: 'start_task' }>).clientRef;
    expect(dispatch).toHaveBeenCalledWith({ type: 'task_sent', paneId: 'p1', clientRef: ref, text: '로그 정리' });
  });
});

describe('Pane · 세션 칩 메뉴 (2c 리뷰)', () => {
  afterEach(cleanup);
  const withPhone = (phone: boolean, fn: () => void) => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: phone && q.includes('max-width: 720px'), media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try { fn(); } finally { window.matchMedia = mm; }
  };

  it('phone: 보기 › 명령 팔레트… opens the palette, also from a new session (no session yet)', () => {
    const onPalette = vi.fn();
    withPhone(true, () => {
      render(<Pane pane={{ ...newPane('p1') }} app={{ pending: [], questions: [], codexAvailable: false }} active closable dispatch={() => {}} send={() => {}} onClose={() => {}} onPalette={onPalette} />);
      fireEvent.click(screen.getByTestId('session-chip-head'));
      fireEvent.click(screen.getByRole('menuitem', { name: '명령 팔레트…' }));
    });
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it('빈 pane 머리: a docked empty pane in a split shows no head control at rest (idle); a session or a card keeps its head', () => {
    const app = { pending: [], questions: [], codexAvailable: false };
    const base = { app, active: true, closable: true, dispatch: () => {}, send: () => {}, onClose: () => {} };
    const { rerender } = render(<Pane {...base} pane={{ ...newPane('p1') }} />);
    const head = () => screen.getByTestId('pane-p1').querySelector('.pane-head')!;
    expect(head().classList.contains('idle')).toBe(true);
    // Its menu stays reachable (창 › 이 창 닫기) for the pointer that brings the head up.
    fireEvent.click(screen.getByTestId('session-chip-head'));
    expect(screen.getByRole('menuitem', { name: '이 창 닫기' })).toBeTruthy();
    rerender(<Pane {...base} pane={{ ...newPane('p1') }} floating onToggleCollapse={() => {}} />);
    expect(head().classList.contains('idle')).toBe(false);
    expect(screen.getByRole('button', { name: '카드 접기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '패널 닫기' })).toBeTruthy();
    rerender(<Pane {...base} pane={{ ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } }} />);
    expect(head().classList.contains('idle')).toBe(false);
  });

  it('빈 pane 머리 idle: hidden at rest only on a hover screen, shown again under the pointer and with focus inside', () => {
    render(<Pane pane={{ ...newPane('p1') }} app={{ pending: [], questions: [], codexAvailable: false }} active closable dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    const head = screen.getByTestId('pane-p1').querySelector<HTMLElement>('.pane-head')!;
    expect(head.classList.contains('idle')).toBe(true);
    // The head's parent is the .pane the :hover rule keys on.
    expect(head.parentElement!.classList.contains('pane')).toBe(true);
    act(() => { screen.getByTestId('session-chip-head').focus(); });
    expect(head.matches(':focus-within')).toBe(true);
    const css = readFileSync(path.join(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const hover = css.match(/@media \(hover: hover\) \{\s*\.pane-head\.idle \{ opacity: 0;[^}]*\}\s*([^{]+)\{ opacity: 1; \}/);
    expect(hover).not.toBeNull();
    const shown = hover![1]!.split(',').map((x) => x.trim());
    expect(shown).toEqual(expect.arrayContaining(['.pane:hover > .pane-head.idle', '.pane-head.idle:focus-within']));
  });

  it('칩 메뉴 (desktop): all five groups in order — 세션 · 보기 · 공유 · 창 · 위험; no 명령 팔레트… / 새 분할 (⌘K and the top bar have them)', () => {
    const entry = { sessionId: 's1', account: 'b' as const, cwd: '/w', projectDir: '/p', file: '/f', title: 't', lastModified: 1, sizeBytes: 1 };
    const actions = { pins: [], onRename: vi.fn(), onTogglePin: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null }, items: [{ kind: 'user', text: 'hi' } as PaneState['items'][number]] };
    const app = { pending: [], questions: [], codexAvailable: false, projects: [{ cwd: '/w', name: 'w', pinned: false, sessions: [entry] }] };
    render(<Pane pane={pane} app={app} active closable dispatch={() => {}} send={() => {}} onClose={() => {}} sessionActions={actions} onPalette={() => {}} onAddPane={() => {}} />);
    fireEvent.click(screen.getByTestId('session-chip-head'));
    const groups: string[][] = [[]];
    for (const el of Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="separator"]'))) {
      if (el.getAttribute('role') === 'separator') groups.push([]);
      else groups.at(-1)!.push(el.textContent!.replace(/(⌘|Ctrl\+).*$/, ''));
    }
    expect(groups).toEqual([
      ['폴더: w ›', '이름 바꾸기', '맨 위에 고정', '보관', '빠르게 (Opus fast)'],
      ['대화에서 찾기', '파일 열기', '새 세션으로 이어가기'],
      ['대화 복사 (마크다운)', '마크다운으로 내보내기', '링크 복사', '새 탭에서 열기'],
      ['새 탭으로 떼어내기', '이 창 닫기'],
      ['삭제…'],
    ]);
  });

  it('phone: 보기 group order: 대화에서 찾기 → 파일 열기 → 명령 팔레트…', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null }, items: [{ kind: 'user', text: 'hi' } as PaneState['items'][number]] };
    let names: string[] = [];
    withPhone(true, () => {
      render(<Pane pane={pane} app={{ pending: [], questions: [], codexAvailable: false }} active closable dispatch={() => {}} send={() => {}} onClose={() => {}} onPalette={() => {}} />);
      fireEvent.click(screen.getByTestId('session-chip-head'));
      names = screen.getAllByRole('menuitem').map((m) => m.textContent!.replace(/(⌘|Ctrl\+).*$/, ''));
    });
    const at = (n: string) => names.indexOf(n);
    expect(at('대화에서 찾기')).toBeGreaterThanOrEqual(0);
    expect(at('대화에서 찾기')).toBeLessThan(at('파일 열기'));
    expect(at('파일 열기')).toBeLessThan(at('명령 팔레트…'));
  });

  it('a phone menu has no 카드 배치… ; the desktop one does, with Ctrl+Shift hints off a Mac', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null } };
    const props = { pane, app: { pending: [], questions: [], codexAvailable: false }, active: true, closable: true, dispatch: () => {}, send: () => {}, onClose: () => {}, onLayouts: () => {}, onPalette: () => {} };
    withPhone(true, () => {
      render(<Pane {...props} />);
      fireEvent.click(screen.getByTestId('session-chip-head'));
      expect(screen.getByRole('menuitem', { name: '명령 팔레트…' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: '카드 배치…' })).toBeNull();
      cleanup();
    });
    withPhone(false, () => {
      render(<Pane {...props} />);
      fireEvent.click(screen.getByTestId('session-chip-head'));
      expect(screen.getByRole('menuitem', { name: '카드 배치…' })).toBeTruthy();
      // jsdom is not a Mac: the close row's hint is spelled out.
      expect(screen.getByRole('menuitem', { name: '이 창 닫기' }).querySelector('kbd')!.textContent).toBe('Ctrl+Shift+X');
      expect(screen.queryByRole('menuitem', { name: '명령 팔레트…' })).toBeNull();
    });
  });
});
