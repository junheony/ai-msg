import { describe, expect, it } from 'vitest';
import { buildMiniStatus, createMiniStatus, pickSessions, summarizeHub, type MiniDeps } from './status';
import { MiniTracker, type TrackedSession } from './MiniTracker';
import { SECRET_FIELD_RE } from '../hub/status';
import type { HubStatus } from '../../shared/hub-types';
import type { UsageSnapshot } from '../../shared/usage-types';
import { MINI_MAX_BYTES } from '../../shared/mini-types';
import { testRegistry } from '../../shared/accounts.testkit';

const NOW = Date.parse('2026-10-30T10:00:00Z');
const HOME = '/Users/alice';

const snapshot: UsageSnapshot = {
  generatedAt: new Date(NOW).toISOString(),
  deckReachable: true,
  accounts: {
    a: { status: 'ok', fetchedAt: new Date(NOW).toISOString(), fiveHour: { usedPct: 37, resetsAt: '2026-10-30T12:00:00Z' }, weekly: { usedPct: 80.4, resetsAt: '2026-11-02T00:00:00Z' }, fable: null },
    b: { status: 'stale', fetchedAt: null, fiveHour: null, weekly: { usedPct: 10, resetsAt: null }, fable: null },
  },
  gpt: { status: 'ok', fetchedAt: null, fiveHour: { usedPct: 100, resetsAt: '2026-10-30T11:00:00Z' }, weekly: { usedPct: 5, resetsAt: null }, fable: null },
};

const hub: HubStatus = {
  host: 'h',
  generated_at: '2026-10-30T09:59:50.000Z',
  modes: [
    { id: 'msg', name: 'MSG 터미널', state: 'ok', lastActivity: null, metrics: { api_key: 'nope' }, alerts: [], links: [], sources: [] },
    { id: 'nexus', name: 'NEXUS', state: 'warn', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [] },
    { id: 'ops', name: 'OPS', state: 'idle', lastActivity: null, metrics: {}, alerts: [], links: [], sources: [] },
  ],
};

function tracked(id: string, extra: Partial<TrackedSession> = {}): TrackedSession {
  return { sessionId: id, engine: 'claude', model: 'opus', account: 'a', lastPrompt: `prompt of ${id}`, usage: null, progressOut: 0, turns: 1, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, waitingOn: null, runningSince: null, updatedAt: NOW - 60_000, ...extra };
}

function deps(sessions: TrackedSession[], running: string[] = [], extra: Partial<MiniDeps> = {}): MiniDeps {
  return {
    tracked: () => sessions,
    running: () => running.map((sessionId) => ({ turnId: `t-${sessionId}`, sessionId, cwd: `${HOME}/proj` })),
    usage: () => snapshot,
    accounts: testRegistry(HOME),
    titleOf: (id) => (id === 's1' ? `Fix ${HOME}/proj/build` : null),
    home: HOME,
    now: () => NOW,
    ...extra,
  };
}

const usage = { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 60_000, cacheCreationTokens: 2000, context: { inputTokens: 1000, cacheReadTokens: 60_000, cacheCreationTokens: 2000 }, contextWindow: 200_000 };

