import { describe, expect, it } from 'vitest';
import type { Account } from '../../shared/accounts';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import { chooseAccount, rankCandidates, routeLogLine, type RouterInput } from './AccountRouter';

const NOW = Date.parse('2026-09-30T12:30:00Z');
const H = 3_600_000;

type Spec = { s?: number; w?: number; f?: number | null; status?: AccountUsage['status']; age?: number; resetH?: number };

function acct(spec: Spec): AccountUsage {
  const status = spec.status ?? 'ok';
  const fetchedAt = new Date(NOW - (spec.age ?? 30_000)).toISOString();
  const resetsAt = new Date(NOW + (spec.resetH ?? 100) * H).toISOString();
  return {
    status,
    fetchedAt,
    fiveHour: spec.s === undefined ? { usedPct: 10, resetsAt } : { usedPct: spec.s, resetsAt },
    weekly: spec.w === undefined ? null : { usedPct: spec.w, resetsAt },
    fable: spec.f === null ? null : { usedPct: spec.f ?? 0, resetsAt },
  };
}

function snap(a: Spec, b: Spec, c: Spec, reachable = true): UsageSnapshot {
  return { generatedAt: new Date(NOW).toISOString(), deckReachable: reachable, accounts: { a: acct(a), b: acct(b), c: acct(c) } };
}

function input(over: Partial<RouterInput>): RouterInput {
  return {
    current: null,
    usage: snap({ w: 7, resetH: 154 }, { w: 3, resetH: 84 }, { w: 91, resetH: 36 }),
    nowMs: NOW,
    lastTurnAtMs: null,
    justCompacted: false,
    cooldownUntilMs: {},
    protectedAccount: null,
    needFable: false,
    // The tables below pin the old "리셋 임박 먼저 소진" policy: they are the proof it is unchanged.
    policy: 'drain',
    ...over,
  };
}

