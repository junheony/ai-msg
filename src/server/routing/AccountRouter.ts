import { ACCOUNTS, type Account } from '../../shared/accounts';
import { FABLE_MAX_PCT } from '../../shared/models';
import { parseIsoUtc, type UsageSnapshot } from '../../shared/usage-types';

export { FABLE_MAX_PCT };

export const FIVE_HOUR_SWITCH_PCT = 80;
export const WEEKLY_SWITCH_PCT = 85;
export const EXCLUDE_PCT = 95;
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
  /** 이 세션은 B 써: the session's pinned account (null/absent = 자동). Used unless unusable — even the protected one. */
  pinned?: Account | null;
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
  /** The account is the session's pinned one, chosen because of the pin. */
  pinned?: boolean;
  /** The pinned account was unusable this turn (e.g. '한도 도달'); `account` is the router's own choice. */
  pinBlocked?: string;
};

function hoursUntil(iso: string | null, nowMs: number): number {
  if (!iso) return DEFAULT_RESET_HOURS;
  const t = parseIsoUtc(iso);
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
      const age = u.fetchedAt ? input.nowMs - parseIsoUtc(u.fetchedAt) : Number.NaN;
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

/** claude-pick exit 3: least weekly among non-excluded, non-protected accounts with a weekly value, ties a→b→c; else 'b'. */
function leastWeekly(input: RouterInput): Account {
  let best: { account: Account; w: number } | null = null;
  for (const account of ACCOUNTS) {
    if (input.exclude?.includes(account) || account === input.protectedAccount) continue;
    const w = input.usage.accounts[account].weekly?.usedPct;
    if (w === undefined || w === null) continue;
    if (!best || w < best.w) best = { account, w };
  }
  return best?.account ?? 'b';
}

/** Why the pinned account cannot take this turn (≥95%, cooldown, already failed this turn); null = usable. */
function pinBlock(input: RouterInput, pin: Account): { why: string; detail: string } | null {
  if (input.exclude?.includes(pin)) return { why: '이번 턴 실패', detail: '이번 턴 실패' };
  const cd = input.cooldownUntilMs[pin];
  if (cd !== undefined && cd > input.nowMs) return { why: '쿨다운 중', detail: `쿨다운(~${hhmm(cd)})` };
  const u = input.usage.accounts[pin];
  const fiveHour = u.fiveHour?.usedPct ?? 0;
  const weekly = u.weekly?.usedPct ?? 0;
  if (fiveHour >= EXCLUDE_PCT) return { why: '한도 도달', detail: `5h ${fiveHour}%` };
  if (weekly >= EXCLUDE_PCT) return { why: '한도 도달', detail: `주간 ${weekly}%` };
  return null;
}

export function chooseAccount(input: RouterInput): RouterDecision {
  const pin = input.pinned ?? null;
  if (pin) {
    // A pin skips warm-cache and threshold switching (and the protected-account rule: it is the user's explicit choice).
    const block = pinBlock(input, pin);
    if (!block) {
      const { candidates, excluded } = rankCandidates(input);
      const switched = input.current !== null && input.current !== pin;
      return { candidates, excluded, account: pin, switched, pinned: true, reason: `고정 ${LABEL[pin]}${switched ? ' 전환' : ''}` };
    }
    // Unusable: the router's own choice for this turn only (the pin stays).
    const d = chooseAccount({ ...input, pinned: null, exclude: [...(input.exclude ?? []), pin] });
    if (d.account === pin) return { ...d, reason: `고정 ${LABEL[pin]} ${block.detail} · 대안 없음 · ${d.reason}` };
    return { ...d, pinBlocked: block.why, reason: `고정 ${LABEL[pin]} ${block.detail} → ${d.reason}` };
  }
  const { candidates, excluded } = rankCandidates(input);
  const best = candidates[0] ?? null;
  const cur = input.current;
  const base = { candidates, excluded };

  if (cur === null) {
    if (best) return { ...base, account: best.account, switched: false, reason: `새 세션 · 점수 최고 ${LABEL[best.account]}(주간 ${best.weeklyPct}%)` };
    const fb = leastWeekly(input);
    return { ...base, account: fb, switched: false, reason: `자격 있는 계정 없음 → 최소 사용 ${LABEL[fb]}` };
  }

  const cu = input.usage.accounts[cur];
  const fiveHour = cu.fiveHour?.usedPct ?? 0;
  const weekly = cu.weekly?.usedPct ?? 0;
  const fable = cu.fable?.usedPct ?? null;
  const cd = input.cooldownUntilMs[cur];
  const inCooldown = cd !== undefined && cd > input.nowMs;

  let force: string | null = null;
  if (inCooldown) force = `쿨다운(~${hhmm(cd)})`;
  else if (fiveHour >= FIVE_HOUR_SWITCH_PCT || weekly >= WEEKLY_SWITCH_PCT) force = `문턱 초과(5h ${fiveHour}% · 주간 ${weekly}%)`;
  // Unknown Fable counts as not Fable-eligible, same as rankCandidates.
  else if (input.needFable && fable === null) force = 'Fable 값 없음';
  else if (input.needFable && fable !== null && fable >= FABLE_MAX_PCT) force = `Fable ${fable}% 이상`;

  if (force) {
    // Only move to an account that would not itself be forced off next turn (no ping-pong, no wasted cache rewrite).
    // The protected account (spec §4.1: last candidate) is only taken when the current one is unusable.
    const roomy = candidates.find((c) => {
      if (c.account === cur || c.protected) return false;
      const u = input.usage.accounts[c.account];
      return (u.fiveHour?.usedPct ?? 0) < FIVE_HOUR_SWITCH_PCT && c.weeklyPct < WEEKLY_SWITCH_PCT;
    });
    if (roomy) return { ...base, account: roomy.account, switched: true, reason: `${force} → ${LABEL[roomy.account]} 전환` };
    // Current is unusable (≥95 or cooling down): any eligible alternative beats staying (protected sorts last).
    const hard = inCooldown || fiveHour >= EXCLUDE_PCT || weekly >= EXCLUDE_PCT;
    const alt = hard ? candidates.find((c) => c.account !== cur) : undefined;
    if (alt) return { ...base, account: alt.account, switched: true, reason: `${force} → ${LABEL[alt.account]} 전환(여유 있는 대안 없음)` };
    return { ...base, account: cur, switched: false, reason: `${force} · 여유 있는 대안 없음 · ${LABEL[cur]} 유지` };
  }

  const sinceLast = input.lastTurnAtMs === null ? null : input.nowMs - input.lastTurnAtMs;
  const coldWhy = input.justCompacted ? '방금 압축' : sinceLast === null ? '첫 턴' : sinceLast >= WARM_MS ? `${Math.round(sinceLast / 60_000)}분 경과` : null;
  // A `down` current card does not block the cold-cache move: nothing is lost by moving when the cache is cold.
  if (coldWhy && best && best.account !== cur) {
    return { ...base, account: best.account, switched: true, reason: `캐시 식음(${coldWhy}) → 점수 더 좋은 ${LABEL[best.account]}` };
  }
  if (cu.status === 'down') return { ...base, account: cur, switched: false, reason: `잔여량 정보 없음 · ${LABEL[cur]} 유지` };
  if (coldWhy) {
    const why = best ? '현재 계정이 최적' : '자격 있는 대안 없음';
    return { ...base, account: cur, switched: false, reason: `캐시 식음(${coldWhy}) · ${why} · ${LABEL[cur]} 유지` };
  }
  // Deliberate for now (review M1): a warm session stays put even on the protected account; it only
  // leaves on a forced switch or when the cache goes cold.
  return { ...base, account: cur, switched: false, reason: `${LABEL[cur]} 유지 · 캐시 따뜻함(${Math.round((sinceLast ?? 0) / 60_000)}분 전)` };
}
