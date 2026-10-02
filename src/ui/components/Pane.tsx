import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Effort, ModelChoice } from '../../shared/models';
import { HANDOFF_PROMPT } from '../../shared/handoff';
import type { ClientMessage } from '../../shared/protocol';
import type { ProjectEntry } from '../../shared/session-types';
import { linksOf, versionsAt } from '../../shared/branches';
import { cardsForPane, engineOf, modelFor, nextQueued, paneMode, type Action, type AppState, type PaneState, type UploadedAttachment } from '../state';
import type { UploadFn } from '../upload';
import { Chat, modelChoices } from './Chat';
import { ModelPicker } from './ModelPicker';
import { ForkMenu } from './ForkMenu';
import { NewChat } from './NewChat';
import { OpenInDesktop } from './OpenInDesktop';
import { SidePanel } from './SidePanel';
import { SidePanelContext, clampSideWidth, type SideDoc } from '../sidePanel';

// T9 prerequisite (a): every send carries a fresh correlation id so the reducer matches its turn_started / refusal
// to this pane, not to whichever pane waits first. Not crypto.randomUUID — it is missing outside secure contexts
// (plain http over Tailscale); a per-tab random prefix keeps ids from two tabs apart.
const TAB = Math.random().toString(36).slice(2, 10);
let seq = 0;
const nextClientRef = () => `${TAB}-${++seq}`;

/** The model a pane sends with. PF13: an existing session is never sent (or shown) a model of the other engine. */
function paneModel(pane: PaneState) {
  const s = pane.session;
  return s && s.sessionId !== null && s.engine ? modelFor(s.engine, pane.model) : pane.model;
}

/** 자동: effort is 자동 too unless the user picked one (null → omitted; the server picks per model). */
function paneEffort(pane: PaneState, model: ModelChoice): Effort | null {
  return model === 'auto' ? pane.autoEffort : pane.efforts[engineOf(model)];
}

/** Sends `text` (+ attachments) as the pane's next turn: `sent` for the reducer, `send` for the server. */
export function sendFromPane(pane: PaneState, text: string, attachments: UploadedAttachment[], dispatch: (a: Action) => void, send: (m: ClientMessage) => void, defaultMode: AppState['defaultPermMode'] = null): void {
  const s = pane.session;
  if (!s) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const ids = attachments.map((a) => a.id);
  const clientRef = nextClientRef();
  dispatch({ type: 'sent', text, paneId: pane.id, attachments: attachments.map((a) => ({ id: a.id, name: a.name, isImage: a.isImage })), clientRef });
  send({
    type: 'send', sessionId: s.sessionId, cwd: s.cwd, text, model,
    ...(effort ? { effort } : {}),
    ...(s.sessionId === null ? { engine: pane.engine, sandbox: pane.sandbox, ...(s.accountPin ? { accountPin: s.accountPin } : {}), ...(s.permissionMode || defaultMode ? { permissionMode: paneMode(pane, defaultMode) } : {}) } : {}),
    ...(ids.length ? { attachments: ids } : {}),
    ...(s.sessionId === null && pane.handoffFrom ? { handoffFrom: pane.handoffFrom.sessionId } : {}),
    clientRef,
  });
}

/** 새 세션으로 이어가기, step 1: the handoff-note turn in the current session (same account and model: warm cache). */
export function startHandoff(pane: PaneState, dispatch: (a: Action) => void, send: (m: ClientMessage) => void): void {
  const s = pane.session;
  if (!s?.sessionId || pane.activeTurnId !== null || pane.awaitingStart) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const clientRef = nextClientRef();
  dispatch({ type: 'sent', text: HANDOFF_PROMPT, paneId: pane.id, clientRef, handoff: true });
  send({ type: 'send', sessionId: s.sessionId, cwd: s.cwd, text: HANDOFF_PROMPT, model, ...(effort ? { effort } : {}), handoff: true, clientRef });
}

/**
 * 메시지 편집 갈래: `text` replaces user message `n` (shown as `original`) of the pane's Claude session. The pane turns
 * into the new branch session at once (same cwd, pin and model); the server forks the transcript and the meta links it.
 */
export function startBranch(pane: PaneState, n: number, text: string, original: string, dispatch: (a: Action) => void, send: (m: ClientMessage) => void): void {
  const s = pane.session;
  if (!s?.sessionId || pane.activeTurnId !== null || pane.awaitingStart) return;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const clientRef = nextClientRef();
  dispatch({ type: 'branch_edit', n, text, paneId: pane.id, clientRef });
  send({
    type: 'send', sessionId: null, cwd: s.cwd, text, model, ...(effort ? { effort } : {}), engine: 'claude',
    ...(s.accountPin ? { accountPin: s.accountPin } : {}),
    branch: { from: s.sessionId, n, ...(original ? { expect: original } : {}) },
    clientRef,
  });
}

