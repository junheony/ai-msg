import { useEffect, useRef, useState } from 'react';
import { trapTab } from '../../components/Dialogs';
import { modeName } from './Approvals';
import type { ControlsFeed } from './useControls';
import type { EngineId, EngineState, LaunchResult } from './types';

const fmtReset = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

/**
 * The three engines as tiles. A tile whose quota is spent is greyed out with when it comes back; Codex and Hermes share
 * one OpenAI quota, so they grey out together and the picker points at Claude.
 */
export function EnginePicker({ engines, value, onChange, name }: { engines: EngineState[]; value: EngineId | null; onChange: (e: EngineId) => void; name: string }) {
  const limited = engines.filter((e) => !e.available);
  return (
    <fieldset className="ctl-engines">
      <legend>엔진</legend>
      <div className="ctl-engine-row">
        {engines.map((e) => (
          <label key={e.id} className={`ctl-engine${e.available ? '' : ' off'}${value === e.id ? ' on' : ''}`} data-testid={`engine-${e.id}`}>
            <input type="radio" name={name} value={e.id} checked={value === e.id} disabled={!e.available} onChange={() => onChange(e.id)} />
            <span className="ctl-engine-name">{e.label}</span>
            <span className="ctl-engine-detail">{e.detail}</span>
            <span className={`ctl-engine-state${e.available ? ' ok' : ' bad'}`}>{e.available ? '사용 가능' : e.limitedUntil ? `한도 · ${fmtReset(e.limitedUntil)} 해제` : e.reason ?? '쓸 수 없음'}</span>
          </label>
        ))}
      </div>
      {limited.some((e) => e.quota === 'openai') && <p className="ctl-hint">Codex 와 Hermes 는 한도를 함께 씁니다. 지금은 Claude 로 실행하세요.</p>}
    </fieldset>
  );
}

type Target = 'agent' | 'bot';
type Step = 'edit' | 'confirm' | 'done';

/**
 * 다음 작업: write a brief for this mode and launch an agent on it (a job folder under ~/jobs, detached), or leave it in a
 * bot's queue. Two steps — write, then confirm what will run where — and the result names the job folder.
 */
