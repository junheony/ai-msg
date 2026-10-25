import type { CloudStatus, EntitlementRes } from '../shared/cloud/api-types';

// The cloud calls of Settings › Accounts (/api/cloud/*). A failed request throws; the caller hides the row.

async function bodyOf<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const getCloudStatus = (): Promise<CloudStatus> => fetch('/api/cloud/status').then((r) => bodyOf<CloudStatus>(r));

/** Ask the cloud again (display only). `null` = this Mac is not linked. Through the relay this path is refused; use the status. */
export const refreshPlan = (): Promise<EntitlementRes | null> =>
  fetch('/api/cloud/plan/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => bodyOf<EntitlementRes | null>(r));
