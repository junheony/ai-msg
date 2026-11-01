/**
 * Candles with the bot's support/resistance zones laid over them as translucent bands. lightweight-charts draws the
 * candles (loaded on first use, like the replay chart); the bands are plain DOM placed with `priceToCoordinate`, so they
 * follow every scroll, zoom and resize, and carry a label the canvas could not. Read-only: nothing here sends anything.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReplayCandle } from '../../../shared/replay-types';
import type { SrRange } from '../../../shared/sr-types';
import { chartText, readChartTheme } from '../replay/chartTheme';
import type { CandleColors } from '../replay/history';
import { precisionOf, useThemeTick } from '../replay/ReplayChart';

type LWC = typeof import('lightweight-charts');
type Time = import('lightweight-charts').UTCTimestamp;

export interface SrChartProps { candles: readonly ReplayCandle[]; ranges: readonly SrRange[]; candleColors: CandleColors; height?: number }

const KST = 'Asia/Seoul';
const fmtTick = new Intl.DateTimeFormat('en-GB', { timeZone: KST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const SIDE_KO = { support: '지지', resistance: '저항' } as const;

export function SrChart({ candles, ranges, candleColors, height = 360 }: SrChartProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const bands = useRef<HTMLDivElement | null>(null);
  const [lwc, setLwc] = useState<LWC | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const themeTick = useThemeTick();

  useEffect(() => {
    let alive = true;
    import('lightweight-charts').then((m) => { if (alive) setLwc(m); }, () => { if (alive) setLoadError('차트 모듈을 불러오지 못했어요 · 새로고침'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const host = el.current; const layer = bands.current;
    if (!lwc || !host || !layer || candles.length === 0) return;
    const theme = readChartTheme(host, candleColors);
    const { createChart, CandlestickSeries, ColorType, CrosshairMode } = lwc;
    const last = candles[candles.length - 1]!.c;
    const precision = precisionOf(last);
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: theme.bg }, textColor: theme.muted, ...chartText(theme), attributionLogo: false },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      rightPriceScale: { borderColor: theme.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 6, minBarSpacing: 2, tickMarkFormatter: (t: Time) => fmtTick.format(new Date((t as number) * 1000)) },
      localization: { timeFormatter: (t: Time) => fmtFull.format(new Date((t as number) * 1000)), locale: 'ko-KR' },
      crosshair: { mode: CrosshairMode.Normal },
      // The bands are placed from the price scale: keep that scale automatic so a scroll is the only thing that moves them.
      handleScale: { axisPressedMouseMove: { time: true, price: false }, mouseWheel: true, pinch: true },
      // A vertical swipe on a phone scrolls the page, not the chart.
      handleScroll: { vertTouchDrag: false },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: theme.up, downColor: theme.down, borderVisible: false, wickUpColor: theme.up, wickDownColor: theme.down,
      priceLineVisible: true, lastValueVisible: true, priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) },
    });
    candle.setData(candles.map((c) => ({ time: Math.floor(c.t / 1000) as Time, open: c.o, high: c.h, low: c.l, close: c.c })));
    chart.timeScale().fitContent();

    // One band per zone; positions are refreshed whenever the scale can have moved.
    const nodes = ranges.map((r) => {
      const d = document.createElement('div');
      d.className = `sr-band ${r.side} t${r.tier}`;
      d.dataset.id = r.id;
      d.title = `${SIDE_KO[r.side]} · 등급 ${r.tier} · ${r.low}–${r.high}`;
      const s = document.createElement('span');
      s.textContent = `${SIDE_KO[r.side]} ${r.tier}`;
      d.append(s);
      layer.append(d);
      return { r, d };
    });
    let alive = true;
    const place = () => {
      if (!alive) return;
      const w = Math.max(0, host.clientWidth - chart.priceScale('right').width());
      layer.style.width = `${w}px`;
      for (const { r, d } of nodes) {
        const top = candle.priceToCoordinate(r.high); const bottom = candle.priceToCoordinate(r.low);
        if (top === null || bottom === null) { d.style.display = 'none'; continue; }
        d.style.display = '';
        d.style.top = `${Math.min(top, bottom)}px`;
        d.style.height = `${Math.max(3, Math.abs(bottom - top))}px`;
      }
    };
    place();
    const raf = requestAnimationFrame(place);
    chart.timeScale().subscribeVisibleLogicalRangeChange(place);
    let roRaf = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(roRaf); roRaf = requestAnimationFrame(place); }) : null;
    ro?.observe(host);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(roRaf);
      ro?.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(place);
      for (const { d } of nodes) d.remove();
      chart.remove();
    };
  }, [lwc, candles, ranges, candleColors, themeTick]);

  return (
    <div className="sr-chart" style={{ height }} data-testid="sr-chart">
      <div ref={el} className="sr-canvas" />
      <div ref={bands} className="sr-bands" aria-hidden="true" />
      {!lwc && <div className="sr-chart-wait" role="status">{loadError ?? '차트 준비 중…'}</div>}
    </div>
  );
}
