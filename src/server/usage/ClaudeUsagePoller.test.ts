import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_USAGE_ARGS, ClaudeUsagePoller, parseClaudeReset, parseClaudeUsage, parseClaudeUsageText } from './ClaudeUsagePoller';
import { UsageService, type FetchLike } from './UsageService';
import type { ChildLike, SpawnFn } from '../engine/CodexEngine';
import { testRegistry } from '../../shared/accounts.testkit';
import { usageOf, type UsageSnapshot } from '../../shared/usage-types';

/** 2026-10-22 12:00 in Seoul. */
const NOW = Date.parse('2026-10-22T03:00:00.000Z');

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 90% used · resets Oct 23 at 5:59pm (Asia/Seoul)
Current week (Fable): 87% used · resets Oct 23 at 5:59pm (Asia/Seoul)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai
`;

describe('parseClaudeReset', () => {
  it('a date and a time, in the zone in brackets', () => {
    expect(parseClaudeReset('Oct 23 at 5:59pm (Asia/Seoul)', NOW)).toBe('2026-10-23T08:59:00.000Z');
    expect(parseClaudeReset('Oct 23 at 5:59pm (America/New_York)', NOW)).toBe('2026-10-23T21:59:00.000Z');
    expect(parseClaudeReset('Nov 3 at 9am (America/New_York)', NOW)).toBe('2026-11-03T14:00:00.000Z'); // after DST ends
  });

  it('a time only (minutes or not): today, or tomorrow once it has passed', () => {
    expect(parseClaudeReset('5:59pm (Asia/Seoul)', NOW)).toBe('2026-10-22T08:59:00.000Z');
    expect(parseClaudeReset('3pm (Asia/Seoul)', NOW)).toBe('2026-10-22T06:00:00.000Z');
    expect(parseClaudeReset('11am (Asia/Seoul)', NOW)).toBe('2026-10-23T02:00:00.000Z');
    expect(parseClaudeReset('12am (Asia/Seoul)', NOW)).toBe('2026-10-22T15:00:00.000Z');
    expect(parseClaudeReset('12pm (UTC)', NOW)).toBe('2026-10-22T12:00:00.000Z');
  });

  it('across the year end: a date already past is next year, a time past midnight is the next year’s day', () => {
    const dec30 = Date.parse('2026-12-30T05:00:00.000Z'); // Seoul Dec 30 14:00
    expect(parseClaudeReset('Jan 2 at 9am (Asia/Seoul)', dec30)).toBe('2027-01-02T00:00:00.000Z');
    expect(parseClaudeReset('Dec 31 at 9am (Asia/Seoul)', dec30)).toBe('2026-12-31T00:00:00.000Z');
    const dec31late = Date.parse('2026-12-31T14:30:00.000Z'); // Seoul Dec 31 23:30
    expect(parseClaudeReset('1am (Asia/Seoul)', dec31late)).toBe('2026-12-31T16:00:00.000Z');
  });

  it('unreadable → null', () => {
    expect(parseClaudeReset('Oct 23 at 5:59pm (Mars/Olympus)', NOW)).toBeNull();
    expect(parseClaudeReset('soon', NOW)).toBeNull();
    expect(parseClaudeReset('13pm (Asia/Seoul)', NOW)).toBeNull();
    expect(parseClaudeReset('Foo 3 at 1pm (Asia/Seoul)', NOW)).toBeNull();
    expect(parseClaudeReset('5:59pm', NOW)).toBeNull();
  });
});

describe('parseClaudeUsage', () => {
  it('the real /usage text: session → 5h, all models → weekly, Fable → fable', () => {
    expect(parseClaudeUsageText(SAMPLE, NOW)).toEqual({
      fiveHour: { usedPct: 0, resetsAt: null },
      weekly: { usedPct: 90, resetsAt: '2026-10-23T08:59:00.000Z' },
      fable: { usedPct: 87, resetsAt: '2026-10-23T08:59:00.000Z' },
    });
  });

  it('inside the json result; a session reset with a time only; Opus → fable, other models ignored', () => {
    const text = 'Current session: 12% used · resets 3pm (Asia/Seoul)\nCurrent week (Sonnet only): 4% used\nCurrent week (Opus): 40% used · resets Oct 25 at 10am (Asia/Seoul)\n';
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, result: text });
    expect(parseClaudeUsage(out, NOW)).toEqual({
      fiveHour: { usedPct: 12, resetsAt: '2026-10-22T06:00:00.000Z' },
      fable: { usedPct: 40, resetsAt: '2026-10-25T01:00:00.000Z' },
    });
  });

  it('an unreadable reset keeps the percentage', () => {
    expect(parseClaudeUsageText('Current week (all models): 55% used · resets someday', NOW)).toEqual({ weekly: { usedPct: 55, resetsAt: null } });
  });

  it('not a subscription, logged out, an error, garbage → null (nothing changes)', () => {
    expect(parseClaudeUsageText('You are currently using API usage billing. /usage is only available for subscription plans.', NOW)).toBeNull();
    expect(parseClaudeUsage(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), NOW)).toBeNull();
    expect(parseClaudeUsage(JSON.stringify({ type: 'result', is_error: true, result: SAMPLE }), NOW)).toBeNull();
    expect(parseClaudeUsage('', NOW)).toBeNull();
    expect(parseClaudeUsage('{not json', NOW)).toBeNull();
  });
});

type Fake = { child: ChildLike & EventEmitter; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

/** No pid: the poller then signals the child itself, never a process group. */
function fakeChild(): Fake {
  const em = new EventEmitter() as ChildLike & EventEmitter;
  const stdout = new PassThrough(), stderr = new PassThrough();
  const kill = vi.fn();
  Object.assign(em, { stdout, stderr, stdin: null, kill });
  return { child: em, stdout, stderr, kill };
}

const answer = (text: string) => (f: Fake) => { f.stdout.end(JSON.stringify({ type: 'result', is_error: false, num_turns: 0, result: text })); f.child.emit('exit', 0); };

function setup(o: { script: (f: Fake, n: number) => void; fetchedAt?: Record<string, string | null>; bin?: string | null; timeoutMs?: number; now?: () => number }) {
  const spawned: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
  const children: Fake[] = [];
  const spawnFn: SpawnFn = (bin, args, so) => {
    spawned.push({ bin, args, cwd: so.cwd, env: so.env });
    const f = fakeChild();
    children.push(f);
    const n = spawned.length;
    setTimeout(() => o.script(f, n), 0);
    return f.child;
  };
  const fetchedAt = o.fetchedAt ?? {};
  const snap = () => ({ accounts: Object.fromEntries(['a', 'b', 'c'].map((a) => [a, { fetchedAt: fetchedAt[a] ?? null }])) }) as unknown as UsageSnapshot;
  const usage = { applyCliPoll: vi.fn(), routingSnapshot: vi.fn(snap) };
  const logs: string[] = [];
  const p = new ClaudeUsagePoller({
    bin: o.bin === undefined ? '/x/claude' : o.bin, accounts: testRegistry(), usage, spawnFn, now: o.now ?? (() => NOW),
    timeoutMs: o.timeoutMs ?? 2_000, startDelayMs: 1_000, intervalMs: 60_000, maxAgeMs: 10 * 60_000,
    baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/elsewhere' }, log: (l) => logs.push(l),
  });
  return { p, usage, spawned, children, logs };
}

describe('ClaudeUsagePoller', () => {
  afterEach(() => vi.useRealTimers());

  it('runs claude -p /usage per account in its own profile, in a temp cwd that is removed after', async () => {
    const { p, usage, spawned } = setup({ script: answer(SAMPLE) });
    await p.pollAccount('b');
    await p.pollAccount('a');
    expect(spawned.map((s) => s.bin)).toEqual(['/x/claude', '/x/claude']);
    expect(spawned[0]!.args).toEqual([...CLAUDE_USAGE_ARGS]);
    expect(spawned[0]!.args).not.toContain('--bare');
    expect(spawned[0]!.env.CLAUDE_CONFIG_DIR).toBe('/h/.claude-b');
    expect(spawned[1]!.env.CLAUDE_CONFIG_DIR).toBeUndefined(); // a = ~/.claude: no override
    expect(spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned[0]!.cwd.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(spawned[0]!.cwd)).toBe(false);
    expect(usage.applyCliPoll).toHaveBeenNthCalledWith(1, 'b', parseClaudeUsageText(SAMPLE, NOW), NOW);
  });

  it('first round shortly after start, then every interval; only accounts whose last observation is older than 10 min', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    const { p, spawned } = setup({
      script: answer(SAMPLE), now: () => clock,
      fetchedAt: { a: new Date(NOW - 60_000).toISOString(), b: new Date(NOW - 11 * 60_000).toISOString(), c: null },
    });
    p.start();
    await vi.advanceTimersByTimeAsync(900);
    expect(spawned).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(spawned.map((s) => s.env.CLAUDE_CONFIG_DIR)).toEqual(['/h/.claude-b', '/h/.claude-c']);
    clock = NOW + 60_000 * 10; // a's observation is now 11 min old too (b/c stay old: the fake snapshot does not move)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(5);
    p.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawned).toHaveLength(5);
  });

  it('one /usage at a time: the next account waits for the first to exit; overlapping rounds are shared', async () => {
    vi.useFakeTimers();
    const { p, spawned, children } = setup({ script: () => {} });
    const r1 = p.sweep(), r2 = p.sweep();
    await vi.advanceTimersByTimeAsync(10);
    expect(spawned).toHaveLength(1);
    answer(SAMPLE)(children[0]!);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawned).toHaveLength(2);
    answer(SAMPLE)(children[1]!);
    await vi.advanceTimersByTimeAsync(10);
    answer(SAMPLE)(children[2]!);
    await Promise.all([r1, r2]);
    expect(spawned).toHaveLength(3);
  });

  it('a failure is one log line and changes nothing; the next round tries again', async () => {
    let fail = true;
    const { p, usage, logs, spawned } = setup({ fetchedAt: { a: null, b: new Date(NOW).toISOString(), c: new Date(NOW).toISOString() }, script: (f) => {
      if (fail) { f.stderr.end('Error: boom\n'); f.stdout.end(); f.child.emit('exit', 1); } else answer(SAMPLE)(f);
    } });
    await p.sweep();
    expect(usage.applyCliPoll).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/claude \/usage \(a\) 실패 — exit 1 — Error: boom/);
    fail = false;
    await p.sweep();
    expect(spawned).toHaveLength(2);
    expect(usage.applyCliPoll).toHaveBeenCalledTimes(1);
  });

  it('a text without limit lines (not a subscription) is logged and applies nothing', async () => {
    const { p, usage, logs } = setup({ script: answer('You are currently using API usage billing') });
    await p.pollAccount('a');
    expect(usage.applyCliPoll).not.toHaveBeenCalled();
    expect(logs[0]).toContain('그대로 둡니다');
  });

  it('a hang is killed at the timeout', async () => {
    const { p, usage, logs, children } = setup({ timeoutMs: 30, script: (f) => { f.kill.mockImplementation(() => { f.child.emit('exit', null); }); } });
    await p.pollAccount('a');
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(usage.applyCliPoll).not.toHaveBeenCalled();
    expect(logs[0]).toContain('시간 초과');
  });

  it('no usable claude binary: nothing runs', async () => {
    const { p, spawned } = setup({ bin: null, script: answer(SAMPLE) });
    await p.sweep();
    await p.pollAccount('a');
    expect(spawned).toHaveLength(0);
  });

  it('stop() kills the running child and ends the round', async () => {
    vi.useFakeTimers();
    const { p, spawned, children, logs } = setup({ script: (f) => { f.kill.mockImplementation(() => { f.child.emit('exit', null); }); } });
    const round = p.sweep();
    await vi.advanceTimersByTimeAsync(10);
    p.stop();
    await round;
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawned).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });

  it('with a real UsageService (cli): the card turns ok and fresh, says it was polled, and a newer turn is never overwritten', async () => {
    let ms = NOW;
    const reg = testRegistry();
    const usage = new UsageService({ mode: 'cli', deckUrl: 'http://usage-deck.invalid', fetchFn: vi.fn<FetchLike>(), now: () => new Date(ms), accounts: reg });
    usage.applyTurn('b', { fiveHour: { usedPct: 30, resetsAt: null }, weekly: { usedPct: 50, resetsAt: null } }, NOW - 86_400_000);
    expect(usageOf(usage.snapshot(), 'b').status).toBe('stale');
    const spawnFn: SpawnFn = () => { const f = fakeChild(); setTimeout(() => answer(SAMPLE)(f), 0); return f.child; };
    const p = new ClaudeUsagePoller({ bin: '/x/claude', accounts: reg, usage, spawnFn, now: () => ms, log: () => {} });
    await p.pollAccount('b');
    expect(usageOf(usage.snapshot(), 'b')).toMatchObject({
      status: 'ok', fetchedAt: new Date(NOW).toISOString(), observedBy: 'poll',
      fiveHour: { usedPct: 0, resetsAt: null }, weekly: { usedPct: 90, resetsAt: '2026-10-23T08:59:00.000Z' }, fable: { usedPct: 87, resetsAt: '2026-10-23T08:59:00.000Z' },
    });
    // A turn observed after the poll started wins; a poll reading taken before it does not overwrite.
    ms = NOW + 60_000;
    usage.applyTurn('b', { fiveHour: { usedPct: 5, resetsAt: null }, weekly: { usedPct: 91, resetsAt: null } }, NOW + 30_000);
    usage.applyCliPoll('b', { fiveHour: { usedPct: 1, resetsAt: null }, weekly: { usedPct: 80, resetsAt: null } }, NOW + 10_000);
    const b = usageOf(usage.snapshot(), 'b');
    expect(b).toMatchObject({ fiveHour: { usedPct: 5 }, weekly: { usedPct: 91 } });
    expect(b).not.toHaveProperty('observedBy');
  });
});
