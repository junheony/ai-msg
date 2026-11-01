import { useMemo, useState } from 'react';
import type { HubAlert, HubKpi, HubMode, HubModeId, HubSection, HubState } from '../../shared/hub-types';
import type { LabState } from '../../shared/lab-types';
import { ExternalIcon, HubIcon, ReloadIcon } from './HubIcons';
import { Cards, Chart, Images, KvGrid, Steps } from './HubSections';
import { NexusHome } from './NexusHome';
import { TradingScoreboard, TradingHome } from './TradingHome';
import { GameStudioHome } from './gamestudio/GameStudioHome';
import { readVideoProject, sfHeader, ShortsFactoryHome, VIDEO_PROJECTS, writeVideoProject, type VideoProject } from './ShortsFactoryHome';
import { modeDef, STATE_LABEL, stateClass } from './modes';
import { fmtKstFull, relTime } from './time';
import { historyStats, readHistory } from './replay/history';
import { liveSrApi, type SrApi } from './sr/api';
import { paperBadge, SrPanel } from './sr/SrPanel';
import { useSrFeed, type SrFeed } from './sr/useSrFeed';
import { liveLabApi, type LabApi } from './lab/api';
import { LabPanel } from './lab/LabPanel';
import { useLabFeed, type LabFeed } from './lab/useLabFeed';

/* ───────── atoms shared with the 개요 ───────── */

export function StatePill({ state, label }: { state: HubState; label?: string | undefined }) {
  return <span className={`hub-st ${stateClass(state)}`}><i />{label ?? STATE_LABEL[state]}</span>;
}

interface SourceRow { name: string; ok: boolean; off?: boolean | undefined; detail: string }

/**
 * 소스 상태: every feed behind a page, folded away. The header shows one dot; the rows only open on request, because a
 * real problem has already surfaced in plain words under 주의.
 */
