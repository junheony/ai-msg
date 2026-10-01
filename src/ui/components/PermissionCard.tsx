import type { PermissionDecision } from '../../shared/turn-types';
import { fileDiffsFor } from '../diff';
import type { PendingPermission } from '../state';
import { DiffList } from './DiffView';

/** "이 세션 동안 `Bash(…)` 허용" → "`Bash(…)`": what the session grant covers, shown under the buttons. */
function sessionRule(label: string | null): string | null {
  if (!label) return null;
  const m = /^이 세션 동안 (.+) 허용$/s.exec(label);
  return m ? m[1]! : label;
}

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const input = JSON.stringify(req.input, null, 2);
  // Edit / Write / … asks show the change they would make, like the tool call card will.
  const diffs = fileDiffsFor(req.toolName, req.input, null);
  const rule = req.allowSession ? sessionRule(req.sessionLabel) : null;
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
      {diffs ? (
        <>
          <DiffList diffs={diffs} cwd={req.cwd} />
          <details className="permission-raw">
            <summary>원본 입력 보기</summary>
            <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>
          </details>
        </>
      ) : <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>}
      <div className="permission-actions">
        {/* defaultToNo: the card opens on 거부 so a stray Enter cannot approve. */}
        <button type="button" className="btn deny" autoFocus={req.defaultToNo} onClick={() => onDecide(req.requestId, 'deny')}>거부</button>
        {/* Review I4: only when an SDK suggestion can be kept for the session; the label says what. */}
        {/* A long rule (e.g. a whole Bash command) must not widen the card: short label here, the rule below. */}
        {req.allowSession && <button type="button" className="btn ghost session-allow" title={req.sessionLabel ?? undefined} onClick={() => onDecide(req.requestId, 'session')}>이 세션 동안 허용</button>}
        <button type="button" className="btn primary" onClick={() => onDecide(req.requestId, 'once')}>허용 1회</button>
      </div>
      {rule && <div className="permission-session-rule muted" data-testid="session-rule">이 세션 동안 허용: <code>{rule}</code></div>}
    </div>
  );
}
