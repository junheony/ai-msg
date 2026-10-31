/**
 * The sidebar/chip title a prompt earns: its first meaningful line, ≤ 80 chars. A slash command (`/status`, `/review
 * src`) is never the title — the command's argument or the next real line is, and a prompt that is only a command has
 * no title (callers fall back to '(제목 없음)' or the engine's own summary later).
 */
const SLASH_RE = /^\/[A-Za-z0-9_:.-]+(?:\s+(.*))?$/;

export const TITLE_MAX = 80;

export function promptTitle(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines) {
    const m = SLASH_RE.exec(line);
    if (!m) return cut(line);
    const arg = m[1]?.trim();
    if (arg && arg.length >= 3 && !arg.startsWith('/')) return cut(arg);
  }
  return null;
}

const cut = (s: string): string => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX) : s);
