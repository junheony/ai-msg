import { useEffect, useRef, useState } from 'react';
import type { CommanderStatusName, CommanderView, RefusalCode } from '../../shared/protocol';

/**
 * 총사령탑 패널 머리 칩 (docs/superpowers/specs/2026-10-18-commander-design.md §2·§7): 상태 한 줄 + ■ 정지(한 번 탭,
 * 확인 없음) + 재개, 누르면 마지막 판정이 펼쳐진다. 보이는 것은 서버가 마지막으로 보낸 그대로다(기기에 저장하지 않음).
 */

/** §2: 이미 걸린 상태 — 새로 걸 수 없고, ⋯ 메뉴는 걸기 대신 정지를 보인다. */
const ACTIVE: readonly CommanderStatusName[] = ['armed', 'sending', 'running', 'judging', 'waiting_human', 'paused'];

export function isCommanderActive(v: CommanderView | null | undefined): boolean {
  return !!v && ACTIVE.includes(v.state.status);
}

/** 재개 탭이 듣는 상태(서버 resume 과 같음). */
export function canResume(v: CommanderView): boolean {
  return v.state.status === 'paused' || v.state.status === 'waiting_human';
}

/** RefusalCode commander_* → 사용자 문구(짧게). */
export const REFUSAL_TEXT: Record<Extract<RefusalCode, `commander_${string}`>, string> = {
  commander_bypass: '모두 자동 승인 세션에는 걸 수 없습니다',
  commander_active: '이미 진행 중입니다 — 먼저 정지하세요',
  commander_engine: 'deck 에서 돌린 Claude 세션에만 걸 수 있습니다',
  commander_disabled: '총사령탑이 꺼져 있습니다 — 설정에서 켜세요',
  commander_stale_epoch: '화면이 오래됐습니다 — 다시 시도',
};

export function refusalText(code: RefusalCode): string {
  return (REFUSAL_TEXT as Record<string, string>)[code] ?? '거절됐습니다';
}

/** 서버 상태·사유 한 줄에서 칩 문구로: 진행 중 · 판정 중 · 사람 필요 · 일시 정지 · 끝 · 상한 도달 · 정지됨 · 재시작으로 끊김. */
export function commanderPhase(v: CommanderView): string {
  const { status, budget } = v.state;
  const note = v.note ?? '';
  switch (status) {
    case 'armed': case 'sending': case 'running': return '진행 중';
    case 'judging': return '판정 중';
    case 'paused': return '일시 정지';
    case 'done': return '끝';
    case 'stopped': return '정지됨';
    case 'idle': return '대기';
    case 'waiting_human':
      if (note.startsWith('재시작으로 끊김')) return '재시작으로 끊김';
      if (/상한|예산 초과/.test(note) || budget.autoTurnsUsed >= budget.maxAutoTurns) return '상한 도달';
      return '사람 필요';
  }
}

/** "사령탑 진행 중 · 7/20턴", "사령탑 · 사람 필요 · 7/20턴". */
export function commanderLabel(v: CommanderView): string {
  const phase = commanderPhase(v);
  const turns = `${v.state.hop}/${v.state.maxTurns}턴`;
  return phase === '진행 중' || phase === '판정 중' ? `사령탑 ${phase} · ${turns}` : `사령탑 · ${phase} · ${turns}`;
}

const VERDICT_TEXT = { continue: '계속', human: '사람 필요', done: '끝' } as const;

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tone(v: CommanderView): string {
  const s = v.state.status;
  if (s === 'waiting_human') return 'human';
  if (s === 'paused' || s === 'stopped') return 'idle';
  if (s === 'done') return 'done';
  return 'live';
}

export function CommanderChip({ view, refusal, onStop, onResume, onClearRefusal }: {
  view: CommanderView;
  /** The server's last refusal of this session's commander ask (shown until the user acts again). */
  refusal: RefusalCode | null;
  /** Both carry the epoch this device saw; another one is refused (commander_stale_epoch). */
  onStop: (epoch: number) => void;
  onResume: (epoch: number) => void;
  onClearRefusal: () => void;
}) {
  const [open, setOpen] = useState(false);
  // A refusal says its line for a while, then goes (the sheet keeps its own until closed).
  const clearRef = useRef(onClearRefusal);
  clearRef.current = onClearRefusal;
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => clearRef.current(), 8000);
    return () => clearTimeout(t);
  }, [refusal]);
  const { epoch } = view.state;
  const v = view.lastVerdict;
  const act = (fn: (epoch: number) => void) => { if (refusal) onClearRefusal(); fn(epoch); };
  return (
    <span className="commander-wrap" data-testid="commander-chip">
      <button type="button" className={`chip commander commander-${tone(view)}`} aria-expanded={open} title={view.note ?? '마지막 판정 보기'} onClick={() => { if (refusal) onClearRefusal(); setOpen((o) => !o); }}>
        {commanderLabel(view)}
      </button>
      {isCommanderActive(view) && <button type="button" className="chip commander-btn" aria-label="사령탑 정지" title="사령탑 정지 (진행 중인 턴은 끊지 않음)" onClick={() => act(onStop)}>■ 정지</button>}
      {canResume(view) && <button type="button" className="chip commander-btn" aria-label="사령탑 재개" onClick={() => act(onResume)}>재개</button>}
      {refusal && <span className="commander-refusal" role="alert">{refusalText(refusal)}</span>}
      {open && (
        <div className="commander-detail" role="region" aria-label="마지막 판정">
          <dl>
            <dt>목표</dt><dd>{view.state.goal}</dd>
            {view.note && <><dt>사유</dt><dd data-testid="commander-note">{view.note}</dd></>}
            {v ? (
              <>
                <dt>판정</dt><dd>{VERDICT_TEXT[v.verdict]} · {v.reason}</dd>
                {v.next && <><dt>다음 지시</dt><dd>{v.next}</dd></>}
                {v.evidence && <><dt>완료 근거</dt><dd>테스트 실행 <code>{v.evidence.testRunId}</code></dd></>}
                <dt>시각</dt><dd>{hhmm(v.atMs)}</dd>
              </>
            ) : <><dt>판정</dt><dd className="muted">아직 없음</dd></>}
          </dl>
        </div>
      )}
    </span>
  );
}
