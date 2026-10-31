import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HubCardItem, HubChartSeries, HubImage, HubSection, HubStep } from '../../shared/hub-types';
import { ExternalIcon } from './HubIcons';
import { STATE_LABEL, stateClass } from './modes';
import './hub-sections.css';

/* ───────── helpers ───────── */

/** A compact number for an axis tick: 1.2억 / 35만 are the collector's job; here 1.2M / 35K / 0.8 / −12. */
export function tick(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${s}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${s}${trim(a / 1e3)}K`;
  if (a >= 100) return `${s}${Math.round(a)}`;
  return `${s}${trim(a)}`;
}
const trim = (n: number): string => (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/\.?0+$/, ''));

/** The value at a point, for the legend and the hover readout. */
function val(v: number | null | undefined, unit?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const t = Math.abs(v) >= 1000 ? tick(v) : (Number.isInteger(v) ? String(v) : v.toFixed(2)).replace('-', '−');
  return unit ? `${t}${unit}` : t;
}

/** Nice axis bounds: at most four ticks, the zero line inside when asked. */
export function axis(min: number, max: number, zero: boolean, ymin?: number): { lo: number; hi: number; ticks: number[] } {
  let lo = ymin !== undefined ? ymin : min;
  let hi = max;
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi === lo) { hi = lo + (Math.abs(lo) || 1); }
  const span = hi - lo;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.001 && ticks.length < 8; t += step) if (t >= lo - step * 0.001) ticks.push(+t.toFixed(10));
  if (ymin === undefined) lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  return { lo, hi, ticks };
}

/** The container's width, live (ResizeObserver when the browser has one; the fallback is the width jsdom reports: 0 → 640). */
function useWidth<T extends HTMLElement>(fallback = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const x = el.getBoundingClientRect().width; if (x > 0) setW(x); };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const COLOR: Record<NonNullable<HubChartSeries['color']>, string> = { accent: 'var(--accent)', ok: 'var(--hub-ok)', warn: 'var(--hub-warn)', bad: 'var(--hub-bad)', muted: 'var(--faint)' };
const PALETTE: NonNullable<HubChartSeries['color']>[] = ['accent', 'ok', 'warn', 'bad', 'muted'];
const colorOf = (s: HubChartSeries, i: number): string => COLOR[s.color ?? PALETTE[i % PALETTE.length]!];

/* ───────── sparkline (cards) ───────── */

export function Spark({ values, unit, label }: { values: (number | null)[]; unit?: string; label?: string }) {
  const W = 160; const H = 36;
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div className="hs-spark empty">{label ?? ''} 자료 없음</div>;
  const lo = Math.min(...pts.map((p) => p[1])); const hi = Math.max(...pts.map((p) => p[1]));
  const sx = (i: number) => (i / Math.max(1, values.length - 1)) * (W - 2) + 1;
  const sy = (v: number) => (hi === lo ? H / 2 : H - 3 - ((v - lo) / (hi - lo)) * (H - 6));
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  const first = pts[0]![1]; const last = pts[pts.length - 1]![1];
  const up = last >= first;
  return (
    <div className="hs-spark" title={`${label ?? ''} ${val(first, unit)} → ${val(last, unit)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"><path d={d} fill="none" stroke={up ? 'var(--hub-ok)' : 'var(--hub-bad)'} strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></svg>
      <span className="hs-spark-l">{label && <span className="k">{label}</span>}<b className={up ? 'ok' : 'bad'}>{val(last, unit)}</b></span>
    </div>
  );
}

/* ───────── cards ───────── */

export function Cards({ s }: { s: Extract<HubSection, { kind: 'cards' }> }) {
  if (s.items.length === 0) return <div className="sec-empty">항목 없음</div>;
  return (
    <div className={`hs-cards cols${s.cols ?? (s.items.length >= 3 ? 3 : 2)}`}>
      {s.items.map((c, i) => <Card key={i} c={c} />)}
    </div>
  );
}

