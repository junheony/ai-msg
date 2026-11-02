import { useCallback, useEffect, useRef, useState } from 'react';
import type { CtlApi } from './api';
import type { ControlsState, RunItem } from './types';

export interface ControlsFeed {
  api: CtlApi;
  state: ControlsState | null;
  runs: RunItem[] | null;
  error: string | null;
  refresh: () => void;
}

/** The controls' state and the runs list, every 15 s while the hub is on screen (and right after any action). */
export function useControls(api: CtlApi, on = true): ControlsFeed {
  const [state, setState] = useState<ControlsState | null>(null);
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.state(), api.runs()]);
      if (!alive.current) return;
      setState(s); setRuns(r); setError(null);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '불러오지 못했어요');
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    if (!on) return () => { alive.current = false; };
    void load();
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 15_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, on]);
  return { api, state, runs, error, refresh: () => { void load(); } };
}
