import type { Account, Seat } from '../shared/accounts';
import { contextWindowOf, DEFAULT_CODEX_MODEL, DEFAULT_EFFORT, DEFAULT_GEMINI_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, defaultSandbox, isClaudeModel, isCodexModel, isGeminiModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../shared/models';
import type { DeckSettings, GeminiStatus, ServerMessage, SessionActivity, TurnBadge, TurnPrompt } from '../shared/protocol';
import type { BgTaskInfo, TaskStatus, TaskUsage, TurnPhase } from '../shared/turn-types';
import type { DesktopSession, ProjectEntry, TranscriptMessage } from '../shared/session-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { coldWriteNote, latestContext, type ContextInfo } from './context';

export type ToolCallItem = { toolUseId: string; name: string; input: unknown; result: string | null; isError: boolean };

export type ChatItem =
  | { kind: 'user'; text: string; /** sent attachments (display: name tile, or a thumbnail for images) */ attachments?: SentFile[] }
  | { kind: 'assistant'; turnId: string | null; text: string; toolCalls: ToolCallItem[]; badge: TurnBadge | null; streaming: boolean; error: string | null; notes: string[]; attempts: string[]; /** The context after this turn (gauge). */ ctx?: ContextInfo; /** Badge tooltip when the turn rewrote the prompt cache (e.g. "캐시 새로 씀 · 계정 전환"). */ cacheNote?: string | null };

/** A subagent's own tool call, shown in its Agent card (nested subagents' calls are flattened into the top card). */
export type AgentCall = { toolUseId: string; name: string; input: unknown; done: boolean; isError: boolean };
/**
 * Live state of the subagent an Agent/Task call started, keyed by that call's toolUseId. Times are this
 * client's clock: `startedAt` is backdated by the server's `ageMs` on a replay.
 */
export type AgentInfo = {
  taskId: string | null; status: TaskStatus; description: string; subagentType: string; backgrounded: boolean;
  startedAt: number; endedAt: number | null; usage: TaskUsage | null; lastToolName: string | null; calls: AgentCall[];
};
/** The pane's background work (one process per session): `receivedAt` + `detail[].ageMs` gives each task's age now. */
export type PaneBackground = { turnId: string; tasks: string[]; detail: BgTaskInfo[]; receivedAt: number; canStop: boolean };

export type PendingPermission = Omit<Extract<ServerMessage, { type: 'permission_request' }>, 'type'>;
export type PendingQuestion = Omit<Extract<ServerMessage, { type: 'question_request' }>, 'type'>;
export type UploadedAttachment = { id: string; name: string; size: number; isImage: boolean; /** ux-state: object URL of the local file, composer thumbnail only (never persisted). */ previewUrl?: string };
/** An attachment as shown in a sent bubble; images load from GET /api/attachments/:id. */
export type SentFile = { id: string; name: string; isImage: boolean };
/** ux-state: a message typed while the pane's turn runs; sent when the turn ends. */
export type QueueItem = { id: string; text: string; attachments: UploadedAttachment[] };

export type PaneSession = { sessionId: string | null; cwd: string; account: Seat | null; title: string; engine: EngineKind | null; sandbox: CodexSandbox | null };

export type PaneState = {
  id: string;
  session: PaneSession | null;
  items: ChatItem[];
  activeTurnId: string | null;
  /** Review I3: turns this pane started (claimed at their first turn_started after a `sent`). */
  myTurns: string[];
  /** A `sent` whose turn_started (or error) has not arrived yet. */
  awaitingStart: boolean;
  /** The `send.clientRef` of that pending send; null for a send made without one (legacy matching). */
  awaitingRef: string | null;
  model: ModelChoice;
  /** Reasoning effort per engine, so switching Claude ↔ GPT keeps each side's pick. */
  efforts: Record<EngineKind, Effort>;
  /** Effort while the model is 자동: null = 자동 too (the server picks per model). */
  autoEffort: Effort | null;
  /** New-session choices (D2, D3); the server ignores them once the session exists. */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  attachments: UploadedAttachment[];
  /** ux-state: messages waiting for the running turn to end (FIFO). */
  queue: QueueItem[];
  /** Stop / a failed turn pauses the queue; a manual send or 이어서 resumes it. */
  queuePaused: boolean;
  /** Status row: when the running turn started (client clock), its output tokens and phase. */
  runStartedAt: number | null;
  progress: { outputTokens: number; phase: TurnPhase } | null;
  /** Subagent cards, by the Agent call's toolUseId. */
  agents: Record<string, AgentInfo>;
  /** Background tasks pill; null = none. */
  bg: PaneBackground | null;
};

export type AppState = {
  connected: boolean;
  usage: UsageSnapshot | null;
  projects: ProjectEntry[];
  /** Prompts from every session (any device may answer); the pane whose session they belong to shows them. */
  pending: PendingPermission[];
  questions: PendingQuestion[];
  panes: PaneState[];
  activePaneId: string;
  error: string | null;
  codexAvailable: boolean;
  /** gemini-cli status from hello; null = not installed (or an older server). */
  gemini: GeminiStatus | null;
  /** F2: pinned session ids, pin order (server-side pins.json). */
  pins: string[];
  /** Recent Claude Desktop sessions (server-side, newest first). */
  desktop: DesktopSession[];
  /** 자동 승인 (server setting); null until the server says. */
  autoApprove: boolean | null;
  /** Sessions with a turn running or background work, on any device (sidebar dots, tab title). */
  activity: SessionActivity[];
  /** Sessions whose turn finished while no focused pane showed them; cleared when opened. */
  unread: string[];
};

export const MAX_PANES = 5;

export function newPane(id: string): PaneState {
  return { id, session: null, items: [], activeTurnId: null, myTurns: [], awaitingStart: false, awaitingRef: null, model: DEFAULT_MODEL, efforts: { ...DEFAULT_EFFORT }, autoEffort: null, engine: 'claude', sandbox: DEFAULT_SANDBOX, attachments: [], queue: [], queuePaused: false, runStartedAt: null, progress: null, agents: {}, bg: null };
}

export const initialState: AppState = { connected: false, usage: null, projects: [], pending: [], questions: [], panes: [newPane('p0')], activePaneId: 'p0', error: null, codexAvailable: false, gemini: null, pins: [], desktop: [], autoApprove: null, activity: [], unread: [] };

export type Action =
  | { type: 'server'; msg: ServerMessage; /** with a `history`: files sent earlier in that session (persist.ts), matched back onto its user items */ sentFiles?: SentRecord[] }
  | { type: 'connected'; value: boolean }
  | { type: 'open'; sessionId: string | null; cwd: string; title: string; paneId?: string }
  | { type: 'sent'; text: string; paneId?: string; attachments?: SentFile[]; /** Echoed by the server on turn_started / refusal; the caller makes it unique. */ clientRef?: string }
  | { type: 'set_model'; model: ModelChoice; paneId?: string }
  | { type: 'set_effort'; engine: EngineKind; effort: Effort; paneId?: string }
  | { type: 'set_auto_effort'; effort: Effort | null; paneId?: string }
  | { type: 'set_engine'; engine: EngineChoice; paneId?: string }
  | { type: 'set_sandbox'; sandbox: CodexSandbox; paneId?: string }
  | { type: 'attach'; attachment: UploadedAttachment; paneId?: string }
  | { type: 'unattach'; id: string; paneId?: string }
  | { type: 'add_pane' }
  | { type: 'close_pane'; paneId: string }
  | { type: 'focus_pane'; paneId: string }
  | { type: 'dismiss_error' }
  | { type: 'set_pins'; pins: string[] }
  | { type: 'show_error'; message: string }
  | { type: 'queue_add'; text: string; paneId?: string }
  | { type: 'queue_edit'; id: string; text: string; paneId?: string }
  | { type: 'queue_remove'; id: string; paneId?: string }
  | { type: 'queue_clear'; paneId?: string }
  | { type: 'queue_pause'; paneId?: string }
  | { type: 'queue_resume'; paneId?: string };

/** A sent message's text and files, kept per session so a reloaded transcript can show thumbnails again. */
export type SentRecord = { text: string; files: SentFile[] };

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

export function fromTranscript(messages: TranscriptMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.kind === 'user') items.push({ kind: 'user', text: m.text });
    else if (m.kind === 'assistant') {
      const at = m.ts ? Date.parse(m.ts) : NaN;
      const ctx: ContextInfo | null = m.usage ? { usage: m.usage, window: contextWindowOf(m.model), at: Number.isNaN(at) ? null : at, model: m.model, account: null } : null;
      items.push({ kind: 'assistant', turnId: null, text: m.text, toolCalls: m.toolCalls.map((t) => ({ toolUseId: t.id, name: t.name, input: t.input, result: null, isError: false })), badge: null, streaming: false, error: null, notes: [], attempts: [], ...(ctx ? { ctx } : {}) });
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it?.kind !== 'assistant') continue;
        const tc = it.toolCalls.find((t) => t.toolUseId === m.toolUseId);
        if (tc) { tc.result = m.content; tc.isError = m.isError; break; }
      }
    }
  }
  return items;
}

