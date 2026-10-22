import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FAST_FELL_BACK_NOTE, FAST_NOTE, modelLabelOf } from '../../shared/models';
import type { TurnBadge as Badge } from '../../shared/protocol';
import { useAccounts } from '../accounts';
import { has } from '../features';
import { COLD_HINT, isCacheCold, type ContextInfo } from '../context';
import { PinIcon } from './AccountPicker';
import { ui } from '../i18n';

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

type BadgeProps = { badge: Badge; /** The turn's own model (turn_result / transcript); shown before the badge's. */ model?: string; stopped?: boolean; /** stopped by an error, not an interrupt */ failed?: boolean; /** "캐시 새로 씀 · <reason>" when the turn rewrote the prompt cache. */ cacheNote?: string | null; /** The last reply's context: its cache expiry shows as the dot. */ ctx?: ContextInfo | null; /** The reply before named the same model: the pill leaves the name to screen readers (account and states stay). */ repeat?: boolean; /** On the reply's meta line: the account reads as text ("계정 A") like the line's other items, not a tile. */ inline?: boolean };

/**
 * Turn meta as the first item of the reply's meta line: model · account (pin), and "중단됨" / "실패" for a turn that never
 * really ran. A dot marks a cache note — this turn rewrote the prompt cache (`cacheNote`), or, on the last reply, the
 * cache has gone cold since (`ctx`: the line that used to sit above the composer). Pressing the pill opens the rest under
 * the line (TurnMeta places `detail`): token counts, the routing reason, the model note and those cache lines.
 */
export function useTurnBadge(props: BadgeProps | null, open: boolean, onToggle: () => void, panelId: string): { pill: ReactNode; detail: ReactNode } {
  const names = useAccounts();
  const [now, setNow] = useState(() => Date.now());
  const at = props?.ctx?.at ?? null;
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [at]);
  if (!props) return { pill: null, detail: null };
  const { badge, model, stopped = false, failed = false, cacheNote = null, repeat = false, inline = false } = props;
  const u = badge.usage;
  const label = names.label(badge.account);
  const look = names.look(badge.account);
  const cold = isCacheCold(at, now) ? COLD_HINT : null;
  // ⚡ Only a turn that really ran fast carries ↯ (a standard turn of a session with the switch on shows none).
  const fast = badge.modelNote?.startsWith(FAST_NOTE) ? 'on' : badge.modelNote === FAST_FELL_BACK_NOTE ? 'fell' : null;
  const status = stopped ? (failed ? '실패' : '중단됨') : null;
  const tokens = `입력 ${k(u.inputTokens)} · 출력 ${k(u.outputTokens)} · 캐시 읽기 ${k(u.cacheReadTokens)} · 캐시 쓰기 ${k(u.cacheCreationTokens)}`;
  const modelName = modelLabelOf(model ?? badge.model);
  const note = ui().chat.accountNote;
  const acctTitle = [ui().chat.account(label), look.kind === 'unknown' ? note.unknown : look.kind === 'retired' ? note.retired : '', badge.pinned ? note.pinned : ''].filter(Boolean).join(' · ');
  const pill = (
    <button type="button" className={`turn-badge tb-pill${stopped ? ' stopped' : ''}`} data-testid="turn-badge" aria-expanded={open} aria-controls={panelId} title={repeat ? modelName : undefined} onClick={onToggle}>
      <span className={repeat ? 'tb-model sr-only' : 'tb-model'}>{modelName}</span>
      {inline
        ? <span className="acct-text" title={acctTitle}>{ui().chat.account(label)}</span>
        : <span className={`acct ${look.kind === 'other' ? `acct-${badge.account}` : `acct-${look.kind}`}`} {...(look.slot !== null ? { 'data-acct-idx': look.slot } : {})} title={acctTitle}><span className="acct-name">{label}</span></span>}
      {fast && <span className={`tb-fast${fast === 'fell' ? ' fell' : ''}`} data-testid="badge-fast" title={badge.modelNote!}><span aria-hidden="true">{fast === 'on' ? '↯' : '↯→표준'}</span><span className="sr-only">{badge.modelNote}</span></span>}
      {badge.pinned && <span className="tb-pin" data-testid="badge-pin"><PinIcon title={note.pin} /></span>}
      {status && <span className="tb-stopped" title={tokens}>{status}</span>}
      {(cacheNote || cold) && <span className="tb-dot" data-testid="badge-dot"><span className="sr-only">캐시 알림</span></span>}
    </button>
  );
  const detail = (
    <div id={panelId} className="tb-detail" data-testid="turn-badge-detail" hidden={!open}>
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
  );
  return { pill, detail };
}

/** The pill on its own, its detail right under it (outside a reply's meta line). */
export function TurnBadge(props: BadgeProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { pill, detail } = useTurnBadge(props, open, () => setOpen((o) => !o), id);
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    e.currentTarget.querySelector<HTMLElement>('.tb-pill')?.focus();
  };
  return <span className="turn-badge-solo" onKeyDown={onKeyDown}>{pill}{detail}</span>;
}
