import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { UsageChip, chipState, spokenCountdown, type ChipKind } from './UsageChip';
import { buildSeats, pickMain, useClock, type RouteNext, type SeatData } from './usageSeats';

/**
 * How much each segment says, widest first: full = label · bar · % · reset; mid = label · % (the reset only when amber /
 * red / spent); min = label · %. chip = not even min fits: the one-seat UsageChip instead.
 */
export type StripStage = 'full' | 'mid' | 'min' | 'chip';
const STAGES = ['full', 'mid', 'min'] as const;
export type StripNeeds = Record<(typeof STAGES)[number], number>;

/** Extra room a wider stage needs before it comes back, so a width near a boundary does not flicker between two. */
export const STRIP_SLACK = 16;

/**
 * The widest stage that fits `avail` px. Going back up (to a wider stage than `cur`) asks STRIP_SLACK more than the
 * stage needs; staying or going down asks only the need itself.
 */
export function pickStage(cur: StripStage, avail: number, need: StripNeeds, slack = STRIP_SLACK): StripStage {
  const rank = (s: StripStage) => (s === 'chip' ? STAGES.length : STAGES.indexOf(s));
  for (const s of STAGES) {
    if (avail >= need[s] + (rank(s) < rank(cur) ? slack : 0)) return s;
  }
  return 'chip';
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

function Segment({ s, stage, measure }: { s: StripSeg; stage: Exclude<StripStage, 'chip'>; measure?: boolean }) {
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
 * Every seat's usage in one row (the top bar on a desktop / tablet, a thin line under it on a phone); a press opens
 * the usage sheet. The segments shrink in steps as room runs out (pickStage) and, past the last, the one-seat chip
 * takes over. The session's seat is highlighted; "→" marks where the next turn goes when that is another seat.
 */
export function UsageStrip({ usage, current, next = null, grok = null, phone = false, open = false, onToggle, now: fixedNow }: {
  usage: UsageSnapshot | null; current: Seat | null; next?: RouteNext | null; grok?: GrokStatus | null;
  /** Phone: the mid stage always, scrolled sideways when it does not fit. */
  phone?: boolean;
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

  const curSeat = current;
  useEffect(() => {
    if (!phone || !curSeat) return;
    const seg = wrapRef.current?.querySelector<HTMLElement>('[data-current]');
    if (seg && typeof seg.scrollIntoView === 'function') seg.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [phone, curSeat, shown]);

  if (!usage || !shown) return null;
  const segs = stripSegs({ seats, current, next, stale: usage.usageMode !== 'cli' && !usage.deckReachable, now, label });
  const nextSays = next && (next.account !== current || next.asOpus) ? `, 다음 턴 ${label(next.account)}${next.asOpus ? '(Opus)' : ''}` : '';
  const aria = `계정별 사용량: ${segs.map((s) => `${s.current ? '지금 ' : ''}${s.spoken}`).join(', ')}${nextSays}`;
  const title = ['계정별 사용량', next ? `다음 턴: ${label(next.account)}${next.asOpus ? ' · Opus' : ''} — ${next.reason}` : ''].filter(Boolean).join(' · ');
  const use: Exclude<StripStage, 'chip'> = phone ? 'mid' : stage === 'chip' ? 'min' : stage;

  return (
    <div
      ref={wrapRef}
      className={phone ? 'usage-strip-row' : 'usage-strip-wrap'}
      data-stage={phone ? 'mid' : stage}
      style={!phone && fullNeed !== null ? { maxWidth: fullNeed + STRIP_SLACK } : undefined}
    >
      {!phone && stage === 'chip' ? (
        <UsageChip usage={usage} current={current} next={next} grok={grok} open={open} onToggle={onToggle} {...(fixedNow !== undefined ? { now: fixedNow } : {})} />
      ) : (
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
          {segs.map((s) => <Segment key={s.seat} s={s} stage={use} />)}
        </button>
      )}
      {canMeasure && (
        <div ref={measureRef} className="usage-strip-measure" aria-hidden="true">
          {STAGES.map((st) => <div key={st} className="usage-strip">{segs.map((s) => <Segment key={s.seat} s={s} stage={st} measure />)}</div>)}
        </div>
      )}
    </div>
  );
}
