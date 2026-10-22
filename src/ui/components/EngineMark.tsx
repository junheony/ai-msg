import { isGeminiAccount, isGrokAccount, type Seat } from '../../shared/accounts';
import type { EngineKind } from '../../shared/models';

/**
 * Engine badges: our own letter badges, not the vendors' logos (their marks are trademarks — AI-MSG draws none). One
 * shape for every engine (a rounded square), a letter or two, a colour from our palette (`--engine-*`). The letter is
 * CSS-drawn (`content: attr(data-letter)`), so a badge adds no text to the title it sits in; the name goes to the
 * tooltip / aria-label, or as plain text next to it where there is room (`EngineName`).
 */
export const ENGINE_BADGE: Record<EngineKind, { letter: string; name: string }> = {
  claude: { letter: 'C', name: 'Claude' },
  codex: { letter: 'G', name: 'Codex (GPT)' },
  gemini: { letter: 'Gm', name: 'Gemini' },
  grok: { letter: 'X', name: 'Grok' },
};

/** The badge itself (decorative: the caller names the engine). `className` sizes / places it. */
export function EngineBadge({ engine, className = '' }: { engine: EngineKind; className?: string }) {
  const b = ENGINE_BADGE[engine] ?? ENGINE_BADGE.claude;
  return <span className={`engine-badge ${engine}${b.letter.length > 1 ? ' wide' : ''} ${className}`.trim()} data-letter={b.letter} aria-hidden="true" />;
}

/** The engine's name as plain text (the badge's companion where the row has room). */
export function engineName(engine: EngineKind): string {
  return (ENGINE_BADGE[engine] ?? ENGINE_BADGE.claude).name;
}

/** Which engine a session runs on: its own field, else what its seat implies. */
export function engineOf(s: { engine?: EngineKind | null; account?: Seat }): EngineKind {
  return s.engine ?? (s.account === 'gpt' ? 'codex' : isGeminiAccount(s.account) ? 'gemini' : isGrokAccount(s.account) ? 'grok' : 'claude');
}

/**
 * The engine badge before a session's title (search hits, palette, highlights, new-chat cards) or after it (the session
 * head). No text content (the letter is CSS), so the title's text and truncation stay as they were. `decorative`: dense
 * lists whose row already says what it is — hidden from assistive tech, tooltip kept. `named`: the engine's name follows
 * as small plain text.
 */
export function EngineMark({ engine, decorative = false, named = false }: { engine: EngineKind; decorative?: boolean; named?: boolean }) {
  if (!(engine in ENGINE_BADGE)) return null;
  const label = engineName(engine);
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <>
      <span className={`engine-mark ${engine}`} title={label} {...a11y}><EngineBadge engine={engine} className="engine-mark-badge" /></span>
      {named && <span className="engine-name" aria-hidden="true">{label}</span>}
    </>
  );
}
