import type { PermissionDecision } from '../../shared/turn-types';
import type { PendingPermission } from '../state';

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const input = JSON.stringify(req.input, null, 2);
  return (
    <div className="permission-card">
      <div className="permission-head">권한 요청: <strong>{req.toolName}</strong></div>
      {/* Review I3: prompts from every session reach every tab — say which one this is. */}
      <div className="permission-scope muted" data-testid="permission-scope">
        {req.sessionId ? `세션 ${req.sessionId.slice(0, 8)}` : '새 세션'} · {req.cwd}
      </div>
      <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>
      <div className="permission-actions">
        <button type="button" onClick={() => onDecide(req.requestId, 'once')}>허용 1회</button>
        <button type="button" onClick={() => onDecide(req.requestId, 'session')}>이 세션</button>
        <button type="button" className="deny" onClick={() => onDecide(req.requestId, 'deny')}>거부</button>
      </div>
    </div>
  );
}
