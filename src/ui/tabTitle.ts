export const APP_TITLE = 'AI-MSG';

/**
 * The browser tab / PWA window title: the focused chat's title (Desktop shows it in the window bar), after the
 * status mark — ● while any turn runs, ✓ when one finished while the tab was hidden.
 *
 * `installed`: the page runs as an installed app (display-mode: standalone). Chrome then puts the app's own name in
 * front of the window title by itself ("AI-MSG - …", the name it took from the manifest at install time) unless the
 * title already starts with it, so the " — AI-MSG" suffix is left off there: "● 버그 고치기", not
 * "AI-MSG - ● 버그 고치기 — AI-MSG". Without a chat the title is the bare app name, which Chrome shows as it is — or, with a mark, the mark alone.
 */
export function tabTitle(mark: '●' | '✓' | null, chat: string | null | undefined, installed = false): string {
  const name = chat?.trim();
  // Installed with no chat but a mark: the mark alone ("AI-MSG - ✓"), not the name twice ("AI-MSG - ✓ AI-MSG").
  if (installed && !name && mark) return mark;
  const base = name ? (installed ? name : `${name} — ${APP_TITLE}`) : APP_TITLE;
  return mark ? `${mark} ${base}` : base;
}
