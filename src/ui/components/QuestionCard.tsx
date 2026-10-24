import { useEffect, useRef, useState } from 'react';
import type { Question, QuestionAnswers } from '../../shared/turn-types';
import { ui } from '../i18n';
import { answersFor, type PendingQuestion } from '../state';
import { folderName, usePending } from './PermissionCard';

/** "Postgres (Recommended)" → { text: 'Postgres', recommended: true }. Display only: the submitted value stays the raw label. */
const RECOMMENDED_TAIL = /\s*\((?:recommended|추천)\)\s*$/i;
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const text = label.replace(RECOMMENDED_TAIL, '');
  return text !== label && text ? { text, recommended: true } : { text: label, recommended: false };
}

/** Optional per-option preview (code/mockup) forwarded by the server, shown under the picked option. */
const previewOf = (o: Question['options'][number]): string | null => (o.preview?.trim() ? o.preview : null);
/** A question with previews is compared before it is decided: no send-on-tap, no moving on after a pick. */
const hasPreview = (q: Question) => q.options.some((o) => previewOf(o) !== null);

/**
 * AskUserQuestion as a stepper: one question open at a time (`‹ 1/3 ›`), answered ones folded to one tappable line with ✓.
 * A single-select pick moves on to the next unanswered question; one single-select question sends on the tap itself
 * (neither when the question has previews to compare).
 * 기타 is one more option of the same shape (checkbox in a multi-select, so it combines with the other picks; radio in a
 * single-select) that opens a two-line text box.
 */
