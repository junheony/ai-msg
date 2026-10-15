import { relPath } from './diff';
import { SIDE_MIN, type SideDoc } from './sidePanel';

/**
 * The side panel's open documents (one pane, one session). Display order is the array's; `used` orders them by last view
 * (the highest is the active tab, so closing it falls back to the one viewed before), `rev` changes on every open so
 * the document's view starts over (e.g. on the fresh diff of a file opened again from an edit).
 */
export type SideTab = { id: string; doc: SideDoc; used: number; rev: number };
export type SideTabs = { tabs: SideTab[]; seq: number };

export const NO_TABS: SideTabs = { tabs: [], seq: 0 };
/** Past this many, opening one closes the least recently viewed. */
export const MAX_SIDE_TABS = 12;

/** A file path as the session folder sees it: a reply's `src/a.ts`, `./src/a.ts` and a tool's `/w/src/a.ts` are one file. */
function samePath(p: string, cwd: string | undefined): string {
  return relPath(p, cwd).replace(/^(\.\/)+/, '');
}

/** The same document: one tab per file (paths compared under `cwd`), per HTML source, and a single 파일 열기. */
function sameDoc(a: SideDoc, b: SideDoc, cwd?: string): boolean {
  if (a.kind === 'file') return b.kind === 'file' && samePath(a.path, cwd) === samePath(b.path, cwd);
  if (a.kind === 'html') return b.kind === 'html' && a.html === b.html;
  return b.kind === 'pick';
}

export function activeTab(s: SideTabs): SideTab | null {
  let best: SideTab | null = null;
  for (const t of s.tabs) if (!best || t.used > best.used) best = t;
  return best;
}

/**
 * Open `doc` as the active tab: an open one is activated instead (a file takes the new diffs). `replace` (the 파일 열기
 * tab a file was picked from) gives the new tab its place, or goes away when the file was already open.
 */
export function openTab(s: SideTabs, doc: SideDoc, { replace: replaceId, cwd, max = MAX_SIDE_TABS }: { replace?: string; cwd?: string; max?: number } = {}): SideTabs {
  const seq = s.seq + 1;
  const same = s.tabs.find((t) => sameDoc(t.doc, doc, cwd));
  if (same) {
    const tabs = s.tabs.map((t) => (t === same ? { ...t, doc, used: seq, rev: seq } : t));
    return { tabs: replaceId && replaceId !== same.id ? tabs.filter((t) => t.id !== replaceId) : tabs, seq };
  }
  const tab: SideTab = { id: `t${seq}`, doc, used: seq, rev: seq };
  let tabs = replaceId && s.tabs.some((t) => t.id === replaceId) ? s.tabs.map((t) => (t.id === replaceId ? tab : t)) : [...s.tabs, tab];
  while (tabs.length > max) {
    let old = tabs[0]!;
    for (const t of tabs) if (t.used < old.used) old = t;
    tabs = tabs.filter((t) => t !== old);
  }
  return { tabs, seq };
}

export function selectTab(s: SideTabs, id: string): SideTabs {
  if (activeTab(s)?.id === id || !s.tabs.some((t) => t.id === id)) return s;
  const seq = s.seq + 1;
  return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, used: seq } : t)), seq };
}

/** Closing the active tab makes the previously viewed one active (by `used`); the last one leaves no tabs. */
export function closeTab(s: SideTabs, id: string): SideTabs {
  return { tabs: s.tabs.filter((t) => t.id !== id), seq: s.seq };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * Per-session memory: every tab in this Map (for coming back to a session in this page), file tabs also in localStorage
 * (for a reload; HTML is too big to keep, diffs are dropped). Both keep the MAX_SESSIONS most recently changed sessions.
 */
export const SIDE_TABS_KEY = 'deck.sideTabs.v1';
const MAX_SESSIONS = 30;
const memory = new Map<string, SideTabs>();
type Stored = Record<string, { files: string[]; active: number; at: number }>;

/** Only entries with a files array survive (storage is untrusted). */
function readStored(store: Store | null): Stored {
  try {
    const data = JSON.parse(store?.getItem(SIDE_TABS_KEY) ?? 'null') as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || !Array.isArray((v as Stored[string]).files)) continue;
      const e = v as Stored[string];
      out[k] = { files: e.files, active: typeof e.active === 'number' ? e.active : -1, at: typeof e.at === 'number' ? e.at : 0 };
    }
    return out;
  } catch { return {}; }
}

