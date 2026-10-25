import type { EntitlementRes } from '../../src/shared/cloud/api-types';
import { hostAuth } from './auth/tokens';
import { entitledState } from './entitled';
import { json, problem } from './http';
import { MINUTE, hit } from './rate';
import type { Ctx } from './router';

const PER_HOST_PER_MINUTE = 6;

/**
 * `GET /v1/entitlement` (host) — the plan for the settings screen. Display only and unsigned: the relay checks the
 * entitlement itself (tickets, room alarm), the Mac locks nothing with this. 6 per minute per host.
 */
export async function entitlement(c: Ctx): Promise<Response> {
  const host = await hostAuth(c.env, c.req);
  if (!host) return problem(401, 'unauthorized');
  if (!(await hit(c.env.DB, `ent:host:${host.id}`, PER_HOST_PER_MINUTE, MINUTE, c.nowMs))) return problem(429, 'rate_limited');
  const e = await entitledState(c.env.DB, host.userId, c.nowMs);
  return json(200, { plan: e.plan, st: e.st, untilMs: e.untilMs, checkedAt: c.nowMs } satisfies EntitlementRes);
}
