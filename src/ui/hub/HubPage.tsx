import { useState } from 'react';
import type { HubAlert, HubKpi, HubMode, HubModeId, HubSection, HubState } from '../../shared/hub-types';
import { ExternalIcon, HubIcon, ReloadIcon } from './HubIcons';
import { Cards, Chart, Images, KvGrid, Steps } from './HubSections';
import { NexusHome } from './NexusHome';
import { modeDef, STATE_LABEL, stateClass } from './modes';
import { relTime } from './time';
import { ReplayTrainer } from './replay/ReplayTrainer';

/* ───────── atoms shared with the 개요 ───────── */

export function StatePill({ state }: { state: HubState }) {
  return <span className={`hub-st ${stateClass(state)}`}><i />{STATE_LABEL[state]}</span>;
}

const metricText = (v: HubMode['metrics'][string]): string => (v === null ? '—' : typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v));

/** An older server (no `page`): the first metrics stand in as KPIs so the page is never empty. */
export function kpisOf(mode: HubMode): HubKpi[] {
  return mode.page?.kpis ?? Object.entries(mode.metrics).slice(0, 6).map(([label, v]) => ({ label, value: metricText(v) }));
}
export function headlineOf(mode: HubMode): string {
  if (mode.page) return mode.page.headline;
  const worst = mode.alerts[0];
  return worst ? worst.text : `${STATE_LABEL[mode.state]}${mode.tag ? ` · ${mode.tag}` : ''}`;
}
export function decisionOf(mode: HubMode): string {
  return mode.page?.decision ?? (mode.alerts.some((a) => a.level !== 'info') ? '주의 항목 확인' : '조치 없음');
}

/** The two lines every mode leads with: what is going on, and what to decide next. */
export function Lead({ state, headline, decision }: { state: HubState; headline: string; decision: string }) {
  return (
    <div className={`lead ${stateClass(state)}`} data-testid="hub-lead">
      <p className="h">{headline}</p>
      <p className="d"><span className="d-k">다음 결정</span> {decision}</p>
    </div>
  );
}

export function Kpi({ k }: { k: HubKpi }) {
  // display size fits ~9 digit-width glyphs in the narrowest tile; Hangul/CJK glyphs are ~1.8 digits wide
  const width = Array.from(k.value).reduce((n, ch) => n + (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1.8 : 1), 0) + (k.unit?.length ?? 0) * 0.7;
  const size = width > 11 ? ' xs' : width > 8 ? ' sm' : '';
  return (
    <div className={`kpi ${k.status ?? ''}`}>
      <span className="l">{k.label}</span>
      <span className={`v${size}`}>{k.value}{k.unit && <span className="u">{k.unit}</span>}</span>
      {k.hint && <span className={`h ${k.status ?? ''}`}>{k.hint}</span>}
    </div>
  );
}

