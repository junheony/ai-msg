import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { GEMINI_ACCOUNTS, GROK_ACCOUNTS, type GeminiAccount, type GrokAccount, type Seat } from '../../shared/accounts';
import type { GrokStatus } from '../../shared/protocol';
import { useAccounts } from '../accounts';
import { ClaudeMark, GeminiMark, GrokMark, OpenAIMark } from './EngineMark';
import { emptyAccountUsage, grokBillingWindow, localDay, parseIsoUtc, remainingPct, trusted, usageOf, type AccountUsage, type GeminiUsage, type GptCredits, type GrokBotUsage, type GrokUsage, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

export function countdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now; // zone-less stamps are UTC (review M9)
  if (Number.isNaN(ms) || ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : `${h}시간 ${m}분 후 리셋`;
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
const UNTRUSTED = '라우팅은 모름으로 봄';

/** A window assumed reset (its observed reset time has passed): said in the titles and the popover. */
const ESTIMATED = '추정 — 관측한 리셋 시각이 지나 0%로 봄';

/** Whole credits with thousands separators ("49,563"); null when there is nothing to spend. */
export function creditsText(c: GptCredits | null | undefined): string | null {
  if (!c || !c.hasCredits) return null;
  if (c.unlimited) return '무제한';
  if (c.balance === null || !Number.isFinite(c.balance)) return null;
  return Math.floor(c.balance).toLocaleString('en-US');
}

/** Colour by what is left: green, amber at ≤20%, red at ≤5%. */
function levelClass(w: UsageWindow | null): string {
  if (!w) return 'none';
  if (w.usedPct >= 95) return 'danger';
  if (w.usedPct >= 80) return 'warn';
  return 'ok';
}

/** What the numbers and colours mean: the 남음 caption's title and the first line of a card's popover. */
const LEGEND = '숫자는 각 한도의 남은 양(%) · 노랑 = 20% 이하 남음 · 빨강 = 5% 이하 남음';

/** What the amber / red of a row means, for its title ('' while green). */
const LEVEL_NOTE: Record<string, string> = { warn: ' · 노랑: 20% 이하 남음', danger: ' · 빨강: 5% 이하 남음' };

/** Review M9: the countdowns re-render every 30 s instead of freezing at the last snapshot. */
function useClock(fixed: number | undefined, periodMs = 30_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [fixed, periodMs]);
  return fixed ?? tick;
}

type Pop = { seat: Seat; x: number; y: number; pinned: boolean };

/** One window row in the popover (and, for the main/secondary rows, the source of a seat's numbers). */
export type SeatRow = { key: string; name: string; w: UsageWindow | null; empty?: string; mainEligible?: boolean };

/** The main row's content: a bar + % + short countdown, or (no number at all) a same-height reason line. */
type MainRow = { kind: 'window'; row: SeatRow; rem: number } | { kind: 'text'; text: string };

/** What an adapter (claudeRows/gptRows/geminiRows/grokRows) builds for one seat; SeatCard only renders this. */
type SeatData = {
  seat: Seat;
  engine: 'claude' | 'gpt' | 'gemini' | 'grok';
  mark: ReactNode;
  /** Popover rows (and the pool the main/secondary rows are picked from); `mainEligible: false` (Fable) never becomes the main row. */
  rows: SeatRow[];
  /** 'kept' is cli-mode only (see UsagePanel); never produced by an adapter. */
  status: 'ok' | 'stale' | 'kept' | 'down' | 'unknown' | 'cooldown';
  dim?: boolean;
  hint?: string;
  observed?: string;
  credits?: string | null;
  /** No usable window at all (Grok, a logged-out/broken Gemini seat): this replaces the main row, same height. */
  reasonLine?: string;
  /** Replaces the generated "other windows" summary (Grok's token tally); '' hides the secondary row. */
  secondaryOverride?: string;
  /** Appended to the popover below the rows (Grok's "오늘 · deck 기준" block). */
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
  return `${b.planLabel ?? '플랜'} ${pct}% 사용${reset}${stale}`;
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
      reasonLine: grokMainText(g, now), secondaryOverride: `오늘 ${g.today.turns}턴 · ${tally} · deck 기준`, extraPopover,
    };
  }
  const blocked = g.status === 'down' || g.status === 'cooldown';
  return {
    seat, engine: 'grok', mark, rows: [{ key: 'week', name: grokPeriodName(g.billing.periodType), w: week, mainEligible: true }],
    // The subscription answered: no turn yet is not "unknown" any more.
    status: g.status === 'unknown' ? 'ok' : g.status,
    ...(blocked ? { reasonLine: grokMainText(g, now) } : {}),
    secondaryOverride: [tier, `deck 오늘 ${g.today.turns}턴`].filter(Boolean).join(' · '),
    observed: `확인 · ${resetStamp(g.billing.fetchedAt)}`,
    extraPopover,
  };
}

