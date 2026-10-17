// src/server/engine/claudeCli/hooks.ts
import os from 'node:os';
import path from 'node:path';
import { gateEditPath, gateReadTool, gateTool, type ReadRoots } from '../../commander/rules';
import type { TurnRequest } from '../Engine';
import { EDIT_TOOL_MATCHER } from './args';
import type { BridgeHandlers } from './bridge';
import type { ModeGate } from './permissions';
import type { ToolAudit } from './stream';
import { COMMANDER_ASK_MESSAGE, COMMANDER_GATE_FAILED_MESSAGE, NO_TOOLS_MESSAGE, PLAN_GATE_MESSAGE } from './texts';

export type HookDeps = Pick<TurnRequest, 'noTools' | 'systemNote' | 'commanderHop' | 'onCommanderGate' | 'commanderEdited' | 'onCommanderEdit'> & Partial<Pick<TurnRequest, 'cwd' | 'allowDirs'>>;

const EDIT_TOOLS = new Set(EDIT_TOOL_MATCHER.split('|'));
/**
 * 총사령탑 자동 턴: 판정 없이 통과(의견 없음 `{}` — CLI 의 보통 권한 흐름 그대로)하는 도구. 늘 사람에게 가는 것
 * (AskUserQuestion·ExitPlanMode)과 TodoWrite 만. 여기 없는 도구는 이름을 몰라도 ask.
 */
const COMMANDER_PASS_TOOLS = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode']);
/** 읽기 도구: 대상 경로가 세션 cwd·allowDirs 안이고 `.env` 가 아니면 통과, 아니면 ask(rules.ts gateReadTool). */
const COMMANDER_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

const pre = (permissionDecision: 'allow' | 'deny' | 'ask', reason?: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...(reason ? { permissionDecisionReason: reason } : {}) },
});

function editedPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as { file_path?: unknown; notebook_path?: unknown };
  const p = typeof i.file_path === 'string' ? i.file_path : i.notebook_path;
  return typeof p === 'string' ? p : null;
}

/** Answers the `--settings` command hooks of one process (relayed by hookRelay.ts). */
export function hookHandler(req: HookDeps, audit: ToolAudit, gate: ModeGate): BridgeHandlers['hook'] {
  let noteSent = false;
  // 총사령탑: 이 프로세스(또는 세션 상태에 남은 이전 자동 턴)에서 편집 도구가 한 번이라도 불렸으면 테스트 러너·git 도 ask.
  let runnerConfigChanged = !!req.commanderEdited;
  let editRecorded = false;
  return async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      const call = { tool_name: String(input.tool_name ?? ''), tool_input: input.tool_input ?? null, tool_use_id: String(input.tool_use_id ?? '') };
      if (req.noTools) { await audit.report(call, 'deny', 'deck'); return pre('deny', NO_TOOLS_MESSAGE); }
      if (req.commanderHop && !COMMANDER_PASS_TOOLS.has(call.tool_name)) {
        const judged = async (decide: () => 'allow' | 'ask' | 'deny') => {
          let decision: 'allow' | 'ask' | 'deny';
          try {
            decision = decide();
          } catch {
            decision = 'deny';
          }
          try {
            await req.onCommanderGate?.({ toolName: call.tool_name, input: call.tool_input, toolUseId: call.tool_use_id, decision });
          } catch {
            // best-effort, like every audit write: never changes the decision
          }
          return decision === 'allow' ? pre('allow') : decision === 'ask' ? pre('ask', COMMANDER_ASK_MESSAGE) : pre('deny', COMMANDER_GATE_FAILED_MESSAGE);
        };
        const base = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : undefined;
        const roots: ReadRoots = { cwd: req.cwd ?? '', allowDirs: req.allowDirs ?? [], home: os.homedir(), ...(base ? { base } : {}) };
        if (EDIT_TOOLS.has(call.tool_name)) {
          // 편집 뒤의 러너 실행 = 임의 코드 실행: 어떤 편집이든 그 뒤 테스트 러너·git 은 ask — 다음 자동 턴(새 프로세스)도.
          runnerConfigChanged = true;
          if (!editRecorded) {
            editRecorded = true;
            try {
              await req.onCommanderEdit?.();
            } catch {
              // best-effort: this process still asks; TurnRunner records it again once the attempt ends
            }
          }
          // 보호 경로이거나 realpath 가 세션 cwd·allowDirs 밖이면 ask — acceptEdits·bypass 모드 판정까지 가지 않는다.
          const p = editedPath(call.tool_input);
          if (p === null || gateEditPath(p, roots) !== 'pass') return judged(() => 'ask');
        } else if (COMMANDER_READ_TOOLS.has(call.tool_name)) {
          if (gateReadTool(call.tool_name, call.tool_input, roots) !== 'pass') return judged(() => 'ask');
        } else {
          return judged(() => gateTool(call.tool_name, call.tool_input, { runnerConfigChanged, roots }));
        }
      }
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
