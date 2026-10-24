import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../shared/protocol';
import type { TranscriptMessage } from '../shared/session-types';
import { initialState, olderOfPane, reducer, withOlderFrom, type AppState, type ChatItem } from './state';

const pane = (s: AppState) => s.panes[0]!;
const play = (msgs: ServerMessage[], start: AppState): AppState => msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), start);
const opened = (sessionId: string): AppState => reducer(initialState, { type: 'open', sessionId, cwd: '/w', title: 't' });
const user = (text: string): TranscriptMessage => ({ kind: 'user', text, ts: null });
const history = (sessionId: string, messages: TranscriptMessage[], older?: string | null, at?: string): ServerMessage => ({
  type: 'history', sessionId, cwd: '/w', account: 'b', runningTurnId: null, messages, ...(older === undefined ? {} : { older }), ...(at ? { at } : {}),
});
const page = (sessionId: string, before: string, reqId: string | undefined, messages: TranscriptMessage[], older: string | null, error?: 'bad_cursor' | 'not_found' | 'read_failed', at?: string): ServerMessage => ({
  type: 'older_history', sessionId, before, ...(reqId ? { reqId } : {}), messages, older, ...(at ? { at } : {}), ...(error ? { error } : {}),
});
const ask = (s: AppState, reqId: string): AppState => reducer(s, { type: 'older_request', paneId: pane(s).id, reqId });
const texts = (items: ChatItem[]) => items.map((i) => i.text);