/** Remaining % as shown: whole numbers (Gemini buckets report "98.5"); a sliver above 0 still reads 1, not 소진. */
function shownPct(w: UsageWindow | null): number | null {
  const r = remainingPct(w);
  return r === null ? null : r > 0 && r < 1 ? 1 : Math.floor(r);
}

/** One row rendered inside the popover: label · bar (or spent pill) · remaining %. */
function PopRow({ seat, name, k, w, now, empty }: { seat: Seat; name: string; k: string; w: UsageWindow | null; now: number; empty?: string }) {
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
      <span className="usage-value">{rem === null ? (empty ? <span className="usage-na">{empty}</span> : '—') : <>{rem}<small>%</small></>}</span>
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

/** The lowest-remaining (= fullest) of the main-eligible rows; null when none has a value. */
function pickMain(rows: SeatRow[]): { row: SeatRow; rem: number } | null {
  let best: { row: SeatRow; rem: number } | null = null;
  for (const row of rows) {
    if (row.mainEligible === false) continue;
    const rem = shownPct(row.w);
    if (rem !== null && (!best || rem < best.rem)) best = { row, rem };
  }
  return best;
}

/** "주간 41% · Fable 63%": every row but the main one, joined; credits appended for GPT. '' when there is nothing else to say. */
function secondaryText(rows: SeatRow[], mainKey: string | null, credits?: string | null): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (row.key === mainKey) continue;
    const rem = shownPct(row.w);
    parts.push(rem === null ? `${row.name} ${row.empty ?? '불명'}` : rem === 0 ? `${row.name} 소진` : `${row.name} ${rem}%`);
  }
  if (credits) parts.push(`크레딧 ${credits}`);
  return parts.join(' · ');
}

/** One status dot — hidden entirely while 'ok' (the current ring alone is enough news there). */
function StatusDot({ seat, status }: { seat: Seat; status: string }) {
  if (status === 'ok') return null;
  const label: Record<string, string> = { stale: '오래됨', unknown: '불명', down: '불명', cooldown: '쿨다운', kept: '추정(유지)' };
  return <span data-testid={`${seat}-dot`} className={`usage-dot ${status}`} title={label[status] ?? status} aria-hidden="true" />;
}

