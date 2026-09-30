import { describe, expect, it, vi } from 'vitest';
import { UsageService, parseDeckState } from './UsageService';
import { remainingPct } from '../../shared/usage-types';

const LIVE = {
  generatedAt: '2026-09-30T12:27:02.000Z',
  cards: [
    { id: 'claude:main', status: 'ok', fetchedAt: '2026-09-30T12:27:01.422Z', rows: [
      { label: 'Session (5h)', used: 13, cap: 100, unit: '%', resetsAt: '2026-09-30T15:09:59.684Z' },
      { label: 'Weekly (7d)', used: 7, cap: 100, unit: '%', resetsAt: '2026-10-06T22:59:59.684Z' },
      { label: 'Fable (7d)', used: 0, cap: 100, unit: '%', resetsAt: '2026-10-06T23:00:00.000Z' } ] },
    { id: 'claude:second', status: 'stale', fetchedAt: '2026-09-30T12:20:00.000Z', rows: [
      { label: 'Session (5h)', used: 2, cap: 100, unit: '%', resetsAt: '2026-09-30T15:30:00.148Z' },
      { label: 'Weekly (7d)', used: 3, cap: 100, unit: '%', resetsAt: '2026-10-04T09:00:00.148Z' } ] },
    { id: 'codex', status: 'setup_needed', rows: [] },
  ],
};

describe('parseDeckState', () => {
  it('maps cards to accounts, rows by label prefix, missing card → down', () => {
    const acc = parseDeckState(LIVE);
    expect(acc.a.status).toBe('ok');
    expect(acc.a.fiveHour).toEqual({ usedPct: 13, resetsAt: '2026-09-30T15:09:59.684Z' });
    expect(acc.a.weekly?.usedPct).toBe(7);
    expect(acc.a.fable?.usedPct).toBe(0);
    expect(acc.b.status).toBe('stale');
    expect(acc.b.fetchedAt).toBe('2026-09-30T12:20:00.000Z');
    expect(acc.b.fable).toBeNull();
    expect(acc.c.status).toBe('down');
    expect(acc.c.weekly).toBeNull();
  });

  it('first label match wins even when its value is missing (claude-pick rows_of)', () => {
    const acc = parseDeckState({ cards: [{ id: 'claude:main', status: 'ok', rows: [
      { label: 'Weekly (7d)', used: null }, { label: 'Weekly (7d) · 2', used: 50 },
      { label: 'Session (5h)', used: 20 }, { label: 'Session (5h) old', used: 90 } ] }] });
    expect(acc.a.weekly).toBeNull();
    expect(acc.a.fiveHour?.usedPct).toBe(20);
  });

  it('tolerates garbage', () => {
    expect(parseDeckState(null).a.status).toBe('down');
    expect(parseDeckState({ cards: [{ id: 'claude:main', status: 'ok', rows: [{ label: 'Weekly (7d)', used: 'x' }] }] }).a.weekly).toBeNull();
  });
});

describe('remainingPct', () => {
  it('is 100 - used, clamped', () => {
    expect(remainingPct({ usedPct: 13, resetsAt: null })).toBe(87);
    expect(remainingPct({ usedPct: 120, resetsAt: null })).toBe(0);
    expect(remainingPct(null)).toBeNull();
  });
});

describe('UsageService', () => {
  function svc(fetchFn: any, now = () => new Date('2026-09-30T12:30:00Z')) {
    return new UsageService({ deckUrl: 'http://deck.test:9310/', fetchFn, intervalMs: 60_000, now });
  }

  it('polls <deckUrl>/api/state and exposes a snapshot', async () => {
    const fetchFn = vi.fn(async (_url: string) => ({ ok: true, json: async () => LIVE }));
    const s = svc(fetchFn);
    await s.pollOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://deck.test:9310/api/state');
    const snap = s.snapshot();
    expect(snap.deckReachable).toBe(true);
    expect(snap.accounts.a.weekly?.usedPct).toBe(7);
    expect(snap.generatedAt).toBe('2026-09-30T12:30:00.000Z');
  });

  it('keeps the last values but marks them stale when the deck is unreachable', async () => {
    let fail = false;
    const fetchFn = vi.fn(async () => { if (fail) throw new Error('ECONNREFUSED'); return { ok: true, json: async () => LIVE }; });
    const s = svc(fetchFn);
    await s.pollOnce();
    fail = true;
    await s.pollOnce();
    const snap = s.snapshot();
    expect(snap.deckReachable).toBe(false);
    expect(snap.accounts.a.status).toBe('stale');
    expect(snap.accounts.a.fetchedAt).toBe('2026-09-30T12:27:01.422Z');
    expect(snap.accounts.a.weekly?.usedPct).toBe(7);
  });

  it('applyTurn overrides 5h/weekly from the SDK rate_limit_event and notifies', async () => {
    const s = svc(async () => ({ ok: true, json: async () => LIVE }));
    await s.pollOnce();
    const seen: number[] = [];
    s.onChange((snap) => seen.push(snap.accounts.a.fiveHour?.usedPct ?? -1));
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: '2026-09-30T15:09:59.000Z' }, weekly: { usedPct: 8, resetsAt: '2026-10-06T22:59:59.000Z' } });
    expect(s.snapshot().accounts.a.fiveHour?.usedPct).toBe(20);
    expect(s.snapshot().accounts.a.weekly?.usedPct).toBe(8);
    expect(s.snapshot().accounts.a.fable?.usedPct).toBe(0);
    expect(seen).toEqual([20]);
  });

  it('a poll keeps per-turn windows observed after the card was fetched, and drops them once the deck is newer', async () => {
    let state: unknown = LIVE; // card a fetchedAt 12:27:01
    const s = svc(async () => ({ ok: true, json: async () => state }));
    await s.pollOnce();
    s.applyTurn('a', { fiveHour: { usedPct: 20, resetsAt: null } }); // observed 12:30
    await s.pollOnce();
    expect(s.snapshot().accounts.a.fiveHour?.usedPct).toBe(20);
    expect(s.snapshot().accounts.a.weekly?.usedPct).toBe(7);
    const newer = structuredClone(LIVE);
    newer.cards[0]!.fetchedAt = '2026-09-30T12:31:00.000Z';
    newer.cards[0]!.rows[0]!.used = 22;
    state = newer;
    await s.pollOnce();
    expect(s.snapshot().accounts.a.fiveHour?.usedPct).toBe(22);
    state = LIVE; // an older card again must not resurrect the dropped turn values
    await s.pollOnce();
    expect(s.snapshot().accounts.a.fiveHour?.usedPct).toBe(13);
  });

  it('a card that recovers (setup_needed → ok) gets fresh status and fetchedAt', async () => {
    const down = structuredClone(LIVE);
    down.cards[0] = { id: 'claude:main', status: 'setup_needed', rows: [] } as never;
    let state: unknown = down;
    const s = svc(async () => ({ ok: true, json: async () => state }));
    await s.pollOnce();
    expect(s.snapshot().accounts.a).toMatchObject({ status: 'down', fetchedAt: null });
    state = LIVE;
    await s.pollOnce();
    expect(s.snapshot().accounts.a).toMatchObject({ status: 'ok', fetchedAt: '2026-09-30T12:27:01.422Z' });
    expect(s.snapshot().accounts.a.weekly?.usedPct).toBe(7);
  });

  it('start() polls on an interval and stop() halts it', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => LIVE }));
    const s = svc(fetchFn);
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
