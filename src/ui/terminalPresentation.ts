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
export type PresentedItem = { item: ChatItem; steps: AssistantItem[]; quietModel: boolean; statusOverride?: ReplyStatus };

/** Lossless display grouping: keep each original record, its thinking, tools and provenance in order. */
export function presentTranscript(items: ChatItem[], busy = false, activeTurnId: string | null = null): PresentedItem[] {
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
  // An error belongs to the whole turn, even when commentary or model changes split its visible groups.
  // History has null IDs: user boundaries separate those turns. Explicit ID changes also start a fresh turn.
  let run: AssistantItem[] = [];
  const partial = new Set<AssistantItem>();
  const finish = (complete = true) => {
    if (complete && run.length && !run.some((it) => it.streaming) && run.some((it) => it.toolCalls.some((call) => call.isError))) {
      const final = run.at(-1)!;
      for (const it of run) if (it === final || replyStatus(it.text).status === 'SUCCESS') partial.add(it);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'user') {
      // Steering is a user bubble within the same explicit turn; only ID-less history splits here.
      if (run.at(-1)?.turnId == null) finish();
      continue;
    }
    if (item.kind !== 'assistant') continue;
    if (run.length && run.at(-1)!.turnId !== item.turnId) finish();
    run.push(item);
  }
  finish(!busy || (activeTurnId !== null && run.at(-1)?.turnId !== activeTurnId));
  for (const row of out) if (row.item.kind === 'assistant' && partial.has(row.item) && replyStatus(row.item.text).status !== 'BLOCKED') row.statusOverride = 'PARTIAL';
  // Earlier badges retain their source/usage popovers on hover and keyboard focus. A changed model stays visible.
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i]!.item;
    const b = out[i + 1]!.item;
    out[i]!.quietModel = a.kind === 'assistant' && b.kind === 'assistant' && sameRun(a, b) && !a.error;
  }
  return out;
}
