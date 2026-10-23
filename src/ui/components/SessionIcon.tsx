import { useSyncExternalStore, type ReactNode } from 'react';
import { GLYPH_PREFIX } from '../../shared/sessionIcons';

/**
 * Line glyphs a session's avatar can wear (직접 고르기, `glyph:<name>`): single-weight line icons on a 24px grid
 * (currentColor stroke). Silhouettes are kept apart on purpose (no two near-identical drops / triangles): at 20px the
 * outline is all that reads. The names are the server's allow-list (shared/sessionIcons SESSION_GLYPH_NAMES).
 */
export const SESSION_ICONS: { name: string; body: ReactNode }[] = [
  { name: 'leaf', body: <><path d="M5 19C5 11 10 5 19 5c0 9-6 14-14 14z" /><path d="M5 19l8-8" /></> },
  { name: 'star', body: <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" /> },
  { name: 'moon', body: <path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" /> },
  { name: 'sun', body: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  { name: 'bolt', body: <path d="M13 2L4 14h7l-1 8 9-12h-7z" /> },
  { name: 'heart', body: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" /> },
  { name: 'cloud', body: <path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-.5 8.5z" /> },
  { name: 'drop', body: <path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z" /> },
  { name: 'flame', body: <path d="M12 22a7 7 0 0 0 7-7c0-4-3-6.5-4-10-2 2-3 3.5-3 6-1.5-1-2.5-2.5-2.5-4C7 9 5 11.5 5 15a7 7 0 0 0 7 7z" /> },
  { name: 'anchor', body: <><circle cx="12" cy="5" r="2" /><path d="M12 7v14M4 13a8 8 0 0 0 16 0M8 10h8" /></> },
  { name: 'bell', body: <><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></> },
  { name: 'book', body: <><path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z" /><path d="M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z" /></> },
  { name: 'key', body: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></> },
  { name: 'flag', body: <><path d="M5 21V4" /><path d="M5 4h12l-2 4 2 4H5" /></> },
  { name: 'music', body: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></> },
  { name: 'camera', body: <><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></> },
  { name: 'cup', body: <><path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3" /></> },
  { name: 'compass', body: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></> },
  { name: 'gem', body: <><path d="M6 3h12l4 6-10 12L2 9z" /><path d="M2 9h20" /></> },
  { name: 'fish', body: <><path d="M3 12c3-5 9-6 13-2l5-3v10l-5-3c-4 4-10 3-13-2z" /><path d="M8.5 11.5h.01" /></> },
  { name: 'tree', body: <><path d="M12 2l6 8h-3l4 6H5l4-6H6z" /><path d="M12 16v6" /></> },
  { name: 'umbrella', body: <><path d="M2 12a10 10 0 0 1 20 0z" /><path d="M12 12v7a2 2 0 0 0 4 0" /></> },
  { name: 'globe', body: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" /></> },
  { name: 'eye', body: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></> },
  { name: 'crown', body: <path d="M3 18L2 7l6 4 4-7 4 7 6-4-1 11z" /> },
  { name: 'hexagon', body: <path d="M12 2l8.7 5v10L12 22l-8.7-5V7z" /> },
  { name: 'mountain', body: <path d="M2 20L9 7l4 7 2-3 7 9z" /> },
  { name: 'plane', body: <><path d="M22 2L2 10l8 3 3 8z" /><path d="M22 2L10 13" /></> },
];

/** A bracketed tag up front ("[WIP] ", "(초안) ", "【公告】"): skipped, unless nothing usable is left after it. */
const BRACKET_PREFIX = /^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|<[^>]*>|「[^」]*」|『[^』]*』|〔[^〕]*〕)\s*/u;
const USABLE = /^[\p{L}\p{N}]/u;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Whole graphemes (an emoji with its joiners and modifiers is one), so a skipped emoji never leaves half of itself. */
function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** The first `n` letters / digits of `s` (each one code point: a grapheme's base), skipping emoji, punctuation and space. */
function usable(s: string, n: number): string[] {
  const out: string[] = [];
  for (const g of graphemes(s)) {
    if (!USABLE.test(g)) continue;
    out.push(Array.from(g)[0]!);
    if (out.length >= n) break;
  }
  return out;
}

/** Case change only when it stays one character ('ß' → 'SS' does not). */
const recase = (c: string, up: boolean) => { const r = up ? c.toUpperCase() : c.toLowerCase(); return Array.from(r).length === 1 ? r : c; };

/**
 * The avatar's letters for a session: the title's first usable character (a Hangul syllable, a letter — Latin upper-cased —
 * or a digit), or with `len` 2 its first two ("백테", "Fx"). Leading emoji, punctuation and bracket tags are skipped; a title
 * with nothing usable falls back to the project name, then "·".
 */
export function monogram(title: string, project = '', len: 1 | 2 = 1): string {
  const pick = (s: string) => {
    const t = s.normalize('NFC');
    let rest = t;
    for (let m = BRACKET_PREFIX.exec(rest); m && m[0].length; m = BRACKET_PREFIX.exec(rest)) rest = rest.slice(m[0].length);
    const got = usable(rest, len);
    return got.length ? got : usable(t, len);
  };
  let chars = pick(title);
  if (!chars.length) chars = pick(project);
  if (!chars.length) return '·';
  return chars.map((c, i) => recase(c, i === 0)).join('');
}

export type MonoRow = { id: string; project: string; title: string };

/**
 * The avatar letters of every listed session: one letter, or two (the title's first two usable characters) when any other listed row of the same project — pinned or not — would
 * show the same letter. Only the set of rows matters, never their order: a re-sort or a new session changes only the
 * rows whose letter it shares.
 * Different projects may share a letter: the colour tells them apart.
 */
export function assignMonograms(pinned: MonoRow[], rest: MonoRow[]): Map<string, string> {
  const rows = new Map<string, MonoRow>();
  for (const r of [...pinned, ...rest]) if (!rows.has(r.id)) rows.set(r.id, r);
  const keyOf = (r: MonoRow) => `${r.project}\u0000${monogram(r.title, r.project)}`;
  const count = new Map<string, number>();
  for (const r of rows.values()) count.set(keyOf(r), (count.get(keyOf(r)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const r of rows.values()) out.set(r.id, monogram(r.title, r.project, (count.get(keyOf(r)) ?? 0) > 1 ? 2 : 1));
  return out;
}

/** A line glyph by name (SESSION_ICONS); decorative. Null for a name the set does not have. */
export function SessionGlyph({ name }: { name: string }) {
  const icon = SESSION_ICONS.find((x) => x.name === name);
  if (!icon) return null;
  return (
    <svg className="row-avatar-icon" data-icon={icon.name} viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icon.body}
    </svg>
  );
}

/** The emoji a title opens with ("🚀 launch" → "🚀", a flag or a joined emoji whole), else null. */
export function leadingEmoji(title: string): string | null {
  const first = graphemes(title.trimStart())[0];
  return first && (/^\p{Extended_Pictographic}/u.test(first) || /^\p{Regional_Indicator}{2}/u.test(first)) ? first : null;
}

/**
 * What sits on the avatar's colour: the icon the user chose (an emoji, or `glyph:<name>`), else the emoji the title opens
 * with, else the letters. Decorative — the row's title names the session.
 */
export function AvatarFace({ mono, icon, title }: { mono: string; icon?: string | null; title?: string }) {
  if (!icon && title) { const e = leadingEmoji(title); if (e) icon = e; }
  const glyph = icon?.startsWith(GLYPH_PREFIX) ? icon.slice(GLYPH_PREFIX.length) : null;
  if (glyph && SESSION_ICONS.some((x) => x.name === glyph)) return <SessionGlyph name={glyph} />;
  if (icon && glyph === null) return <span className="avatar-emoji" data-testid="avatar-emoji" aria-hidden="true">{icon}</span>;
  return <span className="avatar-mono" data-testid="avatar-mono" data-len={Array.from(mono).length > 1 ? 2 : 1} aria-hidden="true">{mono}</span>;
}

/** Project avatar palette size (`--avatar-1` … `--avatar-8` in styles.css). */
export const AVATAR_COLORS = 8;

/** A project's avatar colour, 1 … AVATAR_COLORS: an FNV-1a hash of its slug, so a project keeps its colour everywhere. */
export function avatarIndex(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) { h ^= slug.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % AVATAR_COLORS) + 1;
}

/**
 * A session's avatar as the sidebar draws it: project colour (1 … AVATAR_COLORS), its letters, the icon the user chose
 * (null = the letters show) and the id that icon is stored under (a 갈래 tree's row: its root, for every member).
 */
export type SessionAvatar = { color: number; mono: string; icon: string | null; iconId: string };

type AvatarStore = {
  avatars: Map<string, SessionAvatar>;
  /** Every chosen icon (session id → icon), for a head whose session the sidebar has not listed. */
  icons: Record<string, string>;
  /** Changes a session's icon (null = back to the letters); absent = no picker. */
  setIcon: ((sessionId: string, icon: string | null) => void) | null;
};

// The sidebar's last assignment, shared so the session head shows the very avatar its row shows (a clash in the list
// can give a row two letters — the head cannot recompute that on its own).
let store: AvatarStore = { avatars: new Map(), icons: {}, setIcon: null };
const avatarSubs = new Set<() => void>();
// One stable subscribe for every head: a fresh closure per render would make React re-subscribe on each render.
const subscribeAvatars = (f: () => void) => { avatarSubs.add(f); return () => { avatarSubs.delete(f); }; };

const sameAvatar = (a: SessionAvatar, b: SessionAvatar | undefined) => !!b && b.color === a.color && b.mono === a.mono && b.icon === a.icon && b.iconId === a.iconId;

/** Called by the sidebar after it assigns its avatars; a no-op when nothing changed (no re-render of the heads). */
export function publishSessionAvatars(next: Map<string, SessionAvatar>, icons: Record<string, string> = store.icons, setIcon: AvatarStore['setIcon'] = store.setIcon): void {
  const same = next.size === store.avatars.size && [...next].every(([id, a]) => sameAvatar(a, store.avatars.get(id)));
  if (same && icons === store.icons && setIcon === store.setIcon) return;
  store = { avatars: same ? store.avatars : next, icons, setIcon };
  for (const f of avatarSubs) f();
}

/** The avatar the sidebar gave `sessionId`, or null when the sidebar has not listed it (the caller falls back). */
export function useSessionAvatar(sessionId: string | null | undefined): SessionAvatar | null {
  return useSyncExternalStore(
    subscribeAvatars,
    () => (sessionId ? store.avatars.get(sessionId) ?? null : null),
  );
}

/** The chosen icons and the setter the sidebar published (the head's fallback and its picker). */
export function useSessionIconStore(): Pick<AvatarStore, 'icons' | 'setIcon'> {
  const icons = useSyncExternalStore(subscribeAvatars, () => store.icons);
  const setIcon = useSyncExternalStore(subscribeAvatars, () => store.setIcon);
  return { icons, setIcon };
}
