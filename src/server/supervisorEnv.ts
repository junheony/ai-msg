import { SUPERVISOR_ENV_KEYS } from '../shared/accounts';

export { SUPERVISOR_ENV_KEYS };

/**
 * A copy of `env` without service-manager / deck supervision markers (`XPC_SERVICE_NAME`, `INVOCATION_ID`, …,
 * `DECK_SUPERVISOR`, `DECK_SUPERVISED`): every CLI child deck starts gets this, so nothing under it can pass for the
 * supervised server (plan ② Task 7, review item 7).
 */
export function stripSupervisorEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const k of SUPERVISOR_ENV_KEYS) delete out[k];
  return out;
}
