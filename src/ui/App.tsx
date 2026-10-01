import { useEffect, useReducer, useRef, useState } from 'react';
import type { ClientMessage } from '../shared/protocol';
import { Login } from './components/Login';
import { postPin } from './pins';
import { Pane } from './components/Pane';
import { PermissionCard } from './components/PermissionCard';
import { QuestionCard } from './components/QuestionCard';
import { Sidebar } from './components/Sidebar';
import { UsagePanel } from './components/UsagePanel';
import { MAX_PANES, initialState, orphanCards, reducer, sessionsToClose, type Action } from './state';
import { useIsPhone } from './useIsPhone';
import { createSocket } from './ws';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const phone = useIsPhone();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => { void fetch('/api/me').then((r) => setAuthed(r.ok)); }, []);

  useEffect(() => {
    if (!authed) return;
    sock.current = createSocket((msg) => {
      dispatch({ type: 'server', msg });
      // Reconnected: re-open every pane's session (once each) so this socket receives their turn events again (review I3, D6).
      if (msg.type === 'hello') {
        const panes = latest.current.panes;
        for (const id of new Set(panes.map((p) => p.session?.sessionId).filter((x): x is string => !!x))) sock.current?.send({ type: 'open_session', sessionId: id });
        for (const p of panes) {
          if (p.activeTurnId && msg.running.some((r) => r.turnId === p.activeTurnId)) sock.current?.send({ type: 'watch_turn', turnId: p.activeTurnId });
        }
      }
    }, (value) => dispatch({ type: 'connected', value }), () => setAuthed(false));
    return () => sock.current?.close();
  }, [authed]);

  useEffect(() => {
    if (!phone || !drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, drawer]);

  if (authed === null) return <div className="center">확인 중…</div>;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const send = (m: ClientMessage) => sock.current?.send(m);
  /**
   * Pane-changing actions (open / close): the server's per-socket view set must shrink too, so every session
   * no pane views after the action gets a close_session (T9 prerequisite b; duplicate-session panes keep it).
   */
  const apply = (action: Action) => {
    const prev = latest.current;
    const next = reducer(prev, action);
    latest.current = next;
    dispatch(action);
    for (const sessionId of sessionsToClose(prev, next)) send({ type: 'close_session', sessionId });
  };
  const active = state.panes.find((p) => p.id === state.activePaneId) ?? state.panes[0]!;
  const openIn = (paneId: string, sessionId: string | null, cwd: string, title: string) => {
    apply({ type: 'open', sessionId, cwd, title, paneId });
    if (sessionId) send({ type: 'open_session', sessionId });
    setDrawer(false);
  };
  const orphanPerms = orphanCards(state.panes, state.pending);
  const orphanQs = orphanCards(state.panes, state.questions);

  return (
    <div className="app">
      <header>
        {phone && <button type="button" className="menu" aria-label="메뉴" onClick={() => setDrawer((d) => !d)}>☰</button>}
        <span className="brand">deck</span>
        <UsagePanel usage={state.usage} current={active.session?.account ?? null} />
        {!phone && <button type="button" className="split" onClick={() => dispatch({ type: 'add_pane' })} disabled={state.panes.length >= MAX_PANES} title="분할보기 (최대 4)">+ 분할</button>}
        <span className={`conn ${state.connected ? 'on' : 'off'}`}>{state.connected ? '연결됨' : '재연결 중…'}</span>
      </header>
      {state.error && <div className="banner error" onClick={() => dispatch({ type: 'dismiss_error' })}>{state.error} (클릭해서 닫기)</div>}
      {(orphanPerms.length > 0 || orphanQs.length > 0) && (
        <div className="global-cards">
          {orphanPerms.map((p) => <PermissionCard key={p.requestId} req={p} onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })} />)}
          {orphanQs.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })} />)}
        </div>
      )}
      <div className="body">
        {phone && drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
        <div className={`sidebar-wrap ${phone ? 'drawer' : ''} ${drawer ? 'open' : ''}`}>
          <Sidebar
            projects={state.projects}
            currentSessionId={active.session?.sessionId ?? null}
            onOpen={(sessionId, cwd, title) => openIn(active.id, sessionId, cwd, title)}
            onNew={(cwd, name) => openIn(active.id, null, cwd, `${name} · 새 세션`)}
            onRefresh={() => send({ type: 'refresh_index' })}
            pins={state.pins}
            onTogglePin={(sessionId, pinned) => { postPin(sessionId, pinned).then((pins) => dispatch({ type: 'set_pins', pins }), (err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '고정 실패' })); }}
            onOpenFolder={(cwd) => openIn(active.id, null, cwd, `${cwd.split('/').filter(Boolean).pop() ?? cwd} · 새 세션`)}
          />
        </div>
        <div className="panes" data-count={phone ? 1 : state.panes.length}>
          {phone && state.panes.length > 1 && (
            <div className="pane-switch">
              {state.panes.map((p, i) => <button type="button" key={p.id} className={p.id === active.id ? 'on' : ''} onClick={() => dispatch({ type: 'focus_pane', paneId: p.id })}>{i + 1}{p.session ? ` · ${p.session.title.slice(0, 12)}` : ''}</button>)}
            </div>
          )}
          {(phone ? [active] : state.panes).map((p) => (
            <Pane key={p.id} pane={p} app={state} active={p.id === state.activePaneId} closable={state.panes.length > 1} dispatch={dispatch} send={send} onClose={() => apply({ type: 'close_pane', paneId: p.id })} />
          ))}
        </div>
      </div>
    </div>
  );
}