/** One seat as the common card: head (mark/letter/status dot) → main row → secondary line → click popover. */
function SeatCard({ data, current, now, pop, onPop, onOpenHistory, next }: {
  data: SeatData; current: boolean; now: number; pop: Pop | null; onPop: (p: Pop | null) => void; onOpenHistory?: () => void;
  next?: RouteNext | null;
}) {
  const { seat, rows, status, dim, hint, observed, credits, reasonLine, secondaryOverride, extraPopover, mark, engine } = data;
  const label = useAccounts().label(seat);
  const at = (el: HTMLElement, pinned: boolean): Pop => {
    const r = el.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 250)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  const main = pickMain(rows);
  const mainReset = main ? countdown(main.row.w!.resetsAt, now) : '';
  const mainShort = main ? shortCountdown(main.row.w!.resetsAt, now) : '';
  const secondary = secondaryOverride !== undefined ? secondaryOverride : secondaryText(rows, main?.row.key ?? null, credits);
  // Claude's cli-mode "observed" time belongs in the title (so routing trust is visible without a click); Gemini's
  // "확인 ·" observed stamp is popover-only (the title stays empty for a healthy seat).
  const title = [hint, engine === 'claude' ? observed : '', dim ? UNTRUSTED : ''].filter(Boolean).join(' · ');
  return (
    <div
      data-testid={`account-${seat}`}
      className={`usage-card ${engine} ${current ? 'current' : ''} ${status} ${open ? 'open' : ''}`}
      title={title}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${label} 잔여량${current ? ' (현재)' : ''}${next ? ` · 다음 턴 여기${next.asOpus ? '(Opus)' : ''}` : ''}`}
      onMouseEnter={(e) => { if (!pop?.pinned) onPop(at(e.currentTarget, false)); }}
      onMouseLeave={() => { if (!pop?.pinned) onPop(null); }}
      onClick={(e) => { e.stopPropagation(); onPop(open && pop?.pinned ? null : at(e.currentTarget, true)); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onPop(null);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPop(open ? null : at(e.currentTarget, true)); }
      }}
    >
      <div className="usage-id">
        {mark}
        <span className="usage-letter" title={label}>{label}</span>
        <StatusDot seat={seat} status={status} />
      </div>
      <div className="usage-body">
        {reasonLine !== undefined ? (
          <div className="usage-main usage-main-text" data-testid={`${seat}-main`}>{reasonLine}</div>
        ) : (
          <div className={`usage-main ${main ? levelClass(main.row.w) : 'none'}`} data-testid={`${seat}-main`} title={main ? `${main.row.name} · ${main.rem}% 남음${mainReset ? ` · ${mainReset}` : ''}` : '잔여량 알 수 없음'}>
            <span className="usage-bar" aria-hidden="true"><i style={{ width: `${main?.rem ?? 0}%` }} /></span>
            <span className="usage-value">{!main ? '—' : main.rem === 0 ? '소진' : <>{main.rem}<small>%</small></>}{main?.row.w?.estimated ? <small className="usage-est">~</small> : null}</span>
            {mainShort && <small className="usage-cd" title={`${main!.row.name} · ${mainReset}`}>{mainShort}</small>}
          </div>
        )}
        <div className="usage-secondary" data-testid={`${seat}-secondary`}>{secondary || ' '}</div>
      </div>
      {next && <span className="usage-next" data-testid={`next-${seat}`} title={`다음 턴은 이 계정으로 갑니다: ${next.reason}`}>{next.asOpus ? '→ 다음 턴 · Opus' : '→ 다음 턴'}</span>}
      {/* Always in the DOM (hidden via display:none, not unmounted) so a row's testid is queryable even closed —
          @testing-library's getByRole excludes display:none from the a11y tree, so "no tooltip while closed" still holds. */}
      <div className="usage-pop" role="tooltip" aria-hidden={!open} style={open ? { left: pop!.x, top: pop!.y } : { display: 'none' }}>
        <div className="usage-pop-title">{label} 계정{current ? ' · 현재' : ''}</div>
        <div className="usage-pop-row hint">{LEGEND}</div>
        {hint && <div className="usage-pop-row hint">{hint}</div>}
        {observed && <div className="usage-pop-row" data-testid={`${seat}-observed`}><span>관측</span><b>{observed}</b></div>}
        {rows.map((r) => <PopRow key={r.key} seat={seat} name={r.name} k={r.key} w={r.w} now={now} empty={r.empty} />)}
        {credits && <div className="usage-pop-row" data-testid={`${seat}-credits`}><span>크레딧</span><b>{credits}</b></div>}
        {extraPopover}
        {onOpenHistory && open && pop!.pinned && (
          <div className="usage-pop-row link">
            <button type="button" onClick={(e) => { e.stopPropagation(); onPop(null); onOpenHistory(); }}>토큰 사용량 기록 보기 ›</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Where the active session's next turn would go (route_preview), as the card tag shows it. */
export type RouteNext = { account: Seat; reason: string; asOpus?: boolean };

/** Below this the whole row becomes a one-line vendor chip strip (design §7-10). */
const CHIP_QUERY = '(max-width: 599.98px)';

function usePhoneChips(): boolean {
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(CHIP_QUERY).matches : false);
  const [v, setV] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(CHIP_QUERY);
    const on = () => setV(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}

/**
 * True while the full cards do not fit the width they get (their rows overflow the card even with the bar dropped): the
 * top bar's other items do not shrink, so the room for the cards depends on more than the window width. Measured on the
 * cards (the panel itself is display: contents in the two-row layouts, < 1100px — measured there too: a fixed 1100px
 * cutoff let 600–1099px cards overflow into their neighbours): while the full cards show, after every render
 * (new numbers, a countdown growing, the 30 s clock) and on every card or bar resize; the width the full cards needed is
 * kept, since the compact card cannot measure it, and the switch turns back off only once there is 16px more than that.
 * "More" is read two ways: the cards themselves 16px wider, or — since a capped compact card (the one-row bar's 160px)
 * never gets that wide — each card's share of the row (the panel, or the bar when the panel is display: contents)
 * 16px past the share the full cards were missing. Too early a release only re-measures and switches back at once
 * with a larger need, so it cannot flicker.
 */
function useCramped(panel: RefObject<HTMLDivElement | null>, ids: string): boolean {
  const [cramped, setCramped] = useState(false);
  const on = useRef(false);
  const need = useRef(0);
  const needShare = useRef(0);
  const check = useCallback(() => {
    const set = (v: boolean) => { if (v !== on.current) { on.current = v; setCramped(v); } };
    const el = panel.current;
    const list = el ? [...el.querySelectorAll<HTMLElement>(':scope > .usage-card')] : [];
    if (!el || !list.length) return set(false);
    const row = getComputedStyle(el).display === 'contents' ? el.parentElement : el;
    const share = (row?.clientWidth ?? 0) / list.length;
    if (on.current) {
      if (Math.min(...list.map((c) => c.clientWidth)) >= need.current + 16 || (share > 0 && share >= needShare.current + 16)) set(false);
      return;
    }
    const over = list.filter((c) => c.scrollWidth > c.clientWidth + 1);
    if (over.length) {
      need.current = Math.max(...over.map((c) => c.scrollWidth));
      needShare.current = share + Math.max(...over.map((c) => c.scrollWidth - c.clientWidth));
      set(true);
    }
  }, [panel]);
  // Before paint, so an overflowing full card never shows for a frame.
  useLayoutEffect(() => { if (!on.current) check(); });
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !ids || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    for (const c of el.querySelectorAll(':scope > .usage-card')) ro.observe(c);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    check();
    return () => ro.disconnect();
  }, [panel, ids, check]);
  return cramped;
}

/** Below this the top bar is always two rows (styles.css); above it, `useFold` decides. */
const TWO_ROW_QUERY = '(max-width: 1099.98px)';

/**
 * ≥ 1100px: true while the cards overflow the one-row bar's panel (they ran under the actions and each other — a
 * 6-seat row at 1280px did not fit even dense): the panel says data-fold and styles.css gives
 * the bar the same two-row layout as below 1100px. Folded, the panel is display: contents and cannot be measured, so the
 * window width it would have needed is kept and the fold lets go only once the window is 16px wider than that (or the
 * set of cards changes, which measures again). Judged only once the cards are already dense (data-dense): a row that fits
 * dense never folds, and the kept width is the dense row's, not the full one's. Below 1100px it always lets go (the
 * two-row layout is there anyway, and a fold left on would outlive the window that needed it).
 */
function useFold(panel: RefObject<HTMLDivElement | null>, ids: string): boolean {
  const [fold, setFold] = useState(false);
  const on = useRef(false);
  const at = useRef(0);
  const set = useCallback((v: boolean) => { if (v !== on.current) { on.current = v; setFold(v); } }, []);
  const check = useCallback(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia(TWO_ROW_QUERY).matches) return set(false);
    if (on.current) { if (window.innerWidth >= at.current + 16) set(false); return; }
    const el = panel.current;
    if (!el || !el.hasAttribute('data-dense')) return;
    if (el.scrollWidth > el.clientWidth + 1) { at.current = window.innerWidth + el.scrollWidth - el.clientWidth; set(true); }
  }, [panel, set]);
  // A new set of cards measures afresh (declared first: the check below then runs on the unfolded row).
  useLayoutEffect(() => {
    set(false);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [ids, check, set]);
  // The panel's own size too (the bar's other items come and go without a window resize). Folded, the panel is
  // display: contents and reports nothing, and an unfolded check only reads sizes: no loop.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || !ids || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panel, ids, check]);
  useLayoutEffect(() => { if (!on.current) check(); });
  return fold;
}

/** One vendor chip in the <600px row: letter + main %, or (Grok) a status dot + short word. Tap opens the usual popover. */
function Chip({ data, current, pop, onPop }: { data: SeatData; current: boolean; pop: Pop | null; onPop: (p: Pop | null) => void }) {
  const { seat, rows, status, reasonLine } = data;
  const label = useAccounts().label(seat);
  const main = pickMain(rows);
  const open = pop?.seat === seat;
  const text = reasonLine !== undefined ? (status === 'down' ? '●' : status === 'cooldown' ? '●' : '○') : (!main ? '—' : main.rem === 0 ? '소진' : `${main.rem}`);
  return (
    <button
      type="button"
      data-testid={`chip-${seat}`}
      className={`usage-chip ${status} ${current ? 'current' : ''} ${open ? 'open' : ''}`}
      onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onPop(open ? null : { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 250)), y: r.bottom + 6, pinned: true }); }}
    >
      <span className="usage-chip-letter">{label}</span>
      <span className="usage-chip-num">{text}{reasonLine === undefined && main ? (main.rem > 0 ? '%' : '') : reasonLine !== undefined ? (status === 'ok' ? '가능' : status === 'down' ? '불가' : status === 'cooldown' ? '대기' : '') : ''}</span>
    </button>
  );
}

export function UsagePanel({ usage, current, now: fixedNow, onOpenHistory, next = null, grok = null }: {
  usage: UsageSnapshot | null; current: Seat | null; now?: number; onOpenHistory?: () => void; next?: RouteNext | null;
  /** hello's own Grok status: the Grok card (and chip) is shown only while `grok.bin` is true (design §7-4). */
  grok?: GrokStatus | null;
}) {
  const now = useClock(fixedNow);
  const { active, label } = useAccounts();
  const phoneChips = usePhoneChips();
  const [pop, setPop] = useState<Pop | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cli = usage?.usageMode === 'cli';

  const geminiOf = (a: GeminiAccount): GeminiUsage | undefined => usage?.geminiSeats?.[a] ?? (a === 'g1' ? usage?.gemini : undefined);
  const grokOf = (a: GrokAccount): GrokUsage | undefined => usage?.grokSeats?.[a];
  const showGemini = GEMINI_ACCOUNTS.filter((a) => geminiOf(a) !== undefined);
  const showGrok = grok?.bin ? GROK_ACCOUNTS : [];

  useEffect(() => {
    if (!pop?.pinned) return;
    const close = () => setPop(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [pop?.pinned]);

  // Esc closes an open popover wherever focus is (the phone chip's popover is not inside the focused button). Pane's
  // ESC_OWNERS sees the open tooltip and leaves this press alone; once it is gone, the next Esc stops the turn again.
  const popOpen = pop !== null;
  useEffect(() => {
    if (!popOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popOpen]);

  const ids = usage ? [...active.map((a) => a.id), 'gpt', ...showGemini, ...showGrok].join(' ') : '';
  const cramped = useCramped(panelRef, ids);
  const fold = useFold(panelRef, ids);

  // Before the first snapshot the panel already takes the shape it will have, so the top bar does not jump when numbers arrive.
  if (!usage) return <div className="usage-panel" data-cards={active.length + 1}><span className="usage-loading">잔여량 불러오는 중…</span></div>;

  const gpt = usage.gpt ?? emptyAccountUsage();

  const seats: SeatData[] = [
    ...active.map(({ id: a }): SeatData => {
      const u = usageOf(usage, a);
      const kept = cli && u.status === 'stale' && trusted(u, now);
      const dim = cli && u.status === 'stale' && !kept;
      return {
        seat: a, engine: 'claude', mark: <ClaudeMark className="usage-mark claude" />, rows: claudeRows(u, cli),
        status: (kept ? 'kept' : u.status) as SeatData['status'], dim,
        ...(cli ? { observed: observedText(u, now) } : {}),
      };
    }),
    {
      seat: 'gpt', engine: 'gpt', mark: <OpenAIMark className="usage-mark gpt" />, rows: gptRows(gpt), status: gpt.status as SeatData['status'],
      credits: creditsText(gpt.credits),
      ...(gpt.status === 'down' ? { hint: cli ? 'GPT 잔여량 불명 — 아직 Codex 기록에서 한도 값을 읽지 못했습니다' : 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {}),
    },
    ...showGemini.map((a): SeatData => {
      const g = geminiOf(a)!;
      const hint = geminiHint(g);
      const rows = geminiRows(g);
      return {
        seat: a, engine: 'gemini', mark: <GeminiMark className="usage-mark gemini" />, rows, status: g.status as SeatData['status'],
        hint, ...(rows.length === 0 ? { reasonLine: hint || '잔여량 알 수 없음', secondaryOverride: '' } : {}),
        ...(g.fetchedAt ? { observed: `확인 · ${resetStamp(g.fetchedAt)}` } : {}),
      };
    }),
    ...showGrok.map((a) => grokSeatData(a, grokOf(a) ?? { status: 'unknown', lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '' } }, now, usage?.grokBot)),
  ];

  const cards = seats.length;
  // Measured width drives cramped mode; a hard floor past 5 cards keeps the dense (letters-only) look even when
  // no ResizeObserver has fired yet (e.g. in jsdom tests with no layout), matching the pre-existing count-based
  // "any number of accounts" expectations alongside the new measurement-based ones.
  const dense = cramped || cards > 5;
  const isCurrentSeat = (seat: Seat) => current === seat;

  if (phoneChips) {
    return (
      <div className="usage-panel usage-chips" data-cards={cards}>
        {seats.map((d) => <Chip key={d.seat} data={d} current={isCurrentSeat(d.seat)} pop={pop} onPop={setPop} />)}
        {pop && (() => {
          const d = seats.find((s) => s.seat === pop.seat);
          if (!d) return null;
          return (
            <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
              <div className="usage-pop-title">{label(d.seat)} 계정{isCurrentSeat(d.seat) ? ' · 현재' : ''}</div>
              <div className="usage-pop-row hint">{LEGEND}</div>
              {d.hint && <div className="usage-pop-row hint">{d.hint}</div>}
              {d.observed && <div className="usage-pop-row"><span>관측</span><b>{d.observed}</b></div>}
              {d.rows.map((r) => <PopRow key={r.key} seat={d.seat} name={r.name} k={r.key} w={r.w} now={now} empty={r.empty} />)}
              {d.credits && <div className="usage-pop-row"><span>크레딧</span><b>{d.credits}</b></div>}
              {d.extraPopover}
              {onOpenHistory && (
                <div className="usage-pop-row link">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setPop(null); onOpenHistory(); }}>토큰 사용량 기록 보기 ›</button>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  }

  return (
    <div
      ref={panelRef} className="usage-panel" data-cards={cards} {...(dense ? { 'data-dense': '' } : {})} {...(cards > 4 ? { 'data-many': '' } : {})} {...(fold ? { 'data-fold': '' } : {})} {...(cards > 6 ? { 'data-wrap': '' } : {})}
      style={{ '--usage-cards': cards, ...(cards > 6 ? { '--usage-cols-wrap': Math.ceil(cards / 2) } : {}) } as CSSProperties}
    >
      {/* Said once for the whole row, not on every card: the numbers are what is left, and what amber / red mean. */}
      <span className="usage-caption" title={`${LEGEND} · 카드를 누르면 리셋 시각`}>남음</span>
      {seats.map((d) => (
        <SeatCard
          key={d.seat} data={d} current={isCurrentSeat(d.seat)} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory}
          next={next?.account === d.seat && (d.seat !== current || next.asOpus) ? next : null}
        />
      ))}
      {/* `cli` never asks usage-deck: deckReachable is always false there and says nothing. */}
      {!cli && !usage.deckReachable && <span className="usage-stale" title="usage-deck 에 닿지 않아 마지막 값을 보여 줍니다">오래된 값</span>}
    </div>
  );
}
