import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { ui } from '../i18n';
import { buildSeats, chipCountdown, chipState, pickMain, windowPassed, RESET_PASSED_SAID, resetPassedNote, spokenCountdown, staleNote, useClock, type ChipKind, type RouteNext, type SeatData, type SeatRow } from './usageSeats';
import { ClockIcon, RefreshIcon } from './icons';
import { usePhoneMode } from '../useIsPhone';

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

/**
 * The room the strip may take in the top bar: the bar's inner width less everything else on its row — the other
 * in-flow items (☰, the actions) at their width, the session chip at its minimum (it grows into whatever the strip
 * leaves) and the gaps between them, the strip always counted as one item. `own` marks the strip's boxes, which are
 * skipped: the result never depends on where the strip is or how wide it is, so a stage change or the line under the
 * bar coming and going cannot move it (no loop), and a strip that grows (a seat added) is judged against the real room
 * at once. Auto margins (the actions' margin-left) are left out: with the session chip growing they are 0.
 */
export function barRoom(bar: HTMLElement, own: (el: Element) => boolean): number {
  const px = (v: string | undefined) => parseFloat(v ?? '') || 0;
  const cs = getComputedStyle(bar);
  let room = bar.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  let items = 1;
  for (const el of bar.children) {
    if (own(el)) continue;
    const ecs = getComputedStyle(el);
    if (ecs.display === 'none' || ecs.position === 'fixed' || ecs.position === 'absolute') continue;
    items++;
    room -= el.classList.contains('topbar-head') ? px(ecs.minWidth) : el.getBoundingClientRect().width;
  }
  return room - (items - 1) * px(cs.columnGap || cs.gap);
}

/** One seat in the strip. */
export type StripSeg = {
  seat: Seat;
  label: string;
  kind: ChipKind;
  /** Old numbers: the whole seat a step dimmer (muted number and bar), with a clock or a refresh icon. */
  stale: boolean;
  /** 'clock': old numbers, not reset yet (the age follows); 'refresh': past the reset (the value is "리셋됨"). */
  icon: 'clock' | 'refresh' | null;
  /** The bar's fill: the REMAINING % (a battery; spent: 0, on a red track); null: no number (a cooldown, numbers
   *  whose window has reset since), an empty track. */
  bar: number | null;
  /** The remaining "58%", "리셋됨", "소진", "쿨다운", "가능", "?". */
  value: string;
  /** Which window `value` is about: "5시간", "주" (a plain % only; '' for the words and for rows we cannot name). */
  period: string;
  /** "2h", "12m" (spent, a cooldown's end), "3일 전" (old numbers: when read), "오래됨"; '' when none. */
  reset: string;
  /** `reset` is said with a "·" before it (spent, a cooldown's end; an old reading's age has the clock instead). */
  dot: boolean;
  /** For the strip's title: an old reading said in full ("C 10% — 3일 전 마지막 턴 기준 값. …"); '' when none. */
  note: string;
  spoken: string;
  current: boolean;
  /** The next turn goes here (and not to the current seat). */
  next: boolean;
};

/**
 * Every seat as a strip segment, in buildSeats order; the numbers and words come from chipState (one seat each). The
 * numbers are what is LEFT (ChatGPT's own "78% 남음"); the colours still follow levelClass (amber ≤20% left, red ≤5%).
 * Aria: "GPT 78퍼센트 남음, 5일 뒤 초기화"; a cooldown only with what is known (its end, when there is one).
 */
export function stripSegs({ seats, current, next, stale, now, label }: {
  seats: SeatData[]; current: Seat | null; next: RouteNext | null; stale: boolean; now: number; label: (s: Seat) => string;
}): StripSeg[] {
  return seats.map((d) => {
    const st = chipState({ seats, current: d.seat, next: null, stale, now, label })!;
    const spent = st.kind === 'spent';
    const cooldown = st.kind === 'cooldown';
    const until = cooldown ? chipCountdown(d.until, now) : '';
    const name = label(d.seat);
    const value = cooldown ? '쿨다운' : st.resetPassed ? '리셋됨' : spent ? '소진' : st.left !== null ? `${st.left}%` : st.text;
    const reset = cooldown ? until : spent ? st.reset : st.left !== null ? (st.stale ? st.ago || '오래됨' : st.reset) : '';
    const said = cooldown ? `쿨다운${until ? ` ${spokenCountdown(until)} 뒤 해제` : ''}`
      : st.resetPassed ? (d.autoPoll ? resetPassedNote(d).replaceAll(' · ', ', ') : RESET_PASSED_SAID)
      : spent ? '소진' : st.left !== null ? `${st.left}퍼센트 남음` : st.text === '가능' ? '사용 가능' : '알 수 없음';
    const resetSaid = (spent || st.left !== null) && st.reset ? `, ${spokenCountdown(st.reset)} 뒤 초기화` : '';
    const old = st.stale && !st.resetPassed && st.left !== null;
    const judged = st.stale && !cooldown;
    const main = judged ? pickMain(d.rows.filter((r) => !windowPassed(r.w, now))) : pickMain(d.rows);
    const period = !cooldown && !spent && !st.resetPassed && st.left !== null && main ? stripPeriod(main.row) : '';
    const note = old ? staleNote(st.ago, d.polled) : '';
    const spoken = `${name} ${said}${resetSaid}${old ? `, ${note.replace('. ', ', ')}` : st.kind === 'estimated' ? ', 추정' : ''}`;
    return {
      seat: d.seat, label: name, kind: st.kind, stale: st.stale || st.kind === 'stale', icon: st.resetPassed ? 'refresh' : old ? 'clock' : null,
      bar: spent ? 0 : cooldown ? null : st.left, value, period, reset, dot: (spent || cooldown) && !old, spoken,
      note: st.resetPassed ? `${name} — ${resetPassedNote(d)}` : old ? `${name} ${st.left}% — ${note}` : '',
      current: d.seat === current, next: !!next && next.account === d.seat && next.account !== current,
    };
  });
}

