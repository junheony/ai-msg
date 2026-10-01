import type { ClientMessage } from '../../shared/protocol';
import { cardsForPane, engineOf, modelFor, type Action, type AppState, type PaneState } from '../state';
import type { UploadFn } from '../upload';
import { Chat } from './Chat';

// T9 prerequisite (a): every send carries a fresh correlation id so the reducer matches its turn_started / refusal
// to this pane, not to whichever pane waits first. Not crypto.randomUUID — it is missing outside secure contexts
// (plain http over Tailscale); a per-tab random prefix keeps ids from two tabs apart.
const TAB = Math.random().toString(36).slice(2, 10);
let seq = 0;
const nextClientRef = () => `${TAB}-${++seq}`;

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
  // PF13: an existing session is never sent (or shown) a model of the other engine.
  const model = s && !isNew && s.engine ? modelFor(s.engine, pane.model) : pane.model;
  // 자동: effort is 자동 too unless the user picked one (null → omitted; the server picks per model).
  const effort = model === 'auto' ? pane.autoEffort : pane.efforts[engineOf(model)];
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
          onSend={(text) => {
            const ids = pane.attachments.map((a) => a.id);
            const clientRef = nextClientRef();
            dispatch({ type: 'sent', text, paneId: pane.id, attachments: pane.attachments.map((a) => a.name), clientRef });
            send({
              type: 'send', sessionId: s.sessionId, cwd: s.cwd, text, model,
              ...(effort ? { effort } : {}),
              ...(isNew ? { engine: pane.engine, sandbox: pane.sandbox } : {}),
              ...(ids.length ? { attachments: ids } : {}),
              clientRef,
            });
          }}
          onInterrupt={() => { if (pane.activeTurnId) send({ type: 'interrupt', turnId: pane.activeTurnId }); }}
          onDecide={(requestId, decision) => send({ type: 'permission_response', requestId, decision })}
          onAnswer={(requestId, answers) => send({ type: 'question_response', requestId, answers })}
          onModel={(m) => dispatch({ type: 'set_model', model: m, paneId: pane.id })}
          onEffort={(e) => dispatch(model === 'auto' ? { type: 'set_auto_effort', effort: e, paneId: pane.id } : { type: 'set_effort', engine: engineOf(model), effort: e ?? pane.efforts[engineOf(model)], paneId: pane.id })}
          onEngine={(engine) => dispatch({ type: 'set_engine', engine, paneId: pane.id })}
          onSandbox={(sandbox) => dispatch({ type: 'set_sandbox', sandbox, paneId: pane.id })}
          onAttach={(attachment) => dispatch({ type: 'attach', attachment, paneId: pane.id })}
          onUnattach={(id) => dispatch({ type: 'unattach', id, paneId: pane.id })}
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
