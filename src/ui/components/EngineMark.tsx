import { isGeminiAccount, isGrokAccount, type Seat } from '../../shared/accounts';
import type { EngineKind } from '../../shared/models';

/** OpenAI blossom, drawn in currentColor (CSP: inline only, no external assets). */
export function OpenAIMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .511 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.041l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

const CLAUDE_RAYS = Array.from({ length: 12 }, (_, i) => ({ angle: i * 30, len: i % 2 ? 8.2 : 10.4 }));

/**
 * Claude's multi-ray star as inline SVG in #D97757. A text ✳ (U+2733) is drawn as a green emoji on many systems, so the
 * mark is never a glyph. Same box as OpenAIMark (24-unit viewBox, sized by its class / 1em).
 */
export function ClaudeMark({ className }: { className: string }) {
  return (
    <svg className={`claude-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g stroke="#D97757" strokeWidth="2.3" strokeLinecap="round">
        {CLAUDE_RAYS.map(({ angle, len }) => <line key={angle} x1="12" y1="10.6" x2="12" y2={12 - len} transform={`rotate(${angle} 12 12)`} />)}
      </g>
    </svg>
  );
}

/** Gemini's four-point spark, drawn in currentColor (the usage card colours it Gemini blue). Same 24-unit box as the others. */
export function GeminiMark({ className }: { className: string }) {
  return (
    <svg className={`gemini-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M12 1.5c.4 5.7 4.8 10.1 10.5 10.5-5.7.4-10.1 4.8-10.5 10.5C11.6 16.8 7.2 12.4 1.5 12 7.2 11.6 11.6 7.2 12 1.5z" />
    </svg>
  );
}

/** Grok's slashed mark (a stroke through a ring), drawn in currentColor. Same 24-unit box as the others. */
export function GrokMark({ className }: { className: string }) {
  return (
    <svg className={`grok-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M17.5 6.2A8 8 0 1 0 19.6 15" />
        <line x1="5" y1="20" x2="20.5" y2="3.5" />
      </g>
    </svg>
  );
}

/** Which engine a session runs on: its own field, else what its seat implies. */
export function engineOf(s: { engine?: EngineKind | null; account?: Seat }): EngineKind {
  return s.engine ?? (s.account === 'gpt' ? 'codex' : isGeminiAccount(s.account) ? 'gemini' : isGrokAccount(s.account) ? 'grok' : 'claude');
}

/**
 * The engine mark before a session's title (the usage cards' marks): the Claude star, the OpenAI blossom for Codex, the
 * Grok mark. No text content (all SVG), so the title's text and truncation stay as they were. Gemini (or anything
 * else) has no mark. `decorative`: dense lists whose row already says what it is — hidden from assistive tech, tooltip kept.
 */
export function EngineMark({ engine, decorative = false }: { engine: EngineKind; decorative?: boolean }) {
  if (engine !== 'codex' && engine !== 'claude' && engine !== 'grok') return null;
  const label = engine === 'codex' ? 'Codex (GPT)' : engine === 'grok' ? 'Grok' : 'Claude';
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <span className={`engine-mark ${engine}`} title={label} {...a11y}>
      {engine === 'codex' ? <OpenAIMark className="engine-mark-svg" /> : engine === 'grok' ? <GrokMark className="engine-mark-svg" /> : <ClaudeMark className="engine-mark-svg" />}
    </span>
  );
}