/** The window a strip % belongs to, short ("주 33%", "5시간 58%"): the sheet's rows are named the same way. */
const stripPeriod = (row: SeatRow): string => {
  const t = ui().common;
  if (row.key === 'week') return row.period === 'week' ? t.periodWeek : row.period === 'month' ? t.periodMonth : '';
  return row.key === 'fiveHour' ? t.periodFiveHour : row.key === 'weekly' ? t.periodWeek : '';
};

/** A GPT seat with no numbers (never read, Codex not installed or not signed in) says nothing: "GPT ?" is left out of the strip unless it is the session's own seat. */
const hiddenSeat = (d: SeatData, current: Seat | null, next: RouteNext | null) =>
  d.seat === 'gpt' && d.status === 'down' && !pickMain(d.rows) && current !== 'gpt' && next?.account !== 'gpt';

/** The strip's hover title, first line: the numbers are what is left (they read the other way round before). */
const STRIP_TITLE = '계정별 남은 사용량 — 숫자와 막대는 남은 양 · 노랑 20% 이하 · 빨강 5% 이하';

/** The reset is said in mid only when it matters: amber, red, spent, a cooldown's end. */
const loud = (k: ChipKind) => k === 'warn' || k === 'danger' || k === 'spent' || k === 'cooldown';

/**
 * Old numbers by stage: full = muted bar · "70%" · clock "3일 전"; mid = "70%" · clock "3일 전"; min = "70%" · clock.
 * Past the reset: refresh "리셋됨" in the number's place (min: the icon alone). The words are in the title and aria.
 */
/** In a line of its own or a phone's low top bar only these show: the session's seat, where the next turn goes, a warning. */
const worthShowing = (s: StripSeg) => s.current || s.next || s.kind === 'warn' || s.kind === 'danger';

function Segment({ s, stage, measure, quiet }: { s: StripSeg; stage: Exclude<StripStage, 'row'>; measure?: boolean; quiet?: boolean }) {
  const age = s.icon === 'clock';
  const reset = age ? (stage === 'min' ? '' : s.reset) : stage === 'full' || (stage === 'mid' && loud(s.kind)) ? s.reset : '';
  return (
    <span
      className={`usage-seg ${s.kind}${s.stale && s.kind !== 'stale' ? ' stale' : ''}`}
      {...(s.current ? { 'data-current': '' } : {})}
      {...(quiet ? { 'data-quiet': '' } : {})}
      {...(measure ? {} : { 'data-testid': `seg-${s.seat}` })}
    >
      {s.next && <span className="usage-seg-next" {...(measure ? {} : { 'data-testid': `next-${s.seat}` })}>→</span>}
      <span className="usage-seg-who">{s.label}</span>
      {stage === 'full' && <span className="usage-seg-bar"><i style={{ width: `${s.bar ?? 0}%` }} /></span>}
      {s.period && stage !== 'min' && <span className="usage-seg-per">{s.period}</span>}
      <span className="usage-seg-num">
        {s.icon === 'refresh' && <RefreshIcon className="usage-seg-icon" />}
        {s.icon === 'refresh' && stage === 'min' ? null : s.value}
      </span>
      {age && <span className="usage-seg-reset usage-seg-age"><ClockIcon className="usage-seg-icon" />{reset}</span>}
      {!age && reset && <span className="usage-seg-reset">{s.dot ? `· ${reset}` : reset}</span>}
    </span>
  );
}