/** A session's title in the index (falls back to its id's head). */
function titleIn(projects: ProjectEntry[], sessionId: string): { title: string; cwd: string | null } {
  const e = projects.flatMap((p) => p.sessions).find((x) => x.sessionId === sessionId);
  return { title: e?.title ?? sessionId.slice(0, 8), cwd: e?.cwd ?? null };
}

/**
 * ux-state: when a pane's turn is over, its next queued message goes out by itself (once per queue item).
 * Runs at app level so panes not rendered (phone shows one) still drain their queues.
 */
export function useQueueRunner(panes: PaneState[], connected: boolean, dispatch: (a: Action) => void, send: (m: ClientMessage) => void, defaultMode: AppState['defaultPermMode'] = null): void {
  const fired = useRef(new Set<string>());
  useEffect(() => {
    if (!connected) return;
    for (const p of panes) {
      // A mode picked during a new session's first turn goes out once the id is known (before any queued message).
      const s = p.session;
      if (s?.sessionId && s.permissionModePending && s.permissionMode) {
        dispatch({ type: 'set_permission_mode', mode: s.permissionMode, paneId: p.id });
        send({ type: 'set_permission_mode', sessionId: s.sessionId, mode: s.permissionMode });
      }
      const next = nextQueued(p);
      if (!next || fired.current.has(next.id)) continue;
      fired.current.add(next.id);
      dispatch({ type: 'queue_remove', id: next.id, paneId: p.id });
      sendFromPane(p, next.text, next.attachments, dispatch, send, defaultMode);
    }
  });
}

