import type { Account } from '../shared/accounts';
import { DEFAULT_MODEL, type ClaudeModel } from '../shared/models';
import type { ServerMessage, TurnBadge } from '../shared/protocol';
import type { ProjectEntry, TranscriptMessage } from '../shared/session-types';
import type { UsageSnapshot } from '../shared/usage-types';

export type ToolCallItem = { toolUseId: string; name: string; input: unknown; result: string | null; isError: boolean };

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; turnId: string | null; text: string; toolCalls: ToolCallItem[]; badge: TurnBadge | null; streaming: boolean; error: string | null; notes: string[] };

export type PendingPermission = Omit<Extract<ServerMessage, { type: 'permission_request' }>, 'type'>;

export type AppState = {
  connected: boolean;
  usage: UsageSnapshot | null;
  projects: ProjectEntry[];
  session: { sessionId: string | null; cwd: string; account: Account | null; title: string } | null;
  items: ChatItem[];
  pending: PendingPermission[];
  activeTurnId: string | null;
  /** Review I3: turns this tab started (claimed at their first turn_started after a `sent`). */
  myTurns: string[];
  /** A `sent` whose turn_started (or error) has not arrived yet. */
  awaitingStart: boolean;
  error: string | null;
  model: ClaudeModel;
};

export type Action =
  | { type: 'server'; msg: ServerMessage }
  | { type: 'connected'; value: boolean }
  | { type: 'open'; sessionId: string | null; cwd: string; title: string }
  | { type: 'sent'; text: string }
  | { type: 'set_model'; model: ClaudeModel }
  | { type: 'dismiss_error' };

export const initialState: AppState = { connected: false, usage: null, projects: [], session: null, items: [], pending: [], activeTurnId: null, myTurns: [], awaitingStart: false, error: null, model: DEFAULT_MODEL };

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

