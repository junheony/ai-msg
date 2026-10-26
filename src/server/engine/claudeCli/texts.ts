// src/server/engine/claudeCli/texts.ts
import type { RateLimitSignal } from '../Engine';
import { classifyFailure } from '../limitDetect';
import { MIN_CLAUDE_VERSION } from './version';
/** The handoff-note turn (TurnRequest.noTools): what a denied tool call tells the model. */
export const NO_TOOLS_MESSAGE = '인계 메모 작성 중에는 도구를 쓸 수 없습니다 — 지금까지의 대화만으로 메모를 써 주세요';
/** 계속 계획 on the plan card: what the denied ExitPlanMode call tells the model. */
export const KEEP_PLANNING_MESSAGE = '사용자가 계획을 승인하지 않았습니다 — 계획 모드를 유지하며 계획을 더 다듬어 주세요';
export const DENIED_MESSAGE = '사용자가 거부했습니다';
export const QUESTION_MALFORMED_MESSAGE = '질문 형식이 올바르지 않습니다';
export const QUESTION_UNANSWERED_MESSAGE = '사용자가 답하지 않았습니다';
export const SELF_CALL_MESSAGE = 'Crew 내부 도구는 직접 부를 수 없습니다';
export const PERMISSION_TIMEOUT_MESSAGE = '권한 요청이 오래 응답되지 않아 거부했습니다';
export const PERMISSION_ERROR_MESSAGE = '권한 요청을 처리하다 오류가 나서 거부했습니다';
/** A mid-process switch into plan mode (live.setPermissionMode): edits are refused by deck's PreToolUse hook. */
export const PLAN_GATE_MESSAGE = '계획 모드로 바뀌었습니다 — 파일을 바꾸지 말고 계획을 이어 가 주세요';
/** 총사령탑 자동 턴: 허용 목록 밖의 Bash·`mcp__*` 호출을 권한 카드로 올릴 때의 사유. */
export const COMMANDER_ASK_MESSAGE = '총사령탑 자동 턴 — 허용 목록 밖의 도구 호출이라 사람 확인이 필요합니다';
/** 총사령탑 자동 턴: 판정 자체가 실패하면 실행하지 않는다(fail closed). */
export const COMMANDER_GATE_FAILED_MESSAGE = '총사령탑 자동 턴 — 도구 호출을 판정하지 못해 거부했습니다';
/** Mirrors hookRelay.ts (which may import node built-ins only). */
export const HOOK_RELAY_FAILED_MESSAGE = '도구 사용 여부를 Crew 에 확인하지 못해 거부했습니다';
/** 메시지 편집 갈래: the parent transcript was not found in the profile. */
export const FORK_SOURCE_MISSING = '갈래를 만들 원본 대화 기록을 찾지 못했습니다';
/** 메시지 편집 갈래: the edited message's entry is not in the parent transcript. */
export const FORK_AT_UNSUPPORTED = '고친 메시지 지점을 원본 대화 기록에서 찾지 못했습니다';
/** The session id to resume is not a Claude session id (no child is spawned). */
export const invalidResumeText = (id: string): string => `이어 갈 세션 id 가 올바르지 않습니다: ${id}`;
export const CLAUDE_MISSING_TEXT = 'Claude Code(claude)를 찾지 못했습니다 — 터미널에서 설치하고 로그인한 뒤 Crew 를 다시 시작해 주세요';
export const claudeTooOldText = (version: string): string => `Claude Code ${version} 은 너무 오래됐습니다 — ${MIN_CLAUDE_VERSION} 이상으로 업데이트한 뒤 Crew 를 다시 시작해 주세요`;
/** = TurnRunner.ABORTED: the UI hides a stopped turn's error when it is exactly this. */
export const ABORTED_TEXT = '중단됨';
/** ⚡ 빠르게: which fast-mode line the CLI sent — blocked by the organization, credits used up, credits off, cooldown. */
export type FastModeKind = 'org' | 'exhausted' | 'off' | 'cooldown';

/**
 * ⚡ 빠르게: the kind of a fast-mode refusal, fallback or cooldown line from the CLI; null = not one of those. Matched
 * loosely (the CLI's wording moves): only lines naming fast mode or usage credits count. `failed` (the text of a failed
 * fast turn): any such line counts, an unknown one as a refusal (`off`) — never taken for a plan limit (TurnRunner).
 */
export function fastModeKind(text: string, failed = false): FastModeKind | null {
  const t = text.toLowerCase();
  if (!t.includes('fast mode') && !t.includes('usage credit')) return null;
  if (t.includes('organization')) return 'org';
  if (t.includes('exhausted') || t.includes('limit reached') || t.includes('out of')) return 'exhausted';
  if (t.includes('cooldown') || t.includes('rate limit') || t.includes('overloaded') || t.includes('temporarily unavailable')) return 'cooldown';
  if (failed || t.includes('requires usage credits') || t.includes('not available') || t.includes('turned off') || t.includes('disabled')) return 'off';
  return null;
}

/**
 * ⚡ 빠르게: the fast-mode kind of a failed fast turn, read from its error text only (never stderr). A limit of any kind
 * on a fast turn is one too (`cooldown`): never a cooldown / failover / retry on another account, which would bill that
 * account's credits fast again — the person picks 표준으로 다시 보내기. Only an auth failure keeps its own handling.
 */
export function fastFailureKind(errorText: string | null, errorKind: string | null, rateLimitStatus: RateLimitSignal['status'] | null = null): FastModeKind | null {
  const base = classifyFailure({ ok: false, errorText, errorKind, rateLimitStatus });
  if (base === 'auth') return null;
  return fastModeKind(errorText ?? '', true) ?? (base === 'limit' ? 'cooldown' : null);
}

/** What a fast-mode line means for the person: `failed` = the turn failed on it (nothing is retried by itself), else the CLI went on at standard speed. */
export function fastModeText(kind: FastModeKind, failed: boolean): string {
  if (failed) {
    switch (kind) {
      case 'org': return '조직 설정에서 빠르게 모드(사용 크레딧)를 막아 두었습니다 — 표준으로 다시 보내세요';
      case 'exhausted': return '사용 크레딧이 떨어졌습니다 — 표준으로 다시 보내면 플랜 한도로 돕니다';
      case 'off': return '빠르게 모드를 쓸 수 없습니다(사용 크레딧이 꺼져 있거나 거부됨) — Claude 계정 설정에서 사용 크레딧을 켜거나 표준으로 다시 보내세요';
      case 'cooldown': return '빠르게 전용 한도에 걸렸습니다 — 쿨다운이 끝난 뒤 다시 보내거나 표준으로 다시 보내세요';
    }
  }
  switch (kind) {
    case 'org': return '조직 설정에서 빠르게 모드(사용 크레딧)를 막아 두어 표준 속도로 돕니다';
    case 'exhausted': return '사용 크레딧이 떨어져 표준 속도로 돕니다';
    case 'off': return '빠르게 모드를 쓸 수 없어 표준 속도로 돕니다 — Claude 계정 설정에서 사용 크레딧을 확인하세요';
    case 'cooldown': return '빠르게 전용 한도에 걸려 잠시 표준 속도로 돕니다 — 쿨다운이 끝나면 다시 빨라집니다';
  }
}

/** The fallback text of a fast-mode line (fastModeKind → fastModeText); null = not one. */
export function fastModeHint(text: string): string | null {
  const kind = fastModeKind(text);
  return kind ? fastModeText(kind, false) : null;
}