function Card({ c }: { c: HubCardItem }) {
  return (
    <article className={`hs-card ${c.state ? stateClass(c.state) : ''}`} aria-label={c.title}>
      <div className="hs-card-top">
        <h4>{c.title}</h4>
        {c.badge && <span className="hs-badge">{c.badge}</span>}
        {c.state && <span className={`hub-st ${stateClass(c.state)}`}><i />{STATE_LABEL[c.state]}</span>}
      </div>
      {c.sub && <p className="hs-card-sub">{c.sub}</p>}
      {c.rows.length > 0 && (
        <dl className="hs-rows">
          {c.rows.map((r, i) => <div key={i}><dt>{r.label}</dt><dd className={r.status ?? ''}>{r.value}</dd></div>)}
        </dl>
      )}
      {c.spark && <Spark values={c.spark.values} {...(c.spark.unit ? { unit: c.spark.unit } : {})} {...(c.spark.label ? { label: c.spark.label } : {})} />}
      {c.note && <p className="hs-card-note">{c.note}</p>}
      {c.links && c.links.length > 0 && (
        <div className="hs-card-links">
          {c.links.map((l) => <a key={l.href} className="hub-open" href={l.href} target="_blank" rel="noopener noreferrer">{l.label} <ExternalIcon /></a>)}
        </div>
      )}
    </article>
  );
}

/* ───────── chart (pure SVG) ───────── */

const PAD = { l: 44, r: 12, t: 10, b: 24 };

