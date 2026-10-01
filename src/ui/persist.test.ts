import { describe, expect, it } from 'vitest';
import { SENT_KEY, UI_KEY, hydrate, loadSent, loadUi, parseUi, saveSent, saveUi, snapshotUi } from './persist';
import { initialState, newPane, reducer, type AppState, type PaneState } from './state';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  let writes = 0;
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { writes++; m.set(k, v); }, raw: m, writes: () => writes };
}

const twoPanes = (): AppState => {
  let s = reducer(initialState, { type: 'open', sessionId: 's1', cwd: '/w', title: 'one' });
  s = reducer(s, { type: 'set_model', model: 'fable' });
  s = reducer(s, { type: 'set_effort', engine: 'claude', effort: 'xhigh' });
  s = reducer(s, { type: 'add_pane' });
  s = reducer(s, { type: 'set_engine', engine: 'codex' });
  s = reducer(s, { type: 'set_sandbox', sandbox: 'workspace-write' });
  s = reducer(s, { type: 'open', sessionId: null, cwd: '/x', title: 'x · 새 세션' });
  return s;
};

describe('persist (ux-state)', () => {
  it('round-trips panes, sessions, pickers, active pane, collapsed groups and the drawer', () => {
    const store = memStore();
    const s = twoPanes();
    saveUi(snapshotUi(s, { collapsed: ['/w'], drawer: true }), null, store);
    const ui = loadUi(store);
    expect(ui).toMatchObject({ v: 1, active: 1, collapsed: ['/w'], drawer: true });
    const h = hydrate(initialState, ui);
    expect(h.panes.map((p) => p.id)).toEqual(['p0', 'p1']);
    expect(h.activePaneId).toBe('p1');
    expect(h.panes[0]).toMatchObject({ session: { sessionId: 's1', cwd: '/w', title: 'one', account: null }, model: 'fable', efforts: { claude: 'xhigh', codex: 'medium' }, items: [], queue: [] });
    expect(h.panes[1]).toMatchObject({ session: { sessionId: null, cwd: '/x', engine: 'codex' }, engine: 'codex', model: 'gpt-6-sol', sandbox: 'workspace-write' });
    // add_pane after hydration keeps ids unique
    expect(reducer(h, { type: 'add_pane' }).panes.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('nothing stored, corrupt JSON, wrong shape or an unknown version → null (start fresh)', () => {
    expect(loadUi(memStore())).toBeNull();
    expect(loadUi(memStore({ [UI_KEY]: '{not json' }))).toBeNull();
    expect(parseUi('x')).toBeNull();
    expect(parseUi([])).toBeNull();
    expect(parseUi({ v: 2, panes: [{}] })).toBeNull();
    expect(parseUi({ panes: [{}] })).toBeNull();
    expect(parseUi({ v: 1, panes: [] })).toBeNull();
    expect(parseUi({ v: 1, panes: 'nope' })).toBeNull();
    expect(hydrate(initialState, null)).toBe(initialState);
  });

  it('a bad field falls back to its default without losing the good ones', () => {
    const ui = parseUi({
      v: 1,
      active: 9,
      collapsed: ['/ok', 3, null],
      drawer: 'yes',
      panes: [
        { session: { sessionId: 's1', cwd: '/w', title: 7, engine: 'llama' }, model: 'gpt-9', efforts: { claude: 'max', codex: 'low' }, engine: 'x', sandbox: 'danger-full-access' },
        { session: { sessionId: 's2', cwd: 'relative/path' }, model: 'sonnet' },
        { session: { sessionId: 42, cwd: '/w' } },
        null,
        'junk',
        {}, {}, {}, // more than MAX_PANES (5) in total
      ],
    })!;
    expect(ui.panes).toHaveLength(5);
    expect(ui.active).toBe(0);
    expect(ui.collapsed).toEqual(['/ok']);
    expect(ui.drawer).toBe(false);
    const d = newPane('');
    expect(ui.panes[0]).toEqual({ session: { sessionId: 's1', cwd: '/w', title: 's1', engine: null }, model: d.model, efforts: { claude: 'high', codex: 'low', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'read-only' });
    expect(ui.panes[1]).toMatchObject({ session: null, model: 'sonnet' });
    expect(ui.panes[2]!.session).toBeNull();
    expect(ui.panes[3]).toEqual({ session: null, model: d.model, efforts: d.efforts, autoEffort: null, engine: d.engine, sandbox: d.sandbox });
  });

  it('keeps 자동 (model and its effort) and Gemini panes across a reload', () => {
    const store = memStore();
    let s = reducer(initialState, { type: 'open', sessionId: null, cwd: '/w', title: 'w · 새 세션' });
    s = reducer(s, { type: 'set_model', model: 'auto' });
    s = reducer(s, { type: 'set_auto_effort', effort: 'low' });
    s = reducer(s, { type: 'add_pane' });
    s = reducer(s, { type: 'set_engine', engine: 'gemini' });
    s = reducer(s, { type: 'open', sessionId: 'g-1', cwd: '/x', title: 'gem' });
    s = { ...s, panes: s.panes.map((p, i) => (i === 1 && p.session ? { ...p, session: { ...p.session, engine: 'gemini' as const } } : p)) };
    saveUi(snapshotUi(s, { collapsed: [], drawer: false }), null, store);
    const h = hydrate(initialState, loadUi(store));
    expect(h.panes[0]).toMatchObject({ model: 'auto', autoEffort: 'low' });
    expect(h.panes[1]).toMatchObject({ engine: 'gemini', model: 'gemini-pro', session: { sessionId: 'g-1', engine: 'gemini' } });
    expect(parseUi({ v: 1, panes: [{ model: 'auto', autoEffort: 'max' }] })!.panes[0]).toMatchObject({ model: 'auto', autoEffort: null });
  });

  it('saveUi writes only on change and survives a throwing storage', () => {
    const store = memStore();
    const ui = snapshotUi(twoPanes(), { collapsed: [], drawer: false });
    const last = saveUi(ui, null, store);
    saveUi(ui, last, store);
    expect(store.writes()).toBe(1);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(() => saveUi(ui, null, broken)).not.toThrow();
    expect(loadUi(broken)).toBeNull();
    expect(loadSent('s1', broken)).toEqual([]);
  });

  it('remembers sent files per session (validated, deduped) for transcript reloads', () => {
    const store = memStore();
    const file = { id: '11111111-2222-3333-4444-555555555555', name: 'shot.png', isImage: true };
    const p: PaneState = { ...newPane('p0'), session: { sessionId: 's1', cwd: '/w', account: null, title: 't', engine: 'claude', sandbox: null }, items: [{ kind: 'user', text: 'look', attachments: [file] }, { kind: 'user', text: 'plain' }] };
    const unsaved: PaneState = { ...p, session: { ...p.session!, sessionId: null } };
    saveSent([p, unsaved], 1, store);
    saveSent([p], 2, store);
    expect(loadSent('s1', store)).toEqual([{ text: 'look', files: [file] }]);
    expect(loadSent('nope', store)).toEqual([]);
    // tampered storage: bad ids / shapes are dropped
    const bad = memStore({ [SENT_KEY]: JSON.stringify({ s1: { at: 1, records: [{ text: 'a', files: [{ id: '../../etc', name: 'x' }] }, { text: 'b', files: [file] }, 'junk'] }, s2: 'junk' }) });
    expect(loadSent('s1', bad)).toEqual([{ text: 'b', files: [file] }]);
    expect(loadSent('s2', bad)).toEqual([]);
  });
});
