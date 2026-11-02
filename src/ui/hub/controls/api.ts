import type { ControlsState, EngineId, LaunchBody, LaunchResult, RunItem } from './types';

/**
 * The hub controls' client. Reads are plain GETs; every write carries the CSRF value the last `state()` handed out and
 * `x-msg-confirm: yes` — callers only reach a write from a ConfirmDialog's confirm button.
 */
export interface CtlApi {
  state(): Promise<ControlsState>;
  runs(): Promise<RunItem[]>;
  read(runId: string, what: 'log' | 'report' | 'brief'): Promise<{ text: string; truncated?: boolean }>;
  decide(id: string, decision: 'approve' | 'reject', note: string): Promise<void>;
  launch(body: LaunchBody): Promise<LaunchResult>;
  task(body: { bot: string; mode: string; text: string }): Promise<{ id: string; file: string }>;
  stop(runId: string, pid: number): Promise<void>;
  rerun(runId: string, engine: EngineId): Promise<LaunchResult>;
}

const BASE = '/api/hub/ctl/';

export class CtlError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function body<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new CtlError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export function createCtlApi(fetchFn: typeof fetch = (...a) => fetch(...a)): CtlApi {
  let csrf = '';
  const get = <T,>(p: string) => fetchFn(BASE + p, { credentials: 'same-origin', cache: 'no-store' }).then((r) => body<T>(r));
  const post = async <T,>(p: string, data: unknown): Promise<T> => {
    if (!csrf) await api.state();
    return body<T>(await fetchFn(BASE + p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-msg-csrf': csrf, 'x-msg-confirm': 'yes' }, body: JSON.stringify(data) }));
  };
  const api: CtlApi = {
    async state() {
      const s = await get<ControlsState>('state');
      // An older server (or a stub) answering something else: no controls rather than a broken page.
      if (!s || typeof s.csrf !== 'string' || !Array.isArray(s.approvals?.pending) || !Array.isArray(s.approvals?.decided) || !Array.isArray(s.engines) || !s.modes) throw new CtlError(502, '허브 제어를 지원하지 않는 서버');
      csrf = s.csrf;
      return s;
    },
    async runs() { const r = (await get<{ runs: RunItem[] }>('runs')).runs; if (!Array.isArray(r)) throw new CtlError(502, '허브 제어를 지원하지 않는 서버'); return r; },
    read: (id, what) => get(`runs/${encodeURIComponent(id)}/${what}`),
    async decide(id, decision, note) { await post(`approvals/${encodeURIComponent(id)}/decide`, { decision, note }); },
    launch: (b) => post('jobs', b),
    task: (b) => post('tasks', b),
    async stop(id, pid) { await post(`runs/${encodeURIComponent(id)}/stop`, { pid }); },
    rerun: (id, engine) => post(`runs/${encodeURIComponent(id)}/rerun`, { engine }),
  };
  return api;
}

export const liveCtlApi = createCtlApi();