/** Which engine a model runs on (자동 picks among Claude models). */
export function engineOf(model: ModelChoice): EngineKind {
  return isCodexModel(model) ? 'codex' : isGeminiModel(model) ? 'gemini' : 'claude';
}

/** The pane's model if it belongs to `engine`, else that engine's default. 자동 stays 자동 on Claude (the session keeps its model). */
export function modelFor(engine: EngineKind, model: ModelChoice): ModelChoice {
  if (engine === 'codex') return isCodexModel(model) ? model : DEFAULT_CODEX_MODEL;
  if (engine === 'gemini') return isGeminiModel(model) ? model : DEFAULT_GEMINI_MODEL;
  return isClaudeModel(model) || model === 'auto' ? model : DEFAULT_MODEL;
}

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

function updateTurn(pane: PaneState, turnId: string, fn: (item: AssistantItem) => AssistantItem): PaneState {
  const idx = pane.items.findIndex((it) => it.kind === 'assistant' && it.turnId === turnId);
  if (idx < 0) return pane;
  const items = pane.items.slice();
  items[idx] = fn(items[idx] as AssistantItem);
  return { ...pane, items };
}

type TurnMsg = Extract<ServerMessage, { turnId: string; cwd: string }>;

/** Review I3: a turn event is applied only if it belongs to the session this pane has open. */
function belongs(pane: PaneState, msg: TurnMsg): boolean {
  if (!pane.session) return false;
  if (pane.myTurns.includes(msg.turnId) || msg.turnId === pane.activeTurnId) return true;
  return msg.sessionId !== null && msg.sessionId === pane.session.sessionId;
}

