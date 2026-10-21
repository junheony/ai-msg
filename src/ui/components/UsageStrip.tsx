import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { chipState, spokenCountdown, type ChipKind } from './UsageChip';
import { buildSeats, pickMain, useClock, type RouteNext, type SeatData } from './usageSeats';

/**
 * How much each segment says, widest first: full = label · bar · % · reset; mid = label · % (the reset only when amber /
 * red / spent); min = label · %. row = not even min fits in the top bar: the strip moves to a line of its own under the
 * bar (mid, scrolled sideways), as on a phone — every seat stays in view, never a one-seat summary.
 */
export type StripStage = 'full' | 'mid' | 'min' | 'row';
const STAGES = ['full', 'mid', 'min'] as const;
export type StripNeeds = Record<(typeof STAGES)[number], number>;

/** Extra room a wider stage needs before it comes back, so a width near a boundary does not flicker between two. */
export const STRIP_SLACK = 16;

/**
 * The widest stage that fits `avail` px. Going back up (to a wider stage than `cur`) asks STRIP_SLACK more than the
 * stage needs; staying or going down asks only the need itself.
 */
export function pickStage(cur: StripStage, avail: number, need: StripNeeds, slack = STRIP_SLACK): StripStage {
  const rank = (s: StripStage) => (s === 'row' ? STAGES.length : STAGES.indexOf(s));
  for (const s of STAGES) {
    if (avail >= need[s] + (rank(s) < rank(cur) ? slack : 0)) return s;
  }
  return 'row';
}

/** One seat in the strip. */
export type StripSeg = {
  seat: Seat;
  label: string;
  kind: ChipKind;
  /** Old numbers (a dashed outline; the amber / red of kind kept). */
  stale: boolean;
  /** The bar's fill in % (spent / cooldown: full); null: no number, an empty track. */
  bar: number | null;
  /** "42%", "소진", "쿨다운", "가능", "?". */
  value: string;
  /** "2h", "12m" (spent), "오래됨"; '' when none. */
  reset: string;
  spoken: string;
  current: boolean;
  /** The next turn goes here (and not to the current seat). */
  next: boolean;
};

/** Every seat as a strip segment, in buildSeats order; the numbers and words come from chipState (one seat each). */
export function stripSegs({ seats, current, next, stale, now, label }: {
  seats: SeatData[]; current: Seat | null; next: RouteNext | null; stale: boolean; now: number; label: (s: Seat) => string;
}): StripSeg[] {
  return seats.map((d) => {
    const st = chipState({ seats, current: d.seat, next: null, stale, now, label })!;
    const spent = st.kind === 'spent';
    const cooldown = st.kind === 'cooldown';
    const value = cooldown ? '쿨다운' : spent ? '소진' : st.used !== null ? `${st.used}%` : st.text;
    const reset = cooldown ? '' : spent ? st.reset : st.used !== null ? (st.stale ? '오래됨' : st.reset) : '';
    const said = value === '?' ? '알 수 없음' : value === '가능' ? '사용 가능' : value;
    const spoken = `${label(d.seat)} ${said}${spent && reset ? ` ${spokenCountdown(reset)} 뒤 초기화` : ''}${st.stale ? ' 오래됨' : st.kind === 'estimated' ? ' 추정' : ''}`;
    return {
      seat: d.seat, label: label(d.seat), kind: st.kind, stale: st.stale || st.kind === 'stale',
      bar: spent || cooldown ? 100 : st.used, value, reset, spoken,
      current: d.seat === current, next: !!next && next.account === d.seat && next.account !== current,
    };
  });
}

/** The reset is said in mid only when it matters: amber, red, spent. */
const loud = (k: ChipKind) => k === 'warn' || k === 'danger' || k === 'spent';

function Segment({ s, stage, measure }: { s: StripSeg; stage: Exclude<StripStage, 'row'>; measure?: boolean }) {
  const reset = stage === 'full' || (stage === 'mid' && loud(s.kind)) ? s.reset : '';
  return (
    <span
      className={`usage-seg ${s.kind}${s.stale && s.kind !== 'stale' ? ' stale' : ''}`}
      {...(s.current ? { 'data-current': '' } : {})}
      {...(measure ? {} : { 'data-testid': `seg-${s.seat}` })}
    >
      {s.next && <span className="usage-seg-next" {...(measure ? {} : { 'data-testid': `next-${s.seat}` })}>→</span>}
      <span className="usage-seg-who">{s.label}</span>
      {stage === 'full' && <span className="usage-seg-bar"><i style={{ width: `${s.bar ?? 0}%` }} /></span>}
      <span className="usage-seg-num">{s.value}</span>
      {reset && <span className="usage-seg-reset">{s.kind === 'spent' ? `· ${reset}` : reset}</span>}
    </span>
  );
}

