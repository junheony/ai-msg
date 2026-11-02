import '@fontsource-variable/hahmlet/wght.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RESEARCH_CATEGORIES, type ResearchArticle, type ResearchCategory, type ResearchResponse, type ResearchSource } from '../../../shared/research-types';
import { ExternalIcon, HubIcon, ReloadIcon } from '../HubIcons';
import { liveResearchApi, type ResearchApi } from './api';
import './research.css';

const REFRESH_MS = 5 * 60_000;
const CATEGORY_LABEL: Record<ResearchCategory, string> = { 'Research house': '리서치 하우스', Data: '데이터', 'AI-GPU': 'AI·GPU' };

/** The four narratives with a colour of their own; any other tag stays neutral until it earns one. */
export function tagTone(tag: string): 'rwa' | 'perp' | 'ai' | 'launch' | 'other' {
  const key = tag.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'rwa') return 'rwa';
  if (key === 'perpprop' || key === 'perp' || key === 'prop') return 'perp';
  if (key === 'aicompute') return 'ai';
  if (key === 'launchpad') return 'launch';
  return 'other';
}
const tagLabel = (tag: string): string => tag.replace(/\s*\/\s*/g, '·');
const toneOf = (a: ResearchArticle): string => tagTone(a.tags[0] ?? '');
const dotted = (date: string): string => date.replaceAll('-', '.');
const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');

/** Long lists of project names ("Liquid·Pearl·USD.AI·Lyber/Venice") may break after a separator, never inside a name. */
function Title({ text }: { text: string }) {
  return <>{text.split(/(?<=[·/])/).map((part, i) => <span key={i}>{i > 0 && <wbr />}{part}</span>)}</>;
}

const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;

function Chips({ tags }: { tags: string[] }) {
  return tags.length === 0 ? null : <ul className="rs-chips" aria-label="태그">{tags.map((t) => <li key={t} className="rs-chip" data-tone={tagTone(t)}>{tagLabel(t)}</li>)}</ul>;
}

/** A daily-updated piece has no news date to show: the badge stands in its place, the entry date stays in the tooltip. */
function When({ a }: { a: ResearchArticle }) {
  return a.updatedDaily
    ? <span className="rs-daily" title={`등록 ${dotted(a.date)}`}>매일 갱신</span>
    : <time className="rs-date" dateTime={a.date}>{dotted(a.date)}</time>;
}

function Conclusion({ text, className }: { text: string; className: string }) {
  return text ? <p className={className}>{text}</p> : <p className={`${className} rs-pending`}>요약 대기</p>;
}

/** The cover: flat ink in the lead's narrative colour, so the panel's first read is what the market story is about. */
function Lead({ a }: { a: ResearchArticle }) {
  return (
    <a className="rs-lead" data-tone={toneOf(a)} href={a.url} {...NEW_TAB} data-testid="research-lead">
      <div className="rs-lead-top">
        <Chips tags={a.tags} />
        <When a={a} />
      </div>
      <h3 className="rs-lead-title"><Title text={a.title} /></h3>
      <div className="rs-lead-foot">
        <Conclusion text={a.summary} className="rs-lead-sum" />
        <span className="rs-lead-by">{a.source}</span>
        <span className="rs-lead-go">리포트 열기 <ExternalIcon /></span>
      </div>
    </a>
  );
}

function ArticleCard({ a }: { a: ResearchArticle }) {
  return (
    <a className="rs-card" data-tone={toneOf(a)} href={a.url} {...NEW_TAB} data-testid="research-card">
      <When a={a} />
      <h4 className="rs-card-title"><Title text={a.title} /></h4>
      <Conclusion text={a.summary} className="rs-card-sum" />
      <Chips tags={a.tags} />
    </a>
  );
}

function SourceCard({ s }: { s: ResearchSource }) {
  return (
    <a className="rs-src" href={s.url} {...NEW_TAB} data-testid="research-source" data-owner-pick={s.ownerPick}>
      <span className="rs-src-name">{s.name}{s.nameKo && <span className="rs-src-ko">{s.nameKo}</span>}</span>
      <span className="rs-src-focus">{s.focus}</span>
      <span className="rs-src-host">{hostOf(s.url)} <ExternalIcon /></span>
    </a>
  );
}

function Sources({ sources }: { sources: ResearchSource[] }) {
  const groups = [
    { key: 'pick', label: '오너 픽', items: sources.filter((s) => s.ownerPick) },
    ...RESEARCH_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c], items: sources.filter((s) => !s.ownerPick && s.category === c) })),
  ].filter((g) => g.items.length > 0);
  return (
    <section className="rs-sources" aria-labelledby="rs-sources-h" data-testid="research-sources">
      <h3 id="rs-sources-h" className="rs-h">외부 리서치</h3>
      {groups.map((g) => (
        <div key={g.key} className={`rs-group${g.key === 'pick' ? ' rs-picks' : ''}`} data-testid={`research-group-${g.key}`}>
          <h4 className="rs-group-h">{g.label}</h4>
          <div className="rs-src-grid">{g.items.map((s) => <SourceCard key={s.url} s={s} />)}</div>
        </div>
      ))}
    </section>
  );
}

