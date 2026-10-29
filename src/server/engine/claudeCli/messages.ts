// The subset of `claude -p --output-format stream-json` frames deck reads. Field names follow the
// CLI's own output (the same objects the SDK used to forward); unknown types pass through as
// CliOtherMessage and are ignored by the mapper.
export type Rec = Record<string, unknown>;
export type ContentBlock = Rec & { type: string };

export interface CliSystemMessage { type: 'system'; subtype: string; session_id?: string; uuid?: string; [k: string]: unknown }
export interface CliStreamEvent { type: 'stream_event'; parent_tool_use_id: string | null; event: Rec; session_id?: string; uuid?: string }
export interface CliAssistantMessage {
  type: 'assistant'; parent_tool_use_id: string | null;
  message: { id?: string; content: ContentBlock[]; usage?: unknown; [k: string]: unknown };
  session_id?: string; uuid?: string; error?: string; [k: string]: unknown;
}
export interface CliUserMessage {
  type: 'user'; parent_tool_use_id: string | null;
  message: { role: 'user'; content: string | ContentBlock[] };
  session_id?: string; uuid?: string; priority?: 'now' | 'next' | 'later'; isReplay?: boolean; [k: string]: unknown;
}
export interface CliResultMessage {
  type: 'result'; subtype: string; is_error?: boolean; result?: string; errors?: string[];
  session_id: string; usage?: unknown; modelUsage?: unknown; terminal_reason?: string | null; num_turns?: number; [k: string]: unknown;
}
export interface CliRateLimitEvent { type: 'rate_limit_event'; rate_limit_info: Rec; [k: string]: unknown }
export interface CliOtherMessage {
  type: 'keep_alive' | 'tool_progress' | 'tool_use_summary' | 'auth_status' | 'stream_request_start' | 'control_request' | 'control_cancel_request' | 'control_response' | 'unknown';
  [k: string]: unknown;
}
/** The CLI's guess at the user's next prompt, written ~2 s after a result once `initialize` asked for `promptSuggestions`. */
export interface CliPromptSuggestion { type: 'prompt_suggestion'; suggestion?: unknown; uuid?: string; session_id?: string; [k: string]: unknown }
export type CliMessage = CliSystemMessage | CliStreamEvent | CliAssistantMessage | CliUserMessage | CliResultMessage | CliRateLimitEvent | CliPromptSuggestion | CliOtherMessage;

/**
 * Control frames deck writes: `initialize` before the first prompt, and (when the turn asks) `get_context_usage`
 * after a terminal result. `detail: 'summary'` answers from the last response plus local estimates.
 */
export interface CliControlRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: 'initialize'; promptSuggestions?: boolean } | { subtype: 'get_context_usage'; detail?: 'summary' | 'full' };
}

/** One stdout line → a frame, or null for blank/non-JSON/non-object lines (never throws). */
export function parseLine(line: string): CliMessage | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Rec).type === 'string' ? (v as CliMessage) : null;
  } catch {
    return null;
  }
}
