import type { SessionEntry } from '../../shared/session-types';

/** A read-only list of conversations made outside deck (Grok CLI, agy, Grok Bot), shaped like CodexRolloutIndex. */
export interface ImportIndex {
  /** Overlapping calls share one scan, plus at most one more after it. */
  refresh(): Promise<void>;
  /** `imported: true` entries as of the last refresh. */
  list(): SessionEntry[];
  lookup(id: string): SessionEntry | null;
  /** How long ago it was written outside deck, if within LIVE_ROLLOUT_MS; else null. */
  activeAgeMs(id: string, nowMs?: number): Promise<number | null>;
  /** Why deck must not continue it now because the other app is running it (rescanned first), or null. Absent = never. */
  heldReason?(id: string, nowMs?: number): Promise<string | null>;
}

/** The single-flight refresh CodexRolloutIndex uses: one scan at a time, plus at most one more after it. */
export function singleFlight(scan: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (!running) {
      running = scan().finally(() => { running = null; });
      return running;
    }
    return (again ??= running.catch(() => {}).then(() => { again = null; return refresh(); }));
  };
  return refresh;
}

/** `inner` while `on()` (asked on every call): off = never refreshed (nothing read), nothing listed or found. */
export function gated(inner: ImportIndex, on: () => boolean): ImportIndex {
  return {
    refresh: () => (on() ? inner.refresh() : Promise.resolve()),
    list: () => (on() ? inner.list() : []),
    lookup: (id) => (on() ? inner.lookup(id) : null),
    activeAgeMs: (id, nowMs) => (on() ? inner.activeAgeMs(id, nowMs) : Promise.resolve(null)),
    ...(inner.heldReason ? { heldReason: (id: string, nowMs?: number) => (on() ? inner.heldReason!(id, nowMs) : Promise.resolve(null)) } : {}),
  };
}
