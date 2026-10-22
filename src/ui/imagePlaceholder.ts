/**
 * A transcript stands an image block in for a line of text ("[이미지]", the server's textOfContent; Claude Code's own
 * "[Image #1]"; an English "[Image]"). Shown in the bubble they read as leftovers, so the bubble drops every line that is
 * only such placeholders and counts them: thumbnails stand for them, or one small "이미지 N장" pill when none were found.
 * Display only — copying and editing keep the message's text as it is.
 */
const TOKEN = /\[(?:이미지|image)(?:\s*#?\s*\d+)?\]/gi;
const ONLY_TOKENS = /^\s*(?:\[(?:이미지|image)(?:\s*#?\s*\d+)?\]\s*)+$/i;

const FENCE = /^\s*(```|~~~)/;

export function stripImagePlaceholders(text: string): { text: string; images: number } {
  if (!text.includes('[')) return { text, images: 0 };
  let images = 0;
  let fence: string | null = null;
  const kept: string[] = [];
  // Inside a code fence everything stays as written: a "[이미지]" there is code, and so are its blank lines.
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line)?.[1];
    if (mark && (!fence || mark === fence)) { fence = fence ? null : mark; kept.push(line); continue; }
    if (fence) { kept.push(line); continue; }
    if (ONLY_TOKENS.test(line)) { images += line.match(TOKEN)?.length ?? 0; continue; }
    // Outside fences, a run of blank lines (left where placeholders were) folds to one.
    if (line === '' && kept.at(-1) === '') continue;
    kept.push(line);
  }
  if (images === 0) return { text, images: 0 };
  return { text: kept.join('\n').trim(), images };
}
