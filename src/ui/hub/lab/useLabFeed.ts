/** The lab summary, polled once a minute while `enabled`; shared by the source strip and the panel (one read, not two). */
import { useEffect, useState } from 'react';
import type { LabResponse } from '../../../shared/lab-types';
import { liveLabApi, type LabApi } from './api';

export const LAB_POLL_MS = 60_000;
export interface LabFeed { response: LabResponse | null; clientError: string | null; clientFailures: number }
export const EMPTY_LAB_FEED: LabFeed = { response: null, clientError: null, clientFailures: 0 };

export function useLabFeed(api: LabApi = liveLabApi, enabled = true): LabFeed {
  const [feed, setFeed] = useState<LabFeed>(EMPTY_LAB_FEED);
  useEffect(() => {
    if (!enabled) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.summary(); if (alive) setFeed({ response: next, clientError: null, clientFailures: 0 }); }
      catch { if (alive) setFeed((f) => ({ ...f, clientError: '요약 서버 연결 오류', clientFailures: f.clientFailures + 1 })); }
      finally { if (alive) timer = setTimeout(() => { void poll(); }, LAB_POLL_MS); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, enabled]);
  return feed;
}
