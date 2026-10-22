import { describe, expect, it } from 'vitest';
import { turnMetaProps } from './turnMeta';
import type { ChatItem } from './state';

const reply = (model: string | undefined, text = 'ok'): ChatItem => ({ kind: 'assistant', turnId: null, text, ...(model ? { model } : {}), toolCalls: [], badge: null, streaming: false, error: null, notes: [], attempts: [] });
const notice = '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>tests ran</summary>\n</task-notification>';

describe('turnMetaProps', () => {
  it('a notice-only user row right before a reply moves into that reply\'s meta line', () => {
    const items: ChatItem[] = [{ kind: 'user', text: notice }, reply('claude-opus-5-5')];
    const out = turnMetaProps(items, [true, true]);
    expect(out[0]).toEqual({ absorbed: true });
    expect(out[1]!.notices?.map((n) => n.kind)).toEqual(['task']);
  });

  it('a notice row with typed text, or with no reply after it, stays where it is', () => {
    const typed: ChatItem[] = [{ kind: 'user', text: `${notice}\n이것도 봐줘` }, reply('claude-opus-5-5')];
    expect(turnMetaProps(typed, [true, true])[0]).toEqual({});
    const alone: ChatItem[] = [reply('claude-opus-5-5'), { kind: 'user', text: notice }];
    expect(turnMetaProps(alone, [true, true])[1]).toEqual({});
  });

  it('a turn on the model the turn before named leaves the name out; a change names it again', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'a' }, reply('claude-opus-5-5'),
      { kind: 'user', text: 'b' }, reply('claude-opus-5-5', 'mid'), reply('claude-opus-5-5'),
      { kind: 'user', text: 'c' }, reply('claude-sonnet-5-5'),
      { kind: 'user', text: 'd' }, reply('claude-opus-5-5'),
    ];
    const ends = [true, true, true, false, true, true, true, true, true];
    const out = turnMetaProps(items, ends);
    expect(out.map((o) => !!o.repeatModel)).toEqual([false, false, false, false, true, false, false, false, false]);
  });
});
