import { hydrate, parsePane, parseUi, type PersistedPane } from './persist';
import { initialState, PANE_LIMIT, type PaneState } from './state';

/**
 * 카드 배치: named snapshots of the panes (order, widths, cards and their boxes, sessions — whatever persist.ts keeps for a
 * reload), in the same localStorage as the UI state but under one key for every session. Newest first, at most
 * MAX_LAYOUTS; a name saved again replaces its old entry. Read back as untrusted (each pane through persist's parser).
 */
export const LAYOUTS_KEY = 'deck.layouts.v1';
export const MAX_LAYOUTS = 12;
const MAX_NAME = 80;

export type SavedLayout = { name: string; savedAt: number; panes: PersistedPane[] };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The stored list, validated: bad entries dropped, a repeated name kept once (the first), at most MAX_LAYOUTS. */
export function readLayouts(raw: unknown): SavedLayout[] {
  let data = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw) as unknown; } catch { return []; } }
  if (!Array.isArray(data)) return [];
  const out: SavedLayout[] = [];
  for (const x of data) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const r = x as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > MAX_NAME || out.some((l) => l.name === name)) continue;
    if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt) || !Array.isArray(r.panes) || !r.panes.length) continue;
    out.push({ name, savedAt: r.savedAt, panes: r.panes.slice(0, PANE_LIMIT).map(parsePane) });
    if (out.length >= MAX_LAYOUTS) break;
  }
  return out;
}

export function listLayouts(store: Store | null = storage()): SavedLayout[] {
  try { return readLayouts(store?.getItem(LAYOUTS_KEY) ?? null); } catch { return []; }
}

/** False when the store refused it (quota full, private mode, no storage). */
function write(list: SavedLayout[], store: Store | null): boolean {
  if (!store) return false;
  try { store.setItem(LAYOUTS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/**
 * Saves (or replaces) `name` as the newest entry; the oldest beyond MAX_LAYOUTS go. Only the layout and the session
 * each pane shows are kept — a pane's one-off state (a turn in flight, a prefilled draft, a handoff note) is not.
 * Returns the list now stored, or null when it could not be stored (nothing changed then).
 */
export function saveLayout(name: string, panes: PersistedPane[], store: Store | null = storage(), now = Date.now()): SavedLayout[] | null {
  const key = name.trim().slice(0, MAX_NAME);
  if (!key || !panes.length) return listLayouts(store);
  const kept = panes.map(({ turnId: _t, prefill: _p, handoffFrom: _h, ...rest }) => rest);
  const list = [{ name: key, savedAt: now, panes: kept }, ...listLayouts(store).filter((l) => l.name !== key)].slice(0, MAX_LAYOUTS);
  return write(list, store) ? list : null;
}

export function deleteLayout(name: string, store: Store | null = storage()): SavedLayout[] {
  const list = listLayouts(store).filter((l) => l.name !== name);
  write(list, store);
  return listLayouts(store);
}

/**
 * A saved layout's panes as live panes, built exactly as a reload builds them (parseUi + hydrate: the same pane limit,
 * the first pane docked when every one is a card, sessions loading until their history comes). Ids from `p${firstId}`
 * on, so none collides with a pane on screen now. Null when nothing usable is in it.
 */
export function layoutPanes(panes: PersistedPane[], firstId: number): PaneState[] | null {
  const ui = parseUi({ v: 1, panes, active: 0, collapsed: [], drawer: false });
  if (!ui) return null;
  return hydrate(initialState, ui).panes.map((p, i) => ({ ...p, id: `p${firstId + i}` }));
}
