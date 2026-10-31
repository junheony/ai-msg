/**
 * The replay chart: lightweight-charts (loaded on first use, so the hub chunk stays small) with candles, volume, and the
 * toggled indicators — overlays on the price pane, oscillators in panes below. Only `candles[0..visibleEnd]` ever reach
 * the chart, so the future cannot be scrolled into. Hidden-price mode shows the price axis in percent and ATR as a
 * percent of price; hidden-date mode drops the time axis. Colours come from the shell's tokens at mount.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReplayCandle, ReplayFundingPoint, ReplayOiPoint } from '../../../shared/replay-types';
import { chartText, isDarkTheme, readChartTheme, withAlpha, type ChartTheme } from './chartTheme';
import type { CandleColors, IndicatorId } from './history';
import { atr, bollinger, cvd, ema, macd, rsi, sma, type Series } from './indicators';
import type { Direction } from './scoring';

type LWC = typeof import('lightweight-charts');
type Time = import('lightweight-charts').UTCTimestamp;
type ISeries = import('lightweight-charts').ISeriesApi<'Line' | 'Histogram' | 'Candlestick'>;

export interface ChartMarker { index: number; kind: 'entry' | 'exit'; dir: Exclude<Direction, 'skip'>; text?: string }

export interface ReplayChartProps {
  candles: readonly ReplayCandle[];
  /** Index of the last candle the player may see (inclusive). */
  visibleEnd: number;
  indicators: readonly IndicatorId[];
  hidePrice: boolean;
  hideDate: boolean;
  candleColors: CandleColors;
  markers: readonly ChartMarker[];
  oi?: readonly ReplayOiPoint[] | null;
  funding?: readonly ReplayFundingPoint[] | null;
  /** Called with the hovered candle index (null off-chart). */
  onHover?: (index: number | null) => void;
  /** Rows under the chart title (symbol, O/H/L/C…) are the caller's; the chart only reports hovers. */
  caption?: React.ReactNode;
}

const PANE_IDS: IndicatorId[] = ['rsi', 'macd', 'atr', 'cvd', 'oi', 'funding'];
const PANE_LABEL: Record<string, string> = { rsi: 'RSI 14', macd: 'MACD 12·26·9', atr: 'ATR 14', cvd: 'CVD', oi: '미결제약정', funding: '펀딩비' };
const MAIN_HEIGHT = 380;
const PANE_HEIGHT = 96;

