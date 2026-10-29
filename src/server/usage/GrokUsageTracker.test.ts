import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDay } from '../../shared/usage-types';
import { GrokUsageTracker } from './GrokUsageTracker';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-'));
  file = path.join(dir, 'grok-usage.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY1 = Date.parse('2026-10-18T10:00:00Z'); // KST 19:00 — same local day
const USAGE = { inputTokens: 100, outputTokens: 20 };

describe('GrokUsageTracker.noteTurn', () => {
  it('tallies input+output tokens and turn count for a successful turn, status ok, lastError null', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    const s = t.snapshotOf('x1', DAY1);
    expect(s.status).toBe('ok');
    expect(s.lastError).toBeNull();
    expect(s.today).toEqual({ inputTokens: 100, outputTokens: 20, turns: 1, day: s.today.day });
    expect(s.lastTurnAt).toBe(new Date(DAY1).toISOString());
  });

  it('counts a stopped/cancelled turn too (ok: false, errorKind null) — tokens and turns still added', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: false, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    const s = t.snapshotOf('x1', DAY1);
    expect(s.today).toMatchObject({ inputTokens: 100, outputTokens: 20, turns: 1 });
    expect(s.lastError).toBeNull();
    expect(s.status).toBe('ok');
  });

  it('classifies authentication_failed as auth and status down, which persists through later non-auth failures until a success', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: false, errorKind: 'authentication_failed', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).status).toBe('down');
    expect(t.snapshotOf('x1', DAY1).lastError).toBe('auth');
    // A later rate_limit failure does not clear 'down' — only a success does.
    t.noteTurn('x1', { ok: false, errorKind: 'rate_limit', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: DAY1 + 60_000 });
    expect(t.snapshotOf('x1', DAY1).status).toBe('down');
    expect(t.snapshotOf('x1', DAY1).lastError).toBe('limit');
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).status).toBe('ok');
  });

  it('classifies rate_limit as limit and overloaded as busy; other kinds map to no lastError', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: false, errorKind: 'overloaded', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).lastError).toBe('busy');
    t.noteTurn('x1', { ok: false, errorKind: 'refusal', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).lastError).toBeNull();
  });

  it('cooldown status is read from the caller-supplied cooldownUntilMs alone (TurnRunner.grokCooldownUntil), never computed here', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: false, errorKind: 'rate_limit', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: DAY1 + 60_000 });
    expect(t.snapshotOf('x1', DAY1).status).toBe('cooldown');
    expect(t.snapshotOf('x1', DAY1).cooldownUntil).toBe(new Date(DAY1 + 60_000).toISOString());
    // Once the clock passes cooldownUntilMs, status is no longer 'cooldown' even without a new turn.
    expect(t.snapshotOf('x1', DAY1 + 61_000).status).toBe('ok');
  });

  it('an account with no turn yet reads as unknown with zero today', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    const s = t.snapshotOf('x1', DAY1);
    expect(s.status).toBe('unknown');
    expect(s.today.turns).toBe(0);
  });
});

describe('GrokUsageTracker day rollover (local midnight)', () => {
  it('resets today on the next turn once the local day has changed (same instance, clock moved)', () => {
    let now = DAY1;
    const t = new GrokUsageTracker({ file, now: () => now });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', now).today.turns).toBe(2);
    now = DAY1 + 24 * 3_600_000;
    // Before any new turn, a read on the next local day already sees 0.
    expect(t.snapshotOf('x1', now).today.turns).toBe(0);
    t.noteTurn('x1', { ok: true, errorKind: null, usage: { inputTokens: 5, outputTokens: 1 }, cooldownUntilMs: null });
    const s = t.snapshotOf('x1', now);
    expect(s.today).toEqual({ inputTokens: 5, outputTokens: 1, turns: 1, day: s.today.day });
    expect(s.today.day).not.toBe(t.snapshotOf('x1', DAY1).today.day);
    // A fresh tracker whose clock has moved to the next local day sees the rollover on read, before any new turn.
    const t2 = new GrokUsageTracker({ file, now: () => now + 24 * 3_600_000 });
    expect(t2.snapshotOf('x1').today.turns).toBe(0);
  });

  it('an old-format file without today.day starts today at 0 (yesterday\'s numbers are not carried into today)', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { x1: { lastTurnAtMs: DAY1 - 86_400_000, lastError: null, cooldownUntilMs: null, down: false, today: { inputTokens: 900, outputTokens: 90, turns: 9 } } } }));
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    expect(t.snapshotOf('x1', DAY1).today).toMatchObject({ inputTokens: 0, outputTokens: 0, turns: 0 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).today).toMatchObject({ inputTokens: 100, outputTokens: 20, turns: 1 });
  });

  it('resets today at write time too, when a new turn happens the next local day', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    const nextDay = DAY1 + 24 * 3_600_000;
    let now = nextDay;
    const t2 = new GrokUsageTracker({ file, now: () => now });
    t2.noteTurn('x1', { ok: true, errorKind: null, usage: { inputTokens: 7, outputTokens: 2 }, cooldownUntilMs: null });
    const s = t2.snapshotOf('x1', nextDay);
    expect(s.today.turns).toBe(1);
    expect(s.today.inputTokens).toBe(7);
  });
});