function streamingItem(turnId: string): AssistantItem {
  return { kind: 'assistant', turnId, text: '', toolCalls: [], badge: null, streaming: true, error: null, notes: [], attempts: [] };
}

function promptItem(prompt: TurnPrompt): ChatItem {
  return { kind: 'user', text: prompt.text, ...(prompt.attachments.length ? { attachments: prompt.attachments } : {}) };
}

/**
 * A pane opened mid-turn: the running turn's prompt goes before its streaming item unless the transcript already
 * ends its user messages with it (the CLI writes the prompt early; the server appends path lines after attachments).
 */
function withRunningPrompt(items: ChatItem[], prompt: TurnPrompt): ChatItem[] {
  const idx = items.findLastIndex((it) => it.kind === 'user');
  const lastUser = idx >= 0 ? (items[idx] as Extract<ChatItem, { kind: 'user' }>) : null;
  if (lastUser && (lastUser.text === prompt.text || lastUser.text.startsWith(`${prompt.text}\n`))) {
    if (lastUser.attachments?.length || !prompt.attachments.length) return items;
    const out = items.slice();
    out[idx] = { ...lastUser, attachments: prompt.attachments };
    return out;
  }
  return [...items, promptItem(prompt)];
}

const ACTIVITY_RESET = { runStartedAt: null, progress: null, agents: {}, bg: null } as const;

/** The agent card a subagent call belongs to: its own Agent call, or the top card holding the nested Agent call. */
function agentFor(agents: Record<string, AgentInfo>, parentToolUseId: string): string | null {
  if (agents[parentToolUseId]) return parentToolUseId;
  for (const [id, a] of Object.entries(agents)) if (a.calls.some((c) => c.toolUseId === parentToolUseId)) return id;
  return null;
}

function blankAgent(now: number): AgentInfo {
  return { taskId: null, status: 'running', description: '', subagentType: '', backgrounded: false, startedAt: now, endedAt: null, usage: null, lastToolName: null, calls: [] };
}

function withAgent(pane: PaneState, id: string, fn: (a: AgentInfo) => AgentInfo): PaneState {
  return { ...pane, agents: { ...pane.agents, [id]: fn(pane.agents[id] ?? blankAgent(Date.now())) } };
}

