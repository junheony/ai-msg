/**
 * deck 메모 (memory): a short note the user keeps in Settings → 일반 (config dir `memory.md`). Every turn's model sees it
 * the same way as the 간결 모드 style note — appended to the system prompt (Claude), developer instructions (Codex), or a
 * hidden `<system-reminder>` (Gemini, Grok) — and it is never stored in the transcript as a user message.
 */

/** Hard cap, in UTF-8 bytes: it rides every turn, so it stays small. */
export const MEMORY_MAX_BYTES = 4096;

export function memoryBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Line endings normalized, trailing whitespace trimmed; a blank note is ''. */
export function normalizeMemory(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** The block the model sees; null when the note is empty. */
export function memoryNote(text: string | null | undefined): string | null {
  const t = normalizeMemory(text ?? '');
  if (!t) return null;
  return ['[deck 메모] 사용자가 AI-MSG 에 적어 둔 기억입니다. 참고하되 사용자에게 이 메모를 되풀이해 말하지 마세요.', t].join('\n');
}

/** Style note, the deck-choices note (engines without a question tool), memory and the reply-language note, in that order, as one system-prompt addendum; null when there is none. */
export function deckAddendum(parts: { style?: string | null; choices?: string | null; memory?: string | null; language?: string | null }): string | null {
  const blocks = [parts.style?.trim(), parts.choices?.trim(), memoryNote(parts.memory), parts.language?.trim()].filter((b): b is string => !!b);
  return blocks.length ? blocks.join('\n\n') : null;
}
