import { useEffect, useState } from 'react';
import { COLD_HINT, LONG_HINT, contextHint, contextPct, contextTokens, isLongContext, type ContextInfo } from '../context';

/** Re-renders every `ms` so time-based hints (cache expiry) appear without new server messages. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const R = 7;
const C = 2 * Math.PI * R;

/** Context fill: percent of the window and its level (high ≥85%, long = past the long-session mark). */
export function contextLevel(info: ContextInfo): { pct: number; level: 'high' | 'long' | 'ok' } {
  const tokens = contextTokens(info.usage);
  const pct = contextPct(tokens, info.window);
  return { pct, level: pct >= 85 ? 'high' : isLongContext(tokens, info.window) ? 'long' : 'ok' };
}

/** The small context ring inside the session chip (decorative; the chip's label carries the words). */
export function ContextRing({ info }: { info: ContextInfo }) {
  const { pct, level } = contextLevel(info);
  return (
    <svg className={`ctx-ring ${level}`} width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" data-testid="context-ring">
      <circle className="ctx-track" cx="9" cy="9" r={R} />
      <circle className="ctx-arc" cx="9" cy="9" r={R} strokeDasharray={`${(C * Math.max(pct, 2)) / 100} ${C}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

/** The 새 세션으로 이어가기 button; mousedown keeps focus where it is so a surrounding popover's blur does not eat the click. */
export function HandoffButton({ onHandoff }: { onHandoff: () => void }) {
  return (
    <button type="button" className="handoff-btn" data-testid="handoff-btn" onMouseDown={(e) => e.preventDefault()} onPointerDown={(e) => e.preventDefault()} onClick={onHandoff} title="이 세션의 인계 메모를 쓰고 새 세션에서 이어갑니다">
      새 세션으로 이어가기
    </button>
  );
}

/**
 * One muted line above the composer: cache expired (next turn re-reads everything) or the session is long. Never blocks.
 * `cold = false`: the last reply's pill shows the expiry as its dot, so only the long-session line is left here.
 */
export function ContextHint({ info, onHandoff, cold = true }: { info: ContextInfo | null; onHandoff?: () => void; cold?: boolean }) {
  const now = useNow(60_000);
  const first = contextHint(info, now);
  // Without the expiry (at: null) the only hint left is the long-session one.
  const hint = first === COLD_HINT && !cold && info ? contextHint({ ...info, at: null }, now) : first;
  if (!hint) return null;
  return (
    <div className="ctx-hint" data-testid="context-hint">
      {hint}
      {hint === LONG_HINT && onHandoff && <HandoffButton onHandoff={onHandoff} />}
    </div>
  );
}
