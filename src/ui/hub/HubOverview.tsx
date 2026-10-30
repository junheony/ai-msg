import type { HubMode, HubState, HubStatus } from '../../shared/hub-types';
import { ChevronRightIcon, HubIcon, ReloadIcon } from './HubIcons';
import { Attention, decisionOf, headlineOf, kpisOf, Lead, StatePill } from './HubPage';
import { modeDef, STATE_LABEL, stateClass, type HubModeKey } from './modes';
import { relTime } from './time';

const RANK: Record<HubState, number> = { down: 0, warn: 1, unknown: 2, idle: 3, ok: 4 };
const worstOf = (modes: HubMode[]): HubState => modes.reduce<HubState>((w, m) => (RANK[m.state] < RANK[w] ? m.state : w), 'ok');

/** One card: name · state · the mode's headline · two KPIs · its worst alert (or its next decision) · a way in. */
export function HubCard({ mode, now, onOpenMode }: { mode: HubMode; now: number; onOpenMode: (m: HubModeKey) => void }) {
  const def = modeDef(mode.id);
  const alert = mode.alerts.find((a) => a.level === 'bad') ?? mode.alerts.find((a) => a.level === 'warn') ?? null;
  const kpis = kpisOf(mode).slice(0, 2);
  return (
    <article className={`card ${stateClass(mode.state)}`} data-mode={mode.id} aria-label={mode.name}>
      <div className="top">
        <span className="ico"><HubIcon name={def.icon} /></span>
        <h3>{mode.name}</h3>
        {mode.tag && <span className="hub-tag">{mode.tag}</span>}
        <StatePill state={mode.state} />
      </div>
      <p className="hl">{headlineOf(mode)}</p>
      {kpis.length > 0 && (
        <div className="ck">
          {kpis.map((k, i) => <div key={i}><span className="l">{k.label}</span><span className={`v ${k.status ?? ''}`}>{k.value}{k.unit ? <span className="u">{k.unit}</span> : null}</span></div>)}
        </div>
      )}
      <div className={`al ${alert ? alert.level : 'next'}`} title={alert ? alert.text : decisionOf(mode)}>{alert ? alert.text : `다음 · ${decisionOf(mode)}`}</div>
      <div className="ft">
        <span>마지막 활동 {relTime(mode.lastActivity, now)}</span>
        <button type="button" className="open" onClick={() => onOpenMode(mode.id)} aria-label={`${mode.name} 열기`}>{mode.id === 'msg' ? '터미널' : '열기'} <ChevronRightIcon /></button>
      </div>
    </article>
  );
}

/** The 개요: what needs attention across every mode, then one card per mode, then the server. */
export function HubOverview({ status, error, loading, fetchedAt, now, pushOn, onOpenMode, onRefresh }: { status: HubStatus | null; error: string | null; loading: boolean; fetchedAt: number | null; now: number; pushOn: boolean; onOpenMode: (m: HubModeKey) => void; onRefresh: () => void }) {
  const modes = status?.modes ?? [];
  const n = { down: 0, warn: 0, ok: 0, idle: 0, unknown: 0 };
  for (const m of modes) n[m.state]++;
  const attention = modes.flatMap((m) => m.alerts.filter((a) => a.level !== 'info').map((a) => ({ ...a, who: m.name, onWho: () => onOpenMode(m.id) })));
  attention.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  const first = attention[0];
  const sources = modes.reduce((s, m) => s + m.sources.length, 0);
  const sourcesOk = modes.reduce((s, m) => s + m.sources.filter((x) => x.ok).length, 0);
  const headline = `장애 ${n.down} · 주의 ${n.warn} · 정상 ${n.ok}${n.idle ? ` · 대기 ${n.idle}` : ''}${n.unknown ? ` · 미확인 ${n.unknown}` : ''}`;
  const decision = first ? `${first.who} — ${first.text}${first.hint ? ` → ${first.hint}` : ''}` : '지금 결정할 것 없음';
  return (
    <div className="hub-page" data-testid="hub-overview">
      <header className="ph">
        <span className="mode-ico"><HubIcon name="grid" size={18} /></span>
        <h1>개요</h1>
        <span className="meta">모드 {modes.length} · 소스 {sourcesOk}/{sources}{status ? ` · ${status.host}` : ''}</span>
        <span className="ph-end">
          <span className="pill">{pushOn ? '실시간 푸시' : '15초 폴링'}</span>
          <span className="pill">읽기 전용</span>
          <button type="button" className="pill btn" onClick={onRefresh} disabled={loading} aria-label="지금 새로고침"><ReloadIcon /> {loading ? '불러오는 중…' : '새로고침'}</button>
        </span>
      </header>
      {error && <div className="hub-notice" role="alert">상태를 불러오지 못했어요 · {error}{status ? ` · 마지막 성공 ${relTime(fetchedAt ? new Date(fetchedAt).toISOString() : null, now)}` : ''}</div>}
      {!status && !error && <div className="hub-notice muted">상태를 불러오는 중…</div>}
      {status && <Lead state={worstOf(modes)} headline={headline} decision={decision} />}
      <div className="cards">
        {modes.map((m) => <HubCard key={m.id} mode={m} now={now} onOpenMode={onOpenMode} />)}
      </div>
      {status && (
        <div className="grid2">
          <section className="sec open-static" aria-label="주의 목록">
            <div className="sh"><span className="sec-title">주의 목록</span><span className="n">장애 → 주의 순 · 모드 이름을 누르면 이동</span><span className="cnt">{attention.length}</span></div>
            <Attention alerts={attention} now={now} who />
          </section>
          <section className="sec open-static" aria-label="서버">
            <div className="sh"><span className="sec-title">서버</span></div>
            <div className="b">
              <div className="kv one">
                <div><span>호스트</span><b>{status.host}</b></div>
                <div><span>상태 생성</span><b>{relTime(status.generated_at, now)}</b></div>
                <div><span>마지막 수신</span><b>{fetchedAt ? relTime(new Date(fetchedAt).toISOString(), now) : '—'}</b></div>
                <div><span>갱신</span><b>{pushOn ? '푸시 · 변화 때마다 (15초 점검)' : '폴링 15초'} · 서버 캐시 15초</b></div>
                <div><span>상태 뜻</span><b>{(Object.keys(STATE_LABEL) as HubState[]).map((s) => STATE_LABEL[s]).join(' / ')}</b></div>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
