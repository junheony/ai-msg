import { MODEL_LABEL } from '../../shared/models';
import type { TurnBadge as Badge } from '../../shared/protocol';

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The server reports an interrupted turn as errorText '중단됨' (TurnRunner); SDK/Codex aborts say abort/interrupt. */
const ABORT_ERROR = /중단|abort|interrupt|cancel/i;

/**
 * A turn that never really ran: interrupted, or finished with no input and no output tokens, or
 * failed before producing any text. Its footer says "중단됨" instead of a row of zeros.
 */
export function isStoppedTurn(t: { badge: Badge; error?: string | null; text?: string }): boolean {
  const u = t.badge.usage;
  if (t.error && ABORT_ERROR.test(t.error)) return true;
  if (u.inputTokens === 0 && u.outputTokens === 0) return true;
  return !!t.error && !(t.text ?? '').trim() && u.outputTokens === 0;
}

/** Turn footer: account tile, model pill, token counts (or "중단됨"), then the routing reason — one muted line. */
export function TurnBadge({ badge, stopped = false, cacheNote = null }: { badge: Badge; stopped?: boolean; /** "캐시 새로 씀 · <reason>" when the turn rewrote the prompt cache. */ cacheNote?: string | null }) {
  const u = badge.usage;
  const tokens = `입력 ${k(u.inputTokens)} · 출력 ${k(u.outputTokens)} · 캐시 읽기 ${k(u.cacheReadTokens)} · 캐시 쓰기 ${k(u.cacheCreationTokens)}`;
  return (
    <div className={`turn-badge${stopped ? ' stopped' : ''}`}>
      <span className={`acct acct-${badge.account}`} title={`계정 ${badge.account.toUpperCase()}`}>{badge.account.toUpperCase()}</span>
      <span className="tb-model">{MODEL_LABEL[badge.model]}</span>
      {stopped ? (
        <span className="tb-stopped" title={tokens}>중단됨</span>
      ) : (
        <span className="tb-tokens">
          <span>입력 <b>{k(u.inputTokens)}</b></span>
          <span>출력 <b>{k(u.outputTokens)}</b></span>
          <span>캐시 읽기 <b>{k(u.cacheReadTokens)}</b></span>
          {cacheNote
            ? <span className="tb-cold" title={cacheNote}>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>
            : <span>캐시 쓰기 <b>{k(u.cacheCreationTokens)}</b></span>}
        </span>
      )}
      <span className="reason" title={badge.reason}>{badge.reason}</span>
      {badge.modelNote && <span className="note">{badge.modelNote}</span>}
    </div>
  );
}
