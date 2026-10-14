import { describe, expect, it } from 'vitest';
import { deleteLayout, LAYOUTS_KEY, layoutPanes, listLayouts, MAX_LAYOUTS, readLayouts, saveLayout } from './layouts';
import { parsePane, type PersistedPane } from './persist';

const memStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m }; };
const pane = (extra: Partial<PersistedPane> = {}): PersistedPane => ({ session: null, model: 'auto', efforts: { claude: 'high', codex: 'medium', gemini: 'medium' }, autoEffort: null, engine: 'claude', sandbox: 'workspace-write', ...extra });
const rect = { x: 10, y: 20, w: 400, h: 300 };

describe('layouts (카드 배치)', () => {
  it('saves under the global key, newest first; the same name overwrites (and moves to the front)', () => {
    const store = memStore();
    saveLayout('작업', [pane(), pane({ float: rect })], store, 1);
    saveLayout('리뷰', [pane()], store, 2);
    expect(listLayouts(store).map((l) => l.name)).toEqual(['리뷰', '작업']);
    expect(listLayouts(store)[1]!.panes[1]!.float).toEqual(rect);
    saveLayout(' 작업 ', [pane(), pane(), pane()], store, 3);
    const list = listLayouts(store);
    expect(list.map((l) => [l.name, l.savedAt, l.panes.length])).toEqual([['작업', 3, 3], ['리뷰', 2, 1]]);
    expect(JSON.parse(store.m.get(LAYOUTS_KEY)!)).toHaveLength(2);
    // An empty name or no panes saves nothing.
    expect(saveLayout('  ', [pane()], store)).toHaveLength(2);
    expect(saveLayout('x', [], store)).toHaveLength(2);
  });

  it(`keeps at most ${MAX_LAYOUTS} (the oldest go) and deletes by name`, () => {
    const store = memStore();
    for (let i = 0; i < MAX_LAYOUTS + 3; i++) saveLayout(`L${i}`, [pane()], store, i);
    const list = listLayouts(store);
    expect(list).toHaveLength(MAX_LAYOUTS);
    expect(list[0]!.name).toBe(`L${MAX_LAYOUTS + 2}`);
    expect(list.some((l) => l.name === 'L0')).toBe(false);
    deleteLayout(`L${MAX_LAYOUTS + 2}`, store);
    expect(listLayouts(store)).toHaveLength(MAX_LAYOUTS - 1);
    expect(listLayouts(store)[0]!.name).toBe(`L${MAX_LAYOUTS + 1}`);
  });

  it('readLayouts: bad JSON / shapes are dropped, panes go through persist\'s parser', () => {
    expect(readLayouts('{"oops')).toEqual([]);
    expect(readLayouts(null)).toEqual([]);
    expect(readLayouts({ name: 'x' })).toEqual([]);
    const list = readLayouts([
      { name: 'ok', savedAt: 5, panes: [{ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' }, model: 'nope', float: { x: 0, y: 0, w: 1, h: 1 }, floatCollapsed: true }] },
      { name: 'ok', savedAt: 6, panes: [pane()] }, // a repeated name: the first wins
      { name: '', savedAt: 1, panes: [pane()] },
      { name: 'no-panes', savedAt: 1, panes: [] },
      { name: 'bad-time', savedAt: 'x', panes: [pane()] },
      'junk',
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.panes[0]!.session?.sessionId).toBe('s1');
    expect(list[0]!.panes[0]!.model).toBe(parsePane(null).model); // bad model → default
    expect(list[0]!.panes[0]).not.toHaveProperty('float'); // unusable box dropped…
    expect(list[0]!.panes[0]).not.toHaveProperty('floatCollapsed'); // …and the fold with it
    const store = memStore();
    store.setItem(LAYOUTS_KEY, 'not json');
    expect(listLayouts(store)).toEqual([]);
  });

  it('keeps only the layout and the session: a turn in flight, a prefilled draft, a handoff note are not saved', () => {
    const store = memStore();
    saveLayout('a', [pane({ session: { sessionId: 's1', cwd: '/w', title: 't', engine: 'claude' }, turnId: 't1', prefill: 'draft', handoffFrom: { sessionId: 's0', title: 'old' }, float: rect })], store, 1);
    const saved = listLayouts(store)[0]!.panes[0]!;
    expect(saved.session?.sessionId).toBe('s1');
    expect(saved.float).toEqual(rect);
    expect(saved).not.toHaveProperty('turnId');
    expect(saved).not.toHaveProperty('prefill');
    expect(saved).not.toHaveProperty('handoffFrom');
  });

  it('a store that refuses the write (quota full): saveLayout returns null and nothing changes', () => {
    const store = memStore();
    saveLayout('a', [pane()], store, 1);
    const full = { getItem: store.getItem, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(saveLayout('b', [pane()], full, 2)).toBeNull();
    expect(listLayouts(store).map((l) => l.name)).toEqual(['a']);
    expect(saveLayout('b', [pane()], null, 2)).toBeNull(); // no storage at all
  });

  it('layoutPanes builds panes like a reload: fresh ids, sessions loading, the first card docked when all float', () => {
    const panes = layoutPanes([pane({ session: { sessionId: 's1', cwd: '/w', title: 'one', engine: 'claude' }, float: rect, floatCollapsed: true }), pane({ float: rect })], 7)!;
    expect(panes.map((p) => p.id)).toEqual(['p7', 'p8']);
    expect(panes[0]!.loading).toBe(true);
    expect(panes[0]!.float).toBeUndefined();
    expect(panes[0]!.floatCollapsed).toBeUndefined();
    expect(panes[1]!.float).toEqual(rect);
    expect(layoutPanes([], 0)).toBeNull();
  });
});