/** 주의: the alerts, worst first; a one-line "none" when the mode has nothing to flag. */
export function Attention({ alerts, now, who }: { alerts: (HubAlert & { who?: string; onWho?: () => void })[]; now: number; who?: boolean }) {
  if (alerts.length === 0) return <div className="att empty">주의 없음</div>;
  return (
    <ul className="att" aria-label="주의">
      {alerts.map((a, i) => (
        <li key={i} className={a.level}>
          <i className={`hub-dot ${a.level}`} />
          <span className="t">
            {who && a.who && (a.onWho ? <button type="button" className="hub-who" onClick={a.onWho}>{a.who}</button> : <b className="hub-who">{a.who}</b>)}
            {a.text}
            {a.hint && <span className="hint">→ {a.hint}</span>}
          </span>
          <span className="at">{a.at ? relTime(a.at, now) : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/* ───────── drill-down sections ───────── */

/** A status word at the start of a cell colours it (\b does not end a Hangul word, so the end is spelled out). */
const CELL_STATE: [RegExp, string][] = [[/^(?:가동|성공|정상|PASS|active|예)(?=$|[\s·(,])/, 'ok'], [/^(?:정지|대기|inactive|시작 중)(?=$|[\s·(,])/, 'warn'], [/^(?:실패|장애|failed|NO-GO|FAIL)(?=$|[\s·(,])/, 'bad']];
function cellClass(text: string, num: boolean): string {
  const st = CELL_STATE.find(([re]) => re.test(text))?.[1];
  return [num ? 'n' : '', st ? `st-${st}` : ''].filter(Boolean).join(' ');
}

function Table({ s }: { s: Extract<HubSection, { kind: 'table' }> }) {
  const num = new Set(s.num ?? []);
  const wrap = new Set(s.wrap ?? []);
  const cls = (text: string, j: number) => [cellClass(text, num.has(j)), wrap.has(j) ? 'w' : ''].filter(Boolean).join(' ');
  return (
    <div className="twrap">
      <table className="t">
        <thead><tr>{s.columns.map((c, i) => <th key={i} className={[num.has(i) ? 'n' : '', wrap.has(i) ? 'w' : ''].filter(Boolean).join(' ')}>{c}</th>)}</tr></thead>
        <tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={cls(c, j)}>{wrap.has(j) ? <span className="wtxt">{c}</span> : c}</td>)}</tr>)}</tbody>
      </table>
      {s.rows.length === 0 && <div className="sec-empty">자료 없음</div>}
    </div>
  );
}

function Bars({ s }: { s: Extract<HubSection, { kind: 'bars' }> }) {
  const max = Math.max(1e-9, ...s.items.map((b) => Math.abs(b.value)));
  return (
    <div className="bars">
      {s.items.map((b, i) => (
        <div className="bar" key={i}>
          <span className="l" title={b.label}>{b.label}</span>
          <span className="tr"><i className={b.value < 0 ? 'neg' : ''} style={{ width: `${Math.max(1, Math.round((Math.abs(b.value) / max) * 100))}%` }} /></span>
          <span className="v">{b.text ?? String(b.value)}</span>
        </div>
      ))}
      {s.items.length === 0 && <div className="sec-empty">자료 없음</div>}
    </div>
  );
}

/**
 * 원본 보기: the GET-only, cookie-less proxy inside a sandboxed frame — mounted only once the section is opened — or an
 * outside link in a new tab. The upstream's control buttons are not reachable (no allow-forms; the proxy refuses non-GET).
 */
function Raw({ s, name, open }: { s: Extract<HubSection, { kind: 'raw' }>; name: string; open: boolean }) {
  const [frameKey, setFrameKey] = useState(0);
  if (!s.embed) {
    return <div className="raw-ext"><a className="hub-open ext big" href={s.href} target="_blank" rel="noopener noreferrer">{s.title} · 새 탭 <ExternalIcon /></a><span className="meta">서버 밖 주소 · 여기서는 읽기만</span></div>;
  }
  return (
    <div className="hub-frame">
      <div className="hub-fh">
        <span className="hub-fh-title">원본 · {name}</span>
        <span className="hub-fh-meta">같은 출처 프록시 · GET 전용 · 쿠키 미전달 · 제어 숨김</span>
        <button type="button" className="pill btn" onClick={() => setFrameKey((k) => k + 1)} aria-label="프레임 새로고침"><ReloadIcon /> 새로고침</button>
        <a className="pill btn" href={s.href} target="_blank" rel="noopener noreferrer">새 탭 <ExternalIcon /></a>
      </div>
      {open && <iframe key={frameKey} className="hub-iframe" title={`${name} 원본`} src={s.href} sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />}
    </div>
  );
}

/** What the header counts: rows/items, or done/total for a pipeline (null when a count says nothing: text, raw, chart). */
export function sectionCount(s: HubSection): string | null {
  switch (s.kind) {
    case 'table': case 'kv': case 'kvgrid': return String(s.rows.length);
    case 'list': case 'bars': case 'cards': case 'images': return String(s.items.length);
    case 'steps': return `${s.items.filter((x) => x.state === 'done').length}/${s.items.length}`;
    default: return null;
  }
}

export function SectionView({ s, name }: { s: HubSection; name: string }) {
  const [open, setOpen] = useState(!!s.open);
  const count = sectionCount(s);
  return (
    <details className={`sec sec-${s.kind}`} open={open} data-testid={`hub-sec-${s.kind}`}>
      <summary onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}>
        <span className="sec-title">{s.title}</span>
        {s.note && <span className="n">{s.note}</span>}
        {count !== null && <span className={`cnt${s.kind === 'steps' ? ' frac' : ''}`}>{count}</span>}
      </summary>
      <div className="b">
        {s.kind === 'kv' && (s.rows.length === 0 ? <div className="sec-empty">자료 없음</div> : <div className="kv">{s.rows.map(([k, v], i) => <div key={i}><span>{k}</span><b>{v}</b></div>)}</div>)}
        {s.kind === 'table' && <Table s={s} />}
        {s.kind === 'list' && (s.items.length === 0 ? <div className="sec-empty">항목 없음</div> : (
          <ul className="att inner">
            {s.items.map((it, i) => (
              <li key={i} className={it.level ?? ''}><i className={`hub-dot ${it.level ?? 'none'}`} /><span className="t">{it.text}{it.hint && <span className="hint">{it.hint}</span>}</span>{it.at && <span className="at">{it.at.slice(0, 16).replace('T', ' ')}</span>}</li>
            ))}
          </ul>
        ))}
        {s.kind === 'bars' && <Bars s={s} />}
        {s.kind === 'cards' && <Cards s={s} />}
        {s.kind === 'chart' && (open ? <Chart s={s} /> : null)}
        {s.kind === 'steps' && <Steps s={s} />}
        {s.kind === 'images' && (open ? <Images s={s} /> : null)}
        {s.kind === 'kvgrid' && <KvGrid s={s} />}
        {s.kind === 'text' && <pre className="text">{s.body}</pre>}
        {s.kind === 'raw' && <Raw s={s} name={name} open={open} />}
      </div>
    </details>
  );
}

/* ───────── the page ───────── */

/**
 * One mode, on the common template: header (name, state, tag, activity, sources) → lead (headline, decision) → KPIs →
 * 주의 → drill-down sections (the first ones open, 원본 보기 last) → footer. Everything is read-only.
 */
export function HubPage({ modeKey, mode, now, error, loading, onRefresh, generatedAt }: { modeKey: HubModeId; mode: HubMode | undefined; now: number; error: string | null; loading: boolean; onRefresh: () => void; generatedAt: string | null }) {
  const def = modeDef(modeKey);
  const kpis = mode ? kpisOf(mode) : [];
  const sections = mode?.page?.sections ?? [];
  return (
    <div className="hub-page" data-testid={`hub-mode-${modeKey}`} data-mode={modeKey}>
      <header className="ph">
        <span className="mode-ico"><HubIcon name={def.icon} size={18} /></span>
        <h1>{mode?.name ?? def.label}</h1>
        {mode && <StatePill state={mode.state} />}
        {mode?.tag && <span className="hub-tag">{mode.tag}</span>}
        <span className="meta">마지막 활동 {relTime(mode?.lastActivity, now)}</span>
        {mode && mode.sources.length > 0 && <span className="hub-src-list">{mode.sources.map((s) => <span key={s.name} className={`src${s.ok ? '' : ' bad'}`} title={s.ok ? `${s.ms}ms` : s.error ?? '오류'}>{s.name}{s.ok ? '' : ` · ${s.error ?? '오류'}`}</span>)}</span>}
        <span className="ph-end">
          <span className="pill">읽기 전용</span>
          <button type="button" className="pill btn" onClick={onRefresh} disabled={loading} aria-label="지금 새로고침"><ReloadIcon /> {loading ? '불러오는 중…' : '새로고침'}</button>
        </span>
      </header>
      {error && <div className="hub-notice" role="alert">상태를 불러오지 못했어요 · {error}</div>}
      {!mode && !error && <div className="hub-notice muted">상태를 불러오는 중…</div>}
      {mode && <Lead state={mode.state} headline={headlineOf(mode)} decision={decisionOf(mode)} />}
      {kpis.length > 0 && <div className="kpis" data-testid="hub-kpis">{kpis.map((k, i) => <Kpi key={i} k={k} />)}</div>}
      {mode && (
        <section className="sec open-static" aria-label="주의">
          <div className="sh"><span className="sec-title">주의</span><span className="cnt">{mode.alerts.length}</span></div>
          <Attention alerts={mode.alerts} now={now} />
        </section>
      )}
      {mode?.id === 'nexus' && mode.nexus && <NexusHome home={mode.nexus} now={now} />}
      {mode && sections.map((s, i) => <SectionView key={`${s.title}-${i}`} s={s} name={mode.name} />)}
      {mode && !mode.page && Object.keys(mode.metrics).length > 0 && <SectionView s={{ kind: 'kv', title: '지표', open: true, rows: Object.entries(mode.metrics).map(([k, v]) => [k, metricText(v)]) }} name={mode.name} />}
      {mode && !mode.page && mode.links.filter((l) => !l.embed).map((l) => <SectionView key={l.href} s={{ kind: 'raw', title: l.label, href: l.href }} name={mode.name} />)}
      {modeKey === 'trading' && <ReplayTrainer />}
      {mode && (
        <footer className="foot">
          <span>소스 {mode.sources.filter((s) => s.ok).length}/{mode.sources.length}{mode.sources.length ? ` · ${mode.sources.map((s) => `${s.name} ${s.ok ? `${s.ms}ms` : '실패'}`).join(' · ')}` : ''}</span>
          <span>서버 생성 {relTime(generatedAt, now)}</span>
          <span>읽기 전용 · 제어 없음</span>
        </footer>
      )}
    </div>
  );
}