/** One pane's view of a server message. `claim`: this pane may claim an unclaimed turn_started (only the first waiting pane does). */
function paneOnServer(pane: PaneState, msg: ServerMessage, claim: boolean): PaneState {
  switch (msg.type) {
    case 'hello': {
      // Reconnect: show 중단 for a turn still running on the open session; drop one that ended meanwhile.
      const sid = pane.session?.sessionId ?? null;
      const live = msg.running.find((r) => r.turnId === pane.activeTurnId) ?? (sid ? msg.running.find((r) => r.sessionId === sid) : undefined);
      const activeTurnId = live?.turnId ?? null;
      const items = activeTurnId === pane.activeTurnId ? pane.items : pane.items.map((it) => (it.kind === 'assistant' && it.streaming && it.turnId === pane.activeTurnId ? { ...it, streaming: false } : it));
      const act = sid ? msg.activity?.find((a) => a.sessionId === sid) : undefined;
      // An empty turn_background missed while disconnected must not leave the pill lingering.
      const bg = msg.activity && !(act && act.bg > 0) ? null : pane.bg;
      const run = activeTurnId ? { runStartedAt: pane.runStartedAt ?? (act?.running ? Date.now() - act.forMs : Date.now()) } : { runStartedAt: null, progress: null };
      return { ...pane, activeTurnId, items, awaitingStart: false, awaitingRef: null, bg, ...run };
    }
    case 'activity': {
      const sid = pane.session?.sessionId;
      if (!sid) return pane;
      const act = msg.sessions.find((a) => a.sessionId === sid);
      return pane.bg && !(act && act.bg > 0) ? { ...pane, bg: null } : pane;
    }
    case 'history': {
      let items = fromTranscript(msg.messages);
      if (msg.runningTurnId && msg.runningPrompt) items = withRunningPrompt(items, msg.runningPrompt);
      if (msg.runningTurnId) items.push(streamingItem(msg.runningTurnId));
      const title = pane.session?.sessionId === msg.sessionId ? pane.session.title : msg.sessionId.slice(0, 8);
      const engine: EngineKind = msg.engine ?? 'claude';
      // PF13: a Claude session is never sent a GPT model and vice versa.
      const model = modelFor(engine, pane.model);
      const runStartedAt = msg.runningTurnId ? Date.now() - (msg.runningForMs ?? 0) : null;
      return { ...pane, session: { sessionId: msg.sessionId, cwd: msg.cwd, account: msg.account, title, engine, sandbox: msg.sandbox ?? null }, items, activeTurnId: msg.runningTurnId, model, ...ACTIVITY_RESET, runStartedAt };
    }
    case 'turn_started': {
      let p = pane;
      const sess = pane.session;
      // A send made with a clientRef is claimed only by the turn_started echoing it (send order, not pane order);
      // a ref-less send falls back to the first waiting pane with a matching session.
      const claims = pane.awaitingRef !== null
        ? msg.clientRef === pane.awaitingRef
        : claim && msg.clientRef === undefined && !!sess && (msg.sessionId === sess.sessionId || (msg.sessionId === null && sess.sessionId === null && msg.cwd === sess.cwd));
      if (pane.awaitingStart && sess && !pane.myTurns.includes(msg.turnId) && claims) {
        p = { ...pane, awaitingStart: false, awaitingRef: null, myTurns: [...pane.myTurns, msg.turnId], session: { ...sess, engine: msg.engine ?? 'claude' } };
      }
      if (!belongs(p, msg)) return p;
      const exists = p.items.some((it) => it.kind === 'assistant' && it.turnId === msg.turnId);
      // Another device's (or pane's) message: its bubble goes before the turn's answer. The sending pane shows it already ('sent').
      const echo = msg.prompt && !p.myTurns.includes(msg.turnId) ? [promptItem(msg.prompt)] : [];
      const items = exists ? p.items.map((it) => (it.kind === 'assistant' && it.turnId === msg.turnId ? { ...it, streaming: true } : it)) : [...p.items, ...echo, streamingItem(msg.turnId)];
      // The timer runs from the send (sent) or from this start; a retry of the same turn keeps it.
      const runStartedAt = p.activeTurnId === msg.turnId || (p.runStartedAt !== null && p.activeTurnId === null) ? (p.runStartedAt ?? Date.now()) : Date.now();
      return { ...p, items, activeTurnId: msg.turnId, runStartedAt, progress: p.activeTurnId === msg.turnId ? p.progress : null };
    }
    case 'turn_progress':
      if (!belongs(pane, msg) || msg.turnId !== pane.activeTurnId) return pane;
      return { ...pane, progress: { outputTokens: msg.outputTokens, phase: msg.phase } };
    case 'task_update': {
      if (!belongs(pane, msg)) return pane;
      // A patch (task_updated) has no Agent call id: find the card by task id.
      const id = msg.toolUseId ?? Object.keys(pane.agents).find((k) => pane.agents[k]!.taskId === msg.taskId);
      if (!id) return pane;
      const now = Date.now();
      const fresh = !pane.agents[id];
      return withAgent(pane, id, (a) => ({
        ...a,
        taskId: msg.taskId,
        ...(msg.status ? { status: msg.status, endedAt: msg.status === 'running' ? null : (a.endedAt ?? now) } : {}),
        ...(msg.description !== undefined ? { description: msg.description } : {}),
        ...(msg.subagentType ? { subagentType: msg.subagentType } : {}),
        ...(msg.backgrounded !== undefined ? { backgrounded: msg.backgrounded } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
        ...(msg.lastToolName ? { lastToolName: msg.lastToolName } : {}),
        ...(msg.ageMs !== undefined && fresh ? { startedAt: now - msg.ageMs } : {}),
      }));
    }
    case 'task_done': {
      if (!belongs(pane, msg)) return pane;
      const id = msg.toolUseId ?? (msg.taskId ? Object.keys(pane.agents).find((k) => pane.agents[k]!.taskId === msg.taskId) : undefined);
      if (!id || !pane.agents[id]) return pane;
      return withAgent(pane, id, (a) => ({ ...a, status: msg.status, endedAt: a.endedAt ?? Date.now(), ...(msg.usage ? { usage: msg.usage } : {}) }));
    }
    case 'sub_tool_call': {
      if (!belongs(pane, msg)) return pane;
      const id = agentFor(pane.agents, msg.parentToolUseId) ?? msg.parentToolUseId;
      return withAgent(pane, id, (a) => (a.calls.some((c) => c.toolUseId === msg.toolUseId) ? a : { ...a, calls: [...a.calls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, done: false, isError: false }] }));
    }
    case 'sub_tool_result': {
      if (!belongs(pane, msg)) return pane;
      const id = agentFor(pane.agents, msg.parentToolUseId);
      if (!id) return pane;
      return withAgent(pane, id, (a) => ({ ...a, calls: a.calls.map((c) => (c.toolUseId === msg.toolUseId ? { ...c, done: true, isError: msg.isError } : c)) }));
    }
    case 'delta':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, text: it.text + msg.text }));
    case 'tool_call':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, toolCalls: [...it.toolCalls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, result: null, isError: false }] }));
    case 'tool_result':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, toolCalls: it.toolCalls.map((t) => (t.toolUseId === msg.toolUseId ? { ...t, result: msg.content, isError: msg.isError } : t)) }));
    case 'turn_retry':
      if (!belongs(pane, msg)) return pane;
      // Review M11: the retry streams into a fresh segment; the failed attempt's text is kept apart.
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, text: '', attempts: it.text ? [...it.attempts, it.text] : it.attempts, notes: [...it.notes, `재시도 ${LABEL[msg.fromAccount]} → ${LABEL[msg.toAccount]}: ${msg.reason}`] }));
    case 'turn_background': {
      if (!belongs(pane, msg)) return pane;
      // One pill per pane (one process per session); [] clears it.
      if (!msg.tasks.length) return pane.bg ? { ...pane, bg: null } : pane;
      return { ...pane, bg: { turnId: msg.turnId, tasks: msg.tasks, detail: msg.detail ?? [], receivedAt: Date.now(), canStop: msg.canStop === true } };
    }
    case 'turn_notice':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, notes: [...it.notes, msg.message] }));
    case 'turn_result': {
      const mine = pane.myTurns.includes(msg.turnId);
      const myTurns = mine ? pane.myTurns.filter((t) => t !== msg.turnId) : pane.myTurns;
      if (!belongs(pane, msg)) return myTurns === pane.myTurns ? pane : { ...pane, myTurns };
      const b = msg.badge;
      const prev = latestContext(pane.items);
      const ctx: ContextInfo | null = b?.usage.context ? { usage: b.usage.context, window: b.usage.contextWindow ?? contextWindowOf(b.model), at: Date.now(), model: b.model, account: b.account } : null;
      const cacheNote = b ? coldWriteNote(b.usage, prev, { account: b.account, model: b.model, reason: b.reason, startedAt: pane.runStartedAt ?? Date.now() }) : null;
      const next = updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, badge: msg.badge ?? it.badge, text: it.text || msg.text, error: msg.ok ? null : (msg.errorText ?? '실패'), ...(ctx ? { ctx } : {}), ...(cacheNote ? { cacheNote } : {}) }));
      // Only a turn this pane started may re-point the pane's session (id / account).
      const session = mine && next.session ? { ...next.session, sessionId: msg.sessionId || next.session.sessionId, account: msg.badge?.account ?? next.session.account } : next.session;
      // ux-state: a failed (or stopped) turn of this pane pauses its queue instead of firing the next message into it.
      const queuePaused = next.queuePaused || ((mine || pane.activeTurnId === msg.turnId) && !msg.ok);
      const ended = pane.activeTurnId === msg.turnId;
      return { ...next, session, myTurns, queuePaused, activeTurnId: ended ? null : pane.activeTurnId, ...(ended ? { runStartedAt: null, progress: null } : {}) };
    }
    case 'error': {
      const withItem = msg.turnId ? updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, error: it.error ?? msg.message })) : pane;
      // Review I6: an error that names the running turn ends it, or the composer stays locked on 중단.
      const activeTurnId = msg.turnId !== null && msg.turnId === pane.activeTurnId ? null : withItem.activeTurnId;
      const stop = activeTurnId === null && pane.activeTurnId !== null ? { runStartedAt: null, progress: null } : {};
      // A send refused before its turn started (busy session, bad cwd, unknown session) ends the wait.
      // With a clientRef only the error echoing it ends the wait, so another pane's error never unlocks this one.
      const ends = pane.awaitingRef !== null
        ? msg.clientRef === pane.awaitingRef
        : msg.clientRef === undefined && (msg.turnId === null || !pane.myTurns.includes(msg.turnId));
      // ux-state: a refused send pauses the queue too (it would only be refused again).
      const idle = ends && activeTurnId === null ? { runStartedAt: null, progress: null } : stop;
      return ends ? { ...withItem, activeTurnId, awaitingStart: false, awaitingRef: null, queuePaused: withItem.queuePaused || withItem.queue.length > 0, ...idle } : { ...withItem, activeTurnId, ...stop };
    }
    default:
      return pane;
  }
}

