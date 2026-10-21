import type { Account, AccountNames } from '../../shared/accounts';
import { FABLE_MAX_PCT } from '../../shared/models';
import type { RoutingPolicy } from '../../shared/protocol';
import { leftPct, parseIsoUtc, trusted, usageOf, type UsageSnapshot } from '../../shared/usage-types';

export { FABLE_MAX_PCT };

export const FIVE_HOUR_SWITCH_PCT = 80;
export const WEEKLY_SWITCH_PCT = 85;
export const EXCLUDE_PCT = 95;
export const STALE_MAX_MS = 600_000;
export const WARM_MS = 55 * 60_000;
/** 고르게 분산: 5h usage within this many points counts as a tie (weekly, then the reset-urgency score decide). */
export const BALANCE_TIE_PCT = 5;
/** 고르게 분산, cold cache: a 5h-tied account this many weekly points lower is also a clear win (e.g. one that just reset). */
export const WEEKLY_GAP_PCT = 25;
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
  /**
   * `pinned` is not the user's pin but an edit-fork's parent account (the fork stays there unless it is unusable):
   * the Fable cap does not move it and no pin warning is produced. Default false = a user pin.
   */
  pinIsParent?: boolean;
  /** How 자동 picks among eligible accounts (new sessions, cold caches); default 'balance'. */
  policy?: RoutingPolicy;
  /** Which accounts exist, their order (ties) and labels. */
  accounts: AccountNames;
  /**
   * 같은 벤더 계정 자동 순환 (DeckSettings.sameVendorRotation). false = the turn stays on one account (fixedAccount): no
   * limit / Fable-cap / cold-cache / failover move to another Claude account. Absent = on.
   */
  sameVendorRotation?: boolean;
};