describe('GrokUsageTracker persistence', () => {
  it('writes atomically (via a tmp file + rename) and a fresh tracker reads the same numbers back', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    const t2 = new GrokUsageTracker({ file, now: () => DAY1 });
    expect(t2.snapshotOf('x1', DAY1).today).toMatchObject({ inputTokens: 100, outputTokens: 20, turns: 1 });
  });

  it('a second tracker created after the first one wrote reads its numbers and adds to them (sequential use, not concurrent writers)', () => {
    const t1 = new GrokUsageTracker({ file, now: () => DAY1 });
    t1.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    const t2 = new GrokUsageTracker({ file, now: () => DAY1 });
    t2.noteTurn('x1', { ok: true, errorKind: null, usage: { inputTokens: 1, outputTokens: 1 }, cooldownUntilMs: null });
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(json.accounts.x1.today.turns).toBe(2);
  });

  it('a corrupt file is moved aside as .bad-<ts> and the tracker starts at 0', () => {
    fs.writeFileSync(file, '{ not json');
    const log: string[] = [];
    const t = new GrokUsageTracker({ file, now: () => DAY1, log: (l) => log.push(l) });
    expect(t.snapshotOf('x1', DAY1).today.turns).toBe(0);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('grok-usage.json.bad-'))).toBe(true);
    expect(log.length).toBeGreaterThan(0);
  });

  it('a file with an unrecognized shape (no accounts) is also moved aside, not thrown', () => {
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    expect(t.snapshotOf('x1', DAY1).status).toBe('unknown');
    expect(fs.readdirSync(dir).some((f) => f.startsWith('grok-usage.json.bad-'))).toBe(true);
  });

  it('pushes the restored numbers into UsageService right at construction, not only after the next turn', () => {
    const applied: Array<[string, unknown]> = [];
    const t1 = new GrokUsageTracker({ file, now: () => DAY1 });
    t1.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    new GrokUsageTracker({ file, now: () => DAY1, usage: { applyGrok: (a, u) => applied.push([a, u]) } });
    expect(applied).toHaveLength(1);
    expect(applied[0]![0]).toBe('x1');
    expect((applied[0]![1] as { today: { turns: number } }).today.turns).toBe(1);
  });

  it('calls usage.applyGrok after every noteTurn', () => {
    const applied: Array<[string, unknown]> = [];
    const t = new GrokUsageTracker({ file, now: () => DAY1, usage: { applyGrok: (a, u) => applied.push([a, u]) } });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(applied).toHaveLength(1);
    expect(applied[0]![0]).toBe('x1');
  });
});

