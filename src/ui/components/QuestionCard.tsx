import { useState } from 'react';
import type { Question, QuestionAnswers } from '../../shared/turn-types';
import { answersFor, type PendingQuestion } from '../state';
import { usePending } from './PermissionCard';

/** Every string the card shows, in one place for the coming i18n pass. */
const T = {
  cardLabel: '질문',
  title: 'Claude 가 선택을 기다려요',
  newSession: '새 세션',
  session: (id: string) => `세션 ${id.slice(0, 8)}`,
  progress: (done: number, total: number) => `${done}/${total} 답변`,
  multi: '여러 개 선택',
  recommended: '추천',
  otherPlaceholder: '기타 (직접 입력)',
  otherLabel: (header: string) => `${header} 직접 입력`,
  remaining: (n: number) => `${n}개 남음`,
  ready: '모두 골랐어요',
  submit: '답변 보내기',
  sending: '보내는 중…',
} as const;

/** "Postgres (Recommended)" → { text: 'Postgres', recommended: true }. Display only: the submitted value stays the raw label. */
const RECOMMENDED_TAIL = /\s*\((?:recommended|추천)\)\s*$/i;
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const text = label.replace(RECOMMENDED_TAIL, '');
  return text !== label && text ? { text, recommended: true } : { text: label, recommended: false };
}

/** Optional per-option preview (code/mockup) forwarded by the server, shown under the picked option. */
const previewOf = (o: Question['options'][number]): string | null => (o.preview?.trim() ? o.preview : null);

export function QuestionCard({ req, onAnswer }: { req: PendingQuestion; onAnswer: (requestId: string, answers: QuestionAnswers) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});
  // Same tap feedback as PermissionCard: lock the form until the server resolves the request (or 8 s pass).
  const [pending, setPending] = usePending<true>(req.requestId);

  // Picking an option and typing free text are mutually exclusive per question: whichever the user
  // touches last wins, and the other mode's state for that question is cleared so the UI never shows
  // a selection (a `.picked` option, or free text) that would not actually be submitted.
  const toggle = (q: Question, label: string) => {
    setFree((f) => (f[q.question] ? { ...f, [q.question]: '' } : f));
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  };
  const setFreeText = (q: Question, value: string) => {
    setFree((f) => ({ ...f, [q.question]: value }));
    if (value.trim()) setPicked((p) => (p[q.question]?.length ? { ...p, [q.question]: [] } : p));
  };
  const answerOf = (q: Question) => (free[q.question]?.trim() || (picked[q.question] ?? []).join(', '));
  const total = req.questions.length;
  const done = req.questions.filter((q) => answerOf(q) !== '').length;
  const complete = done === total;
  // The keys must be the exact question text (Task 9's answersFor is the single source of truth for
  // that mapping — the server drops mismatched keys and denies the request).
  const submit = () => { setPending(true); onAnswer(req.requestId, answersFor(req, req.questions.map((q) => answerOf(q)))); };
  const idBase = `qc-${req.requestId}`;

  return (
    <div className={pending ? 'question-card sending' : 'question-card'} role="group" aria-label={T.cardLabel}>
      <div className="question-head">
        <span className="dot" aria-hidden="true" />
        <span className="question-title">{T.title}</span>
        {total > 1 && <span className="question-progress" data-testid="question-progress">{T.progress(done, total)}</span>}
      </div>
      <div className="question-scope muted" data-testid="question-scope" title={req.cwd}>{req.sessionId ? T.session(req.sessionId) : T.newSession} · {req.cwd}</div>
      {req.questions.map((q, qi) => {
        const answered = answerOf(q) !== '';
        const freeText = free[q.question] ?? '';
        const textId = `${idBase}-q${qi}`;
        return (
          <section key={q.question} className={answered ? 'question answered' : 'question'} aria-labelledby={textId}>
            <div className="question-meta">
              {total > 1 && <span className="question-step" aria-hidden="true">{qi + 1}/{total}</span>}
              {q.header && <span className="chip header">{q.header}</span>}
              {q.multiSelect && <span className="question-multi">{T.multi}</span>}
            </div>
            <div className="question-text" id={textId}>{q.question}</div>
            <div className={q.multiSelect ? 'question-options multi' : 'question-options'} role="group" aria-labelledby={textId}>
              {q.options.map((o) => {
                const isPicked = (picked[q.question] ?? []).includes(o.label);
                const { text, recommended } = splitRecommended(o.label);
                const preview = isPicked ? previewOf(o) : null;
                return (
                  <div key={o.label} className="option-wrap">
                    <button type="button" className={`option ${isPicked ? 'picked' : ''}`} aria-pressed={isPicked} disabled={!!pending} onClick={() => toggle(q, o.label)}>
                      <span className="option-mark" aria-hidden="true" />
                      <span className="option-body">
                        <span className="option-line">
                          <span className="option-label">{text}</span>
                          {recommended && <span className="option-rec">{T.recommended}</span>}
                        </span>
                        {o.description && <span className="option-desc muted">{o.description}</span>}
                      </span>
                    </button>
                    {preview && <pre className="option-preview">{preview}</pre>}
                  </div>
                );
              })}
              <label className={`option other ${freeText.trim() ? 'picked' : ''}`}>
                <span className="option-mark" aria-hidden="true" />
                <input className="question-free" placeholder={T.otherPlaceholder} aria-label={T.otherLabel(q.header)} value={freeText} disabled={!!pending} onChange={(e) => setFreeText(q, e.target.value)} />
              </label>
            </div>
          </section>
        );
      })}
      <div className={pending ? 'question-actions sending' : 'question-actions'}>
        {pending
          ? <span className="muted sending-note" role="status">{T.sending}</span>
          : <span className={complete ? 'question-left ready' : 'question-left'} aria-live="polite" data-testid="question-left">{complete ? T.ready : T.remaining(total - done)}</span>}
        <button type="button" className="btn primary" disabled={!complete || !!pending} onClick={submit}>{T.submit}</button>
      </div>
    </div>
  );
}
