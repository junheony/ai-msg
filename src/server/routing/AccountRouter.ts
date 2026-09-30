import { ACCOUNTS, type Account } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage-types';

export const FIVE_HOUR_SWITCH_PCT = 80;
export const WEEKLY_SWITCH_PCT = 85;
export const EXCLUDE_PCT = 95;
export const FABLE_MAX_PCT = 80;
export const STALE_MAX_MS = 600_000;
export const WARM_MS = 55 * 60_000;
const DEFAULT_RESET_HOURS = 168;

export type RouterInput = {
  current: Account | null;
  usage: UsageSnapshot;
  nowMs: number;
  /** Last turn of this session on `current` (ms); null = never / imported. */
  lastTurnAtMs: number | null;
  justCompacted: boolean;
  cooldownUntilMs: Partial<Record<Account, number>>;
  protectedAccount: Account | null;
  needFable: boolean;
  exclude?: Account[];
};

export type Candidate = {
  account: Account;
  score: number;
  weeklyPct: number;
  hoursToReset: number;
  stale: boolean;
  protected: boolean;
};

export type RouterDecision = {
  account: Account;
  reason: string;
  switched: boolean;
  candidates: Candidate[];
  excluded: Partial<Record<Account, string>>;
};

function hoursUntil(iso: string | null, nowMs: number): number {
  if (!iso) return DEFAULT_RESET_HOURS;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? DEFAULT_RESET_HOURS : (t - nowMs) / 3_600_000;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const LABEL: Record<Account, string> = { a: 'A', b: 'B', c: 'C' };

export function rankCandidates(input: RouterInput): { candidates: Candidate[]; excluded: Partial<Record<Account, string>> } {
  const candidates: Candidate[] = [];
  const excluded: Partial<Record<Account, string>> = {};
  for (const account of ACCOUNTS) {
    if (input.exclude?.includes(account)) { excluded[account] = '제외 지정'; continue; }
    const u = input.usage.accounts[account];
    if (u.status === 'down') { excluded[account] = '잔여량 정보 없음'; continue; }
    if (u.status === 'stale') {
      const age = u.fetchedAt ? input.nowMs - Date.parse(u.fetchedAt) : Number.NaN;
      if (Number.isNaN(age) || age > STALE_MAX_MS) {
        excluded[account] = `stale 자료 ${Number.isNaN(age) ? '?' : Math.round(age / 1000)}초 경과`;
        continue;
      }
    }
    const cd = input.cooldownUntilMs[account];
    if (cd !== undefined && cd > input.nowMs) { excluded[account] = `쿨다운(~${hhmm(cd)})`; continue; }
    const weekly = u.weekly?.usedPct;
    if (weekly === undefined || weekly === null) { excluded[account] = '주간 사용률 없음'; continue; }
    const fiveHour = u.fiveHour?.usedPct ?? 0;
    if (fiveHour >= EXCLUDE_PCT) { excluded[account] = `5h ${fiveHour}%`; continue; }
    if (weekly >= EXCLUDE_PCT) { excluded[account] = `주간 ${weekly}%`; continue; }
    if (input.needFable) {
      const f = u.fable?.usedPct;
      if (f === undefined || f === null) { excluded[account] = 'Fable 값 없음'; continue; }
      if (f >= FABLE_MAX_PCT) { excluded[account] = `Fable ${f}%`; continue; }
    }
    const hoursToReset = hoursUntil(u.weekly?.resetsAt ?? null, input.nowMs);
    candidates.push({
      account,
      score: (100 - weekly) / Math.max(hoursToReset, 1),
      weeklyPct: weekly,
      hoursToReset,
      stale: u.status === 'stale',
      protected: account === input.protectedAccount,
    });
  }
  candidates.sort((x, y) =>
    Number(x.protected) - Number(y.protected) ||
    y.score - x.score ||
    x.weeklyPct - y.weeklyPct ||
    Number(x.stale) - Number(y.stale) ||
    (y.account < x.account ? -1 : y.account > x.account ? 1 : 0),
  );
  return { candidates, excluded };
}

function leastWeekly(input: RouterInput): Account | null {
  let best: { account: Account; w: number } | null = null;
  for (const account of ACCOUNTS) {
    const w = input.usage.accounts[account].weekly?.usedPct;
    if (w === undefined || w === null) continue;
    if (!best || w < best.w) best = { account, w };
  }
  return best?.account ?? null;
}

export function chooseAccount(input: RouterInput): RouterDecision {
  const { candidates, excluded } = rankCandidates(input);
  const best = candidates[0] ?? null;
  const cur = input.current;
  const base = { candidates, excluded };

  if (cur === null) {
    if (best) return { ...base, account: best.account, switched: false, reason: `새 세션 · 점수 최고 ${LABEL[best.account]}(주간 ${best.weeklyPct}%)` };
    const fb = leastWeekly(input) ?? 'b';
    return { ...base, account: fb, switched: false, reason: `자격 있는 계정 없음 → 최소 사용 ${LABEL[fb]}` };
  }

  const cu = input.usage.accounts[cur];
  const fiveHour = cu.fiveHour?.usedPct ?? 0;
  const weekly = cu.weekly?.usedPct ?? 0;
  const fable = cu.fable?.usedPct ?? 0;
  const cd = input.cooldownUntilMs[cur];
  const inCooldown = cd !== undefined && cd > input.nowMs;
  const alt = candidates.find((c) => c.account !== cur) ?? null;

  let force: string | null = null;
  if (inCooldown) force = `쿨다운(~${hhmm(cd)})`;
  else if (fiveHour >= FIVE_HOUR_SWITCH_PCT || weekly >= WEEKLY_SWITCH_PCT) force = `문턱 초과(5h ${fiveHour}% · 주간 ${weekly}%)`;
  else if (input.needFable && fable >= FABLE_MAX_PCT) force = `Fable ${fable}% 이상`;

  if (force) {
    if (alt) return { ...base, account: alt.account, switched: true, reason: `${force} → ${LABEL[alt.account]} 전환` };
    return { ...base, account: cur, switched: false, reason: `${force} · 대안 없음 · ${LABEL[cur]} 유지` };
  }

  if (cu.status === 'down') return { ...base, account: cur, switched: false, reason: `잔여량 정보 없음 · ${LABEL[cur]} 유지` };

  const sinceLast = input.lastTurnAtMs === null ? null : input.nowMs - input.lastTurnAtMs;
  const coldWhy = input.justCompacted ? '방금 압축' : sinceLast === null ? '첫 턴' : sinceLast >= WARM_MS ? `${Math.round(sinceLast / 60_000)}분 경과` : null;
  if (coldWhy && best && best.account !== cur) {
    return { ...base, account: best.account, switched: true, reason: `캐시 식음(${coldWhy}) → 점수 더 좋은 ${LABEL[best.account]}` };
  }
  if (coldWhy) return { ...base, account: cur, switched: false, reason: `캐시 식음(${coldWhy}) · 현재 계정이 최적 · ${LABEL[cur]} 유지` };
  return { ...base, account: cur, switched: false, reason: `${LABEL[cur]} 유지 · 캐시 따뜻함(${Math.round((sinceLast ?? 0) / 60_000)}분 전)` };
}
