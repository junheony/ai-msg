import { useEffect, useState } from 'react';
import type { PermissionDecision } from '../../shared/turn-types';
import { fileDiffsFor } from '../diff';
import type { PendingPermission } from '../state';
import { DiffList } from './DiffView';
import { ui } from '../i18n';
import { Markdown } from './MessageView';

/**
 * How long a card stays in its "보내는 중…" state after a tap. The card normally unmounts on the server's
 * `*_resolved` message; if that never comes (dead socket) the buttons come back so the person can try
 * again, or see that it is stuck.
 */
export const CARD_PENDING_RESET_MS = 8_000;

/**
 * Tapping a button gives no feedback until the server answers, so people tap again. `pending` holds the
 * sent value until the request changes or the fallback timer fires (see CARD_PENDING_RESET_MS).
 */
export function usePending<T>(requestId: string) {
  const [pending, setPending] = useState<T | null>(null);
  useEffect(() => { setPending(null); }, [requestId]);
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setPending(null), CARD_PENDING_RESET_MS);
    return () => clearTimeout(t);
  }, [pending]);
  return [pending, setPending] as const;
}

/** The folder's own name; the full path stays in the tooltip (cards show it only inside the activity sheet, CSS). */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

const sendingNote = () => <span className="muted sending-note" role="status">{ui().cards.permission.sending}</span>;

/**
 * Words in a shell command worth a second look before allowing it: underlined in --danger. A small list on purpose —
 * a hint, not a verdict (the person still reads the whole command).
 */
const DANGER = /\brm\s+-[a-z]*[rf][a-z]*\b|\bsudo\b|(?<![\w-])--force(?:-with-lease)?(?![\w-])|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f[a-z]*\b|\bchmod\s+-R\b|\bmkfs\b|\bdd\s+if=/gi;

/** A command split into plain and dangerous stretches (see DANGER), in order. */
export function dangerSpans(cmd: string): { text: string; danger: boolean }[] {
  const out: { text: string; danger: boolean }[] = [];
  let at = 0;
  for (const m of cmd.matchAll(DANGER)) {
    if (m.index! > at) out.push({ text: cmd.slice(at, m.index), danger: false });
    out.push({ text: m[0], danger: true });
    at = m.index! + m[0].length;
  }
  if (at < cmd.length) out.push({ text: cmd.slice(at), danger: false });
  return out;
}

/** One thing 이 세션 would stop asking about: a permission rule, a folder, or file edits (acceptEdits). */
export type SessionGrant = { kind: 'rule'; rule: string } | { kind: 'dir'; dir: string } | { kind: 'edits' };

/**
 * The server sends 이 세션 as one Korean sentence (Engine `sessionAllowLabel`: "이 세션 동안 `Bash(x)`, `/d` 폴더 접근, 파일 편집
 * 허용"); read its items back so the card can say them in the UI language. null when the sentence is not in that shape.
 */
