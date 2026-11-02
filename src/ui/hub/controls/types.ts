/** What `/api/hub/ctl/*` returns. Type-only views of the server modules (erased from the bundle). */
import type { ApprovalItem } from '../../../server/hub/controls/approvals';
import type { EngineId, EngineState } from '../../../server/hub/controls/engines';
import type { RunItem, RunPid } from '../../../server/hub/controls/jobs';

export type { ApprovalItem, EngineId, EngineState, RunItem, RunPid };

export interface ModeControls { locked: boolean; cwd: string | null; bot: string | null; pending: number }

export interface ControlsState {
  csrf: string;
  home: string;
  lockedLabel: string;
  lockedModes: string[];
  approvals: { pending: ApprovalItem[]; decided: ApprovalItem[] };
  engines: EngineState[];
  suggested: EngineId;
  modes: Record<string, ModeControls>;
  bots: string[];
}

export interface LaunchBody { mode: string; engine: EngineId; brief: string; title?: string; cwd?: string }
export interface LaunchResult { run: RunItem; jobDir: string }
