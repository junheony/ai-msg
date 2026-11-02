import { useState } from 'react';
import { ExternalIcon } from '../HubIcons';
import { HUB_MODES } from '../modes';
import { relTime } from '../time';
import { CtlConfirm } from './Confirm';
import { useCtl } from './context';
import type { ApprovalItem } from './types';

const KIND_LABEL: Record<ApprovalItem['kind'], string> = { generic: '일반', 'pr-merge': 'PR 머지', deploy: '배포' };
export const modeName = (m: string): string => HUB_MODES.find((d) => d.id === m)?.label ?? m;

/** A PR request's facts as filed: base ← head, the diff stat, the link. */
function PrFacts({ pr }: { pr: NonNullable<ApprovalItem['pr']> }) {
  const stat = pr.files !== undefined || pr.additions !== undefined || pr.deletions !== undefined;
  return (
    <div className="ctl-pr">
      {(pr.base || pr.head) && <span className="ctl-branch"><code>{pr.base ?? '?'}</code> ← <code>{pr.head ?? '?'}</code></span>}
      {stat && (
        <span className="ctl-diff" aria-label="변경 규모">
          {pr.files !== undefined && <span>파일 {pr.files}</span>}
          {pr.additions !== undefined && <span className="add">+{pr.additions}</span>}
          {pr.deletions !== undefined && <span className="del">−{pr.deletions}</span>}
        </span>
      )}
      {pr.url && <a className="ctl-link" href={pr.url} target="_blank" rel="noopener noreferrer">PR 열기 <ExternalIcon /></a>}
    </div>
  );
}

/**
 * One request as a decision slip: who asks for what, the facts, then the decision bar. A trading request keeps its
 * slip but trades the bar for a hatched lock band — it is decided in its own chat, never here.
 */
export function ApprovalSlip({ item, lockedLabel, now, onDecide }: { item: ApprovalItem; lockedLabel: string; now: number; onDecide?: (item: ApprovalItem, d: 'approve' | 'reject', note: string) => void }) {
  const [note, setNote] = useState('');
  const decided = item.decision;
  const recordsOnly = (item.kind === 'pr-merge' || item.kind === 'deploy') && !item.hook;
  return (
    <article className={`ctl-slip${item.locked ? ' locked' : ''}${decided ? ` decided ${decided.status}` : ''}`} data-mode={item.mode} data-testid={`approval-${item.id}`} aria-label={item.title}>
      <div className="ctl-slip-head">
        <span className="ctl-kind">{KIND_LABEL[item.kind]}</span>
        <h4>{item.title}</h4>
        <span className="ctl-meta">{item.from} 요청 · {modeName(item.mode)} · {relTime(item.createdAt, now)}</span>
      </div>
      {item.detail && <p className="ctl-detail">{item.detail}</p>}
      {item.pr && <PrFacts pr={item.pr} />}
      {item.deploy && (item.deploy.target || item.deploy.version) && <div className="ctl-pr"><span>대상 <b>{item.deploy.target ?? '?'}</b></span>{item.deploy.version && <span>버전 <b>{item.deploy.version}</b></span>}</div>}
      {item.links.length > 0 && <div className="ctl-links">{item.links.map((l) => <a key={l.href} className="ctl-link" href={l.href} target="_blank" rel="noopener noreferrer">{l.label} <ExternalIcon /></a>)}</div>}
      {decided ? (
        <div className="ctl-verdict">
          <b>{decided.status === 'approved' ? '승인됨' : '거절됨'}</b>
          <span>{decided.by} · {relTime(decided.at, now)}{decided.hook === 'launched' ? ' · 실행 훅 시작' : decided.hook === 'failed' ? ' · 실행 훅 실패' : ''}</span>
          {decided.note && <q>{decided.note}</q>}
        </div>
      ) : item.locked ? (
        <div className="ctl-lockband" role="note" data-testid="approval-locked">
          <b>{item.lockedLabel ?? lockedLabel}</b>
          <span>허브에서는 볼 수만 있어요 · {item.locked}</span>
        </div>
      ) : onDecide ? (
        <div className="ctl-decide">
          <input className="ctl-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모 (선택)" aria-label={`${item.title} 메모`} maxLength={1000} />
          {recordsOnly && <span className="ctl-hint">실행 훅 없음 · 결정만 기록합니다</span>}
          <span className="ctl-decide-btns">
            <button type="button" className="ctl-btn ghost danger-text" onClick={() => onDecide(item, 'reject', note)}>거절</button>
            <button type="button" className="ctl-btn solid" onClick={() => onDecide(item, 'approve', note)}>승인</button>
          </span>
        </div>
      ) : null}
    </article>
  );
}

/** 승인함: pending requests (all, or one mode's), and the last few decisions folded under them. */
export function ApprovalInbox({ mode, now }: { mode?: string; now: number }) {
  const ctl = useCtl();
  const [ask, setAsk] = useState<{ item: ApprovalItem; d: 'approve' | 'reject'; note: string } | null>(null);
  const st = ctl?.feed.state;
  if (!ctl || !st) return null;
  const pending = st.approvals.pending.filter((a) => !mode || a.mode === mode);
  const decided = st.approvals.decided.filter((a) => !mode || a.mode === mode).slice(0, 6);
  if (mode && pending.length === 0 && decided.length === 0) return null;
  const open = pending.filter((a) => !a.locked).length;
  return (
    <section className="sec open-static ctl-inbox" aria-label="승인함" data-testid="approval-inbox">
      <div className="sh">
        <span className="sec-title">승인함</span>
        <span className="n">{open ? `결정할 것 ${open}건` : pending.length ? '허브에서 결정할 것 없음' : '대기 중인 요청 없음'}</span>
        <span className="cnt">{pending.length}</span>
      </div>
      <div className="b">
        {pending.length === 0
          ? <p className="ctl-empty">봇이나 스크립트가 <code>msg-approve request --title "…"</code> 로 요청을 올리면 여기에 쌓여요.</p>
          : <div className="ctl-slips">{pending.map((a) => <ApprovalSlip key={a.id} item={a} lockedLabel={st.lockedLabel} now={now} onDecide={(item, d, note) => setAsk({ item, d, note })} />)}</div>}
        {decided.length > 0 && (
          <details className="ctl-history">
            <summary>최근 결정 {decided.length}건</summary>
            <div className="ctl-slips">{decided.map((a) => <ApprovalSlip key={a.id} item={a} lockedLabel={st.lockedLabel} now={now} />)}</div>
          </details>
        )}
      </div>
      {ask && (
        <CtlConfirm
          title={ask.d === 'approve' ? '이 요청을 승인할까요?' : '이 요청을 거절할까요?'}
          confirmLabel={ask.d === 'approve' ? '승인' : '거절'}
          tone={ask.d === 'approve' ? 'primary' : 'danger'}
          onClose={() => setAsk(null)}
          onConfirm={async () => { await ctl.feed.api.decide(ask.item.id, ask.d, ask.note); ctl.feed.refresh(); }}
        >
          <p><b>{ask.item.title}</b></p>
          <p className="ctl-muted">{ask.item.from} 요청 · {KIND_LABEL[ask.item.kind]}</p>
          {ask.note && <p>메모: {ask.note}</p>}
          <p className="ctl-muted">{ask.d === 'approve' && ask.item.hook ? `승인하면 ${ask.item.kind} 실행 훅이 시작됩니다.` : '결정은 msg-approvals.log 에 남고 요청 파일은 decided/ 로 옮겨집니다.'}</p>
        </CtlConfirm>
      )}
    </section>
  );
}
