/**
 * Trading room · 지지·저항 구간: the 트레이딩룸 bot's SR snapshot (`/api/hub/sr`) as a chart with the zones laid over
 * recent 1h candles and a table sorted by distance from the last close. One picker chooses the symbol; nothing else
 * here is a control — the panel reads, it never orders. Split-buy paper status is shown only if the bot reports it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayCandle } from '../../../shared/replay-types';
import type { SrRange, SrSnapshot } from '../../../shared/sr-types';
import { readReplayPrefs } from '../replay/history';
import { precisionOf } from '../replay/ReplayChart';
import { relTime } from '../time';
import { liveSrApi, type SrApi } from './api';
import { SrChart } from './SrChart';
import './sr.css';

export interface SrPanelProps { api?: SrApi; now?: number; initialSymbol?: string }

const SIDE_KO = { support: '지지', resistance: '저항' } as const;
const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d'];

const price = (v: number, p: number): string => v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
const pct = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const ageText = (h: number | null): string => (h === null ? '시각 미상' : h < 1 ? `${Math.max(1, Math.round(h * 60))}분 전` : h < 48 ? `${h.toFixed(1)}시간 전` : `${Math.round(h / 24)}일 전`);

export interface SrRow { r: SrRange; /** (mid − last) / last × 100; null without a price. */ dist: number | null; hits: string[] }

/** Zones nearest the last close first; without a price, strongest first then by price. */
export function sortRows(ranges: readonly SrRange[], last: number | null): SrRow[] {
  const rows = ranges.map((r) => ({
    r, dist: last !== null && last > 0 ? ((r.mid - last) / last) * 100 : null,
    hits: Object.entries(r.tfHits).filter(([k, v]) => v >= 0.5 && TF_ORDER.includes(k)).map(([k]) => k).sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b)),
  }));
  rows.sort((a, b) => (a.dist !== null && b.dist !== null ? Math.abs(a.dist) - Math.abs(b.dist) : b.r.tier - a.r.tier || b.r.mid - a.r.mid));
  return rows;
}

/** A stable empty list, so the chart's rebuild effect does not see a new `ranges` on every render while zones are missing. */
const NO_RANGES: SrRange[] = [];

const pickSymbol = (symbols: string[], wanted?: string): string | null => (wanted && symbols.includes(wanted) ? wanted : symbols.includes('BTCUSDT') ? 'BTCUSDT' : symbols[0] ?? null);

