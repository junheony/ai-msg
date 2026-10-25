import type { EntitlementRes } from '../../shared/cloud/api-types';

const PLANS: ReadonlySet<unknown> = new Set<EntitlementRes['plan']>(['pro', 'trial', 'comp', 'none']);
const PLAN_STATES: ReadonlySet<unknown> = new Set<EntitlementRes['st']>(['active', 'trialing', 'past_due', 'canceled', 'none']);
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 8.64e15;

/**
 * A plan as the cloud's `GET /v1/entitlement` answers it and as `state.json` keeps it: the known enum values and integer
 * ms (`checkedAt` > 0), extra fields dropped. Anything else → `null`.
 */
export function toEntitlement(v: unknown): EntitlementRes | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Partial<Record<keyof EntitlementRes, unknown>>;
  if (!PLANS.has(b.plan) || !PLAN_STATES.has(b.st) || !isMs(b.untilMs) || !isMs(b.checkedAt) || b.checkedAt === 0) return null;
  return { plan: b.plan as EntitlementRes['plan'], st: b.st as EntitlementRes['st'], untilMs: b.untilMs, checkedAt: b.checkedAt };
}
