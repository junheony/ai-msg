/**
 * MSG 허브 push: sockets that sent `hub_watch{on:true}` get `hub_status` at once and then whenever the aggregated status
 * changes (`generated_at` moves). One timer for all watchers; none while nobody watches. Read-only: nothing here
 * triggers a source, it only re-reads HubStatusService (which caches, so a tick is cheap).
 */
import type { ServerMessage } from '../../shared/protocol';
import type { HubStatusService } from './status';

export const HUB_WATCH_INTERVAL_MS = 15_000;

export interface HubWatch<W> {
  watch(w: W): void;
  unwatch(w: W): void;
  /** How many sockets are watching (tests). */
  size(): number;
  stop(): void;
}

export function createHubWatch<W>({ status, send, intervalMs = HUB_WATCH_INTERVAL_MS }: { status: HubStatusService; send: (w: W, msg: ServerMessage) => void; intervalMs?: number }): HubWatch<W> {
  const watchers = new Set<W>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSent: string | null = null;
  let ticking = false;
  /** New watchers owed a first send; one that arrives mid-tick is served when that tick ends (or by a follow-up pass). */
  const pending = new Set<W>();
  const tick = async (force: W | null): Promise<void> => {
    if (force) pending.add(force);
    if (ticking) return;
    ticking = true;
    try {
      while (true) {
        const owed = [...pending].filter((w) => watchers.has(w));
        pending.clear();
        try {
          const s = await status.status();
          for (const w of owed) send(w, { type: 'hub_status', status: s });
          if (s.generated_at !== lastSent) {
            lastSent = s.generated_at;
            for (const w of watchers) if (!owed.includes(w)) send(w, { type: 'hub_status', status: s });
          }
        } catch {
          /* a failed pass leaves the previous status on screen; the UI's staleness poll covers it */
        }
        if (pending.size === 0) break;
      }
    } finally { ticking = false; }
  };
  const stop = (): void => { if (timer) clearInterval(timer); timer = null; };
  return {
    watch(w) {
      if (watchers.has(w)) return;
      watchers.add(w);
      void tick(w);
      timer ??= setInterval(() => { void tick(null); }, intervalMs);
    },
    unwatch(w) { watchers.delete(w); pending.delete(w); if (watchers.size === 0) stop(); },
    size: () => watchers.size,
    stop() { stop(); watchers.clear(); pending.clear(); },
  };
}
