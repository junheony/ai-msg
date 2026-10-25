import type { EntitlementRes } from '../../shared/cloud/api-types';
import { type CloudApi, CloudError } from './CloudApi';
import type { CloudState } from './CloudState';

const EVERY_MS = 6 * 3_600_000;
const JITTER_MS = 30 * 60_000;

/**
 * The plan shown in Settings › Accounts (`GET /v1/entitlement`, kept in `state.plan`). Display only: nothing on this
 * Mac is allowed or refused because of it — the cloud checks the entitlement itself for the relay (D6).
 *
 * - Not linked → no request, `null`.
 * - A failed fetch (network, 5xx, 429, a malformed answer) keeps the stored plan; the screen shows its `checkedAt`.
 *   Every failure goes to `onError` (the owner forgets the link on a 401).
 * - When `plan`·`st`·`untilMs` change to something still running, the relay is asked to recheck (a payment reaches the
 *   relay without waiting for its next alarm).
 */
export class PlanView {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<EntitlementRes | null> | null = null;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly random: () => number;

  constructor(private readonly o: {
    api: Pick<CloudApi, 'entitlement'>;
    state: CloudState;
    relay: { recheck(): void };
    now?: () => number;
    setTimer?: typeof setTimeout;
    random?: () => number;
    /** `token` = the one the failed request carried. */
    onError?: (err: unknown, token: string) => void;
    /** After a new plan is stored. */
    onChange?: () => void;
  }) {
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? setTimeout;
    this.random = o.random ?? Math.random;
  }

  /** When linked: one fetch now, then every 6 h ±30 min until `stop()`. */
  start(): void {
    this.stop();
    if (!this.o.state.get().hostToken) return;
    void this.refresh();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get(): EntitlementRes | null {
    const d = this.o.state.get();
    return d.hostToken ? d.plan : null;
  }

  /** The fresh plan, the stored one when the cloud did not answer, or `null` when not linked (or the token was refused). */
  refresh(): Promise<EntitlementRes | null> {
    this.inflight ??= this.fetchPlan().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private schedule(): void {
    const delay = EVERY_MS + Math.round((this.random() * 2 - 1) * JITTER_MS);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.o.state.get().hostToken) return;
      void this.refresh();
      this.schedule();
    }, delay);
    this.timer.unref?.();
  }

  private async fetchPlan(): Promise<EntitlementRes | null> {
    const st = this.o.state;
    const token = st.get().hostToken;
    if (!token) return null;
    let next: EntitlementRes;
    try {
      next = await this.o.api.entitlement(token);
    } catch (err) {
      this.o.onError?.(err, token);
      return err instanceof CloudError && err.status === 401 ? null : this.get();
    }
    if (st.get().hostToken !== token) return this.get(); // unlinked or relinked meanwhile
    const prev = st.get().plan;
    const changed = !prev || prev.plan !== next.plan || prev.st !== next.st || prev.untilMs !== next.untilMs;
    await st.update({ plan: next });
    this.o.onChange?.();
    if (changed && next.untilMs > this.now()) this.o.relay.recheck();
    return next;
  }
}
