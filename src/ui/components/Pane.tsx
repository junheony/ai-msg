import { useEffect, useRef } from 'react';
import type { Effort, ModelChoice } from '../../shared/models';
import type { ClientMessage } from '../../shared/protocol';
import { cardsForPane, engineOf, modelFor, nextQueued, type Action, type AppState, type PaneState, type UploadedAttachment } from '../state';
import type { UploadFn } from '../upload';
import { Chat } from './Chat';

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
export function sendFromPane(pane: PaneState, text: string, attachments: UploadedAttachment[], dispatch: (a: Action) => void, send: (m: ClientMessage) => void): void {
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
    ...(s.sessionId === null ? { engine: pane.engine, sandbox: pane.sandbox } : {}),
    ...(ids.length ? { attachments: ids } : {}),
    clientRef,
  });
}

/**
 * ux-state: when a pane's turn is over, its next queued message goes out by itself (once per queue item).
 * Runs at app level so panes not rendered (phone shows one) still drain their queues.
 */
export function useQueueRunner(panes: PaneState[], connected: boolean, dispatch: (a: Action) => void, send: (m: ClientMessage) => void): void {
  const fired = useRef(new Set<string>());
  useEffect(() => {
    if (!connected) return;
    for (const p of panes) {
      const next = nextQueued(p);
      if (!next || fired.current.has(next.id)) continue;
      fired.current.add(next.id);
      dispatch({ type: 'queue_remove', id: next.id, paneId: p.id });
      sendFromPane(p, next.text, next.attachments, dispatch, send);
    }
  });
}

/** One split-view pane: its own session, items and composer; user actions become `send`/`dispatch` here (D6). */
export function Pane({ pane, app, active, closable, dispatch, send, onClose, uploadFn }: {
  pane: PaneState;
  app: Pick<AppState, 'pending' | 'questions' | 'codexAvailable'> & Partial<Pick<AppState, 'gemini'>>;
  active: boolean;
  closable: boolean;
  dispatch: (a: Action) => void;
  send: (m: ClientMessage) => void;
  onClose: () => void;
  uploadFn?: UploadFn;
}) {
  const s = pane.session;
  const focus = () => { if (!active) dispatch({ type: 'focus_pane', paneId: pane.id }); };
  const isNew = s?.sessionId === null;
  const model = paneModel(pane);
  const effort = paneEffort(pane, model);
  const close = closable && <button type="button" className="icon-btn pane-close" aria-label="패널 닫기" title="패널 닫기" onClick={onClose}>✕</button>;
  return (
    <section className={`pane ${active ? 'active' : ''}`} data-testid={`pane-${pane.id}`} onMouseDownCapture={focus} onFocusCapture={focus}>
      {s ? (
        <Chat
          items={pane.items}
          pending={cardsForPane(pane, app.pending)}
          questions={cardsForPane(pane, app.questions)}
          activeTurnId={pane.activeTurnId}
          busy={pane.activeTurnId !== null || pane.awaitingStart}
          title={s.title}
          cwd={s.cwd}
          sessionId={s.sessionId}
          headActions={close}
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
          onSend={(text) => sendFromPane(pane, text, pane.attachments, dispatch, send)}
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
          onModel={(m) => dispatch({ type: 'set_model', model: m, paneId: pane.id })}
          onEffort={(e) => dispatch(model === 'auto' ? { type: 'set_auto_effort', effort: e, paneId: pane.id } : { type: 'set_effort', engine: engineOf(model), effort: e ?? pane.efforts[engineOf(model)], paneId: pane.id })}
          onEngine={(engine) => dispatch({ type: 'set_engine', engine, paneId: pane.id })}
          onSandbox={(sandbox) => dispatch({ type: 'set_sandbox', sandbox, paneId: pane.id })}
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
          <div className="chat center muted">왼쪽에서 세션을 고르거나 새 세션을 시작하세요.</div>
        </>
      )}
    </section>
  );
}
