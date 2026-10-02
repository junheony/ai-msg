import { describe, expect, it } from 'vitest';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeEngine, NO_TOOLS_MESSAGE, buildOptions } from './ClaudeEngine';
import type { EngineEvent, TurnRequest } from './Engine';
import { fakeSdk, sdk } from './fakeSdk';

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return { account: 'c', cwd: '/w', resumeSessionId: 's1', model: 'opus', prompt: 'note', signal: new AbortController().signal, onPermission: async () => 'once', ...over };
}
const deps = { home: '/h', baseEnv: {}, abortController: new AbortController(), onStderr: () => {} };
const ctx = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' } as never;

async function runHook(o: Options): Promise<unknown> {
  const m = (o.hooks?.PreToolUse ?? []) as HookCallbackMatcher[];
  expect(m).toHaveLength(1);
  return m[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1', session_id: 's1', transcript_path: '', cwd: '/w' } as never, 'tu1', { signal: new AbortController().signal });
}

describe('buildOptions: handoff note turn (noTools)', () => {
  it('denies every tool call through a PreToolUse hook and canUseTool, without asking', async () => {
    const asked: string[] = [];
    const o = buildOptions(req({ noTools: true, onPermission: async (p) => { asked.push(p.toolName); return 'once'; }, autoApprove: () => true }), deps);
    expect(await runHook(o)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NO_TOOLS_MESSAGE } });
    expect(await o.canUseTool!('Bash', { command: 'ls' }, ctx)).toMatchObject({ behavior: 'deny', message: NO_TOOLS_MESSAGE });
    expect(await o.canUseTool!('AskUserQuestion', { questions: [] }, ctx)).toMatchObject({ behavior: 'deny' });
    expect(asked).toEqual([]);
  });

  it('keeps the rest of the options (tools, model, resume) as a normal turn so the cached prefix still hits', () => {
    const { hooks, canUseTool: _a, abortController: _b, stderr: _c, ...withTools } = buildOptions(req({ noTools: true }), deps);
    const { canUseTool: _d, abortController: _e, stderr: _f, ...normal } = buildOptions(req(), deps);
    expect(hooks).toBeDefined();
    expect(normal).not.toHaveProperty('hooks');
    expect(withTools).toEqual(normal);
  });
});

describe('ClaudeEngine: handoff note turn through the SDK (fake)', () => {
  it('hands the no-tools hook to query() and streams the note like any turn', async () => {
    const f = fakeSdk();
    let seen: Options | undefined;
    const queryFn = ((p: Parameters<typeof f.queryFn>[0]) => { seen = p.options; return f.queryFn(p); }) as typeof f.queryFn;
    f.push(sdk.init('s1'), sdk.delta('## 목표'), sdk.result('## 목표', 's1'));
    f.end();
    const evs: EngineEvent[] = [];
    for await (const e of new ClaudeEngine({ queryFn, readFile: async () => Buffer.from('') }).runTurn(req({ noTools: true }))) evs.push(e);
    expect(evs.map((e) => e.kind)).toEqual(['init', 'delta', 'result']);
    expect(seen?.resume).toBe('s1');
    expect(await runHook(seen!)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
