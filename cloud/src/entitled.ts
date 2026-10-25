export type Entitled = {
  plan: 'trial' | 'comp' | 'pro' | 'none';
  st: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
  untilMs: number;
};

/**
 * The relay entitlement: the largest `until` still in the future across its sources. This Task knows the
 * trial (`trials.ends_at`) and comp grants (`grants.until`); Task 9 adds subscriptions (contract "이용권 계산").
 */
export async function entitledState(db: D1Database, userId: string, nowMs: number): Promise<Entitled> {
  const [trial, grant] = await db.batch<{ until: number }>([
    db.prepare('SELECT ends_at AS until FROM trials WHERE user_id = ?').bind(userId),
    db.prepare('SELECT until FROM grants WHERE user_id = ?').bind(userId),
  ]);
  const candidates: Entitled[] = [];
  const t = trial!.results[0]?.until;
  const g = grant!.results[0]?.until;
  if (t !== undefined && t > nowMs) candidates.push({ plan: 'trial', st: 'trialing', untilMs: t });
  if (g !== undefined && g > nowMs) candidates.push({ plan: 'comp', st: 'active', untilMs: g });
  return candidates.reduce<Entitled>((best, e) => (e.untilMs > best.untilMs ? e : best), { plan: 'none', st: 'none', untilMs: 0 });
}
