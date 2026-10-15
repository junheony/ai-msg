import { beforeEach, describe, expect, it } from 'vitest';
import type { SideDoc } from './sidePanel';
import {
  HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINES, MAX_SIDE_TABS, NO_TABS, SIDE_TABS_KEY, SIDE_WIDTH_DEFAULT, SIDE_WIDTH_KEY,
  activeTab, canHighlight, carriesTabs, closeTab, forgetSideTabs, langFor, openTab, readSideWidth, recallSideTabs, rememberSideTabs, saveSideWidth, selectTab,
  type SideTabs,
} from './sideTabs';

const file = (path: string): SideDoc => ({ kind: 'file', path });
const paths = (s: SideTabs) => s.tabs.map((t) => (t.doc.kind === 'file' ? t.doc.path : t.doc.kind));
const activePath = (s: SideTabs) => { const d = activeTab(s)?.doc; return d?.kind === 'file' ? d.path : d?.kind ?? null; };

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

describe('side tabs', () => {
  it('opens in order, the newest active', () => {
    const s = openTab(openTab(NO_TABS, file('a.ts')), file('b.ts'));
    expect(paths(s)).toEqual(['a.ts', 'b.ts']);
    expect(activePath(s)).toBe('b.ts');
  });

  it('the same file activates its tab and takes the new diffs; the same HTML too', () => {
    let s = openTab(openTab(NO_TABS, file('a.ts')), file('b.ts'));
    const rev = s.tabs[0]!.rev;
    s = openTab(s, { kind: 'file', path: 'a.ts', diffs: [] });
    expect(paths(s)).toEqual(['a.ts', 'b.ts']);
    expect(activePath(s)).toBe('a.ts');
    expect(s.tabs[0]!.doc).toEqual({ kind: 'file', path: 'a.ts', diffs: [] });
    expect(s.tabs[0]!.rev).not.toBe(rev);
    s = openTab(openTab(s, { kind: 'html', title: 'H', html: '<b>1</b>' }), file('c.ts'));
    s = openTab(s, { kind: 'html', title: 'H', html: '<b>1</b>' });
    expect(s.tabs.filter((t) => t.doc.kind === 'html')).toHaveLength(1);
    expect(activeTab(s)!.doc.kind).toBe('html');
  });

  it('closing the active tab goes back to the one viewed before; the last leaves none', () => {
    let s = openTab(openTab(openTab(NO_TABS, file('a.ts')), file('b.ts')), file('c.ts'));
    s = selectTab(s, s.tabs[0]!.id); // a, then c was before it
    s = closeTab(s, s.tabs[0]!.id);
    expect(activePath(s)).toBe('c.ts');
    s = closeTab(closeTab(s, s.tabs[0]!.id), s.tabs[1]!.id);
    expect(s.tabs).toEqual([]);
    expect(activeTab(s)).toBeNull();
  });

  it('past the limit the least recently viewed closes', () => {
    let s = NO_TABS;
    for (let i = 0; i < MAX_SIDE_TABS; i++) s = openTab(s, file(`f${i}`));
    s = selectTab(s, s.tabs[0]!.id); // f0 is recent now; f1 the stalest
    s = openTab(s, file('new'));
    expect(s.tabs).toHaveLength(MAX_SIDE_TABS);
    expect(paths(s)).not.toContain('f1');
    expect(paths(s)).toContain('f0');
    expect(activePath(s)).toBe('new');
  });

  it('a file picked from 파일 열기 takes that tab; one already open just closes the pick', () => {
    let s = openTab(openTab(NO_TABS, file('a.ts')), { kind: 'pick' });
    expect(openTab(s, { kind: 'pick' }).tabs).toHaveLength(2);
    const pick = activeTab(s)!.id;
    const picked = openTab(s, file('b.ts'), { replace: pick });
    expect(paths(picked)).toEqual(['a.ts', 'b.ts']);
    expect(activePath(picked)).toBe('b.ts');
    s = openTab(s, file('a.ts'), { replace: pick });
    expect(paths(s)).toEqual(['a.ts']);
  });

  it('a relative and an absolute path of the same file share a tab (under the cwd)', () => {
    let s = openTab(NO_TABS, file('src/a.ts'), { cwd: '/w' });
    s = openTab(s, file('/w/src/a.ts'), { cwd: '/w' });
    s = openTab(s, file('./src/a.ts'), { cwd: '/w/' });
    expect(s.tabs).toHaveLength(1);
    expect(paths(s)).toEqual(['./src/a.ts']);
    expect(openTab(s, file('/x/src/a.ts'), { cwd: '/w' }).tabs).toHaveLength(2);
  });

  it('selecting the active or a missing tab changes nothing', () => {
    const s = openTab(NO_TABS, file('a.ts'));
    expect(selectTab(s, s.tabs[0]!.id)).toBe(s);
    expect(selectTab(s, 'nope')).toBe(s);
  });
});

