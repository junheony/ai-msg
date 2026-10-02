import { useEffect, useState } from 'react';
import { ACCOUNTS, SEAT_LABEL, type Seat } from '../../shared/accounts';
import { emptyAccountUsage, parseIsoUtc, remainingPct, type AccountUsage, type GptCredits, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

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

/** OpenAI blossom, drawn in currentColor (CSP: inline only, no external assets). */
function OpenAIMark() {
  return (
    <svg className="usage-mark gpt" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.041l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

type Pop = { seat: Seat; x: number; y: number; pinned: boolean };

/** One window row: label · rounded bar · remaining %; a spent window collapses into a muted "소진 · reset" pill. */
function WindowRow({ seat, name, k, w, now }: { seat: Seat; name: string; k: WindowKey; w: UsageWindow | null; now: number }) {
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
      {reset && <span className="usage-reset">{reset}</span>}
    </div>
  );
}

/** One seat as a small card: mark + letter, then aligned rows; reset times on hover (title) and in a tap popover. */
function SeatCard({ seat, u, windows, current, now, pop, onPop, hint, onOpenHistory }: {
  seat: Seat; u: AccountUsage; windows: { key: WindowKey; name: string }[]; current: boolean; now: number;
  pop: Pop | null; onPop: (p: Pop | null) => void; hint?: string; onOpenHistory?: () => void;
}) {
  const at = (el: HTMLElement, pinned: boolean): Pop => {
    const r = el.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 236)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  const credits = seat === 'gpt' ? creditsText(u.credits) : null;
  // Compact layouts (phone, tablet) show one number per seat: the least left of 5h / 주간, the windows that gate every model.
  // Fable only gates Fable (a spent Fable must not read "소진" for the whole seat); its bar still shows.
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
      aria-label={`${SEAT_LABEL[seat]} 잔여량${current ? ' (현재)' : ''}`}
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
        {seat === 'gpt' ? <OpenAIMark /> : <span className="usage-mark claude" aria-hidden="true">✳</span>}
        <span className="usage-letter">{SEAT_LABEL[seat]}</span>
      </div>
      <span className={`usage-sum ${worst ? levelClass(worst.w) : 'none'}`} aria-hidden="true" title={worst ? `가장 적게 남은 한도 · ${worst.name} ${worst.rem}%` : '잔여량 알 수 없음'}>
        {!worst ? '—' : worst.rem === 0 ? '소진' : <>{worst.rem}<small>%</small></>}
      </span>
      <div className="usage-rows">
        {windows.map(({ key, name }) => <WindowRow key={key} seat={seat} name={name} k={key} w={u[key]} now={now} />)}
        {credits && (
          <div data-testid="gpt-credits" className="usage-row credits" title="ChatGPT 크레딧 잔액 — 주간 한도가 끝난 뒤 쓰는 유료 크레딧">
            <span className="usage-label">크레딧</span>
            <span className="usage-credits">{credits}</span>
          </div>
        )}
      </div>
      {open && (
        <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
          <div className="usage-pop-title">{SEAT_LABEL[seat]} 계정{current ? ' · 현재' : ''}</div>
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

export function UsagePanel({ usage, current, now: fixedNow, onOpenHistory }: { usage: UsageSnapshot | null; current: Seat | null; now?: number; onOpenHistory?: () => void }) {
  const now = useClock(fixedNow);
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
  return (
    <div className="usage-panel">
      {ACCOUNTS.map((a) => (
        <SeatCard key={a} seat={a} u={usage.accounts[a]} windows={WINDOWS} current={a === current} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory} />
      ))}
      <SeatCard
        seat="gpt" u={gpt} windows={GPT_WINDOWS} current={current === 'gpt'} now={now} pop={pop} onPop={setPop} onOpenHistory={onOpenHistory}
        {...(gpt.status === 'down' ? { hint: 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {})}
      />
      {!usage.deckReachable && <span className="usage-stale" title="usage-deck 에 닿지 않아 마지막 값을 보여 줍니다">오래된 값</span>}
    </div>
  );
}
