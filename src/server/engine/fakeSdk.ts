import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PromptInput } from './ClaudeEngine';

/**
 * Test double for the Agent SDK `query()` in streaming-input mode: the test feeds SDK messages
 * with `push` (the stream waits for more until `end`), records every user message the engine
 * writes to the input and whether the input was closed; abort makes the stream throw like the SDK.
 */
export function fakeSdk() {
  const inputs: SDKUserMessage[] = [];
  const queue: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const state = { inputClosed: false, calls: 0 };
  const poke = () => { const w = wake; wake = null; w?.(); };
  const queryFn = async function* (p: { prompt: PromptInput; options?: Options }): AsyncGenerator<SDKMessage> {
    state.calls++;
    const prompt = p.prompt;
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const m of prompt) { inputs.push(m); poke(); }
        state.inputClosed = true;
        poke();
      })();
    }
    const signal = p.options?.abortController?.signal;
    for (;;) {
      if (signal?.aborted) throw new Error('Claude Code process aborted by user');
      const m = queue.shift();
      if (m) { yield m; continue; }
      if (ended) return;
      await new Promise<void>((resolve) => { wake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
    }
  };
  return {
    queryFn,
    inputs,
    state,
    push: (...ms: unknown[]) => { queue.push(...(ms as SDKMessage[])); poke(); },
    end: () => { ended = true; poke(); },
  };
}

/** SDK message builders (shapes from sdk.d.ts). */
export const sdk = {
  init: (sid = 's1') => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' }),
  delta: (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }),
  result: (text: string, sid = 's1') => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 2 } }),
  bgLevel: (tasks: { id: string; desc: string; ambient?: boolean }[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((t) => ({ task_id: t.id, task_type: 'local_agent', description: t.desc, ...(t.ambient ? { ambient: true } : {}) })), session_id: 's1' }),
  taskStarted: (id: string, desc: string, backgrounded = true) => ({ type: 'system', subtype: 'task_started', task_id: id, description: desc, is_backgrounded: backgrounded, session_id: 's1' }),
  taskDone: (id: string) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', output_file: '/tmp/o', summary: 'done', session_id: 's1' }),
  /** The CLI's injected notification turn opener (origin task-notification). */
  notifyUser: () => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '<task-notification>done</task-notification>' }, origin: { kind: 'task-notification' }, session_id: 's1' }),
  subagentTool: () => ({ type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] }, session_id: 's1' }),
};
