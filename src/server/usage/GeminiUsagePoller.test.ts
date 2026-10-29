import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GEMINI_USAGE_ARGS, GeminiUsagePoller, parseDuration, parseGeminiUsage, parseUsageText, toResetIso } from './GeminiUsagePoller';
import type { ChildLike, SpawnFn } from '../engine/CodexEngine';

const NOW = Date.parse('2026-10-14T08:00:00Z');
/** The real `agy -p=/usage --output-format json` stdout (agy 1.4.2). */
const USAGE_JSON = fs.readFileSync(path.join(__dirname, '..', 'engine', 'fixtures', 'agy-1.4.2', 'usage.json'), 'utf8');

describe('parseGeminiUsage', () => {
  it('reads the real agy 1.4.2 /usage json: remaining_fraction → used %, "<group> · <window>" names, the Claude/GPT group hidden', () => {
    expect(parseGeminiUsage(USAGE_JSON, NOW)).toEqual([
      { name: 'Gemini · 주간', usedPct: 0, resetsAt: '2026-10-25T08:28:03.000Z' },
      { name: 'Gemini · 5h', usedPct: 0, resetsAt: '2026-10-18T13:28:03.000Z' },
      { name: 'Argon · 주간', usedPct: 2, resetsAt: '2026-10-25T08:25:03.000Z' },
    ]);
    // Same group/window names in two groups no longer collapse: a lower fraction shows as its own used %.
    const two = JSON.stringify({ command: { data: { groups: [
      { name: 'Gemini Models', buckets: [{ name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.25, reset_time: '2026-10-25T08:28:03Z' }] },
      { name: 'Gemini 4 Argon', buckets: [{ name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.6 }] },
    ] } } });
    expect(parseGeminiUsage(two, NOW)).toEqual([
      { name: 'Gemini · 주간', usedPct: 75, resetsAt: '2026-10-25T08:28:03.000Z' },
      { name: 'Argon · 주간', usedPct: 40, resetsAt: null },
    ]);
  });

  it('the tab-separated text report in `response` (remaining %), when the json has no buckets', () => {
    const response = (JSON.parse(USAGE_JSON) as { response: string }).response;
    expect(parseUsageText(response, NOW)).toEqual([
      { name: 'Gemini · 주간', usedPct: 0, resetsAt: '2026-10-25T08:28:03.000Z' },
      { name: 'Gemini · 5h', usedPct: 0, resetsAt: '2026-10-18T13:28:03.000Z' },
      { name: 'Argon · 주간', usedPct: 2, resetsAt: '2026-10-25T08:25:03.000Z' },
    ]);
    expect(parseGeminiUsage(JSON.stringify({ status: 'SUCCESS', response: 'Gemini Models\tFive Hour Limit Remaining\t64%\t2026-10-14T09:00:00Z\n' }), NOW))
      .toEqual([{ name: 'Gemini · 5h', usedPct: 36, resetsAt: '2026-10-14T09:00:00.000Z' }]);
  });

  it('reads used_percentage with epoch-second resets, a bucket named by its group, and ignores the turn token usage', () => {
    const out = JSON.stringify({ result: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, buckets: [
      { display_name: 'Pro', used_percentage: 40.26, reset_time: 1791353807 },
    ], groups: [{ label: 'Flash family', buckets: [{ used_percentage: 5, reset_in_seconds: 600 }] }] } });
    expect(parseGeminiUsage(out, NOW)).toEqual([
      { name: 'Pro', usedPct: 40.3, resetsAt: new Date(1791353807 * 1000).toISOString() },
      { name: 'Flash family', usedPct: 5, resetsAt: new Date(NOW + 600_000).toISOString() },
    ]);
  });

  it('falls back to the text report inside `response`, then to plain stdout; garbage → []', () => {
    const json = JSON.stringify({ status: 'SUCCESS', response: 'Quota\nGemini 4 Argon: 73% remaining (resets in 2h 10m)\ngemini-3.8-flash · 12% used · resets at 2026-10-14T09:00:00Z\n' });
    expect(parseGeminiUsage(json, NOW)).toEqual([
      { name: 'Gemini 4 Argon', usedPct: 27, resetsAt: new Date(NOW + (2 * 60 + 10) * 60_000).toISOString() },
      { name: 'gemini-3.8-flash', usedPct: 12, resetsAt: '2026-10-14T09:00:00.000Z' },
    ]);
    expect(parseGeminiUsage('Argon | 50% left\n', NOW)).toEqual([{ name: 'Argon', usedPct: 50, resetsAt: null }]);
    expect(parseGeminiUsage('nothing here\n{"status":"SUCCESS","response":"ok"}\n', NOW)).toEqual([]);
    expect(parseGeminiUsage('', NOW)).toEqual([]);
  });

  it('dedupes by name (first wins) and clamps percentages', () => {
    const out = JSON.stringify([{ name: 'x', remaining_percentage: -5 }, { name: 'x', remaining_percentage: 50 }, { name: 'y', used_percentage: 140 }]);
    expect(parseGeminiUsage(out, NOW)).toEqual([{ name: 'x', usedPct: 100, resetsAt: null }, { name: 'y', usedPct: 100, resetsAt: null }]);
  });

  it('helpers: durations and reset stamps', () => {
    expect(parseDuration('2h 10m')).toBe((2 * 60 + 10) * 60_000);
    expect(parseDuration('in 45m')).toBe(45 * 60_000);
    expect(parseDuration('1d 3h')).toBe(27 * 3_600_000);
    expect(parseDuration('tomorrow')).toBeNull();
    expect(toResetIso(1791353807, NOW)).toBe(new Date(1791353807 * 1000).toISOString());
    expect(toResetIso(1791353807000, NOW)).toBe(new Date(1791353807000).toISOString());
    expect(toResetIso('2026-10-14 09:00', NOW)).toBe('2026-10-14T09:00:00.000Z');
    expect(toResetIso('garbage', NOW)).toBeNull();
    expect(parseUsageText('\x1b[32mArgon\x1b[0m: 80% remaining', NOW)).toEqual([{ name: 'Argon', usedPct: 20, resetsAt: null }]);
  });
});

