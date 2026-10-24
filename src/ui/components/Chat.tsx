import { loadDraft, saveDraft } from '../autoReload';
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { timeDividers, timeLabel } from '../dateGroups';
import { CLAUDE_MODELS, CODEX_MODELS, DEFAULT_SANDBOX, GEMINI_MODELS, GROK_MODELS, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../../shared/models';
import type { Account, Seat } from '../../shared/accounts';
import type { GeminiStatus, GrokStatus } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { PermissionDecision, QuestionAnswers, TurnPhase } from '../../shared/turn-types';
import type { AgentInfo, ChatItem, PaneBackground, PendingPermission, PendingQuestion, QueueItem, UploadedAttachment } from '../state';
import { latestContext } from '../context';
import { has } from '../features';
import { latestTodos } from '../todos';
import { useStickToBottom, viewAnchor } from '../stickToBottom';
import { mergeToolRuns } from '../toolRuns';
import { turnMetaProps } from '../turnMeta';
import { ATTACHMENT_ONLY_TEXT, filesFrom, replaceAttachment, uploadFile, usePasteUploads, type UploadFn } from '../upload';
import { AgentContext, BackgroundPill, StatusRow, turnPauses, type AgentCtx } from './Activity';
import { useAccounts } from '../accounts';
import { conciseFirstStep } from '../../shared/concise';
import { parseBgCommand, type TaskInfo } from '../../shared/tasks';
import { TaskCards } from './TaskCards';
import { AttachmentBar } from './AttachmentBar';
import { Composer } from './Composer';
import { SessionChip } from './SessionChip';
import { isMacPlatform } from '../shortcuts';
import { ContextHint } from './ContextGauge';
import { useComposerSuggest } from './ComposerSuggest';
import { HANDOFF_COMMAND, HANDOFF_PROMPT, isThreadLocked } from '../../shared/handoff';
import { PERM_MODE_LABEL, nextPermMode, permModeHint, type PermMode } from '../../shared/permission';
import { useIsPhone } from '../useIsPhone';
import { HeadItem, SessionChipHead, type HeadGrip, type HeadGroup, type HeadMenuCtl, type HeadMenuItem } from './SessionChipHead';
import type { CommandItem } from '../autocomplete';
import { MessageActionsContext, MessageView, RegenerateContext, type MessageActions, type Regenerate } from './MessageView';
import { FIND_EVENT, FindBar } from './FindBar';
import type { ReplyTurn } from '../replyTurn';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { QueueChips } from './QueueChips';
import { useShareActions } from './ShareMenu';
import { TodoPanel } from './TodoPanel';
import { usePrefs } from '../usePrefs';
import { BlockedDeleteItem } from './SessionMenu';
import { useAutoGrow } from '../useAutoGrow';
import { FAST_TITLE, requestFast, useFast } from '../fastMode';
import { ui } from '../i18n';

export type ChatProps = {
  items: ChatItem[];
  pending: PendingPermission[];
  questions: PendingQuestion[];
  activeTurnId: string | null;
  busy: boolean;
  title: string;
  /** The title ⌄ menu (the sidebar ⋯ actions; `deleteBlocked` = 삭제 shown disabled with this reason). Absent = the caret is decoration. */
  titleMenu?: { pinned: boolean; archived: boolean; onRename?: (title: string | null) => void; onTogglePin?: () => void; onArchive?: () => void; onDelete?: () => void; deleteBlocked?: string | null; /** 작업 폴더 바꾸기 / 복제 (servers with 'sessionOps'). */ onSetCwd?: () => void; onDuplicate?: () => void };
  /** Session folder: the header shows its last segment as a chip, the full path on hover. */
  cwd?: string;
  /** For `/` command suggestions (null while the session is new). */
  sessionId?: string | null;
  /** Right-side head buttons (a floating card's – / ▭ and ✕). */
  headActions?: ReactNode;
  /** Extra head chips from the pane (갈라짐, 총사령탑), after the session's own. */
  headChips?: ReactNode;
  /** The pane's rows in the session chip's menu, by group (no group = 보기). */
  headMenu?: HeadMenuItem[];
  /** The top bar's slot: the session chip renders there (one pane / the phone's shown pane). */
  headSlot?: Element | null;
  /** The pane's drag handle, carried by the session chip (and its tooltip line). */
  headGrip?: HeadGrip;
  headGripTitle?: string;
  /** The pane id on the head (`data-pane-head`). */
  headPaneId?: string;
  model: ModelChoice;
  /** Reasoning effort for `model`'s engine; null = 자동 (model 자동 only). */
  effort: Effort | null;
  /** New-session choices (D2, D3). */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  /** The open session's engine/sandbox (null until known); ignored while the session is new (PF11). */
  sessionEngine: EngineKind | null;
  sessionSandbox: CodexSandbox | null;
  isNew: boolean;
  codexAvailable: boolean;
  /** null = no gemini-cli: no Gemini option. Not logged in: the option is shown disabled with 로그인 필요. */
  gemini?: GeminiStatus | null;
  /** hello.grok; null = an older server that knows no Grok: no Grok option. Known but no CLI: shown disabled (설치 필요). */
  grok?: GrokStatus | null;
  attachments: UploadedAttachment[];
  uploadFn?: UploadFn;
  onSend: (text: string) => void;
  /** Sends `text` alone: the composer's attachments stay for the user's own next message (a 선택지 click). Absent: onSend. */
  onSendText?: (text: string) => void;
  /** ⚡ 표준으로 다시 보내기: sends `text` without fast (noFast), the ↯ switch left as it is. Absent: no such button. */
  onSendStandard?: (text: string) => void;
  /** 백그라운드 작업 ('tasks' servers): `/bg <text>` or 작업으로 starts `text` as a new session in this folder. False = not sent (the draft stays). */
  onStartTask?: (text: string) => boolean | void;
  /** This chat's tasks (newest first) and the soft cap. */
  tasks?: TaskInfo[];
  taskCap?: number | null;
  onOpenTask?: (t: TaskInfo) => void;
  onDismissTask?: (taskId: string) => void;
  /** 취소 on a waiting or running task card. */
  onCancelTask?: (taskId: string) => void;
  onInterrupt: () => void;
  /** 취소 on 시작하는 중… (busy, no turn yet): stop waiting; the text goes back into the composer. */
  onCancelStart?: () => void;
  /** Stops the background work held by that turn's process (interrupt by its turn id). */
  onStopBackground?: (turnId: string) => void;
  /** Stops one background task (Query.stopTask). */
  onStopTask?: (taskId: string) => void;
  /** Status row: when the running turn started (client clock), its output tokens and phase. */
  runStartedAt?: number | null;
  /** The pending send waits in the server behind a streaming segment (turn_queued.behind): the status row says so instead of 시작하는 중…. */
  awaitingBehind?: string | null;
  progress?: { outputTokens: number; phase: TurnPhase } | null;
  /** Concise-mode routing ack (from turn_started). */
  turnRoute?: { model: string; engine: string; account: string; reason: string } | null;
  /** Subagent cards by Agent call id; the background pill. */
  agents?: Record<string, AgentInfo>;
  bg?: PaneBackground | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  /** An existing GPT session ('sessionSandbox' servers): its sandbox chip becomes a picker; absent = a read-only tag. */
  onSessionSandbox?: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
  /** An edited image replaces attachment `id` (uploaded; its old preview already released); absent = no image editor. */
  onReattach?: (id: string, a: UploadedAttachment) => void;
  /** 이 세션은 B 써 (Claude sessions): the pinned account (null = 자동), the account it runs on, usage for the menu. */
  accountPin?: Account | null;
  account?: Seat | null;
  usage?: UsageSnapshot | null;
  /** Absent = no account picker. */
  onAccountPin?: (pin: Account | null) => void;
  /** Claude permission mode (Shift+Tab cycles); absent onPermMode = no mode picker. */
  permMode?: PermMode;
  onPermMode?: (m: PermMode) => void;
  /** ux-state: while busy, a submit queues the message (absent = the composer can't send while busy). */
  queue?: QueueItem[];
  queuePaused?: boolean;
  onQueue?: (text: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
  onQueueResume?: () => void;
  /** 지금 전송: interrupt the running turn and send this queued item right away (absent = no such action). */
  onQueueSendNow?: (id: string) => void;
  /** 메시지 편집 갈래: send `text` in place of user message `n` (shown as `original`). Absent = 편집 fills the composer instead. */
  onBranch?: (n: number, text: string, original: string) => void;
  /** Why 편집 fills the composer instead of branching (tooltip); null = it branches. */
  editNote?: string | null;
  /** The versions of user message `n` (`< i/N >`); null = one version only. */
  versions?: (n: number) => { index: number; count: number; go: (i: number) => void } | null;
  /** 새 세션으로 이어가기 (absent = not offered: new / GPT / Gemini session, or a turn running). Also `/handoff`. */
  onHandoff?: () => void;
  /** deck 에서 새 GPT 세션으로 이어가기: offered under a GPT turn the thread lock refused (another app holds the thread). */
  onCodexHandoff?: (turnId: string) => void;
  /** A read-only Grok Bot app conversation: opens a deck Grok session prefilled with an excerpt (nothing is sent). */
  onGrokBotHandoff?: () => void;
  /** 작업 폴더 바꾸기 under the composer note (the Grok Bot handoff's new session, before its first send). */
  onPickCwd?: () => void;
  /** The handoff-note turn is running. */
  handoffWriting?: boolean;
  /** Text put into the composer once (the new session's first message after a handoff); not sent. Never over a draft. */
  prefill?: string | null;
  /** Where the draft of a session with no id yet is kept (per pane), so a remount or reload does not lose it. */
  draftKey?: string;
  /** 새 세션으로 이어가기 links: the session this one continues / continues in. */
  prevSession?: { title: string; open: () => void } | null;
  nextSession?: { title: string; open: () => void } | null;
  /** 한도가 풀리면 자동으로 이어가기: the booked resume (epoch ms) and its 취소. Absent/null = none booked. */
  autoResume?: { atMs: number; onCancel: () => void } | null;
  /**
   * 'olderHistory': paging back. `cursor` null = the items start at the conversation's beginning (the end marker);
   * `loading` = a page is on its way; `failed` = the last one could not be read. Absent: no paging (nothing shown).
   */
  older?: { cursor: string | null; loading: boolean; failed: boolean; onLoad: () => void } | null;
  /** Notes / errors about this session no turn owns (e.g. it was just written outside deck): dismissible bars above the transcript. */
  notices?: { message: string; level: 'notice' | 'error' }[];
  onDismissNotice?: (message: string) => void;
  /** The server held the first message back: the engine this turn landed on can't do what it asks (route_fit). */
  routeFit?: { engine: string; need: string } | null;
  onRouteFit?: (how: 'send' | 'dismiss') => void;
  /** View-only session (e.g. an imported Codex thread whose folder is gone): the composer is disabled and shows this reason. */
  readOnly?: string | null;
  /** A line above the composer (the server will refuse a send here, and says why itself). */
  composerNote?: string | null;
  /** The session's history is on its way: a placeholder instead of a blank transcript. */
  loading?: boolean;
  /** The socket is up (absent = yes): queue chips say whether a held message waits for a reconnect or a restart. */
  connected?: boolean;
  /** Claude's guess at the next prompt (prompt_suggestion): ghost text in the empty composer, Tab / 추천 채우기 puts it in. */
  suggestion?: string | null;
};

const HANDOFF_COMMANDS: CommandItem[] = [{ name: HANDOFF_COMMAND, description: '새 세션으로 이어가기 (인계 메모를 쓰고 새 세션에 붙여 넣기)', argumentHint: '' }];

/** The model picker's choices for an engine (자동 offered for Claude and the engine 자동; Gemini / Grok only when picked). */
export function modelChoices(engine: EngineChoice): readonly ModelChoice[] {
  return engine === 'gemini' ? GEMINI_MODELS : engine === 'grok' ? GROK_MODELS : engine === 'codex' ? CODEX_MODELS : engine === 'claude' ? ['auto', ...CLAUDE_MODELS] : ['auto', ...CLAUDE_MODELS, ...CODEX_MODELS];
}

/** The send keys live on the 보내기 button's tooltip. */
export const SEND_TITLE = '보내기 (Enter · Shift+Enter 줄바꿈)';
export const SEND_TITLE_MOD = '보내기 (⌘Enter · Enter 줄바꿈)';
/**
 * The idle placeholder: plain "메시지 보내기". The session's name is not in it — a default name carries the folder
 * ("deck · 새 세션"), and "{이름}에게" reads oddly for a session.
 */
export function composerPlaceholder(): string {
  return ui().chat.placeholder;
}

/** Enter inserts a newline on touch screens (send with the button), as on Desktop's mobile apps. */
const COARSE_QUERY = '(pointer: coarse), (hover: none)';
function useCoarsePointer(): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  const [coarse, setCoarse] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(COARSE_QUERY);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

/**
 * On a touch device, is the on-screen keyboard up right now? An iPad (or a phone) with a hardware keyboard reports
 * a coarse pointer too, but shows no soft keyboard, so the visual viewport keeps its full height. We track the tallest
 * viewport seen at the current width (an orientation/split change resets it) and call the keyboard "up" when the
 * viewport is clearly shorter than that. No visualViewport → assume a soft keyboard (the old behaviour).
 */
let vvWidth = 0;
let vvMax = 0;
function trackViewport(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const w = Math.round(vv.width * vv.scale);
  if (w !== vvWidth) { vvWidth = w; vvMax = 0; }
  vvMax = Math.max(vvMax, vv.height);
  syncSoftKeyboardAttr();
}
/**
 * CSS hook `<html data-soft-kb>`: with the on-screen keyboard up the composer drops its home-indicator inset
 * (styles.css "bottom edge"). Measured against the layout viewport, not the tallest height seen: an iOS keyboard
 * shrinks only the visual viewport, while a pinch-zoom (height × scale stays put) or a Stage Manager / split
 * resize (the layout viewport shrinks with it) is not a keyboard and never leaves the attribute stuck on.
 */
export function syncSoftKeyboardAttr(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const vv = window.visualViewport;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  const layout = document.documentElement.clientHeight;
  const up = !!vv && coarse && layout > 0 && vv.height * vv.scale < layout * 0.8;
  document.documentElement.toggleAttribute('data-soft-kb', up);
}
if (typeof window !== 'undefined' && window.visualViewport) {
  trackViewport();
  window.visualViewport.addEventListener('resize', trackViewport);
}
export function softKeyboardUp(): boolean {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return true;
  trackViewport();
  return vvMax > 0 && vv.height < vvMax * 0.8;
}

/** Enter = newline right now? (a touch screen with its on-screen keyboard up). Read at keydown time. */
export function touchEnterIsNewline(): boolean {
  const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  return coarse && softKeyboardUp();
}

const NO_AGENTS: Record<string, AgentInfo> = {};

/**
 * React keys for the shown items that survive a history reload (cached items → the server's list, the same session
 * reopened): transcript items carry no ids, so each is keyed by the last user message's ordinal (`n`, unique per session)
 * plus its offset after it. A row added or dropped in one turn moves only that turn's keys, so an expanded card
 * (<details>, edit box) further down keeps its state. An item's key never changes while it streams.
 */
/** The newest user message's text (간결 모드 ack: its first step). */
export function lastUserText(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) { const it = items[i]!; if (it.kind === 'user') return it.text; }
  return null;
}

/** 'olderHistory': scrolled up to within this many px of the top, the page before is asked for. */
const OLDER_NEAR_TOP = 240;

export function messageKeys(items: ChatItem[]): string[] {
  const used = new Set<string>();
  let anchor = '^';
  let k = 0;
  return items.map((it) => {
    if (it.kind === 'user' && it.n !== undefined && !used.has(`u${it.n}`)) {
      anchor = `u${it.n}`;
      k = 0;
      used.add(anchor);
      return anchor;
    }
    return `${anchor}+${++k}`;
  });
}

/** An epoch ms as this device's local H:MM (24h), e.g. 1:40 — with M/D before it when that is not today, e.g. 10/25 14:20. */
const clockOf = (ms: number, now = new Date()): string => {
  const d = new Date(ms);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

const WarnIcon = () => <svg className="perm-badge-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.2 14.3 13.3H1.7z" /><path d="M8 6.6v3M8 11.6v.1" /></svg>;
const TaskIcon = () => <svg className="task-add-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h4v4M13 3 7.5 8.5" /><path d="M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" /></svg>;

export function Chat(p: ChatProps) {
  const accountNames = useAccounts();

  const draftKey = p.sessionId ?? p.draftKey ?? null;
  const [text, setText] = useState(() => loadDraft(draftKey));
  // The pane switched sessions: show that session's draft, not the previous one's. Done during render so the save
  // effect below never writes the old text under the new id. A new session getting its id (null → id) keeps the text.
  const [draftId, setDraftId] = useState(p.sessionId);
  if (draftId !== p.sessionId) {
    setDraftId(p.sessionId);
    if (draftId) setText(loadDraft(draftKey));
  }
  useEffect(() => { saveDraft(draftKey, text); }, [draftKey, text]);
  // The session has its id now: its draft lives under the id; the id-less one is spent.
  useEffect(() => { if (p.sessionId && p.draftKey) saveDraft(p.draftKey, ''); }, [p.sessionId, p.draftKey]);
  // Only into an empty composer: a remount must not put the original note back over the user's edits.
  useEffect(() => { if (p.prefill) setText((t) => (t.trim() ? t : p.prefill!)); }, [p.prefill]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Desktop: the composer grows with the text up to the CSS max-height (40vh) and shrinks back after a send.
  const bodyRef = useRef<HTMLDivElement>(null);
  useAutoGrow(taRef, text, bodyRef);
  const content = useMemo(() => ({}), [p.items, p.pending, p.questions]);
  const shown = useMemo(() => mergeToolRuns(p.items), [p.items]);
  const keys = useMemo(() => messageKeys(shown), [shown]);
  // The jump pill counts user / assistant turns after the one last on screen when the view detached (by key: a card
  // going away or a catchup rebuild does not skew it; a reply growing while it streams is not new).
  const turnKeys = useMemo(() => keys.filter((_, i) => shown[i]!.kind === 'user' || shown[i]!.kind === 'assistant'), [keys, shown]);
  const scroll = useStickToBottom(bodyRef, content, p.sessionId, turnKeys);
  // 'olderHistory': scrolling up to near the top asks for the page before (the button at the top is the fallback).
  const older = p.older;
  const olderLoad = useRef<(() => void) | null>(null);
  olderLoad.current = older && older.cursor !== null && !older.loading && !older.failed && p.items.length > 0 ? older.onLoad : null;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => { if (el.scrollTop < OLDER_NEAR_TOP && el.scrollHeight > el.clientHeight) olderLoad.current?.(); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // The items change while scrolled up; read off the DOM during render, while it still shows the old items:
  // - a page put in front (the old items are the new ones' tail, the same objects): what is below the page stays put,
  //   so scrollTop grows by exactly how much the content grew (its keys may be positional, e.g. Codex / Grok items or
  //   ones before the first prompt, so the DOM nodes are no anchor). Whether detached or not: the user is at the top.
  // - else (a history replacing them — the same messageKeys keep their DOM nodes): the item at the view's top is put
  //   back where it was. Lines that come and go with the change (loading, time stamps) are no anchor. Only how far
  //   that item moved goes into scrollTop, so growth below it and native scroll anchoring having moved it change nothing.
  const itemsAnchor = useRef<{ items: ChatItem[]; at: { el: Element; offset: number } | null; grew: { height: number; top: number } | null }>({ items: p.items, at: null, grew: null });
  if (itemsAnchor.current.items !== p.items) {
    const prev = itemsAnchor.current.items;
    const el = bodyRef.current;
    const tail = p.items.length - prev.length;
    const prepended = !!el && prev.length > 0 && tail > 0 && p.items[tail] === prev[0] && p.items[p.items.length - 1] === prev[prev.length - 1];
    itemsAnchor.current = {
      items: p.items,
      grew: prepended ? { height: el.scrollHeight, top: el.scrollTop } : null,
      at: !prepended && scroll.detached && el ? viewAnchor(el, (e) => e.matches('.older-line, .older-more, .msg-time, .chat-refreshing')) : null,
    };
  }
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const { at: a, grew } = itemsAnchor.current;
    itemsAnchor.current.at = null;
    itemsAnchor.current.grew = null;
    if (!el) return;
    if (grew) {
      el.scrollTop = grew.top + (el.scrollHeight - grew.height);
      return;
    }
    if (!a || !a.el.isConnected) return;
    const moved = a.el.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
    if (Math.abs(moved) > 0.5) el.scrollTop += moved;
  }, [p.items]);
  // A question / approval card waits for the user: the status line, the composer and the stop button say so (Q2).
  const waitingFor = p.questions.length > 0 ? 'question' as const : p.pending.length > 0 ? 'permission' as const : null;
  // Q1: a newly shown card taller than the view opens at its head, not at its bottom (scroll.revealTop decides).
  // The turn ended: drop its set-aside wait time (StatusRow keeps it across remounts while the turn runs).
  const runStart = useRef<number | null>(null);
  useEffect(() => {
    if (p.busy && p.runStartedAt != null) runStart.current = p.runStartedAt;
    else if (!p.busy && runStart.current !== null) { turnPauses.delete(runStart.current); runStart.current = null; }
  }, [p.busy, p.runStartedAt]);
  const seenCards = useRef(new Set<string>());
  const revealTop = scroll.revealTop;
  useLayoutEffect(() => {
    const ids = [...p.pending.map((r) => r.requestId), ...p.questions.map((q) => q.requestId)];
    const fresh = ids.find((id) => !seenCards.current.has(id));
    seenCards.current = new Set(ids);
    if (!fresh) return;
    const card = [...(bodyRef.current?.querySelectorAll<HTMLElement>('[data-await-card]') ?? [])].find((el) => el.dataset.awaitCard === fresh);
    if (card) revealTop(card);
  }, [p.pending, p.questions, revealTop]);
  // Read-only: no paste / drop / 첨부 uploads either. Long text pastes become 붙여넣은 텍스트 chips (pasted-N.txt).
  // The live attachment list for ImageEditor's 완료 (its upload may outlast this render).
  const attachmentsRef = useRef(p.attachments);
  attachmentsRef.current = p.attachments;
  const { addFiles, onPaste, uploading, error, pastedTexts, uploadOne } = usePasteUploads({ uploadFn: p.uploadFn ?? uploadFile, attachments: p.attachments, onUploaded: p.onAttach, onUploadFailed: (t) => setText((v) => v + t), disabled: !!p.readOnly });
  const coarse = useCoarsePointer();
  // Set between compositionstart/end: some browsers report isComposing late or not at all.
  const composing = useRef(false);
  // A session switch mid-composition may never deliver its compositionend here: start the next session clean.
  useEffect(() => { composing.current = false; }, [p.sessionId]);
  const dividers = useMemo(() => timeDividers(shown), [shown]);
  // A reply block ends its turn when no other reply follows before the next user message (system rows are skipped).
  const turnEnds = useMemo(() => {
    const ends: boolean[] = [];
    let after = true;
    for (let i = shown.length - 1; i >= 0; i--) {
      const it = shown[i]!;
      ends[i] = after;
      if (it.kind === 'user') after = true;
      else if (it.kind === 'assistant') after = false;
    }
    return ends;
  }, [shown]);
  // Background notices fold into the next reply's meta line; a model named just before is not named again.
  const meta = useMemo(() => turnMetaProps(shown, turnEnds), [shown, turnEnds]);
  const todos = useMemo(() => latestTodos(p.items), [p.items]);

  // Review M12: a failed last turn can be re-sent as-is.
  const last = p.items.at(-1);
  const lastPrompt = ([...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null;
  // Never a handoff-note request: re-sending it would run the note prompt as a plain turn (tools allowed, no switch).
  const retryable = lastPrompt !== HANDOFF_PROMPT ? lastPrompt : null;
  const retryPrompt = !p.busy && !p.readOnly && last?.kind === 'assistant' && last.error !== null && !last.streaming ? retryable : null;
  const lockedTurn = !p.busy && !p.readOnly && p.sessionEngine === 'codex' && last?.kind === 'assistant' && last.error !== null && !last.streaming && isThreadLocked(last.errorCode, last.error) ? last.turnId : null;
  // ⚡ A fast turn refused for fast mode / credits: the same prompt again at standard speed (the switch goes off first).
  const fastRefused = retryPrompt !== null && !!p.onSendStandard && last?.kind === 'assistant' && last.errorCode === 'fast_refused';

  // D3 / PF11: a new session follows the picker (the engine recorded at open time is ignored while it is new);
  // once the session exists its engine is fixed.
  const effectiveEngine: EngineChoice = p.isNew ? p.engine : (p.sessionEngine ?? 'claude');
  // 자동 is offered for Claude (and the engine 자동, which may open on Claude); on an existing session it keeps the session's model.
  // Gemini is explicit only: its models appear only when the Gemini engine is picked (never under 자동).
  const models = modelChoices(effectiveEngine);
  // A new session's sandbox row follows its engine picker (shown only when another engine than Claude is available).
  const engineSelect = p.isNew && (p.codexAvailable || !!p.gemini?.available || has('grok'));
  const hasDraft = (text.trim().length > 0 || p.attachments.length > 0) && uploading === 0;
  const queueing = p.busy && !!p.onQueue;
  /** A running Claude / Grok turn takes a message mid-turn (Codex / Gemini: after the turn). */
  const steering = queueing && !!p.activeTurnId && (p.sessionEngine === 'claude' || p.sessionEngine === 'grok');
  const canSend = hasDraft && !p.readOnly && (!p.busy || queueing);
  // Mid-turn the main button becomes 보내기 only when the send can really happen; otherwise it stays 중단.
  const runSend = !!p.activeTurnId && queueing && canSend;
  const taskReady = !!p.onStartTask && hasDraft && p.attachments.length === 0 && parseBgCommand(text) === null;
  const live = last?.kind === 'assistant' && last.streaming ? last : null;
  const agents = p.agents ?? NO_AGENTS;
  const bgLive = !!p.bg;
  const turnActive = p.activeTurnId !== null;
  const agentCtx = useMemo<AgentCtx>(() => ({ agents, bgLive, active: turnActive }), [agents, bgLive, turnActive]);
  const suggest = useComposerSuggest({ text, setText, textareaRef: taRef, cwd: p.cwd, sessionId: p.sessionId ?? null, commands: effectiveEngine !== 'codex', ...(p.onHandoff ? { extraCommands: HANDOFF_COMMANDS } : {}) });
  const ctx = useMemo(() => latestContext(p.items), [p.items]);
  // The last reply's pill carries the cache-expiry dot (TurnBadge ctx); the line above the composer is left for when it cannot.
  const lastItem = shown[shown.length - 1];
  const pillCold = lastItem?.kind === 'assistant' && !!lastItem.badge && !!lastItem.ctx && lastItem.ctx === ctx;
  // Message actions: 편집 puts the text back in the composer (sent as a new turn); 재시도 re-sends the last prompt.
  // Stable across keystrokes (refs) so the memoized transcript does not re-render while typing.
  const onSendRef = useRef(p.onSend);
  onSendRef.current = p.onSend;
  const onSendTextRef = useRef(p.onSendText ?? p.onSend);
  onSendTextRef.current = p.onSendText ?? p.onSend;
  const onBranchRef = useRef(p.onBranch);
  onBranchRef.current = p.onBranch;
  const canBranch = !!p.onBranch;
  const canReply = !p.busy && !p.readOnly;
  const canRetry = !p.busy && !p.readOnly && retryPrompt === null && retryable !== null && last?.kind === 'assistant';
  // 'historyImages': a Claude session's transcript images load from the server (thumbnails instead of the count pill).
  const historySession = has('historyImages') && p.sessionId && (p.sessionEngine ?? 'claude') === 'claude' ? p.sessionId : null;
  const msgActions = useMemo<MessageActions>(() => ({
    onEdit: (t) => {
      setText(t);
      requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(t.length, t.length); } });
    },
    ...(canRetry && retryable !== null ? { onRetry: () => { onSendRef.current(retryable); scroll.attach(); } } : {}),
    ...(canBranch ? { onBranch: (n: number, t: string, original: string) => { onBranchRef.current?.(n, t, original); scroll.attach(); } } : {}),
    editNote: p.editNote ?? null,
    ...(p.versions ? { versions: p.versions } : {}),
    coarse,
    ...(canReply ? { onReply: (t: string) => { onSendTextRef.current(t); scroll.attach(); } } : {}),
    ...(historySession ? { historyImage: (n: number, k: number) => `/api/sessions/${encodeURIComponent(historySession)}/images/${n}/${k}` } : {}),
  }), [canRetry, retryable, scroll.attach, canBranch, p.editNote, p.versions, coarse, canReply, historySession]);
  // 다시 생성 / 다른 모델로 (Pane's context): the new turn is followed from the bottom, as after a send.
  const paneRegen = useContext(RegenerateContext);
  const regen = useMemo<Regenerate | null>(() => {
    if (!paneRegen) return null;
    const { branch, retryWith } = paneRegen;
    return {
      ...paneRegen,
      ...(branch ? { branch: (turn: ReplyTurn, m?: ModelChoice) => { branch(turn, m); scroll.attach(); } } : {}),
      ...(retryWith ? { retryWith: (m: ModelChoice) => { retryWith(m); scroll.attach(); } } : {}),
    };
  }, [paneRegen, scroll.attach]);
  // GPT/Gemini have no per-call approvals: their sandbox decides, so the mode picker is shown disabled. Grok has approval cards.
  const permSupported = effectiveEngine === 'claude' || effectiveEngine === 'auto' || effectiveEngine === 'grok';
  const permMode: PermMode = p.permMode ?? 'default';
  const folder = p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : null;

  /** 작업으로 / `/bg`: the draft runs as its own new session; this chat stays free (even mid-turn). */
  const startTask = (body: string) => {
    if (!p.onStartTask || !body.trim() || p.attachments.length > 0) return false;
    // Offline: nothing went out, so the draft stays where it is.
    if (p.onStartTask(body.trim()) !== false) setText('');
    return true;
  };
  const submit = () => {
    const bg = parseBgCommand(text);
    if (bg !== null && startTask(bg)) return;
    if (!canSend) return;
    if (p.onHandoff && text.trim() === `/${HANDOFF_COMMAND}` && p.attachments.length === 0) {
      p.onHandoff();
      setText('');
      scroll.attach();
      return;
    }
    const msg = text.trim() || ATTACHMENT_ONLY_TEXT;
    if (p.busy) p.onQueue?.(msg);
    else p.onSend(msg);
    setText('');
    scroll.attach();
  };
  // The prompt suggestion: shown only while the composer is empty and idle (one typed character hides it, deleting it
  // brings it back); taking it fills the composer and sends nothing.
  const ghost = !text && !p.busy && !p.readOnly && p.suggestion ? p.suggestion : null;
  const takeSuggestion = () => {
    if (!ghost) return;
    setText(ghost);
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(ghost.length, ghost.length); } });
  };
  const tm = p.titleMenu;
  // ⚡ 빠르게: an existing Claude session's switch (an id-less one has no key yet); on, a ↯ next to the composer chip.
  const fastEligible = !!p.sessionId && !p.isNew && effectiveEngine === 'claude' && !p.readOnly;
  const fastOn = useFast(p.sessionId) && fastEligible;
  const showAccount = !!p.onAccountPin && (effectiveEngine === 'claude' || (!!p.isNew && effectiveEngine === 'auto'));
  const phone = useIsPhone();
  const taskInMenu = phone || coarse;
  // The share actions close the menu themselves once done (a copy is async): the open menu's closer, kept here.
  const closeMenu = useRef<() => void>(() => {});
  const share = useShareActions({ title: p.title, items: p.items, ...(p.cwd ? { cwd: p.cwd } : {}), sessionId: p.sessionId ?? null, assistant: p.sessionEngine === 'codex' ? 'GPT' : p.sessionEngine === 'gemini' ? 'Gemini' : p.sessionEngine === 'grok' ? 'Grok' : 'Claude' }, () => closeMenu.current());
  const shareActions = p.isNew ? [] : share.actions;
  // 대화에서 찾기 (⌘F / Ctrl+F in the pane, the ⋯ menu, or a 대화 내용 검색 jump with its term); a new key refocuses an open bar.
  const [find, setFind] = useState<{ query: string; anchor: Element | null; key: number } | null>(null);
  useEffect(() => { setFind(null); }, [p.sessionId]);
  const openFind = (query = '', anchor: Element | null = null) => setFind((f) => ({ query: query || f?.query || '', anchor, key: (f?.key ?? 0) + 1 }));
  const closeFind = () => { setFind(null); taRef.current?.focus(); };
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const on = (e: Event) => {
      const q = (e as CustomEvent<unknown>).detail;
      if (typeof q === 'string' && q.trim()) openFind(q, e.target instanceof Element ? e.target : null);
    };
    el.addEventListener(FIND_EVENT, on);
    return () => el.removeEventListener(FIND_EVENT, on);
  }, []);
  const canFind = p.items.length > 0;
  const paneRows = (group: HeadGroup, ctl: HeadMenuCtl) => (p.headMenu ?? []).filter((it) => (it.group ?? 'view') === group)
    .map((it) => <HeadItem key={it.label} label={it.label} hint={it.hint} run={it.run} ctl={ctl} />);
  /** 세션 → 보기 → 공유 → 창 → 총사령탑 → 위험: the session chip's menu. */
  const headGroups = (ctl: HeadMenuCtl): ReactNode[][] => {
    closeMenu.current = ctl.close;
    return [
      [
        tm?.onRename && <HeadItem key="rename" label="이름 바꾸기" run={ctl.rename} ctl={ctl} />,
        tm?.onTogglePin && <HeadItem key="pin" label={tm.pinned ? '고정 해제' : '맨 위에 고정'} run={tm.onTogglePin} ctl={ctl} />,
        tm?.onArchive && <HeadItem key="archive" label={tm.archived ? '보관 해제' : '보관'} run={tm.onArchive} ctl={ctl} />,
        tm?.onSetCwd && <HeadItem key="cwd" label="작업 폴더 바꾸기" run={tm.onSetCwd} ctl={ctl} />,
        tm?.onDuplicate && <HeadItem key="dup" label="복제" run={tm.onDuplicate} ctl={ctl} />,
        fastEligible && <HeadItem key="fast" label={fastOn ? '빠르게 끄기 (Opus fast)' : '빠르게 (Opus fast)'} checked={fastOn} run={() => requestFast(p.sessionId!, !fastOn)} ctl={ctl} />,
        ...paneRows('session', ctl),
      ],
      [
        canFind && <HeadItem key="find" label="대화에서 찾기" hint={isMacPlatform() ? '⌘F' : 'Ctrl+F'} run={() => openFind()} ctl={ctl} />,
        ...paneRows('view', ctl),
        p.onHandoff && <HeadItem key="handoff" label="새 세션으로 이어가기" run={p.onHandoff} ctl={ctl} />,
        ...paneRows('viewEnd', ctl),
      ],
      shareActions.map((a) => <button key={a.key} type="button" role="menuitem" aria-disabled={a.disabled || undefined} onClick={a.disabled ? undefined : a.run}>{a.label}</button>),
      paneRows('window', ctl),
      paneRows('commander', ctl),
      [tm && (tm.deleteBlocked
        ? <BlockedDeleteItem key="del" reason={tm.deleteBlocked} />
        : tm.onDelete && <HeadItem key="del" className="danger" label="삭제…" run={tm.onDelete} ctl={ctl} />)],
    ];
  };
  const [{ sendKey }] = usePrefs();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest.onKeyDown(e)) return;
    // IME: never act on a key that is still part of a composition (Korean/Japanese/Chinese input). keyCode 229 is
    // Safari's Enter that commits the syllable (fired after compositionend with isComposing false). Chrome's own Enter
    // after the commit is a real Enter and sends the full text.
    const ime = e.nativeEvent.isComposing || e.keyCode === 229 || composing.current;
    if (ime) return;
    if (e.key === 'Tab' && ghost && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      takeSuggestion();
      return;
    }
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && p.onPermMode && permSupported) {
      e.preventDefault();
      p.onPermMode(nextPermMode(permMode, effectiveEngine));
      return;
    }
    if (e.key === 'Escape') {
      if (p.activeTurnId) { e.preventDefault(); p.onInterrupt(); }
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && e.currentTarget.selectionStart === 0 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Recall: the last queued message comes back for editing; otherwise the last sent one.
      const queued = p.queue?.at(-1);
      const sent = [...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined;
      const recall = queued?.text ?? sent?.text;
      if (!recall) return;
      e.preventDefault();
      if (queued) p.onQueueRemove?.(queued.id);
      setText(recall);
      return;
    }
    if (e.key !== 'Enter') return;
    // ⌘⇧Enter is the global 패널 최대화: left to it.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    // Touch screens: Enter is a newline while the on-screen keyboard is up (send with the button); with a hardware
    // keyboard (iPad + Magic Keyboard, a phone with a BT keyboard) Enter sends like on a computer.
    if (e.shiftKey || e.altKey || (coarse && softKeyboardUp()) || sendKey === 'mod-enter') return;
    e.preventDefault();
    submit();
  };
  // Files dropped anywhere on the pane attach (full-pane overlay while dragging); never a browser navigation. Anything
  // else dragged (text into the rename / edit / queue fields) is left to the browser. Enter/leave are counted: moving
  // between children fires leave/enter pairs, and Safari gives dragleave no relatedTarget.
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current += 1;
    if (!drag) setDrag(true);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (p.readOnly) e.dataTransfer.dropEffect = 'none';
    if (!drag) setDrag(true);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    // A child removed mid-drag (a streaming message re-rendering) never sends its leave, so the count can stay up;
    // the pointer actually leaving the pane's box always ends the overlay.
    const r = e.currentTarget.getBoundingClientRect();
    const outside = r.width > 0 && (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom);
    if (outside) dragDepth.current = 0;
    if (dragDepth.current === 0) setDrag(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const files = filesFrom(e.dataTransfer);
    if (files.length) void addFiles(files);
  };
  return (
    <main ref={mainRef} className="chat" {...(waitingFor ? { 'data-waiting': waitingFor } : {})} onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && canFind) { e.preventDefault(); openFind(); }
    }} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {drag && <div className={`drop-overlay ${p.readOnly ? 'blocked' : ''}`} data-testid="drop-overlay"><span>{p.readOnly || '여기에 파일을 놓으세요'}</span></div>}
      <SessionChipHead key={p.sessionId ?? 'new'} title={p.title} sessionKey={p.sessionId ?? null} engine={!p.isNew ? p.sessionEngine : null} cwd={p.cwd} slot={p.headSlot ?? null} phone={phone} paneId={p.headPaneId}
        grip={p.headGrip} gripTitle={p.headGripTitle} {...(tm?.onRename ? { onRename: tm.onRename } : {})} groups={headGroups} toast={share.done}
        chips={(p.headChips || (p.onPermMode && permSupported && permMode === 'bypassPermissions')) ? <>
          {/* 모두 자동 승인 stays on the head as a warning; the other modes live in the composer's session chip. */}
          {p.onPermMode && permSupported && permMode === 'bypassPermissions' && <span className="chip perm-badge perm-bypassPermissions" title={`${PERM_MODE_LABEL[permMode]} — ${permModeHint(permMode, effectiveEngine)}`} data-testid="perm-badge"><WarnIcon /><span className="perm-badge-full">{PERM_MODE_LABEL[permMode]}</span></span>}
          {p.headChips}
        </> : null}
        trail={p.headActions} />
      {find && <FindBar key={find.key} root={bodyRef} content={content} initialQuery={find.query} anchor={find.anchor} onClose={closeFind} />}
      {p.notices?.map((n) => (
        <div key={n.message} className={`pane-notice ${n.level}`} role={n.level === 'error' ? 'alert' : 'status'} data-testid="pane-notice">
          <span className="pane-notice-text">{n.message}</span>
          {p.onDismissNotice && <button type="button" className="pane-notice-close" aria-label="알림 닫기" title="닫기" onClick={() => p.onDismissNotice?.(n.message)}>×</button>}
        </div>
      ))}
      {p.routeFit && (
        <div className="pane-notice" role="alert" data-testid="route-fit">
          <span className="pane-notice-text">이 작업은 {p.routeFit.need} 가 필요합니다 — {p.routeFit.engine === 'codex' ? 'GPT' : p.routeFit.engine === 'gemini' ? 'Gemini' : p.routeFit.engine === 'grok' ? 'Grok' : 'Claude'} 로는 못 할 수 있어 보내지 않았습니다</span>
          <button type="button" className="btn" data-testid="route-fit-send" onClick={() => p.onRouteFit?.('send')}>그래도 보내기</button>
          <button type="button" className="pane-notice-close" aria-label="알림 닫기" title="닫기 (대기열로 돌려놓기)" onClick={() => p.onRouteFit?.('dismiss')}>×</button>
        </div>
      )}
      <div className="chat-body" ref={bodyRef}>
        {p.prevSession && <button type="button" className="session-link prev" data-testid="handoff-prev" onClick={p.prevSession.open} title={p.prevSession.title}>← 이전 세션 · {p.prevSession.title}</button>}
        {p.loading && p.items.length === 0 && (
          <div className="chat-loading" role="status" data-testid="chat-loading">
            <span className="sr-only">불러오는 중…</span>
            {[72, 46, 88, 60].map((w, i) => <span key={i} className={`skeleton-line ${i % 2 ? 'mine' : ''}`} style={{ width: `${w}%` }} aria-hidden="true" />)}
          </div>
        )}
        {/* Reopened from the recent cache: the kept transcript shows while the fresh history is on its way. */}
        {p.loading && p.items.length > 0 && <div className="chat-refreshing" role="status" data-testid="chat-refreshing">불러오는 중…</div>}
        {older && !p.loading && p.items.length > 0 && (older.cursor === null
          ? <div className="older-line older-start" data-testid="older-start">{ui().chat.older.start}</div>
          : older.loading
            ? <div className="older-line" role="status" data-testid="older-loading">{ui().chat.older.loading}</div>
            : <button type="button" className="older-more" data-testid="older-more" onClick={older.onLoad}>{older.failed ? ui().chat.older.retry : ui().chat.older.more}</button>)}
        <AgentContext.Provider value={agentCtx}>
          <MessageActionsContext.Provider value={msgActions}>
            <RegenerateContext.Provider value={regen}>
              {shown.map((it, i) => {
                const at = dividers[i];
                return (
                  <Fragment key={keys[i]}>
                    {at != null && <div className="msg-time" data-testid="msg-time"><time dateTime={new Date(at).toISOString()}>{timeLabel(at)}</time></div>}
                    <MessageView item={it} cwd={p.cwd} last={i === shown.length - 1} turnEnd={turnEnds[i]} {...meta[i]} />
                  </Fragment>
                );
              })}
            </RegenerateContext.Provider>
          </MessageActionsContext.Provider>
        </AgentContext.Provider>
        {retryPrompt !== null && <button type="button" className="btn ghost retry" onClick={() => { p.onSend(retryPrompt); scroll.attach(); }}>재시도</button>}
        {fastRefused && <button type="button" className="btn ghost retry" data-testid="fast-standard-retry" onClick={() => { p.onSendStandard?.(retryPrompt!); scroll.attach(); }}>표준으로 다시 보내기</button>}
        {lockedTurn !== null && p.onCodexHandoff && <button type="button" className="btn ghost retry" data-testid="codex-handoff" onClick={() => p.onCodexHandoff?.(lockedTurn)}>AI-MSG 에서 새 GPT 세션으로 이어가기</button>}
        {p.pending.map((r) => <div key={r.requestId} className="await-card" data-await-card={r.requestId}><PermissionCard req={r} onDecide={p.onDecide} /></div>)}
        {p.questions.map((q) => <div key={q.requestId} className="await-card" data-await-card={q.requestId}><QuestionCard req={q} onAnswer={p.onAnswer} /></div>)}
        {p.tasks && p.tasks.length > 0 && <TaskCards tasks={p.tasks} cap={p.taskCap ?? null} {...(p.onOpenTask ? { onOpen: p.onOpenTask } : {})} {...(p.onDismissTask ? { onDismiss: p.onDismissTask } : {})} {...(p.onCancelTask ? { onCancel: p.onCancelTask } : {})} />}
        {p.autoResume && !p.busy && (
          <div className="auto-resume" role="status" data-testid="auto-resume">
            <span className="turn-meta-text">{ui().chat.autoResume.at(clockOf(p.autoResume.atMs))}</span>
            <span aria-hidden="true">·</span>
            <button type="button" className="auto-resume-cancel" data-testid="auto-resume-cancel" onClick={p.autoResume.onCancel}>{ui().chat.autoResume.cancel}</button>
          </div>
        )}
        {p.nextSession && <button type="button" className="session-link next" data-testid="handoff-next" onClick={p.nextSession.open} title={p.nextSession.title}>→ 새 세션으로 이어감 · {p.nextSession.title}</button>}
      </div>
      {scroll.detached && (
        <div className="jump-anchor">
          <button type="button" className={`jump-bottom ${scroll.unread > 0 ? 'unread' : ''}`} onClick={scroll.attach} data-testid="jump-bottom">
            <span aria-hidden="true">↓</span> {scroll.unread > 0 ? ui().chat.jump.unread(scroll.unread) : ui().chat.jump.bottom}
          </button>
        </div>
      )}
      <div className="composer-wrap">
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {p.queue && p.queue.length > 0 && (
          <QueueChips queue={p.queue} paused={!!p.queuePaused} onEdit={(id, t) => p.onQueueEdit?.(id, t)} onRemove={(id) => p.onQueueRemove?.(id)} onClear={() => p.onQueueClear?.()} onResume={() => p.onQueueResume?.()}{...(p.connected !== undefined ? { connected: p.connected } : {})}{...(p.onQueueSendNow ? { onSendNow: p.onQueueSendNow } : {})} />
        )}
        {(p.busy || p.bg) && (
          <div className="activity-bar">
            {p.busy ? <StatusRow startedAt={p.runStartedAt ?? null} started={!!p.activeTurnId} queuedBehind={p.activeTurnId ? null : p.awaitingBehind ?? null} progress={p.progress ?? null} live={live} routeAck={p.turnRoute ? { model: p.turnRoute.model, engine: p.turnRoute.engine, accountLabel: accountNames.label(p.turnRoute.account), step: conciseFirstStep(lastUserText(p.items)) } : null} waiting={p.activeTurnId ? waitingFor : null} onInterrupt={p.activeTurnId ? p.onInterrupt : undefined} onCancel={p.activeTurnId ? undefined : p.onCancelStart} /> : <span className="spacer" />}
            {p.bg && <BackgroundPill bg={p.bg} onStopTask={p.onStopTask} onStopAll={() => p.onStopBackground?.(p.bg!.turnId)} />}
          </div>
        )}
        {p.handoffWriting && <div className="handoff-status" role="status" data-testid="handoff-status">인계 메모 작성 중… 끝나면 새 세션이 열리고 메모가 입력창에 들어갑니다</div>}
        {!p.busy && <ContextHint info={ctx} onHandoff={p.onHandoff} cold={!pillCold} />}
        {(p.composerNote || p.onPickCwd || p.onGrokBotHandoff) && (
          <div className="pane-notice notice composer-note">
            {p.composerNote && <span className="pane-notice-text" role="status" data-testid="composer-note">{p.composerNote}</span>}
            {p.onPickCwd && <button type="button" className="btn ghost" data-testid="grokbot-handoff-cwd" onClick={p.onPickCwd}>작업 폴더 바꾸기</button>}
            {p.onGrokBotHandoff && <button type="button" className="btn ghost" data-testid="grokbot-handoff" onClick={p.onGrokBotHandoff}>새 Grok 세션으로 이어가기</button>}
          </div>
        )}
        <Composer
          dragover={drag && !p.readOnly}
          popup={suggest.popup}
          {...(ghost ? { hint: (
            <button type="button" className="prompt-suggest-take" data-testid="prompt-suggest-take" onMouseDown={(e) => e.preventDefault()} onClick={takeSuggestion} title={`추천 채우기: ${ghost}`}>
              {!coarse && <kbd>Tab</kbd>}추천 채우기
            </button>
          ) } : {})}
          chip={(<>
            <SessionChip
              key={p.sessionId ?? 'new'}
              isNew={p.isNew}
              folder={folder}
              engine={effectiveEngine}
              engines={p.isNew ? { codexAvailable: p.codexAvailable, gemini: p.gemini ?? null, grok: p.grok ?? null, onEngine: p.onEngine } : null}
              sandbox={p.isNew
                ? (engineSelect ? { value: p.sandbox, onChange: p.onSandbox } : null)
                : p.sessionEngine === 'codex' ? { value: p.sessionSandbox ?? DEFAULT_SANDBOX, ...(p.onSessionSandbox ? { onChange: p.onSessionSandbox, existing: true } : {}) }
                : p.sessionEngine === 'gemini' ? { value: p.sessionSandbox ?? 'read-only' } : null}
              models={models} model={p.model} effort={p.effort} onModel={p.onModel} onEffort={p.onEffort}
              account={showAccount && p.onAccountPin ? { pin: p.accountPin ?? null, current: p.isNew ? null : (p.account ?? null), usage: p.usage ?? null, onPin: p.onAccountPin } : null}
              perm={p.onPermMode ? { mode: permMode, supported: permSupported, onChange: p.onPermMode } : null}
              ctx={ctx}
              {...(p.onHandoff ? { onHandoff: p.onHandoff } : {})}
              disabled={!!p.readOnly}
            />
            {fastOn && <button type="button" className="fast-chip" data-testid="fast-chip" aria-label={`${FAST_TITLE} — 누르면 끕니다`} title={`${FAST_TITLE} — 누르면 끕니다`} onClick={() => requestFast(p.sessionId!, false)}>↯</button>}
          </>)}
          files={(p.attachments.length > 0 || uploading > 0 || error) ? (
            <AttachmentBar attachments={p.attachments} uploading={uploading} error={error} onRemove={p.onUnattach} pastedTexts={pastedTexts}
              {...(p.onReattach && !p.readOnly ? { onReplace: (old: UploadedAttachment, f: File) => replaceAttachment(old, f, uploadOne, () => attachmentsRef.current, (a) => p.onReattach!(old.id, a)) } : {})} />
          ) : null}
          onFiles={(f) => void addFiles(f)}
          text={text}
          onText={setText}
          {...(taskReady && taskInMenu ? { menu: [{ key: 'task', label: ui().chat.taskMenu, icon: <TaskIcon />, run: () => startTask(text) }] } : {})}
          crowded={!!p.activeTurnId && runSend}
          extra={<>
            {/* Desktop: a 작업으로 pill; a phone / touch screen has it in the + menu instead (C-1: at most two round buttons on the right). */}
            {taskReady && !taskInMenu && (
              <button type="button" className="task-add" data-testid="task-add" onClick={() => startTask(text)} aria-label="작업으로" title="작업으로 — 새 세션에서 따로 돌리고, 이 대화는 계속 씁니다. 끝나면 알림과 결과 카드가 옵니다 (/bg 로도 시작)">
                <span className="task-add-text">작업으로</span><TaskIcon />
              </button>
            )}
          </>}
          action={p.activeTurnId && !runSend
            ? <button type="button" className={`send stop${waitingFor ? ' quiet' : ''}`} onClick={p.onInterrupt} title={ui().chat.composer.stop}><i aria-hidden="true" /><span className="sr-only">{ui().chat.composer.stop}</span></button>
            : p.activeTurnId
            ? <>
                <button type="button" className={`send stop stop-mini${waitingFor ? ' quiet' : ''}`} onClick={p.onInterrupt} title={ui().chat.composer.stopEsc}><i aria-hidden="true" /><span className="sr-only">{ui().chat.composer.stop}</span></button>
                <button type="button" className="send" onClick={submit} title={steering ? ui().chat.composer.queueSteerTitle : ui().chat.composer.queueWaitTitle} aria-keyshortcuts={coarse ? undefined : sendKey === 'mod-enter' ? 'Meta+Enter Control+Enter' : 'Enter'}><span aria-hidden="true">↑</span><span className="sr-only">{ui().chat.composer.queueAdd}</span></button>
              </>
            : <button type="button" className="send" onClick={submit} disabled={!canSend} title={coarse ? '보내기' : sendKey === 'mod-enter' ? SEND_TITLE_MOD : SEND_TITLE} aria-keyshortcuts={coarse ? undefined : sendKey === 'mod-enter' ? 'Meta+Enter Control+Enter' : 'Enter'}><span aria-hidden="true">↑</span><span className="sr-only">보내기</span></button>}
        >
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); suggest.track(e); }}
            onSelect={suggest.track}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onPaste={onPaste}
            // Safari (web app) honours these; Chrome ignores them. Without them Safari auto-capitalises the first
            // letter, swaps words with autocorrect and underlines code — prompts are not prose.
            autoCorrect="off" autoCapitalize="off" spellCheck={false}
            disabled={!!p.readOnly}
            placeholder={p.readOnly ? p.readOnly : ghost ? ghost : waitingFor ? (waitingFor === 'question' ? ui().chat.waiting.placeholderQuestion : ui().chat.waiting.placeholderPermission) : queueing ? (steering ? (coarse ? '실행 중 · 보내면 다음 도구 실행 뒤 전달' : '실행 중 · Enter 로 보내면 다음 도구 실행 뒤 전달 · Esc 중단') : coarse ? '실행 중 · 보내면 대기열에 추가' : '실행 중 · Enter 로 대기열에 추가 · Esc 중단') : composerPlaceholder()}
            aria-label="메시지"
            rows={1}
            // Not a form field: keeps iOS from showing its AutoFill (password/card/address) bar above the keyboard.
            name="deck-message"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            enterKeyHint={coarse ? 'enter' : 'send'}
          />
        </Composer>
      </div>
    </main>
  );
}
