import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import wranglerSrc from '../wrangler.jsonc?raw';
import worker, { deps } from '../src/index';
import { liveSubscription } from '../src/billing';
import { runCleanup } from '../src/cleanup';
import type { PaddleApi } from '../src/paddle/api';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/**
 * A clock far in the past: rows other tests write carry real timestamps, so to this clock they are all fresh and
 * only the rows seeded here can expire — the counts below are exact whatever else is in D1.
 */
const NOW = Date.UTC(2001, 0, 1);

class FakePaddle implements PaddleApi {
  calls: string[] = [];
  constructor(private readonly fail = false, private readonly status = 500) {}
  async cancelSubscription(id: string): Promise<void> {
    this.calls.push(id);
    if (this.fail) throw Object.assign(new Error(`paddle cancel ${this.status}`), { status: this.status });
  }
  async portalSession(): Promise<{ url: string }> { throw new Error('unused'); }
}
const fakePaddle = (fail = false, status = 500) => new FakePaddle(fail, status);

const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
const n = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<number>('n'))!;
let seq = 0;

async function seedUser(): Promise<string> {
  const id = `u_clean${seq++}`;
  await run('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)', id, `${id}@example.test`, NOW);
  return id;
}

/** For every table, one row past its keep time and one still within it. Returns the host whose pairings are checked. */
async function seedExpiredAndFresh(): Promise<string> {
  const u1 = await seedUser();
  const u2 = await seedUser();
  const host = `h_clean${seq++}`;
  await run('INSERT INTO hosts (id, user_id, name, host_pub, token_hash, ui_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', host, u1, 'M', 'pub', `th_${host}`, '1.0.0', NOW);
  const s = seq++;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?), (?, ?, ?)').bind(`ml_old${s}`, 'x@example.test', NOW - 2 * DAY, `ml_new${s}`, 'x@example.test', NOW - HOUR),
    env.DB.prepare('INSERT INTO relay_tickets (ticket_hash, device_id, host_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)')
      .bind(`rt_old${s}`, 'd', host, u1, NOW - 2 * HOUR, `rt_new${s}`, 'd', host, u1, NOW - 30 * MIN),
    env.DB.prepare('INSERT INTO rate (key, window_start, count) VALUES (?, ?, 1), (?, ?, 1)').bind(`r_old${s}`, NOW - 3 * DAY, `r_new${s}`, NOW - DAY),
    env.DB.prepare("INSERT INTO pairings (id, host_id, claim_hash, state, expires_at) VALUES (?, ?, 'c', 'expired', ?), (?, ?, 'c', 'confirmed', ?), (?, ?, 'c', 'open', ?)")
      .bind(`p_old_free${s}`, host, NOW - 2 * DAY, `p_old_used${s}`, host, NOW - 2 * DAY, `p_new${s}`, host, NOW - HOUR),
    env.DB.prepare("INSERT INTO devices (id, user_id, host_id, pairing_id, name, pub, token_hash, state, created_at) VALUES (?, ?, ?, ?, 'P', 'pub', ?, 'active', ?)")
      .bind(`d_clean${s}`, u1, host, `p_old_used${s}`, `dt_${s}`, NOW),
    env.DB.prepare("INSERT INTO host_links (device_code_hash, user_code, host_name, host_pub, ui_version, state, expires_at) VALUES (?, ?, 'M', 'p', '1.0.0', 'pending', ?), (?, ?, 'M', 'p', '1.0.0', 'pending', ?)")
      .bind(`hl_old${s}`, `UC-OLD-${s}`, NOW - 2 * DAY, `hl_new${s}`, `UC-NEW-${s}`, NOW - HOUR),
    env.DB.prepare('INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?), (?, ?, ?)').bind(`ws_old${s}`, u1, NOW - 1, `ws_new${s}`, u1, NOW + HOUR),
    env.DB.prepare("INSERT INTO outbox (to_addr, subject, body, created_at) VALUES ('x@example.test', 's', 'b', ?), ('x@example.test', 's', 'b', ?)").bind(NOW - 2 * DAY, NOW - HOUR),
    env.DB.prepare("INSERT INTO checkout_intents (user_id, plan, expires_at) VALUES (?, 'pro-monthly', ?), (?, 'pro-monthly', ?)").bind(u1, NOW - 1, u2, NOW + HOUR),
    env.DB.prepare("INSERT INTO paddle_events (event_id, event_type, occurred_at, received_at, outcome) VALUES (?, 't', 0, ?, 'applied'), (?, 't', 0, ?, 'applied')").bind(`ev_old${s}`, NOW - 91 * DAY, `ev_new${s}`, NOW - 89 * DAY),
    env.DB.prepare("INSERT INTO ops_alerts (kind, ref, detail, created_at, resolved_at) VALUES ('unmatched', 'a', 'resolved', ?, ?), ('unmatched', 'b', 'old', ?, NULL), ('unmatched', 'c', 'open', ?, NULL)")
      .bind(NOW - HOUR, NOW - MIN, NOW - 91 * DAY, NOW - HOUR),
  ]);
  return host;
}