function mapPanes(state: AppState, msg: ServerMessage): PaneState[] {
  return state.panes.map((p) => paneOnServer(p, msg, false));
}

/**
 * Once the server knows a session's real title (derived server-side, e.g. from the first prompt line),
 * it appears in the project index; adopt it into any pane still showing the placeholder `... 새 세션` title.
 */
function applyTitles(panes: PaneState[], projects: ProjectEntry[]): PaneState[] {
  return panes.map((p) => {
    const sessionId = p.session?.sessionId;
    if (!sessionId) return p;
    const found = projects.flatMap((pr) => pr.sessions).find((s) => s.sessionId === sessionId);
    return found && found.title !== p.session!.title ? { ...p, session: { ...p.session!, title: found.title } } : p;
  });
}

/** 자동 승인 changes the default sandbox of new GPT sessions; panes still on the old default follow it. */
function applySettings(state: AppState, settings: DeckSettings | undefined): AppState {
  if (!settings || settings.autoApprove === state.autoApprove) return state;
  const from = defaultSandbox(state.autoApprove ?? false);
  const to = defaultSandbox(settings.autoApprove);
  return { ...state, autoApprove: settings.autoApprove, panes: state.panes.map((p) => (p.sandbox === from ? { ...p, sandbox: to } : p)) };
}

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'hello':
      return applySettings({ ...state, connected: true, activity: msg.activity ?? state.activity, usage: msg.usage, projects: msg.projects, pins: msg.pins ?? state.pins, desktop: msg.desktop ?? state.desktop, codexAvailable: msg.codex.available, gemini: msg.gemini ?? null, panes: applyTitles(mapPanes(state, msg), msg.projects) }, msg.settings);
    case 'settings': return applySettings(state, msg.settings);
    case 'usage': return { ...state, usage: msg.usage };
    case 'index': return { ...state, projects: msg.projects, pins: msg.pins ?? state.pins, desktop: msg.desktop ?? state.desktop, panes: applyTitles(state.panes, msg.projects) };
    case 'history': {
      // Every pane with this session open (`open` records the id before open_session is sent, so a pane still
      // waiting for its reply counts). A history no pane views — its pane was closed or switched while the reply
      // was in flight — is dropped, never adopted by a blank pane (T9 prerequisite b).
      if (!state.panes.some((p) => p.session?.sessionId === msg.sessionId)) return state;
      return { ...state, panes: state.panes.map((p) => (p.session?.sessionId === msg.sessionId ? paneOnServer(p, msg, false) : p)) };
    }
    case 'permission_request': {
      // Prompts from every session are shown (any device may answer); replays on reconnect are deduped (review M10).
      if (state.pending.some((p) => p.requestId === msg.requestId)) return state;
      const { type: _t, ...req } = msg;
      return { ...state, pending: [...state.pending, req] };
    }
    case 'permission_resolved': return { ...state, pending: state.pending.filter((p) => p.requestId !== msg.requestId) };
    case 'question_request': {
      if (state.questions.some((q) => q.requestId === msg.requestId)) return state;
      const { type: _t, ...req } = msg;
      return { ...state, questions: [...state.questions, req] };
    }
    case 'question_resolved': return { ...state, questions: state.questions.filter((q) => q.requestId !== msg.requestId) };
    case 'turn_started': {
      let claimed = false;
      const panes = state.panes.map((p) => {
        const canClaim = !claimed && p.awaitingStart;
        const next = paneOnServer(p, msg, canClaim);
        if (canClaim && next.myTurns.includes(msg.turnId)) claimed = true;
        return next;
      });
      return { ...state, panes };
    }
    case 'delta': case 'tool_call': case 'tool_result': case 'turn_retry': case 'turn_background':
    case 'turn_progress': case 'task_update': case 'task_done': case 'sub_tool_call': case 'sub_tool_result':
      return { ...state, panes: mapPanes(state, msg) };
    case 'activity': {
      // A turn that finished while no focused pane showed its session leaves an unread dot.
      const focused = state.panes.find((p) => p.id === state.activePaneId)?.session?.sessionId ?? null;
      const finished = state.activity.filter((a) => a.running && !msg.sessions.some((n) => n.sessionId === a.sessionId && n.running)).map((a) => a.sessionId);
      const add = finished.filter((sid) => sid !== focused && !state.unread.includes(sid));
      return { ...state, activity: msg.sessions, unread: add.length ? [...state.unread, ...add] : state.unread, panes: mapPanes(state, msg) };
    }
    case 'turn_notice': {
      const panes = mapPanes(state, msg);
      if (panes.some((p, i) => p !== state.panes[i])) return { ...state, panes };
      // A pane owns this turn but has no item for it: surface the notice globally. Other sessions' notices are ignored.
      return state.panes.some((p) => belongs(p, msg)) ? { ...state, error: msg.message } : state;
    }
    case 'turn_result':
      return { ...state, panes: mapPanes(state, msg), pending: state.pending.filter((p) => p.turnId !== msg.turnId), questions: state.questions.filter((q) => q.turnId !== msg.turnId) };
    case 'error':
      return { ...state, panes: mapPanes(state, msg), error: msg.message };
  }
}

