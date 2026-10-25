import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEntry } from '../shared/session-types';
import type { UsageRow } from '../shared/token-usage';
import type { GrokUsage } from '../shared/usage-types';
import { agoParts, cachedJson, clearHomeCache, historyRows, homeLists, providerRows, providerState, recentByProject, setupEngines, untilParts, usageTotals } from './home';
import type { UsageSnapshot } from '../shared/usage-types';

const sess = (sessionId: string, lastModified: number, extra: Record<string, unknown> = {}) =>
  ({ sessionId, account: 'a', cwd: '/w/app', projectDir: '/p', file: '/f', title: `t-${sessionId}`, lastModified, sizeBytes: 1, ...extra });
const projects = [
  { cwd: '/w/app', name: 'app', pinned: false, sessions: [sess('a', 50), sess('b', 40), sess('g', 30, { account: 'gpt', engine: 'codex' }), sess('old', 5, { archived: true })] },
  { cwd: '/w/site', name: 'site', pinned: false, sessions: [sess('s1', 45, { cwd: '/w/site' }), sess('s2', 10, { cwd: '/w/site' })] },
] as unknown as ProjectEntry[];
const act = (sessionId: string, running: boolean, bg = 0, forMs = 0) => ({ sessionId, cwd: '/w/app', turnId: 't', running, bg, forMs });

describe('homeLists', () => {
  it('waiting: permissions then questions, one per session, prompts without a session left out', () => {
    const { waiting } = homeLists({
      projects,
      pending: [{ sessionId: 'a', cwd: '/w/app', toolName: 'Bash' }, { sessionId: 'a', cwd: '/w/app', toolName: 'Edit' }, { sessionId: null, cwd: '/w/app', toolName: 'Bash' }],
      questions: [{ sessionId: 's1', cwd: '/w/site', questions: [{ header: 'Scope', question: 'Which one?' }] }],
    });
    expect(waiting.map((w) => [w.sessionId, w.kind, w.detail, w.title, w.project])).toEqual([
      ['a', 'permission', 'Bash', 't-a', 'app'],
      ['s1', 'question', 'Scope', 't-s1', 'site'],
    ]);
  });

  it('running: running or background work, waiting sessions excluded, running before background, longest first', () => {
    const { running } = homeLists({
      projects,
      activity: [act('a', true, 0, 9), act('b', false, 2), act('g', true, 0, 50), act('s1', true, 0, 99), act('s2', false, 0)],
      pending: [{ sessionId: 's1', cwd: '/w/site', toolName: 'Bash' }],
    });
    expect(running.map((r) => r.sessionId)).toEqual(['g', 'a', 'b']);
    expect(running.find((r) => r.sessionId === 'g')?.engine).toBe('codex');
  });

  it('unread: not waiting or running, newest first; an unknown session is named by its id', () => {
    const { unread } = homeLists({ projects, activity: [act('a', true)], unread: ['s2', 'a', 'b', 'zzzzzzzz-1234'] });
    expect(unread.map((u) => [u.sessionId, u.title])).toEqual([['b', 't-b'], ['s2', 't-s2'], ['zzzzzzzz-1234', 'zzzzzzzz']]);
  });

  it('a session not listed yet takes its folder name', () => {
    const { running } = homeLists({ projects: [], activity: [{ ...act('new', true), cwd: '/w/fresh' }] });
    expect(running[0]).toMatchObject({ title: 'fresh', project: 'fresh', engine: 'claude' });
  });
});

describe('recentByProject', () => {
  it('newest live sessions grouped by project, excluded ones skipped, capped', () => {
    const groups = recentByProject(projects, new Set(['a']), 3);
    expect(groups.map((g) => [g.project, g.items.map((i) => i.sessionId)])).toEqual([['site', ['s1']], ['app', ['b', 'g']]]);
  });

  it('archived sessions never show', () => {
    expect(recentByProject(projects, new Set(), 99).flatMap((g) => g.items.map((i) => i.sessionId))).not.toContain('old');
  });
});

describe('usageTotals', () => {
  const row = (day: string, family: UsageRow['family'], input: number, messages: number, source: UsageRow['source'] = 'all'): UsageRow =>
    ({ day, source, family, input, output: 0, cacheRead: 0, cacheWrite: 0, messages });
  // 2026-10-25 is a Sunday: its week started Monday 2026-10-19.
  const rows = [
    row('2026-10-25', 'opus', 1_000_000, 3),
    row('2026-10-25', 'gpt', 500, 2),
    row('2026-10-25', 'opus', 999, 9, 'a'), // per-account copy: never counted
    row('2026-10-20', 'sonnet', 1_000_000, 4),
    row('2026-10-18', 'opus', 7, 7), // last week
  ];
  const grok = { x1: { today: { inputTokens: 100, outputTokens: 20, turns: 1, day: '2026-10-25' } } as GrokUsage };

  it('today: Claude priced, Codex and Grok counted without cost', () => {
    const t = usageTotals(rows, grok, 'today', '2026-10-25');
    expect(t.cost).toBeCloseTo(4); // Opus input $4 / MTok
    expect(t.tokens).toBe(1_000_000 + 500 + 120);
    expect(t.messages).toBe(3 + 2 + 1);
    expect(t.byEngine.map((e) => e.engine)).toEqual(['claude', 'codex', 'grok']);
  });

  it('week: from Monday, Grok left out (today only)', () => {
    const t = usageTotals(rows, grok, 'week', '2026-10-25');
    expect(t.tokens).toBe(2_000_000 + 500);
    expect(t.cost).toBeCloseTo(4 + 2);
    expect(t.byEngine.map((e) => e.engine)).toEqual(['claude', 'codex']);
  });

  it("a Grok count from another day and missing rows read as nothing", () => {
    const stale = { x1: { today: { inputTokens: 5, outputTokens: 5, turns: 1, day: '2026-10-24' } } as GrokUsage };
    expect(usageTotals(undefined, stale, 'today', '2026-10-25')).toEqual({ cost: 0, tokens: 0, messages: 0, byEngine: [] });
  });
});

