import type { Account, Seat } from '../shared/accounts';
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL, DEFAULT_SANDBOX, isClaudeModel, isCodexModel, type AnyModel, type CodexSandbox, type EngineChoice, type EngineKind } from '../shared/models';
import type { ServerMessage, TurnBadge } from '../shared/protocol';
import type { ProjectEntry, TranscriptMessage } from '../shared/session-types';
import type { UsageSnapshot } from '../shared/usage-types';

export type ToolCallItem = { toolUseId: string; name: string; input: unknown; result: string | null; isError: boolean };

export type ChatItem =
  | { kind: 'user'; text: string; /** attachment names, display only */ attachments?: string[] }
  | { kind: 'assistant'; turnId: string | null; text: string; toolCalls: ToolCallItem[]; badge: TurnBadge | null; streaming: boolean; error: string | null; notes: string[]; attempts: string[] };

export type PendingPermission = Omit<Extract<ServerMessage, { type: 'permission_request' }>, 'type'>;
export type PendingQuestion = Omit<Extract<ServerMessage, { type: 'question_request' }>, 'type'>;
export type UploadedAttachment = { id: string; name: string; size: number; isImage: boolean };

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
  model: AnyModel;
  /** New-session choices (D2, D3); the server ignores them once the session exists. */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  attachments: UploadedAttachment[];
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
};

export const MAX_PANES = 4;

export function newPane(id: string): PaneState {
  return { id, session: null, items: [], activeTurnId: null, myTurns: [], awaitingStart: false, model: DEFAULT_MODEL, engine: 'claude', sandbox: DEFAULT_SANDBOX, attachments: [] };
}

export const initialState: AppState = { connected: false, usage: null, projects: [], pending: [], questions: [], panes: [newPane('p0')], activePaneId: 'p0', error: null, codexAvailable: false };

export type Action =
  | { type: 'server'; msg: ServerMessage }
  | { type: 'connected'; value: boolean }
  | { type: 'open'; sessionId: string | null; cwd: string; title: string; paneId?: string }
  | { type: 'sent'; text: string; paneId?: string; attachments?: string[] }
  | { type: 'set_model'; model: AnyModel; paneId?: string }
  | { type: 'set_engine'; engine: EngineChoice; paneId?: string }
  | { type: 'set_sandbox'; sandbox: CodexSandbox; paneId?: string }
  | { type: 'attach'; attachment: UploadedAttachment; paneId?: string }
  | { type: 'unattach'; id: string; paneId?: string }
  | { type: 'add_pane' }
  | { type: 'close_pane'; paneId: string }
  | { type: 'focus_pane'; paneId: string }
  | { type: 'dismiss_error' };

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

