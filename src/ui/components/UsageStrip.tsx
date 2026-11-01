import { useEffect, useRef, useState } from 'react';
import type { GrokStatus } from '../../shared/protocol';
import type { Seat } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { buildSeats, resetLabel, resetStamp, SeatIdentity, useUsageRefresh, chipCountdown, chipState, pickMain, PopRow, RESET_PASSED_NOTE, RESET_PASSED_SAID, seatStale, spokenCountdown, staleNote, useClock, windowPassed, type ChipKind, type RouteNext, type SeatData } from './usageSeats';
import { ClockIcon, RefreshIcon } from './icons';

/**
 * How much each segment says, widest first: full = label · bar · % · reset; mid = label · % (the reset only when amber /
 * red / spent); min = label · %. The header pill does not use these stages: it stays a one-seat summary, and the
 * popover always shows full. `row` remains the "does not fit" result of pickStage.
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
  /** Nothing can run here now: spent (0 % left), a live cooldown, or the CLI is logged out — a red pill beside the header chip. */
  blocked: boolean;
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
      : st.resetPassed ? RESET_PASSED_SAID
      : spent ? '소진' : st.left !== null ? `${st.left}퍼센트 남음` : st.text === '가능' ? '사용 가능' : st.text === '?' ? '알 수 없음' : st.text;
    const resetSaid = (spent || st.left !== null) && st.reset ? `, ${spokenCountdown(st.reset)} 뒤 초기화` : '';
    const old = st.stale && !st.resetPassed && st.left !== null;
    const note = old ? staleNote(st.ago, d.polled) : '';
    const spoken = `${name} ${said}${resetSaid}${old ? `, ${note.replace('. ', ', ')}` : st.kind === 'estimated' ? ', 추정' : ''}`;
    return {
      seat: d.seat, label: name, kind: st.kind, stale: st.stale || st.kind === 'stale', icon: st.resetPassed ? 'refresh' : old ? 'clock' : null,
      bar: spent ? 0 : cooldown ? null : st.left, value, reset, dot: (spent || cooldown) && !old, spoken,
      note: st.resetPassed ? `${name} — ${RESET_PASSED_NOTE}` : old ? `${name} ${st.left}% — ${note}` : '',
      current: d.seat === current, next: !!next && next.account === d.seat && next.account !== current,
      blocked: spent || cooldown || !!d.loginNeeded,
    };
  });
}

/** The strip's hover title, first line: the numbers are what is left (they read the other way round before). */
const STRIP_TITLE = '계정별 남은 사용량 — 숫자와 막대는 남은 양 · 노랑 20% 이하 · 빨강 5% 이하';

/** A remaining percent ("58%"), as opposed to 소진 / 쿨다운 / 리셋됨 / 가능 / ?. */
const percentValue = (v: string) => /^\d+%$/.test(v);

/**
 * The seat the collapsed chip names: the one with the MOST left (of its own tightest window), so the chip says where
 * a turn can still go. A seat with a remaining % beats one with no number (가능 / ? / 로그인 필요); the larger % wins,
 * the earlier seat on a tie. With no number anywhere, the first seat that is not blocked, else the first.
 */
export function bestSeg(segs: StripSeg[]): StripSeg {
  const numbered = segs.filter((s) => s.bar !== null && !s.blocked);
  if (numbered.length > 0) return numbered.reduce((best, s) => (s.bar! > best.bar! ? s : best));
  return segs.find((s) => !s.blocked) ?? segs[0]!;
}

/** The seats nothing can run on (spent, cooldown, logged out), minus the one the chip already names: the red pills. */
export function outSegs(segs: StripSeg[], best: StripSeg): StripSeg[] {
  return segs.filter((s) => s.blocked && s.seat !== best.seat);
}

/** A red pill's word: 소진 (0 % left), 쿨다운, 로그인 (the CLI is logged out). */
function outWord(s: StripSeg): string {
  return s.kind === 'cooldown' ? '쿨다운' : s.bar === 0 ? '소진' : '로그인';
}

