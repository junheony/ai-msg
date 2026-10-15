// src/server/engine/claudeCli/permissions.ts
import { parseQuestions, ruleString, sessionUpdates, type PermissionRequest, type TurnRequest } from '../Engine';
import { BRIDGE_SERVER, type CliPermissionMode } from './args';
import type { BridgeHandlers, PermissionReply } from './bridge';
import type { PermissionUpdate } from './permissionTypes';
import type { ToolAudit } from './stream';
import { DENIED_MESSAGE, KEEP_PLANNING_MESSAGE, NO_TOOLS_MESSAGE, QUESTION_MALFORMED_MESSAGE, QUESTION_UNANSWERED_MESSAGE, SELF_CALL_MESSAGE } from './texts';

/** The process's effective permission mode as deck sees it (changed by the plan card and by live.setPermissionMode). */
export type ModeGate = { mode: CliPermissionMode; readonly startedIn: CliPermissionMode };

/**
 * 이 세션 grants given during this process. The CLI should apply `updatedPermissions` itself
 * (spike D2); this memory makes a repeat ask auto-allow even if it does not.
 */
export class SessionGrants {
  private readonly rules = new Set<string>();
  private readonly dirs = new Set<string>();
  add(updates: PermissionUpdate[]): void {
    for (const u of updates) {
      if (u.type === 'addRules' && u.behavior === 'allow') for (const r of u.rules) this.rules.add(ruleString(r));
      else if (u.type === 'addDirectories') for (const d of u.directories) this.dirs.add(d);
    }
  }
  covers(suggestions: PermissionUpdate[] | undefined): boolean {
    const wanted: string[] = [];
    for (const u of suggestions ?? []) {
      if (u.type === 'addRules' && u.behavior === 'allow') wanted.push(...u.rules.map((r) => `r:${ruleString(r)}`));
      else if (u.type === 'addDirectories') wanted.push(...u.directories.map((d) => `d:${d}`));
    }
    return wanted.length > 0 && wanted.every((w) => (w.startsWith('r:') ? this.rules.has(w.slice(2)) : this.dirs.has(w.slice(2))));
  }
}

export type PermissionDeps = Pick<TurnRequest, 'noTools' | 'onQuestion' | 'onQuestionMalformed' | 'autoApprove' | 'onAutoApproved' | 'onPermission'>;

/**
 * The suggestion deck offers when the CLI's prompt-tool request has no `permission_suggestions`
 * (spike D3 negative): allow this tool for the session; for Bash, this exact command. Without it
 * TurnRunner's addGrants (which reads pr.suggestions) would have nothing to persist for 이 세션.
 */
export function synthesizedSuggestions(toolName: string, input: Record<string, unknown>): PermissionUpdate[] | undefined {
  if (toolName === 'ExitPlanMode') return undefined;
  const ruleContent = toolName === 'Bash' && typeof input.command === 'string' && input.command ? input.command : undefined;
  return [{ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' }];
}

/** The old canUseTool, answering the CLI's permission-prompt tool through the bridge. */
export function permissionHandler(req: PermissionDeps, audit: ToolAudit, gate: ModeGate, grants: SessionGrants): BridgeHandlers['permission'] {
  return async (call, signal): Promise<PermissionReply> => {
    const { tool_name: toolName, input, tool_use_id: toolUseId } = call;
    audit.handled.add(toolUseId);
    const deny = (message: string): PermissionReply => ({ behavior: 'deny', message });
    if (toolName.startsWith(`mcp__${BRIDGE_SERVER}__`)) return deny(SELF_CALL_MESSAGE);
    if (req.noTools) return deny(NO_TOOLS_MESSAGE);
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input);
      if (!questions) { await req.onQuestionMalformed?.(input); return deny(QUESTION_MALFORMED_MESSAGE); }
      const answers = req.onQuestion ? await req.onQuestion({ toolUseId, questions, signal }) : null;
      if (!answers) return deny(QUESTION_UNANSWERED_MESSAGE);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    const suggestions = call.permission_suggestions ?? synthesizedSuggestions(toolName, input);
    const pr: PermissionRequest = {
      toolName, input, toolUseId, signal,
      ...(suggestions ? { suggestions } : {}),
      suppressAlwaysAllowRule: false,
    };
    if (req.autoApprove?.()) {
      await req.onAutoApproved?.(pr);
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName !== 'ExitPlanMode' && grants.covers(pr.suggestions)) {
      audit.handled.delete(toolUseId); // decided by a rule the user gave earlier: audited from the stream as 'cli'
      return { behavior: 'allow', updatedInput: input };
    }
    const decision = await req.onPermission(pr);
    if (toolName === 'ExitPlanMode') {
      if (decision === 'deny') return deny(KEEP_PLANNING_MESSAGE);
      const mode = decision === 'session' ? 'acceptEdits' : 'default';
      gate.mode = mode;
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
    }
    if (decision === 'deny') return deny(DENIED_MESSAGE);
    if (decision === 'session') {
      const updates = sessionUpdates(pr);
      if (updates.length) {
        grants.add(updates);
        if (updates.some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) gate.mode = 'acceptEdits';
        return { behavior: 'allow', updatedInput: input, updatedPermissions: updates };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
