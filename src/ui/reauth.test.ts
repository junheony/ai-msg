import { describe, expect, it } from 'vitest';
import type { SetupStatus } from '../shared/setup-types';
import type { UsageSnapshot } from '../shared/usage-types';
import { geminiLoggedOut, reauthSeats, reauthWithUsage } from './reauth';

const status = (over: Partial<SetupStatus> = {}): SetupStatus => ({
  engines: [
    { engine: 'claude', bin: '/bin/claude', version: '1', login: 'yes', loginCommand: 'claude auth login' },
    { engine: 'codex', bin: '/bin/codex', version: '1', login: 'no', loginCommand: 'codex login' },
    { engine: 'gemini', bin: '/bin/agy', version: '1', login: 'no', loginCommand: 'agy' },
    { engine: 'grok', bin: null, version: null, login: 'no', loginCommand: 'grok login' },
  ],
  claudeProfiles: [
    { id: 'a', label: 'A', dir: '~/.claude', home: true, active: true, login: 'yes', loginCommand: 'claude auth login' },
    { id: 'b', label: 'B', dir: '~/.claude-b', home: false, active: true, login: 'no', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-b claude auth login' },
    { id: 'c', label: 'C', dir: '~/.claude-c', home: false, active: false, login: 'no', loginCommand: 'CLAUDE_CONFIG_DIR=~/.claude-c claude auth login' },
  ],
  addresses: [], needed: false, supervised: false, restartNeeded: false, accountsFile: true, checkedAt: 't',
  ...over,
});

describe('reauthSeats', () => {
  it('lists logged-out Claude profiles and Codex; skips a missing grok binary, a retired profile and Gemini without a per-seat probe', () => {
    expect(reauthSeats(status())).toEqual(['b', 'gpt']);
  });

  it('offers re-login for a logged-out Grok binary and each logged-out agy seat', () => {
    const engines = status().engines.map((e) => e.engine === 'grok' ? { ...e, bin: '/bin/grok', login: 'no' as const } : e);
    const seats = reauthSeats(status({
      engines,
      geminiSeats: [
        { id: 'g1', label: 'G1', dir: '~/.gemini/antigravity-cli', login: 'no', loginCommand: 'agy' },
        { id: 'g2', label: 'G2', dir: '~/.agy-g2/.gemini/antigravity-cli', login: 'yes', loginCommand: 'HOME=~/.agy-g2 agy' },
      ],
    }));
    expect(seats).toEqual(['b', 'gpt', 'x1', 'g1']);
  });
});

describe('reauthWithUsage', () => {
  it('adds x1 when the billing poller marked Grok logged out, and does not duplicate a setup hit', () => {
    const usage = { grokSeats: { x1: { status: 'down', lastTurnAt: null, lastError: 'auth', cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '' } } } } as UsageSnapshot;
    expect(reauthWithUsage(['b'], usage)).toEqual(['b', 'x1']);
    expect(reauthWithUsage(['x1'], usage)).toEqual(['x1']);
    expect(reauthWithUsage(['b'], { grokSeats: { x1: { status: 'unknown', lastTurnAt: null, lastError: null, cooldownUntil: null, today: { inputTokens: 0, outputTokens: 0, turns: 0, day: '' } } } } as UsageSnapshot)).toEqual(['b']);
  });

  it('adds each Gemini seat whose usage poll found no Google login (g1 / g2 separately; an old snapshot\'s `gemini` is g1); a read failure while logged in is not a login problem', () => {
    const out = { status: 'down' as const, fetchedAt: null, loggedIn: false, buckets: [], error: 'Gemini 로그인 필요 — 사용량에서 재로그인' };
    const ok = { status: 'ok' as const, fetchedAt: 't', loggedIn: true, buckets: [{ name: 'Gemini · 5h', usedPct: 3, resetsAt: null }] };
    const snap = (over: Partial<UsageSnapshot>): UsageSnapshot => ({ generatedAt: 'x', deckReachable: true, accounts: {}, ...over });
    expect(reauthWithUsage([], snap({ geminiSeats: { g1: out, g2: ok } }))).toEqual(['g1']);
    expect(reauthWithUsage(['gpt'], snap({ geminiSeats: { g1: ok, g2: out } }))).toEqual(['gpt', 'g2']);
    expect(reauthWithUsage(['g1'], snap({ geminiSeats: { g1: out, g2: out } }))).toEqual(['g1', 'g2']);
    expect(reauthWithUsage([], snap({ gemini: out }))).toEqual(['g1']);
    expect(reauthWithUsage([], snap({ geminiSeats: { g1: ok, g2: ok } }))).toEqual([]);
    expect(reauthWithUsage([], null)).toEqual([]);
    // Down while logged in (agy answered, the answer did not parse): no login button for that.
    expect(geminiLoggedOut({ status: 'down', fetchedAt: null, loggedIn: true, buckets: [], error: '사용량 응답을 해석하지 못했습니다' })).toBe(false);
    // Down with an auth error in the reason: it is.
    expect(geminiLoggedOut({ status: 'down', fetchedAt: null, loggedIn: true, buckets: [], error: 'Authentication required' })).toBe(true);
    expect(geminiLoggedOut({ ...ok, status: 'stale', error: 'agy /usage 실패 (exit 1)' })).toBe(false);
    expect(geminiLoggedOut(undefined)).toBe(false);
  });
});
