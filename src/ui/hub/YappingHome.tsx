import type { HubKpi, HubMode, HubSection } from '../../shared/hub-types';
import { yappingSourceSummary } from '../../shared/yapping';
import { fmtKstFull, relTime } from './time';
import './yapping.css';

function Cap({ item }: { item: HubKpi }) {
  const parts = /^(\d+) \/ (\d+)$/.exec(item.value);
  const missing = !parts;
  const stale = item.hint?.startsWith('마지막 정상');
  return <div className={`yp-cap${missing ? ' yp-missing' : ''}${stale ? ' yp-stale' : ''}`}>
    <span className="yp-label">{item.label}</span>
    <strong className={item.status === 'warn' ? 'yp-over' : ''}>{parts ? <>{parts[1]}<span className="yp-limit"> / {parts[2]}</span></> : '데이터 없음'}</strong>
    {parts && <meter min={0} max={Number(parts[2]) || 1} value={Math.min(Number(parts[1]), Number(parts[2]))} aria-label={`${item.label} 한도 사용량`} />}
    <p>{item.hint || (missing ? '운영 기록을 확인할 수 없음' : '')}</p>
  </div>;
}
function Recent({ section, now }: { section: Extract<HubSection, { kind: 'table' }>; now: number }) {
  return <section className="yp-recent" aria-label={section.title}>
    <div className="yp-section-head"><h3>{section.title}</h3><span>{section.note}</span></div>
    {section.rows.length ? <ol>{section.rows.slice(0, 3).map(([at, title, href], i) => <li key={href || i}>
      <time dateTime={at} title={at ? fmtKstFull(at) : undefined}>{at ? relTime(at, now) : '시각 없음'}</time>
      <a href={href} target="_blank" rel="noopener noreferrer">{title || '게시물 보기'}<span className="yp-link-hint">{section.title.startsWith('X') ? 'X에서 보기' : 'Telegram에서 보기'}</span></a>
    </li>)}</ol> : <p className="yp-empty">{section.note || '데이터 없음 · 게시 기록 없음'}</p>}
  </section>;
}

export function YappingHome({ mode, now }: { mode: HubMode; now: number }) {
  const page = mode.page;
  if (!page) return null;
  // The new collector identifies caps by meaning, never expose retired manual-rotation payloads.
  const caps = ['속보', '리포트', '전체 게시', '답글'].map((label) => page.kpis.find((k) => k.label === label) ?? { label, value: '데이터 없음', hint: '자동 성장 기록이 아직 연결되지 않음' });
  const growth = ['팔로워 변화', '조회수 변화'].map((label) => page.kpis.find((k) => k.label === label) ?? { label, value: '데이터 없음', hint: '비교 관측값 없음' });
  const latest = page.sections.filter((s): s is Extract<HubSection, { kind: 'table' }> => s.kind === 'table' && ['X 최근 게시', 'Telegram 미러'].includes(s.title));
  const details = page.sections.find((s) => s.kind === 'kv' && s.title === '소스 상태');
  return <div className="yp-home" data-testid="yapping-home">
    <header className="yp-heading"><div><h2>@cblabx 자동 성장</h2><p>속보와 리포트 게시, 대화와 성장 기록</p></div><a href="https://x.com/cblabx" target="_blank" rel="noopener noreferrer">@cblabx</a></header>
    <section className="yp-budget" aria-label="일일 한도 사용량"><div className="yp-section-head"><h3>일일 한도</h3><span>게시 03:00 · 답글 00:00 KST 초기화</span></div><div className="yp-caps">{caps.map((item) => <Cap key={item.label} item={item} />)}</div></section>
    {mode.alerts.filter((a) => !/응답 없음|시간 초과/.test(a.text)).map((a, i) => <p className="yp-alert" key={i}>{a.text}</p>)}
    <section className="yp-growth" aria-label="성장 변화">{growth.map((item) => <div className={`yp-growth-item${item.value === '데이터 없음' ? ' yp-missing' : ''}${item.hint?.startsWith('마지막 정상') ? ' yp-stale' : ''}`} key={item.label}><span className="yp-label">{item.label}</span><strong>{item.value}</strong><p>{item.hint}</p></div>)}</section>
    <div className="yp-feeds">{latest.map((section) => <Recent key={section.title} section={section} now={now} />)}</div>
    <details className="yp-sources"><summary><span>소스 상태</span><span>{yappingSourceSummary(mode.sources)}</span></summary><div className="yp-source-body"><ul>{mode.sources.map((source) => <li key={source.name}><span>{source.name}</span><span>{source.ok ? '연결됨' : source.error || '확인 필요'}</span></li>)}</ul>{details?.kind === 'kv' && <dl>{details.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}</div></details>
  </div>;
}