describe('side tabs per session', () => {
  beforeEach(() => forgetSideTabs());

  it('remembers every tab per session in the page; none for no session', () => {
    const store = memStore();
    const s = openTab(openTab(NO_TABS, file('a.ts')), { kind: 'html', title: 'H', html: '<b/>' });
    rememberSideTabs('s1\n/w', s, store);
    expect(recallSideTabs('s1\n/w', store)).toBe(s);
    expect(recallSideTabs('s2\n/w', store)).toEqual(NO_TABS);
    expect(recallSideTabs('', store)).toEqual(NO_TABS);
  });

  it('a reload gets the file tabs back from storage (no HTML, no diffs), the active one active', () => {
    const store = memStore();
    let s = openTab(openTab(openTab(NO_TABS, { kind: 'file', path: 'a.ts', diffs: [] }), { kind: 'html', title: 'H', html: '<b/>' }), file('b.ts'));
    s = selectTab(s, s.tabs[0]!.id);
    rememberSideTabs('s1\n/w', s, store);
    expect(store.m.get(SIDE_TABS_KEY)).not.toContain('<b/>');
    forgetSideTabs();
    const back = recallSideTabs('s1\n/w', store);
    expect(paths(back)).toEqual(['a.ts', 'b.ts']);
    expect(back.tabs[0]!.doc).toEqual({ kind: 'file', path: 'a.ts' });
    expect(activePath(back)).toBe('a.ts');
    // Opening more after a restore never reuses an id.
    expect(new Set(openTab(back, file('c.ts')).tabs.map((t) => t.id)).size).toBe(3);
  });

  it('closing everything forgets the stored entry; junk in storage reads as none', () => {
    const store = memStore();
    rememberSideTabs('s1\n/w', openTab(NO_TABS, file('a.ts')), store);
    rememberSideTabs('s1\n/w', NO_TABS, store);
    expect(store.m.has(SIDE_TABS_KEY)).toBe(false);
    forgetSideTabs(); // a fresh page: storage only
    store.setItem(SIDE_TABS_KEY, '{not json');
    expect(recallSideTabs('s1\n/w', store)).toEqual(NO_TABS);
    store.setItem(SIDE_TABS_KEY, JSON.stringify({ 's1\n/w': { files: [1, '', 'ok.ts'], active: 9, at: 1 } }));
    expect(paths(recallSideTabs('s1\n/w', store))).toEqual(['ok.ts']);
  });

  it('a new chat (no session id yet) is not remembered, so the next new chat in that folder starts empty', () => {
    const store = memStore();
    rememberSideTabs('\n/w', openTab(NO_TABS, file('a.ts')), store);
    expect(recallSideTabs('\n/w', store)).toEqual(NO_TABS);
    expect(store.m.has(SIDE_TABS_KEY)).toBe(false);
  });

  it('a new chat carries its tabs to its session id, in the same folder only', () => {
    expect(carriesTabs('\n/w', 's1\n/w')).toBe(true);
    expect(carriesTabs('\n/w', 's1\n/x')).toBe(false);
    expect(carriesTabs('s0\n/w', 's1\n/w')).toBe(false);
    expect(carriesTabs('\n/w', '\n/w2')).toBe(false);
    expect(carriesTabs('', 's1\n/w')).toBe(false);
  });

  it('odd stored entries are dropped instead of breaking a save', () => {
    const store = memStore();
    store.setItem(SIDE_TABS_KEY, JSON.stringify({ 'k\n/a': null, 'k\n/b': 3, 'k\n/c': { files: 'x' }, 'k\n/d': { files: ['d.ts'] } }));
    expect(() => rememberSideTabs('s1\n/w', openTab(NO_TABS, file('a.ts')), store)).not.toThrow();
    expect(Object.keys(JSON.parse(store.m.get(SIDE_TABS_KEY)!) as object).sort()).toEqual(['k\n/d', 's1\n/w']);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    expect(() => rememberSideTabs('s2\n/w', openTab(NO_TABS, file('a.ts')), throwing)).not.toThrow();
  });

  it('keeps the 30 most recently changed sessions in storage', () => {
    const store = memStore();
    for (let i = 0; i < 32; i++) rememberSideTabs(`s${i}\n/w`, openTab(NO_TABS, file('a.ts')), store, 1000 + i);
    const kept = Object.keys(JSON.parse(store.m.get(SIDE_TABS_KEY)!) as object);
    expect(kept).toHaveLength(30);
    expect(kept).not.toContain('s0\n/w');
    expect(kept).toContain('s31\n/w');
  });
});

describe('side panel width', () => {
  it('saves and reads back; missing, junk or too narrow gives the default', () => {
    const store = memStore();
    expect(readSideWidth(store)).toBe(SIDE_WIDTH_DEFAULT);
    saveSideWidth(612.4, store);
    expect(store.m.get(SIDE_WIDTH_KEY)).toBe('612');
    expect(readSideWidth(store)).toBe(612);
    store.setItem(SIDE_WIDTH_KEY, 'wide');
    expect(readSideWidth(store)).toBe(SIDE_WIDTH_DEFAULT);
    store.setItem(SIDE_WIDTH_KEY, '40');
    expect(readSideWidth(store)).toBe(SIDE_WIDTH_DEFAULT);
    expect(readSideWidth(null)).toBe(SIDE_WIDTH_DEFAULT);
  });
});

describe('highlighting', () => {
  it('skips big files', () => {
    expect(canHighlight('const a = 1;\n')).toBe(true);
    expect(canHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS))).toBe(true);
    expect(canHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(false);
    expect(canHighlight('\n'.repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
    expect(canHighlight('\n'.repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
  });

  it('picks a language by extension or name; plain text has none', () => {
    expect(langFor('/w/src/a.ts')).toBe('ts');
    expect(langFor('x/App.TSX')).toBe('tsx');
    expect(langFor('a.py')).toBe('py');
    expect(langFor('log.jsonl')).toBe('json');
    expect(langFor('pkg/Makefile')).toBe('makefile');
    expect(langFor('notes.txt')).toBeNull();
    expect(langFor('LICENSE')).toBeNull();
    expect(langFor('x.constructor')).toBe('constructor'); // never an Object.prototype member
    expect(langFor('x.toString')).toBe('tostring');
  });
});
