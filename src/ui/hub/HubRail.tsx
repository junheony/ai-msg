import { useEffect, useRef } from 'react';
import type { HubStatus } from '../../shared/hub-types';
import { HubIcon } from './HubIcons';
import { HUB_MODES, modeDigit, STATE_LABEL, stateClass, type HubModeKey } from './modes';

/**
 * The fixed mode rail: the first child of `.body` in every mode (the terminal included), so navigation never moves.
 * Desktop: a 64px column on the left. Phone (CSS): a bottom tab bar. Each entry carries the mode's state as a dot plus
 * the state word in its accessible name.
 */
export function HubRail({ mode, status, onChange, mac }: { mode: HubModeKey; status: HubStatus | null; onChange: (m: HubModeKey) => void; mac: boolean }) {
  const nav = useRef<HTMLElement>(null);
  // The phone tab bar scrolls sideways: keep the current mode's tab in view when the mode changes (⌘n, the switcher).
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('.rail-btn.on')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [mode]);
  return (
    <nav ref={nav} className="rail" aria-label="모드" data-testid="hub-rail">
      {HUB_MODES.map((m, i) => {
        const on = m.id === mode;
        const st = m.id === 'home' ? null : status?.modes.find((x) => x.id === m.id)?.state ?? null;
        const kbd = `${mac ? '⌘' : 'Ctrl+'}${modeDigit(i)}`;
        return (
          <button key={m.id} type="button" className={`rail-btn${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} data-mode={m.id}
            aria-label={st ? `${m.label} · ${STATE_LABEL[st]}` : m.label} title={`${m.label} (${kbd})`} onClick={() => onChange(m.id)}>
            <span className="rail-ico"><HubIcon name={m.icon} size={18} />{st && <i className={`hub-dot ${stateClass(st)}`} />}</span>
            <span className="rail-label">{m.short}</span>
          </button>
        );
      })}
      <span className="rail-sp" />
    </nav>
  );
}