export function fromTranscript(messages: TranscriptMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.kind === 'user') items.push({ kind: 'user', text: m.text });
    else if (m.kind === 'assistant') {
      items.push({ kind: 'assistant', turnId: null, text: m.text, toolCalls: m.toolCalls.map((t) => ({ toolUseId: t.id, name: t.name, input: t.input, result: null, isError: false })), badge: null, streaming: false, error: null, notes: [], attempts: [] });
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

/** The pane's model if it belongs to `engine`, else that engine's default. */
function modelFor(engine: EngineKind, model: AnyModel): AnyModel {
  if (engine === 'codex') return isCodexModel(model) ? model : DEFAULT_CODEX_MODEL;
  return isClaudeModel(model) ? model : DEFAULT_MODEL;
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

/** One pane's view of a server message. `claim`: this pane may claim an unclaimed turn_started (only the first waiting pane does). */
function paneOnServer(pane: PaneState, msg: ServerMessage, claim: boolean): PaneState {
  switch (msg.type) {
    case 'hello': {
      // Reconnect: show 중단 for a turn still running on the open session; drop one that ended meanwhile.
      const sid = pane.session?.sessionId ?? null;
      const live = msg.running.find((r) => r.turnId === pane.activeTurnId) ?? (sid ? msg.running.find((r) => r.sessionId === sid) : undefined);
      const activeTurnId = live?.turnId ?? null;
      const items = activeTurnId === pane.activeTurnId ? pane.items : pane.items.map((it) => (it.kind === 'assistant' && it.streaming && it.turnId === pane.activeTurnId ? { ...it, streaming: false } : it));
      return { ...pane, activeTurnId, items, awaitingStart: false };
    }
    case 'history': {
      const items = fromTranscript(msg.messages);
      if (msg.runningTurnId) items.push(streamingItem(msg.runningTurnId));
      const title = pane.session?.sessionId === msg.sessionId ? pane.session.title : msg.sessionId.slice(0, 8);
      const engine: EngineKind = msg.engine ?? 'claude';
      // PF13: a Claude session is never sent a GPT model and vice versa.
      const model = modelFor(engine, pane.model);
      return { ...pane, session: { sessionId: msg.sessionId, cwd: msg.cwd, account: msg.account, title, engine, sandbox: msg.sandbox ?? null }, items, activeTurnId: msg.runningTurnId, model };
    }
    case 'turn_started': {
      let p = pane;
      const sess = pane.session;
      if (claim && pane.awaitingStart && sess && !pane.myTurns.includes(msg.turnId) && (msg.sessionId === sess.sessionId || (msg.sessionId === null && sess.sessionId === null && msg.cwd === sess.cwd))) {
        p = { ...pane, awaitingStart: false, myTurns: [...pane.myTurns, msg.turnId], session: { ...sess, engine: msg.engine ?? 'claude' } };
      }
      if (!belongs(p, msg)) return p;
      const exists = p.items.some((it) => it.kind === 'assistant' && it.turnId === msg.turnId);
      const items = exists ? p.items.map((it) => (it.kind === 'assistant' && it.turnId === msg.turnId ? { ...it, streaming: true } : it)) : [...p.items, streamingItem(msg.turnId)];
      return { ...p, items, activeTurnId: msg.turnId };
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
    case 'turn_notice':
      if (!belongs(pane, msg)) return pane;
      return updateTurn(pane, msg.turnId, (it) => ({ ...it, notes: [...it.notes, msg.message] }));
    case 'turn_result': {
      const mine = pane.myTurns.includes(msg.turnId);
      const myTurns = mine ? pane.myTurns.filter((t) => t !== msg.turnId) : pane.myTurns;
      if (!belongs(pane, msg)) return myTurns === pane.myTurns ? pane : { ...pane, myTurns };
      const next = updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, badge: msg.badge ?? it.badge, text: it.text || msg.text, error: msg.ok ? null : (msg.errorText ?? '실패') }));
      // Only a turn this pane started may re-point the pane's session (id / account).
      const session = mine && next.session ? { ...next.session, sessionId: msg.sessionId || next.session.sessionId, account: msg.badge?.account ?? next.session.account } : next.session;
      return { ...next, session, myTurns, activeTurnId: pane.activeTurnId === msg.turnId ? null : pane.activeTurnId };
    }
    case 'error': {
      const withItem = msg.turnId ? updateTurn(pane, msg.turnId, (it) => ({ ...it, streaming: false, error: it.error ?? msg.message })) : pane;
      // Review I6: an error that names the running turn ends it, or the composer stays locked on 중단.
      const activeTurnId = msg.turnId !== null && msg.turnId === pane.activeTurnId ? null : withItem.activeTurnId;
      // A send refused before its turn started (busy session, bad cwd, unknown session) ends the wait.
      const awaitingStart = msg.turnId === null || !pane.myTurns.includes(msg.turnId) ? false : withItem.awaitingStart;
      return { ...withItem, activeTurnId, awaitingStart };
    }
    default:
      return pane;
  }
}

