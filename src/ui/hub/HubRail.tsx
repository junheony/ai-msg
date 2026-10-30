import type { HubStatus } from '../../shared/hub-types';
import { HubIcon } from './HubIcons';
import { HUB_MODES, modeDigit, STATE_LABEL, stateClass, type HubModeKey } from './modes';

/**
 * The fixed mode rail: the first child of `.body` in every mode (the terminal included), so navigation never moves.
 * Desktop: a 64px column on the left. Phone (CSS): a bottom tab bar. Each entry carries the mode's state as a dot plus
 * the state word in its accessible name.
 */
export function HubRail({ mode, status, onChange, mac }: { mode: HubModeKey; status: HubStatus | null; onChange: (m: HubModeKey) => void; mac: boolean }) {
  return (
    <nav className="rail" aria-label="모드" data-testid="hub-rail">
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
      <span className="rail-foot" aria-hidden="true">읽기 전용</span>
    </nav>
  );
}