/** One split-view pane: its own session, items and composer; user actions become `send`/`dispatch` here (D6). */
export function Pane({ pane, app, active, closable, dispatch, send, onClose, onOpenSession, onStartChat, newChatCwd, uploadFn }: {
  pane: PaneState;
  app: Pick<AppState, 'pending' | 'questions' | 'codexAvailable'> & Partial<Pick<AppState, 'gemini' | 'usage' | 'projects' | 'defaultPermMode'>>;
  active: boolean;
  closable: boolean;
  dispatch: (a: Action) => void;
  send: (m: ClientMessage) => void;
  onClose: () => void;
  /** Opens a session in this pane (the 이전 세션 / 새 세션으로 이어감 links). */
  onOpenSession?: (sessionId: string, cwd: string, title: string) => void;
  /** The empty pane's start box: a new session in `cwd`, `text` (if any) sent as its first message with `attachments`. */
  onStartChat?: (cwd: string, name: string, text: string, attachments: UploadedAttachment[]) => void;
  /** The empty pane's preselected project. */
  newChatCwd?: string | null;
  uploadFn?: UploadFn;
}) {
  const s = pane.session;
  // Side panel (artifacts / file preview): per pane, closed by ✕ or Esc, dropped when the pane's session changes.
  const [side, setSide] = useState<SideDoc | null>(null);
  const [sideWidth, setSideWidth] = useState(440);
  const sectionRef = useRef<HTMLElement>(null);
  const openSide = useCallback((doc: SideDoc) => setSide(doc), []);
  const sessionKey = s ? `${s.sessionId ?? ''}\n${s.cwd}` : '';
  useEffect(() => { setSide(null); }, [sessionKey]);
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only the pane the user is in (split view: one Esc closes one panel).
      if (!active && !sectionRef.current?.contains(document.activeElement)) return;
      setSide(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [side, active]);
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = sectionRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => setSideWidth(clampSideWidth(box.right - ev.clientX, box.width));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const focus = () => { if (!active) dispatch({ type: 'focus_pane', paneId: pane.id }); };
  const isNew = s?.sessionId === null;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const fileBtn = s && <button type="button" className="icon-btn side-open" aria-label="파일 열기" title="파일 — 사이드 패널에서 세션 폴더의 파일 보기" aria-pressed={!!side} onClick={() => setSide(side ? null : { kind: 'pick' })}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></svg>
    <span className="side-open-label">파일</span>
  </button>;
  const close = closable && <button type="button" className="icon-btn pane-close" aria-label="패널 닫기" title="패널 닫기" onClick={onClose}>✕</button>;
  const busy = pane.activeTurnId !== null || pane.awaitingStart;
  const onModel = (m: ModelChoice) => dispatch({ type: 'set_model', model: m, paneId: pane.id });
  const onEffort = (e: Effort | null) => dispatch(model === 'auto' ? { type: 'set_auto_effort', effort: e, paneId: pane.id } : { type: 'set_effort', engine: engineOf(model), effort: e ?? pane.efforts[engineOf(model)], paneId: pane.id });
  const fork = s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && (
    <ForkMenu sessionId={s.sessionId} busy={busy} onResolved={() => send({ type: 'open_session', sessionId: s.sessionId! })} onError={(message) => dispatch({ type: 'show_error', message })} />
  );
  const desktop = s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && (
    <OpenInDesktop sessionId={s.sessionId} onError={(message) => dispatch({ type: 'show_error', message })} />
  );
  // 새 세션으로 이어가기: Claude sessions with an id, nothing running.
  const canHandoff = !!s?.sessionId && s.engine !== 'codex' && s.engine !== 'gemini' && !busy;
  const projects = app.projects ?? [];
  const entry = s?.sessionId ? projects.flatMap((p) => p.sessions).find((x) => x.sessionId === s.sessionId) : undefined;
  // 메시지 편집 갈래: Claude sessions with an id; otherwise 편집 puts the text in the composer (the note says why).
  const canBranch = canHandoff;
  const editNote = !s?.sessionId ? '아직 저장되지 않은 새 세션이라 입력창에 넣습니다' : s.engine === 'codex' || s.engine === 'gemini' ? 'GPT·Gemini 세션은 대화를 갈라 편집할 수 없어 입력창에 넣습니다' : busy ? '실행 중에는 입력창에 넣습니다' : null;
  // Stable while the index and the session stay the same, so the memoized transcript does not re-render on every delta.
  const openRef = useRef(onOpenSession);
  openRef.current = onOpenSession;
  const sid = s?.sessionId ?? null;
  const cwd = s?.cwd ?? '';
  const versions = useMemo(() => {
    const all = projects.flatMap((p) => p.sessions);
    const links = linksOf(all);
    const known = new Set(all.map((x) => x.sessionId));
    return (n: number) => {
      if (!sid) return null;
      const v = versionsAt(links, sid, n);
      if (!v) return null;
      // A version whose session was deleted (휴지통) is skipped; its children still link to it and stay grouped.
      const own = v.members[v.index]!;
      const members = v.members.filter((id) => id === own || id === sid || known.has(id));
      if (members.length < 2) return null;
      return { index: Math.max(0, members.indexOf(own)), count: members.length, go: (i: number) => { const id = members[i]; if (id && id !== sid) { const t = titleIn(projects, id); openRef.current?.(id, t.cwd ?? cwd, t.title); } } };
    };
  }, [projects, sid, cwd]);
  // A refused edit (message not found, folder gone…) leaves an unsent new session: go back to the original instead.
  const branchUndo = useRef<{ sessionId: string; cwd: string; title: string } | null>(null);
  useEffect(() => {
    const u = branchUndo.current;
    if (!u || pane.awaitingStart) return;
    branchUndo.current = null;
    if (pane.myTurns.length === 0 && pane.session?.sessionId === null) openRef.current?.(u.sessionId, u.cwd, u.title);
  }, [pane.awaitingStart, pane.myTurns.length, pane.session?.sessionId]);
  const prevId = entry?.prevSession ?? pane.handoffFrom?.sessionId ?? null;
  const link = (id: string | null) => {
    if (!id || !s) return null;
    const t = titleIn(projects, id);
    return { title: id === pane.handoffFrom?.sessionId && !t.cwd ? pane.handoffFrom.title : t.title, open: () => onOpenSession?.(id, t.cwd ?? s.cwd, t.title) };
  };
  return (
    <section ref={sectionRef} className={`pane ${active ? 'active' : ''}${side && s ? ' with-side' : ''}`} data-testid={`pane-${pane.id}`} onMouseDownCapture={focus} onFocusCapture={focus}>
      <SidePanelContext.Provider value={s ? openSide : null}>
      {s ? (
        <Chat
          items={pane.items}
          pending={cardsForPane(pane, app.pending)}
          questions={cardsForPane(pane, app.questions)}
          activeTurnId={pane.activeTurnId}
          busy={busy}
          title={s.title}
          cwd={s.cwd}
          sessionId={s.sessionId}
          headActions={<>{fileBtn}{desktop}{fork}{close}</>}
          model={model}
          effort={effort}
          engine={pane.engine}
          sandbox={pane.sandbox}
          sessionEngine={s.engine}
          sessionSandbox={s.sandbox}
          isNew={isNew}
          codexAvailable={app.codexAvailable}
          gemini={app.gemini ?? null}
          attachments={pane.attachments}
          uploadFn={uploadFn}
          onSend={(text) => sendFromPane(pane, text, pane.attachments, dispatch, send, app.defaultPermMode ?? null)}
          onBranch={canBranch ? (n, text, original) => { branchUndo.current = { sessionId: s.sessionId!, cwd: s.cwd, title: s.title }; startBranch(pane, n, text, original, dispatch, send); } : undefined}
          editNote={editNote}
          versions={versions}
          onHandoff={canHandoff ? () => startHandoff(pane, dispatch, send) : undefined}
          handoffWriting={pane.handoff !== null}
          prefill={pane.prefill}
          prevSession={link(prevId)}
          nextSession={link(entry?.nextSession ?? null)}
          onInterrupt={() => {
            if (!pane.activeTurnId) return;
            // ux-state: stop keeps the queue but pauses it — the next message must not fire into the stop.
            if (pane.queue.length) dispatch({ type: 'queue_pause', paneId: pane.id });
            send({ type: 'interrupt', turnId: pane.activeTurnId });
          }}
          onStopBackground={(turnId) => send({ type: 'interrupt', turnId })}
          onStopTask={(taskId) => { if (pane.bg) send({ type: 'stop_task', turnId: pane.bg.turnId, taskId }); }}
          runStartedAt={pane.runStartedAt}
          progress={pane.progress}
          agents={pane.agents}
          bg={pane.bg}
          queue={pane.queue}
          queuePaused={pane.queuePaused}
          onQueue={(text) => dispatch({ type: 'queue_add', text, paneId: pane.id })}
          onQueueEdit={(id, text) => dispatch({ type: 'queue_edit', id, text, paneId: pane.id })}
          onQueueRemove={(id) => dispatch({ type: 'queue_remove', id, paneId: pane.id })}
          onQueueClear={() => dispatch({ type: 'queue_clear', paneId: pane.id })}
          onQueueResume={() => dispatch({ type: 'queue_resume', paneId: pane.id })}
          onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })}
          onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })}
          onModel={onModel}
          onEffort={onEffort}
          onEngine={(engine) => dispatch({ type: 'set_engine', engine, paneId: pane.id })}
          onSandbox={(sandbox) => dispatch({ type: 'set_sandbox', sandbox, paneId: pane.id })}
          accountPin={s.accountPin ?? null}
          account={s.account}
          usage={app.usage ?? null}
          onAccountPin={(pin) => {
            dispatch({ type: 'set_account_pin', pin, paneId: pane.id });
            // An existing session's pin lives on the server (applied from its next turn); a new one rides the first send.
            if (s.sessionId) send({ type: 'set_account_pin', sessionId: s.sessionId, pin });
          }}
          permMode={paneMode(pane, app.defaultPermMode ?? null)}
          onPermMode={(mode) => {
            dispatch({ type: 'set_permission_mode', mode, paneId: pane.id });
            // An existing session's mode lives on the server (a running turn switches at once); a new one rides the first
            // send, or — picked while that send's turn runs — goes out when the id arrives (useQueueRunner).
            if (s.sessionId) send({ type: 'set_permission_mode', sessionId: s.sessionId, mode });
          }}
          onAttach={(attachment) => dispatch({ type: 'attach', attachment, paneId: pane.id })}
          onUnattach={(id) => {
            const url = pane.attachments.find((a) => a.id === id)?.previewUrl;
            if (url) URL.revokeObjectURL(url);
            dispatch({ type: 'unattach', id, paneId: pane.id });
          }}
        />
      ) : (
        <>
          {close && <div className="chat-head"><span className="spacer" />{close}</div>}
          {onStartChat
            ? <NewChat projects={projects} defaultCwd={newChatCwd ?? null} onStart={onStartChat} {...(onOpenSession ? { onOpenSession } : {})} {...(uploadFn ? { uploadFn } : {})}
                modelPicker={<ModelPicker models={modelChoices(pane.engine)} model={model} effort={effort} onModel={onModel} onEffort={onEffort} />} />
            : <div className="chat center muted">왼쪽에서 세션을 고르거나 새 세션을 시작하세요.</div>}
        </>
      )}
      {side && s && (
        <>
          <div className="side-splitter" role="separator" aria-orientation="vertical" aria-label="사이드 패널 크기 조절" onPointerDown={startResize} />
          <div className="side-wrap" style={{ width: sideWidth }}>
            <SidePanel doc={side} cwd={s.cwd} sessionId={s.sessionId} onClose={() => setSide(null)} onOpen={openSide} />
          </div>
        </>
      )}
      </SidePanelContext.Provider>
    </section>
  );
}
