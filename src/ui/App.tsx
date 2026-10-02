import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import type { ClientMessage } from '../shared/protocol';
import { Login } from './components/Login';
import { NotifyMenu } from './components/NotifyMenu';
import { postPin } from './pins';
import { findHitElement } from './scrollToHit';
import { postSessionMeta } from './sessionApi';
import { Pane, useQueueRunner } from './components/Pane';
import { PermissionCard } from './components/PermissionCard';
import { QuestionCard } from './components/QuestionCard';
import { Sidebar } from './components/Sidebar';
import { UsagePanel } from './components/UsagePanel';
import { claimReload, hasDraftText, isNewBuild, shouldAutoReload } from './autoReload';
import { hydrate, loadSent, loadUi, saveSent, saveUi, snapshotUi } from './persist';
import { findSession } from './push';
import { MAX_PANES, initialState, orphanCards, reducer, sessionsToClose, type Action } from './state';
import { useIsPhone } from './useIsPhone';
import { createSocket } from './ws';

const TITLE = 'deck';
/** Tab title: "● deck" while any turn runs; "✓ deck" when one finished while the tab was hidden, until it is shown. */
function useTabTitle(running: boolean) {
  const was = useRef(running);
  useEffect(() => {
    const finished = was.current && !running;
    was.current = running;
    if (running) document.title = `● ${TITLE}`;
    else if (finished && document.hidden) document.title = `✓ ${TITLE}`;
    else if (!document.hidden || document.title.startsWith('●')) document.title = TITLE;
  }, [running]);
  useEffect(() => {
    const onVis = () => { if (!document.hidden && document.title.startsWith('✓')) document.title = TITLE; };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // ux-state: panes, pickers, folded sidebar groups and the drawer come back after a reload (persist.ts).
  const saved = useMemo(() => loadUi(), []);
  const [state, dispatch] = useReducer(reducer, saved, (ui) => hydrate(initialState, ui));
  const [collapsed, setCollapsed] = useState<string[]>(() => saved?.collapsed ?? []);
  const firstBuild = useRef<string | null | undefined>(undefined);
  const [newBuild, setNewBuild] = useState(false);
  const sock = useRef<ReturnType<typeof createSocket> | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const phone = useIsPhone();
  const [drawer, setDrawer] = useState(() => saved?.drawer ?? false);
  const lastSaved = useRef<string | null>(null);
  useEffect(() => { lastSaved.current = saveUi(snapshotUi(state, { collapsed, drawer }), lastSaved.current); }, [state.panes, state.activePaneId, collapsed, drawer]);
  // Sent files per session (thumbnails after a transcript reload): re-saved only when some pane's sent files change.
  const sentSig = state.panes.map((p) => `${p.session?.sessionId ?? ''}:${p.items.filter((it) => it.kind === 'user' && it.attachments?.length).length}`).join('|');
  useEffect(() => { saveSent(latest.current.panes); }, [sentSig]);
  // A 대화 내용 검색 hit being opened: once its pane has loaded the transcript, scroll to the message containing it.
  const [scrollTo, setScrollTo] = useState<{ paneId: string; sessionId: string; snippet: string; match: string; until: number } | null>(null);

  useEffect(() => { void fetch('/api/me').then((r) => setAuthed(r.ok)); }, []);

  useEffect(() => {
    if (!authed) return;
    sock.current = createSocket((msg) => {
      dispatch(msg.type === 'history' ? { type: 'server', msg, sentFiles: loadSent(msg.sessionId) } : { type: 'server', msg });
      // Reconnected: re-open every pane's session (once each) so this socket receives their turn events again (review I3, D6).
      if (msg.type === 'hello') {
        // A restarted server with a new UI build: reload when nothing is at stake, else offer the pill.
        const build = msg.build ?? null;
        if (firstBuild.current === undefined) firstBuild.current = build;
        else if (isNewBuild(firstBuild.current, build)) {
          const next = reducer(latest.current, { type: 'server', msg });
          if (shouldAutoReload({ draftText: hasDraftText(), state: next }) && claimReload(build!)) { location.reload(); return; }
          setNewBuild(true);
        }
        const panes = latest.current.panes;
        for (const id of new Set(panes.map((p) => p.session?.sessionId).filter((x): x is string => !!x))) sock.current?.send({ type: 'open_session', sessionId: id });
        for (const p of panes) {
          if (p.activeTurnId && msg.running.some((r) => r.turnId === p.activeTurnId)) sock.current?.send({ type: 'watch_turn', turnId: p.activeTurnId });
        }
      }
    }, (value) => dispatch({ type: 'connected', value }), () => setAuthed(false));
    return () => sock.current?.close();
  }, [authed]);

  useQueueRunner(state.panes, state.connected, dispatch, (m) => sock.current?.send(m));
  useTabTitle(state.activity.some((a) => a.running) || state.panes.some((p) => p.activeTurnId !== null));
  // PWA: a notification click opens deck at /?session=<id> or, with deck already open, posts the id here.
  const [openReq, setOpenReq] = useState<string | null>(() => new URLSearchParams(window.location.search).get('session'));
  const openById = useRef<(sessionId: string) => boolean>(() => false);
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMsg = (e: MessageEvent) => { const d = e.data as { type?: unknown; sessionId?: unknown } | null; if (d?.type === 'deck-open-session' && typeof d.sessionId === 'string') setOpenReq(d.sessionId); };
    sw.addEventListener('message', onMsg);
    return () => sw.removeEventListener('message', onMsg);
  }, []);
  useEffect(() => {
    if (!openReq || !state.connected) return;
    if (openById.current(openReq) || state.projects.length > 0) {
      setOpenReq(null);
      if (window.location.search) window.history.replaceState(null, '', '/');
    }
  }, [openReq, state.connected, state.projects]);

  useEffect(() => {
    if (!phone || !drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, drawer]);

  useEffect(() => {
    if (!scrollTo) return;
    if (Date.now() > scrollTo.until) { setScrollTo(null); return; }
    const pane = state.panes.find((p) => p.id === scrollTo.paneId);
    if (pane?.session?.sessionId !== scrollTo.sessionId) { setScrollTo(null); return; }
    const root = document.querySelector(`[data-testid="pane-${scrollTo.paneId}"]`);
    // After the pane's own scroll-to-bottom (it runs in the same commit), hence the frame delay.
    const id = requestAnimationFrame(() => {
      const el = root && findHitElement(root, scrollTo.snippet, scrollTo.match);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 2000);
      setScrollTo(null);
    });
    return () => cancelAnimationFrame(id);
  }, [scrollTo, state.panes]);

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
  openById.current = (sessionId) => {
    const pane = state.panes.find((p) => p.session?.sessionId === sessionId);
    if (pane) { dispatch({ type: 'focus_pane', paneId: pane.id }); return true; }
    const hit = findSession(state.projects, state.desktop, sessionId);
    if (!hit) return false;
    openIn(active.id, sessionId, hit.cwd, hit.title);
    return true;
  };
  const orphanPerms = orphanCards(state.panes, state.pending);
  const orphanQs = orphanCards(state.panes, state.questions);

  return (
    <div className="app">
      <header className="topbar">
        {phone && <button type="button" className="menu" aria-label="메뉴" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>☰</button>}
        <span className="brand"><span className="spark" aria-hidden="true">✳</span>deck</span>
        <UsagePanel usage={state.usage} current={active.session?.account ?? null} />
        <div className="topbar-end">
          {!phone && <button type="button" className="text-btn split" onClick={() => dispatch({ type: 'add_pane' })} disabled={state.panes.length >= MAX_PANES} title={`분할보기 (최대 ${MAX_PANES})`}>+ 분할</button>}
          <NotifyMenu />
          <span className={`conn ${state.connected ? 'on' : 'off'}`} title={state.connected ? '연결됨' : '재연결 중…'}>{state.connected ? '연결됨' : '재연결 중…'}</span>
        </div>
      </header>
      {newBuild && <button type="button" className="update-pill" onClick={() => location.reload()}>새 버전이 있어요 · 새로고침</button>}
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
            desktop={state.desktop}
            autoApprove={state.autoApprove}
            onAutoApprove={(autoApprove) => send({ type: 'set_settings', autoApprove })}
            onTogglePin={(sessionId, pinned) => { postPin(sessionId, pinned).then((pins) => dispatch({ type: 'set_pins', pins }), (err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '고정 실패' })); }}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onRename={(sessionId, title) => { postSessionMeta(sessionId, { title }).catch((err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '이름 바꾸기 실패' })); }}
            onArchive={(sessionId, archived) => { postSessionMeta(sessionId, { archived }).catch((err: unknown) => dispatch({ type: 'show_error', message: err instanceof Error ? err.message : '보관 실패' })); }}
            onOpenHit={(h) => {
              if (active.session?.sessionId !== h.sessionId) openIn(active.id, h.sessionId, h.cwd, h.title);
              else setDrawer(false);
              setScrollTo({ paneId: active.id, sessionId: h.sessionId, snippet: h.snippet, match: h.snippet.slice(h.matchStart, h.matchStart + h.matchLength), until: Date.now() + 15_000 });
            }}
            activity={state.activity}
            unread={state.unread}
            onOpenFolder={(cwd) => openIn(active.id, null, cwd, `${cwd.split('/').filter(Boolean).pop() ?? cwd} · 새 세션`)}
          />
        </div>
        <div className="panes" data-count={phone ? 1 : state.panes.length} style={{ '--cols': phone ? 1 : state.panes.length } as CSSProperties}>
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
