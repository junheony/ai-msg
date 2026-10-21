import { isGeminiAccount, isGrokAccount, type Account, type Seat } from '../../shared/accounts';
import { useAccounts } from '../accounts';
import { usageOf } from '../../shared/usage-types';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';

/** Small pin glyph: the session chip's account when pinned, and a turn badge whose account came from the pin. */
export function PinIcon({ title }: { title?: string }) {
  return (
    <svg className="pin-icon" viewBox="0 0 16 16" width="11" height="11" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title}>
      {title && <title>{title}</title>}
      <path fill="currentColor" d="M10.2 1.3a1 1 0 0 1 1.4 0l3.1 3.1a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1 .25l-2.1 2.1.3 2.4a1 1 0 0 1-.3.8l-.6.6a.6.6 0 0 1-.85 0L7 10.2l-3.9 3.9a.6.6 0 0 1-.85-.85L6.1 9.4 3.65 6.95a.6.6 0 0 1 0-.85l.6-.6a1 1 0 0 1 .8-.3l2.4.3 2.1-2.1a1 1 0 0 1 .25-1l.4-.4z" />
    </svg>
  );
}

/** 5h · 주간 · Fable — the Fable value is shown so a pin on an account at the Fable cap is visible where the pin is set. */
function pct(u: AccountUsage | undefined): string {
  const f = u?.fiveHour?.usedPct;
  const w = u?.weekly?.usedPct;
  const fb = u?.fable?.usedPct;
  return `5h ${f ?? '—'}% · 주간 ${w ?? '—'}% · Fable ${fb ?? '—'}%`;
}

/**
 * The words for the session's account: the pin, or the account the session runs on now, or 자동 — with the state of a
 * retired / unconfigured one. `aria` is the full wording ("계정: B 고정", "계정: 자동 · A").
 */
export function useAccountWords(pin: Account | null, current: Seat | null) {
  const names = useAccounts();
  const cur = current !== null && current !== 'gpt' && !isGeminiAccount(current) && !isGrokAccount(current) ? names.label(current) : null;
  // An account that left the configuration shows its id, grey; a retired one its label, dimmed.
  const shown = pin ?? (cur !== null ? current : null);
  const look = shown !== null ? names.look(shown).kind : 'active';
  const state = shown !== null ? names.state(shown) : null;
  // A pin on an account that cannot run a turn is no pin to the server: the router picks.
  const pinName = pin ? `${names.label(pin)}${names.home?.id === pin ? ' (Desktop)' : ''}${state ? ` (${state} — 자동으로 동작)` : ''}` : '';
  const label = pin ? names.label(pin) : cur ? `자동 · ${cur}` : '자동';
  return {
    pinLabel: pin ? names.label(pin) : null,
    cur,
    aria: `계정: ${pin ? `${pinName} 고정` : `${label}${state ? ` (${state})` : ''}`}`,
    title: pin ? pinName : cur ? `${cur}${state ? ` (${state})` : ''}` : '자동 = 턴마다 라우터가 고름',
    cls: `mp-acct${look === 'retired' || look === 'unknown' ? ` acct-${look}` : ''}`,
  };
}

/** The account part of the session chip: the pinned name (with a pin), or "자동 · " + the current one (a narrow pane keeps the name). */
export function AccountChipName({ pin, current }: { pin: Account | null; current: Seat | null }) {
  const w = useAccountWords(pin, current);
  return (
    <span className={`sc-acct ${pin ? 'pinned' : ''}`} data-testid="account-picker" role="img" aria-label={w.aria}>
      {pin && <PinIcon />}
      {pin ? <span className={w.cls} title={w.title}>{w.pinLabel}</span>
        : w.cur ? <><span className="sc-extra">자동 · </span><span className={w.cls} title={w.title}>{w.cur}</span></>
        : <span className="mp-acct" title={w.title}>자동</span>}
    </span>
  );
}

/** 이 세션은 B 써: per-session account list, inline in the session chip's sheet. 자동 = the router decides each turn. */
export function AccountMenu({ pin, usage, onPin }: {
  pin: Account | null;
  usage: UsageSnapshot | null;
  onPin: (pin: Account | null) => void;
}) {
  const names = useAccounts();
  const choose = (p: Account | null) => { if (p !== pin) onPin(p); };
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
    <div className="mp-list" role="menu" aria-label="계정" data-testid="account-menu">
      <div className="mp-section" role="group" aria-label="계정">
        {item(null, '자동', '턴마다 잔여량과 캐시를 보고 고름')}
        {names.active.map((a) => item(a.id, `${a.label}${a.home ? ' (Desktop)' : ''}`, pct(usage ? usageOf(usage, a.id) : undefined)))}
      </div>
    </div>
  );
}
