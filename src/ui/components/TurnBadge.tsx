import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FAST_FELL_BACK_NOTE, FAST_NOTE, modelLabelOf } from '../../shared/models';
import type { TurnBadge as Badge } from '../../shared/protocol';
import { useAccounts } from '../accounts';
import { has } from '../features';
import { COLD_HINT, isCacheCold, type ContextInfo } from '../context';
import { PinIcon } from './AccountPicker';

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The server's text for an interrupted turn (TurnRunner ABORTED). */
const ABORTED = '중단됨';
/** An older server (no 'abortLabel') passed the SDK's own text through for a user interrupt. */
const OLD_SERVER_ABORT = /aborted by user/i;

/**
 * The turn was stopped by the user, not failed: the server says exactly '중단됨', this client sent an interrupt for it
 * (중단, 지금 전송), or an older server's raw SDK "aborted by user". Other abort/cancel texts (timeouts, API or MCP
 * cancellations) are real failures and keep their "오류:" line.
 */
export function isAbortError(error: string | null | undefined, interrupted = false): boolean {
  return !!error && (interrupted || error.trim() === ABORTED || (!has('abortLabel') && OLD_SERVER_ABORT.test(error)));
}

/**
 * A turn that never really ran: interrupted, or finished with no input and no output tokens, or
 * failed before producing any text. Its footer says "중단됨" instead of a row of zeros.
 */
export function isStoppedTurn(t: { badge: Badge; error?: string | null; text?: string; interrupted?: boolean }): boolean {
  const u = t.badge.usage;
  if (isAbortError(t.error, t.interrupted)) return true;
  if (u.inputTokens === 0 && u.outputTokens === 0) return true;
  return !!t.error && !(t.text ?? '').trim() && u.outputTokens === 0;
}

/** A stopped turn that ended on a real error (not an interrupt): its footer says "실패" rather than "중단됨". */
export function isFailedTurn(t: { error?: string | null; interrupted?: boolean }): boolean {
  return !!t.error && !isAbortError(t.error, t.interrupted);
}

/**
 * Turn meta as one small pill at the end of the reply: model · account (pin), and "중단됨" / "실패" for a turn that never
 * really ran. A dot marks a cache note — this turn rewrote the prompt cache (`cacheNote`), or, on the last reply, the
 * cache has gone cold since (`ctx`: the line that used to sit above the composer). Pressing the pill opens the rest:
 * token counts, the routing reason, the model note and those cache lines. Esc or a press outside closes it.
 */
export function TurnBadge({ badge, model, stopped = false, failed = false, cacheNote = null, ctx = null }: { badge: Badge; /** The turn's own model (turn_result / transcript); shown before the badge's. */ model?: string; stopped?: boolean; /** stopped by an error, not an interrupt */ failed?: boolean; /** "캐시 새로 씀 · <reason>" when the turn rewrote the prompt cache. */ cacheNote?: string | null; /** The last reply's context: its cache expiry shows as the dot. */ ctx?: ContextInfo | null }) {
  const u = badge.usage;
  const names = useAccounts();
  const label = names.label(badge.account);
  const look = names.look(badge.account);
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const at = ctx?.at ?? null;
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [at]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const cold = isCacheCold(at, now) ? COLD_HINT : null;
  // ⚡ Only a turn that really ran fast carries ↯ (a standard turn of a session with the switch on shows none).
  const fast = badge.modelNote?.startsWith(FAST_NOTE) ? 'on' : badge.modelNote === FAST_FELL_BACK_NOTE ? 'fell' : null;
  const status = stopped ? (failed ? '실패' : '중단됨') : null;
  const tokens = `입력 ${k(u.inputTokens)} · 출력 ${k(u.outputTokens)} · 캐시 읽기 ${k(u.cacheReadTokens)} · 캐시 쓰기 ${k(u.cacheCreationTokens)}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDetailsElement>) => {
    if (e.key !== 'Escape' || !ref.current?.open) return;
    e.preventDefault();
    e.stopPropagation();
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
  };
  return (
    <details ref={ref} className={`turn-badge${stopped ? ' stopped' : ''}`} data-testid="turn-badge" onToggle={(e) => setOpen(e.currentTarget.open)} onKeyDown={onKeyDown}>
      <summary className="tb-pill">
        <span className="tb-model">{modelLabelOf(model ?? badge.model)}</span>
        <span className={`acct ${look.kind === 'other' ? `acct-${badge.account}` : `acct-${look.kind}`}`} {...(look.slot !== null ? { 'data-acct-idx': look.slot } : {})} title={`계정 ${label}${look.kind === 'unknown' ? ' · 설정에 없는 계정' : look.kind === 'retired' ? ' · 뺀 계정' : ''}${badge.pinned ? ' · 고정' : ''}`}><span className="acct-name">{label}</span></span>
        {fast && <span className={`tb-fast${fast === 'fell' ? ' fell' : ''}`} data-testid="badge-fast" title={badge.modelNote!}><span aria-hidden="true">{fast === 'on' ? '↯' : '↯→표준'}</span><span className="sr-only">{badge.modelNote}</span></span>}
        {badge.pinned && <span className="tb-pin" data-testid="badge-pin"><PinIcon title="고정 계정" /></span>}
        {status && <span className="tb-stopped" title={tokens}>{status}</span>}
        {(cacheNote || cold) && <span className="tb-dot" data-testid="badge-dot"><span className="sr-only">캐시 알림</span></span>}
      </summary>
      <div className="tb-detail">
        {!stopped && (
          <span className="tb-tokens">
            <span>입력 <b>{k(u.inputTokens)}</b></span>
            <span>출력 <b>{k(u.outputTokens)}</b></span>
            <span>캐시 읽기 <b>{k(u.cacheReadTokens)}</b></span>
            {cacheNote
              ? <span className="tb-cold" title={cacheNote}>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>
              : <span>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>}
          </span>
        )}
        <span className="reason">{badge.reason}</span>
        {badge.modelNote && <span className="note">{badge.modelNote}</span>}
        {cacheNote && <span className="tb-cache">{cacheNote}</span>}
        {cold && <span className="tb-cache" data-testid="badge-cold">{cold}</span>}
      </div>
    </details>
  );
}
