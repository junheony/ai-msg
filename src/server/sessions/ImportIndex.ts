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