describe('GrokUsageTracker billing (`_x.ai/billing` readings)', () => {
  const B = {
    usedPct: 1, windowStart: '2026-10-18T07:54:33.561Z', windowEnd: '2026-10-25T07:54:33.561Z', tier: 'SuperGrok Heavy',
    fetchedAt: '2026-10-18T10:00:00.000Z', periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
  };

  it('a turn\'s billing is stored, shown in the snapshot and read back by a fresh tracker', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null, billing: B });
    expect(t.snapshotOf('x1', DAY1).billing).toEqual(B);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    const t2 = new GrokUsageTracker({ file, now: () => DAY1 });
    expect(t2.snapshotOf('x1', DAY1).billing).toEqual(B);
    expect(t2.billingOf('x1')).toEqual(B);
  });

  it('a turn without billing keeps the last reading', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null, billing: B });
    t.noteTurn('x1', { ok: true, errorKind: null, usage: USAGE, cooldownUntilMs: null });
    expect(t.snapshotOf('x1', DAY1).billing).toEqual(B);
  });

  it('noteAuth with no turn is login-needed, keeps any billing, and survives a reload', () => {
    const applied: string[] = [];
    const t = new GrokUsageTracker({ file, now: () => DAY1, usage: { applyGrok: (_a, u) => applied.push(u.status) } });
    t.noteBilling('x1', B);
    t.noteAuth('x1');
    const s = t.snapshotOf('x1', DAY1);
    expect(s.status).toBe('down');
    expect(s.lastError).toBe('auth');
    expect(s.lastTurnAt).toBeNull();
    expect(s.today.turns).toBe(0);
    expect(s.billing).toEqual(B);
    expect(applied).toEqual(['unknown', 'down']);
    expect(new GrokUsageTracker({ file, now: () => DAY1 }).snapshotOf('x1', DAY1).status).toBe('down');
  });

  it('noteBilling after noteAuth clears login-needed and keeps the reading', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteAuth('x1');
    t.noteBilling('x1', B);
    const s = t.snapshotOf('x1', DAY1);
    expect(s.status).toBe('unknown');
    expect(s.lastError).toBeNull();
    expect(s.billing).toEqual(B);
    expect(s.lastTurnAt).toBeNull();
  });

  it('noteBilling clears down left by a turn auth error and keeps a later limit cooldown', () => {
    const t = new GrokUsageTracker({ file, now: () => DAY1 });
    t.noteTurn('x1', { ok: false, errorKind: 'authentication_failed', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: null });
    t.noteTurn('x1', { ok: false, errorKind: 'rate_limit', usage: { inputTokens: 0, outputTokens: 0 }, cooldownUntilMs: DAY1 + 60_000 });
    expect(t.snapshotOf('x1', DAY1).status).toBe('down');
    t.noteBilling('x1', B);
    const s = t.snapshotOf('x1', DAY1);
    expect(s.status).toBe('cooldown');
    expect(s.lastError).toBe('limit');
    expect(s.billing).toEqual(B);
  });

  it('noteBilling (the idle poller) stores a reading with no turn: today stays 0, applyGrok is called', () => {
    const applied: string[] = [];
    const t = new GrokUsageTracker({ file, now: () => DAY1, usage: { applyGrok: (a) => applied.push(a) } });
    t.noteBilling('x1', B);
    const s = t.snapshotOf('x1', DAY1);
    expect(s.billing).toEqual(B);
    expect(s.today.turns).toBe(0);
    expect(s.lastTurnAt).toBeNull();
    expect(applied).toEqual(['x1']);
    expect(new GrokUsageTracker({ file, now: () => DAY1 }).billingOf('x1')).toEqual(B);
  });

  it('an old file without billing reads fine; a corrupt billing entry is dropped, the rest kept', () => {
    const acct = { lastTurnAtMs: DAY1, lastError: null, cooldownUntilMs: null, down: false, today: { inputTokens: 5, outputTokens: 1, turns: 1, day: localDay(new Date(DAY1)) } };
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { x1: acct } }));
    const old = new GrokUsageTracker({ file, now: () => DAY1 }).snapshotOf('x1', DAY1);
    expect(old.billing).toBeUndefined();
    expect(old.today.turns).toBe(1);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { x1: { ...acct, billing: { usedPct: 'lots', fetchedAt: 'never' } } } }));
    const bad = new GrokUsageTracker({ file, now: () => DAY1 });
    expect(bad.snapshotOf('x1', DAY1).billing).toBeUndefined();
    expect(bad.snapshotOf('x1', DAY1).today.turns).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bad-'))).toEqual([]);
  });
});
