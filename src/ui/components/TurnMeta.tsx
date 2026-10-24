import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronIcon } from './icons';
import { ui } from '../i18n';
import type { InjectedNotice } from '../injected';
import { roleSummary } from '../roles';
import type { ChatItem } from '../state';
import { groupLabel } from '../toolLabel';
import { modelLabelOf } from '../../shared/models';
import { RoleBadge, roleCountLabel } from './RoleBadge';
import { ToolCalls, awaitsAnswer, isQuestionCall, isSoloCall } from './ToolCallView';
import { useTurnBadge } from './TurnBadge';

type Assistant = Extract<ChatItem, { kind: 'assistant' }>;
type Cell = { key: string; node: ReactNode; panel?: ReactNode };

/** A task notice's status as the meta line words it: done / failed / stopped / running. */
function noticeTone(status: string): 'completed' | 'failed' | 'stopped' | 'running' | 'other' {
  if (status === 'completed' || status === 'failed' || status === 'running') return status;
  return status === 'killed' || status === 'stopped' ? 'stopped' : 'other';
}
const NOTICE_MARK: Record<ReturnType<typeof noticeTone>, string> = { completed: '✓', failed: '!', stopped: '■', running: '…', other: '·' };

/**
 * The calls the meta line's tools item folds: in 간결 모드 all but answered questions (their summary stays in the reply), else
 * all but file edits, subagents and answered questions (shown in the reply).
 */
export function foldedCalls(item: Assistant, concise: boolean) {
  return item.toolCalls.filter((c) => !(concise ? isQuestionCall(c) : isSoloCall(c)));
}

/**
 * The tools item's state while a reply streams: `running` when a call other than a pending question has no result yet,
 * `waiting` when the only open calls are questions waiting on the person (the turn is paused on its card).
 */
export function toolsState(calls: Assistant['toolCalls'], streaming: boolean): { running: boolean; waiting: boolean } {
  if (!streaming) return { running: false, waiting: false };
  const open = calls.filter((c) => c.result === null);
  const running = open.some((c) => !awaitsAnswer(c));
  return { running, waiting: !running && open.length > 0 };
}

/**
 * A reply's meta as one quiet line under it: model (or the turn pill) · thinking › · tools › · subagents › · background ✓ ›,
 * then the reply's actions. Each › item opens its detail under the line (thinking text, one row per call, the role chips,
 * the background task's result); Esc closes one panel at a time (the focused one, else the last opened). A reply with no text is just this line.
 */
