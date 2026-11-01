import { absCwd, useCtl } from './context';

/**
 * A mode's ways to act, on its 개요 card and its page head: 승인 N (to the inbox), 터미널 (its folder in MSG), 다음 작업.
 * Trading and QUANT get none of them, only the line saying where their decisions are made.
 */
export function ModeActions({ mode, place, onInbox }: { mode: string; place: 'card' | 'head'; onInbox?: () => void }) {
  const ctl = useCtl();
  const st = ctl?.feed.state;
  if (!ctl || !st) return null;
  const mc = st.modes[mode];
  if (!mc) return null;
  if (mc.locked) return <span className="ctl-lock-tag" data-testid={`ctl-locked-${mode}`}>{st.lockedLabel}</span>;
  const pending = st.approvals.pending.filter((a) => a.mode === mode && !a.locked).length;
  return (
    <span className={`ctl-mode-acts ${place}`} data-testid={`ctl-acts-${mode}`}>
      {pending > 0 && (onInbox
        ? <button type="button" className="ctl-badge" onClick={onInbox} aria-label={`승인 대기 ${pending}건`}>승인 {pending}</button>
        : <span className="ctl-badge" aria-label={`승인 대기 ${pending}건`}>승인 {pending}</span>)}
      {ctl.openTerminal && mc.cwd && mode !== 'msg' && <button type="button" className="ctl-btn ghost sm" onClick={() => ctl.openTerminal!(absCwd(st.home, mc.cwd!))} title={`${mc.cwd} 를 터미널에서 열기`}>터미널</button>}
      <button type="button" className="ctl-btn solid sm" onClick={() => ctl.compose(mode)}>다음 작업</button>
    </span>
  );
}
