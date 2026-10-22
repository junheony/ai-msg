/**
 * A transcript stands an image block in for a line of text ("[이미지]", the server's textOfContent; Claude Code's own
 * "[Image #1]"; an English "[Image]"). Shown in the bubble they read as leftovers, so the bubble drops every line that is
 * only such placeholders and counts them: thumbnails stand for them, or one small "이미지 N장" pill when none were found.
 * Display only — copying and editing keep the message's text as it is.
 */
const TOKEN = /\[(?:이미지|image)(?:\s*#?\s*\d+)?\]/gi;
const ONLY_TOKENS = /^\s*(?:\[(?:이미지|image)(?:\s*#?\s*\d+)?\]\s*)+$/i;

export function stripImagePlaceholders(text: string): { text: string; images: number } {
  if (!text.includes('[')) return { text, images: 0 };
  let images = 0;
  const kept = text.split('\n').filter((line) => {
    if (!ONLY_TOKENS.test(line)) return true;
    images += line.match(TOKEN)?.length ?? 0;
    return false;
  });
  if (images === 0) return { text, images: 0 };
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), images };
}
