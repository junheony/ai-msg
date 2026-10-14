import { useEffect, useState, type CSSProperties } from 'react';
import type { Seat } from '../../shared/accounts';
import { useAccounts } from '../accounts';
import { ClaudeMark, GeminiMark, OpenAIMark } from './EngineMark';
import { isGeminiAccount } from '../../shared/accounts';
import { emptyAccountUsage, parseIsoUtc, remainingPct, usageOf, type AccountUsage, type GeminiUsage, type GptCredits, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

type WindowKey = 'fiveHour' | 'weekly' | 'fable';
const WINDOWS: { key: WindowKey; name: string }[] = [
  { key: 'fiveHour', name: '5h' },
  { key: 'weekly', name: '주간' },
  { key: 'fable', name: 'Fable' },
];
const GPT_WINDOWS: { key: WindowKey; name: string }[] = [
  { key: 'weekly', name: '주간' },
  { key: 'fiveHour', name: '5h' },
];

export function countdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now; // zone-less stamps are UTC (review M9)
  if (Number.isNaN(ms) || ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 후 리셋` : `${h}시간 ${m}분 후 리셋`;
}

/**
 * The always-on short form next to a card's fullest window: "47분 후", "3시간 후", "1일 5시간 후" (under 48 hours the
 * hours still count), "2일 후", "리셋됨"; '' without a (readable) reset time.
 */
export function shortCountdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = parseIsoUtc(resetsAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return '리셋됨';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)}일 후`;
  if (h >= 24) return h > 24 ? `1일 ${h - 24}시간 후` : '1일 후';
  if (h >= 1) return `${h}시간 후`;
  return `${Math.max(1, Math.floor(ms / 60_000))}분 후`;
}

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

/** One window row: label · rounded bar · remaining %; a spent window collapses into a muted "소진 · reset" pill. */
function WindowRow({ seat, name, k, w, now, short }: { seat: Seat; name: string; /** Row id for the test id: a window key, or a Gemini bucket's. */ k: string; w: UsageWindow | null; now: number; /** Show the short countdown next to the % (the card's fullest window). */ short?: boolean }) {
  const rem = remainingPct(w);
  const reset = w ? countdown(w.resetsAt, now) : '';
  const title = rem === null ? `${name} · 알 수 없음` : rem === 0 ? `${name} · 소진${w?.resetsAt ? ` · ${resetStamp(w.resetsAt)} 리셋` : ''}` : `${name} · ${rem}% 남음${reset ? ` · ${reset}` : ''}`;
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
    <div data-testid={`${seat}-${k}`} className={`usage-row ${levelClass(w)}`} title={title}>
      <span className="usage-label">{name}</span>
      <span className="usage-bar" aria-hidden="true"><i style={{ width: `${rem ?? 0}%` }} /></span>
      <span className="usage-value">{rem === null ? '—' : <>{rem}<small>%</small></>}</span>
      {short && w?.resetsAt && <small className="usage-cd" data-testid={`${seat}-${k}-cd`}>{shortCountdown(w.resetsAt, now)}</small>}
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

/** One seat as a small card: mark + letter, then aligned rows; reset times on hover (title) and in a tap popover. */
function SeatCard({ seat, u, windows, current, now, pop, onPop, hint, onOpenHistory, next }: {
  seat: Seat; u: AccountUsage; windows: { key: WindowKey; name: string }[]; current: boolean; now: number;
  pop: Pop | null; onPop: (p: Pop | null) => void; hint?: string; onOpenHistory?: () => void;
  /** The active session's next turn would run here (route_preview). */
  next?: RouteNext | null;
}) {
  const label = useAccounts().label(seat);
  const at = (el: HTMLElement, pinned: boolean): Pop => {
    const r = el.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 236)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  const credits = seat === 'gpt' ? creditsText(u.credits) : null;
  // Compact layouts (phone, tablet) show one number per seat: the least left of 5h / 주간, the windows that gate every model.
  // Fable only gates Fable (a spent Fable must not read "소진" for the whole seat); its bar still shows.
  const fullest = fullestWindow(u, windows.map((w) => w.key));
  let worst: { name: string; w: UsageWindow; rem: number } | null = null;
  for (const { key, name } of windows) {
    if (key === 'fable') continue;
    const w = u[key];
    const rem = remainingPct(w);
    if (w && rem !== null && (!worst || rem < worst.rem)) worst = { name, w, rem };
  }
  return (
    <div
      data-testid={`account-${seat}`}
      className={`usage-card ${seat === 'gpt' ? 'gpt' : 'claude'} ${current ? 'current' : ''} ${u.status} ${open ? 'open' : ''}`}
      title={hint ?? ''}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${label} 잔여량${current ? ' (현재)' : ''}`}
      onMouseEnter={(e) => { if (!pop?.pinned) onPop(at(e.currentTarget, false)); }}
      onMouseLeave={() => { if (!pop?.pinned) onPop(null); }}
      onClick={(e) => { e.stopPropagation(); onPop(open && pop?.pinned ? null : at(e.currentTarget, true)); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onPop(null);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPop(open ? null : at(e.currentTarget, true)); }
      }}
    >
      {current && <span className="usage-dot" aria-hidden="true" />}
      <div className="usage-id">
        {seat === 'gpt' ? <OpenAIMark className="usage-mark gpt" /> : <ClaudeMark className="usage-mark claude" />}
        <span className="usage-letter" title={label}>{label}</span>
        {/* Next-turn routing preview: the account (and model) the next message of the active pane will go to. Inside the id
            column, never overhanging the card — the cards fill the top bar's height, so an overhang gets clipped. */}
        {next && <span className="usage-next" data-testid={`next-${seat}`} title={`다음 턴은 이 계정으로 갑니다: ${next.reason}`}>{next.asOpus ? '다음 턴 · Opus' : '다음 턴'}</span>}
      </div>
      <span className={`usage-sum ${worst ? levelClass(worst.w) : 'none'}`} aria-hidden="true" title={worst ? `가장 적게 남은 한도 · ${worst.name} ${worst.rem}%` : '잔여량 알 수 없음'}>
        {!worst ? '—' : worst.rem === 0 ? '소진' : <>{worst.rem}<small>%</small></>}
      </span>
      <div className="usage-rows">
        {windows.map(({ key, name }) => <WindowRow key={key} seat={seat} name={name} k={key} w={u[key]} now={now} short={key === fullest} />)}
        {credits && (
          <div data-testid="gpt-credits" className="usage-row credits" title="ChatGPT 크레딧 잔액 — 주간 한도가 끝난 뒤 쓰는 유료 크레딧">
            <span className="usage-label">크레딧</span>
            <span className="usage-credits">{credits}</span>
          </div>
        )}
      </div>
      {open && (
        <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
          <div className="usage-pop-title">{label} 계정{current ? ' · 현재' : ''}</div>
          {hint && <div className="usage-pop-row hint">{hint}</div>}
          {windows.map(({ key, name }) => {
            const w = u[key];
            const rem = remainingPct(w);
            return (
              <div key={key} className="usage-pop-row">
                <span>{name} {rem === null ? '—' : rem === 0 ? '한도 소진' : `${rem}% 남음`}</span>
                <b>{w?.resetsAt ? (rem === 0 ? `${resetStamp(w.resetsAt)} 리셋` : countdown(w.resetsAt, now)) : '리셋 시각 없음'}</b>
              </div>
            );
          })}
          {credits && <div className="usage-pop-row"><span>크레딧</span><b>{credits}</b></div>}
          {onOpenHistory && pop.pinned && (
            <div className="usage-pop-row link">
              <button type="button" onClick={(e) => { e.stopPropagation(); onPop(null); onOpenHistory(); }}>토큰 사용량 기록 보기 ›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Gemini 로그인 필요 / a read failure, as the card's hint; '' when the numbers are fresh. */
export function geminiHint(g: GeminiUsage): string {
  if (!g.loggedIn) return 'Gemini 로그인 필요 — 터미널에서 agy 실행 후 Google 로그인하면 사용량이 보입니다';
  if (g.status === 'ok') return '';
  return g.error ? `Gemini 사용량 ${g.status === 'stale' ? '오래된 값' : '불명'} — ${g.error}` : 'Gemini 사용량 불명';
}

/** Short bucket names: "Gemini 4 Argon" → "4 Argon", "gemini-3.8-flash" → "3.8 Flash"; anything else as is. */
export function bucketLabel(name: string): string {
  const s = name.replace(/^gemini[-_ ]?/i, '').replace(/[-_]+/g, ' ').trim();
  if (!s) return name;
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * The Gemini seat as a card: the spark + "Gemini", one row per quota bucket agy reports (models or model families), the
 * lowest remaining % as the summary. No bucket (not logged in, no answer yet, unreadable) shows "—" and the hint.
 */
function GeminiCard({ g, current, now, pop, onPop, onOpenHistory }: { g: GeminiUsage; current: boolean; now: number; pop: Pop | null; onPop: (p: Pop | null) => void; onOpenHistory?: () => void }) {
  const seat: Seat = 'g1';
  const at = (el: HTMLElement, pinned: boolean): Pop => {
    const r = el.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 236)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  const hint = geminiHint(g);
  const rows = g.buckets.map((b, i) => ({ key: `b${i}`, name: bucketLabel(b.name), w: { usedPct: b.usedPct, resetsAt: b.resetsAt } as UsageWindow }));
  let worst: { name: string; w: UsageWindow; rem: number } | null = null;
  for (const r of rows) { const rem = remainingPct(r.w); if (rem !== null && (!worst || rem < worst.rem)) worst = { name: r.name, w: r.w, rem }; }
  const fullest = worst?.name ?? null;
  return (
    <div
      data-testid="account-gemini"
      className={`usage-card gemini ${current ? 'current' : ''} ${g.status} ${open ? 'open' : ''}`}
      title={hint}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`Gemini 잔여량${current ? ' (현재)' : ''}`}
      onMouseEnter={(e) => { if (!pop?.pinned) onPop(at(e.currentTarget, false)); }}
      onMouseLeave={() => { if (!pop?.pinned) onPop(null); }}
      onClick={(e) => { e.stopPropagation(); onPop(open && pop?.pinned ? null : at(e.currentTarget, true)); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onPop(null);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPop(open ? null : at(e.currentTarget, true)); }
      }}
    >
      {current && <span className="usage-dot" aria-hidden="true" />}
      <div className="usage-id">
        <GeminiMark className="usage-mark gemini" />
        <span className="usage-letter" title="Gemini (Antigravity)">Gemini</span>
      </div>
      <span className={`usage-sum ${worst ? levelClass(worst.w) : 'none'}`} aria-hidden="true" title={worst ? `가장 적게 남은 한도 · ${worst.name} ${worst.rem}%` : (hint || '잔여량 알 수 없음')}>
        {!worst ? '—' : worst.rem === 0 ? '소진' : <>{worst.rem}<small>%</small></>}
      </span>
      <div className="usage-rows">
        {rows.length
          ? rows.map((r) => <WindowRow key={r.key} seat={seat} name={r.name} k={r.key} w={r.w} now={now} short={r.name === fullest} />)
          : <div data-testid="g1-none" className="usage-row none" title={hint || '잔여량 알 수 없음'}><span className="usage-label">{g.loggedIn ? '한도' : '로그인'}</span><span className="usage-bar" aria-hidden="true"><i style={{ width: 0 }} /></span><span className="usage-value">—</span></div>}
      </div>
      {open && (
        <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
          <div className="usage-pop-title">Gemini{current ? ' · 현재' : ''}</div>
          {hint && <div className="usage-pop-row hint">{hint}</div>}
          {rows.map((r) => {
            const rem = remainingPct(r.w);
            return (
              <div key={r.key} className="usage-pop-row">
                <span>{r.name} {rem === null ? '—' : rem === 0 ? '한도 소진' : `${rem}% 남음`}</span>
                <b>{r.w.resetsAt ? (rem === 0 ? `${resetStamp(r.w.resetsAt)} 리셋` : countdown(r.w.resetsAt, now)) : '리셋 시각 없음'}</b>
              </div>
            );
          })}
          {g.fetchedAt && <div className="usage-pop-row"><span>확인</span><b>{resetStamp(g.fetchedAt)}</b></div>}
          {onOpenHistory && pop.pinned && (
            <div className="usage-pop-row link">
              <button type="button" onClick={(e) => { e.stopPropagation(); onPop(null); onOpenHistory(); }}>토큰 사용량 기록 보기 ›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Where the active session's next turn would go (route_preview), as the card tag shows it. */
export type RouteNext = { account: Seat; reason: string; asOpus?: boolean };

export function UsagePanel({ usage, current, now: fixedNow, onOpenHistory, next = null }: { usage: UsageSnapshot | null; current: Seat | null; now?: number; onOpenHistory?: () => void; next?: RouteNext | null }) {
  const now = useClock(fixedNow);
  const { active } = useAccounts();
  const [pop, setPop] = useState<Pop | null>(null);
  useEffect(() => {
    if (!pop?.pinned) return;
    const close = () => setPop(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [pop?.pinned]);
  if (!usage) return <div className="usage-panel"><span className="usage-loading">잔여량 불러오는 중…</span></div>;
  const gpt = usage.gpt ?? emptyAccountUsage();
  // One card per active account, one for GPT, one for Gemini when it is set up: the grid's column count. Up to five cards
  // keep the rows of numbers (five go to two rows below 1600px, see styles.css); past five there is no room for them at any
  // width: the compact card (label over the lowest remaining %). From seven cards a phone shows two rows.
  const gemini = usage.gemini ?? null;
  const cards = active.length + 1 + (gemini ? 1 : 0);
  return (
    <div className="usage-panel" data-cards={cards} {...(cards > 5 ? { 'data-dense': '' } : {})} {...(cards > 6 ? { 'data-wrap': '' } : {})} style={{ '--usage-cards': cards, ...(cards > 6 ? { '--usage-cols-wrap': Math.ceil(cards / 2) } : {}) } as CSSProperties}>
      {active.map(({ id: a }) => (
        <SeatCard key={a} seat={a} u={usageOf(usage, a)} windows={WINDOWS} current={a === current} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory} next={next?.account === a ? next : null} />
      ))}
      <SeatCard
        seat="gpt" u={gpt} windows={GPT_WINDOWS} current={current === 'gpt'} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory}
        {...(gpt.status === 'down' ? { hint: 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {})}
      />
      {gemini && <GeminiCard g={gemini} current={isGeminiAccount(current)} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory} />}
      {!usage.deckReachable && <span className="usage-stale" title="usage-deck 에 닿지 않아 마지막 값을 보여 줍니다">오래된 값</span>}
    </div>
  );
}