export function Composer({ feed, mode, onClose, onShowRuns }: { feed: ControlsFeed; mode: string; onClose: () => void; onShowRuns?: () => void }) {
  const st = feed.state;
  const mc = st?.modes[mode];
  const [target, setTarget] = useState<Target>('agent');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [cwd, setCwd] = useState(mc?.cwd ?? '');
  const [engine, setEngine] = useState<EngineId | null>(() => (st ? (st.engines.find((e) => e.id === st.suggested && e.available)?.id ?? st.engines.find((e) => e.available)?.id ?? null) : null));
  const [bot, setBot] = useState(mc?.bot ?? st?.bots[0] ?? '');
  const [step, setStep] = useState<Step>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; sub: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !busy) { e.preventDefault(); e.stopPropagation(); if (step === 'confirm') setStep('edit'); else onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose, step]);

  const eng = st?.engines.find((e) => e.id === engine) ?? null;
  const ready = brief.trim().length > 0 && (target === 'bot' ? !!bot : !!eng?.available);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      if (target === 'agent') {
        const out: LaunchResult = await feed.api.launch({ mode, engine: engine!, brief, title: title.trim() || undefined, cwd: cwd.trim() || undefined });
        setDone({ text: `${out.jobDir} 에서 시작했어요`, sub: `${eng?.label}${out.run.account ? ` · 계정 ${out.run.account}` : ''}${out.run.pids[0] ? ` · PID ${out.run.pids[0].pid}` : ''}` });
      } else {
        const out = await feed.api.task({ bot, mode, text: title.trim() ? `# ${title.trim()}\n\n${brief}` : brief });
        setDone({ text: `${bot} 큐에 넣었어요`, sub: out.file });
      }
      setStep('done');
      feed.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '보내지 못했어요');
      setStep('edit');
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop ctl-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && step !== 'confirm') onClose(); }}>
      <div className="modal ctl-modal ctl-composer" role="dialog" aria-modal="true" aria-label={`다음 작업 · ${modeName(mode)}`} data-mode={mode} onKeyDown={trapTab} data-testid="composer">
        <div className="ctl-composer-head">
          <h2>다음 작업</h2>
          <span className="ctl-muted">{modeName(mode)}</span>
          <button type="button" className="ctl-x" onClick={onClose} aria-label="닫기" disabled={busy}>×</button>
        </div>
        {!st ? <p className="ctl-muted">불러오는 중…</p> : step === 'done' && done ? (
          <div className="ctl-done" role="status">
            <p className="ctl-done-h">{done.text}</p>
            <p className="ctl-muted">{done.sub}</p>
            <div className="ctl-actions">
              {target === 'agent' && onShowRuns && <button type="button" className="ctl-btn ghost" onClick={() => { onClose(); onShowRuns(); }}>실행 관리 보기</button>}
              <button type="button" className="ctl-btn solid" onClick={onClose}>닫기</button>
            </div>
          </div>
        ) : step === 'confirm' ? (
          <div className="ctl-review" data-testid="composer-confirm">
            <p className="ctl-review-q">{target === 'agent' ? '이대로 실행할까요?' : '이대로 큐에 넣을까요?'}</p>
            <dl className="ctl-dl">
              {target === 'agent' ? <>
                <div><dt>엔진</dt><dd>{eng?.label}</dd></div>
                <div><dt>작업 폴더</dt><dd><code>{cwd.trim() || mc?.cwd || '새 작업 폴더'}</code></dd></div>
                <div><dt>기록</dt><dd><code>~/jobs/날짜-제목/</code> 에 BRIEF.md · run.log · REPORT.md</dd></div>
              </> : <>
                <div><dt>봇</dt><dd>{bot}</dd></div>
                <div><dt>큐</dt><dd><code>~/.msg/tasks/{bot}/</code> · 메시지는 보내지 않아요</dd></div>
              </>}
              <div><dt>제목</dt><dd>{title.trim() || '본문 첫 줄'}</dd></div>
            </dl>
            <pre className="ctl-brief-preview">{brief}</pre>
            <div className="ctl-actions">
              <button type="button" className="ctl-btn ghost" onClick={() => setStep('edit')} disabled={busy}>고치기</button>
              <button type="button" className="ctl-btn solid" onClick={() => void send()} disabled={busy}>{busy ? '보내는 중…' : target === 'agent' ? '실행' : '큐에 넣기'}</button>
            </div>
          </div>
        ) : (
          <form className="ctl-form" onSubmit={(e) => { e.preventDefault(); if (ready) setStep('confirm'); }}>
            <div className="ctl-seg" role="tablist" aria-label="보낼 곳">
              <button type="button" role="tab" aria-selected={target === 'agent'} onClick={() => setTarget('agent')}>에이전트 실행</button>
              <button type="button" role="tab" aria-selected={target === 'bot'} onClick={() => setTarget('bot')}>봇에게</button>
            </div>
            <label className="ctl-field"><span>제목</span><input className="ctl-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="짧게, 폴더 이름이 됩니다" maxLength={160} /></label>
            <label className="ctl-field"><span>브리프</span><textarea ref={ref} className="ctl-input ctl-textarea" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={target === 'agent' ? '무엇을, 어디까지, 끝나면 무엇이 남아야 하는지' : '봇이 다음에 할 일'} rows={7} maxLength={20000} /></label>
            {target === 'agent' ? <>
              <EnginePicker engines={st.engines} value={engine} onChange={setEngine} name="composer-engine" />
              <label className="ctl-field"><span>작업 폴더</span><input className="ctl-input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="비우면 ~/jobs 의 새 작업 폴더" spellCheck={false} /></label>
              <p className="ctl-hint">BRIEF.md 끝에 REPORT.md 와 STATUS 규칙이 자동으로 붙어요. 트레이딩 제어, 비밀값이 든 브리프는 서버가 거절합니다.</p>
            </> : (
              <label className="ctl-field"><span>봇</span>
                <select className="ctl-input" value={bot} onChange={(e) => setBot(e.target.value)}>{st.bots.map((b) => <option key={b} value={b}>{b}</option>)}</select>
              </label>
            )}
            {error && <p className="ctl-err" role="alert">{error}</p>}
            <div className="ctl-actions">
              <button type="button" className="ctl-btn ghost" onClick={onClose}>취소</button>
              <button type="submit" className="ctl-btn solid" disabled={!ready}>다음</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
