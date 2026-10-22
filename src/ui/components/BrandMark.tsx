/**
 * AI-MSG's own mark: a faceted crystal grain (MSG — the seasoning, not the dish) whose lower-left corner is a speech
 * tail. Three facets in three indigo steps (`--brand-top/left/right`, tinted per theme); the attribute fills are the
 * light theme's, for a copy outside the stylesheet. Same 24-unit box as the engine badges, sized by its class / 1em.
 * Source and the other options: docs/brand/. The app icons (scripts/gen-icons.mjs) draw the same polygons.
 */
const TOP = 'M12 1.4 20.31 6.2 12 11 3.69 6.2Z';
const LEFT = 'M3.69 6.2 12 11V20.6L8.26 18.44 4.1 22.4 5.19 16.66 3.69 15.8Z';
const RIGHT = 'M12 11 20.31 6.2V15.8L12 20.6Z';

export function BrandMark({ className }: { className: string }) {
  return (
    <svg className={`brand-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="brand-top" fill="#a5b4fc" d={TOP} />
      <path className="brand-left" fill="#4f46e5" d={LEFT} />
      <path className="brand-right" fill="#3730a3" d={RIGHT} />
    </svg>
  );
}

/** The wordmark: "AI-" quiet, "MSG" (the seasoning) emphasised. Plain text, so it reads as "AI-MSG". */
export function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-wordmark ${className}`.trim()}>
      <span className="brand-ai">AI</span><span className="brand-dash">-</span><span className="brand-msg">MSG</span>
    </span>
  );
}

/**
 * The progress mark: the grain without its tail, its facets in currentColor at three strengths, turned by `.spin`.
 * Neutral (no engine's mark) — a turn of any engine shows the same one.
 */
export function ProgressMark({ className }: { className: string }) {
  return (
    <svg className={`progress-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 2.4 20.31 7.2 12 12 3.69 7.2Z" />
      <path fill="currentColor" opacity=".7" d="M3.69 7.2 12 12V21.6L3.69 16.8Z" />
      <path fill="currentColor" opacity=".42" d="M12 12 20.31 7.2V16.8L12 21.6Z" />
    </svg>
  );
}
