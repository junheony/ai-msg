import type { Account } from '../shared/accounts';
import { DEFAULT_MODEL, type ClaudeModel } from '../shared/models';
import type { ServerMessage, TurnBadge } from '../shared/protocol';
import type { ProjectEntry, TranscriptMessage } from '../shared/session-types';
import type { UsageSnapshot } from '../shared/usage-types';

export type ToolCallItem = { toolUseId: string; name: string; input: unknown; result: string | null; isError: boolean };

export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; turnId: string | null; text: string; toolCalls: ToolCallItem[]; badge: TurnBadge | null; streaming: boolean; error: string | null; notes: string[] };

export type PendingPermission = { turnId: string; requestId: string; toolName: string; input: unknown };

export type AppState = {
  connected: boolean;
  usage: UsageSnapshot | null;
  projects: ProjectEntry[];
  session: { sessionId: string | null; cwd: string; account: Account | null; title: string } | null;
  items: ChatItem[];
  pending: PendingPermission[];
  activeTurnId: string | null;
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

export const initialState: AppState = { connected: false, usage: null, projects: [], session: null, items: [], pending: [], activeTurnId: null, error: null, model: DEFAULT_MODEL };

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

function onServer(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'hello': return { ...state, connected: true, usage: msg.usage, projects: msg.projects };
    case 'usage': return { ...state, usage: msg.usage };
    case 'index': return { ...state, projects: msg.projects };
    case 'history':
      return { ...state, session: { sessionId: msg.sessionId, cwd: msg.cwd, account: msg.account, title: state.session?.sessionId === msg.sessionId ? state.session.title : msg.sessionId.slice(0, 8) }, items: fromTranscript(msg.messages), pending: [], activeTurnId: null };
    case 'turn_started': {
      const exists = state.items.some((it) => it.kind === 'assistant' && it.turnId === msg.turnId);
      const items = exists ? state.items : [...state.items, { kind: 'assistant' as const, turnId: msg.turnId, text: '', toolCalls: [], badge: null, streaming: true, error: null, notes: [] }];
      return { ...state, items, activeTurnId: msg.turnId };
    }
    case 'delta': return updateTurn(state, msg.turnId, (it) => ({ ...it, text: it.text + msg.text }));
    case 'tool_call': return updateTurn(state, msg.turnId, (it) => ({ ...it, toolCalls: [...it.toolCalls, { toolUseId: msg.toolUseId, name: msg.name, input: msg.input, result: null, isError: false }] }));
    case 'tool_result': return updateTurn(state, msg.turnId, (it) => ({ ...it, toolCalls: it.toolCalls.map((t) => (t.toolUseId === msg.toolUseId ? { ...t, result: msg.content, isError: msg.isError } : t)) }));
    case 'permission_request': return { ...state, pending: [...state.pending, { turnId: msg.turnId, requestId: msg.requestId, toolName: msg.toolName, input: msg.input }] };
    case 'permission_resolved': return { ...state, pending: state.pending.filter((p) => p.requestId !== msg.requestId) };
    case 'turn_retry': return updateTurn(state, msg.turnId, (it) => ({ ...it, notes: [...it.notes, `${LABEL[msg.fromAccount]} → ${LABEL[msg.toAccount]}: ${msg.reason}`] }));
    case 'turn_result': {
      const next = updateTurn(state, msg.turnId, (it) => ({ ...it, streaming: false, badge: msg.badge ?? it.badge, text: it.text || msg.text, error: msg.ok ? null : (msg.errorText ?? '실패') }));
      const session = next.session ? { ...next.session, sessionId: msg.sessionId || next.session.sessionId, account: msg.badge?.account ?? next.session.account } : next.session;
      return { ...next, session, activeTurnId: null, pending: next.pending.filter((p) => p.turnId !== msg.turnId) };
    }
    case 'error': {
      const withItem = msg.turnId ? updateTurn(state, msg.turnId, (it) => ({ ...it, streaming: false, error: it.error ?? msg.message })) : state;
      // Review I6: an error that names the running turn ends it, or the composer stays locked on 중단.
      const activeTurnId = msg.turnId !== null && msg.turnId === state.activeTurnId ? null : withItem.activeTurnId;
      return { ...withItem, activeTurnId, error: msg.message };
    }
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server': return onServer(state, action.msg);
    case 'connected': return { ...state, connected: action.value };
    case 'open': return { ...state, session: { sessionId: action.sessionId, cwd: action.cwd, account: null, title: action.title }, items: [], pending: [], activeTurnId: null };
    case 'sent': return { ...state, items: [...state.items, { kind: 'user', text: action.text }] };
    case 'set_model': return { ...state, model: action.model };
    case 'dismiss_error': return { ...state, error: null };
  }
}