/** Shared provider identity, single remaining-capacity bar, and a calm exhausted/login state. */
export function UsageSeatSummary({ s, d, now, login, onLogin }: { s: StripSeg; d: SeatData; now: number; login: boolean; onLogin?: () => void }) {
  const main = pickMain(d.rows.filter((r) => !(s.stale && windowPassed(r.w, now))));
  const at = d.status === 'cooldown' ? d.until : main?.row.w?.resetsAt;
  const reset = at ? resetLabel(at, now) : '';
  const exhausted = s.kind === 'spent' || s.kind === 'cooldown';
  return <span className={`usage-seg ${s.kind}${s.stale && s.kind !== 'stale' ? ' stale' : ''}`} data-testid={`seg-${s.seat}`} {...(s.current ? { 'data-current': '' } : {})}>
    <span className="usage-pop-heading">
      {s.next && <span className="usage-seg-next" data-testid={`next-${s.seat}`}>→</span>}
      <SeatIdentity d={d} label={s.label} />
      <span className={`usage-seg-num${exhausted && !login ? ' usage-exhausted' : ''}`} title={at ? resetStamp(at) : undefined}>
        {s.icon === 'refresh' && !login && <RefreshIcon className="usage-seg-icon" />}
        {login ? '로그인 필요' : s.value}
        {!login && exhausted && reset && <span className="usage-exhausted-reset"> · {reset}</span>}
      </span>
      {login && onLogin && <span data-testid={`reauth-${s.seat}`}><button type="button" className="text-btn usage-reauth-btn" onClick={onLogin}>로그인</button></span>}
    </span>
    {!login && <span className="usage-seg-bar" aria-hidden="true"><i style={{ width: `${s.bar ?? 0}%` }} /></span>}
    {!login && s.icon === 'clock' && <span className="usage-seg-reset usage-seg-age"><ClockIcon className="usage-seg-icon" />{s.reset}</span>}
  </span>;
}

/**
 * One pill in the header for every seat: the tightest remaining amount (tightestSeg). A press opens the seat list
 * (label · bar · remaining % · reset, the same segments as before) under the pill; 자세히 opens the usage sheet.
 * The same pill on a phone — the list is the popover, not a second row of every seat. `phone` and `rowSlot` stay on
 * the props so the header call site is unchanged.
 */
