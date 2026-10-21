import { describe, expect, it } from 'vitest';
import { testRegistry } from '../../shared/accounts.testkit';
import type { UsageSnapshot } from '../../shared/usage-types';
import { OBSERVATION_MAX_MS, chooseRoute, engineState } from './AutoRoute';
import { buildEngineLimits, geminiGroupOf, type EngineLimitsInput } from './engineLimits';

const NOW = Date.parse('2026-10-18T03:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function input(usage: Partial<UsageSnapshot> = {}, over: Partial<EngineLimitsInput> = {}): EngineLimitsInput {
  return {
    usage: { generatedAt: iso(NOW), deckReachable: true, accounts: {}, ...usage },
    nowMs: NOW,
    claude: { cooldownUntilMs: {}, protectedAccount: null, accounts: testRegistry() },
    codex: { installed: true, cooldownUntilMs: null },
    gemini: { installed: true, loggedIn: { g1: true, g2: false }, cooldownUntilMs: {} },
    grok: { installed: true, cooldownUntilMs: null, lastError: null },
    ...over,
  };
}

const gpt = (usedPct: number, ageMs: number, status: 'ok' | 'stale' | 'down' = 'ok') => ({
  status, fetchedAt: iso(NOW - ageMs), fiveHour: null, fable: null, weekly: { usedPct, resetsAt: '2026-10-20T00:00:00Z' },
});
const gemini = (ageMs: number, buckets: { name: string; usedPct: number }[]) => ({
  status: 'ok' as const, fetchedAt: iso(NOW - ageMs), loggedIn: true, buckets: buckets.map((b) => ({ ...b, resetsAt: null })),
});