function updatePane(state: AppState, paneId: string | undefined, fn: (p: PaneState) => PaneState): AppState {
  const id = paneId ?? state.activePaneId;
  return { ...state, panes: state.panes.map((p) => (p.id === id ? fn(p) : p)) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server': {
      const next = onServer(state, action.msg);
      const msg = action.msg;
      if (msg.type !== 'history' || !action.sentFiles?.length) return next;
      const records = action.sentFiles;
      return { ...next, panes: next.panes.map((p) => (p.session?.sessionId === msg.sessionId ? { ...p, items: restoreSentFiles(p.items, records) } : p)) };
    }
    case 'connected': return { ...state, connected: action.value };
    // Prompts stay: they belong to their own session and the card says which (review I3).
    case 'open': return updatePane({ ...state, unread: action.sessionId ? state.unread.filter((u) => u !== action.sessionId) : state.unread }, action.paneId, (p) => ({
      ...p,
      session: { sessionId: action.sessionId, cwd: action.cwd, account: null, title: action.title, engine: action.sessionId === null && p.engine !== 'auto' ? p.engine : null, sandbox: null },
      items: [], activeTurnId: null, myTurns: [], awaitingStart: false, awaitingRef: null, attachments: [], queue: [], queuePaused: false, ...ACTIVITY_RESET,
    }));
    case 'sent': return updatePane(state, action.paneId, (p) => ({
      ...p,
      items: [...p.items, { kind: 'user', text: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}) }],
      awaitingStart: true, awaitingRef: action.clientRef ?? null, attachments: [], queuePaused: false,
      ...(p.activeTurnId === null ? { runStartedAt: Date.now(), progress: null } : {}),
    }));
    case 'set_model': return updatePane(state, action.paneId, (p) => ({ ...p, model: action.model }));
    case 'set_effort': return updatePane(state, action.paneId, (p) => ({ ...p, efforts: { ...p.efforts, [action.engine]: action.effort } }));
    case 'set_auto_effort': return updatePane(state, action.paneId, (p) => ({ ...p, autoEffort: action.effort }));
    case 'set_engine': return updatePane(state, action.paneId, (p) => ({ ...p, engine: action.engine, model: action.engine === 'auto' ? (isGeminiModel(p.model) ? DEFAULT_MODEL : p.model) : modelFor(action.engine, p.model) }));
    case 'set_sandbox': return updatePane(state, action.paneId, (p) => ({ ...p, sandbox: action.sandbox }));
    case 'attach': return updatePane(state, action.paneId, (p) => (p.attachments.some((a) => a.id === action.attachment.id) ? p : { ...p, attachments: [...p.attachments, action.attachment] }));
    case 'unattach': return updatePane(state, action.paneId, (p) => ({ ...p, attachments: p.attachments.filter((a) => a.id !== action.id) }));
    case 'add_pane': {
      if (state.panes.length >= MAX_PANES) return state;
      const n = Math.max(...state.panes.map((p) => Number(p.id.slice(1)) || 0)) + 1;
      const pane = { ...newPane(`p${n}`), sandbox: defaultSandbox(state.autoApprove ?? false) };
      return { ...state, panes: [...state.panes, pane], activePaneId: pane.id };
    }
    case 'close_pane': {
      if (state.panes.length <= 1) return state;
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      return { ...state, panes, activePaneId: state.activePaneId === action.paneId ? panes[0]!.id : state.activePaneId };
    }
    case 'focus_pane': {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) return state;
      const sid = pane.session?.sessionId;
      return { ...state, activePaneId: action.paneId, unread: sid && state.unread.includes(sid) ? state.unread.filter((u) => u !== sid) : state.unread };
    }
    case 'dismiss_error': return { ...state, error: null };
    case 'set_pins': return { ...state, pins: action.pins };
    case 'show_error': return { ...state, error: action.message };
    case 'queue_add': {
      const text = action.text.trim();
      return updatePane(state, action.paneId, (p) => (!text && !p.attachments.length ? p : { ...p, queue: [...p.queue, { id: nextQueueId(), text, attachments: p.attachments }], attachments: [] }));
    }
    case 'queue_edit': return updatePane(state, action.paneId, (p) => ({ ...p, queue: p.queue.map((q) => (q.id === action.id ? { ...q, text: action.text } : q)) }));
    case 'queue_remove': return updatePane(state, action.paneId, (p) => ({ ...p, queue: p.queue.filter((q) => q.id !== action.id) }));
    case 'queue_clear': return updatePane(state, action.paneId, (p) => ({ ...p, queue: [], queuePaused: false }));
    case 'queue_pause': return updatePane(state, action.paneId, (p) => ({ ...p, queuePaused: true }));
    case 'queue_resume': return updatePane(state, action.paneId, (p) => ({ ...p, queuePaused: false }));
  }
}

