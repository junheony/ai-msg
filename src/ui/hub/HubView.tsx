import { useEffect, useState } from 'react';
import type { HubStatus } from '../../shared/hub-types';
import { HubIcon } from './HubIcons';
import { HubModeView } from './HubModeView';
import { HubOverview } from './HubOverview';
import { HUB_MODES, type HubModeKey } from './modes';
import type { HubFeed } from './useHubStatus';

const stateDot = (status: HubStatus | null, id: HubModeKey): string => {
  const m = status?.modes.find((x) => x.id === id);
  return m ? (m.state === 'down' ? 'bad' : m.state) : 'none';
};

/** Everything under the header while a hub mode is showing: the rail (desktop), the 개요 or a mode. */
export function HubView({ mode, onChangeMode, phone, feed }: { mode: HubModeKey; onChangeMode: (m: HubModeKey) => void; phone: boolean; feed: HubFeed }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setNow(Date.now()); }, [feed.fetchedAt]);
  const current = feed.status?.modes.find((m) => m.id === mode);
  return (
    <div className={`hub${phone ? ' phone' : ''}`} data-mode={mode}>
      {!phone && (
        <nav className="hub-rail" aria-label="모드">
          {HUB_MODES.map((m) => (
            <button key={m.id} type="button" className={`hub-rail-btn${m.id === mode ? ' on' : ''}`} aria-current={m.id === mode ? 'page' : undefined} title={m.label} onClick={() => onChangeMode(m.id)}>
              <span className="hub-rail-icon"><HubIcon name={m.icon} size={18} />{m.id !== 'home' && m.id !== 'msg' && <i className={`hub-dot ${stateDot(feed.status, m.id)}`} />}</span>
              <span className="hub-rail-label">{m.short}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="hub-main">
        {mode === 'home'
          ? <HubOverview status={feed.status} error={feed.error} loading={feed.loading} fetchedAt={feed.fetchedAt} now={now} onOpenMode={onChangeMode} onRefresh={feed.refresh} />
          : <HubModeView modeKey={mode} mode={current} now={now} onOpenMode={onChangeMode} />}
      </div>
      {phone && (
        <nav className="hub-mbar" aria-label="하단 메뉴">
          <button type="button" className={mode === 'home' ? 'on' : ''} onClick={() => onChangeMode('home')}><HubIcon name="grid" /> 개요</button>
          <button type="button" onClick={() => onChangeMode('msg')}><HubIcon name="terminal" /> 터미널</button>
        </nav>
      )}
    </div>
  );
}
