import { ACCOUNTS, type Account } from '../../shared/accounts';
import { remainingPct, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };
const WINDOWS: { key: 'fiveHour' | 'weekly' | 'fable'; name: string }[] = [
  { key: 'fiveHour', name: '5h' },
  { key: 'weekly', name: '주간' },
  { key: 'fable', name: 'Fable' },
];

export function countdown(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = Date.parse(resetsAt) - now;
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

export function UsagePanel({ usage, current, now = Date.now() }: { usage: UsageSnapshot | null; current: Account | null; now?: number }) {
  if (!usage) return <div className="usage-panel">잔여량 불러오는 중…</div>;
  return (
    <div className="usage-panel">
      {ACCOUNTS.map((a) => {
        const u = usage.accounts[a];
        return (
          <div key={a} data-testid={`account-${a}`} className={`usage-account ${a === current ? 'current' : ''} ${u.status}`}>
            <div className="usage-name">{LABEL[a]}{a === current && <span className="tag">현재</span>}</div>
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
      {!usage.deckReachable && <span className="tag stale">오래된 값</span>}
    </div>
  );
}