/**
 * Every seat's usage in one row; a press opens the usage sheet. Rendered in the top bar: on a desktop / tablet the
 * strip takes just the width its stage needs (the session chip grows into the rest) and steps down full → mid → min as
 * the bar's room (barRoom) runs out; past min it goes to `rowSlot` (a line under the bar, a portal) and the bar keeps
 * nothing of it. A phone always has that line — held sideways, the strip sits in its low top bar instead. In the line
 * and in that bar only the seats worth a look show (worthShowing) and a "+N" chip counts the rest, whole seats only;
 * the sheet has them all. The session's seat is highlighted; "→" marks where the next turn goes when that is another seat.
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
  const sideways = usePhoneMode() === 'landscape' && phone;
  const { active, label } = useAccounts();
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<StripStage>('full');
  const stageRef = useRef<StripStage>('full');
  /** The strip had the focus when it moved between the bar and the line: the new button takes it. */
  const refocus = useRef(false);
  const check = useRef<() => void>(() => {});
  const seats = usage ? buildSeats(usage, active, grok, now).filter((d) => !hiddenSeat(d, current, next)) : [];
  const shown = seats.length > 0 && (!!current || !!next || seats.some((s) => pickMain(s.rows)));
  // jsdom (tests) has no layout and no ResizeObserver: the strip stays full there.
  const canMeasure = shown && !phone && typeof ResizeObserver !== 'undefined';

  useLayoutEffect(() => {
    const m = measureRef.current;
    const bar = m?.parentElement;
    if (!canMeasure || !m || !bar) return;
    const kids = [...m.children] as HTMLElement[];
    const own = (el: Element) => el === m || el === wrapRef.current || el === rowRef.current;
    check.current = () => {
      const w = (k: HTMLElement | undefined) => k?.getBoundingClientRect().width ?? 0;
      const cur = stageRef.current;
      const nextStage = pickStage(cur, barRoom(bar, own), { full: w(kids[0]), mid: w(kids[1]), min: w(kids[2]) });
      if (nextStage === cur) return;
      if ((nextStage === 'row') !== (cur === 'row')) {
        const a = document.activeElement;
        refocus.current = !!a && (!!wrapRef.current?.contains(a) || !!rowRef.current?.contains(a));
      }
      stageRef.current = nextStage;
      setStage(nextStage);
    };
    const ro = new ResizeObserver(() => check.current());
    ro.observe(bar);
    for (const el of bar.children) if (!own(el)) ro.observe(el);
    for (const k of kids) ro.observe(k);
    check.current();
    return () => { ro.disconnect(); check.current = () => {}; };
  }, [canMeasure]);
  // After every render too (a seat added, a number widened): judged before paint, not a frame later via the observer.
  useLayoutEffect(() => check.current());

  const inRow = (phone && !sideways) || stage === 'row';
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (inRow ? rowRef : wrapRef).current?.querySelector<HTMLElement>('button.usage-strip')?.focus();
  }, [inRow]);
  useEffect(() => {
    if (!inRow || !current) return;
    const seg = rowRef.current?.querySelector<HTMLElement>('[data-current]');
    if (seg && typeof seg.scrollIntoView === 'function') seg.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [inRow, current, shown, rowSlot]);

  if (!usage || !shown) return null;
  const segs = stripSegs({ seats, current, next, stale: usage.usageMode !== 'cli' && !usage.deckReachable, now, label });
  const nextSays = next && (next.account !== current || next.asOpus) ? `; 다음 턴 ${label(next.account)}${next.asOpus ? '(Opus)' : ''}` : '';
  const aria = `계정별 남은 사용량: ${segs.map((s) => `${s.current ? '지금 ' : ''}${s.spoken}`).join('; ')}${nextSays}`;
  const title = [STRIP_TITLE, ...segs.map((s) => s.note), next ? `다음 턴: ${label(next.account)}${next.asOpus ? ' · Opus' : ''} — ${next.reason}` : ''].filter(Boolean).join('\n');
  // Nothing worth a look (no session seat yet): every seat shows, as in the bar.
  const few = segs.some(worthShowing);
  const button = (st: Exclude<StripStage, 'row'>, focus = false) => (
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
      <span className="usage-strip-head" aria-hidden="true">남음</span>
      {segs.map((s) => <Segment key={s.seat} s={s} stage={st} quiet={focus && few && !worthShowing(s)} />)}
      {focus && few && segs.some((s) => !worthShowing(s)) && <span className="usage-strip-more" data-testid="usage-strip-more">+{segs.filter((s) => !worthShowing(s)).length}</span>}
    </button>
  );
  if (sideways) return <div className="usage-strip-wrap" data-stage="sideways">{button('mid', true)}</div>;
  const row = inRow && <div ref={rowRef} className="usage-strip-row" data-stage="row">{button('mid', true)}</div>;
  const placedRow = row && rowSlot ? createPortal(row, rowSlot) : row;
  if (phone) return placedRow;

  return (
    <>
      {!inRow && <div ref={wrapRef} className="usage-strip-wrap" data-stage={stage}>{button(stage as Exclude<StripStage, 'row'>)}</div>}
      {/* Off-screen copies of the three stages (position: fixed: not a flex item of the bar, never in its gaps). */}
      {canMeasure && (
        <div ref={measureRef} className="usage-strip-measure" aria-hidden="true">
          {STAGES.map((st) => <div key={st} className="usage-strip"><span className="usage-strip-head">남음</span>{segs.map((s) => <Segment key={s.seat} s={s} stage={st} measure />)}</div>)}
        </div>
      )}
      {placedRow}
    </>
  );
}
