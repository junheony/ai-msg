import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubStatus } from '../../shared/hub-types';

/** Polling cadence (no push, or the push went quiet). */
export const HUB_POLL_MS = 15_000;
/** With push on: nothing heard for this long → fetch once (the socket may be fine but the watch lost). */
export const HUB_PUSH_STALE_MS = 30_000;

/** A `hub_status` the socket delivered (App hands the newest one down). */
export interface HubPush { status: HubStatus; at: number }

export interface HubFeed {
  status: HubStatus | null;
  /** Why the last fetch failed, null after a good one (or a push). */
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

/**
 * The hub's status feed. With `pushOn` (a 'hub' server, App sends `hub_watch`) the socket's `hub_status` pushes are the
 * source and `GET /api/hub/status` is only the fallback when nothing arrived for HUB_PUSH_STALE_MS; otherwise it polls
 * every 15 s while `enabled` and the page is visible. `refresh()` always fetches now.
 */
export function useHubStatus(enabled: boolean, push: HubPush | null, pushOn: boolean): HubFeed {
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);
  const lastAt = useRef<number | null>(null);
  const force = useRef(false);
  const refresh = useCallback(() => { force.current = true; setTick((n) => n + 1); }, []);
  useEffect(() => {
    if (!push || !enabled) return;
    lastAt.current = push.at;
    setStatus(push.status); setError(null); setFetchedAt(push.at); setLoading(false);
  }, [push, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    const run = (now: boolean) => {
      if (document.visibilityState === 'hidden') return;
      if (!now && pushOn && lastAt.current !== null && Date.now() - lastAt.current < HUB_PUSH_STALE_MS) return;
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      setLoading(true);
      fetchHubStatus(ac.signal).then(
        (s) => { if (gone || ac.signal.aborted) return; lastAt.current = Date.now(); setStatus(s); setError(null); setFetchedAt(lastAt.current); setLoading(false); },
        (err: unknown) => { if (gone || ac.signal.aborted) return; setError(err instanceof Error ? err.message : '오류'); setLoading(false); },
      );
    };
    // A push server sends the current status as soon as the watch is on: no fetch of our own unless asked or nothing comes.
    if (force.current || !pushOn) run(true);
    force.current = false;
    const timer = setInterval(() => run(false), HUB_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') run(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { gone = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); inflight.current?.abort(); };
  }, [enabled, tick, pushOn]);
  return { status, error, fetchedAt, loading, refresh };
}
