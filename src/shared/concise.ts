/**
 * 간결 모드 helpers (shared): ack labels, mid-turn event classification, milestone copy.
 * The preference itself lives in the client (`prefs.conciseMode`, default on). Full mode is unchanged
 * when the pref is off — these helpers only decide what the concise UI surfaces.
 */

import { modelLabelOf, type AnyModel, type EngineKind } from './models';

/** Short Korean engine label for the ack line. */
export const CONCISE_ENGINE_LABEL: Record<EngineKind, string> = {
  claude: 'Claude',
  codex: 'GPT',
  gemini: 'Gemini',
  grok: 'Grok',
};

/**
 * Instant ack after routing is known (turn_started): "확인 · GPT Sol로 처리 중".
 * Prefers a short model name; falls back to the engine label.
 */
export function conciseAck(input: {
  model?: string | null;
  engine?: EngineKind | null;
  accountLabel?: string | null;
}): string {
  const model = input.model ? modelLabelOf(input.model) : null;
  // Prefer a short family name when the full label is long (e.g. "GPT-6.1-Sol" → keep as-is from MODEL_LABEL).
  const who = model ?? (input.engine ? CONCISE_ENGINE_LABEL[input.engine] : null) ?? '모델';
  const acct = input.accountLabel?.trim();
  return acct ? `확인 · ${who}(${acct})로 처리 중` : `확인 · ${who}로 처리 중`;
}

/** How the concise UI treats each mid-turn server event (full mode ignores this). */
export type ConciseEventRole =
  | 'surface'      // show as-is (started, result, permission, question)
  | 'milestone'    // collapse into a progress milestone
  | 'defer'        // hold until the turn ends (streamed answer text)
  | 'suppress';     // hide body mid-turn (thinking chunks, tool result bodies)

const ROLES: Record<string, ConciseEventRole> = {
  turn_started: 'surface',
  turn_result: 'surface',
  turn_retry: 'surface',
  permission_request: 'surface',
  question_request: 'surface',
  route_fit: 'surface',
  error: 'surface',
  turn_notice: 'surface',
  turn_system: 'surface',
  turn_queued: 'surface',
  turn_progress: 'milestone',
  tool_call: 'milestone',
  sub_tool_call: 'milestone',
  task_update: 'milestone',
  thinking: 'suppress',
  tool_result: 'suppress',
  sub_tool_result: 'suppress',
  delta: 'defer',
};

export function conciseEventRole(type: string): ConciseEventRole {
  return ROLES[type] ?? 'suppress';
}

/** Whether this event type is forwarded into the concise chat pane mid-turn. */
export function conciseForwardsEvent(type: string): boolean {
  const role = conciseEventRole(type);
  return role === 'surface' || role === 'milestone';
}

/**
 * Milestone copy for a long turn: started → periodic still-working → done.
 * `step` is 1-based tool/progress steps; `elapsedMs` drives the "still working" cadence.
 */
export function conciseMilestone(input: {
  phase: 'started' | 'working' | 'done';
  step?: number;
  elapsedMs?: number;
  ok?: boolean;
}): string {
  if (input.phase === 'started') return '시작함';
  if (input.phase === 'done') return input.ok === false ? '끝남 · 실패' : '끝남';
  const step = input.step && input.step > 0 ? input.step : null;
  const mins = input.elapsedMs !== undefined ? Math.floor(input.elapsedMs / 60_000) : 0;
  if (step !== null && mins >= 1) return `계속 작업 중 · 단계 ${step} · ${mins}분`;
  if (step !== null) return `계속 작업 중 · 단계 ${step}`;
  if (mins >= 1) return `계속 작업 중 · ${mins}분`;
  return '계속 작업 중';
}

/** Emit a working milestone at most this often (server filter / UI status). */
export const CONCISE_MILESTONE_MS = 20_000;

/**
 * Pure filter: given prior milestone state and a new event, decide whether to emit a milestone notice.
 * Used by the server turn pipeline and covered by unit tests; the UI also mirrors the same cadence.
 */
export function shouldEmitMilestone(state: {
  lastAtMs: number;
  steps: number;
  startedAtMs: number;
}, nowMs: number, eventType: string): { emit: boolean; next: { lastAtMs: number; steps: number; startedAtMs: number }; message?: string } {
  const role = conciseEventRole(eventType);
  let steps = state.steps;
  if (eventType === 'tool_call' || eventType === 'sub_tool_call') steps += 1;
  if (eventType === 'turn_started') {
    return { emit: true, next: { lastAtMs: nowMs, steps: 0, startedAtMs: nowMs }, message: conciseMilestone({ phase: 'started' }) };
  }
  if (eventType === 'turn_result') {
    return { emit: true, next: { ...state, lastAtMs: nowMs, steps }, message: conciseMilestone({ phase: 'done', step: steps || undefined, elapsedMs: nowMs - state.startedAtMs }) };
  }
  if (role !== 'milestone') return { emit: false, next: { ...state, steps } };
  const due = nowMs - state.lastAtMs >= CONCISE_MILESTONE_MS;
  const stepBump = steps > state.steps && (steps === 1 || steps % 3 === 0);
  if (!due && !stepBump) return { emit: false, next: { ...state, steps } };
  return {
    emit: true,
    next: { lastAtMs: nowMs, steps, startedAtMs: state.startedAtMs },
    message: conciseMilestone({ phase: 'working', step: steps || undefined, elapsedMs: nowMs - state.startedAtMs }),
  };
}

/** Short model chip for routing tables / docs (AnyModel id → Korean-ish short name). */
export function conciseModelChip(model: AnyModel | string): string {
  return modelLabelOf(model);
}