export function SourceStatus({ sources, note }: { sources: SourceRow[]; note?: string | undefined }) {
  const live = sources.filter((s) => !s.off);
  const failed = live.filter((s) => !s.ok).length;
  const tone = live.length === 0 ? '' : failed === 0 ? 'ok' : failed === live.length ? 'bad' : 'warn';
  const word = live.length === 0 ? '사용 안 함' : failed === 0 ? '모두 정상' : `${failed}개 문제`;
  return (
    <details className="hub-sources" data-testid="hub-sources">
      <summary aria-label={`소스 상태 · ${word}`} title={word}><span className={`hub-dot ${tone}`} data-testid="hub-sources-dot" /><span>소스 상태</span></summary>
      <div className="hub-sources-panel">
        <ul>
          {sources.map((s) => <li key={s.name} className={s.off ? 'off' : s.ok ? 'ok' : 'bad'}><span className={`hub-dot ${s.off ? '' : s.ok ? 'ok' : 'warn'}`} /><span className="nm">{s.name}</span><span className="dt">{s.detail}</span></li>)}
        </ul>
        {note && <p className="hub-sources-note">{note}</p>}
      </div>
    </details>
  );
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
  const size = width > 13 ? ' xxs' : width > 11 ? ' xs' : width > 8 ? ' sm' : '';
  return (
    <div className={`kpi ${k.status ?? ''}`}>
      <span className="l" title={k.label}>{k.label}</span>
      <span className={`v${size}`} title={`${k.value}${k.unit ?? ''}`}>{k.value}{k.unit && <span className="u">{k.unit}</span>}</span>
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
function Raw({ s, name, open, linkOnly = false }: { s: Extract<HubSection, { kind: 'raw' }>; name: string; open: boolean; linkOnly?: boolean }) {
  const [frameKey, setFrameKey] = useState(0);
  if (!s.embed || linkOnly) {
    return <div className="raw-ext"><a className="hub-open ext big" href={s.href} target="_blank" rel="noopener noreferrer">{s.title} · 새 탭 <ExternalIcon /></a><span className="meta">{s.embed ? '같은 출처 프록시 · GET 전용 · 새 탭에서만' : '서버 밖 주소 · 여기서는 읽기만'}</span></div>;
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

/**
 * One drill-down section. Collapsible by default; `static` renders it always open with no `<summary>` — the Trading room
 * is links only, so even a fold is out, and 원본 보기 there is a new-tab link rather than a frame with a reload button.
 */
export function SectionView({ s, name, static: isStatic = false }: { s: HubSection; name: string; static?: boolean }) {
  const [toggled, setToggled] = useState(!!s.open);
  const open = isStatic || toggled;
  const count = sectionCount(s);
  const head = (
    <>
      <span className="sec-title">{s.title}</span>
      {s.note && <span className="n">{s.note}</span>}
      {count !== null && <span className={`cnt${s.kind === 'steps' ? ' frac' : ''}`}>{count}</span>}
    </>
  );
  const body = (
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
        {s.kind === 'raw' && <Raw s={s} name={name} open={open} linkOnly={isStatic} />}
      </div>
  );
  if (isStatic) {
    return <section className={`sec sec-${s.kind} open-static`} data-testid={`hub-sec-${s.kind}`} data-static="true"><div className="sh">{head}</div>{body}</section>;
  }
  return (
    <details className={`sec sec-${s.kind}`} open={open} data-testid={`hub-sec-${s.kind}`}>
      <summary onClick={(e) => { e.preventDefault(); setToggled((o) => !o); }}>{head}</summary>
      {body}
    </details>
  );
}

/* ───────── Trading room: the two paper sources, up front ───────── */

const LAB_STATE_KO: Record<LabState, string> = { ok: '정상', partial: '일부 오류', loading: '엔진 준비 중', stale: '이전 값', error: '오류', offline: '오프라인', 'verify-failed': '원장 검증 실패' };
const toneOfLab = (st: LabState | undefined, clientError: string | null): '' | 'warn' | 'bad' => (!st || clientError ? 'bad' : st === 'ok' ? '' : st === 'error' || st === 'offline' || st === 'verify-failed' ? 'bad' : 'warn');

/**
 * Where the paper numbers come from, before any of them: one card per source with its PAPER ONLY verdict, the service
 * behind it, the reading's time in KST and a link down to its section. Both sources stay discoverable from the fold.
 */
export function SourceStrip({ lab, sr }: { lab: LabFeed; sr: SrFeed }) {
  const snap = lab.response?.snapshot ?? null;
  const labTone = toneOfLab(lab.response?.state, lab.clientError);
  const labState = lab.clientError ?? (lab.response ? LAB_STATE_KO[lab.response.state] + (lab.response.error ? ` · ${lab.response.error}` : '') : '불러오는 중…');
  const all = sr.all;
  const badge = paperBadge(all);
  const srOk = all?.feeds.sr.ok ?? false, stOk = all?.feeds.status.ok ?? false;
  const srTone = !all ? (sr.error ? 'bad' : '') : badge.tone === 'bad' ? 'bad' : !srOk && !stOk ? 'bad' : !srOk || !stOk || all.feeds.sr.stale || all.feeds.status.stale ? 'warn' : '';
  return (
    <div className="tr-src" data-testid="tr-src" aria-label="페이퍼 출처">
      <article className={`hs-card ${labTone}`} data-testid="tr-src-lab">
        <div className="hs-card-top"><h4><span className="tr-src-name">Lab</span> 연구실 페이퍼 요약</h4><span className="hs-badge tr-src-paper ok" title="live=false · read_only=true">PAPER ONLY</span></div>
        <p className="hs-card-sub">트레이딩 ver2 · 60초 갱신</p>
        <dl className="hs-rows">
          <div><dt>기준 시각</dt><dd>{fmtKstFull(snap?.generated_at ?? null)}</dd></div>
          <div><dt>상태</dt><dd className={labTone === 'bad' ? 'bad' : labTone === 'warn' ? 'warn' : 'ok'}>{labState}</dd></div>
          <div><dt>전략 북 · 열린 포지션</dt><dd>{snap?.books ? `${snap.books.length}개` : '미보고'} · {snap?.open_positions_total ?? '미보고'}</dd></div>
        </dl>
        <div className="hs-card-links"><a className="hub-open" href="#hub-lab">Lab 연구실 요약으로 ↓</a></div>
      </article>
      <article className={`hs-card ${srTone}`} data-testid="tr-src-sr">
        <div className="hs-card-top"><h4><span className="tr-src-name">SR / DCA</span> 지지·저항 · 분할매수(DCA)</h4><span className={`hs-badge tr-src-paper ${badge.tone}`} title={badge.title}>{badge.text}</span></div>
        <p className="hs-card-sub">트레이딩룸 · 60초 갱신</p>
        <dl className="hs-rows">
          <div><dt>SR 스냅샷</dt><dd className={!all ? '' : srOk ? (all.feeds.sr.stale ? 'warn' : 'ok') : 'bad'}>{all ? (srOk ? fmtKstFull(all.snapshotAt ?? all.room?.srSnapshot?.mtime ?? null) + (all.feeds.sr.stale ? ' · 이전 값' : '') : `응답 없음${all.feeds.sr.error ? ` · ${all.feeds.sr.error}` : ''}`) : sr.error ? `응답 없음 · ${sr.error}` : '불러오는 중…'}</dd></div>
          <div><dt>룸 상태</dt><dd className={!all ? '' : stOk ? (all.feeds.status.stale ? 'warn' : 'ok') : 'bad'}>{all ? (stOk ? fmtKstFull(all.room?.generatedAt ?? null) + (all.feeds.status.stale ? ' · 이전 값' : '') : `응답 없음${all.feeds.status.error ? ` · ${all.feeds.status.error}` : ''}`) : '—'}</dd></div>
          <div><dt>심볼 · 구간</dt><dd>{all ? `${all.symbols.length} · ${all.rangeCount}` : '—'}</dd></div>
        </dl>
        <div className="hs-card-links"><a className="hub-open" href="#hub-sr">SR / DCA 지지·저항으로 ↓</a></div>
      </article>
    </div>
  );
}

/**
 * The replay log this browser holds, read-only: counts and the running result. The interactive trainer is not reachable
 * from the Trading room — no link, no sub-screen — so the room stays links-only end to end.
 */
export function PracticeCard() {
  const st = useMemo(() => historyStats(readHistory()), []);
  const pct = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
  return (
    <section id="hub-practice" className="sec open-static tr-sec tr-practice" aria-label="복기 연습 기록" data-testid="hub-practice">
      <div className="sh"><span className="sec-title">복기 연습 기록</span><span className="n">이 브라우저에 저장된 모의 복기 · 주문 없음</span><span className="cnt">{st.sessions}</span></div>
      <div className="b">
        <div className="tr-mini">
          <div className="tr-mi"><span className="k">세션</span><b>{st.sessions}</b></div>
          <div className="tr-mi"><span className="k">판단 횟수</span><b>{st.trades}</b></div>
          <div className={`tr-mi${st.hitRate === null ? '' : st.hitRate >= 0.5 ? ' ok' : ' warn'}`}><span className="k">적중률</span><b>{st.hitRate === null ? '—' : `${Math.round(st.hitRate * 100)}%`}</b></div>
          <div className={`tr-mi${st.totalPct > 0 ? ' ok' : st.totalPct < 0 ? ' bad' : ''}`}><span className="k">누적 결과</span><b>{pct(st.sessions ? st.totalPct : null)}</b></div>
        </div>
        <p className="tr-rule">이 브라우저에 저장된 복기 기록만 읽어 보여줍니다 · 재생·판단 조작 화면은 트레이딩 룸에서 열리지 않습니다</p>
      </div>
    </section>
  );
}

/* ───────── the page ───────── */

/**
 * One mode, on the common template: header (name, state, tag, activity, sources) → lead (headline, decision) → KPIs →
 * 주의 → drill-down sections (the first ones open, 원본 보기 last) → footer. Everything is read-only.
 */
export interface HubPageProps { modeKey: HubModeId; mode: HubMode | undefined; now: number; error: string | null; loading: boolean; onRefresh: () => void; generatedAt: string | null; /** Trading room reads, injectable for tests. */ labApi?: LabApi; srApi?: SrApi }

export function HubPage({ modeKey, mode, now, error, loading, onRefresh, generatedAt, labApi = liveLabApi, srApi = liveSrApi }: HubPageProps) {
  const def = modeDef(modeKey);
  const trading = modeKey === 'trading';
  // The Trading room's two paper sources are read once here and shared with the strip and the panels.
  const lab = useLabFeed(labApi, trading);
  const sr = useSrFeed(srApi, trading);
  // 영상 carries two projects: engineering-shorts (the mode's own page) and Shorts 공장 (mode.shorts). The choice is kept.
  const [project, setProject] = useState<VideoProject>(readVideoProject);
  const pick = (p: VideoProject) => { setProject(p); writeVideoProject(p); };
  const factory = modeKey === 'video' && project === 'factory';
  const own = !factory;
  // While Shorts 공장 is selected the header speaks for it, not for engineering-shorts.
  const head = factory && mode?.shorts ? sfHeader(mode.shorts) : null;
  const kpis = mode ? kpisOf(mode) : [];
  const sections = mode?.page?.sections ?? [];
  // Keyed by title (a suffix only for a repeated title), so a section added above does not remount — and collapse — the rest.
  const seen = new Map<string, number>();
  const sectionKeys = sections.map((s) => { const n = seen.get(s.title) ?? 0; seen.set(s.title, n + 1); return n ? `${s.title}#${n}` : s.title; });
  // 게임 mode with the studio collector on: the lobby leads and the old ops view folds under 상세 기록.
  const studio = mode?.id === 'game' ? mode.studio : undefined;
  const ops = (
    <>
      {mode && <Lead state={mode.state} headline={headlineOf(mode)} decision={decisionOf(mode)} />}
      {mode?.trading?.scoreboard && <TradingScoreboard rows={mode.trading.scoreboard} tag={mode.tag} />}
      {trading && <SourceStrip lab={lab} sr={sr} />}
      {kpis.length > 0 && <div className="kpis" data-testid="hub-kpis">{kpis.map((k, i) => <Kpi key={i} k={k} />)}</div>}
      {mode && (
        <section className="sec open-static" aria-label="주의">
          <div className="sh"><span className="sec-title">주의</span><span className="cnt">{mode.alerts.length}</span></div>
          <Attention alerts={mode.alerts} now={now} />
        </section>
      )}
      {mode?.id === 'nexus' && mode.nexus && <NexusHome home={mode.nexus} now={now} />}
      {trading && <LabPanel api={labApi} now={now} feed={lab} />}
      {trading && <SrPanel api={srApi} now={now} feed={sr} />}
      {mode?.id === 'trading' && mode.trading && <TradingHome t={mode.trading} now={now} />}
      {mode && sections.map((s, i) => <SectionView key={sectionKeys[i]} s={s} name={mode.name} static={trading} />)}
      {mode && !mode.page && Object.keys(mode.metrics).length > 0 && <SectionView s={{ kind: 'kv', title: '지표', open: true, rows: Object.entries(mode.metrics).map(([k, v]) => [k, metricText(v)]) }} name={mode.name} static={trading} />}
      {mode && !mode.page && mode.links.filter((l) => !l.embed).map((l) => <SectionView key={l.href} s={{ kind: 'raw', title: l.label, href: l.href }} name={mode.name} static={trading} />)}
      {trading && <PracticeCard />}
    </>
  );
  return (
    <div className="hub-page" data-testid={`hub-mode-${modeKey}`} data-mode={modeKey}>
      <header className="ph">
        <span className="mode-ico"><HubIcon name={def.icon} size={18} /></span>
        <h1>{mode?.name ?? def.label}</h1>
        {mode && <StatePill state={head ? head.state : mode.state} label={head ? undefined : mode.stateLabel} />}
        {head ? <span className="hub-tag">Shorts 공장</span> : mode?.tag && !studio && <span className="hub-tag">{mode.tag}</span>}
        <span className="meta">{head ? '파일 갱신' : '마지막 활동'} {relTime(head ? head.lastActivity : mode?.lastActivity, now)}</span>
        {head && <SourceStatus sources={head.sources.map((x) => ({ name: x.name, ok: x.ok, detail: x.label }))} />}
        {!head && !studio && mode && mode.sources.length > 0 && <SourceStatus sources={mode.sources.map((x) => ({ name: x.name, ok: x.ok, off: x.off, detail: x.off ? (x.error ?? '꺼짐') : x.ok ? (x.ms ? `${x.ms}ms` : '') : (x.error ?? '오류') }))} note={mode.sourceNote} />}
        <span className="ph-end">
          <span className="pill">읽기 전용</span>
          {/* The Trading room has no control anywhere, the header included: its feeds poll on their own (60 s), so the
              only thing left of the button there is a passive "loading" word while the status is being read. */}
          {trading
            ? (loading && <span className="pill tr-loading" role="status">불러오는 중…</span>)
            : <button type="button" className="pill btn" onClick={onRefresh} disabled={loading} aria-label="지금 새로고침"><ReloadIcon /> <span className="pill-label">{loading ? '불러오는 중…' : '새로고침'}</span></button>}
        </span>
      </header>
      {modeKey === 'video' && (
        <nav className="sf-tabs" role="tablist" aria-label="영상 프로젝트" data-testid="hub-video-tabs">
          {VIDEO_PROJECTS.map((p) => {
            const n = p.id === 'factory' ? mode?.shorts?.alerts.filter((a) => a.level !== 'info').length ?? 0 : mode?.alerts.length ?? 0;
            const worst = p.id === 'factory' ? mode?.shorts?.alerts[0]?.level : mode?.alerts[0]?.level;
            return <button key={p.id} type="button" role="tab" className="sf-tab" aria-selected={(p.id === 'factory') === factory} onClick={() => pick(p.id)}>{p.label}{n > 0 && <span className={`sf-tab-n ${worst === 'bad' ? 'bad' : 'warn'}`}>{n}</span>}</button>;
          })}
        </nav>
      )}
      {error && <div className="hub-notice" role="alert">상태를 불러오지 못했어요 · {error}</div>}
      {!mode && !error && <div className="hub-notice muted">상태를 불러오는 중…</div>}
      {factory && mode && (mode.shorts ? <ShortsFactoryHome sf={mode.shorts} now={now} /> : <div className="hub-notice muted" data-testid="sf-absent">서버가 Shorts 공장 데이터를 보내지 않았다 · 서버를 새 빌드로 올리면 보인다.</div>)}
      {studio && <GameStudioHome studio={studio} now={now} />}
      {studio ? (
        <details className="gs-detail" data-testid="gs-detail">
          <summary>상세 기록</summary>
          <div className="gs-detail-in">{ops}</div>
        </details>
      ) : own && ops}
      {mode && (
        <footer className="foot">
          <span>서버 생성 {relTime(generatedAt, now)}</span>
          <span>읽기 전용 · 제어 없음</span>
        </footer>
      )}
    </div>
  );
}
