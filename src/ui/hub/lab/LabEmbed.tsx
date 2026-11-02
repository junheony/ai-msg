/** 연구소: the lab gateway's own pages in a frame, through the same-origin `/lab` relay; a sentence instead of an empty frame when it is down. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalIcon, ReloadIcon } from '../HubIcons';
import './lab.css';

export type LabProbe = 'ok' | 'offline' | 'login';
export const LAB_EMBED_HOME = '/lab';
export const LAB_PROBE_OK_MS = 30_000;
export const LAB_PROBE_OFFLINE_MS = 15_000;
/** The gateway restarts in seconds: one missed probe does not throw away the page being read. */
const FAILURES_TO_OFFLINE = 2;

export async function probeLab(): Promise<LabProbe> {
  try {
    const r = await fetch('/lab/health', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6_000), headers: { accept: 'application/json' } });
    return r.status === 401 ? 'login' : r.ok ? 'ok' : 'offline';
  } catch { return 'offline'; }
}

export function LabEmbed({ probe = probeLab }: { probe?: () => Promise<LabProbe> }) {
  const [state, setState] = useState<LabProbe | 'checking'>('checking');
  const stateRef = useRef(state);
  stateRef.current = state;
  const failures = useRef(0);
  // Where the frame is now: the new-window link follows it, and a reload or coming back from an outage returns to it.
  const [path, setPath] = useState(LAB_EMBED_HOME);
  const [frameKey, setFrameKey] = useState(0);

  const check = useCallback(async () => {
    const next = await probe();
    failures.current = next === 'offline' ? failures.current + 1 : 0;
    if (next === 'offline' && stateRef.current === 'ok' && failures.current < FAILURES_TO_OFFLINE) return;
    setState(next);
  }, [probe]);

  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await check();
      if (alive) timer = setTimeout(() => { void tick(); }, stateRef.current === 'ok' ? LAB_PROBE_OK_MS : LAB_PROBE_OFFLINE_MS);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [check]);

  if (state !== 'ok') {
    const text = state === 'checking' ? '연구소 서버 연결 확인 중…' : state === 'login' ? '로그인이 필요합니다 — 다시 로그인한 뒤 시도하세요' : '연구소 서버에 연결할 수 없습니다 — cblabx-labgw 상태 확인';
    return (
      <div className="lab-embed-off" data-testid="lab-embed-off" role={state === 'checking' ? 'status' : 'alert'}>
        <p>{text}</p>
        {state !== 'checking' && <button type="button" className="pill btn" onClick={() => { setState('checking'); void check(); }}><ReloadIcon /> 다시 시도</button>}
      </div>
    );
  }
  return (
    <div className="lab-embed" data-testid="lab-embed">
      <div className="hub-fh">
        <span className="hub-fh-title">크바연 연구소</span>
        <span className="hub-fh-meta">같은 출처 중계 · GET 전용 · 쿠키 미전달</span>
        <button type="button" className="pill btn" onClick={() => setFrameKey((k) => k + 1)} aria-label="프레임 새로고침"><ReloadIcon /> 새로고침</button>
        <a className="pill btn" href={path} target="_blank" rel="noopener noreferrer">새 창에서 열기 <ExternalIcon /></a>
      </div>
      <LabFrame key={frameKey} start={path} onNavigate={setPath} />
    </div>
  );
}

/** `src` is fixed for the frame's life: feeding the followed location back into it would load every inner page twice. */
function LabFrame({ start, onNavigate }: { start: string; onNavigate: (path: string) => void }) {
  const [src] = useState(start);
  const frame = useRef<HTMLIFrameElement>(null);
  const onLoad = () => {
    try {
      const at = frame.current?.contentWindow?.location;
      if (at && (at.pathname === LAB_EMBED_HOME || at.pathname.startsWith(`${LAB_EMBED_HOME}/`))) onNavigate(at.pathname + at.search);
    } catch { /* not readable: the link keeps the last page */ }
  };
  // allow-forms: the coach's ticket is a <form> its script handles; without it the submit event never fires. The relay's form-action 'none' still stops a real submit.
  return <iframe ref={frame} className="hub-iframe" title="크바연 연구소" src={src} onLoad={onLoad} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />;
}
