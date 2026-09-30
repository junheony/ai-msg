import { describe, expect, it } from 'vitest';
import type { Account } from '../../shared/accounts';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import { chooseAccount, rankCandidates, type RouterInput } from './AccountRouter';

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
