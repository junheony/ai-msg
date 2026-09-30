import { useEffect, useState } from 'react';
import { ACCOUNTS, SEAT_LABEL, type Seat } from '../../shared/accounts';
import { emptyAccountUsage, parseIsoUtc, remainingPct, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

const WINDOWS: { key: 'fiveHour' | 'weekly' | 'fable'; name: string }[] = [
  { key: 'fiveHour', name: '5h' },
  { key: 'weekly', name: '주간' },
  { key: 'fable', name: 'Fable' },
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

export function UsagePanel({ usage, current, now: fixedNow }: { usage: UsageSnapshot | null; current: Seat | null; now?: number }) {
  const now = useClock(fixedNow);
  if (!usage) return <div className="usage-panel">잔여량 불러오는 중…</div>;
  const gpt = usage.gpt ?? emptyAccountUsage();
  return (
    <div className="usage-panel">
      {ACCOUNTS.map((a) => {
        const u = usage.accounts[a];
        return (
          <div key={a} data-testid={`account-${a}`} className={`usage-account ${a === current ? 'current' : ''} ${u.status}`}>
            <div className="usage-name">{SEAT_LABEL[a]}{a === current && <span className="tag">현재</span>}</div>
            {WINDOWS.map(({ key, name }) => {
              const w = u[key];
              const rem = remainingPct(w);
              return (
                <div key={key} data-testid={`${a}-${key}`} className={`usage-window ${levelClass(w)}`} title={w ? countdown(w.resetsAt, now) : ''}>
                  <span className="usage-label">{name}</span>
                  <span className="usage-value">{rem === null ? '—' : `${rem}% 남음`}</span>
                  {w && <span className="usage-reset">{countdown(w.resetsAt, now)}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
      {(() => {
        const unknown = gpt.status === 'down';
        return (
          <div data-testid="account-gpt" className={`usage-account ${current === 'gpt' ? 'current' : ''} ${gpt.status}`} title={unknown ? 'GPT 잔여량 불명 — usage-deck 의 codex 카드가 setup_needed 상태입니다' : ''}>
            <div className="usage-name">{SEAT_LABEL.gpt}{current === 'gpt' && <span className="tag">현재</span>}</div>
            {([{ key: 'weekly', name: '주간' }, { key: 'fiveHour', name: '5h' }] as const).map(({ key, name }) => {
              const w = gpt[key];
              const rem = remainingPct(w);
              return (
                <div key={key} data-testid={`gpt-${key}`} className={`usage-window ${levelClass(w)}`} title={w ? countdown(w.resetsAt, now) : ''}>
                  <span className="usage-label">{name}</span>
                  <span className="usage-value">{rem === null ? '—' : `${rem}% 남음`}</span>
                  {w && <span className="usage-reset">{countdown(w.resetsAt, now)}</span>}
                </div>
              );
            })}
          </div>
        );
      })()}
      {!usage.deckReachable && <span className="tag stale">오래된 값</span>}
    </div>
  );
}
