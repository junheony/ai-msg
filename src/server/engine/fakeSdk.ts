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
  /** Task ids passed to `Query.stopTask` (each answered with a stopped task_notification, like the SDK). */
  const stopped: string[] = [];
  const poke = () => { const w = wake; wake = null; w?.(); };
  const gen = async function* (p: { prompt: PromptInput; options?: Options }): AsyncGenerator<SDKMessage> {
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
  const queryFn = (p: { prompt: PromptInput; options?: Options }) => Object.assign(gen(p), {
    stopTask: async (id: string) => {
      stopped.push(id);
      queue.push({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', output_file: '', summary: 'stopped', session_id: 's1' } as unknown as SDKMessage);
      poke();
    },
  });
  return {
    queryFn,
    inputs,
    state,
    stopped,
    push: (...ms: unknown[]) => { queue.push(...(ms as SDKMessage[])); poke(); },
    end: () => { ended = true; poke(); },
  };
}

/** SDK message builders: moved to the CLI test double (same names, same shapes) until this file goes in Task 8b. */
export { cli as sdk } from './claudeCli/fakeClaudeCli';