describe('rankCandidates', () => {
  it('scores (100-weekly)/hours and orders by score', () => {
    const { candidates } = rankCandidates(input({}));
    expect(candidates.map((c) => c.account)).toEqual(['b', 'a', 'c']);
    expect(candidates[0]?.score).toBeCloseTo(97 / 84, 5);
  });

  it('excludes ≥95, cooldown, stale >600s, missing weekly, and explicit exclude', () => {
    const { candidates, excluded } = rankCandidates(input({
      usage: snap({ w: 96 }, { w: 10, s: 95 }, { w: 10, status: 'stale', age: 601_000 }),
      cooldownUntilMs: {},
    }));
    expect(candidates).toEqual([]);
    expect(excluded.a).toMatch(/주간 96/);
    expect(excluded.b).toMatch(/5h 95/);
    expect(excluded.c).toMatch(/stale/);
    const r2 = rankCandidates(input({ usage: snap({ w: 10 }, {}, { w: 10 }), cooldownUntilMs: { c: NOW + 1000 }, exclude: ['a'] }));
    expect(r2.candidates).toEqual([]);
    expect(r2.excluded.b).toMatch(/주간 사용률 없음/);
    expect(r2.excluded.c).toMatch(/쿨다운/);
    expect(r2.excluded.a).toMatch(/제외/);
  });

  it('stale within 600s stays eligible but sorts after ok on ties; ties break c > b > a', () => {
    const { candidates } = rankCandidates(input({ usage: snap({ w: 10, resetH: 50 }, { w: 10, resetH: 50, status: 'stale', age: 100_000 }, { w: 10, resetH: 50 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c', 'a', 'b']);
  });

  it('needFable drops accounts with Fable ≥80 or unknown', () => {
    const { candidates, excluded } = rankCandidates(input({ needFable: true, usage: snap({ w: 10, f: 80 }, { w: 10, f: null }, { w: 10, f: 79 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c']);
    expect(excluded.a).toMatch(/Fable 80/);
    expect(excluded.b).toMatch(/Fable 값 없음/);
  });

  it('protected account sorts last even with the best score', () => {
    const { candidates } = rankCandidates(input({ protectedAccount: 'a', usage: snap({ w: 0, resetH: 10 }, { w: 50 }, { w: 60 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['b', 'c', 'a']);
    expect(candidates[2]?.protected).toBe(true);
  });
});

describe('chooseAccount — table', () => {
  const cases: { name: string; in: Partial<RouterInput>; account: Account; switched: boolean; reason: RegExp }[] = [
    { name: 'new session → best score', in: {}, account: 'b', switched: false, reason: /새 세션/ },
    { name: 'new session, protected a is last', in: { protectedAccount: 'a', usage: snap({ w: 0, resetH: 10 }, { w: 50 }, { w: 60 }) }, account: 'b', switched: false, reason: /새 세션/ },
    { name: 'new session, protected is the only candidate', in: { protectedAccount: 'a', usage: snap({ w: 0 }, { w: 96 }, { w: 97 }) }, account: 'a', switched: false, reason: /새 세션/ },
    { name: 'no eligible at all → least weekly', in: { usage: snap({ w: 96 }, { w: 95 }, { w: 99 }) }, account: 'b', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'current over 5h 80 → switch', in: { current: 'b', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 7 }, { w: 3, s: 80 }, { w: 91 }) }, account: 'a', switched: true, reason: /문턱/ },
    { name: 'current over weekly 85 → switch', in: { current: 'c', lastTurnAtMs: NOW - 60_000 }, account: 'b', switched: true, reason: /문턱/ },
    { name: 'current in cooldown → switch', in: { current: 'b', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { b: NOW + 60_000 } }, account: 'a', switched: true, reason: /쿨다운/ },
    { name: 'current over but no alternative → stay', in: { current: 'b', usage: snap({ w: 96 }, { w: 3, s: 85 }, { w: 97 }) }, account: 'b', switched: false, reason: /대안 없음/ },
    { name: 'warm cache with a better account → stay', in: { current: 'a', lastTurnAtMs: NOW - 10 * 60_000 }, account: 'a', switched: false, reason: /캐시 따뜻함/ },
    { name: 'cold cache (55 min) → better account', in: { current: 'a', lastTurnAtMs: NOW - 55 * 60_000 }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'just compacted → better account', in: { current: 'a', lastTurnAtMs: NOW - 60_000, justCompacted: true }, account: 'b', switched: true, reason: /압축/ },
    { name: 'imported session (no last turn) → better account', in: { current: 'a' }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'cold but current is best → stay', in: { current: 'b', lastTurnAtMs: NOW - 2 * H }, account: 'b', switched: false, reason: /현재 계정이 최적/ },
    { name: 'deck down → stay on current', in: { current: 'c', usage: snap({ status: 'down' }, { status: 'down' }, { status: 'down' }, false) }, account: 'c', switched: false, reason: /잔여량 정보 없음/ },
    { name: 'deck stale >600s everywhere → stay', in: { current: 'c', lastTurnAtMs: NOW - 2 * H, usage: snap({ w: 7, status: 'stale', age: 900_000 }, { w: 3, status: 'stale', age: 900_000 }, { w: 10, status: 'stale', age: 900_000 }) }, account: 'c', switched: false, reason: /대안 없음/ },
    { name: 'needFable and current Fable 85 → switch to one with room', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 85 }, { w: 3, f: 10 }, { w: 91, f: 27 }) }, account: 'b', switched: true, reason: /Fable/ },
    { name: 'needFable and current Fable unknown → switch to one with room', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: null }, { w: 3, f: 10 }, { w: 91, f: 27 }) }, account: 'b', switched: true, reason: /Fable/ },
    { name: 'current card down, cold cache → move to a better account', in: { current: 'a', lastTurnAtMs: NOW - 2 * H, usage: snap({ status: 'down' }, { w: 3 }, { w: 10 }) }, account: 'b', switched: true, reason: /캐시 식음/ },
    { name: 'current card down, warm cache → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ status: 'down' }, { w: 3 }, { w: 10 }) }, account: 'a', switched: false, reason: /유지/ },
    { name: 'over threshold, only alt is also over its 5h threshold → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'over threshold, alt is over its weekly threshold → stay', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 10, w: 88 }, { s: 10, w: 96 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'current ≥95 on 5h, alt merely over threshold → still switch', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 96, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'b', switched: true, reason: /전환/ },
    { name: 'current in cooldown, alt merely over threshold → still switch', in: { current: 'a', lastTurnAtMs: NOW - 60_000, cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ s: 10, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 96 }) }, account: 'b', switched: true, reason: /쿨다운/ },
    { name: 'over threshold → prefers an alt under both switch thresholds', in: { current: 'a', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 85, w: 1, resetH: 5 }, { s: 10, w: 50 }) }, account: 'c', switched: true, reason: /전환/ },
    { name: 'over threshold, only the protected account has room → stay', in: { current: 'a', protectedAccount: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 81, w: 10 }, { s: 90, w: 10 }, { s: 10, w: 10 }) }, account: 'a', switched: false, reason: /대안 없음/ },
    { name: 'current ≥95, only the protected account has room → protected', in: { current: 'a', protectedAccount: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ s: 96, w: 10 }, { s: 10, w: 96 }, { s: 10, w: 10 }) }, account: 'c', switched: true, reason: /전환/ },
    { name: 'no eligible, protected has least weekly → skip it (claude-pick loose list)', in: { protectedAccount: 'b', usage: snap({ w: 96 }, { w: 95 }, { w: 99 }) }, account: 'a', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible, excluded has least weekly → skip it', in: { exclude: ['b'], usage: snap({ w: 97 }, { w: 95 }, { w: 96 }) }, account: 'c', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible and nothing in the loose list → b', in: { protectedAccount: 'c', exclude: ['a', 'b'], usage: snap({ w: 97 }, { w: 95 }, { w: 96 }) }, account: 'b', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'no eligible, weekly tie → alphabetical first (claude-pick sorts (w, t))', in: { usage: snap({ w: 96 }, { w: 96 }, { w: 99 }) }, account: 'a', switched: false, reason: /자격 있는 계정 없음/ },
    { name: 'needFable, nobody has room → stay (caller downgrades model)', in: { current: 'a', lastTurnAtMs: NOW - 60_000, needFable: true, usage: snap({ w: 7, f: 85 }, { w: 3, f: 90 }, { w: 91, f: 80 }) }, account: 'a', switched: false, reason: /대안 없음/ },
  ];

  it('I1: no ping-pong when the only alternative is also over its switch threshold', () => {
    const usage = snap({ s: 81, w: 10, resetH: 50 }, { s: 90, w: 10, resetH: 50 }, { s: 10, w: 96, resetH: 50 });
    for (const start of ['a', 'b'] as const) {
      let cur: Account = start;
      const seen: Account[] = [];
      for (let i = 0; i < 6; i++) {
        const d = chooseAccount(input({ current: cur, usage, lastTurnAtMs: NOW - 60_000 }));
        seen.push(d.account);
        cur = d.account;
      }
      expect(seen).toEqual(Array(6).fill(start));
    }
  });

  for (const c of cases) {
    it(c.name, () => {
      const d = chooseAccount(input(c.in));
      expect(d.account).toBe(c.account);
      expect(d.switched).toBe(c.switched);
      expect(d.reason).toMatch(c.reason);
    });
  }
});

