import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';
import { parseIsoUtc } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { buildSeats, levelClass, pickMain, useClock, type RouteNext, type SeatData } from './usageSeats';

/** "40m" / "2h" / "3d" for the chip; '' without a (future) reset time. */
export function chipCountdown(resetsAt: string | null | undefined, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now;
  if (Number.isNaN(ms) || ms <= 0) return '';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The same span spelled out for the aria-label ("40분" / "2시간" / "3일"). */
function spokenCountdown(short: string): string {
  const n = short.slice(0, -1);
  return `${n}${short.endsWith('m') ? '분' : short.endsWith('h') ? '시간' : '일'}`;
}

export type ChipKind = 'ok' | 'warn' | 'danger' | 'spent' | 'stale' | 'estimated' | 'cooldown' | 'unknown';

export type ChipState = {
  /** The seat whose numbers the chip shows (null: no session yet — a generic "사용량" chip). */
  target: Seat | null;
  /** Shown as "A→B" when the next turn goes to another seat. */
  nextSeat: Seat | null;
  /** The session's own seat is not known yet (no history): the chip is about the next turn alone ("→B"). */
  onlyNext: boolean;
  kind: ChipKind;
  /** Used % of the fullest window (null without a number). */
  used: number | null;
  /** Short reset countdown of that window ("2h"; '' when unknown). */
  reset: string;
  /** The value text after the label on desktop ("42% · 2h", "소진 · 12m", "쿨다운"). */
  text: string;
  /** The value text on a phone ("42%", "✕", ''). */
  compactText: string;
  /** Another seat (not the target) is red or spent: a small red dot. */
  otherDanger: boolean;
  aria: string;
  title: string;
};

/**
 * What the one usage chip says (design §3.5): the current seat's fullest window as USED %, its reset, where the next
 * turn goes, and a red dot when some other seat is in danger. null = nothing to show at all (hidden).
 */
export function chipState({ seats, current, next, stale: snapshotStale, now, label }: {
  seats: SeatData[]; current: Seat | null; next: RouteNext | null; stale: boolean; now: number; label: (s: Seat) => string;
}): ChipState | null {
  const target = current ?? next?.account ?? null;
  const d = target ? seats.find((s) => s.seat === target) ?? null : null;
  const dangerOf = (s: SeatData) => {
    if (s.dim) return false;
    const m = pickMain(s.rows);
    return !!m && (m.rem === 0 || levelClass(m.row.w) === 'danger');
  };
  const otherDanger = seats.some((s) => s.seat !== target && dangerOf(s));
  const onlyNext = !current && !!next;
  const nextSeat = next && (onlyNext || next.account !== target) ? next.account : null;
  const nextAria = next && !onlyNext ? `, 다음 턴은 ${label(next.account)} 계정${next.asOpus ? '(Opus)' : ''}` : '';
  const nextTitle = next ? `다음 턴: ${label(next.account)}${next.asOpus ? ' · Opus' : ''} — ${next.reason}` : '';
  const dangerAria = otherDanger ? ', 다른 계정 한도 임박' : '';

  if (!d) {
    if (!seats.some((s) => pickMain(s.rows))) return null;
    return {
      target: null, nextSeat: null, onlyNext: false, kind: otherDanger ? 'danger' : 'ok', used: null, reset: '', text: '', compactText: '', otherDanger,
      aria: `사용량 보기${dangerAria}`, title: '계정별 사용량',
    };
  }

  const name = label(d.seat);
  const main = pickMain(d.rows);
  const used = main ? 100 - main.rem : null;
  const reset = main ? chipCountdown(main.row.w?.resetsAt, now) : '';
  const stale = d.dim || d.status === 'stale' || snapshotStale || ((d.status === 'down' || d.status === 'unknown') && !!main);
  const estimated = !!main?.row.w?.estimated || d.status === 'kept';
  let kind: ChipKind;
  let text: string;
  let compactText: string;
  let spoken: string;
  if (d.status === 'cooldown') {
    kind = 'cooldown'; text = '쿨다운'; compactText = '쿨다운'; spoken = '쿨다운 중';
  } else if (main && main.rem === 0) {
    kind = 'spent'; text = reset ? `소진 · ${reset}` : '소진'; compactText = '✕';
    spoken = `소진${reset ? `, ${spokenCountdown(reset)} 뒤 초기화` : ''}`;
  } else if (main) {
    const lvl = levelClass(main.row.w);
    kind = stale ? 'stale' : lvl === 'danger' ? 'danger' : lvl === 'warn' ? 'warn' : estimated ? 'estimated' : 'ok';
    text = `${used}%${stale ? ' · 오래됨' : reset ? ` · ${reset}` : ''}`;
    compactText = `${used}%`;
    spoken = `${used}퍼센트${reset ? `, ${spokenCountdown(reset)} 뒤 초기화` : ''}${stale ? ', 오래된 값' : estimated ? ', 추정' : ''}`;
  } else {
    const ok = d.engine === 'grok' && d.status === 'ok';
    kind = ok ? 'ok' : 'unknown'; text = ok ? '가능' : '?'; compactText = text; spoken = ok ? '사용 가능' : '알 수 없음';
  }
  if (nextSeat) compactText = kind === 'spent' || kind === 'cooldown' ? compactText : '';
  return {
    target: d.seat, nextSeat, onlyNext, kind, used, reset, text, compactText, otherDanger,
    aria: `${onlyNext ? `다음 턴 ${name}${next!.asOpus ? '(Opus)' : ''}` : name} 계정 사용량 ${spoken}${nextAria}${dangerAria}`,
    title: [`${name} 계정${main ? ` · ${main.row.name} ${used}% 사용` : ''}`, d.reasonLine ?? '', nextTitle].filter(Boolean).join(' · '),
  };
}

/** The one usage chip in the top bar; it opens the usage sheet (UsageSheet). */
export function UsageChip({ usage, current, next = null, grok = null, compact = false, open = false, onToggle, now: fixedNow }: {
  usage: UsageSnapshot | null; current: Seat | null; next?: RouteNext | null; grok?: GrokStatus | null;
  /** Phone: the value shrinks to "42%" / "A→B" / "✕". */
  compact?: boolean;
  open?: boolean; onToggle: () => void; now?: number;
}) {
  const now = useClock(fixedNow);
  const { active, label } = useAccounts();
  if (!usage) return null;
  const seats = buildSeats(usage, active, grok, now);
  const st = chipState({ seats, current, next, stale: usage.usageMode !== 'cli' && !usage.deckReachable, now, label });
  if (!st) return null;
  const value = compact ? st.compactText : st.text;
  return (
    <button
      type="button"
      className={`usage-chip ${st.kind}${compact ? ' compact' : ''}`}
      data-testid="usage-chip"
      aria-label={st.aria}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-sheet-return=""
      title={st.title}
      onClick={onToggle}
    >
      <span className="usage-chip-dot" aria-hidden="true" />
      {st.target ? (
        <span className="usage-chip-who">
          {!st.onlyNext && label(st.target)}
          {st.nextSeat && <span className="usage-chip-next" data-testid={`next-${st.nextSeat}`}>→{label(st.nextSeat)}</span>}
        </span>
      ) : <span className="usage-chip-who">사용량</span>}
      {value && <span key={value} className="usage-chip-num">{value}</span>}
      {st.otherDanger && <span className="usage-chip-alert" data-testid="usage-chip-alert" aria-hidden="true" />}
    </button>
  );
}