/** The permission/question cards a pane shows: those of its session or of turns it started. */
export function cardsForPane<T extends { turnId: string; sessionId: string | null }>(pane: PaneState, cards: T[]): T[] {
  return cards.filter((c) => pane.myTurns.includes(c.turnId) || c.turnId === pane.activeTurnId || (c.sessionId !== null && c.sessionId === pane.session?.sessionId));
}

/** Cards no open pane claims (another device's session): shown in the app-level strip. */
export function orphanCards<T extends { turnId: string; sessionId: string | null }>(panes: PaneState[], cards: T[]): T[] {
  const shown = new Set(panes.flatMap((p) => cardsForPane(p, cards)));
  return cards.filter((c) => !shown.has(c));
}

/**
 * Sessions some pane viewed in `prev` that no pane views in `next` (pane closed or switched to another
 * session). The app sends `close_session` for each so the server's per-socket view set shrinks too.
 * A new session receiving its id (null → id) is not a release: null ids are never listed.
 */
export function sessionsToClose(prev: AppState, next: AppState): string[] {
  const viewed = (s: AppState) => new Set(s.panes.map((p) => p.session?.sessionId).filter((id): id is string => !!id));
  const still = viewed(next);
  return [...viewed(prev)].filter((id) => !still.has(id));
}

