import { useEffect, useState, type ReactNode } from 'react';
import { GEMINI_ACCOUNTS, GROK_ACCOUNTS, type Account, type GeminiAccount, type GrokAccount, type Seat } from '../../shared/accounts';
import type { GrokStatus } from '../../shared/protocol';
import { ClaudeMark, GeminiMark, GrokMark, OpenAIMark } from './EngineMark';
import { emptyAccountUsage, grokBillingWindow, localDay, parseIsoUtc, remainingPct, trusted, usageOf, type AccountUsage, type GeminiUsage, type GptCredits, type GrokBotUsage, type GrokUsage, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

export function countdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now; // zone-less stamps are UTC (review M9)
  if (Number.isNaN(ms) || ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  // A zero part is left out ("7분", "2시간", "3일"), never "0시간 7분".
  if (h >= 24) return h % 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : `${h / 24}일 후 리셋`;
  if (!h) return m ? `${m}분 후 리셋` : '1분 안에 리셋';
  return m ? `${h}시간 ${m}분 후 리셋` : `${h}시간 후 리셋`;
}

/**
 * The always-on short form after the % of a card's main row ("19% · 5일"): "47분", "3시간", "1일 5시간" (under 48
 * hours the hours still count), "2일", "리셋됨"; '' without a (readable) reset time. The title has the full wording.
 */
export function shortCountdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}일`;
  if (h >= 24) return h > 24 ? `1일 ${h - 24}시간` : '1일';
  if (h >= 1) return `${h}시간`;
  return `${Math.max(1, Math.floor(ms / 60_000))}분`;
}

type WindowKey = 'fiveHour' | 'weekly' | 'fable';

/** The window whose short countdown a card shows: the highest usedPct, ties 5h > 주간 > Fable; null when no window has a value. */
export function fullestWindow(u: AccountUsage, keys: WindowKey[]): WindowKey | null {
  let best: { key: WindowKey; pct: number } | null = null;
  for (const key of (['fiveHour', 'weekly', 'fable'] as const).filter((k) => keys.includes(k))) {
    const pct = u[key]?.usedPct;
    if (typeof pct === 'number' && (!best || pct > best.pct)) best = { key, pct };
  }
  return best?.key ?? null;
}

/** Absolute local reset time, e.g. "10/3 09:00" (an exhausted window needs a when, not a countdown). */
export function resetStamp(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const t = parseIsoUtc(resetsAt);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** How long ago, short: "방금", "12분 전", "3시간 전", "2일 전"; '' when unreadable. */
export function agoText(iso: string | null, now: number): string {
  if (!iso) return '';
  const t = parseIsoUtc(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

/**
 * `cli` usage mode: when a Claude card's numbers were observed ("마지막 턴 기준 · 12분 전"), or that they never were.
 * Old but still a lower bound (stale within `trustUntil`): "추정 · 마지막 턴 12분 전".
 */
export function observedText(u: AccountUsage, now: number): string {
  const ago = u.fiveHour || u.weekly ? agoText(u.fetchedAt, now) : '';
  if (!ago) return '아직 관측 없음';
  return u.status === 'stale' && trusted(u, now) ? `추정 · 마지막 턴 ${ago}` : `마지막 턴 기준 · ${ago}`;
}

/** `cli` usage mode: the Fable row when no turn told a value (rate_limit_event has no Fable window). */
const CLI_NO_FABLE = 'CLI 미제공';

/** `cli` usage mode: a dimmed card (stale past `trustUntil`) — what the router does with it. */
export const UNTRUSTED = '라우팅은 모름으로 봄';

/** A window assumed reset (its observed reset time has passed): said in the titles and the popover. */
const ESTIMATED = '추정 — 관측한 리셋 시각이 지나 0%로 봄';

/** Whole credits with thousands separators ("49,563"); null when there is nothing to spend. */
export function creditsText(c: GptCredits | null | undefined): string | null {
  if (!c || !c.hasCredits) return null;
  if (c.unlimited) return '무제한';
  if (c.balance === null || !Number.isFinite(c.balance)) return null;
  return Math.floor(c.balance).toLocaleString('en-US');
}

/** Colour by what is used (the numbers on screen say what is LEFT): green, amber at ≥80% used (≤20% left), red at ≥95% used (≤5% left). */
export function levelClass(w: UsageWindow | null): string {
  if (!w) return 'none';
  if (w.usedPct >= 95) return 'danger';
  if (w.usedPct >= 80) return 'warn';
  return 'ok';
}

/** What the numbers and colours mean: the first line of the usage sheet (the strip says the same REMAINING %). */
export const LEGEND = '숫자는 남은 양 · 노랑 20% 이하 남음 · 빨강 5% 이하 남음';

/** What the amber / red of a row means, for its title ('' while green). */
const LEVEL_NOTE: Record<string, string> = { warn: ' · 노랑: 20% 이하 남음', danger: ' · 빨강: 5% 이하 남음' };

/** Review M9: the countdowns re-render every 30 s instead of freezing at the last snapshot. */
export function useClock(fixed: number | undefined, periodMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [fixed, periodMs]);
  return fixed ?? tick;
}

/** One window row in the sheet (and, for the main row, the source of the chip's number). */
export type SeatRow = { key: string; name: string; w: UsageWindow | null; empty?: string; mainEligible?: boolean };

/** What an adapter (claudeRows/gptRows/geminiRows/grokRows) builds for one seat; the chip and the sheet only render this. */
export type SeatData = {
  seat: Seat;
  engine: 'claude' | 'gpt' | 'gemini' | 'grok';
  mark: ReactNode;
  /** Sheet rows (and the pool the main row is picked from); `mainEligible: false` (Fable) never becomes the main row. */
  rows: SeatRow[];
  /** 'kept' is cli-mode only (see buildSeats); never produced by an adapter. */
  status: 'ok' | 'stale' | 'kept' | 'down' | 'unknown' | 'cooldown';
  dim?: boolean;
  hint?: string;
  observed?: string;
  credits?: string | null;
  /** No usable window at all (Grok, a logged-out/broken Gemini seat), or a state that wins over the numbers (a cooldown). */
  reasonLine?: string;
  /** A live cooldown's end (Grok), when known. */
  until?: string;
  /** When the seat's numbers were last read (ISO), for the strip's "3일 전" on old numbers; absent when unknown. */
  fetchedAt?: string | null;
  /** Appended to the sheet below the rows (Grok's "오늘 · deck 기준" block). */
  extraPopover?: ReactNode;
};

const WINDOW_NAME: Record<WindowKey, string> = { fiveHour: '5h', weekly: '주간', fable: 'Fable' };

/** Claude A/B/C: main = fullest of 5h/weekly (Fable excluded — "Fable 은 Fable 만 막는다"); Fable only in the secondary row/popover. */
function claudeRows(u: AccountUsage, cli: boolean): SeatRow[] {
  return [
    { key: 'fiveHour', name: WINDOW_NAME.fiveHour, w: u.fiveHour, mainEligible: true },
    { key: 'weekly', name: WINDOW_NAME.weekly, w: u.weekly, mainEligible: true },
    { key: 'fable', name: WINDOW_NAME.fable, w: u.fable, mainEligible: false, ...(cli && !u.fable ? { empty: CLI_NO_FABLE } : {}) },
  ];
}

/** GPT: main = fullest of 5h/weekly; credits shown alongside, never as a row of their own. */
function gptRows(u: AccountUsage): SeatRow[] {
  return [
    { key: 'weekly', name: WINDOW_NAME.weekly, w: u.weekly, mainEligible: true },
    { key: 'fiveHour', name: WINDOW_NAME.fiveHour, w: u.fiveHour, mainEligible: true },
  ];
}

/** Short bucket names: "Gemini 4 Argon" → "4 Argon", "gemini-3.8-flash" → "3.8 Flash"; anything else as is. */
export function bucketLabel(name: string): string {
  // "<group> · <window>" (agy 1.4.2: "Gemini · 5h", "Argon · 주간") is already a display name: as is.
  if (name.includes(' · ')) return name;
  const s = name.replace(/^gemini[-_ ]?/i, '').replace(/[-_]+/g, ' ').trim();
  if (!s) return name;
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/** Gemini 로그인 필요 / a read failure, as the card's hint; '' when the numbers are fresh. */
export function geminiHint(g: GeminiUsage): string {
  if (!g.loggedIn) return 'Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인하면 사용량이 보입니다';
  if (g.status === 'ok') return '';
  return g.error ? `Gemini 사용량 ${g.status === 'stale' ? '오래된 값' : '불명'} — ${g.error}` : 'Gemini 사용량 불명';
}

/** Gemini g1/g2: one row per quota bucket agy reports (already only the Gemini-model groups, see GeminiUsagePoller). */
function geminiRows(g: GeminiUsage): SeatRow[] {
  return g.buckets.map((b, i) => ({ key: `b${i}`, name: bucketLabel(b.name), w: { usedPct: b.usedPct, resetsAt: b.resetsAt } as UsageWindow, mainEligible: true }));
}

/**
 * The snapshot is only pushed when a Grok turn ends, so it can be hours old: a cooldown whose time has passed and a
 * `today` from an earlier local day are re-judged here against the clock (same day rule as GrokUsageTracker).
 */
function grokNow(g: GrokUsage, now: number): GrokUsage {
  const until = g.cooldownUntil ? parseIsoUtc(g.cooldownUntil) : NaN;
  const status = g.status === 'cooldown' && !(until > now) ? (g.lastTurnAt ? 'ok' : 'unknown') : g.status;
  const day = localDay(new Date(now));
  const today = g.today.day === day ? g.today : { inputTokens: 0, outputTokens: 0, turns: 0, day };
  return status === g.status && today === g.today ? g : { ...g, status, today };
}

/** Grok's status sentence (design §3/§7-4): the main row when there is no subscription usage (or a cooldown / login problem). */
function grokMainText(g: GrokUsage, now: number): string {
  if (g.status === 'down') return '로그인 필요';
  if (g.status === 'cooldown') return `한도 — ${g.cooldownUntil ? resetStamp(g.cooldownUntil) : '알 수 없음'} 이후`;
  if (g.status === 'unknown' || !g.lastTurnAt) return '아직 사용 없음';
  return `사용 가능 · 마지막 턴 ${agoText(g.lastTurnAt, now)}`;
}

/** The billing period's row name: "주간" for SuperGrok's weekly period, "월간" for a monthly one, else "구독". */
function grokPeriodName(type: string | null | undefined): string {
  if (type && /WEEK/i.test(type)) return WINDOW_NAME.weekly;
  if (type && /MONTH/i.test(type)) return '월간';
  return '구독';
}

/**
 * This install's Grok seats as `SeatData`; shown only while `GrokStatus.bin` is true (checked by the caller). With the
 * subscription's usage (`_x.ai/billing`) the card is a bar like GPT / Gemini; a cooldown or login problem still wins the
 * main row. Without it, the status sentence. Today's deck tally is the secondary line / popover either way.
 */
/** The Grok Bot app's own weekly plan reading (macOS, read from the app's cache): a secondary popover line. */
export function grokBotLine(b: GrokBotUsage, now: number): string {
  const pct = Math.round(b.percentUsed);
  const reset = b.nextResetMs !== null ? ` · 리셋 ${resetStamp(new Date(b.nextResetMs).toISOString())}` : '';
  const stale = now - b.readAtMs > 24 * 3600_000 ? ` (앱 동기화 ${Math.floor((now - b.readAtMs) / 3600_000)}시간 전)` : '';
  return `${b.planLabel ?? '플랜'} ${Math.max(0, 100 - pct)}% 남음${reset}${stale}`;
}

function grokSeatData(seat: Seat, snap: GrokUsage, now: number, bot?: GrokBotUsage | null): SeatData {
  const g = grokNow(snap, now);
  const tally = `입력 ${g.today.inputTokens.toLocaleString('en-US')} · 출력 ${g.today.outputTokens.toLocaleString('en-US')}`;
  const tier = g.billing?.tier ?? null;
  const extraPopover = (
    <>
      {tier && <div className="usage-pop-row" data-testid={`${seat}-tier`}><span>구독</span><b>{tier}</b></div>}
      <div className="usage-pop-row" data-testid={`${seat}-today`}><span>deck 오늘</span><b>{`${g.today.turns}턴 · ${tally}`}</b></div>
      {bot && <div className="usage-pop-row" data-testid={`${seat}-grokbot`}><span>Grok Bot</span><b>{grokBotLine(bot, now)}</b></div>}
    </>
  );
  const week = grokBillingWindow(g.billing, now);
  const mark = <GrokMark className="usage-mark grok" />;
  if (!week || !g.billing) {
    return {
      seat, engine: 'grok', mark, rows: [], status: g.status,
      reasonLine: grokMainText(g, now), extraPopover,
      ...(g.status === 'cooldown' && g.cooldownUntil ? { until: g.cooldownUntil } : {}),
    };
  }
  const blocked = g.status === 'down' || g.status === 'cooldown';
  return {
    seat, engine: 'grok', mark, rows: [{ key: 'week', name: grokPeriodName(g.billing.periodType), w: week, mainEligible: true }],
    // The subscription answered: no turn yet is not "unknown" any more.
    status: g.status === 'unknown' ? 'ok' : g.status,
    ...(blocked ? { reasonLine: grokMainText(g, now) } : {}),
    ...(g.status === 'cooldown' && g.cooldownUntil ? { until: g.cooldownUntil } : {}),
    observed: `확인 · ${resetStamp(g.billing.fetchedAt)}`,
    fetchedAt: g.billing.fetchedAt,
    extraPopover,
  };
}

/** Remaining % as shown: whole numbers (Gemini buckets report "98.5"); a sliver above 0 still reads 1, not 소진. */
export function shownPct(w: UsageWindow | null): number | null {
  const r = remainingPct(w);
  return r === null ? null : r > 0 && r < 1 ? 1 : Math.floor(r);
}

/**
 * One window row in the sheet: label · bar (or spent pill) · REMAINING % · countdown. Every seat (Claude, GPT, Gemini
 * buckets, Grok) says the share left, like the strip: the bar is as full as what is left (a battery).
 */
export function PopRow({ seat, name, k, w, now, empty }: { seat: Seat; name: string; k: string; w: UsageWindow | null; now: number; empty?: string }) {
  const rem = shownPct(w);
  const reset = w ? countdown(w.resetsAt, now) : '';
  const title = (rem === null ? `${name} · ${empty ?? '알 수 없음'}` : rem === 0 ? `${name} · 소진${w?.resetsAt ? ` · ${resetStamp(w.resetsAt)} 리셋` : ''}` : `${name} · ${rem}% 남음${reset ? ` · ${reset}` : ''}${LEVEL_NOTE[levelClass(w)] ?? ''}`) + (w?.estimated ? ` · ${ESTIMATED}` : '');
  if (rem === 0) {
    const at = resetStamp(w?.resetsAt ?? null);
    return (
      <div data-testid={`${seat}-${k}`} className="usage-row spent danger" title={title}>
        <span className="usage-label">{name}</span>
        <span className="usage-pill">소진{at && <span className="usage-pill-at">{` · ${at}`}</span>}</span>
      </div>
    );
  }
  return (
    <div data-testid={`${seat}-${k}`} className={`usage-row ${levelClass(w)}${w?.estimated ? ' estimated' : ''}`} title={title}>
      <span className="usage-label">{name}</span>
      <span className="usage-bar" aria-hidden="true"><i style={{ width: `${rem ?? 0}%` }} /></span>
      <span className="usage-value">{rem === null ? (empty ? <span className="usage-na">{empty}</span> : '—') : <>{rem}<small>% 남음</small></>}</span>
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

/** The lowest-remaining (= fullest) of the main-eligible rows; null when none has a value. */
export function pickMain(rows: SeatRow[]): { row: SeatRow; rem: number } | null {
  let best: { row: SeatRow; rem: number } | null = null;
  for (const row of rows) {
    if (row.mainEligible === false) continue;
    const rem = shownPct(row.w);
    if (rem !== null && (!best || rem < best.rem)) best = { row, rem };
  }
  return best;
}


/** Where the active session's next turn would go (route_preview), as the chip's arrow and the sheet's tag show it. */
export type RouteNext = { account: Seat; reason: string; asOpus?: boolean };

/** One word for a seat's state in the sheet ('' for a healthy seat). */
export function statusLabel(d: SeatData): string {
  if (d.dim || d.status === 'stale') return '오래됨';
  if (d.status === 'kept') return '추정(유지)';
  if (d.status === 'cooldown') return '쿨다운';
  if (d.status === 'down') return d.engine === 'gemini' || d.engine === 'grok' ? '로그인 필요' : '불명';
  if (d.status === 'unknown' && d.rows.length > 0) return '불명';
  return '';
}

/** The hover title of a seat: its hint, Claude's cli-mode observed time, and the "not trusted" note. */
export function seatTitle(d: SeatData): string {
  return [d.hint, d.engine === 'claude' ? d.observed : '', d.dim ? UNTRUSTED : ''].filter(Boolean).join(' · ');
}

/**
 * Every seat the chip and the sheet know about, in display order: the active Claude accounts, GPT, the Gemini seats
 * that report anything, and the Grok seats while hello says the CLI is installed (design §7-4).
 */
export function buildSeats(usage: UsageSnapshot, active: readonly { id: Account }[], grok: GrokStatus | null, now: number): SeatData[] {
  const cli = usage.usageMode === 'cli';
  const geminiOf = (a: GeminiAccount): GeminiUsage | undefined => usage.geminiSeats?.[a] ?? (a === 'g1' ? usage.gemini : undefined);
  const grokOf = (a: GrokAccount): GrokUsage | undefined => usage.grokSeats?.[a];
  const gpt = usage.gpt ?? emptyAccountUsage();
  return [
    ...active.map(({ id: a }): SeatData => {
      const u = usageOf(usage, a);
      const kept = cli && u.status === 'stale' && trusted(u, now);
      const dim = cli && u.status === 'stale' && !kept;
      return {
        seat: a, engine: 'claude', mark: <ClaudeMark className="usage-mark claude" />, rows: claudeRows(u, cli),
        status: (kept ? 'kept' : u.status) as SeatData['status'], dim, fetchedAt: u.fetchedAt,
        ...(cli ? { observed: observedText(u, now) } : {}),
      };
    }),
    {
      seat: 'gpt', engine: 'gpt', mark: <OpenAIMark className="usage-mark gpt" />, rows: gptRows(gpt), status: gpt.status as SeatData['status'],
      credits: creditsText(gpt.credits), fetchedAt: gpt.fetchedAt,
      ...(gpt.status === 'down' ? { hint: cli ? 'GPT 사용량 불명 — 아직 Codex 기록에서 한도 값을 읽지 못했습니다' : 'GPT 사용량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {}),
    },
    ...GEMINI_ACCOUNTS.filter((a) => geminiOf(a) !== undefined).map((a): SeatData => {
      const g = geminiOf(a)!;
      const hint = geminiHint(g);
      const rows = geminiRows(g);
      return {
        seat: a, engine: 'gemini', mark: <GeminiMark className="usage-mark gemini" />, rows, status: g.status as SeatData['status'],
        hint, fetchedAt: g.fetchedAt, ...(rows.length === 0 ? { reasonLine: hint || '사용량 알 수 없음' } : {}),
        ...(g.fetchedAt ? { observed: `확인 · ${resetStamp(g.fetchedAt)}` } : {}),
      };
    }),
    ...(grok?.bin ? GROK_ACCOUNTS : []).map((a) => grokSeatData(a, grokOf(a) ?? { status: 'unknown', lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '' } }, now, usage.grokBot)),
  ];
}

/** "40m" / "2h" / "3d" for the usage strip; '' without a (future) reset time. */
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
export function spokenCountdown(short: string): string {
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
  /** The numbers are old (a stale seat / usage-deck out of reach): a mark added on top, the amber / red of kind kept. */
  stale: boolean;
  /** Remaining % of the fullest window (null without a number, or once old numbers' window has reset). */
  left: number | null;
  /** Old numbers whose window has reset since they were read (its reset time has passed): the % is dropped ("리셋됨?"). */
  resetPassed: boolean;
  /** Old numbers, window not reset yet: how long ago they were read ("3일 전"; '' when unknown or no reset time is known). */
  ago: string;
  /** Short reset countdown of that window ("2h"; '' when unknown). */
  reset: string;
  /** The value text after the label on desktop ("58% · 2h", "10% · 3일 전", "리셋됨?", "소진 · 12m", "쿨다운"). */
  text: string;
  /** The value text on a phone ("58%", "✕", ''). */
  compactText: string;
  /** Another seat (not the target) is red or spent: a small red dot. */
  otherDanger: boolean;
  aria: string;
  title: string;
};

/**
 * One seat's state for the usage strip (UsageStrip, one call per seat), as the one-seat chip of design §3.5 said it: the current seat's fullest window as REMAINING %, its reset, where the next
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
      target: null, nextSeat: null, onlyNext: false, kind: otherDanger ? 'danger' : 'ok', stale: false, left: null, resetPassed: false, ago: '', reset: '', text: '', compactText: '', otherDanger,
      aria: `사용량 보기${dangerAria}`, title: '계정별 사용량',
    };
  }

  const name = label(d.seat);
  const main = pickMain(d.rows);
  const reset = main ? chipCountdown(main.row.w?.resetsAt, now) : '';
  const stale = d.dim || d.status === 'stale' || snapshotStale || ((d.status === 'down' || d.status === 'unknown') && !!main);
  const estimated = !!main?.row.w?.estimated || d.status === 'kept';
  // Old numbers are judged by their window's reset time: past it the old % says nothing any more (an estimated window
  // already is the server's 0 % after a reset); before it, how long ago they were read. No reset time: "오래됨" as before.
  const resetAt = main?.row.w?.resetsAt ? parseIsoUtc(main.row.w.resetsAt) : NaN;
  const resetPassed = stale && !!main && d.status !== 'cooldown' && !main.row.w?.estimated && resetAt <= now;
  const ago = stale && !!main && !resetPassed && resetAt > now ? agoText(d.fetchedAt ?? null, now) : '';
  const left = main && !resetPassed ? main.rem : null;
  let kind: ChipKind;
  let text: string;
  let compactText: string;
  let spoken: string;
  if (d.status === 'cooldown') {
    kind = 'cooldown'; text = '쿨다운'; compactText = '쿨다운'; spoken = '쿨다운 중';
  } else if (resetPassed) {
    kind = 'stale'; text = '리셋됨?'; compactText = text; spoken = '마지막 값 이후 초기화 시각이 지남';
  } else if (main && main.rem === 0) {
    kind = 'spent'; text = reset ? `소진 · ${reset}` : '소진'; compactText = '✕';
    spoken = `소진${reset ? `, ${spokenCountdown(reset)} 뒤 초기화` : ''}`;
  } else if (main) {
    const lvl = levelClass(main.row.w);
    // Amber / red first: old numbers that were near the limit still warn (오래됨 is added, not swapped in).
    kind = lvl === 'danger' ? 'danger' : lvl === 'warn' ? 'warn' : stale ? 'stale' : estimated ? 'estimated' : 'ok';
    text = `${left}%${stale ? ` · ${ago || '오래됨'}` : reset ? ` · ${reset}` : ''}`;
    compactText = `${left}%`;
    spoken = `${left}퍼센트 남음${reset ? `, ${spokenCountdown(reset)} 뒤 초기화` : ''}${stale ? (ago ? `, 마지막 턴 기준 ${ago} 값` : ', 오래된 값') : estimated ? ', 추정' : ''}`;
  } else {
    const ok = d.engine === 'grok' && d.status === 'ok';
    kind = ok ? 'ok' : 'unknown'; text = ok ? '가능' : '?'; compactText = text; spoken = ok ? '사용 가능' : '알 수 없음';
  }
  if (nextSeat) compactText = kind === 'spent' || kind === 'cooldown' ? compactText : '';
  return {
    target: d.seat, nextSeat, onlyNext, kind, stale: stale && !!main && d.status !== 'cooldown', left, resetPassed, ago, reset: resetPassed ? '' : reset, text, compactText, otherDanger,
    aria: `${onlyNext ? `다음 턴 ${name}${next!.asOpus ? '(Opus)' : ''}` : name} 계정 사용량 ${spoken}${nextAria}${dangerAria}`,
    title: [`${name} 계정${resetPassed ? ' · 마지막 값 이후 초기화 시각이 지남' : left !== null ? ` · ${main!.row.name} ${left}% 남음${ago ? ` (마지막 턴 기준 ${ago} 값)` : ''}` : ''}`, d.reasonLine ?? '', nextTitle].filter(Boolean).join(' · '),
  };
}
