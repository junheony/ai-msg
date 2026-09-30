import { useState } from 'react';
import type { Question, QuestionAnswers } from '../../shared/turn-types';
import { answersFor, type PendingQuestion } from '../state';

export function QuestionCard({ req, onAnswer }: { req: PendingQuestion; onAnswer: (requestId: string, answers: QuestionAnswers) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) => setPicked((p) => {
    const cur = p[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    return { ...p, [q.question]: next };
  });
  const answerOf = (q: Question) => (free[q.question]?.trim() || (picked[q.question] ?? []).join(', '));
  const complete = req.questions.every((q) => answerOf(q) !== '');
  // The keys must be the exact question text (Task 9's answersFor is the single source of truth for
  // that mapping — the server drops mismatched keys and denies the request).
  const submit = () => onAnswer(req.requestId, answersFor(req, req.questions.map((q) => answerOf(q))));

  return (
    <div className="question-card">
      <div className="question-head">질문</div>
      <div className="question-scope muted" data-testid="question-scope">{req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}</div>
      {req.questions.map((q) => (
        <div key={q.question} className="question">
          {q.header && <span className="chip header">{q.header}</span>}
          <div className="question-text">{q.question}{q.multiSelect && <span className="muted"> (복수 선택)</span>}</div>
          <div className="question-options">
            {q.options.map((o) => (
              <button type="button" key={o.label} className={`option ${(picked[q.question] ?? []).includes(o.label) ? 'picked' : ''}`} onClick={() => toggle(q, o.label)}>
                <span className="option-label">{o.label}</span>
                {o.description && <span className="option-desc muted">{o.description}</span>}
              </button>
            ))}
          </div>
          <input className="question-free" placeholder="기타 (직접 입력)" value={free[q.question] ?? ''} onChange={(e) => setFree((f) => ({ ...f, [q.question]: e.target.value }))} />
        </div>
      ))}
      <div className="permission-actions">
        <button type="button" disabled={!complete} onClick={submit}>답변 보내기</button>
      </div>
    </div>
  );
}
