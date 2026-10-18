import { useState } from 'react';
import type { RefusalCode } from '../../shared/protocol';
import { Sheet } from './Dialogs';
import { refusalText } from './CommanderChip';

/** §2 시트의 한도 — 서버 스키마(commander_set)와 같다. */
export const COMMANDER_TEXT_MAX = 2000;
export const COMMANDER_TURNS_MIN = 1;
export const COMMANDER_TURNS_MAX = 50;
export const COMMANDER_TURNS_DEFAULT = 20;

export type CommanderAsk = { goal: string; done: string; maxTurns: number };

/** What is wrong with the form (null = it can go). */
export function commanderFormError(goal: string, done: string, turns: string): string | null {
  if (!goal.trim()) return '목표를 적어 주세요';
  if (goal.trim().length > COMMANDER_TEXT_MAX) return `목표는 ${COMMANDER_TEXT_MAX}자 이하로`;
  if (!done.trim()) return '완료 조건을 적어 주세요';
  if (done.trim().length > COMMANDER_TEXT_MAX) return `완료 조건은 ${COMMANDER_TEXT_MAX}자 이하로`;
  const n = Number(turns);
  if (!/^\d+$/.test(turns.trim()) || n < COMMANDER_TURNS_MIN || n > COMMANDER_TURNS_MAX) return `턴 상한은 ${COMMANDER_TURNS_MIN}~${COMMANDER_TURNS_MAX}`;
  return null;
}

/**
 * 총사령탑 걸기 (⋯ 메뉴): 목표 · 완료 조건 · 턴 상한 → commander_set. 데스크톱·폰 공용 바텀시트(Dialogs Sheet). 닫는 것은
 * 부르는 쪽 — 서버가 새 사령탑을 알리면 닫고, 거절이면 `refusal` 로 이 자리에서 보인다.
 */
export function CommanderSheet({ title, refusal, waiting, defaultTurns = COMMANDER_TURNS_DEFAULT, onSubmit, onClose }: {
  title: string;
  refusal: RefusalCode | null;
  /** 걸기를 보냈고 서버의 답을 기다리는 중. */
  waiting: boolean;
  /** 턴 상한의 처음 값: 설정의 commanderMaxTurns(모르면 20). */
  defaultTurns?: number;
  /** false: 보내지 못함(연결 끊김). */
  onSubmit: (ask: CommanderAsk) => boolean;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState('');
  const [done, setDone] = useState('');
  const [turns, setTurns] = useState(String(defaultTurns));
  const [unsent, setUnsent] = useState(false);
  const error = commanderFormError(goal, done, turns);
  const submit = () => {
    if (error || waiting) return;
    setUnsent(!onSubmit({ goal: goal.trim(), done: done.trim(), maxTurns: Number(turns) }));
  };
  return (
    <Sheet className="commander-sheet" label="총사령탑 걸기" onClose={onClose}>
      <form className="commander-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="settings-head">
          <h2>총사령탑 걸기</h2>
          <button type="button" className="btn ghost" onClick={onClose}>닫기</button>
        </div>
        <p className="muted commander-session">{title}</p>
        <label className="commander-field">
          <span>목표</span>
          <textarea value={goal} maxLength={COMMANDER_TEXT_MAX} rows={3} autoFocus onChange={(e) => setGoal(e.target.value)} placeholder="무엇을 끝낼지" />
        </label>
        <label className="commander-field">
          <span>완료 조건</span>
          <textarea value={done} maxLength={COMMANDER_TEXT_MAX} rows={3} onChange={(e) => setDone(e.target.value)} placeholder="예: npm test 통과" />
        </label>
        <label className="commander-field turns">
          <span>턴 상한</span>
          <input type="number" inputMode="numeric" min={COMMANDER_TURNS_MIN} max={COMMANDER_TURNS_MAX} value={turns} onChange={(e) => setTurns(e.target.value)} />
        </label>
        <p className="muted">세션이 쉴 때마다 판정해 다음 지시를 보냅니다. 권한 카드·되돌리기 어려운 일은 멈추고 알립니다. 자동 턴도 테스트 코드는 실행합니다.</p>
        {(goal || done) && error && <p className="commander-error" role="status">{error}</p>}
        {refusal && <p className="commander-error" role="alert">{refusalText(refusal)}</p>}
        {unsent && <p className="commander-error" role="alert">연결이 끊겨 보내지 못했습니다</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>취소</button>
          <button type="submit" className="btn primary" disabled={!!error || waiting}>{waiting ? '거는 중…' : '걸기'}</button>
        </div>
      </form>
    </Sheet>
  );
}