export function fromTranscript(messages: TranscriptMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.kind === 'user') items.push({ kind: 'user', text: m.text });
    else if (m.kind === 'assistant') {
      items.push({ kind: 'assistant', turnId: null, text: m.text, toolCalls: m.toolCalls.map((t) => ({ toolUseId: t.id, name: t.name, input: t.input, result: null, isError: false })), badge: null, streaming: false, error: null, notes: [] });
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

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

function updateTurn(state: AppState, turnId: string, fn: (item: AssistantItem) => AssistantItem): AppState {
  const idx = state.items.findIndex((it) => it.kind === 'assistant' && it.turnId === turnId);
  if (idx < 0) return state;
  const items = state.items.slice();
  items[idx] = fn(items[idx] as AssistantItem);
  return { ...state, items };
}

type TurnMsg = Extract<ServerMessage, { turnId: string; cwd: string }>;

/** Review I3: a turn event is applied only if it belongs to the session this tab has open. */
function belongs(state: AppState, msg: TurnMsg): boolean {
  if (!state.session) return false;
  if (state.myTurns.includes(msg.turnId) || msg.turnId === state.activeTurnId) return true;
  return msg.sessionId !== null && msg.sessionId === state.session.sessionId;
}

function streamingItem(turnId: string): AssistantItem {
  return { kind: 'assistant', turnId, text: '', toolCalls: [], badge: null, streaming: true, error: null, notes: [] };
}

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'hello': {
      // Reconnect: show 중단 for a turn still running on the open session; drop one that ended meanwhile.
      const sid = state.session?.sessionId ?? null;
      const live = msg.running.find((r) => r.turnId === state.activeTurnId) ?? (sid ? msg.running.find((r) => r.sessionId === sid) : undefined);
      const activeTurnId = live?.turnId ?? null;
      const items = activeTurnId === state.activeTurnId ? state.items : state.items.map((it) => (it.kind === 'assistant' && it.streaming && it.turnId === state.activeTurnId ? { ...it, streaming: false } : it));
      return { ...state, connected: true, usage: msg.usage, projects: msg.projects, activeTurnId, items, awaitingStart: false };
    }
    case 'usage': return { ...state, usage: msg.usage };
    case 'index': return { ...state, projects: msg.projects };
    case 'history': {
      const items = fromTranscript(msg.messages);
      if (msg.runningTurnId) items.push(streamingItem(msg.runningTurnId));
      return { ...state, session: { sessionId: msg.sessionId, cwd: msg.cwd, account: msg.account, title: state.session?.sessionId === msg.sessionId ? state.session.title : msg.sessionId.slice(0, 8) }, items, activeTurnId: msg.runningTurnId };
    }
    case 'turn_started': {
      let s = state;
      const sess = state.session;
      if (state.awaitingStart && sess && !state.myTurns.includes(msg.turnId) && (msg.sessionId === sess.sessionId || (msg.sessionId === null && sess.sessionId === null && msg.cwd === sess.cwd))) {
        s = { ...state, awaitingStart: false, myTurns: [...state.myTurns, msg.turnId] };
      }
      if (!belongs(s, msg)) return s;
      const exists = s.items.some((it) => it.kind === 'assistant' && it.turnId === msg.turnId);
      const items = exists ? s.items.map((it) => (it.kind === 'assistant' && it.turnId === msg.turnId ? { ...it, streaming: true } : it)) : [...s.items, streamingItem(msg.turnId)];
      return { ...s, items, activeTurnId: msg.turnId };
    }
    case 'delta':
      if (!belongs(state, msg)) return state;
      return updateTurn(state, msg.turnId, (it) => ({ ...it, text: it.text + msg.text }));
    case 'tool_call':
      if (!belongs(state, msg)) return state;
      return updateTurn(state, msg.turnId, (it) => ({ ...it, toolCalls: [...it.toolCalls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, result: null, isError: false }] }));
    case 'tool_result':
      if (!belongs(state, msg)) return state;
      return updateTurn(state, msg.turnId, (it) => ({ ...it, toolCalls: it.toolCalls.map((t) => (t.toolUseId === msg.toolUseId ? { ...t, result: msg.content, isError: msg.isError } : t)) }));
    case 'permission_request': {
      // Prompts from every session are shown (any device may answer); replays on reconnect are deduped (review M10).
      if (state.pending.some((p) => p.requestId === msg.requestId)) return state;
      const { type: _t, ...req } = msg;
      return { ...state, pending: [...state.pending, req] };
    }
    case 'permission_resolved': return { ...state, pending: state.pending.filter((p) => p.requestId !== msg.requestId) };
    case 'turn_retry':
      if (!belongs(state, msg)) return state;
      return updateTurn(state, msg.turnId, (it) => ({ ...it, notes: [...it.notes, `재시도 ${LABEL[msg.fromAccount]} → ${LABEL[msg.toAccount]}: ${msg.reason}`] }));
    case 'turn_notice': {
      if (!belongs(state, msg)) return state;
      const next = updateTurn(state, msg.turnId, (it) => ({ ...it, notes: [...it.notes, msg.message] }));
      return next === state ? { ...state, error: msg.message } : next;
    }
    case 'turn_result': {
      const mine = state.myTurns.includes(msg.turnId);
      const myTurns = mine ? state.myTurns.filter((t) => t !== msg.turnId) : state.myTurns;
      const pending = state.pending.filter((p) => p.turnId !== msg.turnId);
      if (!belongs(state, msg)) return { ...state, myTurns, pending };
      const next = updateTurn(state, msg.turnId, (it) => ({ ...it, streaming: false, badge: msg.badge ?? it.badge, text: it.text || msg.text, error: msg.ok ? null : (msg.errorText ?? '실패') }));
      // Only a turn this tab started may re-point the tab's session (id / account).
      const session = mine && next.session ? { ...next.session, sessionId: msg.sessionId || next.session.sessionId, account: msg.badge?.account ?? next.session.account } : next.session;
      return { ...next, session, myTurns, pending, activeTurnId: state.activeTurnId === msg.turnId ? null : state.activeTurnId };
    }
    case 'error': {
      const withItem = msg.turnId ? updateTurn(state, msg.turnId, (it) => ({ ...it, streaming: false, error: it.error ?? msg.message })) : state;
      // Review I6: an error that names the running turn ends it, or the composer stays locked on 중단.
      const activeTurnId = msg.turnId !== null && msg.turnId === state.activeTurnId ? null : withItem.activeTurnId;
      // A send refused before it started (busy session, bad cwd) is answered with a turn-less error.
      const awaitingStart = msg.turnId === null ? false : withItem.awaitingStart;
      return { ...withItem, activeTurnId, awaitingStart, error: msg.message };
    }
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server': return onServer(state, action.msg);
    case 'connected': return { ...state, connected: action.value };
    // Prompts stay: they belong to their own session and the card says which (review I3).
    case 'open': return { ...state, session: { sessionId: action.sessionId, cwd: action.cwd, account: null, title: action.title }, items: [], activeTurnId: null, myTurns: [], awaitingStart: false };
    case 'sent': return { ...state, items: [...state.items, { kind: 'user', text: action.text }], awaitingStart: true };
    case 'set_model': return { ...state, model: action.model };
    case 'dismiss_error': return { ...state, error: null };
  }
}
