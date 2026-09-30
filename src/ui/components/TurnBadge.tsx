import { MODEL_LABEL } from '../../shared/models';
import type { TurnBadge as Badge } from '../../shared/protocol';

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function TurnBadge({ badge }: { badge: Badge }) {
  const u = badge.usage;
  return (
    <div className="turn-badge">
      <span className={`acct acct-${badge.account}`}>{badge.account.toUpperCase()}</span>
      <span>{MODEL_LABEL[badge.model]}</span>
      <span>입력 {k(u.inputTokens)} · 출력 {k(u.outputTokens)} · 캐시 읽기 {k(u.cacheReadTokens)} · 캐시 쓰기 {k(u.cacheCreationTokens)}</span>
      <span className="reason">{badge.reason}</span>
      {badge.modelNote && <span className="note">{badge.modelNote}</span>}
    </div>
  );
}
