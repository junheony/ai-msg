/**
 * 총사령탑(commander) 타입 — `docs/superpowers/specs/2026-10-18-commander-design.md` §4·§6.
 * 1단계(상태 보존)만 구현된 현재는 이 파일이 `SessionState.commander` 의 모양을 정의할 뿐,
 * 판정·전송·실행 차단 로직(§6 의 digest.ts·signature.ts·rules.ts·Judge.ts·Commander.ts)은 이후 단계에서 들어온다.
 */

/** §4 상태 머신의 노드. */
export const COMMANDER_STATUSES = ['idle', 'armed', 'sending', 'running', 'judging', 'waiting_human', 'paused', 'stopped', 'done'] as const;
export type CommanderStatus = (typeof COMMANDER_STATUSES)[number];

/** §5 예산(공유) — 세그먼트 안 모든 하위 턴 사용량 + 판정 호출 사용량을 합산한다. */
export type CommanderBudget = {
  maxAutoTurns: number;
  autoTurnsUsed: number;
  maxTokens: number;
  tokensUsed: number;
  maxWallClockMs: number;
  maxInternalRetries: number;
  internalRetriesUsed: number;
};

const RISKS = ['none', 'deploy', 'delete', 'external', 'payment', 'push', 'db', 'other'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;

/** §3 출력 스키마(zod, 위반 시 human) — 판정기 한 건의 결과. */
export type Verdict = {
  verdict: 'continue' | 'human' | 'done';
  reason: string;
  next?: string;
  evidence?: { testRunId: string };
  risk?: (typeof RISKS)[number];
  confidence: (typeof CONFIDENCES)[number];
};

/** §3 입력 — 세그먼트 누적기(digest.ts, 이후 단계)가 만드는 판정 입력. 필드는 이후 단계에서 채운다. */
export type SegmentDigest = {
  digestId: string;
};

/** §6 `types.ts` — `SessionState.commander` 의 모양. */
export type CommanderState = {
  goal: string;
  done: string;
  maxTurns: number;
  hop: number;
  epoch: number;
  status: CommanderStatus;
  startedAtMs: number;
  budget: CommanderBudget;
  /** 최근 2건. */
  lastVerdicts: Verdict[];
  sendKey?: string;
  /** 최근 8건. */
  processedDigestIds: string[];
  /** 최근 3건. */
  signatures: string[];
  pausedBy?: string;
};

function isBudget(v: unknown): v is CommanderBudget {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.maxAutoTurns === 'number' &&
    typeof b.autoTurnsUsed === 'number' &&
    typeof b.maxTokens === 'number' &&
    typeof b.tokensUsed === 'number' &&
    typeof b.maxWallClockMs === 'number' &&
    typeof b.maxInternalRetries === 'number' &&
    typeof b.internalRetriesUsed === 'number'
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isVerdict(v: unknown): v is Verdict {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.verdict !== 'continue' && r.verdict !== 'human' && r.verdict !== 'done') return false;
  if (typeof r.reason !== 'string') return false;
  if (r.next !== undefined && typeof r.next !== 'string') return false;
  if (r.evidence !== undefined && (typeof r.evidence !== 'object' || r.evidence === null || typeof (r.evidence as Record<string, unknown>).testRunId !== 'string')) return false;
  if (r.risk !== undefined && !(RISKS as readonly unknown[]).includes(r.risk)) return false;
  if (!(CONFIDENCES as readonly unknown[]).includes(r.confidence)) return false;
  return true;
}

/**
 * 디스크에서 읽은 값이 `CommanderState` 모양인지 검사한다. 파일을 손으로 고치거나 이전 버전이 다른 모양으로 남긴
 * 값은 여기서 걸러지고, 호출부(`SessionState.load`)는 세션 전체가 아니라 `commander` 필드만 버린다.
 */
export function isCommanderState(v: unknown): v is CommanderState {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.goal === 'string' &&
    typeof c.done === 'string' &&
    typeof c.maxTurns === 'number' &&
    typeof c.hop === 'number' &&
    typeof c.epoch === 'number' &&
    (COMMANDER_STATUSES as readonly unknown[]).includes(c.status) &&
    typeof c.startedAtMs === 'number' &&
    isBudget(c.budget) &&
    Array.isArray(c.lastVerdicts) &&
    c.lastVerdicts.every(isVerdict) &&
    (c.sendKey === undefined || typeof c.sendKey === 'string') &&
    isStringArray(c.processedDigestIds) &&
    isStringArray(c.signatures) &&
    (c.pausedBy === undefined || typeof c.pausedBy === 'string')
  );
}
