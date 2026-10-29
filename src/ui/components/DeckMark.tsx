import { useId } from 'react';

/**
 * MSG's own mark — the app icon's chip (indigo tile #6366f1 → #4338ca, white speech-bubble cube).
 * Geometry is docs/brand/ai-msg-mark-a.svg (the grain / speech-bubble cube); the tile is the app-icon
 * treatment from that sheet. Inline SVG for the brand in the sidebar and on login. Same 24-unit box as
 * the engine marks, sized by its class / 1em. Sessions keep their engine marks (EngineMark).
 * PWA icon files live in src/ui/public/icons and are a separate change.
 */
export function DeckMark({ className }: { className: string }) {
  const grad = useId();
  return (
    <svg className={`deck-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={grad} x1="18%" y1="0%" x2="82%" y2="100%">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.3" fill={`url(#${grad})`} />
      <g transform="translate(12 12.2) scale(0.66) translate(-12 -11.9)">
        <path fill="#ffffff" d="M12 1.4 20.31 6.2 12 11 3.69 6.2Z" />
        <path fill="#e0e7ff" d="M3.69 6.2 12 11V20.6L8.26 18.44 4.1 22.4 5.19 16.66 3.69 15.8Z" />
        <path fill="#a5b4fc" d="M12 11 20.31 6.2V15.8L12 20.6Z" />
      </g>
    </svg>
  );
}