describe('chooseAccount · 고정 계정 (pinned)', () => {
  it('pinned and usable: always that account — no warm-cache stickiness, no threshold switching', () => {
    // Warm on B, but pinned to C (C at 91% weekly is past WEEKLY_SWITCH_PCT, still < 95).
    const d = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, pinned: 'c' }));
    expect(d.account).toBe('c');
    expect(d.switched).toBe(true);
    expect(d.pinned).toBe(true);
    expect(d.pinBlocked).toBeUndefined();
    expect(d.reason).toMatch(/고정 C/);
    // Already there: stays, even above the 80/85 thresholds that would force a switch when unpinned.
    const stay = chooseAccount(input({ current: 'c', lastTurnAtMs: NOW - 60_000, pinned: 'c', usage: snap({ w: 7 }, { w: 3 }, { w: 90, s: 85 }) }));
    expect(stay).toMatchObject({ account: 'c', switched: false, pinned: true });
    expect(chooseAccount(input({ current: 'c', lastTurnAtMs: NOW - 60_000, usage: snap({ w: 7 }, { w: 3 }, { w: 90, s: 85 }) })).account).not.toBe('c');
  });

  it('pinned but unusable (≥95 / cooldown / failed this turn): the router picks for this turn and says why', () => {
    const limit = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, pinned: 'b', usage: snap({ w: 7 }, { w: 96 }, { w: 20 }) }));
    expect(limit.account).toBe('a');
    expect(limit.pinned).toBeUndefined();
    expect(limit.pinBlocked).toBe('한도 도달');
    expect(limit.reason).toMatch(/고정 B 주간 96%/);
    const cool = chooseAccount(input({ current: 'b', pinned: 'b', cooldownUntilMs: { b: NOW + 60_000 }, usage: snap({ w: 7 }, { w: 10 }, { w: 20 }) }));
    expect(cool.account).not.toBe('b');
    expect(cool.pinBlocked).toBe('쿨다운 중');
    const failed = chooseAccount(input({ current: 'b', pinned: 'b', exclude: ['b'], usage: snap({ w: 7 }, { w: 10 }, { w: 20 }) }));
    expect(failed.account).not.toBe('b');
    expect(failed.pinBlocked).toBe('이번 턴 실패');
    // Nothing else usable either: stays on the pinned account, no fallback claimed.
    const none = chooseAccount(input({ current: 'b', pinned: 'b', usage: snap({ w: 99 }, { w: 96 }, { w: 98 }) }));
    expect(none.account).toBe('b');
    expect(none.pinBlocked).toBeUndefined();
  });

  it('pinning to the protected account (A, Desktop) is honoured — it is the user\'s explicit choice', () => {
    const d = chooseAccount(input({ current: 'b', lastTurnAtMs: NOW - 60_000, protectedAccount: 'a', pinned: 'a' }));
    expect(d).toMatchObject({ account: 'a', switched: true, pinned: true });
    expect(chooseAccount(input({ current: null, protectedAccount: 'a', pinned: 'a' })).account).toBe('a');
    // Unpinned, a new session never lands on the protected account while others are eligible.
    expect(chooseAccount(input({ current: null, protectedAccount: 'a' })).account).not.toBe('a');
  });
});

