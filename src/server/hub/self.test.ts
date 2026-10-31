import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../shared/session-types';
import type { UsageSnapshot } from '../../shared/usage-types';
import { HUB_SELF_RECENT, hubSelfOf, seatsOf } from './self';

const NOW = Date.parse('2026-10-30T13:00:00Z');
const accounts = { list: () => ['a', 'b'], label: (id: string) => ({ a: 'Claude A', b: 'Claude B' })[id] ?? id.toUpperCase() };
const entry = (o: Partial<SessionEntry>): SessionEntry => ({ sessionId: 's', account: 'a', cwd: '/Users/alice/dev/proj', projectDir: '/Users/alice/.claude/projects/x', file: '/Users/alice/.claude/projects/x/s.jsonl', title: 't', lastModified: NOW - 1000, sizeBytes: 1, ...o });
const win = (usedPct: number, resetsAt = '2026-10-30T15:00:00Z') => ({ usedPct, resetsAt });
const snap = (o: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ generatedAt: new Date(NOW).toISOString(), deckReachable: true, accounts: { a: { status: 'ok', fetchedAt: null, fiveHour: win(12.4), weekly: win(40), fable: win(3) } }, ...o });

describe('hubSelfOf', () => {
  it('lists the newest sessions first with running ones on top, as project names and seat labels, never ids or paths', () => {
    const sessions = [
      entry({ sessionId: 'old', title: 'old work', lastModified: NOW - 3 * 86_400_000 }),
      entry({ sessionId: 'run', title: '/hub continue', lastModified: NOW - 9_000_000, cwd: '/home/max/ai-msg-hub3', account: 'b' }),
      entry({ sessionId: 'gpt', title: 'codex thread', engine: 'codex', account: 'gpt', cwd: '/Users/alice/arbitrage-nexus', lastModified: NOW - 500 }),
      entry({ sessionId: 'arch', title: 'archived', archived: true }),
      entry({ sessionId: 'hl', title: 'ocr', headless: true }),
      entry({ sessionId: 'g2', engine: 'gemini', account: 'g2', title: 'gem', lastModified: NOW - 5000 }),
    ];
    const self = hubSelfOf({ startedAt: NOW - 60_000, sessions: () => sessions, running: () => [{ turnId: 't', sessionId: 'run', cwd: '/home/max/ai-msg-hub3' }], activeTurns: () => 1, usage: () => snap(), accounts, now: () => NOW });
    expect(self.uptimeMs).toBe(60_000);
    expect(self.sessions).toBe(4);
    expect(self.activeTurns).toBe(1);
    expect(self.active24h).toBe(3);
    expect(self.recent!.map((r) => [r.project, r.seat, r.engine, r.running])).toEqual([['ai-msg-hub3', 'Claude B', 'claude', true], ['arbitrage-nexus', 'GPT', 'codex', false], ['proj', 'Gemini 2', 'gemini', false], ['proj', 'Claude A', 'claude', false]]);
    expect(JSON.stringify(self.recent)).not.toMatch(/sessionId|\/Users\/|\/home\//);
    expect(self.seats!.map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ sessionId: `s${i}`, lastModified: NOW - i * 1000 }));
    const self = hubSelfOf({ startedAt: NOW, sessions: () => many, running: () => [], activeTurns: () => 0, usage: () => snap(), accounts, now: () => NOW });
    expect(self.recent!.length).toBe(HUB_SELF_RECENT);
    expect(self.sessions).toBe(40);
  });
  it('a usage reader that throws leaves seats out instead of failing the page', () => {
    const self = hubSelfOf({ startedAt: NOW, sessions: () => [], running: () => [], activeTurns: () => 0, usage: () => { throw new Error('boom'); }, accounts, now: () => NOW });
    expect(self.seats).toBeUndefined();
    expect(self.recent).toEqual([]);
  });
});

describe('seatsOf', () => {
  it('one row per Claude account (missing = empty), GPT with credits, Gemini seats with login state and buckets, Grok with billing', () => {
    const seats = seatsOf(snap({
      gpt: { status: 'stale', fetchedAt: null, fiveHour: win(0), weekly: win(100.4), fable: null, credits: { hasCredits: true, unlimited: false, balance: 12 } },
      geminiSeats: { g1: { status: 'down', fetchedAt: null, loggedIn: false, buckets: [], error: 'not logged in' }, g2: { status: 'ok', fetchedAt: null, loggedIn: true, buckets: [{ name: 'flash', usedPct: 3, resetsAt: null }, { name: 'pro', usedPct: 42.6, resetsAt: '2026-10-31T00:00:00Z' }] } },
      grokSeats: { x1: { status: 'down', lastTurnAt: null, lastError: 'auth', cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 2, day: '2026-10-30' }, billing: { usedPct: 7.2, windowStart: null, windowEnd: '2026-11-03T00:00:00Z', tier: 'SuperGrok', fetchedAt: 'x' } } },
    }), accounts);
    expect(seats.map((s) => [s.id, s.label, s.status, s.fiveHour, s.weekly, s.fable])).toEqual([
      ['a', 'Claude A', 'ok', 12, 40, 3], ['b', 'Claude B', 'down', null, null, null], ['gpt', 'GPT', 'stale', 0, 100, null],
      ['g1', 'Gemini', 'login', null, null, null], ['g2', 'Gemini 2', 'ok', null, 43, null], ['x1', 'Grok', 'login', null, 7, null],
    ]);
    expect(seats[2]!.note).toBe('크레딧 12');
    expect(seats[3]!.note).toBe('로그인 필요 (agy)');
    expect(seats[4]!.note).toBe('pro 43% · flash 3%');
    expect(seats[4]!.weeklyResetsAt).toBe('2026-10-31T00:00:00Z');
    expect(seats[5]!.note).toBe('인증 실패 — 재로그인 · SuperGrok · 오늘 2턴');
  });
  it('leaves out seats the snapshot does not carry', () => {
    expect(seatsOf(snap(), accounts).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
