import type { ReactNode } from 'react';

/**
 * Session glyphs for the sidebar avatar: single-weight line icons on a 24px grid (currentColor stroke), chosen per
 * session so a dozen rows of one project — one colour — still tell apart. Silhouettes are kept apart on purpose (no two
 * near-identical drops / triangles): at 20px the outline is all that reads.
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

/** FNV-1a of the session id: the glyph a session starts from, the same on every device and every render. */
export function sessionIconBase(sessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) { h ^= sessionId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  // A final mix: ids sharing a prefix (uuids rarely, test ids often) still spread over the set.
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) % SESSION_ICONS.length;
}

export type IconRow = { id: string; project: string };

/**
 * The glyph of every listed session (index into SESSION_ICONS). Stability first, then telling apart:
 * - every session starts from its id hash, so most keep one glyph for good;
 * - `pinned` (a stable set, the ⌘1 … ⌘9 rows): no two of one project share a glyph — clashes step to the next free one,
 *   settled in id order, so only a pin change can move one (and only along that clash);
 * - `rest`, in the order shown: steps past the glyphs its project's pinned rows hold, and past the row right above when
 *   that row is the same project with the same glyph. Nothing else in the list moves it: a new session or a re-sort
 *   only matters to a row whose neighbour clashes.
 * Different projects may share a glyph: the colour already tells them apart. Past SESSION_ICONS.length pinned rows of one
 * project the glyphs come round again.
 */
export function assignSessionIcons(pinned: IconRow[], rest: IconRow[]): Map<string, number> {
  const n = SESSION_ICONS.length;
  const out = new Map<string, number>();
  const held = new Map<string, Set<number>>();
  for (const r of [...pinned].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (out.has(r.id)) continue;
    let used = held.get(r.project);
    if (!used) held.set(r.project, (used = new Set()));
    if (used.size >= n) used.clear();
    let i = sessionIconBase(r.id);
    while (used.has(i)) i = (i + 1) % n;
    used.add(i);
    out.set(r.id, i);
  }
  let prev: { project: string; icon: number } | null = null;
  for (const r of rest) {
    let i = out.get(r.id);
    if (i === undefined) {
      const used = held.get(r.project);
      const avoid = (k: number) => (!!used && used.size < n && used.has(k)) || (prev?.project === r.project && prev.icon === k);
      i = sessionIconBase(r.id);
      for (let step = 0; step < n && avoid(i); step++) i = (i + 1) % n;
      out.set(r.id, i);
    }
    prev = { project: r.project, icon: i };
  }
  return out;
}

/** The glyph itself: decorative (the row's text names the session and project). */
export function SessionGlyph({ index }: { index: number }) {
  const icon = SESSION_ICONS[index % SESSION_ICONS.length]!;
  return (
    <svg className="row-avatar-icon" data-icon={icon.name} viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icon.body}
    </svg>
  );
}