/**
 * The `question_response.answers` map: keyed by each asked question's exact text (the server drops
 * other keys); multi-select picks are comma-joined; unanswered questions are omitted; clipped to the protocol limits.
 */
export function answersFor(q: PendingQuestion, values: (string | string[])[]): Record<string, string> {
  const out: Record<string, string> = {};
  q.questions.forEach((question, i) => {
    const v = values[i];
    const text = (Array.isArray(v) ? v.join(', ') : (v ?? '')).slice(0, 4000);
    // protocol.ts question_response limits: keys 2000, values 4000.
    if (text) out[question.question.slice(0, 2000)] = text;
  });
  return out;
}

let queueSeq = 0;
const nextQueueId = () => `q${++queueSeq}`;

/** ux-state: the queued message a pane should send now — its turn is over, nothing is pending, the queue isn't paused. */
export function nextQueued(pane: PaneState): QueueItem | null {
  if (pane.queuePaused || !pane.session || pane.activeTurnId !== null || pane.awaitingStart) return null;
  return pane.queue[0] ?? null;
}

/**
 * Transcripts carry no attachment ids (images are inline blocks, files are path lines), so the files of
 * messages sent from this browser are matched back by text, in order: the transcript's user text starts
 * with what was typed, then a line break (the server appends path lines / an image marker after it).
 */
export function restoreSentFiles(items: ChatItem[], records: SentRecord[]): ChatItem[] {
  let r = 0;
  return items.map((it) => {
    if (it.kind !== 'user' || it.attachments?.length || r >= records.length) return it;
    for (let j = r; j < records.length; j++) {
      const rec = records[j]!;
      if (rec.text && (it.text === rec.text || it.text.startsWith(`${rec.text}\n`))) { r = j + 1; return { ...it, attachments: rec.files }; }
    }
    return it;
  });
}
