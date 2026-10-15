// src/server/engine/claudeCli/hooks.ts
import type { TurnRequest } from '../Engine';
import type { BridgeHandlers } from './bridge';
import type { ModeGate } from './permissions';
import type { ToolAudit } from './stream';
import { NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';

export type HookDeps = Pick<TurnRequest, 'noTools' | 'systemNote'>;

const pre = (permissionDecision: 'allow' | 'deny' | 'ask', reason?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason ? { permissionDecisionReason: reason } : {}) },
});

/** Answers the `--settings` command hooks of one process (relayed by hookRelay.ts). */
export function hookHandler(req: HookDeps, audit: ToolAudit, gate: ModeGate): BridgeHandlers['hook'] {
  let noteSent = false;
  return async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      const call = { tool_name: String(input.tool_name ?? ''), tool_input: input.tool_input ?? null, tool_use_id: String(input.tool_use_id ?? '') };
      if (req.noTools) { await audit.report(call, 'deny', 'deck'); return pre('deny', NO_TOOLS_MESSAGE); }
      if (gate.mode === gate.startedIn) return {};
      if (gate.mode === 'plan') return pre('deny', PLAN_GATE_MESSAGE);
      if (gate.mode === 'acceptEdits') return pre('allow');
      if (gate.startedIn === 'acceptEdits') return pre('ask');
      return {};
    }
    if (input.hook_event_name === 'UserPromptSubmit') {
      if (noteSent || !req.systemNote) return {};
      noteSent = true;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: req.systemNote } };
    }
    return {};
  };
}
