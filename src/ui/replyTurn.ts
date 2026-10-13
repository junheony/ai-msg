import { HANDOFF_PROMPT } from '../shared/handoff';
import { parseUserText } from './injected';
import type { ChatItem } from './state';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;

/** The user message a reply answers: its ordinal (`n`, the branch point) and its text as shown (the edit's `original`). */
export type ReplyTurn = { n: number; text: string };

type Index = { turns: Map<ChatItem, ReplyTurn | null>; byText: Map<string, Assistant[]> };
const cache = new WeakMap<ChatItem[], Index>();

function build(items: ChatItem[]): Index {
  const turns = new Map<ChatItem, ReplyTurn | null>();
  const byText = new Map<string, Assistant[]>();
  let user: ReplyTurn | null = null;
  let tail: Assistant | null = null;
  for (const it of items) {
    if (it.kind === 'user') {
      if (tail) turns.set(tail, user);
      tail = null;
      const text = parseUserText(it.text).text;
      // Like 편집: a message with text and a known position; attachments would not go with the branch, a handoff request is no turn of the user's.
      user = it.n !== undefined && text && !it.attachments?.length && it.text !== HANDOFF_PROMPT ? { n: it.n, text } : null;
    } else if (it.kind === 'assistant') {
      if (tail) turns.set(tail, null);
      tail = it;
      const same = byText.get(it.text);
      if (same) same.push(it); else byText.set(it.text, [it]);
    }
  }
  if (tail) turns.set(tail, user);
  return { turns, byText };
}

/** mergeToolRuns' copy of `orig`: every field the same object except the folded tool calls and the streaming flag. */
function foldedFrom(orig: Assistant, shown: Assistant): boolean {
  const keys = new Set([...Object.keys(orig), ...Object.keys(shown)]);
  for (const k of keys) {
    if (k === 'toolCalls' || k === 'streaming') continue;
    if ((orig as Record<string, unknown>)[k] !== (shown as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/**
 * 다시 생성: the user message `item` (a reply as the transcript shows it — possibly mergeToolRuns' copy) answers, when
 * `item` ends its turn (the last reply before the next user message) and that message could be edited into a branch.
 */
export function replyTurn(items: ChatItem[], item: ChatItem): ReplyTurn | null {
  if (item.kind !== 'assistant') return null;
  let idx = cache.get(items);
  if (!idx) { idx = build(items); cache.set(items, idx); }
  if (idx.turns.has(item)) return idx.turns.get(item) ?? null;
  for (const orig of idx.byText.get(item.text) ?? []) if (foldedFrom(orig, item)) return idx.turns.get(orig) ?? null;
  return null;
}
