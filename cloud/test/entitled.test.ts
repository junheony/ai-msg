import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { entitledState } from '../src/entitled';

const NOW = 1_800_000_000_000;
let seq = 0;
async function user(): Promise<string> {
  const id = `u-ent-${seq++}`;
  await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, `${id}@example.test`, NOW).run();
  return id;
}
const trial = (u: string, endsAt: number) => env.DB.prepare('INSERT INTO trials (user_id, started_at, ends_at) VALUES (?, ?, ?)').bind(u, NOW - 1000, endsAt).run();
const grant = (u: string, until: number) => env.DB.prepare("INSERT INTO grants (user_id, plan, until) VALUES (?, 'comp', ?)").bind(u, until).run();

describe('entitledState (trial + comp)', () => {
  it('trial and comp: larger until wins; expired → none', async () => {
    const none = await user();
    expect(await entitledState(env.DB, none, NOW)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const t = await user();
    await trial(t, NOW + 5000);
    expect(await entitledState(env.DB, t, NOW)).toEqual({ plan: 'trial', st: 'trialing', untilMs: NOW + 5000 });
    expect(await entitledState(env.DB, t, NOW + 5000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const both = await user();
    await trial(both, NOW + 5000);
    await grant(both, NOW + 9000);
    expect(await entitledState(env.DB, both, NOW)).toEqual({ plan: 'comp', st: 'active', untilMs: NOW + 9000 });
    expect(await entitledState(env.DB, both, NOW + 9000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const trialWins = await user();
    await trial(trialWins, NOW + 9000);
    await grant(trialWins, NOW + 5000);
    expect(await entitledState(env.DB, trialWins, NOW)).toEqual({ plan: 'trial', st: 'trialing', untilMs: NOW + 9000 });
    expect(await entitledState(env.DB, trialWins, NOW + 9000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const expiredTrial = await user();
    await trial(expiredTrial, NOW - 1);
    await grant(expiredTrial, NOW + 100);
    expect(await entitledState(env.DB, expiredTrial, NOW)).toEqual({ plan: 'comp', st: 'active', untilMs: NOW + 100 });
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type SubRow = { status: string; period_end?: number | null; canceled_at?: number | null; past_due_since?: number | null; scheduled_cancel?: number; last_event_at?: number };
let subSeq = 0;
async function subscription(u: string, r: SubRow): Promise<string> {
  const id = `sub_ent_${subSeq++}`;
  await env.DB.prepare('INSERT INTO subscriptions (id, user_id, customer_id, status, period_end, canceled_at, past_due_since, scheduled_cancel, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, u, `ctm_${id}`, r.status, r.period_end ?? null, r.canceled_at ?? null, r.past_due_since ?? null, r.scheduled_cancel ?? 0, r.last_event_at ?? NOW - 1000, NOW).run();
  return id;
}

describe('entitledState (subscriptions)', () => {
  it('active / trialing: period_end + 48 h, also with a scheduled cancel', async () => {
    const a = await user();
    await subscription(a, { status: 'active', period_end: NOW + DAY });
    expect(await entitledState(env.DB, a, NOW)).toEqual({ plan: 'pro', st: 'active', untilMs: NOW + DAY + 48 * HOUR });
    expect(await entitledState(env.DB, a, NOW + DAY + 47 * HOUR)).toMatchObject({ plan: 'pro' });
    expect(await entitledState(env.DB, a, NOW + DAY + 48 * HOUR)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const t = await user();
    await subscription(t, { status: 'trialing', period_end: NOW + DAY, scheduled_cancel: 1 });
    expect(await entitledState(env.DB, t, NOW)).toEqual({ plan: 'pro', st: 'trialing', untilMs: NOW + DAY + 48 * HOUR });
  });

  it('past_due: past_due_since + 7 days', async () => {
    const u = await user();
    await subscription(u, { status: 'past_due', period_end: NOW - DAY, past_due_since: NOW - DAY });
    expect(await entitledState(env.DB, u, NOW)).toEqual({ plan: 'pro', st: 'past_due', untilMs: NOW + 6 * DAY });
  });

  it('canceled / paused end at canceled_at (else last event); a scheduled cancel keeps period_end + 48 h unless fully refunded', async () => {
    const c = await user();
    await subscription(c, { status: 'canceled', period_end: NOW + DAY, canceled_at: NOW - 1 });
    expect(await entitledState(env.DB, c, NOW)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const p = await user();
    await subscription(p, { status: 'paused', last_event_at: NOW + 500 });
    expect(await entitledState(env.DB, p, NOW)).toEqual({ plan: 'pro', st: 'canceled', untilMs: NOW + 500 });

    const s = await user();
    await subscription(s, { status: 'canceled', period_end: NOW, canceled_at: NOW, scheduled_cancel: 1 });
    expect(await entitledState(env.DB, s, NOW)).toEqual({ plan: 'pro', st: 'canceled', untilMs: NOW + 48 * HOUR });

    const r = await user();
    const rid = await subscription(r, { status: 'canceled', period_end: NOW, canceled_at: NOW, scheduled_cancel: 1 });
    await env.DB.prepare("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, ?)").bind(`adj_${rid}`, rid, NOW).run();
    expect(await entitledState(env.DB, r, NOW)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });
  });

  it('largest until wins across sources; a tie shows pro over comp over trial', async () => {
    const u = await user();
    await trial(u, NOW + 3 * DAY);
    await subscription(u, { status: 'active', period_end: NOW });
    expect(await entitledState(env.DB, u, NOW)).toEqual({ plan: 'trial', st: 'trialing', untilMs: NOW + 3 * DAY });

    const tie = await user();
    await trial(tie, NOW + 48 * HOUR);
    await grant(tie, NOW + 48 * HOUR);
    await subscription(tie, { status: 'active', period_end: NOW });
    expect(await entitledState(env.DB, tie, NOW)).toEqual({ plan: 'pro', st: 'active', untilMs: NOW + 48 * HOUR });

    const tie2 = await user();
    await trial(tie2, NOW + 1000);
    await grant(tie2, NOW + 1000);
    expect(await entitledState(env.DB, tie2, NOW)).toMatchObject({ plan: 'comp' });
  });
});