/**
 * Every seat's usage in one row; a press opens the usage sheet. Rendered in the top bar: on a desktop / tablet the
 * segments shrink in steps as room runs out (pickStage) and, past min, the strip goes to `rowSlot` (a line under the
 * bar, a portal). A phone always has that line. In the bar an (empty, invisible) box keeps measuring the bar's free
 * width — what the strip may take, not the strip itself — so the line coming and going cannot loop. The session's seat
 * is highlighted; "→" marks where the next turn goes when that is another seat.
 */
export function UsageStrip({ usage, current, next = null, grok = null, phone = false, rowSlot = null, open = false, onToggle, now: fixedNow }: {
  usage: UsageSnapshot | null; current: Seat | null; next?: RouteNext | null; grok?: GrokStatus | null;
  /** Phone: the line under the bar always (mid, scrolled sideways when it does not fit). */
  phone?: boolean;
  /** Where the line under the top bar goes (null: rendered in place, e.g. in tests). */
  rowSlot?: HTMLElement | null;
  open?: boolean; onToggle: () => void; now?: number;
}) {
  const now = useClock(fixedNow);
  const { active, label } = useAccounts();
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<StripStage>('full');
  const [fullNeed, setFullNeed] = useState<number | null>(null);
  const seats = usage ? buildSeats(usage, active, grok, now) : [];
  const shown = seats.length > 0 && (!!current || !!next || seats.some((s) => pickMain(s.rows)));
  // jsdom (tests) has no layout and no ResizeObserver: the strip stays full there.
  const canMeasure = shown && !phone && typeof ResizeObserver !== 'undefined';

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const m = measureRef.current;
    if (!canMeasure || !wrap || !m) return;
    const kids = [...m.children] as HTMLElement[];
    const check = () => {
      const need = { full: kids[0]!.offsetWidth, mid: kids[1]!.offsetWidth, min: kids[2]!.offsetWidth };
      setFullNeed(need.full);
      setStage((s) => pickStage(s, wrap.clientWidth, need));
    };
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    for (const k of kids) ro.observe(k);
    check();
    return () => ro.disconnect();
  }, [canMeasure]);

  const inRow = phone || stage === 'row';
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!inRow || !current) return;
    const seg = rowRef.current?.querySelector<HTMLElement>('[data-current]');
    if (seg && typeof seg.scrollIntoView === 'function') seg.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [inRow, current, shown, rowSlot]);

  if (!usage || !shown) return null;
  const segs = stripSegs({ seats, current, next, stale: usage.usageMode !== 'cli' && !usage.deckReachable, now, label });
  const nextSays = next && (next.account !== current || next.asOpus) ? `, 다음 턴 ${label(next.account)}${next.asOpus ? '(Opus)' : ''}` : '';
  const aria = `계정별 사용량: ${segs.map((s) => `${s.current ? '지금 ' : ''}${s.spoken}`).join(', ')}${nextSays}`;
  const title = ['계정별 사용량', next ? `다음 턴: ${label(next.account)}${next.asOpus ? ' · Opus' : ''} — ${next.reason}` : ''].filter(Boolean).join(' · ');
  const button = (st: Exclude<StripStage, 'row'>) => (
    <button
      type="button"
      className="usage-strip"
      data-testid="usage-strip"
      aria-label={aria}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-sheet-return=""
      title={title}
      onClick={onToggle}
    >
      {segs.map((s) => <Segment key={s.seat} s={s} stage={st} />)}
    </button>
  );
  const row = inRow && <div ref={rowRef} className="usage-strip-row" data-stage="row">{button('mid')}</div>;
  const placedRow = row && rowSlot ? createPortal(row, rowSlot) : row;
  if (phone) return placedRow;

  return (
    <>
      <div
        ref={wrapRef}
        className="usage-strip-wrap"
        data-stage={stage}
        style={fullNeed !== null ? { maxWidth: fullNeed + STRIP_SLACK } : undefined}
      >
        {!inRow && button(stage as Exclude<StripStage, 'row'>)}
        {canMeasure && (
          <div ref={measureRef} className="usage-strip-measure" aria-hidden="true">
            {STAGES.map((st) => <div key={st} className="usage-strip">{segs.map((s) => <Segment key={s.seat} s={s} stage={st} measure />)}</div>)}
          </div>
        )}
      </div>
      {placedRow}
    </>
  );
}
