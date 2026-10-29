import type { TaskStatus } from '../shared/turn-types';
import type { ToolCallItem } from './state';

/** D9: who did the work in this turn besides the main model. */
export type RoleEntry =
  | { kind: 'agent'; toolUseId: string; type: string; model: string | null; description: string; isError: boolean; pending: boolean }
  | { kind: 'offload'; toolUseId: string; model: string | null; cross: boolean; command: string; isError: boolean; pending: boolean };

export type RoleRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Status for one row. An agent with live subagent state passes that status (from Activity.agentStatus).
 * Otherwise a pending call is running while the turn streams, and stopped once the turn is over.
 */
export function roleStatus(entry: { isError: boolean; pending: boolean }, live: boolean, agent?: TaskStatus): RoleRunStatus {
  if (agent) return agent;
  if (entry.isError) return 'failed';
  if (entry.pending) return live ? 'running' : 'stopped';
  return 'completed';
}

const OFFLOAD = /^(?:\S*\/)?offload\b([\s\S]*)$/;

export function roleSummary(toolCalls: ToolCallItem[]): RoleEntry[] {
  const out: RoleEntry[] = [];
  for (const c of toolCalls) {
    const input = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {};
    if (c.name === 'Agent' || c.name === 'Task') {
      out.push({
        kind: 'agent',
        toolUseId: c.toolUseId,
        type: typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general',
        model: typeof input.model === 'string' ? input.model : null,
        description: typeof input.description === 'string' ? input.description : '',
        isError: c.isError,
        pending: c.result === null,
      });
    } else if (c.name === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command.trim();
      const m = OFFLOAD.exec(cmd);
      if (!m) continue;
      const rest = (m[1] ?? '').trim();
      if (/^status\b/.test(rest)) continue;
      const model = /(?:^|\s)(?:-m|--model)[=\s]+(\S+)/.exec(rest)?.[1] ?? null;
      out.push({
        kind: 'offload',
        toolUseId: c.toolUseId,
        model,
        cross: /^cross\b/.test(rest),
        command: cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd,
        isError: c.isError,
        pending: c.result === null,
      });
    }
  }
  return out;
}
