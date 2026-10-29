import type { CliControlRequest, CliMessage, Rec } from './messages';
import { lastCallUsageOf, type ContextCategory, type ContextCategoryId, type LastCallUsage } from '../../../shared/turn-types';

/** Category ids Claude's context usage reports that MSG shows. Free space, buffers, and deferred rows are not in this list. */
export const CONTEXT_CATEGORY_IDS: readonly ContextCategoryId[] = [
  'system_prompt', 'system_tools', 'mcp_tools', 'mcp_instructions', 'custom_agents', 'memory_files', 'skills', 'messages',
];

const ID_SET = new Set<string>(CONTEXT_CATEGORY_IDS);

/** English names from Claude's /context breakdown, used when an older CLI sends no id. */
const NAME_TO_ID: Record<string, ContextCategoryId> = {
  'System prompt': 'system_prompt',
  'System tools': 'system_tools',
  'MCP tools': 'mcp_tools',
  'MCP instructions': 'mcp_instructions',
  'MCP server instructions': 'mcp_instructions',
  'Custom agents': 'custom_agents',
  'Memory files': 'memory_files',
  Skills: 'skills',
  Messages: 'messages',
};

/**
 * A get_context_usage payload (or assistant `context_usage`).
 * null when this is not a context payload (no `categories` array). [] when the array has no row MSG can show.
 */
export function parseContextPayload(payload: unknown): ContextCategory[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const categories = (payload as Rec).categories;
  if (!Array.isArray(categories)) return null;
  const totals = new Map<ContextCategoryId, number>();
  const order: ContextCategoryId[] = [];
  for (const row of categories) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Rec;
    if (r.isDeferred === true) continue;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    if (kind === 'free' || kind === 'buffer' || kind === 'deferred') continue;
    const id = typeof r.id === 'string' && ID_SET.has(r.id) ? (r.id as ContextCategoryId) : null;
    const fromName = typeof r.name === 'string' ? NAME_TO_ID[r.name] : undefined;
    const resolved = id ?? fromName ?? null;
    if (!resolved) continue;
    const tokens = typeof r.tokens === 'number' && Number.isFinite(r.tokens) ? r.tokens : 0;
    if (tokens <= 0) continue;
    if (!totals.has(resolved)) order.push(resolved);
    totals.set(resolved, (totals.get(resolved) ?? 0) + tokens);
  }
  return order.map((id) => ({ id, tokens: totals.get(id)! }));
}

export function contextUsageRequest(id: string): CliControlRequest {
  return { type: 'control_request', request_id: id, request: { subtype: 'get_context_usage', detail: 'summary' } };
}

export type ContextUsageAnswer = { categories: ContextCategory[]; api: LastCallUsage | null };

/**
 * The control_response for `requestId`. null when the frame is a different request.
 * An error response is an answer with no rows, so the turn does not keep waiting.
 */
export function parseContextControl(msg: CliMessage, requestId: string): ContextUsageAnswer | null {
  if (msg.type !== 'control_response') return null;
  const top = msg as Rec;
  const response = top.response;
  if (!response || typeof response !== 'object') return null;
  const r = response as Rec;
  const id = typeof r.request_id === 'string' ? r.request_id : typeof top.request_id === 'string' ? top.request_id : '';
  if (id !== requestId) return null;
  if (r.subtype === 'error') return { categories: [], api: null };
  const inner = r.response && typeof r.response === 'object' ? (r.response as Rec) : r;
  return {
    categories: parseContextPayload(inner) ?? [],
    api: lastCallUsageOf(inner.apiUsage ?? inner.api_usage),
  };
}
