import { parseUserText, type InjectedNotice } from './injected';
import { modelLabelOf } from '../shared/models';
import type { ChatItem } from './state';

/** Per shown item, what the chat adds to MessageView so a reply's meta reads as one quiet line. */
export type TurnMetaProps = {
  /** A user row that is only background-task notices, shown in the next reply's meta line instead. */
  absorbed?: true;
  /** The notices that reply shows ("백그라운드 완료 ✓ ›"). */
  notices?: InjectedNotice[];
  /** The reply names the same model as the reply shown before it: the line leaves the name out. */
  repeatModel?: true;
};

const taskOnly = new WeakMap<ChatItem, InjectedNotice[] | null>();
/** The task notices of a user row that has nothing else to show (no typed text, no attachments); cached per item. */
function taskNotices(it: ChatItem): InjectedNotice[] | null {
  if (it.kind !== 'user') return null;
  if (taskOnly.has(it)) return taskOnly.get(it)!;
  const { text, notices } = parseUserText(it.text);
  const only = !text && !it.attachments?.length && notices.length > 0 && notices.every((n) => n.kind === 'task') ? notices : null;
  taskOnly.set(it, only);
  return only;
}

/**
 * `ends[i]`: item i is the last reply block of its turn (only that one names the model). The model counts as repeated when
 * the previous reply that named one named the same model.
 */
export function turnMetaProps(items: ChatItem[], ends: boolean[]): TurnMetaProps[] {
  const out: TurnMetaProps[] = items.map(() => ({}));
  let lastModel: string | null = null;
  items.forEach((it, i) => {
    const notices = taskNotices(it);
    if (notices && items[i + 1]?.kind === 'assistant') {
      out[i] = { absorbed: true };
      out[i + 1] = { notices };
    }
    if (it.kind !== 'assistant') return;
    const model = it.model ?? it.badge?.model;
    if (!model || !(ends[i] ?? true)) return;
    const label = modelLabelOf(model);
    if (label === lastModel) out[i] = { ...out[i], repeatModel: true };
    lastModel = label;
  });
  return out;
}