describe('chooseAccount · 고르게 분산 (balance)', () => {
  // The reported case: B resets in ~18h with 78% left, C in ~138h with 100% left. Drain sends everything to B.
  const reported = () => snap({ s: 30, w: 40, resetH: 100 }, { s: 10, w: 22, resetH: 18 }, { s: 0, w: 0, resetH: 138 });
  const bal = (over: Partial<RouterInput>) => input({ policy: 'balance', ...over });

  it('is the default when no policy is given', () => {
    const { policy: _p, ...noPolicy } = input({ protectedAccount: 'a', usage: reported() });
    expect(chooseAccount(noPolicy).account).toBe('c');
  });

  it('new session → lowest 5h among safe candidates, and says why', () => {
    const d = chooseAccount(bal({ protectedAccount: 'a', usage: reported() }));
    expect(d.account).toBe('c');
    expect(d.reason).toBe('새 세션 · 분산: 5h C 0% < B 10%');
    // The same input under drain still drains B (resets soonest).
    expect(chooseAccount(input({ protectedAccount: 'a', usage: reported() })).account).toBe('b');
  });

  it('5h within 5 points → lower weekly wins, then the reset-urgency score', () => {
    const w = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 4, w: 30, resetH: 5 }, { s: 8, w: 20, resetH: 150 }) }));
    expect(w.account).toBe('c');
    expect(w.reason).toMatch(/주간 C 20% < B 30%/);
    // 5h and weekly both tied: the account whose weekly resets sooner (higher score) wins.
    const s = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 6, w: 20, resetH: 150 }, { s: 3, w: 20, resetH: 10 }) }));
    expect(s.account).toBe('c');
    const s2 = chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 3, w: 20, resetH: 10 }, { s: 6, w: 20, resetH: 150 }) }));
    expect(s2.account).toBe('b');
    // More than 5 points apart: 5h decides even against a much lower weekly.
    expect(chooseAccount(bal({ usage: snap({ s: 50, w: 10 }, { s: 2, w: 60 }, { s: 8, w: 0 }) })).account).toBe('b');
  });

  it('skips candidates past the force thresholds', () => {
    // B has the lowest 5h but is past the weekly 85 threshold; C is past the 5h 80 threshold.
    const d = chooseAccount(bal({ usage: snap({ s: 40, w: 10 }, { s: 0, w: 90 }, { s: 85, w: 0 }) }));
    expect(d.account).toBe('a');
  });

  it('protected account stays last even with the lowest 5h', () => {
    const { candidates } = rankCandidates(bal({ protectedAccount: 'a', usage: snap({ s: 0, w: 0 }, { s: 40, w: 50 }, { s: 20, w: 60 }) }));
    expect(candidates.map((c) => c.account)).toEqual(['c', 'b', 'a']);
    expect(chooseAccount(bal({ protectedAccount: 'a', usage: snap({ s: 0, w: 0 }, { s: 40, w: 50 }, { s: 20, w: 60 }) })).account).toBe('c');
  });

  it('nothing safe → falls back to the drain ordering', () => {
    // A protected; B over 5h 80; C over weekly 85 → no safe candidate.
    const usage = snap({ s: 0, w: 0 }, { s: 82, w: 10, resetH: 150 }, { s: 0, w: 88, resetH: 10 });
    const b = chooseAccount(bal({ protectedAccount: 'a', usage }));
    const d = chooseAccount(input({ protectedAccount: 'a', usage }));
    expect(b.account).toBe(d.account);
    expect(rankCandidates(bal({ protectedAccount: 'a', usage })).candidates.map((c) => c.account))
      .toEqual(rankCandidates(input({ protectedAccount: 'a', usage })).candidates.map((c) => c.account));
    expect(b.reason).toMatch(/안전한 후보 없음/);
  });

  it('cold session re-routes by the balance policy; a warm one stays', () => {
    const usage = reported();
    const cold = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 2 * H, usage }));
    expect(cold).toMatchObject({ account: 'c', switched: true });
    expect(cold.reason).toMatch(/캐시 식음\(120분 경과\) → C · 분산: 5h C 0% < B 10%/);
    const compacted = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 60_000, justCompacted: true, usage }));
    expect(compacted.account).toBe('c');
    const first = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: null, usage }));
    expect(first.account).toBe('c');
    const warm = chooseAccount(bal({ current: 'b', protectedAccount: 'a', lastTurnAtMs: NOW - 10 * 60_000, usage }));
    expect(warm).toMatchObject({ account: 'b', switched: false });
    expect(warm.reason).toMatch(/캐시 따뜻함/);
  });

  it('forced switches and pins are the same under both policies', () => {
    const usage = snap({ s: 81, w: 10 }, { s: 30, w: 1, resetH: 5 }, { s: 10, w: 50, resetH: 150 });
    const forced = { current: 'a' as const, lastTurnAtMs: NOW - 60_000, usage };
    expect(chooseAccount(bal(forced))).toMatchObject({ account: chooseAccount(input(forced)).account, switched: true });
    const pinned = { current: 'b' as const, lastTurnAtMs: NOW - 60_000, pinned: 'a' as const, usage: reported() };
    expect(chooseAccount(bal(pinned))).toMatchObject({ account: 'a', pinned: true });
  });
});

describe('routeLogLine', () => {
  it('one line: short session id, account, reason, candidates and exclusions', () => {
    const d = chooseAccount(input({ policy: 'balance', protectedAccount: 'a', cooldownUntilMs: { a: NOW + 60_000 }, usage: snap({ s: 0, w: 0 }, { s: 10, w: 22, resetH: 18 }, { s: 0, w: 0, resetH: 138 }) }));
    const line = routeLogLine('0123456789abcdef', d);
    expect(line).toMatch(/^deck: route 01234567 → C \(새 세션 · 분산: 5h C 0% < B 10%\)/);
    expect(line).toMatch(/후보 C 5h 0% · 주간 0%, B 5h 10% · 주간 22%/);
    expect(line).toMatch(/제외 A 쿨다운/);
    expect(line).not.toMatch(/\n/);
    expect(routeLogLine(null, d)).toMatch(/^deck: route 새 세션 → C/);
  });
});
