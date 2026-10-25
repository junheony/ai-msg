export type Entitled = {
  plan: 'trial' | 'comp' | 'pro' | 'none';
  st: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
  untilMs: number;
};

const HOUR = 3_600_000;
/** active/trialing: Paddle renews at `period_end`; the renewal webhook may lag, so Pro holds 48 h past it (D15). */
export const RENEWAL_GRACE_MS = 48 * HOUR;
/** past_due: Paddle's dunning retries; Pro holds 7 days from the first past_due event (D15). */
export const PAST_DUE_GRACE_MS = 7 * 24 * HOUR;

type SubRow = {
  status: string;
  period_end: number | null;
  canceled_at: number | null;
  past_due_since: number | null;
  scheduled_cancel: number;
  last_event_at: number;
  refunded: number;
};

/** The `until` one subscription grants, or `null` when it grants nothing. */
function subscriptionUntil(s: SubRow): number | null {
  if (s.status === 'active' || s.status === 'trialing') return s.period_end === null ? null : s.period_end + RENEWAL_GRACE_MS;
  if (s.status === 'past_due') return s.past_due_since === null ? null : s.past_due_since + PAST_DUE_GRACE_MS;
  const end = s.canceled_at ?? s.last_event_at;
  // A scheduled cancel that has now happened keeps the paid period; a full refund/chargeback ends it at once.
  if (s.status === 'canceled' && s.scheduled_cancel === 1 && !s.refunded && s.period_end !== null) return Math.max(end, s.period_end + RENEWAL_GRACE_MS);
  return end;
}

const RANK: Record<Entitled['plan'], number> = { pro: 3, comp: 2, trial: 1, none: 0 };

/**
 * The relay entitlement: the largest `until` still in the future across trial (`trials.ends_at`), comp grants
 * (`grants.until`) and Paddle subscriptions (contract "이용권 계산"). On a tie Pro wins over comp over trial.
 */
export async function entitledState(db: D1Database, userId: string, nowMs: number): Promise<Entitled> {
  const [trial, grant, subs] = await db.batch<{ until: number } & SubRow>([
    db.prepare('SELECT ends_at AS until FROM trials WHERE user_id = ?').bind(userId),
    db.prepare('SELECT until FROM grants WHERE user_id = ?').bind(userId),
    db.prepare(`SELECT s.status, s.period_end, s.canceled_at, s.past_due_since, s.scheduled_cancel, s.last_event_at,
      EXISTS (SELECT 1 FROM refunds r WHERE r.subscription_id = s.id AND r.full = 1) AS refunded
      FROM subscriptions s WHERE s.user_id = ?`).bind(userId),
  ]);
  const candidates: Entitled[] = [];
  const t = trial!.results[0]?.until;
  const g = grant!.results[0]?.until;
  if (t !== undefined && t > nowMs) candidates.push({ plan: 'trial', st: 'trialing', untilMs: t });
  if (g !== undefined && g > nowMs) candidates.push({ plan: 'comp', st: 'active', untilMs: g });
  for (const s of subs!.results) {
    const until = subscriptionUntil(s);
    if (until === null || until <= nowMs) continue;
    const st: Entitled['st'] = s.status === 'active' || s.status === 'trialing' || s.status === 'past_due' ? s.status : 'canceled';
    candidates.push({ plan: 'pro', st, untilMs: until });
  }
  return candidates.reduce<Entitled>(
    (best, e) => (e.untilMs > best.untilMs || (e.untilMs === best.untilMs && RANK[e.plan] > RANK[best.plan]) ? e : best),
    { plan: 'none', st: 'none', untilMs: 0 },
  );
}
