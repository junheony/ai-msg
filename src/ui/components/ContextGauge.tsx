import { useEffect, useState } from 'react';
import { contextHint, contextLabel, contextPct, contextTokens, fmtTokens, isLongContext, type ContextInfo } from '../context';

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

/** Desktop-style context ring next to the model picker; hover (or tap, on phones) shows "컨텍스트 312k / 1M · 캐시 적중 97%". */
export function ContextGauge({ info }: { info: ContextInfo | null }) {
  const [open, setOpen] = useState(false);
  if (!info) return null;
  const tokens = contextTokens(info.usage);
  const pct = contextPct(tokens, info.window);
  const label = contextLabel(info);
  const level = pct >= 85 ? 'high' : isLongContext(tokens, info.window) ? 'long' : 'ok';
  return (
    <span className="ctx-gauge-wrap">
      <button type="button" className={`ctx-gauge ${level}`} title={label} aria-label={label} aria-expanded={open} data-testid="context-gauge" onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ctx-track" cx="9" cy="9" r={R} />
          <circle className="ctx-arc" cx="9" cy="9" r={R} strokeDasharray={`${(C * Math.max(pct, 2)) / 100} ${C}`} transform="rotate(-90 9 9)" />
        </svg>
        <span className="ctx-num">{fmtTokens(tokens)}</span>
      </button>
      {open && <span className="ctx-pop" role="status">{label}</span>}
    </span>
  );
}

/** One muted line above the composer: cache expired (next turn re-reads everything) or the session is long. Never blocks. */
export function ContextHint({ info }: { info: ContextInfo | null }) {
  const now = useNow(60_000);
  const hint = contextHint(info, now);
  return hint ? <div className="ctx-hint" data-testid="context-hint">{hint}</div> : null;
}