export function SrPanel({ api = liveSrApi, now = Date.now(), initialSymbol }: SrPanelProps) {
  const [all, setAll] = useState<SrSnapshot | null>(null);
  const [allError, setAllError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [cur, setCur] = useState<SrSnapshot | null>(null);
  const [curError, setCurError] = useState<string | null>(null);
  const [candles, setCandles] = useState<ReplayCandle[] | null>(null);
  const [candleError, setCandleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);
  const candleColors = useMemo(() => readReplayPrefs().candleColors, []);

  // The unfiltered snapshot once: the symbol list and the file's age; then the first symbol.
  useEffect(() => {
    let alive = true;
    api.sr(null).then((s) => { if (!alive) return; setAll(s); setAllError(null); setSymbol(pickSymbol(s.symbols, initialSymbol)); }, (e: unknown) => { if (alive) setAllError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [api, initialSymbol]);

  // One symbol: its zones (server-filtered) and candles, side by side; a late answer for an old symbol is dropped.
  useEffect(() => {
    if (!symbol) return;
    const id = ++req.current;
    setBusy(true); setCandles(null); setCandleError(null); setCur(null); setCurError(null);
    const zones = api.sr(symbol).then((s) => { if (req.current === id) { setCur(s); setCurError(null); } }, (e: unknown) => { if (req.current === id) { setCur(null); setCurError(e instanceof Error ? e.message : String(e)); } });
    const ks = api.klines(symbol).then((c) => { if (req.current === id) setCandles(c); }, (e: unknown) => { if (req.current === id) setCandleError(e instanceof Error ? e.message : String(e)); });
    void Promise.allSettled([zones, ks]).then(() => { if (req.current === id) setBusy(false); });
  }, [api, symbol]);

  const last = candles && candles.length > 0 ? candles[candles.length - 1]! : null;
  const rows = useMemo(() => sortRows(cur?.ranges ?? NO_RANGES, last?.c ?? null), [cur, last]);
  const p = precisionOf(last?.c ?? rows[0]?.r.mid ?? 0);
  const support = rows.filter((x) => x.r.side === 'support').length;
  const resistance = rows.length - support;
  const meta = cur ?? all;

  return (
    <section className="sec open-static tr-sec sr" data-testid="sr-panel" aria-label="지지·저항 구간">
      <div className="sh">
        <span className="sec-title">지지·저항 구간</span>
        {meta && <span className="n tr-note">스냅샷 {ageText(meta.ageHours)} · {meta.symbols.length}심볼 · 자동 MTF 구간</span>}
        <span className="tr-right sr-pick">
          <label htmlFor="sr-symbol">심볼</label>
          <select id="sr-symbol" className="rp-input" value={symbol ?? ''} disabled={!all || all.symbols.length === 0} onChange={(e) => setSymbol(e.target.value)}>
            {!all && <option value="">불러오는 중…</option>}
            {all?.symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </span>
      </div>
      <div className="b">
        {allError && <div className="tr-down" role="status"><b>SR 스냅샷 응답 없음</b><span className="tr-dim"> · {allError}</span><p>트레이딩룸(:8830)이 /api/sr 를 내주면 여기에 구간이 나타납니다.</p></div>}
        {all && all.symbols.length === 0 && !allError && <p className="sec-empty">스냅샷에 심볼이 없어요.</p>}
        {symbol && (
          <div className="sr-grid">
            <div className="sr-chart-wrap">
              <div className="sr-cap">
                <b className="sr-sym">{symbol}</b>
                <span>선물 1h · {last ? <>마지막 <b className="sr-num">{price(last.c, p)}</b> · {relTime(new Date(last.t).toISOString(), now)}</> : candleError ? <span className="tr-dim">캔들 없음 · {candleError}</span> : '캔들 불러오는 중…'}</span>
                <span className="sr-cnt"><i className="sr-sw support" />지지 {support}<i className="sr-sw resistance" />저항 {resistance}</span>
              </div>
              {candles && candles.length > 0 && <SrChart candles={candles} ranges={cur?.ranges ?? NO_RANGES} candleColors={candleColors} />}
              {candles && candles.length === 0 && <div className="sr-chart-wait" role="status">이 심볼의 선물 캔들이 없어요 · 표만 보여요</div>}
              {!candles && candleError && <div className="sr-chart-wait" role="status">캔들을 받지 못했어요 · 표는 등급순</div>}
            </div>
            <div className="sr-side">
              {curError && <div className="tr-down" role="status"><b>{symbol} 구간 응답 없음</b><span className="tr-dim"> · {curError}</span></div>}
              {cur && rows.length === 0 && !busy && <p className="sec-empty">{symbol}: 스냅샷에 구간이 없어요.</p>}
              {rows.length > 0 && (
                <div className="twrap sr-twrap">
                  <table className="t sr-t" data-testid="sr-table">
                    <thead><tr><th>방향</th><th className="n">구간</th><th className="n">거리</th><th>등급</th><th>TF</th></tr></thead>
                    <tbody>
                      {rows.map(({ r, dist, hits }) => (
                        <tr key={r.id} className={r.side} title={r.notes.join(' · ') || undefined} data-dist={dist === null ? '' : dist.toFixed(4)}>
                          <td className={`sr-sd ${r.side}`}><i className={`sr-sw ${r.side}`} />{SIDE_KO[r.side]}</td>
                          <td className="n">{price(r.low, p)}<span className="tr-dim"> – </span>{price(r.high, p)}</td>
                          <td className={`n sr-dist ${dist === null ? '' : dist > 0 ? 'above' : 'below'}`}>{pct(dist)}</td>
                          <td><span className={`sr-tier t${r.tier}`} aria-label={`등급 ${r.tier}`} title={r.score === null ? undefined : `점수 ${r.score.toFixed(2)}`}>{'●'.repeat(r.tier)}{'○'.repeat(5 - r.tier)}</span></td>
                          <td className="sr-tf">{hits.length ? hits.join(' ') : <span className="tr-dim">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
        {meta && (
          <div className="sr-foot">
            <span className="tr-band" data-testid="sr-splitbuy"><b>분할매수 페이퍼</b>{meta.splitBuy.reported ? meta.splitBuy.rows.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>) : <>미보고<span className="tr-dim"> · {meta.splitBuy.note}</span></>}</span>
            <p className="tr-rule">정책 {meta.policy || '—'} · 등급 {meta.method.tiers || '—'} · 파일 {meta.source || '—'}{meta.generatedAt ? ` · 생성 ${relTime(meta.generatedAt, now)}` : ''} · 읽기 전용</p>
          </div>
        )}
      </div>
    </section>
  );
}