export function TurnMeta({ item, turnEnd, repeatModel, notices, last, stopped, failed, concise, cwd, actions, hold, markdown }: {
  item: Assistant; turnEnd: boolean; repeatModel: boolean; notices: InjectedNotice[]; last: boolean; stopped: boolean; failed: boolean; concise: boolean; cwd?: string;
  /** The reply's action row (copy · retry · 다시 생성), kept at the end of the line. */
  actions: ReactNode;
  /** Keep the line even with no item (the actions alone). */
  hold: boolean;
  /** Renders markdown (MessageView's memoized Markdown): the thinking text, a task's result. */
  markdown: (text: string, className: string) => ReactNode;
}) {
  const T = ui().chat;
  const id = useId();
  const [open, setOpen] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggle = (key: string) => setOpen((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));
  const isOpen = (key: string) => open.includes(key);
  const panelId = (key: string) => `${id}-${key}`;
  // The turn pill's detail closes on a press anywhere outside the meta block (it reads like a popover).
  const badgeOpen = isOpen('badge');
  useEffect(() => {
    if (!badgeOpen) return;
    const outside = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen((o) => o.filter((k) => k !== 'badge')); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [badgeOpen]);
  const badge = useTurnBadge(
    item.badge
      ? { badge: item.badge, ...(item.model ? { model: item.model } : {}), stopped, failed, cacheNote: item.cacheNote ?? null, ctx: last ? (item.ctx ?? null) : null, repeat: repeatModel, inline: true }
      : null,
    badgeOpen, () => toggle('badge'), panelId('badge'),
  );

  /** A › item: a button naming what opens under the line. */
  const opener = (key: string, label: ReactNode, extra: { testId?: string; cls?: string; after?: ReactNode; title?: string } = {}) => (
    <button type="button" className={`meta-item${extra.cls ? ` ${extra.cls}` : ''}`} {...(extra.testId ? { 'data-testid': extra.testId } : {})} {...(extra.title ? { title: extra.title } : {})} aria-expanded={isOpen(key)} aria-controls={panelId(key)} onClick={() => toggle(key)}>
      {label}{extra.after}<ChevronIcon />
    </button>
  );
  const panel = (key: string, cls: string, body: ReactNode) => <div key={key} id={panelId(key)} className={`meta-panel ${cls}`} hidden={!isOpen(key)}>{body}</div>;

  const cells: Cell[] = [];
  if (item.badge) cells.push({ key: 'badge', node: badge.pill, panel: badge.detail });
  else if (item.model && turnEnd && !repeatModel) cells.push({ key: 'model', node: <span className="meta-model msg-model" data-testid="msg-model" title={item.model}>{modelLabelOf(item.model)}</span> });

  const streaming = item.streaming;
  const conciseLive = concise && streaming;
  const t = item.thinking;
  if (t && !(conciseLive && !t.text && !t.redacted)) {
    const secs = t.ms === null ? null : Math.max(1, Math.round(t.ms / 1000));
    const body = conciseLive ? '' : t.text.trim();
    const label = t.ms === null && streaming ? T.meta.thinking : secs !== null ? T.meta.thoughtFor(secs) : body ? T.meta.process : T.meta.thought;
    cells.push(body
      ? { key: 'thinking', node: opener('thinking', <span className="tool-label">{label}</span>, { testId: 'thinking' }), panel: panel('thinking', 'thinking-panel', markdown(body, 'markdown thinking-body')) }
      : { key: 'thinking', node: <span className={`turn-meta-text${conciseLive ? ' concise' : ''}`} data-testid="thinking">{label}</span> });
  }

  // A question still waiting on its card is not work done: it is left out of the count (and of the item when it is alone).
  // Only while the turn is live: a turn that ended without an answer keeps the question listed.
  const all = foldedCalls(item, concise);
  const calls = streaming ? all.filter((c) => !awaitsAnswer(c)) : all;
  if (calls.length) {
    const { running, waiting } = toolsState(all, streaming);
    const errors = calls.filter((c) => c.isError).length;
    // Waiting on the person (a question card is up): the line stops saying 계속 작업 중 and reads like a finished step.
    const liveLabel = conciseLive && !waiting;
    const label = liveLabel ? `${T.meta.live} · ${T.meta.step(item.toolCalls.filter((c) => !streaming || !awaitsAnswer(c)).length)}` : groupLabel(calls);
    const states = <>
      {running && <span className="tool-state running">{T.meta.running}</span>}
      {errors > 0 && <span className="tool-state error">{T.meta.errors(errors)}</span>}
    </>;
    cells.push({
      key: 'tools',
      node: opener('tools', <span className="tool-label" {...(liveLabel ? { 'aria-live': 'polite' as const } : {})}>{label}</span>, { testId: 'work-log', cls: running ? 'running' : '', after: states }),
      panel: panel('tools', 'work-log-body', <ToolCalls calls={all} live={streaming} cwd={cwd} flat />),
    });
  }

  const roles = roleSummary(item.toolCalls);
  const rolesLabel = roleCountLabel(roles);
  if (rolesLabel) cells.push({ key: 'roles', node: opener('roles', <span className="tool-label">{rolesLabel}</span>, { testId: 'roles' }), panel: panel('roles', 'roles-panel', <RoleBadge roles={roles} />) });

  notices.forEach((n, i) => {
    const tone = noticeTone(n.status);
    const key = `notice-${i}`;
    cells.push({
      key,
      node: opener(key, <span className="tool-label">{T.bg[tone]}</span>, { testId: 'meta-notice', cls: `notice ${tone}`, title: [n.label, n.summary].filter(Boolean).join(' · '), after: <span className="meta-mark" aria-hidden="true">{NOTICE_MARK[tone]}</span> }),
      panel: panel(key, 'sys-detail notice-panel', <>
        {n.summary && <div className="notice-summary">{n.summary}</div>}
        {n.body && markdown(n.body, 'markdown')}
        <details className="sys-raw"><summary>{T.bg.raw}</summary><pre>{n.raw}</pre></details>
      </>),
    });
  });

  if (!cells.length && !hold) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open.length) return;
    e.preventDefault();
    e.stopPropagation();
    // One panel per press: the one holding focus (or whose opener has it), else the one opened last.
    const target = e.target as Element;
    const key = open.find((k) => target.closest(`[id="${panelId(k)}"]`) || target.closest(`[aria-controls="${panelId(k)}"]`)) ?? open.at(-1)!;
    setOpen((o) => o.filter((k) => k !== key));
    rootRef.current?.querySelector<HTMLElement>(`[aria-controls="${panelId(key)}"]`)?.focus();
  };
  return (
    <div ref={rootRef} className="turn-foot" data-testid="turn-meta" onKeyDown={onKeyDown}>
      <div className="turn-meta" role="group" aria-label={T.meta.label}>
        {cells.map((c, i) => (
          <span key={c.key} className="meta-cell">
            {i > 0 && <span className="meta-sep" aria-hidden="true">·</span>}
            {c.node}
          </span>
        ))}
        {actions}
      </div>
      {cells.map((c) => c.panel && <Fragment key={c.key}>{c.panel}</Fragment>)}
    </div>
  );
}

