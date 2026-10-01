import type { PermissionDecision } from '../../shared/turn-types';
import type { PendingPermission } from '../state';

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const input = JSON.stringify(req.input, null, 2);
  return (
    <div className="permission-card" role="group" aria-label={`권한 요청 ${req.toolName}`}>
      <div className="permission-head"><span className="dot" aria-hidden="true" />권한 요청 <strong>{req.toolName}</strong></div>
      {/* Review I3: prompts from every session reach every tab — say which one this is. */}
      <div className="permission-scope muted" data-testid="permission-scope" title={req.cwd}>
        {req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}
      </div>
      {req.title && <div className="permission-title">{req.title}</div>}
      {req.decisionReason && <div className="permission-reason muted">이유: {req.decisionReason}</div>}
      {req.blockedPath && <div className="permission-path muted">경로: {req.blockedPath}</div>}
      <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>
      <div className="permission-actions">
        {/* defaultToNo: the card opens on 거부 so a stray Enter cannot approve. */}
        <button type="button" className="btn deny" autoFocus={req.defaultToNo} onClick={() => onDecide(req.requestId, 'deny')}>거부</button>
        {/* Review I4: only when an SDK suggestion can be kept for the session; the label says what. */}
        {req.allowSession && <button type="button" className="btn ghost" onClick={() => onDecide(req.requestId, 'session')}>{req.sessionLabel ?? '이 세션'}</button>}
        <button type="button" className="btn primary" onClick={() => onDecide(req.requestId, 'once')}>허용 1회</button>
      </div>
    </div>
  );
}