export function UsageStrip({ usage, current, next = null, grok = null, phone = false, open = false, onToggle, now: fixedNow, reauth = [], onReauth, onRefresh }: {
  usage: UsageSnapshot | null; current: Seat | null; next?: RouteNext | null; grok?: GrokStatus | null;
  phone?: boolean;
  rowSlot?: HTMLElement | null;
  /** The usage sheet is open (자세히). The pill's own list closes so it does not sit under the sheet. */
  open?: boolean; onToggle: () => void; now?: number;
  /** Seats whose login probe is `no` (authLogin). */
  reauth?: readonly string[];
  onReauth?: (seat: string) => void;
  onRefresh?: () => void;
}) {
  const now = useClock(fixedNow);
  const { active, label } = useAccounts();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState(false);
  useUsageRefresh(pop, onRefresh);
  const seats = usage ? buildSeats(usage, active, grok, now) : [];
  // A logged-out seat still needs the pill: with no remaining-% yet there is otherwise nothing to press for 로그인.
  const shown = seats.length > 0 && (!!current || !!next || seats.some((s) => pickMain(s.rows) || s.loginNeeded) || reauth.length > 0);
  /** Seats whose CLI needs a login: the setup probe's list, or the snapshot itself (Gemini without its Google login, Grok after an auth failure). */
  const needsLogin = (d: SeatData) => reauth.includes(d.seat) || !!d.loginNeeded;

  useEffect(() => { if (open) setPop(false); }, [open]);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setPop(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) setPop(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [pop]);

  if (!usage || !shown) return null;
  const snapshotStale = usage.usageMode !== 'cli' && !usage.deckReachable;
  const segs = stripSegs({ seats, current, next, stale: snapshotStale, now, label });
  const sum = bestSeg(segs);
  const out = outSegs(segs, sum);
  const nextSays = next && (next.account !== current || next.asOpus) ? `; 다음 턴 ${label(next.account)}${next.asOpus ? '(Opus)' : ''}` : '';
  const aria = `계정별 남은 사용량: ${segs.map((s) => `${s.current ? '지금 ' : ''}${s.spoken}`).join('; ')}${nextSays}`;
  const title = [STRIP_TITLE, ...segs.map((s) => s.note), next ? `다음 턴: ${label(next.account)}${next.asOpus ? ' · Opus' : ''} — ${next.reason}` : ''].filter(Boolean).join('\n');
  const showLeft = percentValue(sum.value);
  return (
    <div ref={wrapRef} className="usage-strip-wrap" data-summary="">
      <button
        type="button"
        className={`usage-strip ${sum.kind}${sum.stale && sum.kind !== 'stale' ? ' stale' : ''}${out.length ? ' has-out' : ''}`}
        data-testid="usage-strip"
        aria-label={aria}
        aria-haspopup="true"
        aria-expanded={pop}
        aria-controls="usage-strip-pop"
        data-sheet-return=""
        title={title}
        onClick={() => setPop((v) => !v)}
      >
        {showLeft && <span className="usage-strip-head" aria-hidden="true">남음</span>}
        <span className="usage-summary" data-testid="usage-summary">
          <span className="usage-seg-who">{sum.label}</span>
          <span className="usage-seg-bar" aria-hidden="true"><i style={{ width: `${sum.bar ?? 0}%` }} /></span>
          <span className="usage-seg-num">
            {sum.icon === 'refresh' && <RefreshIcon className="usage-seg-icon" />}
            {sum.icon === 'clock' && <ClockIcon className="usage-seg-icon" />}
            {sum.value}
          </span>
        </span>
        {out.length > 0 && (
          <span className="usage-out" data-testid="usage-out" aria-hidden="true">
            {out.map((s) => <span key={s.seat} className={`usage-out-pill ${s.kind}`} data-testid={`out-${s.seat}`}>{s.label}{!phone && <small>{outWord(s)}</small>}</span>)}
          </span>
        )}
        {out.length > 0 && <span className="usage-out-count" aria-hidden="true">확인 {out.length}</span>}
        <span className="usage-strip-caret" aria-hidden="true">{pop ? '▴' : '▾'}</span>
      </button>
      {pop && (
        <div id="usage-strip-pop" className="usage-strip-pop" role="group" aria-label="계정별 남은 사용량" data-testid="usage-strip-pop">
          {segs.map((s) => {
            const d = seats.find((x) => x.seat === s.seat)!;
            const old = seatStale(d, snapshotStale) && d.status !== 'cooldown';
            return (
              <div key={s.seat} className={`usage-pop-seat${s.current ? ' current' : ''}`} data-testid={`pop-${s.seat}`}>
                <UsageSeatSummary s={s} d={d} now={now} login={needsLogin(d)} {...(onReauth ? { onLogin: () => { setPop(false); onReauth(s.seat); } } : {})} />
                {d.engine === 'gpt' && <span className="usage-shared-note">Hermes와 한도 공유</span>}
                {!needsLogin(d) && d.rows.length > 0 && (
                  <div className="usage-pop-rows">
                    {d.rows.map((r) => <PopRow compact key={r.key} id={`pop-${s.seat}-${r.key}`} seat={s.seat} name={r.name} k={r.key} w={r.w} now={now} empty={r.empty} stale={old} polled={d.polled} />)}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="text-btn usage-strip-more" onClick={onToggle}>자세히</button>
        </div>
      )}
    </div>
  );
}
