import { useEffect, useRef, useState } from 'react';
import { usePopoverPlacement } from './usePopoverPlacement';
import { ACCOUNTS, type Account, type Seat } from '../../shared/accounts';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';

const NAME: Record<Account, string> = { a: 'A (Desktop)', b: 'B', c: 'C' };

/** Small pin glyph: the account picker when pinned, and a turn badge whose account came from the pin. */
export function PinIcon({ title }: { title?: string }) {
  return (
    <svg className="pin-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title}>
      {title && <title>{title}</title>}
      <path fill="currentColor" d="M10.2 1.3a1 1 0 0 1 1.4 0l3.1 3.1a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1 .25l-2.1 2.1.3 2.4a1 1 0 0 1-.3.8l-.6.6a.6.6 0 0 1-.85 0L7 10.2l-3.9 3.9a.6.6 0 0 1-.85-.85L6.1 9.4 3.65 6.95a.6.6 0 0 1 0-.85l.6-.6a1 1 0 0 1 .8-.3l2.4.3 2.1-2.1a1 1 0 0 1 .25-1l.4-.4z" />
    </svg>
  );
}

function pct(u: AccountUsage | undefined): string {
  const f = u?.fiveHour?.usedPct;
  const w = u?.weekly?.usedPct;
  return `5h ${f ?? '—'}% · 주간 ${w ?? '—'}%`;
}

/**
 * 이 세션은 B 써: per-session account choice next to the model picker. 자동 = the router decides each turn; a letter =
 * that account every turn unless it is out of quota. The button shows the pinned letter (or 자동 · the current one).
 */
export function AccountPicker({ pin, current, usage, onPin }: {
  pin: Account | null;
  /** The account the session runs on now (null for a new session). */
  current: Seat | null;
  usage: UsageSnapshot | null;
  onPin: (pin: Account | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPlacement(open, btnRef, popRef, 240);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const cur = current === 'a' || current === 'b' || current === 'c' ? current.toUpperCase() : null;
  const label = pin ? pin.toUpperCase() : cur ? `자동 · ${cur}` : '자동';
  const choose = (p: Account | null) => { setOpen(false); if (p !== pin) onPin(p); };
  const item = (value: Account | null, name: string, desc: string) => (
    <button key={value ?? 'auto'} type="button" role="menuitemradio" aria-checked={value === pin} className={`mp-item ${value === pin ? 'on' : ''}`} onClick={() => choose(value)}>
      <span className="mp-text">
        <span className="mp-name">{name}</span>
        <span className="mp-desc">{desc}</span>
      </span>
      <span className="mp-check" aria-hidden="true">{value === pin ? '✓' : ''}</span>
    </button>
  );

  return (
    <span className="model-picker account-picker">
      <button
        ref={btnRef}
        type="button"
        className={`mp-button ${open ? 'open' : ''} ${pin ? 'pinned' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`계정: ${pin ? `${NAME[pin]} 고정` : label}`}
        title="이 세션의 계정 (자동 = 턴마다 라우터가 고름)"
        data-testid="account-picker"
        onClick={() => setOpen((o) => !o)}
      >
        {pin && <PinIcon />}
        <span className="mp-label">{label}</span>
        <span className="mp-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div ref={popRef} className="mp-pop ap-pop" role="menu" aria-label="계정" style={pos} data-testid="account-menu">
          <div className="mp-section" role="group" aria-label="계정">
            <div className="mp-head">이 세션의 계정</div>
            {item(null, '자동', '턴마다 잔여량과 캐시를 보고 고름')}
            {ACCOUNTS.map((a) => item(a, NAME[a], pct(usage?.accounts[a])))}
          </div>
        </div>
      )}
    </span>
  );
}