describe('providerState', () => {
  it('reads the setup probe', () => {
    expect(providerState({ bin: '/b', login: 'yes' })).toBe('ready');
    expect(providerState({ bin: '/b', login: 'no' })).toBe('needs-login');
    expect(providerState({ bin: '/b', login: 'unknown' })).toBe('unknown');
    expect(providerState({ bin: null, login: 'yes' })).toBe('unavailable');
  });
  it('falls back to what hello says, else unknown', () => {
    expect(providerState(null, { installed: false })).toBe('unavailable');
    expect(providerState(null, { installed: true })).toBe('unknown');
    expect(providerState(null, { installed: true, login: 'yes' })).toBe('ready');
    expect(providerState(null)).toBe('unknown');
  });
});

describe('agoParts', () => {
  it('picks the unit', () => {
    expect(agoParts(0, 30_000)).toEqual({ unit: 'now', n: 0 });
    expect(agoParts(0, 5 * 60_000)).toEqual({ unit: 'minutes', n: 5 });
    expect(agoParts(0, 3 * 3_600_000)).toEqual({ unit: 'hours', n: 3 });
    expect(agoParts(0, 2 * 86_400_000)).toEqual({ unit: 'days', n: 2 });
  });
});

describe('cachedJson', () => {
  beforeEach(clearHomeCache);
  const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it('reuses an answer for ~50 s and shares an ask in flight', async () => {
    const f = vi.fn(() => ok({ n: 1 }));
    const [a, b] = await Promise.all([cachedJson('/x', f as unknown as typeof fetch), cachedJson('/x', f as unknown as typeof fetch)]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(await cachedJson('/x', f as unknown as typeof fetch)).toEqual({ n: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    // Younger than the home's 60 s refresh, so every refresh tick really asks again.
    expect(await cachedJson('/x', f as unknown as typeof fetch, Date.now() + 51_000)).toEqual({ n: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a failure is null and asks again next time', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('no', { status: 500 })));
    expect(await cachedJson('/y', f as unknown as typeof fetch)).toBeNull();
    expect(await cachedJson('/y', f as unknown as typeof fetch)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('malformed answers read as missing', () => {
    expect(setupEngines({} as never)).toBeNull();
    expect(historyRows({} as never)).toBeNull();
    expect(historyRows({ rows: [] } as never)).toEqual([]);
  });
});

describe('providerRows', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const win = (usedPct: number) => ({ usedPct, resetsAt: '2026-10-28T00:00:00Z' });
  const acct = (weekly: ReturnType<typeof win> | null) => ({ status: 'ok', fetchedAt: null, fiveHour: null, weekly, fable: null });
  it('one row per Claude account (its letter), GPT weekly, the fullest Gemini bucket, Grok tier and Grok Bot plan', () => {
    const usage = {
      accounts: { a: acct(win(30)), b: acct(null) },
      gpt: acct(win(80)),
      geminiSeats: { g1: { status: 'ok', fetchedAt: null, loggedIn: true, buckets: [{ name: 'Flash', usedPct: 10, resetsAt: null }, { name: 'Pro', usedPct: 60, resetsAt: null }] } },
      grokSeats: { x1: { billing: { usedPct: 12, windowStart: null, windowEnd: '2026-10-30T00:00:00Z', tier: 'SuperGrok', fetchedAt: '2026-10-25T00:00:00Z' } } },
      grokBot: { percentUsed: 40, nextResetMs: null, planLabel: 'Heavy', readAtMs: now },
    } as unknown as UsageSnapshot;
    const r = providerRows(usage, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], now);
    expect(r.claude.rows.map((x) => [x.label, x.w?.usedPct ?? null])).toEqual([['A', 30], ['B', null]]);
    expect(r.codex.rows.map((x) => x.w?.usedPct)).toEqual([80]);
    expect(r.gemini.rows.map((x) => [x.label, x.w?.usedPct])).toEqual([['Pro', 60]]);
    expect(r.grok.plan).toBe('SuperGrok');
    expect(r.grok.rows.map((x) => [x.label, x.w?.usedPct])).toEqual([[null, 12], ['Grok Bot · Heavy', 40]]);
  });
  it('no snapshot: no rows, no plan', () => {
    expect(providerRows(null, [{ id: 'a', label: 'A' }], now).claude).toEqual({ rows: [], plan: null });
  });
});

describe('untilParts', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  it('minutes, hours under two days, then days; past or missing is null', () => {
    expect(untilParts('2026-10-25T12:30:00Z', now)).toEqual({ unit: 'minutes', n: 30 });
    expect(untilParts('2026-10-26T20:00:00Z', now)).toEqual({ unit: 'hours', n: 32 });
    expect(untilParts('2026-10-29T12:00:00Z', now)).toEqual({ unit: 'days', n: 4 });
    expect(untilParts('2026-10-24T12:00:00Z', now)).toBeNull();
    expect(untilParts(null, now)).toBeNull();
  });
});
