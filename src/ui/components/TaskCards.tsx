import type { TaskInfo } from '../../shared/tasks';

const STATUS_LABEL: Record<TaskInfo['status'], string> = { queued: '대기 중', running: '작업 중', done: '완료', failed: '실패' };

/**
 * 백그라운드 작업 cards in the chat they were started from: what runs (or waits for a slot) and, once done, the result's
 * first line with a link to the task's own session. Newest first; 닫기 forgets an ended one.
 */
export function TaskCards({ tasks, cap = null, onOpen, onDismiss }: {
  tasks: TaskInfo[];
  /** The soft cap (shown on a waiting card). */
  cap?: number | null;
  onOpen?: (t: TaskInfo) => void;
  onDismiss?: (taskId: string) => void;
}) {
  if (!tasks.length) return null;
  return (
    <div className="task-cards" data-testid="task-cards">
      {tasks.map((t) => {
        const ended = t.status === 'done' || t.status === 'failed';
        return (
          <div key={t.taskId} className={`task-card ${t.status}`} data-testid="task-card" role={ended ? 'status' : undefined}>
            <div className="task-card-head">
              <span className={`task-badge ${t.status}`}>{STATUS_LABEL[t.status]}</span>
              <span className="task-title" title={t.title}>{t.title}</span>
            </div>
            {ended && t.line && <div className="task-line">{t.line}</div>}
            {t.status === 'queued' && <div className="task-line muted">동시 작업 {cap ?? '?'}개가 끝나면 시작합니다</div>}
            <div className="task-actions">
              {t.sessionId && onOpen && <button type="button" className="btn ghost" data-testid="task-open" onClick={() => onOpen(t)}>{ended ? '결과 열기' : '열어 보기'}</button>}
              {ended && onDismiss && <button type="button" className="btn ghost" data-testid="task-dismiss" onClick={() => onDismiss(t.taskId)}>닫기</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
