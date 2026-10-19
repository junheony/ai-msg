/**
 * Server-side concise-mode event projection.
 *
 * The live WebSocket still sends the full turn stream (catchup, full-mode clients, commander).
 * This module decides which events a concise projection would keep or promote to milestones —
 * used by tests and by any future per-client filter. The UI also mirrors the same rules via
 * `src/shared/concise.ts` (prefs.conciseMode, default on).
 */
import {
  conciseEventRole,
  conciseForwardsEvent,
  shouldEmitMilestone,
  type ConciseEventRole,
} from '../../shared/concise';
import type { ServerMessage } from '../../shared/protocol';

export { conciseEventRole, conciseForwardsEvent, shouldEmitMilestone };
export type { ConciseEventRole };

export type MilestoneState = { lastAtMs: number; steps: number; startedAtMs: number };

export const emptyMilestoneState = (atMs = 0): MilestoneState => ({ lastAtMs: atMs, steps: 0, startedAtMs: atMs });

/**
 * Project a turn event for concise mode: drop suppressed bodies mid-turn, keep surface/milestone
 * events, and optionally attach a milestone notice message (caller may emit it as turn_notice).
 */
export function filterConciseEvent(
  msg: ServerMessage,
  state: MilestoneState,
  nowMs: number,
): { forward: boolean; role: ConciseEventRole; state: MilestoneState; milestone?: string } {
  const type = msg.type;
  const role = conciseEventRole(type);
  const mile = shouldEmitMilestone(state, nowMs, type);
  const forward = conciseForwardsEvent(type) || type === 'turn_result' || type === 'turn_started';
  return {
    forward,
    role,
    state: mile.next,
    ...(mile.emit && mile.message ? { milestone: mile.message } : {}),
  };
}

/** Filter a recorded stream of turn events into what the concise pane would surface mid-turn. */
export function projectConciseStream(events: ServerMessage[], nowMs = Date.now()): { kept: ServerMessage[]; milestones: string[] } {
  let state = emptyMilestoneState(nowMs);
  const kept: ServerMessage[] = [];
  const milestones: string[] = [];
  for (const msg of events) {
    const r = filterConciseEvent(msg, state, nowMs);
    state = r.state;
    if (r.forward) kept.push(msg);
    if (r.milestone) milestones.push(r.milestone);
  }
  return { kept, milestones };
}
