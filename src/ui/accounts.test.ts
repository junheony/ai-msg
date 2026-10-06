import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo, ServerMessage } from '../shared/protocol';
import { ACCOUNT_PALETTE_SIZE, LEGACY_ACCOUNT_LIST, accountListOf, seatLabel, uiAccounts } from './accounts';
import { setFeatures } from './features';
import { hydrate, parseUi } from './persist';
import { initialState, reducer, type AppState } from './state';

const acct = (id: string, label = id.toUpperCase(), extra: Partial<AccountInfo> = {}): AccountInfo => ({ id, label, home: false, retired: false, ...extra });
const FIVE: AccountInfo[] = [acct('a', 'Main', { home: true }), acct('b', 'Work'), acct('old', 'Old', { retired: true }), acct('d'), acct('team-2', 'Team-2')];
const usage = { generatedAt: 'x', deckReachable: true, accounts: {} };
const hello = (extra: Partial<Extract<ServerMessage, { type: 'hello' }>> = {}): ServerMessage => ({ type: 'hello', usage, projects: [], running: [], codex: { available: false }, ...extra });
const server = (s: AppState, msg: ServerMessage): AppState => reducer(s, { type: 'server', msg });

afterEach(() => setFeatures(undefined));

describe('the UI account list', () => {
  it('before any hello it is a/b/c with A as home', () => {
    expect(initialState.accounts).toEqual([
      { id: 'a', label: 'A', home: true, retired: false },
      { id: 'b', label: 'B', home: false, retired: false },
      { id: 'c', label: 'C', home: false, retired: false },
    ]);
    expect(LEGACY_ACCOUNT_LIST).toBe(initialState.accounts);
  });

  it('a server with the accounts feature fills it from hello.accounts, in its order, retired included', () => {
    setFeatures(['accounts']);
    const s = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    expect(s.accounts).toEqual(FIVE);
    const names = uiAccounts(s.accounts);
    expect(names.active.map((a) => a.id)).toEqual(['a', 'b', 'd', 'team-2']);
    expect(names.home?.id).toBe('a');
  });

  it('an older server (no feature, no field) leaves a/b/c — and a field without the feature is not read', () => {
    expect(server(initialState, hello()).accounts).toEqual(LEGACY_ACCOUNT_LIST);
    expect(server(initialState, hello({ accounts: FIVE })).accounts).toEqual(LEGACY_ACCOUNT_LIST);
  });

  it('every hello replaces it: a reconnect to an older server goes back to a/b/c, to a newer one takes its list', () => {
    setFeatures(['accounts']);
    const s1 = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    setFeatures(undefined);
    const s2 = server(s1, hello());
    expect(s2.accounts).toEqual(LEGACY_ACCOUNT_LIST);
    setFeatures(['accounts']);
    expect(server(s2, hello({ features: ['accounts'], accounts: [acct('solo', 'Solo', { home: true })] })).accounts).toEqual([acct('solo', 'Solo', { home: true })]);
  });

  it('a malformed or empty list is no list; bad entries and repeats are dropped, a missing label is the id in capitals', () => {
    expect(accountListOf(undefined)).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf([])).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf('abc' as never)).toBe(LEGACY_ACCOUNT_LIST);
    expect(accountListOf([null, 3, { id: '' }, { id: 'x' }, { id: 'x', label: 'Twice' }, { id: 'y', label: 'Why', home: 'yes', retired: true }] as never)).toEqual([
      { id: 'x', label: 'X', home: false, retired: false },
      { id: 'y', label: 'Why', home: false, retired: true },
    ]);
  });
});

describe('labels and looks', () => {
  const names = uiAccounts(FIVE);

  it('a configured account shows its label, a retired one too; an id that is not configured shows as it is — never "undefined"', () => {
    expect(names.label('a')).toBe('Main');
    expect(names.label('old')).toBe('Old');
    expect(names.label('zz-gone')).toBe('zz-gone');
    expect(names.label('c')).toBe('c');
    expect(names.label('gpt')).toBe('GPT');
    expect(names.label('g1')).toBe('G1');
    for (const id of ['constructor', 'toString', '__proto__', 'x']) expect(seatLabel(FIVE, id)).toBe(id);
    expect(names.look('a')).toEqual({ slot: 0, kind: 'active' });
    expect(names.look('old')).toEqual({ slot: 2, kind: 'retired' });
    expect(names.look('zz-gone')).toEqual({ slot: null, kind: 'unknown' });
    expect(names.look('gpt')).toEqual({ slot: null, kind: 'other' });
    expect(names.look('g2')).toEqual({ slot: null, kind: 'other' });
    expect(names.has('old')).toBe(true);
    expect(names.has('zz-gone')).toBe(false);
    expect(names.isRetired('old')).toBe(true);
    expect(names.isRetired('zz-gone')).toBe(false);
  });

  it('palette slot: the position in the configured list (retired ones keep theirs), wrapping after eight', () => {
    expect(ACCOUNT_PALETTE_SIZE).toBe(8);
    expect(FIVE.map((a) => names.slot(a.id))).toEqual([0, 1, 2, 3, 4]);
    const ten = uiAccounts(Array.from({ length: 10 }, (_, i) => acct(`n${i}`)));
    expect(ten.all.map((a) => ten.slot(a.id))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
    expect(names.slot('zz-gone')).toBeNull();
    expect(names.slot('gpt')).toBeNull();
    expect(uiAccounts(LEGACY_ACCOUNT_LIST).all.map((a) => uiAccounts(LEGACY_ACCOUNT_LIST).slot(a.id))).toEqual([0, 1, 2]);
  });

  it('a retry note names both accounts by label, an unconfigured one by its id', () => {
    setFeatures(['accounts']);
    let s = server(initialState, hello({ features: ['accounts'], accounts: FIVE }));
    s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't' });
    s = server(s, { type: 'history', sessionId: 's1', cwd: '/w', account: 'b', engine: 'claude', sandbox: null, messages: [], runningTurnId: null });
    s = server(s, { type: 'turn_started', turnId: 't1', sessionId: 's1', cwd: '/w', account: 'b', model: 'opus', reason: 'r', attempt: 1 });
    s = server(s, { type: 'turn_retry', turnId: 't1', sessionId: 's1', cwd: '/w', fromAccount: 'b', toAccount: 'zz-gone', reason: '한도', attempt: 1 });
    const notes = s.panes[0]!.items.flatMap((it) => (it.kind === 'assistant' ? it.notes : []));
    expect(notes).toEqual(['재시도 Work → zz-gone: 한도']);
  });

  it('a new session\'s stored pin on a fourth account survives a reload', () => {
    const ui = parseUi({ v: 1, panes: [{ session: { sessionId: null, cwd: '/w', title: 't', engine: 'claude' }, accountPin: 'team-2' }], active: 0, collapsed: [], drawer: false });
    expect(hydrate(initialState, ui).panes[0]!.session).toMatchObject({ accountPin: 'team-2' });
  });
});
