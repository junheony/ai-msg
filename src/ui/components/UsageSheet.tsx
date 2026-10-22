import { useState, type KeyboardEvent } from 'react';
import type { Seat } from '../../shared/accounts';
import type { GrokStatus } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { Sheet, SheetHead } from './Dialogs';
import { UsageHistoryView } from './UsageView';
import { agoText, buildSeats, LEGEND, PopRow, REFRESH_HINT, seatStale, seatTitle, statusLabel, useClock, type RouteNext } from './usageSeats';
import { ClockIcon, RefreshIcon } from './icons';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab / Shift+Tab wrap inside the sheet (it is modal). */
function trapTab(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Every account's limits (all windows, resets, credits, hints) plus the token history, in one sheet (design §3.5):
 * a bottom sheet on a phone, a side panel on a desktop. Opened from the usage chip, the palette, settings, the menu.
 */
export function UsageSheet({ usage, current, next = null, grok = null, initialHistory = false, onClose, now: fixedNow, fetchFn }: {
  usage: UsageSnapshot | null; current: Seat | null; next?: RouteNext | null; grok?: GrokStatus | null;
  /** Open with the history already expanded (settings / menu "사용량 기록"). */
  initialHistory?: boolean;
  onClose: () => void; now?: number; fetchFn?: typeof fetch;
}) {
  const now = useClock(fixedNow);
  const { active, label } = useAccounts();
  const [history, setHistory] = useState(initialHistory);
  const cli = usage?.usageMode === 'cli';
  const seats = usage ? buildSeats(usage, active, grok, now) : [];
  return (
    <Sheet className={`usage-sheet${history ? ' with-history' : ''}`} label="사용량" onClose={onClose}>
      <div className="usage-sheet-inner" onKeyDown={trapTab}>
        <SheetHead title="사용량" onClose={onClose} />
        <p className="usage-sheet-legend">{LEGEND}</p>
        {!usage && <p className="usage-sheet-note">사용량 불러오는 중…</p>}
        {/* `cli` never asks usage-deck: deckReachable is always false there and says nothing. */}
        {usage && !cli && !usage.deckReachable && <p className="usage-sheet-note stale" data-testid="usage-stale">오래된 값 — usage-deck 에 닿지 않아 마지막 값을 보여 줍니다</p>}
        <ul className="usage-seats">
          {seats.map((d) => {
            const st = statusLabel(d);
            const old = seatStale(d, !!usage && !cli && !usage.deckReachable) && d.status !== 'cooldown';
            const ago = old ? agoText(d.fetchedAt ?? null, now) : '';
            const isNext = next?.account === d.seat && (d.seat !== current || !!next.asOpus);
            return (
              <li key={d.seat} data-testid={`account-${d.seat}`} className={`usage-seat ${d.engine} ${d.status}${d.seat === current ? ' current' : ''}${d.dim ? ' dim' : ''}${old ? ' old' : ''}`} title={seatTitle(d)}>
                <div className="usage-seat-head">
                  {d.mark}
                  <b className="usage-seat-name">{label(d.seat)}</b>
                  {d.seat === current && <span className="usage-tag current">현재</span>}
                  {isNext && <span className="usage-tag next" data-testid={`sheet-next-${d.seat}`} title={`다음 턴은 이 계정으로 갑니다: ${next!.reason}`}>{next!.asOpus ? '다음 턴 여기 · Opus' : '다음 턴 여기'}</span>}
                  {st && <span className={`usage-tag status ${d.status}`} data-testid={`${d.seat}-status`}>{old && <ClockIcon className="usage-icon" />}{st}</span>}
                </div>
                {d.hint && d.reasonLine === undefined && <div className="usage-pop-row hint">{d.hint}</div>}
                {d.reasonLine !== undefined && <div className="usage-pop-row hint" data-testid={`${d.seat}-main`}>{d.reasonLine}</div>}
                {d.observed && <div className="usage-pop-row" data-testid={`${d.seat}-observed`}><span>관측</span><b>{d.observed}</b></div>}
                {d.rows.map((r) => <PopRow key={r.key} seat={d.seat} name={r.name} k={r.key} w={r.w} now={now} empty={r.empty} stale={old} polled={d.polled} />)}
                {old && d.rows.some((r) => r.w) && <div className="usage-pop-row usage-refresh-hint" data-testid={`${d.seat}-refresh`}><RefreshIcon className="usage-icon" />{ago ? `${ago} ${d.polled ? '확인한 값' : '마지막 턴 기준 값'} · ` : ''}{REFRESH_HINT}</div>}
                {d.credits && <div className="usage-pop-row" data-testid={`${d.seat}-credits`}><span>크레딧</span><b>{d.credits}</b></div>}
                {d.extraPopover}
              </li>
            );
          })}
        </ul>
        <button type="button" className="usage-history-toggle" aria-expanded={history} onClick={() => setHistory((v) => !v)}>
          토큰 사용량 기록 (주별·일별) {history ? '▴' : '▾'}
        </button>
        {history && <UsageHistoryView {...(fetchFn ? { fetchFn } : {})} {...(fixedNow !== undefined ? { now: new Date(fixedNow) } : {})} />}
      </div>
    </Sheet>
  );
}
