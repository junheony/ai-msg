// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useReducer } from 'react';
import { Pane } from './Pane';
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
    expect(dispatch).toHaveBeenCalledWith({ type: 'sent', text: 'hello', paneId: 'p1', attachments: ['shot.png'], clientRef: expect.any(String) });
    expect(send).toHaveBeenCalledWith({ type: 'send', sessionId: null, cwd: '/w', text: 'hello', model: 'gpt-6-astra', engine: 'codex', sandbox: 'workspace-write', attachments: ['a1'], clientRef: expect.any(String) });
    // T9 prerequisite (a): the frame carries the same clientRef the reducer waits for.
    const ref1 = (dispatch.mock.calls.find((c) => (c[0] as Action).type === 'sent')![0] as { clientRef: string }).clientRef;
    expect((send.mock.calls[0]![0] as { clientRef: string }).clientRef).toBe(ref1);
    fireEvent.click(screen.getByLabelText('패널 닫기'));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    render(<Pane pane={{ ...pane, session: { ...pane.session!, sessionId: 's1', engine: 'claude' } }} app={{ pending: [], questions: [], codexAvailable: true }} active={false} closable={false} dispatch={dispatch} send={send} onClose={onClose} />);
    expect(screen.queryByLabelText('패널 닫기')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/메시지/), { target: { value: 'again' } });
    fireEvent.click(screen.getByText('보내기'));
    // PF13: a Claude session is never sent a GPT model (falls back to the Claude default).
    expect(send).toHaveBeenLastCalledWith({ type: 'send', sessionId: 's1', cwd: '/w', text: 'again', model: 'opus', attachments: ['a1'], clientRef: expect.any(String) });
    const ref2 = (send.mock.lastCall![0] as { clientRef: string }).clientRef;
    expect(ref2).not.toBe(ref1);
  });

  it('shows only the cards that belong to its session', () => {
    const pane: PaneState = { ...newPane('p1'), session: { sessionId: 's1', cwd: '/w', account: 'b', title: 't', engine: 'claude', sandbox: null } };
    const card = (requestId: string, sessionId: string) => ({ turnId: 'x' + requestId, sessionId, cwd: '/w', requestId, toolName: 'Bash', input: {}, title: null, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: false, sessionLabel: null });
    render(<Pane pane={pane} app={{ pending: [card('r1', 's1'), card('r2', 's2')], questions: [], codexAvailable: false }} active closable={false} dispatch={() => {}} send={() => {}} onClose={() => {}} />);
    expect(screen.getAllByText('허용 1회')).toHaveLength(1);
  });

  it('PF11: switching the engine picker to GPT on a new session shows the sandbox picker and GPT models', () => {
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'n' });
    s = { ...s, codexAvailable: true };
    function Harness() {
      const [state, dispatch] = useReducer(reducer, s);
      return <Pane pane={state.panes[0]!} app={state} active closable={false} dispatch={dispatch} send={() => {}} onClose={() => {}} />;
    }
    render(<Harness />);
    expect(screen.queryByTestId('sandbox-select')).toBeNull();
    fireEvent.change(screen.getByTestId('engine-select'), { target: { value: 'codex' } });
    expect(screen.getByTestId('sandbox-select')).toBeTruthy();
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
    expect(select.value).toBe('gpt-6-sol');
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
});