export type Candidate = {
  account: Account;
  score: number;
  /** 0 when the card has no 5h row (see fiveHourKnown). */
  fiveHourPct: number;
  /** False when the card has no 5h row: 고르게 분산 ranks it after every account with a known 5h. */
  fiveHourKnown: boolean;
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
  /**
   * 잔여량 모름: accounts whose usage is not known (no usage-deck, no card, a card too old to trust) and that nothing
   * else rules out, in the order they are tried — after every candidate. They also keep their entry in `excluded`.
   */
  unknown?: Account[];
  /** The account is the session's pinned one, chosen because of the pin. */
  pinned?: boolean;
  /** The pinned account was unusable this turn (e.g. '한도 도달', 'Fable 15% 남음(하한 20%)'); `account` is the router's own choice. */
  pinBlocked?: string;
  /** The pin is honoured although the router would not pick it (Fable at the cap, nowhere else with room): shown to the user. */
  pinWarn?: string;
  /**
   * This Fable turn was routed as an Opus turn, and why: set exactly when `reason` says "→ Opus". The runner runs Opus
   * then, so the reason and the model come from this one decision. Without it the model follows the account's own
   * Fable value (`resolveModel`).
   */
  asOpus?: string;
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

/** An install that has never had an answer from usage-deck: an unknown value alone does not change the model or engine. */
export function isLax(usage: UsageSnapshot): boolean {
  return usage.usageSource === 'none';
}

/**
 * Why a Fable turn with no Fable-eligible account runs on Opus: a Fable value at the limit is known, or (with usage-deck)
 * none is known. null = no reason: an install without usage-deck leaves Fable only for a known value at the limit —
 * not for unknown values, cooldowns or 5h/weekly limits.
 */
export function noFableWhy(input: Pick<RouterInput, 'usage' | 'accounts'>): string | null {
  if (input.accounts.list().some((a) => (usageOf(input.usage, a).fable?.usedPct ?? -1) >= FABLE_MAX_PCT)) return 'Fable 여유 계정 없음';
  return isLax(input.usage) ? null : 'Fable 잔여량 모름(usage-deck 값 없음)';
}

export function rankCandidates(input: RouterInput): { candidates: Candidate[]; excluded: Partial<Record<Account, string>>; unknown: Account[] } {
  const candidates: Candidate[] = [];
  const excluded: Partial<Record<Account, string>> = {};
  const unknown: Account[] = [];
  const reg = input.accounts;
  const lax = isLax(input.usage);
  for (const account of reg.list()) {
    if (input.exclude?.includes(account)) { excluded[account] = '제외 지정'; continue; }
    const u = usageOf(input.usage, account);
    const cd = input.cooldownUntilMs[account];
    const cooling = cd !== undefined && cd > input.nowMs;
    if (u.status === 'down') { excluded[account] = '잔여량 정보 없음'; if (!cooling) unknown.push(account); continue; }
    if (u.status === 'stale') {
      const age = u.fetchedAt ? input.nowMs - parseIsoUtc(u.fetchedAt) : Number.NaN;
      // `cli` mode: an old observation is still a lower bound until its window resets (`trustUntil`): a stale candidate.
      if ((Number.isNaN(age) || age > STALE_MAX_MS) && !trusted(u, input.nowMs)) {
        excluded[account] = `stale 자료 ${Number.isNaN(age) ? '?' : Math.round(age / 1000)}초 경과`;
        // Its last numbers at the limit: old, but no reason to try it before anything else.
        const atLimit = (u.fiveHour?.usedPct ?? 0) >= EXCLUDE_PCT || (u.weekly?.usedPct ?? 0) >= EXCLUDE_PCT;
        if (!cooling && !atLimit) unknown.push(account);
        continue;
      }
    }
    if (cooling) { excluded[account] = `쿨다운(~${hhmm(cd)})`; continue; }
    const weekly = u.weekly?.usedPct;
    if (weekly === undefined || weekly === null) { excluded[account] = '주간 사용률 없음'; unknown.push(account); continue; }
    const fiveHour = u.fiveHour?.usedPct ?? 0;
    if (fiveHour >= EXCLUDE_PCT) { excluded[account] = `5h ${leftPct(fiveHour)}% 남음`; continue; }
    if (weekly >= EXCLUDE_PCT) { excluded[account] = `주간 ${leftPct(weekly)}% 남음`; continue; }
    if (input.needFable) {
      const f = u.fable?.usedPct;
      if (f === undefined || f === null) {
        if (!lax) { excluded[account] = 'Fable 값 없음'; continue; }
      } else if (f >= FABLE_MAX_PCT) { excluded[account] = `Fable ${leftPct(f)}% 남음`; continue; }
    }
    const hoursToReset = hoursUntil(u.weekly?.resetsAt ?? null, input.nowMs);
    candidates.push({
      account,
      score: (100 - weekly) / Math.max(hoursToReset, 1),
      fiveHourPct: fiveHour,
      fiveHourKnown: typeof u.fiveHour?.usedPct === 'number',
      weeklyPct: weekly,
      hoursToReset,
      stale: u.status === 'stale',
      protected: account === input.protectedAccount,
    });
  }
  candidates.sort(drainOrder(reg));
  // The registry's fallback order: not protected and not home first, then home, the protected account last. Within
  // one rank the lowest last-known weekly first (old numbers still tell a nearly full account from an empty one);
  // accounts with no weekly value at all follow.
  const rank = (a: Account) => (a === input.protectedAccount ? 2 : reg.isHome(a) ? 1 : 0);
  const lastWeekly = (a: Account) => usageOf(input.usage, a).weekly?.usedPct ?? Infinity;
  unknown.sort((x, y) => rank(x) - rank(y) || (lastWeekly(x) === lastWeekly(y) ? 0 : lastWeekly(x) - lastWeekly(y)));
  return { candidates: (input.policy ?? 'balance') === 'balance' ? balanceOrder(candidates, input.usage.usageMode === 'cli') : candidates, excluded, unknown };
}

/**
 * 리셋 임박 먼저 소진: safe accounts first (one past a force threshold would be forced off again next turn — the same
 * rule as the forced switch's target, so new-session, cold-move and forced-switch orders agree and never ping-pong),
 * then the highest (100 - weekly) / hours-to-reset, then the lower weekly; on a tie the protected account last, then
 * the later account in the registry's order first.
 */
function drainOrder(reg: AccountNames): (x: Candidate, y: Candidate) => number {
  const order = reg.list();
  return (x, y) => Number(!isSafe(x)) - Number(!isSafe(y)) ||
    y.score - x.score ||
    x.weeklyPct - y.weeklyPct ||
    Number(x.protected) - Number(y.protected) ||
    Number(x.stale) - Number(y.stale) ||
    order.indexOf(y.account) - order.indexOf(x.account);
}

/** Under both force-switch thresholds (down/cooldown/untrusted stale/≥95 never become candidates). */
function isSafe(c: Candidate): boolean {
  return c.fiveHourPct < FIVE_HOUR_SWITCH_PCT && c.weeklyPct < WEEKLY_SWITCH_PCT;
}

/**
 * 고르게 분산: safe candidates first, lowest 5h first; 5h within BALANCE_TIE_PCT of the lowest is a tie, broken by the
 * lower weekly, then the protected account last (it is a candidate like any other — 다 같이 쓰게 — and only loses
 * ties), then the drain order (score). Safe candidates with no 5h row follow (unknown is not 0%, so it never wins over
 * a known value), in drain order. The ones past a threshold follow in drain order — so with no safe candidate this is
 * exactly the drain ranking.
 * `cli` usage mode: a stale candidate's numbers are only a lower bound (kept until `trustUntil`), so every freshly
 * observed safe candidate comes first, then the stale safe ones — each group in the order above.
 */
function balanceOrder(drainSorted: Candidate[], cli = false): Candidate[] {
  const safeOrder = (group: Candidate[]): Candidate[] => {
    const pool = group.filter((c) => c.fiveHourKnown);
    const out: Candidate[] = [];
    while (pool.length > 0) {
      const low = Math.min(...pool.map((c) => c.fiveHourPct));
      // `pool` is in drain order and the sort is stable: a full tie keeps the score order.
      const pick = pool.filter((c) => c.fiveHourPct <= low + BALANCE_TIE_PCT)
        .sort((x, y) => x.weeklyPct - y.weeklyPct || Number(x.protected) - Number(y.protected))[0] as Candidate;
      out.push(pick);
      pool.splice(pool.indexOf(pick), 1);
    }
    return [...out, ...group.filter((c) => !c.fiveHourKnown)];
  };
  const safe = drainSorted.filter(isSafe);
  const head = cli ? [...safeOrder(safe.filter((c) => !c.stale)), ...safeOrder(safe.filter((c) => c.stale))] : safeOrder(safe);
  return [...head, ...drainSorted.filter((c) => !isSafe(c))];
}

/** A candidate's 5h for reasons and logs: '?' when the card has no 5h row. */
function pct5(c: Candidate): string {
  return c.fiveHourKnown ? `${c.fiveHourPct}%` : '?';
}

/** A candidate's 5h said as what is left, for reasons: '?' when the card has no 5h row. */
function left5(c: Candidate): string {
  return c.fiveHourKnown ? `${leftPct(c.fiveHourPct)}% 남음` : '?';
}

/** Why `cands[0]` (safe) won under 고르게 분산, against the runner-up (what is left: the UI's numbers). */
function balanceWhy(reg: AccountNames, cands: Candidate[], cli = false): string {
  const [b, n] = cands as [Candidate, Candidate | undefined];
  const B = reg.label(b.account);
  if (!n) return `분산: 5h ${B} ${left5(b)} · 유일한 후보`;
  const N = reg.label(n.account);
  if (!isSafe(n)) return `분산: 5h ${B} ${left5(b)} · ${N} 문턱 근접`;
  if (cli && !b.stale && n.stale) return `분산: 5h ${B} ${left5(b)} · ${N} 오래된 관측(추정)`;
  if (b.fiveHourKnown && !n.fiveHourKnown) return `분산: 5h ${B} ${left5(b)} · ${N} 5h 값 없음`;
  if (n.fiveHourPct - b.fiveHourPct > BALANCE_TIE_PCT) return `분산: 5h ${B} ${left5(b)} > ${N} ${left5(n)}`;
  if (b.weeklyPct < n.weeklyPct) return `분산: 5h 비슷(${B} ${left5(b)} · ${N} ${left5(n)}) · 주간 ${B} ${leftPct(b.weeklyPct)}% 남음 > ${N} ${leftPct(n.weeklyPct)}% 남음`;
  if (n.protected && !b.protected && b.fiveHourKnown && n.fiveHourKnown && b.weeklyPct === n.weeklyPct) return `분산: 5h·주간 비슷 · ${N} 동률이면 마지막`;
  return `분산: 5h·주간 비슷 · 리셋 임박 ${B}`;
}

/** The policy's reason for picking `cands[0]`. */
function bestWhy(input: RouterInput, cands: Candidate[]): string {
  const b = cands[0] as Candidate;
  const reg = input.accounts;
  const drain = `리셋 임박 ${reg.label(b.account)}(주간 ${leftPct(b.weeklyPct)}% 남음 · ${Math.round(b.hoursToReset)}시간 뒤 리셋)`;
  if ((input.policy ?? 'balance') === 'drain') return drain;
  return isSafe(b) ? balanceWhy(reg, cands, input.usage.usageMode === 'cli') : `안전한 후보 없음 → ${drain}`;
}

/** The server log line for a routed turn: decision, candidates and exclusions (usage numbers only, no secrets). */
export function routeLogLine(sessionId: string | null, d: RouterDecision, accounts: AccountNames): string {
  const LABEL = (a: Account) => accounts.label(a);
  const cands = d.candidates.map((c) => `${LABEL(c.account)} 5h ${pct5(c)} · 주간 ${c.weeklyPct}%`).join(', ');
  const unknown = (d.unknown ?? []).map(LABEL).join(', ');
  const ex = accounts.list().filter((a) => d.excluded[a] && !d.unknown?.includes(a)).map((a) => `${LABEL(a)} ${d.excluded[a]}`).join(', ');
  return `deck: route ${sessionId ? sessionId.slice(0, 8) : '새 세션'} → ${LABEL(d.account)} (${d.reason})${cands ? ` · 후보 ${cands}` : ''}${unknown ? ` · 잔여량 모름 ${unknown}` : ''}${ex ? ` · 제외 ${ex}` : ''}`;
}

/** Least weekly among non-excluded accounts with a weekly value (the protected one included, but last on a tie), other ties in the registry's order; else the registry's fallback (not protected, not home: `b` in the a/b/c set). */
function leastWeekly(input: RouterInput): Account {
  const reg = input.accounts;
  let best: { account: Account; w: number } | null = null;
  for (const account of reg.list()) {
    if (input.exclude?.includes(account)) continue;
    const w = usageOf(input.usage, account).weekly?.usedPct;
    if (w === undefined || w === null) continue;
    const tieBeatsProtected = !!best && w === best.w && best.account === input.protectedAccount && account !== input.protectedAccount;
    if (!best || w < best.w || tieBeatsProtected) best = { account, w };
  }
  return best?.account ?? reg.fallback(input.protectedAccount);
}

/** A user pin's known Fable value at or over the cap, for a Fable turn; null otherwise (a fork's parent account never). */
function pinFableOver(input: RouterInput, pin: Account): number | null {
  if (!input.needFable || input.pinIsParent) return null;
  const f = usageOf(input.usage, pin).fable?.usedPct;
  return typeof f === 'number' && f >= FABLE_MAX_PCT ? f : null;
}

/** Why the pinned account cannot take this turn (≥95%, cooldown, already failed this turn); null = usable. */
function pinBlock(input: RouterInput, pin: Account): { why: string; detail: string } | null {
  if (input.exclude?.includes(pin)) return { why: '이번 턴 실패', detail: '이번 턴 실패' };
  const cd = input.cooldownUntilMs[pin];
  if (cd !== undefined && cd > input.nowMs) return { why: '쿨다운 중', detail: `쿨다운(~${hhmm(cd)})` };
  const u = usageOf(input.usage, pin);
  const fiveHour = u.fiveHour?.usedPct ?? 0;
  const weekly = u.weekly?.usedPct ?? 0;
  if (fiveHour >= EXCLUDE_PCT) return { why: '한도 도달', detail: `5h ${leftPct(fiveHour)}% 남음` };
  if (weekly >= EXCLUDE_PCT) return { why: '한도 도달', detail: `주간 ${leftPct(weekly)}% 남음` };
  return null;
}

/** Said in the reason (badge, route log) of every turn routed with 같은 벤더 계정 자동 순환 off. */
export const NO_ROTATION = '같은 벤더 순환 꺼짐';

/** `reg` narrowed to the one active account `only`: routing over it never picks another account. */
export function onlyAccount(reg: AccountNames, only: Account): AccountNames {
  return {
    list: () => [only],
    all: () => reg.all(),
    has: (id: unknown): id is Account => reg.has(id),
    isRetired: (id) => reg.isRetired(id),
    label: (id) => reg.label(id),
    cardId: (id) => reg.cardId(id),
    home: reg.home,
    isHome: (id) => reg.isHome(id),
    fallback: () => only,
  };
}

/**
 * With 같은 벤더 계정 자동 순환 off, the one account a turn may run on: the pin (the user's explicit choice, or an
 * edit-fork's parent), else the session's own account, else (a new session, a retired account) the home account.
 */
export function fixedAccount(input: Pick<RouterInput, 'pinned' | 'current' | 'accounts'>): Account {
  const active = input.accounts.list();
  if (input.pinned && active.includes(input.pinned)) return input.pinned;
  if (input.current !== null && active.includes(input.current)) return input.current;
  return input.accounts.home;
}

export function chooseAccount(input: RouterInput): RouterDecision {
  const reg = input.accounts;
  const LABEL = (a: Account) => reg.label(a);
  if (input.sameVendorRotation === false) {
    // The same decision over that one account: limits, cooldowns and the Fable cap still decide the reason and the
    // model (→ Opus), but never send the turn to another Claude account.
    const d = chooseAccount({ ...input, sameVendorRotation: true, accounts: onlyAccount(reg, fixedAccount(input)) });
    return { ...d, reason: `${NO_ROTATION} · ${d.reason}` };
  }
  // A pin on an account that is not active (removed or retired since) is no pin.
  const pin = input.pinned && reg.list().includes(input.pinned) ? input.pinned : null;
  if (pin) {
    // A pin skips warm-cache and threshold switching (and the ranking altogether: it is the user's explicit choice).
    const block = pinBlock(input, pin);
    if (!block) {
      // A pin means "this account", not "whatever it costs": for a Fable turn, a pin at the Fable cap yields this turn
      // to the router's own choice — when that choice is another account taking the turn as a Fable turn (not the pin
      // itself for want of a roomy alternative, not an Opus fallback). Otherwise the pin holds and the user is told.
      // (2026-10-12: pins set while B·C were capped kept burning A at Fable 85% for days after they had reset.)
      const over = pinFableOver(input, pin);
      if (over !== null) {
        const d = chooseAccount({ ...input, pinned: null, exclude: [...(input.exclude ?? []), pin] });
        if (d.account !== pin && !d.asOpus) return { ...d, pinBlocked: `Fable ${leftPct(over)}% 남음(하한 ${100 - FABLE_MAX_PCT}%)`, reason: `고정 ${LABEL(pin)} Fable ${leftPct(over)}% 남음 → ${d.reason}` };
      }
      const ranked = rankCandidates(input);
      const switched = input.current !== null && input.current !== pin;
      const warn = over === null ? undefined : `Fable ${leftPct(over)}% 남음(하한 ${100 - FABLE_MAX_PCT}%) — 대신 쓸 계정이 없어 그대로`;
      const reason = warn && over !== null ? `고정 ${LABEL(pin)}${switched ? ' 전환' : ''} · Fable ${leftPct(over)}% 남음(하한 ${100 - FABLE_MAX_PCT}%) · 대안 없음` : `고정 ${LABEL(pin)}${switched ? ' 전환' : ''}`;
      return { ...ranked, account: pin, switched, pinned: true, reason, ...(warn ? { pinWarn: warn } : {}) };
    }
    // Unusable: the router's own choice for this turn only (the pin stays).
    const d = chooseAccount({ ...input, pinned: null, exclude: [...(input.exclude ?? []), pin] });
    if (d.account === pin) return { ...d, reason: `고정 ${LABEL(pin)} ${block.detail} · 대안 없음 · ${d.reason}` };
    return { ...d, pinBlocked: block.why, reason: `고정 ${LABEL(pin)} ${block.detail} → ${d.reason}` };
  }
  const { candidates, excluded, unknown } = rankCandidates(input);
  // No Fable-eligible account at all (the protected one counts — it is a candidate like any other, it only loses ties):
  // the turn is routed like an Opus turn — not to the "least weekly" fallback, which ignores 5h limits and cooldowns.
  // Whether it then runs on Opus follows the account it lands on (below).
  const lax = isLax(input.usage);
  // Without usage-deck ever: accounts nothing is known about take the Fable turn as it is (the unknown tier below).
  const blindFable = lax && candidates.length === 0 && unknown.length > 0;
  if (input.needFable && !blindFable && candidates.length === 0) {
    const d = chooseAccount({ ...input, needFable: false });
    // The model follows that account's own Fable value, as `resolveModel` reads it: at the limit → Opus; unknown → Opus
    // with usage-deck, Fable without; known room (the account is out for a 5h/weekly limit, a cooldown or an old card,
    // none of which is a reason to change the model) → Fable. "→ Opus" is said only with `asOpus`, and the other way round.
    const f = usageOf(input.usage, d.account).fable?.usedPct ?? null;
    const why = f === null ? (lax ? null : noFableWhy(input)) : f < FABLE_MAX_PCT ? null : 'Fable 여유 계정 없음';
    if (why === null) return d;
    return { ...d, asOpus: why, reason: `${why} → Opus · ${d.reason}` };
  }
  const best = candidates[0] ?? null;
  const cur = input.current;
  const base = { candidates, excluded, unknown };

  if (cur === null) {
    if (best) return { ...base, account: best.account, switched: false, reason: `새 세션 · ${bestWhy(input, candidates)}` };
    // Nobody is known to have room: an account nothing is known about comes before one known to be at its limit.
    const blind = unknown[0];
    if (blind !== undefined) return { ...base, account: blind, switched: false, reason: `자격 있는 계정 없음 → 잔여량 모름 · ${LABEL(blind)}` };
    const fb = leastWeekly(input);
    return { ...base, account: fb, switched: false, reason: `자격 있는 계정 없음 → 최소 사용 ${LABEL(fb)}` };
  }

  const cu = usageOf(input.usage, cur);
  const fiveHour = cu.fiveHour?.usedPct ?? 0;
  const weekly = cu.weekly?.usedPct ?? 0;
  const fable = cu.fable?.usedPct ?? null;
  const cd = input.cooldownUntilMs[cur];
  const inCooldown = cd !== undefined && cd > input.nowMs;

  let force: string | null = null;
  if (inCooldown) force = `쿨다운(~${hhmm(cd)})`;
  else if (fiveHour >= FIVE_HOUR_SWITCH_PCT || weekly >= WEEKLY_SWITCH_PCT) force = `문턱 초과(5h ${leftPct(fiveHour)}% 남음 · 주간 ${leftPct(weekly)}% 남음)`;
  // Unknown Fable counts as not Fable-eligible, same as rankCandidates.
  else if (input.needFable && fable === null && !lax) force = 'Fable 값 없음';
  else if (input.needFable && fable !== null && fable >= FABLE_MAX_PCT) force = `Fable ${leftPct(fable)}% 남음`;

  if (force) {
    // Only move to an account that would not itself be forced off next turn (no ping-pong, no wasted cache rewrite).
    // The target follows the policy: 고르게 분산 → the balance order (safe, lowest 5h first); drain → the drain order.
    // The protected account is a target like any other (it only loses ties).
    const ordered = (input.policy ?? 'balance') === 'drain' ? [...candidates].sort(drainOrder(reg)) : candidates;
    const roomy = ordered.find((c) => {
      if (c.account === cur) return false;
      const u = usageOf(input.usage, c.account);
      return (u.fiveHour?.usedPct ?? 0) < FIVE_HOUR_SWITCH_PCT && c.weeklyPct < WEEKLY_SWITCH_PCT;
    });
    if (roomy) return { ...base, account: roomy.account, switched: true, reason: `${force} → ${LABEL(roomy.account)} 전환` };
    // Current is unusable (≥95 or cooling down): any eligible alternative beats staying (in `ordered` order; protected loses only ties).
    const hard = inCooldown || fiveHour >= EXCLUDE_PCT || weekly >= EXCLUDE_PCT;
    const alt = hard ? ordered.find((c) => c.account !== cur) : undefined;
    if (alt) return { ...base, account: alt.account, switched: true, reason: `${force} → ${LABEL(alt.account)} 전환(여유 있는 대안 없음)` };
    const blind = hard ? unknown.find((a) => a !== cur) : undefined;
    if (blind !== undefined) return { ...base, account: blind, switched: true, reason: `${force} → 잔여량 모름 · ${LABEL(blind)} 전환` };
    return { ...base, account: cur, switched: false, reason: `${force} · 여유 있는 대안 없음 · ${LABEL(cur)} 유지` };
  }

  const sinceLast = input.lastTurnAtMs === null ? null : input.nowMs - input.lastTurnAtMs;
  const coldWhy = input.justCompacted ? '방금 압축' : sinceLast === null ? '첫 턴' : sinceLast >= WARM_MS ? `${Math.round(sinceLast / 60_000)}분 경과` : null;
  // A `down` current card does not block the cold-cache move: nothing is lost by moving when the cache is cold.
  // 고르게 분산 hysteresis: 5h moves a lot, so a cold session on a safe account (the protected one included) only moves
  // for a clear win (5h more than BALANCE_TIE_PCT lower, both known; or 5h no worse than the tie band and weekly at least
  // WEEKLY_GAP_PCT lower) — not B→C→B on every idle hour, each one a relocate().
  const curCand = candidates.find((c) => c.account === cur);
  const fiveHourWin = !!best && !!curCand && best.fiveHourKnown && curCand.fiveHourKnown && best.fiveHourPct + BALANCE_TIE_PCT < curCand.fiveHourPct;
  const weeklyWin = !!best && !!curCand && best.fiveHourKnown && curCand.fiveHourKnown &&
    best.fiveHourPct <= curCand.fiveHourPct + BALANCE_TIE_PCT && best.weeklyPct + WEEKLY_GAP_PCT <= curCand.weeklyPct;
  const marginal = (input.policy ?? 'balance') === 'balance' && !!best && !!curCand && isSafe(curCand) && !fiveHourWin && !weeklyWin;
  if (coldWhy && best && best.account !== cur && !marginal) {
    return { ...base, account: best.account, switched: true, reason: `캐시 식음(${coldWhy}) → ${LABEL(best.account)} · ${bestWhy(input, candidates)}` };
  }
  if (cu.status === 'down') return { ...base, account: cur, switched: false, reason: `잔여량 정보 없음 · ${LABEL(cur)} 유지` };
  if (coldWhy) {
    const why = best ? (best.account !== cur ? `현재 계정이 최적(5h 차이 ${BALANCE_TIE_PCT}%p 이내 · 주간 차이 ${WEEKLY_GAP_PCT}%p 미만)` : '현재 계정이 최적') : '자격 있는 대안 없음';
    return { ...base, account: cur, switched: false, reason: `캐시 식음(${coldWhy}) · ${why} · ${LABEL(cur)} 유지` };
  }
  // A warm session stays put; it only leaves on a forced switch or when the cache goes cold.
  return { ...base, account: cur, switched: false, reason: `${LABEL(cur)} 유지 · 캐시 따뜻함(${Math.round((sinceLast ?? 0) / 60_000)}분 전)` };
}
