import { describe, expect, it } from 'vitest';
import type { GrokBilling } from '../../shared/usage-types';
import type { GrokBillingProbe } from '../engine/grokBilling';
import { GROK_BILLING_BACKOFF_MAX_MS, GROK_BILLING_BACKOFF_MS, GROK_BILLING_INTERVAL_MS, GrokBillingPoller } from './GrokBillingPoller';

const T0 = Date.parse('2026-10-18T10:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const billing = (fetchedMs: number, endMs = T0 + 7 * 86_400_000): GrokBilling => ({
  usedPct: 1, windowStart: iso(endMs - 7 * 86_400_000), windowEnd: iso(endMs), tier: 'SuperGrok Heavy', fetchedAt: iso(fetchedMs),
});

function setup(answers: Array<GrokBillingProbe | (() => GrokBillingProbe)>, o: { busy?: () => boolean; stored?: GrokBilling | null } = {}) {
  let now = T0;
  let stored: GrokBilling | null = o.stored ?? null;
  const probes: number[] = [];
  const logs: string[] = [];
  const notes: GrokBilling[] = [];
  const poller = new GrokBillingPoller({
    probe: async (_signal: AbortSignal) => {
      probes.push(now);
      const a = answers.length > 1 ? answers.shift()! : answers[0]!;
      return typeof a === 'function' ? a() : a;
    },
    tracker: {
      noteBilling: (account, b) => { expect(account).toBe('x1'); stored = b; notes.push(b); },
      billingOf: () => stored,
    },
    busy: o.busy ?? (() => false),
    now: () => now,
    log: (l) => logs.push(l),
  });
  return {
    poller, probes, logs, notes,
    at: (ms: number) => { now = ms; },
    setStored: (b: GrokBilling | null) => { stored = b; },
  };
}

