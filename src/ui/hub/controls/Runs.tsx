import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { trapTab } from '../../components/Dialogs';
import { modeName } from './Approvals';
import { EnginePicker } from './Composer';
import { CtlConfirm, CtlLayer } from './Confirm';
import { absCwd, useCtl } from './context';
import type { EngineId, RunItem, RunPid } from './types';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', hermes: 'Hermes' };
const STATUS_LABEL: Record<RunItem['statusKind'], string> = { done: '완료', blocked: '막힘', partial: '일부', other: '기타', none: '보고 없음' };

export function fmtElapsed(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '1분 미만';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

/** The log tail (newest at the bottom, scrolled there) or REPORT.md rendered, in a sheet over the hub. */
function RunViewer({ run, what, onClose }: { run: RunItem; what: 'log' | 'report'; onClose: () => void }) {
  const ctl = useCtl()!;
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const load = () => { ctl.feed.api.read(run.id, what).then((r) => { setText(r.text); setTruncated(!!r.truncated); setErr(null); }, (e: unknown) => setErr(e instanceof Error ? e.message : '읽지 못했어요')); };
  useEffect(load, [run.id, what]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (what === 'log' && pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [text, what]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <CtlLayer>
      <div className="modal-backdrop ctl-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={`modal ctl-modal ctl-viewer ${what}`} role="dialog" aria-modal="true" aria-label={`${run.title} ${what === 'log' ? '로그' : '보고서'}`} onKeyDown={trapTab} data-testid={`viewer-${what}`}>
          <div className="ctl-composer-head">
            <h2>{what === 'log' ? '로그 끝부분' : 'REPORT.md'}</h2>
            <span className="ctl-muted ctl-ellip">{run.path}</span>
            {what === 'log' && <button type="button" className="ctl-btn ghost sm" onClick={load}>새로 읽기</button>}
            <button type="button" className="ctl-x" onClick={onClose} aria-label="닫기" autoFocus>×</button>
          </div>
          {err ? <p className="ctl-err">{err}</p> : text === null ? <p className="ctl-muted">읽는 중…</p> : what === 'log'
            ? <pre ref={pre} className="ctl-log">{truncated ? '… (앞부분 생략)\n' : ''}{text}</pre>
            : <div className="ctl-md"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown></div>}
        </div>
      </div>
    </CtlLayer>
  );
}

type Ask = { kind: 'stop'; run: RunItem; pid: RunPid } | { kind: 'rerun'; run: RunItem };

function RunRow({ run, now, onView, onAsk }: { run: RunItem; now: number; onView: (w: 'log' | 'report') => void; onAsk: (a: Ask) => void }) {
  const ctl = useCtl()!;
  const home = ctl.feed.state?.home ?? '';
  const elapsed = run.alive && run.startedAt ? now - Date.parse(run.startedAt) : run.elapsedMs;
  const stoppable = run.pids.filter((p) => p.alive && p.stoppable);
  const cwd = run.cwd ?? run.path;
  return (
    <li className={`ctl-run${run.alive ? ' alive' : ''} st-${run.statusKind}`} data-testid={`run-${run.id}`}>
      <span className={`ctl-run-dot${run.alive ? ' on' : ''}`} aria-label={run.alive ? '실행 중' : '멈춤'} />
      <div className="ctl-run-main">
        <div className="ctl-run-title"><b title={run.title}>{run.title}</b>{run.launchedByMsg && <span className="ctl-tag">MSG</span>}{run.mode && <span className="ctl-tag soft">{modeName(run.mode)}</span>}</div>
        <div className="ctl-run-sub"><code>{run.path}</code></div>
      </div>
      <div className="ctl-run-facts">
        <span className="ctl-fact"><i>엔진</i>{run.engine ? ENGINE_LABEL[run.engine] : '—'}{run.account && run.engine === 'claude' ? ` ${run.account}` : ''}</span>
        <span className="ctl-fact"><i>{run.alive ? '경과' : '걸린 시간'}</i>{fmtElapsed(elapsed)}</span>
        <span className={`ctl-status ${run.statusKind}`} title={run.status ?? ''}>{run.status ? (run.status.length > 28 ? `${run.status.slice(0, 28)}…` : run.status) : run.alive ? '진행 중' : STATUS_LABEL[run.statusKind]}</span>
        {run.limitHit && <span className="ctl-status limit">한도 도달</span>}
      </div>
      <div className="ctl-run-acts">
        {run.hasLog && <button type="button" className="ctl-btn ghost sm" onClick={() => onView('log')}>로그</button>}
        {run.hasReport && <button type="button" className="ctl-btn ghost sm" onClick={() => onView('report')}>보고서</button>}
        {ctl.openTerminal && !run.locked && <button type="button" className="ctl-btn ghost sm" onClick={() => ctl.openTerminal!(absCwd(home, cwd))}>터미널</button>}
        {run.locked ? <span className="ctl-lock-tag" title={run.locked}>{ctl.feed.state?.lockedLabel}</span> : <>
          {stoppable.map((p) => <button key={p.pid} type="button" className="ctl-btn ghost sm danger-text" onClick={() => onAsk({ kind: 'stop', run, pid: p })}>중지{stoppable.length > 1 ? ` ${p.pid}` : ''}</button>)}
          {!run.alive && <button type="button" className="ctl-btn ghost sm" onClick={() => onAsk({ kind: 'rerun', run })}>다시 실행</button>}
        </>}
      </div>
    </li>
  );
}

function RerunConfirm({ run, onClose }: { run: RunItem; onClose: () => void }) {
  const ctl = useCtl()!;
  const st = ctl.feed.state!;
  const first = (id: string | null) => st.engines.find((e) => e.id === id && e.available)?.id ?? null;
  const [engine, setEngine] = useState<EngineId | null>(() => first(run.engine) ?? first(st.suggested) ?? st.engines.find((e) => e.available)?.id ?? null);
  return (
    <CtlConfirm title="같은 브리프로 다시 실행할까요?" confirmLabel="다시 실행" disabled={!engine} onClose={onClose}
      onConfirm={async () => { await ctl.feed.api.rerun(run.id, engine!); ctl.feed.refresh(); }}>
      <p><b>{run.title}</b></p>
      <p className="ctl-muted">새 작업 폴더를 만들고 BRIEF.md 를 그대로 옮겨 실행해요. 원래 폴더는 그대로 둡니다.</p>
      <EnginePicker engines={st.engines} value={engine} onChange={setEngine} name="rerun-engine" />
    </CtlConfirm>
  );
}

/** 실행 관리: every job folder the server knows, running ones first; view, stop (SIGTERM, verified PIDs only), rerun. */
export function RunsPanel({ now, mode, limit }: { now: number; mode?: string; limit?: number }) {
  const ctl = useCtl();
  const [view, setView] = useState<{ run: RunItem; what: 'log' | 'report' } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [all, setAll] = useState(false);
  const runs = ctl?.feed.runs;
  if (!ctl || !runs) return null;
  const mine = mode ? runs.filter((r) => r.mode === mode) : runs;
  if (mode && mine.length === 0) return null;
  const alive = mine.filter((r) => r.alive).length;
  const cap = limit && !all ? limit : mine.length;
  return (
    <section id="hub-runs" className="sec open-static ctl-runs" aria-label="실행 관리" data-testid="runs-panel">
      <div className="sh"><span className="sec-title">실행 관리</span><span className="n">{alive ? `${alive}개 실행 중` : '실행 중인 작업 없음'}</span><span className="cnt">{mine.length}</span></div>
      <div className="b">
        {mine.length === 0 ? <p className="ctl-empty">아직 작업이 없어요. 카드의 다음 작업으로 첫 작업을 시작하세요.</p> : (
          <ul className="ctl-run-list">{mine.slice(0, cap).map((r) => <RunRow key={r.id} run={r} now={now} onView={(what) => setView({ run: r, what })} onAsk={setAsk} />)}</ul>
        )}
        {mine.length > cap && <button type="button" className="ctl-more" onClick={() => setAll(true)}>{mine.length - cap}개 더 보기</button>}
      </div>
      {view && <RunViewer run={view.run} what={view.what} onClose={() => setView(null)} />}
      {ask?.kind === 'stop' && (
        <CtlConfirm title="이 작업을 중지할까요?" confirmLabel="SIGTERM 보내기" tone="danger" onClose={() => setAsk(null)}
          onConfirm={async () => { await ctl.feed.api.stop(ask.run.id, ask.pid.pid); ctl.feed.refresh(); }}>
          <p><b>{ask.run.title}</b></p>
          <p className="ctl-muted">PID {ask.pid.pid} ({ask.pid.source === 'msg' ? 'MSG 가 시작한 프로세스' : `${ask.pid.file} 에 기록된 프로세스`}) 에 SIGTERM 만 보냅니다. 강제 종료는 하지 않아요.</p>
        </CtlConfirm>
      )}
      {ask?.kind === 'rerun' && <RerunConfirm run={ask.run} onClose={() => setAsk(null)} />}
    </section>
  );
}