/**
 * Sessions worth remembering: `key` is `sessionId\ncwd`, so '' (no session) and `\ncwd` (a new chat before its first
 * message: every new chat in that folder would share it) are not; such a chat's tabs move over with carriesTabs.
 */
function remembered(key: string): boolean {
  return key !== '' && !key.startsWith('\n');
}

/** A new chat just got its session id (same folder): its tabs go with it instead of closing. */
export function carriesTabs(from: string, to: string): boolean {
  return from.startsWith('\n') && remembered(to) && to.endsWith(from);
}

/** The session's remembered tabs (none for a key that is not remembered). */
export function recallSideTabs(key: string, store: Store | null = storage()): SideTabs {
  if (!remembered(key)) return NO_TABS;
  const kept = memory.get(key);
  if (kept) return kept;
  const e = readStored(store)[key];
  if (!e) return NO_TABS;
  const files = e.files.filter((f): f is string => typeof f === 'string' && f !== '').slice(0, MAX_SIDE_TABS);
  const tabs = files.map((path, i): SideTab => ({ id: `t${i + 1}`, doc: { kind: 'file', path }, used: i + 1, rev: 0 }));
  const on = tabs[e.active];
  if (on) on.used = tabs.length + 1;
  return { tabs, seq: tabs.length + 1 };
}

export function rememberSideTabs(key: string, s: SideTabs, store: Store | null = storage(), now = Date.now()): void {
  if (!remembered(key)) return;
  memory.delete(key);
  memory.set(key, s);
  for (const k of memory.keys()) { if (memory.size <= MAX_SESSIONS) break; memory.delete(k); }
  try { storeFiles(key, s, store, now); } catch { /* full / private mode / odd data: memory only */ }
}

function storeFiles(key: string, s: SideTabs, store: Store | null, now: number): void {
  const files = s.tabs.filter((t) => t.doc.kind === 'file');
  const stored = readStored(store);
  if (!files.length && !(key in stored)) return;
  if (files.length) {
    const on = activeTab(s);
    stored[key] = { files: files.map((t) => (t.doc as { path: string }).path), active: files.findIndex((t) => t === on), at: now };
  } else delete stored[key];
  const keys = Object.keys(stored).sort((a, b) => stored[b]!.at - stored[a]!.at);
  for (const k of keys.slice(MAX_SESSIONS)) delete stored[k];
  if (Object.keys(stored).length) store?.setItem(SIDE_TABS_KEY, JSON.stringify(stored));
  else store?.removeItem(SIDE_TABS_KEY);
}

/** Tests: forget the in-page memory. */
export function forgetSideTabs(): void { memory.clear(); }

/** The side panel's width survives a reload and a session switch (clamped to the pane when shown). */
export const SIDE_WIDTH_KEY = 'deck.sideWidth.v1';
export const SIDE_WIDTH_DEFAULT = 440;

export function readSideWidth(store: Store | null = storage()): number {
  try {
    const n = Number(store?.getItem(SIDE_WIDTH_KEY) ?? NaN);
    return Number.isFinite(n) && n >= SIDE_MIN ? Math.round(n) : SIDE_WIDTH_DEFAULT;
  } catch { return SIDE_WIDTH_DEFAULT; }
}

export function saveSideWidth(w: number, store: Store | null = storage()): void {
  try { store?.setItem(SIDE_WIDTH_KEY, String(Math.round(w))); } catch { /* private mode: just won't persist */ }
}

/** Past either limit a text file is shown plain: highlighting would stall the page (2 MB files are allowed). */
export const HIGHLIGHT_MAX_CHARS = 200_000;
export const HIGHLIGHT_MAX_LINES = 5000;

export function canHighlight(text: string): boolean {
  if (text.length > HIGHLIGHT_MAX_CHARS) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (++lines > HIGHLIGHT_MAX_LINES) return false;
  return true;
}

/** Extensions highlight.js has no alias for, mapped onto a grammar it has; the rest go through as aliases. */
const LANG_OF: Record<string, string> = {
  jsonl: 'json', mdx: 'markdown', htm: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml',
  env: 'bash', fish: 'bash', cfg: 'ini', conf: 'ini', exs: 'elixir', gradle: 'groovy', tf: 'ini',
};

/** The highlight.js language (or alias) for a file, or null for plain text; unknown names are checked when highlighting. */
export function langFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === 'dockerfile') return 'dockerfile';
  const ext = /\.([a-z0-9+]+)$/.exec(name)?.[1];
  if (!ext || ext === 'txt' || ext === 'text' || ext === 'log') return null;
  return Object.hasOwn(LANG_OF, ext) ? LANG_OF[ext]! : ext;
}