describe('GrokBillingPoller', () => {
  it('reads once at start, then not again until 15 minutes after the last read', async () => {
    const s = setup([() => ({ kind: 'ok', billing: billing(T0) })]);
    await s.poller.tick();
    expect(s.probes).toEqual([T0]);
    expect(s.notes).toHaveLength(1);
    s.at(T0 + 14 * MIN);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
    s.at(T0 + GROK_BILLING_INTERVAL_MS);
    await s.poller.tick();
    expect(s.probes).toHaveLength(2);
  });

  it('a turn\'s fresh reading (fetchedAt) counts as the last read', async () => {
    const s = setup([{ kind: 'ok', billing: billing(T0) }], { stored: billing(T0 - 5 * MIN) });
    await s.poller.tick();
    expect(s.probes).toHaveLength(0);
    s.at(T0 + 10 * MIN);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
  });

  it('the next tick after the period end reads again, even within 15 minutes', async () => {
    const end = T0 + 5 * MIN;
    const s = setup([{ kind: 'ok', billing: billing(T0, end) }], { stored: billing(T0, end) });
    await s.poller.tick();
    expect(s.probes).toHaveLength(0);
    s.at(end + 1);
    await s.poller.tick();
    expect(s.probes).toEqual([end + 1]);
    // After that read the stored end is still the old one, but the read came after it: not again.
    s.at(end + 2 * MIN);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
  });

  it('skipped while a Grok turn runs; the next free tick reads', async () => {
    let busy = true;
    const s = setup([{ kind: 'ok', billing: billing(T0) }], { busy: () => busy });
    await s.poller.tick();
    expect(s.probes).toHaveLength(0);
    busy = false;
    s.at(T0 + MIN);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
  });

  it.each(['no_bin', 'auth', 'unsupported'] as const)('%s stops it quietly with one log line', async (kind) => {
    const s = setup([{ kind, message: 'why' }]);
    await s.poller.tick();
    expect(s.poller.running).toBe(false);
    expect(s.logs).toEqual(['deck: Grok 구독 사용량 조회를 멈춤 — why']);
    s.at(T0 + 2 * GROK_BILLING_INTERVAL_MS);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
    expect(s.notes).toHaveLength(0);
  });

  it('other failures keep it going with backoff (1h, 2h, 4h), the same message logged once; a throwing probe counts as one', async () => {
    const s = setup([
      { kind: 'error', message: 'Grok 응답 없음' },
      { kind: 'blocked', message: 'grok inspect 거부' },
      { kind: 'blocked', message: 'grok inspect 거부' },
      () => { throw new Error('boom'); },
    ]);
    // 1st failure at T0; retries after 1h, then 2h, then 4h (review item 2's backoff).
    const ticks = [T0, T0 + 1 * 60 * MIN, T0 + 3 * 60 * MIN, T0 + 7 * 60 * MIN];
    for (const t of ticks) {
      s.at(t);
      await s.poller.tick();
    }
    expect(s.probes).toEqual(ticks);
    expect(s.poller.running).toBe(true);
    expect(s.logs).toEqual([
      'deck: Grok 구독 사용량 조회 실패 — Grok 응답 없음',
      'deck: Grok 구독 사용량 조회 실패 — grok inspect 거부',
      'deck: Grok 구독 사용량 조회 실패 — boom',
    ]);
  });

  it('review item 2: backoff doubles up to a 6-hour cap while failures continue', async () => {
    const s = setup([{ kind: 'error', message: 'boom' }]);
    let t = T0;
    s.at(t);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
    // Failures: 1h, 2h, 4h, then capped at 6h from then on.
    const steps = [GROK_BILLING_BACKOFF_MS, GROK_BILLING_BACKOFF_MS * 2, GROK_BILLING_BACKOFF_MAX_MS, GROK_BILLING_BACKOFF_MAX_MS];
    for (const step of steps) {
      t += step;
      s.at(t);
      await s.poller.tick();
    }
    expect(s.probes).toHaveLength(5);
  });

  it('review item 2: a fresh reading from elsewhere (a turn\'s) resets the backoff to the normal 15-minute cadence', async () => {
    const s = setup([
      { kind: 'error', message: 'boom' },
      () => ({ kind: 'ok', billing: billing(T0 + 10 * MIN) }),
    ]);
    s.at(T0);
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
    // A turn's own billing read lands in the tracker before the 1h backoff would fire.
    s.setStored(billing(T0 + 10 * MIN));
    s.at(T0 + 20 * MIN);
    await s.poller.tick();
    // The fresh fetchedAt resets the streak, so it is not due yet at +20min (interval is back to 15min from the fresh read).
    expect(s.probes).toHaveLength(1);
    s.at(T0 + 10 * MIN + GROK_BILLING_INTERVAL_MS);
    await s.poller.tick();
    expect(s.probes).toHaveLength(2);
  });

  it('one read at a time: a tick during a read shares it', async () => {
    let release!: () => void;
    const s = setup([{ kind: 'ok', billing: billing(T0) }]);
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new GrokBillingPoller({
      probe: async () => { s.probes.push(T0); await gate; return { kind: 'ok', billing: billing(T0) }; },
      tracker: { noteBilling: () => {}, billingOf: () => null },
      busy: () => false,
      now: () => T0,
      log: () => {},
    });
    const a = slow.tick();
    const b = slow.tick();
    release();
    await Promise.all([a, b]);
    expect(s.probes).toHaveLength(1);
  });

  it('start() reads right away; stop() ends it', async () => {
    const s = setup([{ kind: 'ok', billing: billing(T0) }]);
    s.poller.start();
    await s.poller.tick();
    expect(s.probes).toHaveLength(1);
    const stopped = s.poller.stop();
    expect(s.poller.running).toBe(false);
    await stopped;
  });

  it('review item 5: stop() aborts a read in flight and its returned promise resolves once that read ends', async () => {
    let sawAbort = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const poller = new GrokBillingPoller({
      probe: async (signal: AbortSignal) => {
        signal.addEventListener('abort', () => { sawAbort = true; });
        await gate;
        return { kind: 'ok', billing: billing(T0) };
      },
      tracker: { noteBilling: () => {}, billingOf: () => null },
      busy: () => false,
      now: () => T0,
      log: () => {},
    });
    const tickP = poller.tick();
    const stopP = poller.stop();
    expect(poller.running).toBe(false);
    expect(sawAbort).toBe(true);
    release();
    await Promise.all([tickP, stopP]);
  });
});