export function QuestionCard({ req, onAnswer }: { req: PendingQuestion; onAnswer: (requestId: string, answers: QuestionAnswers) => void }) {
  const T = ui().cards.question;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState(0);
  // Keyboard focus follows a step change the person made (the open question and the folded lines are different elements).
  const moved = useRef(false);
  // The 기타 box takes focus when it is switched on, not each time its question is reopened.
  const openedOther = useRef<string | null>(null);
  const go = (i: number) => { moved.current = true; setStep(i); };
  // Same tap feedback as PermissionCard: lock the form until the server resolves the request (or 8 s pass).
  const [pending, setPending] = usePending<true>(req.requestId);

  const qs = req.questions;
  const total = qs.length;
  const instant = total === 1 && !qs[0]!.multiSelect && !hasPreview(qs[0]!);
  const answerFrom = (q: Question, p: Record<string, string[]>, f: Record<string, string>, on: Record<string, boolean>) => {
    const text = on[q.question] ? (f[q.question] ?? '').trim() : '';
    return [...(p[q.question] ?? []), ...(text ? [text] : [])].join(', ');
  };
  const answerOf = (q: Question) => answerFrom(q, picked, free, otherOn);
  const done = qs.filter((q) => answerOf(q) !== '').length;
  const complete = done === total;
  // The keys must be the exact question text (answersFor is the single source of truth for that mapping — the server
  // drops mismatched keys and denies the request).
  const send = (values: string[]) => { setPending(true); onAnswer(req.requestId, answersFor(req, values)); };
  const submit = () => send(qs.map((q) => answerOf(q)));

  /** After a single-select pick: the next unanswered question after `from` (wrapping), or stay when all are answered. */
  const advance = (from: number, nextPicked: Record<string, string[]>) => {
    for (let k = 1; k < total; k++) {
      const i = (from + k) % total;
      if (answerFrom(qs[i]!, nextPicked, free, otherOn) === '') { go(i); return; }
    }
  };

  const toggle = (qi: number, label: string) => {
    const q = qs[qi]!;
    // Mark the pick first so the sending card shows what went out.
    if (instant) { setPicked({ [q.question]: [label] }); send([label]); return; }
    const cur = picked[q.question] ?? [];
    const next = { ...picked, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label] };
    setPicked(next);
    if (!q.multiSelect) {
      setOtherOn((o) => ({ ...o, [q.question]: false }));
      if (!hasPreview(q)) advance(qi, next);
    }
  };
  const toggleOther = (q: Question) => {
    const on = !otherOn[q.question];
    // Single-select: 기타 is the radio's last choice, so it clears the pick; reopening it keeps the text typed before.
    if (!q.multiSelect) { if (!on) return; setPicked((p) => ({ ...p, [q.question]: [] })); }
    openedOther.current = on ? q.question : null;
    setOtherOn((o) => ({ ...o, [q.question]: on }));
  };

  const idBase = `qc-${req.requestId}`;
  const cur = Math.min(step, total - 1);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    document.getElementById(`${idBase}-q${cur}`)?.focus();
  }, [cur, idBase]);

  const renderQuestion = (q: Question, qi: number) => {
    const textId = `${idBase}-q${qi}`;
    const other = !!otherOn[q.question];
    const choiceRole = q.multiSelect ? undefined : 'radio';
    return (
      <section key={q.question} className="question" data-testid="question-open">
        {/* A focus target for screen readers after ‹ › (not a control): the stylesheet never draws a ring on it. */}
        <div className="question-text" id={textId} tabIndex={-1}>{q.question}</div>
        <div className={q.multiSelect ? 'question-options multi' : 'question-options'} role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={textId} aria-describedby={q.multiSelect ? `${textId}-multi` : undefined}>
          {q.options.map((o) => {
            const isPicked = (picked[q.question] ?? []).includes(o.label);
            const { text, recommended } = splitRecommended(o.label);
            const preview = isPicked ? previewOf(o) : null;
            return (
              <div key={o.label} className="option-wrap">
                <button type="button" className={`option ${isPicked ? 'picked' : ''}`} role={choiceRole} {...(choiceRole ? { 'aria-checked': isPicked } : { 'aria-pressed': isPicked })} disabled={!!pending} onClick={() => toggle(qi, o.label)}>
                  <span className="option-mark" aria-hidden="true" />
                  <span className="option-body">
                    <span className="option-line">
                      <span className="option-label">{text}</span>
                      {recommended && <span className="option-rec">{T.recommended}</span>}
                    </span>
                    {o.description && <span className="option-desc">{o.description}</span>}
                  </span>
                </button>
                {preview && <pre className="option-preview" tabIndex={0}>{preview}</pre>}
              </div>
            );
          })}
          <div className={other ? 'option-wrap other-wrap open' : 'option-wrap other-wrap'}>
            <button type="button" className={`option other ${other ? 'picked' : ''}`} role={choiceRole} {...(choiceRole ? { 'aria-checked': other } : { 'aria-pressed': other })} disabled={!!pending} onClick={() => toggleOther(q)}>
              <span className="option-mark" aria-hidden="true" />
              <span className="option-body"><span className="option-line"><span className="option-plus" aria-hidden="true">+</span><span className="option-label">{T.other}</span></span></span>
            </button>
            {other && (
              <textarea className="question-free" rows={2} ref={(el) => { if (el && openedOther.current === q.question) { openedOther.current = null; el.focus(); } }} placeholder={T.otherPlaceholder} aria-label={T.otherLabel(q.header || q.question)} value={free[q.question] ?? ''} disabled={!!pending}
                onChange={(e) => setFree((f) => ({ ...f, [q.question]: e.target.value }))} />
            )}
          </div>
        </div>
      </section>
    );
  };

  const showActions = !instant || !!otherOn[qs[0]!.question];
  return (
    <div className={pending ? 'question-card sending' : 'question-card'} role="group" aria-label={T.cardLabel}>
      {/* One quiet line: the open question's header (or 질문) and 여러 개 선택, then ‹ 1/3 ›. "Waiting for you" is said
          once, by the status line above the composer. */}
      <div className="question-head">
        <span className="dot" aria-hidden="true" />
        <span className="question-label" data-testid="question-label">{qs[cur]!.header || T.cardLabel}</span>
        {qs[cur]!.multiSelect && <span className="question-multi" id={`${idBase}-q${cur}-multi`}>{T.multi}</span>}
        {total > 1 && (
          <span className="question-nav">
            <button type="button" className="question-nav-btn" aria-label={T.prev} disabled={cur === 0} onClick={() => go(cur - 1)}>‹</button>
            <span className="question-progress" data-testid="question-progress" aria-live="polite">{T.step(cur + 1, total)}</span>
            <button type="button" className="question-nav-btn" aria-label={T.next} disabled={cur === total - 1} onClick={() => go(cur + 1)}>›</button>
          </span>
        )}
      </div>
      <div className="question-scope muted" data-testid="question-scope" title={req.cwd}>{folderName(req.cwd)}</div>
      {qs.map((q, qi) => {
        if (qi === cur) return renderQuestion(q, qi);
        const answer = answerOf(q);
        if (!answer) return null;
        return (
          <button key={q.question} type="button" className="question-done" data-testid="question-done" title={T.reopen(q.question)} disabled={!!pending} onClick={() => go(qi)}>
            <span className="question-done-n" aria-hidden="true">{qi + 1}</span>
            <span className="question-done-text">{q.header || q.question} · <b>{[...(picked[q.question] ?? []).map((l) => splitRecommended(l).text), ...(otherOn[q.question] && free[q.question]?.trim() ? [free[q.question]!.trim()] : [])].join(', ')}</b></span>
            <span className="question-done-check" aria-hidden="true">✓</span>
          </button>
        );
      })}
      {showActions && (
        <div className={pending ? 'question-actions sending' : 'question-actions'}>
          {pending && <span className="muted sending-note" role="status">{T.sending}</span>}
          <button type="button" className="btn question-send" data-testid="question-send" disabled={!complete || !!pending} onClick={submit}>
            {complete ? (instant ? T.send : T.submit) : T.left(total - done)}
          </button>
        </div>
      )}
      {!showActions && pending && <div className="question-actions sending"><span className="muted sending-note" role="status">{T.sending}</span></div>}
    </div>
  );
}