describe('older history (pane state)', () => {
  it('history sets the cursor; absent older = no paging; null = at the start', () => {
    let s = play([history('s1', [user('c')], 'i10')], opened('s1'));
    expect(olderOfPane(pane(s))).toMatchObject({ sessionId: 's1', cursor: 'i10', reqId: null });
    s = play([history('s2', [user('c')])], opened('s2'));
    expect(olderOfPane(pane(s))).toBeUndefined();
    s = play([history('s3', [user('c')], null)], opened('s3'));
    expect(olderOfPane(pane(s))?.cursor).toBeNull();
  });

  it('pages go in front, oldest first, and the cursor moves back', () => {
    let s = play([history('s1', [user('c'), user('d')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    expect(olderOfPane(pane(s))?.reqId).toBe('r1');
    s = play([page('s1', 'i2', 'r1', [user('a'), user('b')], null)], s);
    expect(texts(pane(s).items)).toEqual(['a', 'b', 'c', 'd']);
    expect(olderOfPane(pane(s))).toMatchObject({ cursor: null, reqId: null });
    // At the start: no further request goes out.
    expect(ask(s, 'r2')).toBe(s);
  });

  it('no duplicates: a repeated answer, one for another reqId, or for an old cursor is ignored', () => {
    let s = play([history('s1', [user('e')], 'i4')], opened('s1'));
    s = ask(s, 'r1');
    // A second request while one is in flight is not recorded.
    expect(ask(s, 'r9')).toBe(s);
    expect(play([page('s1', 'i4', 'r9', [user('x')], null)], s)).toBe(s);
    s = play([page('s1', 'i4', 'r1', [user('c'), user('d')], 'i2')], s);
    expect(texts(pane(s).items)).toEqual(['c', 'd', 'e']);
    // The same answer again (e.g. a resend): not applied twice.
    expect(play([page('s1', 'i4', 'r1', [user('c'), user('d')], 'i2')], s)).toBe(s);
    s = ask(s, 'r2');
    // An answer to the old cursor under the new reqId: ignored.
    expect(play([page('s1', 'i4', 'r2', [user('c'), user('d')], 'i2')], s)).toBe(s);
    s = play([page('s1', 'i2', 'r2', [user('a'), user('b')], null)], s);
    expect(texts(pane(s).items)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a late answer after switching session (or reopening it) is ignored', () => {
    let s = play([history('s1', [user('c')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    // Switch to another session on the same pane.
    s = reducer(s, { type: 'open', sessionId: 's2', cwd: '/w', title: 't', paneId: pane(s).id });
    s = play([history('s2', [user('z')], null)], s);
    const before = s;
    s = play([page('s1', 'i2', 'r1', [user('a'), user('b')], null)], s);
    expect(s).toBe(before);
    expect(texts(pane(s).items)).toEqual(['z']);
    // Back to s1: a fresh history resets paging; the old request's answer does not apply.
    s = reducer(s, { type: 'open', sessionId: 's1', cwd: '/w', title: 't', paneId: pane(s).id });
    s = play([history('s1', [user('c')], 'i2')], s);
    expect(olderOfPane(pane(s))).toMatchObject({ cursor: 'i2', reqId: null });
    expect(play([page('s1', 'i2', 'r1', [user('a'), user('b')], null)], s)).toBe(s);
  });

  it('clearing the pane drops paging', () => {
    let s = play([history('s1', [user('c')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    s = reducer(s, { type: 'clear_pane' });
    expect(pane(s).older).toBeUndefined();
    expect(play([page('s1', 'i2', 'r1', [user('a')], null)], s)).toBe(s);
  });

  it('an error marks the request failed and keeps the cursor for a retry', () => {
    let s = play([history('s1', [user('c')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    s = play([page('s1', 'i2', 'r1', [], null, 'read_failed')], s);
    expect(olderOfPane(pane(s))).toMatchObject({ cursor: 'i2', reqId: null, failed: true });
    expect(texts(pane(s).items)).toEqual(['c']);
    s = ask(s, 'r2');
    expect(olderOfPane(pane(s))).toMatchObject({ reqId: 'r2', failed: false });
  });

  it('a reconnect (hello) drops the request in flight so it can be asked again', () => {
    let s = play([history('s1', [user('c')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    s = play([{ type: 'hello', usage: { accounts: {} } as never, projects: [], running: [], codex: { available: false } }], s);
    expect(olderOfPane(pane(s))?.reqId).toBeNull();
  });

  it('a tool result whose call is on the earlier page joins it when that page comes', () => {
    const call: TranscriptMessage = { kind: 'assistant', text: 'run', model: null, toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'ls' } }], ts: null };
    const result: TranscriptMessage = { kind: 'tool_result', toolUseId: 't1', content: 'out', isError: false, ts: null };
    let s = play([history('s1', [result, user('next')], 'i2')], opened('s1'));
    s = ask(s, 'r1');
    s = play([page('s1', 'i2', 'r1', [user('q'), call], null)], s);
    const items = pane(s).items;
    expect(texts(items)).toEqual(['q', 'run', 'next']);
    const a = items[1] as Extract<ChatItem, { kind: 'assistant' }>;
    expect(a.toolCalls[0]).toMatchObject({ toolUseId: 't1', result: 'out' });
  });

  it('from: where the items start (history / page `at`); an open_session for the session carries it, others do not', () => {
    let s = play([history('s1', [user('c')], 'i2.aaaaaaaa', 'i2.aaaaaaaa')], opened('s1'));
    expect(olderOfPane(pane(s))?.from).toBe('i2.aaaaaaaa');
    s = ask(s, 'r1');
    s = play([page('s1', 'i2.aaaaaaaa', 'r1', [user('b')], 'i1.aaaaaaaa', undefined, 'i1.aaaaaaaa')], s);
    expect(olderOfPane(pane(s))?.from).toBe('i1.aaaaaaaa');
    // A failed page leaves it.
    s = ask(s, 'r2');
    s = play([page('s1', 'i1.aaaaaaaa', 'r2', [], null, 'read_failed')], s);
    expect(olderOfPane(pane(s))?.from).toBe('i1.aaaaaaaa');
    expect(withOlderFrom({ type: 'open_session', sessionId: 's1' }, s.panes)).toEqual({ type: 'open_session', sessionId: 's1', from: 'i1.aaaaaaaa' });
    expect(withOlderFrom({ type: 'open_session', sessionId: 's1', after: { epoch: 'e', seq: 1 } }, s.panes)).toMatchObject({ from: 'i1.aaaaaaaa' });
    expect(withOlderFrom({ type: 'open_session', sessionId: 's9' }, s.panes)).toEqual({ type: 'open_session', sessionId: 's9' });
    expect(withOlderFrom({ type: 'close_session', sessionId: 's1' }, s.panes)).toEqual({ type: 'close_session', sessionId: 's1' });
    // A history without `at` (an older server): nothing to send.
    s = play([history('s1', [user('c')], 'i2')], s);
    expect(withOlderFrom({ type: 'open_session', sessionId: 's1' }, s.panes)).toEqual({ type: 'open_session', sessionId: 's1' });
  });
});
