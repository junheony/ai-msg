import { useState } from 'react';
import type { HubMode } from '../../shared/hub-types';
import { ExternalIcon, HubIcon, ReloadIcon } from './HubIcons';
import { StatePill } from './HubOverview';
import { modeDef, type HubModeKey } from './modes';
import { relTime } from './time';

/**
 * A single mode. QUANT and OPS show their dashboard inside a frame served by the hub's own read-only proxy (same
 * origin, GET only, no cookie upstream); the others show the card's detail with a link out.
 */
export function HubModeView({ modeKey, mode, now, onOpenMode }: { modeKey: HubModeKey; mode: HubMode | undefined; now: number; onOpenMode: (m: HubModeKey) => void }) {
  const def = modeDef(modeKey);
  const [frameKey, setFrameKey] = useState(0);
  const embed = mode?.links.find((l) => l.embed);
  const ext = mode?.links.filter((l) => !l.embed) ?? [];
  return (
    <div className={`hub-page hub-mode${embed ? ' embed' : ''}`} data-testid={`hub-mode-${modeKey}`}>
      <div className="hub-trow">
        <span className="hub-mode-icon"><HubIcon name={def.icon} size={18} /></span>
        <h1>{def.label}</h1>
        {mode && <StatePill state={mode.state} />}
        {mode?.tag && <span className="hub-tag">{mode.tag}</span>}
        <span className="hub-meta">마지막 활동 {relTime(mode?.lastActivity, now)}</span>
        <span className="hub-src-list">{mode?.sources.map((s) => <span key={s.name} className={`hub-src${s.ok ? '' : ' bad'}`}>{s.name}{s.ok ? '' : ` · ${s.error ?? '오류'}`}</span>)}</span>
        {embed && <span className="hub-pill">샌드박스 · GET 전용 · 쿠키 미전달</span>}
        {modeKey === 'msg' && <button type="button" className="hub-pill btn" onClick={() => onOpenMode('msg')}>터미널로</button>}
      </div>
      {!mode && <div className="hub-notice muted">상태를 불러오는 중…</div>}
      {embed ? (
        <div className="hub-frame">
          <div className="hub-fh">
            <span className="hub-fh-title">임베디드 · {mode?.name}</span>
            <span className="hub-fh-meta">같은 출처 프록시 · {embed.href}</span>
            <button type="button" className="hub-pill btn" onClick={() => setFrameKey((k) => k + 1)} aria-label="프레임 새로고침"><ReloadIcon /> 새로고침</button>
            <a className="hub-pill btn" href={embed.href} target="_blank" rel="noopener noreferrer">새 창에서 열기 <ExternalIcon /></a>
          </div>
          <iframe key={frameKey} className="hub-iframe" title={`${mode?.name ?? def.label} 임베디드`} src={embed.href}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
        </div>
      ) : mode && (
        <div className="hub-detail">
          <section className="hub-panel" aria-label="지표">
            <h2>지표</h2>
            {Object.keys(mode.metrics).length === 0 && <div className="hub-panel-empty">지표 없음</div>}
            {Object.entries(mode.metrics).map(([k, v]) => <div className="hub-kv" key={k}><span>{k}</span><b>{v === null ? '—' : typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v)}</b></div>)}
          </section>
          <section className="hub-panel" aria-label="알림">
            <h2>알림</h2>
            {mode.alerts.length === 0 ? <div className="hub-panel-empty">최근 알림 없음</div> : (
              <ul className="hub-alert-list">
                {mode.alerts.map((a, i) => <li key={i}><i className={`hub-dot ${a.level}`} /><span className="hub-txt">{a.text}</span><span className="hub-time">{a.at ? relTime(a.at, now) : ''}</span></li>)}
              </ul>
            )}
          </section>
          <section className="hub-panel" aria-label="바로가기">
            <h2>바로가기</h2>
            {ext.length === 0 ? <div className="hub-panel-empty">{modeKey === 'msg' ? '이 앱 자체입니다' : '외부 링크 없음 (서버 안에서만 읽음)'}</div> : ext.map((l) => <a key={l.href} className="hub-open ext big" href={l.href} target="_blank" rel="noopener noreferrer">{l.label} · 새 탭 <ExternalIcon /></a>)}
          </section>
        </div>
      )}
    </div>
  );
}