function Filter({ tags, counts, total, active, onPick }: { tags: string[]; counts: Map<string, number>; total: number; active: string | null; onPick: (t: string | null) => void }) {
  return (
    <div className="rs-filter" role="group" aria-label="태그로 거르기" data-testid="research-filter">
      <button type="button" className="rs-f" aria-pressed={active === null} onClick={() => onPick(null)}>전체<span className="rs-f-n">{total}</span></button>
      {tags.map((t) => <button key={t} type="button" className="rs-f" data-tone={tagTone(t)} aria-pressed={active === t} onClick={() => onPick(t)}>{tagLabel(t)}<span className="rs-f-n">{counts.get(t)}</span></button>)}
    </div>
  );
}

function Articles({ data }: { data: ResearchResponse }) {
  const [active, setActive] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of data.articles) for (const t of a.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  }, [data.articles]);
  // A tag that left the file with the last refresh must not strand the panel on an empty filter.
  const tag = active !== null && counts.has(active) ? active : null;
  const shown = tag === null ? data.articles : data.articles.filter((a) => a.tags.includes(tag));
  const [lead, ...rest] = shown;
  return (
    <>
      {counts.size > 1 && <Filter tags={[...counts.keys()]} counts={counts} total={data.articles.length} active={tag} onPick={setActive} />}
      {lead && <Lead a={lead} />}
      {rest.length > 0 && <div className="rs-grid">{rest.map((a) => <ArticleCard key={a.id} a={a} />)}</div>}
    </>
  );
}

/** Read-only: every article and source is a link out. Empty and broken files say what to do next. */
export function ResearchBody({ api = liveResearchApi }: { api?: ResearchApi }) {
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api.get()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [api]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    if (!error) return <p className="rs-note" role="status">리서치를 불러오는 중…</p>;
    return <div className="rs-empty" role="alert"><p className="rs-empty-h">리서치를 불러오지 못했습니다</p><p>{error}</p><button type="button" className="pill btn" onClick={() => void load()}><ReloadIcon /> 다시 불러오기</button></div>;
  }
  const skipped = data.skipped.articles + data.skipped.sources;
  return (
    <>
      {data.files.articles === 'invalid' && <div className="rs-empty" role="alert" data-testid="research-invalid"><p className="rs-empty-h">글 목록을 읽지 못했습니다</p><p>서버의 ~/.msg/research/articles.json 이 JSON 배열인지 확인하세요.</p></div>}
      {data.files.articles !== 'invalid' && data.articles.length === 0 && <div className="rs-empty" data-testid="research-empty"><p className="rs-empty-h">아직 실린 글이 없습니다</p><p>서버에서 scripts/msg-research-add 로 글을 추가하면 재시작 없이 여기에 보입니다.</p></div>}
      {data.articles.length > 0 && <Articles data={data} />}
      {data.sources.length > 0 && <Sources sources={data.sources} />}
      {data.files.sources === 'invalid' && <p className="rs-note" role="alert" data-testid="research-sources-invalid">외부 리서치 목록을 읽지 못했습니다. 서버의 ~/.msg/research/sources.json 이 JSON 배열인지 확인하세요.</p>}
      {skipped > 0 && <p className="rs-note" data-testid="research-skipped">형식이 맞지 않는 항목 {skipped}건을 뺐습니다. 스키마는 docs/research.md 에 있습니다.</p>}
    </>
  );
}

/** The panel at the bottom of the 개요. */
export function ResearchPanel({ api }: { api?: ResearchApi }) {
  return (
    <section className="rs" aria-labelledby="rs-title" data-testid="research-panel">
      <header className="rs-head">
        <h2 id="rs-title" className="rs-title">리서치</h2>
        <p className="rs-deck">시장 내러티브를 검증한 글과, 다음 국면을 준비할 때 읽을 곳.</p>
      </header>
      <ResearchBody {...(api ? { api } : {})} />
    </section>
  );
}

/** The 리서치 tab: the same reading page under the hub's common header. */
export function ResearchPage({ api }: { api?: ResearchApi }) {
  return (
    <div className="hub-page" data-testid="hub-mode-research" data-mode="research">
      <header className="ph">
        <span className="mode-ico"><HubIcon name="book" size={18} /></span>
        <h1>리서치</h1>
        <span className="ph-end"><span className="pill">읽기 전용</span></span>
      </header>
      <section className="rs rs-page" aria-label="리서치">
        <p className="rs-deck">시장 내러티브를 검증한 글과, 다음 국면을 준비할 때 읽을 곳.</p>
        <ResearchBody {...(api ? { api } : {})} />
      </section>
    </div>
  );
}
