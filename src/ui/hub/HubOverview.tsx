import type { HubAlert, HubMode, HubStatus } from '../../shared/hub-types';
import { ChevronRightIcon, ExternalIcon, HubIcon, ReloadIcon } from './HubIcons';
import { modeDef, STATE_LABEL, type HubModeKey } from './modes';
import { relTime } from './time';

const stateClass = (s: HubMode['state']) => (s === 'down' ? 'bad' : s);

export function StatePill({ state }: { state: HubMode['state'] }) {
  return <span className={`hub-st ${stateClass(state)}`}><i />{STATE_LABEL[state]}</span>;
}

function firstAlert(m: HubMode): HubAlert | null {
  return m.alerts.find((a) => a.level === 'bad') ?? m.alerts.find((a) => a.level === 'warn') ?? m.alerts[0] ?? null;
}

/** One status card: state, last activity, up to four metrics, the worst alert, and a way in. */
export function HubCard({ mode, now, onOpenMode }: { mode: HubMode; now: number; onOpenMode: (m: HubModeKey) => void }) {
  const def = modeDef(mode.id);
  const metrics = Object.entries(mode.metrics).slice(0, 4);
  const alert = firstAlert(mode);
  const embed = mode.links.find((l) => l.embed);
  const ext = mode.links.find((l) => !l.embed);
  const ok = mode.sources.filter((s) => s.ok).length;
  return (
    <article className={`hub-card ${stateClass(mode.state)}`} data-mode={mode.id} aria-label={mode.name}>
      <div className="hub-card-top">
        <span className="hub-card-icon"><HubIcon name={def.icon} /></span>
        <h3 className="hub-card-name">{mode.name}</h3>
        <StatePill state={mode.state} />
      </div>
      <div className="hub-card-sub">
        <span>마지막 활동 {relTime(mode.lastActivity, now)}</span>
        {mode.tag && <span className="hub-tag">{mode.tag}</span>}
      </div>
      <dl className="hub-mets">
        {metrics.length === 0 && <div className="hub-met empty">지표 없음</div>}
        {metrics.map(([k, v]) => <div className="hub-met" key={k}><dt>{k}</dt><dd>{v === null ? '—' : typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v)}</dd></div>)}
      </dl>
      <div className={`hub-alert ${alert ? alert.level : 'none'}`}>{alert ? alert.text : '최근 알림 없음'}</div>
      <div className="hub-card-foot">
        <span className="hub-card-src">소스 {ok}/{mode.sources.length}{mode.sources.some((s) => !s.ok) ? ` · ${mode.sources.find((s) => !s.ok)?.error ?? '오류'}` : ''}</span>
        {embed || mode.id !== 'msg' ? (
          <button type="button" className="hub-open" onClick={() => onOpenMode(mode.id)}>열기 <ChevronRightIcon /></button>
        ) : (
          <button type="button" className="hub-open" onClick={() => onOpenMode('msg')}>터미널 <ChevronRightIcon /></button>
        )}
        {ext && <a className="hub-open ext" href={ext.href} target="_blank" rel="noopener noreferrer">{ext.label} <ExternalIcon /></a>}
      </div>
    </article>
  );
}

/** The 개요: eight cards, the recent alerts, the server. */
export function HubOverview({ status, error, loading, fetchedAt, now, onOpenMode, onRefresh }: { status: HubStatus | null; error: string | null; loading: boolean; fetchedAt: number | null; now: number; onOpenMode: (m: HubModeKey) => void; onRefresh: () => void }) {
  const modes = status?.modes ?? [];
  const sources = modes.reduce((n, m) => n + m.sources.length, 0);
  const alerts = modes.flatMap((m) => m.alerts.map((a) => ({ ...a, who: m.name, id: m.id }))).filter((a) => a.level !== 'info').slice(0, 8);
  return (
    <div className="hub-page" data-testid="hub-overview">
      <div className="hub-trow">
        <h1>개요</h1>
        <span className="hub-meta">모드 {modes.length} · 소스 {sources} · 서버 {status ? 1 : 0}대</span>
        <span className="hub-pill">자동 새로고침 15초</span>
        <span className="hub-pill">읽기 전용 · 제어 없음</span>
        <button type="button" className="hub-pill btn" onClick={onRefresh} disabled={loading} aria-label="지금 새로고침"><ReloadIcon /> {loading ? '불러오는 중…' : '새로고침'}</button>
      </div>
      {error && <div className="hub-notice" role="alert">상태를 불러오지 못했어요 · {error}{status ? ` · 마지막 성공 ${relTime(fetchedAt ? new Date(fetchedAt).toISOString() : null, now)}` : ''}</div>}
      {!status && !error && <div className="hub-notice muted">상태를 불러오는 중…</div>}
      <div className="hub-grid">
        {modes.map((m) => <HubCard key={m.id} mode={m} now={now} onOpenMode={onOpenMode} />)}
      </div>
      {status && (
        <div className="hub-bottom">
          <section className="hub-panel" aria-label="최근 알림">
            <h2>최근 알림</h2>
            {alerts.length === 0 ? <div className="hub-panel-empty">알림 없음</div> : (
              <ul className="hub-alert-list">
                {alerts.map((a, i) => (
                  <li key={`${a.id}-${i}`}>
                    <i className={`hub-dot ${a.level}`} />
                    <button type="button" className="hub-who" onClick={() => onOpenMode(a.id)}>{a.who}</button>
                    <span className="hub-txt">{a.text}</span>
                    <span className="hub-time">{a.at ? relTime(a.at, now) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="hub-panel" aria-label="서버">
            <h2>서버</h2>
            <div className="hub-kv"><span>호스트</span><b>{status.host}</b></div>
            <div className="hub-kv"><span>상태 생성</span><b>{relTime(status.generated_at, now)}</b></div>
            <div className="hub-kv"><span>소스 응답</span><b>{modes.reduce((n, m) => n + m.sources.filter((s) => s.ok).length, 0)}/{sources}</b></div>
            <div className="hub-kv"><span>갱신 주기</span><b>15초 · 서버 캐시 15초</b></div>
          </section>
        </div>
      )}
    </div>
  );
}