type Fake = { child: ChildLike & EventEmitter; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

function fakeChild(): Fake {
  const em = new EventEmitter() as ChildLike & EventEmitter;
  const stdout = new PassThrough(), stderr = new PassThrough();
  const kill = vi.fn();
  Object.assign(em, { stdout, stderr, stdin: null, kill, pid: 1 });
  return { child: em, stdout, stderr, kill };
}

let realHome = '';
beforeAll(() => { realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agy-usage-')); });
afterAll(() => { if (realHome) fs.rmSync(realHome, { recursive: true, force: true }); });

function poller(opts: { loggedIn: boolean; script: (f: Fake) => void; now?: () => number; timeoutMs?: number }) {
  const applyGemini = vi.fn();
  const spawned: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
  const spawnFn: SpawnFn = (bin, args, o) => { spawned.push({ bin, args, cwd: o.cwd, env: o.env }); const f = fakeChild(); setTimeout(() => opts.script(f), 0); return f.child; };
  const login = { get: vi.fn(() => opts.loggedIn), refresh: vi.fn(async () => opts.loggedIn) };
  const p = new GeminiUsagePoller({ bin: '/x/agy', usage: { applyGemini }, login, spawnFn, now: opts.now ?? (() => NOW), timeoutMs: opts.timeoutMs ?? 2_000, log: () => {}, baseEnv: { PATH: '/bin', GEMINI_API_KEY: 'k', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' }, realHome });
  return { p, applyGemini, spawned, login };
}

describe('GeminiUsagePoller', () => {
  it('runs agy -p=/usage --output-format json in a temp cwd with a cleaned env and publishes the buckets', async () => {
    const { p, applyGemini, spawned } = poller({ loggedIn: true, script: (f) => { f.stdout.end(JSON.stringify({ quota: { buckets: [{ name: 'gemini-4-argon', remaining_percentage: 60, reset_time: '2026-10-14T12:00:00Z' }] } }) + '\n'); f.child.emit('exit', 0); } });
    await p.pollOnce();
    expect(spawned).toHaveLength(2);
    expect(spawned.map((s) => s.env.HOME)).toEqual([realHome, `${realHome}/.agy-g2`]);
    expect(spawned[0]!.bin).toBe('/x/agy');
    expect(spawned[0]!.args).toEqual([...GEMINI_USAGE_ARGS]);
    expect(spawned[0]!.args).not.toContain('--disable-slash-commands');
    expect(spawned[0]!.env.GEMINI_API_KEY).toBeUndefined();
    expect(spawned[0]!.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(spawned[0]!.env.SSH_CONNECTION).toBeUndefined();
    const usage = { status: 'ok', fetchedAt: new Date(NOW).toISOString(), loggedIn: true, buckets: [{ name: 'gemini-4-argon', usedPct: 40, resetsAt: '2026-10-14T12:00:00.000Z' }], error: null };
    expect(applyGemini).toHaveBeenCalledWith('g1', usage);
    expect(applyGemini).toHaveBeenCalledWith('g2', usage);
    expect(p.current()?.status).toBe('ok');
  });

  it('never runs agy while the login probe says logged out (print mode would block waiting for a browser login)', async () => {
    const { p, applyGemini, spawned, login } = poller({ loggedIn: false, script: () => { throw new Error('must not spawn'); } });
    await p.pollOnce();
    expect(spawned).toHaveLength(0);
    expect(login.refresh).toHaveBeenCalledTimes(1);
    expect(applyGemini).toHaveBeenCalledWith('g1', { status: 'down', fetchedAt: null, loggedIn: false, buckets: [], error: expect.stringContaining('로그인 필요') });
    expect(applyGemini).toHaveBeenCalledWith('g2', { status: 'down', fetchedAt: null, loggedIn: false, buckets: [], error: expect.stringContaining('로그인 필요') });
  });

  it('keeps the last buckets as stale when a later read fails, and reports down with the reason when there were none', async () => {
    let step = 0;
    const { p, applyGemini } = poller({ loggedIn: true, script: (f) => {
      step += 1;
      if (step <= 2) { f.stdout.end('{"quota":{"buckets":[{"name":"a","used_percentage":10}]}}\n'); f.child.emit('exit', 0); }
      else { f.stderr.end('Error: boom\n'); f.stdout.end(); f.child.emit('exit', 1); }
    } });
    await p.pollOnce();
    await p.pollOnce();
    const last = applyGemini.mock.calls.at(-1)![1];
    expect(last.status).toBe('stale');
    expect(last.buckets).toEqual([{ name: 'a', usedPct: 10, resetsAt: null }]);
    expect(last.error).toContain('exit 1');

    const fresh = poller({ loggedIn: true, script: (f) => { f.stdout.end('not a report\n'); f.child.emit('exit', 0); } });
    await fresh.p.pollOnce();
    expect(fresh.applyGemini).toHaveBeenCalledWith('g1', { status: 'down', fetchedAt: null, loggedIn: true, buckets: [], error: '사용량 응답을 해석하지 못했습니다' });
  });

  it('an "authentication required" answer reads as logged out, a hang is killed at the timeout', async () => {
    const auth = poller({ loggedIn: true, script: (f) => { f.stderr.end('authentication required. Run \'agy\' to log in\n'); f.stdout.end(); f.child.emit('exit', 1); } });
    await auth.p.pollOnce();
    expect(auth.applyGemini.mock.calls.at(-1)![1].error).toContain('로그인 필요');

    let killed: Fake | null = null;
    const hang = poller({ loggedIn: true, timeoutMs: 30, script: (f) => { killed = f; f.kill.mockImplementation(() => { f.child.emit('exit', null); }); } });
    await hang.p.pollOnce();
    expect(killed!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(hang.applyGemini.mock.calls.at(-1)![1].error).toContain('시간 초과');
  });

  it('bump() coalesces into one delayed read; concurrent pollOnce calls share a run', async () => {
    vi.useFakeTimers();
    try {
      const { p, spawned } = poller({ loggedIn: true, script: (f) => { f.stdout.end('{"buckets":[{"name":"a","used_percentage":1}]}\n'); f.child.emit('exit', 0); } });
      p.bump(100); p.bump(100); p.bump(100);
      await vi.advanceTimersByTimeAsync(150);
      expect(spawned).toHaveLength(2);
      const a = p.pollOnce(), b = p.pollOnce();
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([a, b]);
      expect(spawned).toHaveLength(4);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