describe('buildEngineLimits', () => {
  it('empty snapshot: GPT and Gemini numbers unknown, nothing invented', () => {
    const l = buildEngineLimits(input());
    expect(l.codex).toEqual({ installed: true, weeklyUsedPct: null, weeklyResetsAtMs: null, observedAtMs: null, cooldownUntilMs: null });
    expect(l.gemini.observedAtMs).toBeNull();
    expect(l.gemini.seats[0]!.remainingPct).toEqual({ pro: null, flash: null });
    expect(engineState('codex', 'gpt-6-sol', l, NOW).state).toBe('unknown');
    expect(engineState('gemini', 'gemini-pro', l, NOW).state).toBe('unknown');
    expect(l.grok).toEqual({ installed: true, cooldownUntilMs: null, lastError: null, periodUsedPct: null, periodResetsAtMs: null });
  });

  it('Grok: the subscription used % from grokSeats.x1.billing; 85 %+ blocks until the period ends', () => {
    const billing = (usedPct: number, endMs: number) => ({ usedPct, windowStart: iso(endMs - 7 * 86_400_000), windowEnd: iso(endMs), tier: 'SuperGrok Heavy', fetchedAt: iso(NOW - 60_000) });
    const seat = (usedPct: number, endMs: number) => ({ x1: { status: 'ok' as const, lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '2026-10-18' }, billing: billing(usedPct, endMs) } });
    const low = buildEngineLimits(input({ grokSeats: seat(1, NOW + 86_400_000) }));
    expect(low.grok.periodUsedPct).toBe(1);
    expect(low.grok.periodResetsAtMs).toBe(NOW + 86_400_000);
    expect(engineState('grok', 'grok-4.7', low, NOW)).toMatchObject({ state: 'ok', why: 'Grok 구독 99% 남음' });
    const high = buildEngineLimits(input({ grokSeats: seat(90, NOW + 86_400_000) }));
    expect(engineState('grok', 'grok-4.7', high, NOW)).toMatchObject({ state: 'blocked', why: 'Grok 구독 10% 남음' });
    // The period ended since the reading: a new period, not judged on the old number.
    const ended = buildEngineLimits(input({ grokSeats: seat(90, NOW - 1) }));
    expect(ended.grok.periodUsedPct).toBeNull();
    expect(engineState('grok', 'grok-4.7', ended, NOW).state).toBe('ok');
  });

  it('review item 3: a cached reading with no windowEnd goes stale (null) after 24 hours', () => {
    const billing = (fetchedAgoMs: number) => ({
      usedPct: 90, windowStart: null, windowEnd: null, tier: 'SuperGrok Heavy', fetchedAt: iso(NOW - fetchedAgoMs),
    });
    const seat = (fetchedAgoMs: number) => ({ x1: { status: 'ok' as const, lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '2026-10-18' }, billing: billing(fetchedAgoMs) } });
    const fresh = buildEngineLimits(input({ grokSeats: seat(60_000) }));
    expect(fresh.grok.periodUsedPct).toBe(90);
    expect(engineState('grok', 'grok-4.7', fresh, NOW).state).toBe('blocked');
    const stale = buildEngineLimits(input({ grokSeats: seat(25 * 3600_000) }));
    expect(stale.grok.periodUsedPct).toBeNull();
    expect(stale.grok.periodResetsAtMs).toBeNull();
    expect(engineState('grok', 'grok-4.7', stale, NOW).state).toBe('ok');
  });

  it('GPT weekly, reset and observation time come from the snapshot; down = unknown', () => {
    const l = buildEngineLimits(input({ gpt: gpt(30, 60_000) }));
    expect(l.codex.weeklyUsedPct).toBe(30);
    expect(l.codex.weeklyResetsAtMs).toBe(Date.parse('2026-10-20T00:00:00Z'));
    expect(l.codex.observedAtMs).toBe(NOW - 60_000);
    const down = buildEngineLimits(input({ gpt: gpt(30, 60_000, 'down') }));
    expect(down.codex.observedAtMs).toBeNull();
    expect(down.codex.weeklyUsedPct).toBeNull();
  });

  it('stale observation: older than OBSERVATION_MAX_MS reads as unknown', () => {
    const old = OBSERVATION_MAX_MS + 60_000;
    const l = buildEngineLimits(input({ gpt: gpt(10, old), gemini: gemini(old, [{ name: 'Argon · 주간', usedPct: 10 }]) }));
    expect(engineState('codex', 'gpt-6-sol', l, NOW)).toMatchObject({ state: 'unknown' });
    expect(engineState('gemini', 'gemini-pro', l, NOW)).toMatchObject({ state: 'unknown' });
  });

  it('Gemini buckets → pro/flash remaining (worst window), other groups ignored', () => {
    const l = buildEngineLimits(input({ gemini: gemini(60_000, [
      { name: 'Argon · 주간', usedPct: 20 }, { name: 'Argon · 5h', usedPct: 70 },
      { name: 'Gemini · 주간', usedPct: 5 }, { name: 'Claude · 주간', usedPct: 99 },
    ]) }));
    expect(l.gemini.seats[0]!.remainingPct).toEqual({ pro: 30, flash: 95 });
    expect(engineState('gemini', 'gemini-pro', l, NOW)).toMatchObject({ state: 'ok', why: 'Gemini Pro 30% 남음' });
  });

  it('review #7: Pro remaining = min(Argon bucket, the shared "Gemini" (agy\'s Gemini Models) bucket) — the big bucket can be the tighter cap', () => {
    const l = buildEngineLimits(input({ gemini: gemini(60_000, [
      { name: 'Argon · 주간', usedPct: 5 }, { name: 'Gemini · 주간', usedPct: 60 },
    ]) }));
    // Argon alone would say 95% left; the shared bucket (both Pro and Flash draw from it) is down to 40% — Pro is capped there too.
    expect(l.gemini.seats[0]!.remainingPct).toEqual({ pro: 40, flash: 40 });
  });

  it('review #7 fixture: agy-1.4.2 usage.json parsed end to end into engineLimits — Argon tighter than the shared bucket', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { parseGeminiUsage } = await import('../usage/GeminiUsagePoller');
    const raw = await fs.readFile(path.join(import.meta.dirname, '../engine/fixtures/agy-1.4.2/usage.json'), 'utf8');
    const buckets = parseGeminiUsage(raw, NOW);
    const l = buildEngineLimits(input({ gemini: { status: 'ok', fetchedAt: iso(NOW), loggedIn: true, buckets } }));
    // Fixture: Argon weekly 98% remaining, Gemini Models weekly/5h 100% remaining → Pro = min(98, 100) = 98.
    expect(l.gemini.seats[0]!.remainingPct.pro).toBe(98);
    expect(l.gemini.seats[0]!.remainingPct.flash).toBe(100);
  });

  it('cooldowns: Claude, GPT and Grok pass through; a Gemini seat in cooldown counts as 0 %', () => {
    const l = buildEngineLimits(input({ gemini: gemini(60_000, [{ name: 'Argon · 주간', usedPct: 10 }]) }, {
      claude: { cooldownUntilMs: { a: NOW + 1000 }, protectedAccount: null, accounts: testRegistry() },
      codex: { installed: true, cooldownUntilMs: NOW + 1000 },
      gemini: { installed: true, loggedIn: { g1: true, g2: false }, cooldownUntilMs: { g1: NOW + 1000 } },
      grok: { installed: true, cooldownUntilMs: NOW + 1000, lastError: 'auth' },
    }));
    expect(l.claude.cooldownUntilMs).toEqual({ a: NOW + 1000 });
    expect(engineState('codex', 'gpt-6-sol', l, NOW).state).toBe('blocked');
    expect(l.gemini.seats[0]!.remainingPct).toEqual({ pro: 0, flash: 0 });
    expect(engineState('gemini', 'gemini-pro', l, NOW).state).toBe('blocked');
    expect(engineState('grok', 'grok-4.7', l, NOW).state).toBe('blocked');
  });

  it('G2 not logged in: disabled; logged in: enabled with no numbers of its own', () => {
    const off = buildEngineLimits(input());
    expect(off.gemini.loggedIn).toBe(true);
    expect(off.gemini.seats.map((s) => [s.seat, s.enabled])).toEqual([['g1', true], ['g2', false]]);
    const on = buildEngineLimits(input({}, { gemini: { installed: true, loggedIn: { g1: false, g2: true }, cooldownUntilMs: {} } }));
    expect(on.gemini.seats[1]).toEqual({ seat: 'g2', enabled: true, remainingPct: { pro: null, flash: null } });
    const none = buildEngineLimits(input({}, { gemini: { installed: false, loggedIn: { g1: false, g2: false }, cooldownUntilMs: {} } }));
    expect(none.gemini).toMatchObject({ installed: false, loggedIn: false });
  });

  it('feeds chooseRoute (full auto, consented Gemini on an easy explain turn)', () => {
    const l = buildEngineLimits(input({ gemini: gemini(60_000, [{ name: 'Gemini · 주간', usedPct: 10 }]) }));
    const d = chooseRoute({ text: '이 함수 뭐야?', images: 0, engine: 'auto', model: 'auto', limits: l, nowMs: NOW, cwdInsideHome: true, autoEngines: ['gemini'], consented: ['gemini'] });
    expect(d).toMatchObject({ kind: 'route', engine: 'gemini', model: 'gemini-flash' });
  });

  it('review #6: G1 쿨다운(0%) + G2 로그인(숫자 없음, 쿨다운 아님) → unknown, not blocked', () => {
    const l = buildEngineLimits(input({ gemini: gemini(60_000, [{ name: 'Argon · 주간', usedPct: 10 }]) }, {
      gemini: { installed: true, loggedIn: { g1: true, g2: true }, cooldownUntilMs: { g1: NOW + 1000 } },
    }));
    expect(l.gemini.seats[0]!.remainingPct).toEqual({ pro: 0, flash: 0 });
    expect(l.gemini.seats[1]!.remainingPct).toEqual({ pro: null, flash: null });
    expect(engineState('gemini', 'gemini-pro', l, NOW).state).toBe('unknown');
  });

  it('geminiGroupOf', () => {
    expect(geminiGroupOf('Argon · 주간')).toBe('pro');
    expect(geminiGroupOf('Gemini · 5h')).toBe('flash');
    expect(geminiGroupOf('Flash family')).toBe('flash');
    expect(geminiGroupOf('GPT · 주간')).toBeNull();
  });
});