const sec = (ms: number): Time => Math.floor(ms / 1000) as Time;
const KST = 'Asia/Seoul';
const fmtTick = new Intl.DateTimeFormat('en-GB', { timeZone: KST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Indicator values for every candle, computed once per scene (the future is computed too but sliced before the chart sees it). */
export interface IndicatorValues {
  ema20: Series; ema50: Series; sma200: Series; bb: { mid: Series; upper: Series; lower: Series };
  rsi: Series; macd: { macd: Series; signal: Series; hist: Series }; atr: Series; atrPct: Series; cvd: Series;
}
export function computeIndicators(cs: readonly ReplayCandle[]): IndicatorValues {
  const a = atr(cs, 14);
  return { ema20: ema(cs, 20), ema50: ema(cs, 50), sma200: sma(cs, 200), bb: bollinger(cs, 20, 2), rsi: rsi(cs, 14), macd: macd(cs), atr: a, atrPct: a.map((v, i) => (v === null ? null : (v / cs[i]!.c) * 100)), cvd: cvd(cs) };
}

const lineData = (cs: readonly ReplayCandle[], s: Series, end: number) => {
  const out: { time: Time; value: number }[] = [];
  for (let i = 0; i <= end; i++) { const v = s[i]; if (v !== null && v !== undefined) out.push({ time: sec(cs[i]!.t), value: v }); }
  return out;
};

/** Re-reads the theme when the shell's theme stamp or the OS scheme changes. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
    const onMq = () => setTick((t) => t + 1);
    mq?.addEventListener('change', onMq);
    return () => { mo.disconnect(); mq?.removeEventListener('change', onMq); };
  }, []);
  return tick;
}

export function ReplayChart({ candles, visibleEnd, indicators, hidePrice, hideDate, candleColors, markers, oi, funding, onHover, caption }: ReplayChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const [lwc, setLwc] = useState<LWC | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const themeTick = useThemeTick();
  const values = useMemo(() => computeIndicators(candles), [candles]);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    let alive = true;
    import('lightweight-charts').then((m) => { if (alive) setLwc(m); }, () => { if (alive) setLoadError('차트 모듈을 불러오지 못했어요 · 새로고침'); });
    return () => { alive = false; };
  }, []);

  const panes = PANE_IDS.filter((p) => indicators.includes(p));
  const height = MAIN_HEIGHT + panes.length * PANE_HEIGHT;
  const indKey = indicators.join(',');

  // One chart per scene/setting combination; stepping forward only appends (the effect below).
  const built = useRef<{ chart: import('lightweight-charts').IChartApi; candle: ISeries; series: Map<string, ISeries>; markers: import('lightweight-charts').ISeriesMarkersPluginApi<import('lightweight-charts').Time>; end: number; theme: ChartTheme } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!lwc || !el || candles.length === 0) return;
    const theme = readChartTheme(el, candleColors);
    const { createChart, CandlestickSeries, LineSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle, PriceScaleMode, createSeriesMarkers } = lwc;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.muted, ...chartText(theme), attributionLogo: false, panes: { separatorColor: theme.border, separatorHoverColor: withAlpha(theme.accent, 0.25), enableResize: false } },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border, scaleMargins: { top: 0.08, bottom: indicators.includes('volume') ? 0.24 : 0.08 } },
      timeScale: { visible: !hideDate, borderColor: theme.border, timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7, minBarSpacing: 2, tickMarkFormatter: (t: Time) => fmtTick.format(new Date((t as number) * 1000)) },
      localization: { timeFormatter: (t: Time) => fmtFull.format(new Date((t as number) * 1000)), locale: 'ko-KR' },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: theme.faint, labelVisible: !hideDate, labelBackgroundColor: theme.accent }, horzLine: { color: theme.faint, labelBackgroundColor: theme.accent } },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      kineticScroll: { mouse: false, touch: true },
    });
    const end = Math.min(visibleEnd, candles.length - 1);
    const series = new Map<string, ISeries>();
    const candle = chart.addSeries(CandlestickSeries, { upColor: theme.up, downColor: theme.down, borderVisible: false, wickUpColor: theme.up, wickDownColor: theme.down, priceLineVisible: !hidePrice, lastValueVisible: !hidePrice, priceFormat: { type: 'price', precision: precisionOf(candles[end]!.c), minMove: Math.pow(10, -precisionOf(candles[end]!.c)) } }, 0);
    candle.setData(candles.slice(0, end + 1).map((c) => ({ time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    series.set('candle', candle);

    const line = (id: string, color: string, pane: number, opts: Partial<import('lightweight-charts').LineSeriesPartialOptions> = {}) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: pane > 0 && !hidePrice, crosshairMarkerVisible: false, ...opts }, pane);
      series.set(id, s);
      return s;
    };
    const overlay = (id: IndicatorId, data: Series, color: string, opts: Partial<import('lightweight-charts').LineSeriesPartialOptions> = {}) => {
      if (indicators.includes(id)) line(id, color, 0, { lastValueVisible: false, ...opts }).setData(lineData(candles, data, end));
    };
    overlay('ema20', values.ema20, theme.series[0]!);
    overlay('ema50', values.ema50, theme.series[1]!);
    overlay('sma200', values.sma200, theme.series[2]!);
    if (indicators.includes('bb')) {
      line('bb.upper', withAlpha(theme.series[6]!, 0.9), 0, { lineWidth: 1 }).setData(lineData(candles, values.bb.upper, end));
      line('bb.mid', withAlpha(theme.series[6]!, 0.7), 0, { lineWidth: 1, lineStyle: LineStyle.Dashed }).setData(lineData(candles, values.bb.mid, end));
      line('bb.lower', withAlpha(theme.series[6]!, 0.9), 0, { lineWidth: 1 }).setData(lineData(candles, values.bb.lower, end));
    }
    if (indicators.includes('volume')) {
      const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false }, 0);
      chart.priceScale('vol', 0).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      vol.setData(candles.slice(0, end + 1).map((c) => ({ time: sec(c.t), value: c.v, color: withAlpha(c.c >= c.o ? theme.up : theme.down, 0.38) })));
      series.set('volume', vol);
    }
    let pane = 1;
    const paneOf = new Map<IndicatorId, number>();
    for (const id of panes) paneOf.set(id, pane++);
    if (paneOf.has('rsi')) {
      const s = line('rsi', theme.series[0]!, paneOf.get('rsi')!, { lastValueVisible: true, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
      s.setData(lineData(candles, values.rsi, end));
      for (const lvl of [30, 70]) s.createPriceLine({ price: lvl, color: theme.faint, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' });
      chart.priceScale('right', paneOf.get('rsi')!).applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    }
    if (paneOf.has('macd')) {
      const p = paneOf.get('macd')!;
      const h = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: hidePrice ? 4 : precisionOf(candles[end]!.c), minMove: 0.0001 } }, p);
      h.setData(lineData(candles, values.macd.hist, end).map((d) => ({ ...d, color: withAlpha(d.value >= 0 ? theme.up : theme.down, 0.6) })));
      series.set('macd.hist', h);
      line('macd', theme.series[0]!, p, { lastValueVisible: false }).setData(lineData(candles, values.macd.macd, end));
      line('macd.signal', theme.series[1]!, p, { lastValueVisible: false }).setData(lineData(candles, values.macd.signal, end));
    }
    if (paneOf.has('atr')) line('atr', theme.series[3]!, paneOf.get('atr')!, { priceFormat: hidePrice ? { type: 'percent', precision: 2, minMove: 0.01 } : undefined }).setData(lineData(candles, hidePrice ? values.atrPct : values.atr, end));
    if (paneOf.has('cvd')) line('cvd', theme.series[2]!, paneOf.get('cvd')!, { priceFormat: { type: 'volume' } }).setData(lineData(candles, values.cvd, end));
    if (paneOf.has('oi')) line('oi', theme.series[4]!, paneOf.get('oi')!, { priceFormat: { type: 'volume' } }).setData(oiData(oi, candles[end]!.t));
    if (paneOf.has('funding')) {
      const f = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', minMove: 0.0001, formatter: (v: number) => `${v.toFixed(4)}%` } }, paneOf.get('funding')!);
      f.setData(fundingData(funding, candles[end]!.t, theme));
      series.set('funding', f);
    }
    const all = chart.panes();
    all[0]?.setStretchFactor(MAIN_HEIGHT);
    // Percent mode (the hidden-price axis) belongs to the price pane only; the indicator panes keep their own units.
    chart.priceScale('right', 0).applyOptions({ mode: hidePrice ? PriceScaleMode.Percentage : PriceScaleMode.Normal });
    for (let i = 1; i < all.length; i++) {
      all[i]!.setStretchFactor(PANE_HEIGHT);
      chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });
    }

    const plugin = createSeriesMarkers(candle, markerData(markers, candles, end, theme));
    chart.timeScale().scrollToRealTime();
    chart.subscribeCrosshairMove((p) => {
      if (!onHoverRef.current) return;
      const t = p.time as number | undefined;
      if (t === undefined || !p.point) { onHoverRef.current(null); return; }
      // visible candles are evenly spaced; the exact one is found by its time
      const i = indexOfTime(candles, t * 1000, built.current?.end ?? end);
      onHoverRef.current(i);
    });
    built.current = { chart, candle, series, markers: plugin, end, theme };
    return () => { built.current = null; chart.remove(); };
    // `visibleEnd` and `markers` are applied by the effects below; a change in everything else rebuilds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lwc, candles, indKey, hidePrice, hideDate, candleColors, themeTick, oi, funding, values]);

  // Stepping forward: append the newly revealed candles (and their indicator points) to every series.
  useEffect(() => {
    const b = built.current;
    if (!b) return;
    const end = Math.min(visibleEnd, candles.length - 1);
    if (end <= b.end) return;
    for (let i = b.end + 1; i <= end; i++) {
      const c = candles[i]!;
      const t = sec(c.t);
      b.candle.update({ time: t, open: c.o, high: c.h, low: c.l, close: c.c });
      const put = (id: string, v: number | null | undefined, color?: string) => { const s = b.series.get(id); if (s && v !== null && v !== undefined) s.update(color ? { time: t, value: v, color } : { time: t, value: v }); };
      put('ema20', values.ema20[i]); put('ema50', values.ema50[i]); put('sma200', values.sma200[i]);
      put('bb.upper', values.bb.upper[i]); put('bb.mid', values.bb.mid[i]); put('bb.lower', values.bb.lower[i]);
      put('volume', c.v, withAlpha(c.c >= c.o ? b.theme.up : b.theme.down, 0.38));
      put('rsi', values.rsi[i]);
      const h = values.macd.hist[i];
      put('macd.hist', h, h === null || h === undefined ? undefined : withAlpha(h >= 0 ? b.theme.up : b.theme.down, 0.6));
      put('macd', values.macd.macd[i]); put('macd.signal', values.macd.signal[i]);
      put('atr', hidePrice ? values.atrPct[i] : values.atr[i]);
      put('cvd', values.cvd[i]);
    }
    const oiS = b.series.get('oi'); if (oiS) oiS.setData(oiData(oi, candles[end]!.t));
    const fS = b.series.get('funding'); if (fS) fS.setData(fundingData(funding, candles[end]!.t, b.theme));
    b.end = end;
    b.chart.timeScale().scrollToRealTime();
  }, [visibleEnd, candles, values, hidePrice, oi, funding]);

  useEffect(() => {
    const b = built.current;
    if (b) b.markers.setMarkers(markerData(markers, candles, b.end, b.theme));
  }, [markers, candles, visibleEnd]);

  const style: CSSProperties = { height };
  return (
    <div className={`rp-chart${isDarkTheme() ? ' dark' : ''}`} data-testid="replay-chart" data-visible-end={Math.min(visibleEnd, candles.length - 1)} data-panes={panes.length}>
      <div ref={host} className="rp-canvas" style={style} aria-label="리플레이 차트" role="img" />
      {panes.length > 0 && (
        <div className="rp-pane-labels" style={{ top: MAIN_HEIGHT }} aria-hidden>
          {panes.map((p) => <span key={p} style={{ height: PANE_HEIGHT }}>{PANE_LABEL[p]}{p === 'atr' && hidePrice ? ' · % of price' : ''}</span>)}
        </div>
      )}
      {caption && <div className="rp-caption">{caption}</div>}
      {!lwc && !loadError && <div className="rp-chart-wait">차트 준비 중…</div>}
      {loadError && <div className="rp-chart-wait bad">{loadError}</div>}
    </div>
  );
}

/** Decimal places that make sense for this price level (BTC 1, ETH 2, small caps up to 6). */
export function precisionOf(price: number): number {
  if (!(price > 0)) return 2;
  if (price >= 1000) return 1;
  if (price >= 10) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 6;
}

function indexOfTime(cs: readonly ReplayCandle[], tMs: number, end: number): number | null {
  let lo = 0; let hi = end;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const t = cs[mid]!.t; if (t === tMs) return mid; if (t < tMs) lo = mid + 1; else hi = mid - 1; }
  return null;
}
function oiData(oi: readonly ReplayOiPoint[] | null | undefined, maxT: number) {
  const out: { time: Time; value: number }[] = [];
  let last = -1;
  for (const p of oi ?? []) { if (p.t > maxT) break; const t = sec(p.t); if (t <= last) continue; last = t; out.push({ time: t, value: p.oi }); }
  return out;
}
function fundingData(f: readonly ReplayFundingPoint[] | null | undefined, maxT: number, theme: ChartTheme) {
  const out: { time: Time; value: number; color: string }[] = [];
  let last = -1;
  for (const p of f ?? []) { if (p.t > maxT) break; const t = sec(p.t); if (t <= last) continue; last = t; out.push({ time: t, value: p.rate * 100, color: withAlpha(p.rate >= 0 ? theme.series[5]! : theme.series[7]!, 0.85) }); }
  return out;
}
function markerData(ms: readonly ChartMarker[], cs: readonly ReplayCandle[], end: number, theme: ChartTheme) {
  return ms.filter((m) => m.index <= end).map((m) => ({
    time: sec(cs[m.index]!.t),
    position: (m.kind === 'entry' ? (m.dir === 'long' ? 'belowBar' : 'aboveBar') : 'inBar') as 'belowBar' | 'aboveBar' | 'inBar',
    shape: (m.kind === 'entry' ? (m.dir === 'long' ? 'arrowUp' : 'arrowDown') : 'circle') as 'arrowUp' | 'arrowDown' | 'circle',
    color: m.kind === 'entry' ? (m.dir === 'long' ? theme.up : theme.down) : theme.accent,
    text: m.text,
    size: m.kind === 'entry' ? 1.4 : 0.9,
  })).sort((a, b) => (a.time as number) - (b.time as number));
}

export { fmtDay, fmtFull };
