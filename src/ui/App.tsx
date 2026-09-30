import { useEffect, useReducer, useRef, useState } from 'react';
import { isAccount } from '../shared/accounts';
import type { ClientMessage } from '../shared/protocol';
import { Chat } from './components/Chat';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { UsagePanel } from './components/UsagePanel';
import { initialState, reducer } from './state';
import { createSocket } from './ws';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);
  const openSessionId = useRef<string | null>(null);
  openSessionId.current = state.session?.sessionId ?? null;
  const activeTurn = useRef<string | null>(null);
  activeTurn.current = state.activeTurnId;

  useEffect(() => { void fetch('/api/me').then((r) => setAuthed(r.ok)); }, []);

  useEffect(() => {
    if (!authed) return;
    sock.current = createSocket((msg) => {
      dispatch({ type: 'server', msg });
      // Reconnected: re-open the current session so this socket receives its turn events again (review I3).
      if (msg.type === 'hello') {
        if (openSessionId.current) sock.current?.send({ type: 'open_session', sessionId: openSessionId.current });
        const t = activeTurn.current;
        if (t && msg.running.some((r) => r.turnId === t)) sock.current?.send({ type: 'watch_turn', turnId: t });
      }
    }, (value) => dispatch({ type: 'connected', value }), () => setAuthed(false));
    return () => sock.current?.close();
  }, [authed]);

  if (authed === null) return <div className="center">확인 중…</div>;
  if (!authed) return <Login onLoggedIn={() => setAuthed(true)} />;

  const send = (m: ClientMessage) => sock.current?.send(m);
  const session = state.session;

  return (
    <div className="app">
      <header>
        <span className="brand">deck</span>
        <UsagePanel usage={state.usage} current={session?.account && isAccount(session.account) ? session.account : null} />
        <span className={`conn ${state.connected ? 'on' : 'off'}`}>{state.connected ? '연결됨' : '재연결 중…'}</span>
      </header>
      {state.error && <div className="banner error" onClick={() => dispatch({ type: 'dismiss_error' })}>{state.error} (클릭해서 닫기)</div>}
      <div className="body">
        <Sidebar
          projects={state.projects}
          currentSessionId={session?.sessionId ?? null}
          onOpen={(sessionId, cwd, title) => { dispatch({ type: 'open', sessionId, cwd, title }); send({ type: 'open_session', sessionId }); }}
          onNew={(cwd, name) => dispatch({ type: 'open', sessionId: null, cwd, title: `${name} · 새 세션` })}
          onRefresh={() => send({ type: 'refresh_index' })}
        />
        {session ? (
          <Chat
            items={state.items}
            pending={state.pending}
            activeTurnId={state.activeTurnId}
            busy={state.activeTurnId !== null || state.awaitingStart}
            model={state.model}
            title={`${session.title} — ${session.cwd}`}
            onSend={(text) => { dispatch({ type: 'sent', text }); send({ type: 'send', sessionId: session.sessionId, cwd: session.cwd, text, model: state.model }); }}
            onInterrupt={() => { if (state.activeTurnId) send({ type: 'interrupt', turnId: state.activeTurnId }); }}
            onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })}
            onModel={(model) => dispatch({ type: 'set_model', model })}
          />
        ) : (
          <main className="chat center muted">왼쪽에서 세션을 고르거나 새 세션을 시작하세요.</main>
        )}
      </div>
    </div>
  );
}
