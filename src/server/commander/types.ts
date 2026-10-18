/**
 * 총사령탑(commander) 타입 — `docs/superpowers/specs/2026-10-18-commander-design.md` §4·§6.
 * 상태 머신은 Commander.ts, 세그먼트 누적은 digest.ts(ws 가 이벤트를 넣는다), 판정기는 Judge.ts.
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

/** §3 테스트 결과 한 건 — 테스트 러너 패턴 Bash 의 실행 하나(최상위 또는 하위 에이전트). */
export type TestRun = {
  /** 실행 id(`tool_use_id`) — 판정기의 `evidence.testRunId` 와 대조한다. */
  testRunId: string;
  /** 명령 1줄(절단). */
  command: string;
  /** 출력 꼬리(절단). 비어 있으면 테스트 증거로 인정하지 않는다. */
  outputTail: string;
  hasOutput: boolean;
  /** 결과가 아직 안 왔으면 null. */
  exitCode: number | null;
  /** 이 실행 뒤 세그먼트에 파일 변경(Edit·Write·MultiEdit·NotebookEdit)이 있었는지. */
  filesChangedAfter: boolean;
  /** 하위 에이전트(Task)의 실행. */
  sub: boolean;
};

/** §3 입력 — 세그먼트 누적기(digest.ts)가 만드는 판정 입력. 각 항목은 §3 표의 상한으로 절단돼 있다. */
export type SegmentDigest = {
  digestId: string;
  /** 세그먼트 안 `turn_result` 수(cap·bg failover·retry 하위 턴 포함). */
  turns: number;
  /** 마지막 `turn_result.text` 머리+꼬리, ≤ 4,000자. */
  summary: string;
  /** cwd 기준 상대 경로, ≤ 40개. */
  changedFiles: string[];
  /** 절단 전 바뀐 파일 수. */
  changedFileCount: number;
  /** 최근 실행부터 채워 명령+출력 합 ≤ 1,200자, 시간순. */
  testRuns: TestRun[];
  failure: {
    ok: boolean;
    /** ≤ 200자. */
    errorText: string | null;
    kind: 'limit' | 'auth' | 'other' | null;
  };
  /** 서버 정규화 세그먼트 서명(signature.ts) — `CommanderState.signatures` 에 들어간다. */
  signature: string;
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
  /** 멈춘 원인: 'user'(send·steer·일시 정지 탭) · 'card'(권한·질문 카드 — 답하면 자동 재개) · 'restart' · 'check'(판정·검사·예산). */
  pausedBy?: string;
  /** 마지막 판정이 반영된 시각(ms). */
  verdictAtMs?: number;
  /** 칩·푸시에 쓰는 한 줄(사람 필요 이유, 재시작으로 끊김 …). */
  note?: string;
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
    (c.pausedBy === undefined || typeof c.pausedBy === 'string') &&
    (c.note === undefined || typeof c.note === 'string') &&
    (c.verdictAtMs === undefined || typeof c.verdictAtMs === 'number')
  );
}