function mapPanes(state: AppState, msg: ServerMessage): PaneState[] {
  return state.panes.map((p) => paneOnServer(p, msg, false));
}

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'hello':
      return { ...state, connected: true, usage: msg.usage, projects: msg.projects, codexAvailable: msg.codex.available, panes: mapPanes(state, msg) };
    case 'usage': return { ...state, usage: msg.usage };
    case 'index': return { ...state, projects: msg.projects };
    case 'history': {
      // The pane that has this session open; else the active pane (a history for a just-opened session).
      const found = state.panes.findIndex((p) => p.session?.sessionId === msg.sessionId);
      const idx = found >= 0 ? found : Math.max(0, state.panes.findIndex((p) => p.id === state.activePaneId));
      const panes = state.panes.slice();
      panes[idx] = paneOnServer(panes[idx]!, msg, false);
      return { ...state, panes };
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
    case 'delta': case 'tool_call': case 'tool_result': case 'turn_retry':
      return { ...state, panes: mapPanes(state, msg) };
    case 'turn_notice': {
      const panes = mapPanes(state, msg);
      const changed = panes.some((p, i) => p !== state.panes[i]);
      return changed ? { ...state, panes } : { ...state, error: msg.message };
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
    case 'server': return onServer(state, action.msg);
    case 'connected': return { ...state, connected: action.value };
    // Prompts stay: they belong to their own session and the card says which (review I3).
    case 'open': return updatePane(state, action.paneId, (p) => ({
      ...p,
      session: { sessionId: action.sessionId, cwd: action.cwd, account: null, title: action.title, engine: action.sessionId === null && p.engine !== 'auto' ? p.engine : null, sandbox: null },
      items: [], activeTurnId: null, myTurns: [], awaitingStart: false, attachments: [],
    }));
    case 'sent': return updatePane(state, action.paneId, (p) => ({
      ...p,
      items: [...p.items, { kind: 'user', text: action.text, ...(action.attachments?.length ? { attachments: action.attachments } : {}) }],
      awaitingStart: true, attachments: [],
    }));
    case 'set_model': return updatePane(state, action.paneId, (p) => ({ ...p, model: action.model }));
    case 'set_engine': return updatePane(state, action.paneId, (p) => ({ ...p, engine: action.engine, model: action.engine === 'auto' ? p.model : modelFor(action.engine, p.model) }));
    case 'set_sandbox': return updatePane(state, action.paneId, (p) => ({ ...p, sandbox: action.sandbox }));
    case 'attach': return updatePane(state, action.paneId, (p) => (p.attachments.some((a) => a.id === action.attachment.id) ? p : { ...p, attachments: [...p.attachments, action.attachment] }));
    case 'unattach': return updatePane(state, action.paneId, (p) => ({ ...p, attachments: p.attachments.filter((a) => a.id !== action.id) }));
    case 'add_pane': {
      if (state.panes.length >= MAX_PANES) return state;
      const n = Math.max(...state.panes.map((p) => Number(p.id.slice(1)) || 0)) + 1;
      const pane = newPane(`p${n}`);
      return { ...state, panes: [...state.panes, pane], activePaneId: pane.id };
    }
    case 'close_pane': {
      if (state.panes.length <= 1) return state;
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      return { ...state, panes, activePaneId: state.activePaneId === action.paneId ? panes[0]!.id : state.activePaneId };
    }
    case 'focus_pane': return state.panes.some((p) => p.id === action.paneId) ? { ...state, activePaneId: action.paneId } : state;
    case 'dismiss_error': return { ...state, error: null };
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
 * other keys); multi-select picks are comma-joined; unanswered questions are omitted.
 */
export function answersFor(q: PendingQuestion, values: (string | string[])[]): Record<string, string> {
  const out: Record<string, string> = {};
  q.questions.forEach((question, i) => {
    const v = values[i];
    const text = Array.isArray(v) ? v.join(', ') : (v ?? '');
    if (text) out[question.question] = text;
  });
  return out;
}
