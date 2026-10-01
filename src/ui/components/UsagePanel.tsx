import { useEffect, useState, type MouseEvent } from 'react';
import { ACCOUNTS, SEAT_LABEL, type Seat } from '../../shared/accounts';
import { emptyAccountUsage, parseIsoUtc, remainingPct, type AccountUsage, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

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

/** One seat: label, then a thin bar + "N% 남음" per window; reset times on hover and in a tap popover. */
function SeatChip({ seat, u, windows, current, now, pop, onPop, hint }: {
  seat: Seat; u: AccountUsage; windows: { key: WindowKey; name: string }[]; current: boolean; now: number;
  pop: Pop | null; onPop: (p: Pop | null) => void; hint?: string;
}) {
  const at = (e: MouseEvent<HTMLDivElement>, pinned: boolean): Pop => {
    const r = e.currentTarget.getBoundingClientRect();
    return { seat, x: Math.max(8, Math.min(r.left, window.innerWidth - 216)), y: r.bottom + 6, pinned };
  };
  const open = pop?.seat === seat;
  return (
    <div
      data-testid={`account-${seat}`}
      className={`usage-account ${current ? 'current' : ''} ${u.status} ${open ? 'open' : ''}`}
      title={hint ?? ''}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${SEAT_LABEL[seat]} 잔여량`}
      onMouseEnter={(e) => { if (!pop?.pinned) onPop(at(e, false)); }}
      onMouseLeave={() => { if (!pop?.pinned) onPop(null); }}
      onClick={(e) => { e.stopPropagation(); onPop(open && pop?.pinned ? null : at(e, true)); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onPop(null); }}
    >
      <div className="usage-name">{SEAT_LABEL[seat]}{current && <span className="tag">현재</span>}</div>
      <div className="usage-windows">
        {windows.map(({ key, name }) => {
          const w = u[key];
          const rem = remainingPct(w);
          const reset = w ? countdown(w.resetsAt, now) : '';
          return (
            <div key={key} data-testid={`${seat}-${key}`} className={`usage-window ${levelClass(w)}`} title={reset}>
              <span className="usage-label">{name}</span>
              <span className="usage-bar" aria-hidden="true"><i style={{ width: `${rem ?? 0}%` }} /></span>
              <span className="usage-value">{rem === null ? '—' : <>{`${rem}% `}<small>남음</small></>}</span>
              {reset && <span className="usage-reset">{reset}</span>}
            </div>
          );
        })}
      </div>
      {open && (
        <div className="usage-pop" role="tooltip" style={{ left: pop.x, top: pop.y }}>
          <div className="usage-pop-title">{SEAT_LABEL[seat]} 계정{current ? ' · 현재' : ''}</div>
          {hint && <div className="usage-pop-row">{hint}</div>}
          {windows.map(({ key, name }) => {
            const w = u[key];
            const rem = remainingPct(w);
            return (
              <div key={key} className="usage-pop-row">
                <span>{name} {rem === null ? '—' : `${rem}% 남음`}</span>
                <b>{w?.resetsAt ? countdown(w.resetsAt, now) : '리셋 시각 없음'}</b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ usage, current, now: fixedNow }: { usage: UsageSnapshot | null; current: Seat | null; now?: number }) {
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
        <SeatChip key={a} seat={a} u={usage.accounts[a]} windows={WINDOWS} current={a === current} now={now} pop={pop} onPop={setPop} />
      ))}
      <SeatChip
        seat="gpt" u={gpt} windows={GPT_WINDOWS} current={current === 'gpt'} now={now} pop={pop} onPop={setPop}
        {...(gpt.status === 'down' ? { hint: 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' } : {})}
      />
      {!usage.deckReachable && <span className="tag stale" title="usage-deck 에 닿지 않아 마지막 값을 보여 줍니다">오래된 값</span>}
    </div>
  );
}
