import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubStatus } from '../../shared/hub-types';

export const HUB_POLL_MS = 15_000;

export interface HubFeed {
  status: HubStatus | null;
  /** Why the last fetch failed, null after a good one. */
  error: string | null;
  fetchedAt: number | null;
  loading: boolean;
  refresh: () => void;
}

export async function fetchHubStatus(signal?: AbortSignal): Promise<HubStatus> {
  const res = await fetch('/api/hub/status', { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (res.status === 401) throw new Error('로그인이 필요합니다');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as HubStatus;
  if (!body || !Array.isArray(body.modes)) throw new Error('응답 형식 오류');
  return body;
}

/** Polls `/api/hub/status` every 15 s while `enabled` and the page is visible (and at once when it becomes visible). */
export function useHubStatus(enabled: boolean): HubFeed {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const run = () => {
      if (document.visibilityState === 'hidden') return;
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      setLoading(true);
      fetchHubStatus(ac.signal).then(
        (s) => { if (gone || ac.signal.aborted) return; setStatus(s); setError(null); setFetchedAt(Date.now()); setLoading(false); },
        (err: unknown) => { if (gone || ac.signal.aborted) return; setError(err instanceof Error ? err.message : '오류'); setLoading(false); },
      );
    };
    run();
    const timer = setInterval(run, HUB_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { gone = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); inflight.current?.abort(); };
  }, [enabled, tick]);
  return { status, error, fetchedAt, loading, refresh };
}