const realDeps = { ...deps };
afterEach(() => { Object.assign(deps, realDeps); vi.restoreAllMocks(); });

describe('runCleanup', () => {
  it('removes only expired rows and keeps pairings that devices still point to', async () => {
    const host = await seedExpiredAndFresh();
    const counts = await runCleanup(env, NOW, { paddle: fakePaddle() });
    expect(counts).toMatchObject({ magic_links: 1, relay_tickets: 1, rate: 1, pairings: 1, host_links: 1, web_sessions: 1, outbox: 1, checkout_intents: 1, paddle_events: 1, ops_alerts: 2 });
    expect(await n('SELECT count(*) AS n FROM pairings WHERE host_id = ?', host)).toBe(2); // the expired one a device points to stays
    expect(Object.values(await runCleanup(env, NOW, { paddle: fakePaddle() })).every((v) => v === 0)).toBe(true);
  });

  it('retries a pending refund cancel and records success', async () => {
    const s = seq++;
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, NULL, ?)", `adj_a${s}`, `sub_a${s}`, NOW - 11 * MIN);
    // A failed claim (negative, older than 10 min) is retried; a fresh claim (a delivery still running) and a recent event are not.
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, ?, ?)", `adj_b${s}`, `sub_b${s}`, -(NOW - 20 * MIN), NOW - 20 * MIN);
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, ?, ?)", `adj_c${s}`, `sub_c${s}`, -(NOW - MIN), NOW - 20 * MIN);
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, NULL, ?)", `adj_d${s}`, `sub_d${s}`, NOW - MIN);
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 0, NULL, ?)", `adj_e${s}`, `sub_e${s}`, NOW - HOUR);
    const paddle = fakePaddle();
    const counts = await runCleanup(env, NOW, { paddle });
    expect(paddle.calls.sort()).toEqual([`sub_a${s}`, `sub_b${s}`]);
    expect(counts).toMatchObject({ refund_cancel_done: 2, refund_cancel_failed: 0 });
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_a${s}`).first('cancel_done_at')).toBe(NOW);
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_b${s}`).first('cancel_done_at')).toBe(NOW);
    const again = fakePaddle();
    await runCleanup(env, NOW + HOUR, { paddle: again });
    expect(again.calls.sort()).toEqual([`sub_c${s}`, `sub_d${s}`]); // now old enough
  });

  it('a failing retry keeps the claim and alerts once a day', async () => {
    const s = seq++;
    const sub = `sub_f${s}`;
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'chargeback', 'approved', 1, NULL, ?)", `adj_f${s}`, sub, NOW - HOUR);
    const alerts = () => n("SELECT count(*) AS n FROM ops_alerts WHERE kind = 'refund_cancel_failed' AND ref = ?", sub);
    const p1 = fakePaddle(true);
    expect(await runCleanup(env, NOW, { paddle: p1 })).toMatchObject({ refund_cancel_failed: 1 });
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_f${s}`).first('cancel_done_at')).toBe(-NOW);
    expect(await alerts()).toBe(1);
    const p2 = fakePaddle(true);
    await runCleanup(env, NOW + 11 * MIN, { paddle: p2 });
    expect(p2.calls).toEqual([sub]);
    expect(await alerts()).toBe(1); // same day: no second alert
    await runCleanup(env, NOW + DAY + 20 * MIN, { paddle: fakePaddle(true) });
    expect(await alerts()).toBe(2);
  });

  it('a refund cancel is done when the subscription is already canceled locally or unknown to Paddle (404)', async () => {
    const s = seq++;
    await run("INSERT INTO subscriptions (id, status, last_event_at, updated_at) VALUES (?, 'canceled', ?, ?)", `sub_gone${s}`, NOW - DAY, NOW - DAY);
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, ?, ?)", `adj_g${s}`, `sub_gone${s}`, -(NOW - HOUR), NOW - HOUR);
    const p1 = fakePaddle(true);
    expect(await runCleanup(env, NOW, { paddle: p1 })).toMatchObject({ refund_cancel_done: 1, refund_cancel_failed: 0 });
    expect(p1.calls).toEqual([]); // no call needed
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_g${s}`).first('cancel_done_at')).toBe(NOW);

    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, NULL, ?)", `adj_404${s}`, `sub_404${s}`, NOW - HOUR);
    const p2 = fakePaddle(true, 404);
    expect(await runCleanup(env, NOW, { paddle: p2 })).toMatchObject({ refund_cancel_done: 1, refund_cancel_failed: 0 });
    expect(p2.calls).toEqual([`sub_404${s}`]);
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_404${s}`).first('cancel_done_at')).toBe(NOW);
    expect(await n("SELECT count(*) AS n FROM ops_alerts WHERE kind = 'refund_cancel_failed' AND ref IN (?, ?)", `sub_gone${s}`, `sub_404${s}`)).toBe(0);
  });

  it('a refund cancel still failing 30 days after its event is given up with one last alert', async () => {
    const s = seq++;
    const sub = `sub_old${s}`;
    await run("INSERT INTO refunds (adjustment_id, subscription_id, action, status, full, cancel_done_at, last_event_at) VALUES (?, ?, 'refund', 'approved', 1, ?, ?)", `adj_old${s}`, sub, -(NOW - DAY), NOW - 31 * DAY);
    const p = fakePaddle(true);
    expect(await runCleanup(env, NOW, { paddle: p })).toMatchObject({ refund_cancel_gave_up: 1, refund_cancel_failed: 0 });
    expect(p.calls).toEqual([]);
    expect(await env.DB.prepare('SELECT cancel_done_at FROM refunds WHERE adjustment_id = ?').bind(`adj_old${s}`).first('cancel_done_at')).toBe(0);
    const alerts = await env.DB.prepare("SELECT detail FROM ops_alerts WHERE kind = 'refund_cancel_failed' AND ref = ?").bind(sub).all<{ detail: string }>();
    expect(alerts.results).toHaveLength(1);
    expect(alerts.results[0]!.detail).toMatch(/gave up/);
    const later = fakePaddle(true);
    expect(await runCleanup(env, NOW + 2 * DAY, { paddle: later })).toMatchObject({ refund_cancel_gave_up: 0 });
    expect(later.calls).not.toContain(sub); // (an earlier test's failing row may still be retried)
  });

  it('a failing step is counted as -1 in errors; the other steps still run', async () => {
    const s = seq++;
    await run('INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)', `ml_err${s}`, 'x@example.test', NOW - 2 * DAY);
    await run('INSERT INTO outbox (to_addr, subject, body, created_at) VALUES (?, ?, ?, ?)', 'x@example.test', 's', 'b', NOW - 2 * DAY);
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => { if (sql.includes('FROM magic_links')) throw new Error('D1_ERROR boom'); return target.prepare(sql); };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = await runCleanup({ ...env, DB: db }, NOW, { paddle: fakePaddle() });
    expect(counts).toMatchObject({ magic_links: -1, errors: 1, outbox: 1 });
    expect(await n('SELECT count(*) AS n FROM magic_links WHERE token_hash = ?', `ml_err${s}`)).toBe(1);
    expect(errs.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/ml_err|@/);
  });

  it('stale customer links: alert after 24 h once a day, delete after 30 days', async () => {
    const s = seq++;
    await run('INSERT INTO paddle_link_pending (customer_id, user_id, created_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
      `ctm_stale${s}`, 'u_x', NOW - 25 * HOUR, `ctm_old${s}`, 'u_y', NOW - 31 * DAY, `ctm_new${s}`, 'u_z', NOW - HOUR);
    const counts = await runCleanup(env, NOW, { paddle: fakePaddle() });
    expect(counts).toMatchObject({ paddle_link_pending: 1, customer_pending_stale: 1 });
    expect(await n("SELECT count(*) AS n FROM ops_alerts WHERE kind = 'customer_pending_stale' AND ref = ?", `ctm_stale${s}`)).toBe(1);
    expect(await n('SELECT count(*) AS n FROM paddle_link_pending WHERE customer_id IN (?, ?)', `ctm_stale${s}`, `ctm_new${s}`)).toBe(2);
    expect(await runCleanup(env, NOW + HOUR, { paddle: fakePaddle() })).toMatchObject({ customer_pending_stale: 0 });
    expect(await runCleanup(env, NOW + DAY + HOUR, { paddle: fakePaddle() })).toMatchObject({ customer_pending_stale: 2 }); // the stale one again + the new one, now 25 h old
  });

  it('subscriptions left active past their period (a missed cancel webhook): not live, alert once a day', async () => {
    const u = await seedUser();
    const ins = (id: string, status: string, periodEnd: number | null, pastDueSince: number | null, user: string | null = null) =>
      run('INSERT INTO subscriptions (id, user_id, status, period_end, past_due_since, last_event_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user, status, periodEnd, pastDueSince, NOW - 40 * DAY, NOW - 40 * DAY);
    const s = seq++;
    await ins(`sub_s_active${s}`, 'active', NOW - 4 * DAY, null, u);
    await ins(`sub_s_trial${s}`, 'trialing', NOW - 4 * DAY, null);
    await ins(`sub_s_due${s}`, 'past_due', NOW - 10 * DAY, NOW - 8 * DAY);
    await ins(`sub_ok_active${s}`, 'active', NOW - DAY, null); // inside the 48 h renewal grace
    await ins(`sub_ok_due${s}`, 'past_due', NOW - 3 * DAY, NOW - 6 * DAY);
    await ins(`sub_ok_canceled${s}`, 'canceled', NOW - 40 * DAY, null);

    expect(await liveSubscription(env.DB, u, NOW)).toBe(false);
    expect(await liveSubscription(env.DB, u, NOW - 3 * DAY)).toBe(true); // 1 day past period_end: still in the grace

    const counts = await runCleanup(env, NOW, { paddle: fakePaddle() });
    expect(counts).toMatchObject({ subscription_stale: 3 });
    const refs = await env.DB.prepare("SELECT ref FROM ops_alerts WHERE kind = 'subscription_stale' AND ref LIKE ? ORDER BY ref").bind(`sub_%${s}`).all<{ ref: string }>();
    expect(refs.results.map((r) => r.ref)).toEqual([`sub_s_active${s}`, `sub_s_due${s}`, `sub_s_trial${s}`]);
    expect(await runCleanup(env, NOW + HOUR, { paddle: fakePaddle() })).toMatchObject({ subscription_stale: 0 });
  });

  it('logs counts only', async () => {
    await seedExpiredAndFresh();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const counts = await runCleanup(env, NOW, { paddle: fakePaddle() });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({ cron: 'cleanup', ...counts });
    expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(true);
    expect(lines[0]).not.toMatch(/@|u_clean|h_clean|sub_|ctm_/);
  });
});

describe('scheduled', () => {
  it('the daily cron runs the cleanup', async () => {
    const paddle = fakePaddle();
    deps.paddle = () => paddle;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '17 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('{"cron":"cleanup"'))).toBe(true);
  });

  it('wrangler.jsonc schedules it once a day', () => {
    expect(wranglerSrc).toMatch(/"triggers":\s*\{\s*"crons":\s*\["17 3 \* \* \*"\]\s*\}/);
  });
});
