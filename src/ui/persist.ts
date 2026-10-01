import { CODEX_SANDBOXES, DEFAULT_EFFORT, isClaudeModel, isCodexModel, isEffort, isGeminiModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../shared/models';
import { MAX_PANES, newPane, type AppState, type ChatItem, type PaneState, type SentFile, type SentRecord } from './state';

/**
 * ux-state: UI state that survives a reload (localStorage, per browser — phone and desktop are independent).
 * Everything read back is untrusted: each field is validated on its own and a bad one falls back to its
 * default, so one corrupt value never costs the rest (and never throws).
 */
export const UI_KEY = 'deck.ui.v1';
export const SENT_KEY = 'deck.sent.v1';

export type PersistedSession = { sessionId: string | null; cwd: string; title: string; engine: EngineKind | null };
/** `autoEffort`: the effort picked while the model is 자동 (null = 자동 too). */
export type PersistedPane = { session: PersistedSession | null; model: ModelChoice; efforts: Record<EngineKind, Effort>; autoEffort: Effort | null; engine: EngineChoice; sandbox: CodexSandbox };
export type PersistedUi = { v: 1; panes: PersistedPane[]; active: number; collapsed: string[]; drawer: boolean };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const shortStr = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
const ENGINES: readonly EngineChoice[] = ['claude', 'codex', 'gemini', 'auto'];
const isModelChoice = (x: unknown): x is ModelChoice => x === 'auto' || isClaudeModel(x) || isCodexModel(x) || isGeminiModel(x);

function readJson(key: string, store: Store | null): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, store: Store | null): void {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode: persistence is best-effort */ }
}

function session(x: unknown): PersistedSession | null {
  if (!isObj(x) || !shortStr(x.cwd, 4096) || !x.cwd.startsWith('/')) return null;
  const sessionId = x.sessionId === null ? null : shortStr(x.sessionId, 200) && x.sessionId ? x.sessionId : undefined;
  if (sessionId === undefined) return null;
  const title = shortStr(x.title, 500) ? x.title : (sessionId?.slice(0, 8) ?? '새 세션');
  const engine = x.engine === 'claude' || x.engine === 'codex' || x.engine === 'gemini' ? x.engine : null;
  return { sessionId, cwd: x.cwd, title, engine };
}

function pane(x: unknown): PersistedPane {
  const d = newPane('');
  if (!isObj(x)) return { session: null, model: d.model, efforts: { ...DEFAULT_EFFORT }, autoEffort: null, engine: d.engine, sandbox: d.sandbox };
  const e = isObj(x.efforts) ? x.efforts : {};
  return {
    session: session(x.session),
    model: isModelChoice(x.model) ? x.model : d.model,
    efforts: { claude: isEffort(e.claude) ? e.claude : DEFAULT_EFFORT.claude, codex: isEffort(e.codex) ? e.codex : DEFAULT_EFFORT.codex, gemini: isEffort(e.gemini) ? e.gemini : DEFAULT_EFFORT.gemini },
    autoEffort: isEffort(x.autoEffort) ? x.autoEffort : null,
    engine: ENGINES.includes(x.engine as EngineChoice) ? (x.engine as EngineChoice) : d.engine,
    sandbox: CODEX_SANDBOXES.includes(x.sandbox as CodexSandbox) ? (x.sandbox as CodexSandbox) : d.sandbox,
  };
}

/** Validates (and migrates) whatever is stored; null = nothing usable, start fresh. */
export function parseUi(raw: unknown): PersistedUi | null {
  if (!isObj(raw)) return null;
  // Only v1 exists; an unknown version is dropped rather than guessed at.
  if (raw.v !== 1) return null;
  const panes = Array.isArray(raw.panes) ? raw.panes.slice(0, MAX_PANES).map(pane) : [];
  if (!panes.length) return null;
  const active = Number.isInteger(raw.active) && (raw.active as number) >= 0 && (raw.active as number) < panes.length ? (raw.active as number) : 0;
  const collapsed = Array.isArray(raw.collapsed) ? raw.collapsed.filter((c): c is string => shortStr(c, 4096)).slice(0, 200) : [];
  return { v: 1, panes, active, collapsed, drawer: raw.drawer === true };
}

export function loadUi(store: Store | null = storage()): PersistedUi | null {
  return parseUi(readJson(UI_KEY, store));
}