export function Chart({ s }: { s: Extract<HubSection, { kind: 'chart' }> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = s.x.length;
  const series = s.series.filter((x) => x.values.length > 0);
  const all = series.flatMap((x) => x.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (n === 0 || all.length === 0) return <div className="sec-empty">자료 없음</div>;
  const H = 220;
  const W = Math.max(240, width);
  const pw = W - PAD.l - PAD.r; const ph = H - PAD.t - PAD.b;
  const ax = axis(Math.min(...all), Math.max(...all), !!s.zero, s.ymin);
  const X = (i: number) => PAD.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const Y = (v: number) => PAD.t + ph - ((v - ax.lo) / (ax.hi - ax.lo)) * ph;
  const bars = series.filter((x) => x.style === 'bar');
  const slot = pw / Math.max(1, n);
  const bw = Math.max(2, Math.min(28, (slot * 0.7) / Math.max(1, bars.length)));
  // x labels: at most ~6, always the last.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 90))));
  const labelIdx = s.x.map((_, i) => i).filter((i) => i === n - 1 || (i % every === 0 && n - 1 - i >= every / 2));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / pw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hv = hover === null ? n - 1 : hover;
  return (
    <div className="hs-chart" ref={ref} data-testid="hub-chart">
      <div className="hs-legend">
        {series.map((x, i) => <span key={x.name} className="hs-leg"><i style={{ background: colorOf(x, i) }} className={x.style === 'bar' ? 'sq' : ''} />{x.name} <b>{val(x.values[hv], s.unit)}</b></span>)}
        <span className="hs-leg at">{s.x[hv]}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s.title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ax.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? 'hs-zero' : 'hs-grid'} />
            <text x={PAD.l - 6} y={Y(t) + 3.5} className="hs-tick" textAnchor="end">{tick(t)}</text>
          </g>
        ))}
        {labelIdx.map((i) => <text key={i} x={X(i)} y={H - 6} className="hs-tick x" textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}>{s.x[i]}</text>)}
        {bars.map((x, k) => {
          const c = colorOf(x, series.indexOf(x));
          const base = Y(Math.max(ax.lo, Math.min(ax.hi, 0)));
          return x.values.map((v, i) => {
            if (v === null || !Number.isFinite(v)) return null;
            const y = Y(v);
            const x0 = X(i) - (bars.length * bw) / 2 + k * bw;
            return <rect key={`${k}-${i}`} x={x0} y={Math.min(y, base)} width={bw} height={Math.max(1, Math.abs(base - y))} fill={c} opacity={hover === null || hover === i ? 0.85 : 0.45} rx={1} />;
          });
        })}
        {series.filter((x) => x.style !== 'bar').map((x, k) => {
          const c = colorOf(x, series.indexOf(x));
          const segs: string[] = [];
          let pen = false;
          x.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v)) { pen = false; return; }
            segs.push(`${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
            pen = true;
          });
          const hvv = x.values[hv];
          return (
            <g key={k}>
              <path d={segs.join(' ')} fill="none" stroke={c} strokeWidth={1.8} strokeLinejoin="round" />
              {hvv !== null && hvv !== undefined && Number.isFinite(hvv) && <circle cx={X(hv)} cy={Y(hvv)} r={3.2} fill={c} stroke="var(--bg-raised)" strokeWidth={1.5} />}
            </g>
          );
        })}
        {hover !== null && <line x1={X(hv)} x2={X(hv)} y1={PAD.t} y2={PAD.t + ph} className="hs-cursor" />}
      </svg>
    </div>
  );
}

/* ───────── steps (pipeline) ───────── */

const STEP_KO: Record<HubStep['state'], string> = { done: '완료', active: '진행 중', todo: '대기', blocked: '차단' };

export function Steps({ s }: { s: Extract<HubSection, { kind: 'steps' }> }) {
  if (s.items.length === 0) return <div className="sec-empty">단계 없음</div>;
  return (
    <ol className="hs-steps" aria-label={s.title}>
      {s.items.map((st, i) => (
        <li key={i} className={st.state} aria-label={`${st.label} · ${STEP_KO[st.state]}`}>
          <span className="hs-step-dot"><i>{st.state === 'done' ? '✓' : st.state === 'blocked' ? '!' : i + 1}</i></span>
          <span className="hs-step-l">{st.label}</span>
          <span className="hs-step-s">{STEP_KO[st.state]}</span>
          {st.hint && <span className="hs-step-h">{st.hint}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ───────── images (thumbnails, videos, playable builds) ───────── */

const VIDEO_RE = /\.(mp4|webm|mov)(\?|$)/i;

export function Images({ s }: { s: Extract<HubSection, { kind: 'images' }> }) {
  if (s.items.length === 0) return <div className="sec-empty">이미지 없음</div>;
  return (
    <div className="hs-images">
      {s.items.map((im, i) => <Thumb key={i} im={im} />)}
    </div>
  );
}

function Thumb({ im }: { im: HubImage }) {
  const kind = im.kind ?? (VIDEO_RE.test(im.src) ? 'video' : 'image');
  const href = im.href ?? im.src;
  let body: ReactNode;
  if (kind === 'video') body = <video className="hs-media" src={im.src} preload="metadata" controls muted playsInline />;
  else if (kind === 'html') body = <a className="hs-media hs-play" href={href} target="_blank" rel="noopener noreferrer"><span>▶ 새 탭에서 열기</span></a>;
  else body = <a href={href} target="_blank" rel="noopener noreferrer"><img className="hs-media" src={im.src} alt={im.label} loading="lazy" decoding="async" /></a>;
  return (
    <figure className={`hs-thumb ${kind}`}>
      {body}
      <figcaption><span>{im.label}</span><a className="hub-open ext" href={href} target="_blank" rel="noopener noreferrer">열기 <ExternalIcon /></a></figcaption>
    </figure>
  );
}

/* ───────── kvgrid (label · meaning · aligned number) ───────── */

export function KvGrid({ s }: { s: Extract<HubSection, { kind: 'kvgrid' }> }) {
  if (s.rows.length === 0) return <div className="sec-empty">자료 없음</div>;
  return (
    <div className="hs-kvgrid" role="table" aria-label={s.title}>
      {s.rows.map((r, i) => (
        <div key={i} className={`hs-kvrow ${r.status ?? ''}`} role="row">
          <span className="hs-kv-l" role="cell">{r.label}</span>
          <span className="hs-kv-d" role="cell">{r.desc ?? ''}</span>
          <span className="hs-kv-v" role="cell">{r.value}</span>
          <span className="hs-kv-s" role="cell">{r.sub ?? ''}</span>
        </div>
      ))}
    </div>
  );
}
