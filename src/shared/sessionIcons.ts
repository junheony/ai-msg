/**
 * A session's own avatar icon (직접 고르기): one of these emoji, or `glyph:<name>` for a line glyph of the sidebar's set
 * (SESSION_ICONS in ui/components/SessionIcon.tsx — its names must match SESSION_GLYPH_NAMES). Stored server-side
 * (session-icons.json), shared by every device; anything else is refused.
 */
export const SESSION_ICON_EMOJI = ['📈', '🐛', '🎨', '🧪', '🚀', '📝', '🔧', '💡', '🔒', '📦', '🌐', '🤖', '📊', '💰', '🧠', '⚡', '🔥', '⭐', '🎯', '📱', '🖥️', '🗂️', '🧹', '☕'] as const;

export const SESSION_GLYPH_NAMES = ['leaf', 'star', 'moon', 'sun', 'bolt', 'heart', 'cloud', 'drop', 'flame', 'anchor', 'bell', 'book', 'key', 'flag', 'music', 'camera', 'cup', 'compass', 'gem', 'fish', 'tree', 'umbrella', 'globe', 'eye', 'crown', 'hexagon', 'mountain', 'plane'] as const;

export const GLYPH_PREFIX = 'glyph:';

const ALLOWED = new Set<string>([...SESSION_ICON_EMOJI, ...SESSION_GLYPH_NAMES.map((n) => `${GLYPH_PREFIX}${n}`)]);

export function isSessionIconChoice(v: unknown): v is string {
  return typeof v === 'string' && ALLOWED.has(v);
}