export function snapshotUi(state: AppState, extra: { collapsed: string[]; drawer: boolean }): PersistedUi {
  return {
    v: 1,
    panes: state.panes.map((p) => ({
      session: p.session ? { sessionId: p.session.sessionId, cwd: p.session.cwd, title: p.session.title, engine: p.session.engine } : null,
      model: p.model, efforts: p.efforts, autoEffort: p.autoEffort, engine: p.engine, sandbox: p.sandbox,
    })),
    active: Math.max(0, state.panes.findIndex((p) => p.id === state.activePaneId)),
    collapsed: extra.collapsed,
    drawer: extra.drawer,
  };
}

/** Writes only when the serialized value changed; returns what is stored now (feed it back as `last`). */
export function saveUi(ui: PersistedUi, last: string | null = null, store: Store | null = storage()): string {
  const json = JSON.stringify(ui);
  if (json !== last) { try { store?.setItem(UI_KEY, json); } catch { /* best-effort */ } }
  return json;
}

/** The app's start state: panes (sessions, pickers) restored; the sessions themselves are re-opened on `hello`. */
export function hydrate(base: AppState, ui: PersistedUi | null): AppState {
  if (!ui) return base;
  const panes: PaneState[] = ui.panes.map((p, i) => ({
    ...newPane(`p${i}`),
    session: p.session ? { ...p.session, account: null, sandbox: null } : null,
    model: p.model, efforts: { ...p.efforts }, autoEffort: p.autoEffort, engine: p.engine, sandbox: p.sandbox,
  }));
  return { ...base, panes, activePaneId: panes[ui.active]?.id ?? panes[0]!.id };
}

// --- sent attachments per session (thumbnails for reloaded transcripts) ---

const MAX_SESSIONS = 50;
const MAX_RECORDS = 40;
type SentMap = Record<string, { at: number; records: SentRecord[] }>;

function sentFile(x: unknown): SentFile | null {
  if (!isObj(x) || !shortStr(x.id, 64) || !/^[0-9a-f-]{36}$/.test(x.id) || !shortStr(x.name, 300)) return null;
  return { id: x.id, name: x.name, isImage: x.isImage === true };
}

function sentMap(raw: unknown): SentMap {
  const out: SentMap = {};
  if (!isObj(raw)) return out;
  for (const [sid, v] of Object.entries(raw)) {
    if (!isObj(v) || !Array.isArray(v.records) || sid.length > 200) continue;
    const records = v.records.flatMap((r): SentRecord[] => {
      if (!isObj(r) || !shortStr(r.text, 100_000) || !Array.isArray(r.files)) return [];
      const files = r.files.map(sentFile).filter((f): f is SentFile => !!f);
      return files.length ? [{ text: r.text, files }] : [];
    });
    if (records.length) out[sid] = { at: typeof v.at === 'number' ? v.at : 0, records: records.slice(-MAX_RECORDS) };
  }
  return out;
}

export function loadSent(sessionId: string, store: Store | null = storage()): SentRecord[] {
  return sentMap(readJson(SENT_KEY, store))[sessionId]?.records ?? [];
}

/** Records every user item with files of every pane that has a session id (merging, newest sessions kept). */
export function saveSent(panes: PaneState[], now = Date.now(), store: Store | null = storage()): void {
  const fresh = panes.flatMap((p) => {
    const sid = p.session?.sessionId;
    if (!sid) return [];
    const records = p.items.flatMap((it: ChatItem): SentRecord[] => (it.kind === 'user' && it.attachments?.length ? [{ text: it.text, files: it.attachments }] : []));
    return records.length ? [[sid, records] as const] : [];
  });
  if (!fresh.length) return;
  const map = sentMap(readJson(SENT_KEY, store));
  let changed = false;
  for (const [sid, records] of fresh) {
    const prev = map[sid]?.records ?? [];
    const merged = [...prev];
    for (const r of records) if (!merged.some((m) => m.text === r.text && m.files[0]?.id === r.files[0]?.id)) { merged.push(r); changed = true; }
    if (merged.length !== prev.length) map[sid] = { at: now, records: merged.slice(-MAX_RECORDS) };
  }
  if (!changed) return;
  const kept = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS);
  writeJson(SENT_KEY, Object.fromEntries(kept), store);
}