describe('mini status', () => {
  it('answers the compact shape: counts, top sessions, a line per seat, the hub reduced to states', () => {
    const s = buildMiniStatus(deps([tracked('s1', { usage, totals: { input: 1000, output: 250, cacheRead: 60_000, cacheWrite: 2000 }, turns: 3, runningSince: NOW - 5000, progressOut: 77, updatedAt: NOW - 5000 })], ['s1']), summarizeHub(hub));
    expect(s.generated_at).toBe(new Date(NOW).toISOString());
    expect(s.running).toBe(1);
    expect(s.waiting).toBe(0);
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toEqual({
      title: 'Fix ~/proj/build', engine: 'claude', model: 'opus', account: 'a',
      contextPct: 32, context: 63_000, out: 77, cacheRead: 60_000,
      costUsd: expect.any(Number), turns: 3, lastPrompt: 'prompt of s1', state: 'running', updatedAgoMs: 5000, forMs: 5000,
    });
    // opus: (1000×4 + 250×20 + 60000×4×0.1 + 2000×4×1.25) / 1e6
    expect(s.sessions[0]!.costUsd).toBeCloseTo(0.04, 2);
    expect(s.seats).toEqual([
      { id: 'a', label: 'A', status: 'ok', left5h: 63, leftWeek: 19, resets5h: '2026-10-30T12:00:00Z', resetsWeek: '2026-11-02T00:00:00Z' },
      { id: 'b', label: 'B', status: 'stale', left5h: null, leftWeek: 90, resets5h: null, resetsWeek: null },
      { id: 'c', label: 'C', status: 'down', left5h: null, leftWeek: null, resets5h: null, resetsWeek: null },
      { id: 'gpt', label: 'GPT', status: 'ok', left5h: 0, leftWeek: 95, resets5h: '2026-10-30T11:00:00Z', resetsWeek: null },
    ]);
    expect(s.hub).toEqual({ modes: [{ id: 'msg', name: 'MSG 터미널', state: 'ok' }, { id: 'nexus', name: 'NEXUS', state: 'warn' }, { id: 'ops', name: 'OPS', state: 'idle' }], counts: { ok: 1, warn: 1, down: 0, idle: 1, unknown: 0 }, worst: 'warn', generated_at: '2026-10-30T09:59:50.000Z' });
  });

  it('orders waiting, then running, then the most recently changed — three at most', () => {
    const list = [
      tracked('old', { updatedAt: NOW - 3_600_000 }),
      tracked('idle-new', { updatedAt: NOW - 1000 }),
      tracked('run', { runningSince: NOW - 100, updatedAt: NOW - 100 }),
      tracked('wait', { waitingOn: 'p1', updatedAt: NOW - 20_000 }),
      tracked('idle-mid', { updatedAt: NOW - 30_000 }),
    ];
    const s = buildMiniStatus(deps(list, ['run']), null);
    expect(s.sessions.map((x) => [x.lastPrompt, x.state])).toEqual([['prompt of wait', 'waiting'], ['prompt of run', 'running'], ['prompt of idle-new', 'idle']]);
    expect(s.waiting).toBe(1);
    expect(s.hub).toBeNull();
    expect(pickSessions(deps([], []), NOW)).toEqual([]);
  });

  it('never answers a path, a cwd or a key that reads like a secret, and stays under 4 kB with everything filled', () => {
    const long = tracked('x', { usage, totals: { input: 999_999, output: 999_999, cacheRead: 9_999_999, cacheWrite: 999_999 }, turns: 999, lastPrompt: `${HOME}/secret/path ` + 'p'.repeat(60), updatedAt: NOW - 1 });
    const list = Array.from({ length: 10 }, (_, i) => ({ ...long, sessionId: `s${i}`, lastPrompt: `${i} ${long.lastPrompt}`.slice(0, 80) }));
    const s = buildMiniStatus(deps(list, list.map((t) => t.sessionId), { titleOf: () => 'T'.repeat(80) }), summarizeHub({ ...hub, modes: [...hub.modes, ...hub.modes, ...hub.modes] }));
    const text = JSON.stringify(s);
    expect(Buffer.byteLength(text)).toBeLessThan(MINI_MAX_BYTES);
    expect(text).not.toContain(HOME);
    expect(text).not.toContain('/proj');
    expect(text).not.toContain('cwd');
    expect(text).not.toContain('projectDir');
    expect(text).not.toContain('api_key');
    const keys = new Set<string>();
    JSON.parse(text, (k, v) => { if (k) keys.add(k); return v as unknown; });
    for (const k of keys) expect(k, `key ${k} reads like a secret`).not.toMatch(SECRET_FIELD_RE);
    expect(s.sessions).toHaveLength(3);
    expect(s.sessions[0]!.lastPrompt.startsWith('0 ~/secret/path')).toBe(true);
  });

  it('a session without a finished turn has no context, no cost; GPT / Grok models cost from their own family', () => {
    const none = buildMiniStatus(deps([tracked('n')]), null).sessions[0]!;
    expect(none).toMatchObject({ contextPct: null, context: null, costUsd: null, out: 0, cacheRead: 0 });
    const gpt = buildMiniStatus(deps([tracked('g', { engine: 'codex', model: 'gpt-5', usage: { ...usage, context: undefined, contextWindow: undefined, lastCall: { inputTokens: 100_000, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } }, totals: { input: 100_000, output: 10, cacheRead: 0, cacheWrite: 0 } })]), null).sessions[0]!;
    expect(gpt.contextPct).toBe(50);
    expect(gpt.costUsd).toBeCloseTo(0.25, 2);
    const other = buildMiniStatus(deps([tracked('o', { engine: 'grok', model: 'grok-4', totals: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } })]), null).sessions[0]!;
    expect(other.costUsd).toBeNull();
  });

  it('the service waits for the hub a bounded time and otherwise answers with the last hub summary it had', async () => {
    let resolveHub: (h: HubStatus) => void = () => {};
    let calls = 0;
    const service = createMiniStatus(deps([], [], { hub: { status: () => { calls++; return new Promise((r) => { resolveHub = r; }); } }, hubTimeoutMs: 10 }));
    const first = await service.status();
    expect(first.hub).toBeNull();
    expect(calls).toBe(1);
    resolveHub(hub);
    await new Promise((r) => setTimeout(r, 1));
    const second = await service.status();
    expect(second.hub?.worst).toBe('warn');
    expect(calls).toBe(2);
    // A tracker feeds it end to end.
    const tr = new MiniTracker(() => NOW);
    tr.observe({ type: 'turn_started', turnId: 't', sessionId: 'live', cwd: HOME, account: 'a', model: 'fable', reason: 'r', attempt: 1, prompt: { text: 'hi', attachments: [] } });
    const live = buildMiniStatus(deps(tr.list(), ['live']), null);
    expect(live.sessions[0]).toMatchObject({ title: 'hi', model: 'fable', state: 'running', turns: 1 });
  });
});