export function sessionGrants(label: string | null): SessionGrant[] | null {
  const m = label ? /^이 세션 동안 (.+) 허용$/s.exec(label) : null;
  if (!m) return null;
  const out: SessionGrant[] = [];
  const ITEM = /`([^`]+)`( 폴더 접근)?|파일 편집/g;
  let rest = m[1]!;
  for (const g of m[1]!.matchAll(ITEM)) {
    out.push(g[1] === undefined ? { kind: 'edits' } : g[2] ? { kind: 'dir', dir: g[1]! } : { kind: 'rule', rule: g[1]! });
    rest = rest.replace(g[0], '');
  }
  // Anything left besides the ", " separators means a shape this reader does not know: better the raw sentence than a wrong list.
  return out.length && !rest.replace(/,\s*/g, '').trim() ? out : null;
}

/** What 이 세션 동안 허용 covers, in a sentence next to the buttons (a tooltip alone never shows on a phone). */
function SessionScope({ label }: { label: string | null }) {
  const T = ui().cards.permission;
  const grants = sessionGrants(label);
  if (!grants) return label ? <div className="permission-session-rule muted" data-testid="session-rule">{label}</div> : null;
  return (
    <div className="permission-session-rule muted" data-testid="session-rule">
      {T.sessionScope}{' '}
      {grants.map((g, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {g.kind === 'rule' ? <code title={g.rule}>{clip(g.rule, 160)}</code> : g.kind === 'dir' ? T.sessionDir(g.dir) : T.sessionEdits}
        </span>
      ))}
    </div>
  );
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '…' : s);

/** What the tool would do, readable: Bash as its description and `$ command`; any other tool as key · value rows. */
function InputView({ toolName, input }: { toolName: string; input: unknown }) {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const command = obj ? str(obj.command) : null;
  if (toolName === 'Bash' && command) {
    const description = str(obj!.description);
    return (
      <>
        {description && <div className="permission-desc">{description}</div>}
        <pre className="permission-cmd" data-testid="permission-cmd" tabIndex={0}><code><span className="permission-prompt" aria-hidden="true">$ </span>
          {dangerSpans(command).map((s, i) => (s.danger ? <span key={i} className="danger-token" data-testid="danger-token">{s.text}</span> : s.text))}
        </code></pre>
      </>
    );
  }
  if (!obj) return input === null || input === undefined ? null : <pre className="permission-cmd">{clip(String(typeof input === 'string' ? input : JSON.stringify(input)), 2000)}</pre>;
  const rows = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (rows.length === 0) return null;
  return (
    <dl className="permission-kv" data-testid="permission-kv">
      {rows.map(([k, v]) => (
        <div key={k} className="permission-kv-row">
          <dt>{k}</dt>
          <dd>{clip(typeof v === 'string' ? v : JSON.stringify(v), 300)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 계획 모드: ExitPlanMode asks to leave plan mode with its plan. 'session' = approve and auto-accept edits,
 * 'once' = approve and keep asking, 'deny' = keep planning (the server maps these, TurnRunner/ClaudeEngine).
 */
function PlanCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const T = ui().cards.plan;
  const raw = req.input && typeof req.input === 'object' ? (req.input as { plan?: unknown }).plan : undefined;
  const plan = typeof raw === 'string' ? raw : '';
  const [pending, setPending] = usePending<PermissionDecision>(req.requestId);
  const decide = (d: PermissionDecision) => { setPending(d); onDecide(req.requestId, d); };
  return (
    <div className="permission-card plan-card" role="group" aria-label={T.label} data-testid="plan-card">
      <div className="permission-head"><span className="dot" aria-hidden="true" />{T.label}</div>
      <div className="permission-scope muted" title={req.cwd}>{folderName(req.cwd)}</div>
      <div className="plan-body">{plan ? <Markdown text={plan} /> : <span className="muted">{T.empty}</span>}</div>
      <div className={pending ? 'permission-actions sending' : 'permission-actions'}>
        <button type="button" className="btn deny" disabled={!!pending} onClick={() => decide('deny')}>{T.keepPlanning}</button>
        <button type="button" className="btn ghost" disabled={!!pending} title={T.manualTitle} onClick={() => decide('once')}>{T.manual}</button>
        <button type="button" className="btn primary" disabled={!!pending} title={T.autoTitle} onClick={() => decide('session')}>{T.auto}</button>
        {pending && sendingNote()}
      </div>
    </div>
  );
}

export function PermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  // Split so each variant owns its hooks (no hook sits behind the early return).
  return req.toolName === 'ExitPlanMode' ? <PlanCard req={req} onDecide={onDecide} /> : <ToolPermissionCard req={req} onDecide={onDecide} />;
}

function ToolPermissionCard({ req, onDecide }: { req: PendingPermission; onDecide: (requestId: string, decision: PermissionDecision) => void }) {
  const T = ui().cards.permission;
  const [pending, setPending] = usePending<PermissionDecision>(req.requestId);
  const decide = (d: PermissionDecision) => { setPending(d); onDecide(req.requestId, d); };
  const input = JSON.stringify(req.input, null, 2) ?? '';
  // Edit / Write / … asks show the change they would make, like the tool call card will.
  const diffs = fileDiffsFor(req.toolName, req.input, null);
  return (
    <div className="permission-card" role="group" aria-label={T.label(req.toolName)}>
      <div className="permission-head"><span className="dot" aria-hidden="true" />{T.head} <strong>{req.toolName}</strong></div>
      {/* Review I3: prompts from every session reach every tab — the activity sheet says which one (CSS shows this there only). */}
      <div className="permission-scope muted" data-testid="permission-scope" title={req.cwd}>{folderName(req.cwd)}</div>
      {req.title && <div className="permission-title">{req.title}</div>}
      {req.decisionReason && <div className="permission-reason muted">{T.reason(req.decisionReason)}</div>}
      {req.blockedPath && <div className="permission-path muted">{T.path(req.blockedPath)}</div>}
      {diffs ? <DiffList diffs={diffs} cwd={req.cwd} /> : <InputView toolName={req.toolName} input={req.input} />}
      {input && input !== '{}' && input !== 'null' && (
        <details className="permission-raw">
          <summary>{T.details}</summary>
          <pre>{input.length > 2000 ? input.slice(0, 2000) + '\n…' : input}</pre>
        </details>
      )}
      {req.allowSession && <SessionScope label={req.sessionLabel} />}
      <div className={pending ? 'permission-actions sending' : 'permission-actions'}>
        {/* defaultToNo: the card opens on 거부 so a stray Enter cannot approve. */}
        <button type="button" className="btn deny" autoFocus={req.defaultToNo} disabled={!!pending} onClick={() => decide('deny')}>{T.deny}</button>
        {/* Review I4: only when an SDK suggestion can be kept for the session; what it keeps is the line above the buttons. */}
        {req.allowSession && <button type="button" className="btn ghost session-allow" disabled={!!pending} onClick={() => decide('session')}>{T.allowSession}</button>}
        <button type="button" className="btn primary" disabled={!!pending} onClick={() => decide('once')}>{T.allowOnce}</button>
        {pending && sendingNote()}
      </div>
    </div>
  );
}
