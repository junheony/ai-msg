/** The unfiltered SR snapshot (symbols, room status, feed health), polled once a minute while `enabled`. */
import { useEffect, useState } from 'react';
import type { SrSnapshot } from '../../../shared/sr-types';
import { liveSrApi, type SrApi } from './api';

export const SR_POLL_MS = 60_000;
export interface SrFeed { all: SrSnapshot | null; error: string | null }
export const EMPTY_SR_FEED: SrFeed = { all: null, error: null };

export function useSrFeed(api: SrApi = liveSrApi, enabled = true): SrFeed {
  const [feed, setFeed] = useState<SrFeed>(EMPTY_SR_FEED);
  useEffect(() => {
    if (!enabled) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const all = await api.sr(null); if (alive) setFeed({ all, error: null }); }
      catch (e: unknown) { if (alive) setFeed((f) => ({ all: f.all, error: e instanceof Error ? e.message : String(e) })); }
      finally { if (alive) timer = setTimeout(() => { void poll(); }, SR_POLL_MS); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, enabled]);
  return feed;
}
