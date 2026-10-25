import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntitlementRes } from '../../shared/cloud/api-types';
import { getCloudStatus, refreshPlan } from '../cloudApi';
import { formatDateTime, ui } from '../i18n';

const DAY = 86_400_000;
const date = (ms: number) => formatDateTime(ms, { dateStyle: 'medium' });

/** The plan row's text. A plan whose time is over reads as Community (the cloud says `none` on its next answer). */
export function planText(e: EntitlementRes, now: number): string {
  const T = ui().cloud;
  const live = e.untilMs > now;
  if (e.plan === 'none' || !live) return T.planNone;
  if (e.plan === 'trial') return T.planTrial(Math.max(1, Math.ceil((e.untilMs - now) / DAY)));
  if (e.plan === 'comp') return T.planComp(date(e.untilMs));
  if (e.st === 'past_due') return T.planPastDue(date(e.untilMs));
  if (e.st === 'canceled') return T.planCanceled(date(e.untilMs));
  return T.planActive;
}

/**
 * Settings › Accounts: the cloud plan (display only — nothing on this Mac is locked by it, D6). Opening asks the cloud
 * once; not linked, cloud off or an error → no row. `readOnly` (the phone through the relay, where plan/refresh is
 * refused): the plan comes from GET /api/cloud/status and there is no Refresh button.
 */
export function CloudSection({ readOnly = false, now = Date.now }: { readOnly?: boolean; now?: () => number }) {
  const T = ui().cloud;
  const [plan, setPlan] = useState<EntitlementRes | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const p = readOnly ? (await getCloudStatus()).plan : await refreshPlan();
      if (alive.current) setPlan(p);
    } catch {
      if (alive.current) setPlan(null);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [readOnly]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  if (!plan) return null;
  return (
    <>
      <div className="settings-row" data-testid="plan-row">
        <span>{T.planLabel}</span>
        <span>{planText(plan, now())}</span>
        {!readOnly && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void load()}>{busy ? T.refreshing : T.refresh}</button>
        )}
      </div>
      <div className="settings-hint"><p>{T.proLine} · {T.checkedAt(formatDateTime(plan.checkedAt))}</p></div>
    </>
  );
}
