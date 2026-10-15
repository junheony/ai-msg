// src/server/engine/claudeCli/texts.ts
import { MIN_CLAUDE_VERSION } from './version';
/** The handoff-note turn (TurnRequest.noTools): what a denied tool call tells the model. */
export const NO_TOOLS_MESSAGE = '인계 메모 작성 중에는 도구를 쓸 수 없습니다 — 지금까지의 대화만으로 메모를 써 주세요';
/** 계속 계획 on the plan card: what the denied ExitPlanMode call tells the model. */
export const KEEP_PLANNING_MESSAGE = '사용자가 계획을 승인하지 않았습니다 — 계획 모드를 유지하며 계획을 더 다듬어 주세요';
export const DENIED_MESSAGE = '사용자가 거부했습니다';
export const QUESTION_MALFORMED_MESSAGE = '질문 형식이 올바르지 않습니다';
export const QUESTION_UNANSWERED_MESSAGE = '사용자가 답하지 않았습니다';
export const SELF_CALL_MESSAGE = 'deck 내부 도구는 직접 부를 수 없습니다';
export const PERMISSION_TIMEOUT_MESSAGE = '권한 요청이 오래 응답되지 않아 거부했습니다';
export const PERMISSION_ERROR_MESSAGE = '권한 요청을 처리하다 오류가 나서 거부했습니다';
/** A mid-process switch into plan mode (live.setPermissionMode): edits are refused by deck's PreToolUse hook. */
export const PLAN_GATE_MESSAGE = '계획 모드로 바뀌었습니다 — 파일을 바꾸지 말고 계획을 이어 가 주세요';
/** Mirrors hookRelay.ts (which may import node built-ins only). */
export const HOOK_RELAY_FAILED_MESSAGE = '도구 사용 여부를 deck 에 확인하지 못해 거부했습니다';
/** 메시지 편집 갈래: the parent transcript was not found in the profile. */
export const FORK_SOURCE_MISSING = '갈래를 만들 원본 대화 기록을 찾지 못했습니다';
/** 메시지 편집 갈래: the edited message's entry is not in the parent transcript. */
export const FORK_AT_UNSUPPORTED = '고친 메시지 지점을 원본 대화 기록에서 찾지 못했습니다';
export const CLAUDE_MISSING_TEXT = 'Claude Code(claude)를 찾지 못했습니다 — 터미널에서 설치하고 로그인한 뒤 deck 을 다시 시작해 주세요';
export const claudeTooOldText = (version: string): string => `Claude Code ${version} 은 너무 오래됐습니다 — ${MIN_CLAUDE_VERSION} 이상으로 업데이트한 뒤 deck 을 다시 시작해 주세요`;
/** = TurnRunner.ABORTED: the UI hides a stopped turn's error when it is exactly this. */
export const ABORTED_TEXT = '중단됨';
