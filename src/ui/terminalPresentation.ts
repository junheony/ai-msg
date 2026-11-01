import type { ChatItem } from './state';

export type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;
export type ReplyStatus = 'SUCCESS' | 'PARTIAL' | 'BLOCKED';

/** Leading uppercase report markers, including the owner's bare-marker Korean report convention. */
export function replyStatus(text: string): { status: ReplyStatus | null; text: string } {
  const match = /^(?:\*\*(SUCCESS|PARTIAL|BLOCKED)(?:[.:：])?\*\*(?=\s|[.:：—–]|$)[.:：]?|(?:(SUCCESS|PARTIAL|BLOCKED)(?:[.:：]|\s+[—–])(?=\s|$))|(?:(SUCCESS|PARTIAL|BLOCKED)(?=\s+[가-힣]|\s*$)))(?:[ \t]*[—–][ \t]+|[ \t]*\n|[ \t]*)/.exec(text);
  return match ? { status: (match[1] ?? match[2] ?? match[3]) as ReplyStatus, text: text.slice(match[0].length) } : { status: null, text };
}

/** Display text only: retain the useful words of links/emphasis, never raw markdown chrome. */
export function sessionPreview(text: string | undefined): { status: ReplyStatus | null; text: string } {
  const parsed = replyStatus(text?.trim() ?? '');
  return {
    status: parsed.status,
    text: parsed.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(^|\n)\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/g, '$1')
      .replace(/\*\*|__|~~/g, '')
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, '$1$2')
      .replace(/\s+/g, ' ').trim(),
  };
}

export const hasActivity = (it: AssistantItem) => !!it.thinking || it.toolCalls.length > 0;
const activityOnly = (it: ChatItem): it is AssistantItem => it.kind === 'assistant' && hasActivity(it)
  && !it.text && !it.error && !it.badge && !it.notes.length && !it.attempts.length;
const sameRun = (a: AssistantItem, b: AssistantItem) => a.turnId === b.turnId && a.model === b.model;
export type PresentedItem = { item: ChatItem; steps: AssistantItem[]; quietModel: boolean };

/** Lossless display grouping: keep each original record, its thinking, tools and provenance in order. */
export function presentTranscript(items: ChatItem[]): PresentedItem[] {
  const out: PresentedItem[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    if (item.kind === 'assistant' && !item.error && !item.notes.length && !item.attempts.length
      && prev && activityOnly(prev.item) && sameRun(prev.item, item)) {
      prev.steps.push(...(hasActivity(item) ? [item] : []));
      prev.item = item;
    } else {
      out.push({ item, steps: item.kind === 'assistant' && hasActivity(item) ? [item] : [], quietModel: false });
    }
  }
  // Earlier badges retain their source/usage popovers on hover and keyboard focus. A changed model stays visible.
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!.item;
    const b = out[i + 1]!.item;
    out[i]!.quietModel = a.kind === 'assistant' && b.kind === 'assistant' && sameRun(a, b) && !a.error;
  }
  return out;
}
