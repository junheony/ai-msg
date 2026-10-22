import type { Locale } from '../../shared/locale';

// The reply-language note (i18n): rides each turn's system prompt with deck's other notes (deckAddendum), never the transcript.

/** Each language's English name and its own name (the model sees both). */
const NAMES: Record<Exclude<Locale, 'en'>, { en: string; own: string }> = { ko: { en: 'Korean', own: '한국어' } };

/**
 * Which language a turn's replies come in: the connecting device decides (send.lang — its explicit pick or its
 * browser's); a turn without a device (총사령탑, retries) keeps the session's last (SessionState.lang); settings
 * `language` is only the fallback for neither. None = no note.
 */
export function turnLanguage(o: { device?: Locale; session?: Locale; server?: Locale | null }): Locale | undefined {
  return o.device ?? o.session ?? o.server ?? undefined;
}

/**
 * The note for `lang`; null for English and for none. English needs no note: models answer in English (or in the
 * language the user writes) already, and an English note would force English on someone writing Korean from an
 * English browser. `questionTool`: the engine asks decisions with AskUserQuestion (Claude, not a 백그라운드 작업 turn);
 * other engines offer deck-choices options instead.
 */
export function languageDirective(lang: Locale | null | undefined, opts: { questionTool?: boolean } = {}): string | null {
  if (!lang || lang === 'en') return null;
  const n = NAMES[lang];
  return [
    `[deck language] Respond to the user in ${n.en} (${n.own}).`,
    opts.questionTool ? `Write AskUserQuestion questions, headers, options and descriptions in ${n.en} too.` : `Write any choice options in ${n.en} too.`,
    'Keep code, commands and identifiers as-is.',
  ].join(' ');
}
