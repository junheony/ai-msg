/**
 * Trading room · 지지·저항 · 분할매수(DCA): the 트레이딩룸 bot's SR snapshot (`/api/hub/sr`, read from :8830 `/api/sr`)
 * as a static chart with the zones over recent 1h candles and a table sorted by distance from the last close, plus the
 * room's own paper flags from :8830 `/api/status` (same hub route, second feed). Every interaction here is a link: the
 * symbol is chosen by `#sr=SYMBOL`, the full list by `#sr-all`. No control of any kind — the panel reads, it never orders.
 * DCA is reported only as the bot reports it: today that is "미보고", with the paper flags that are reported listed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayCandle } from '../../../shared/replay-types';
import { SR_SYMBOL_RE, srPaperVerdict, type SrFeedMeta, type SrRange, type SrRoomStatus, type SrScalar, type SrSnapshot } from '../../../shared/sr-types';
import { readReplayPrefs } from '../replay/history';
import { precisionOf } from '../replay/ReplayChart';
import { fmtKstFull, relTime } from '../time';
import { hashSymbol, useHash } from '../useHash';
import { liveSrApi, type SrApi } from './api';
import { SrChart } from './SrChart';
import { EMPTY_SR_FEED, useSrFeed, type SrFeed } from './useSrFeed';
import './sr.css';

export interface SrPanelProps { api?: SrApi; now?: number; /** The unfiltered read, when the page already holds it (the source strip shares it). */ feed?: SrFeed }

export const SR_DASHBOARD_URL = 'https://cursor.com/canvas/store-86eba8f1-2966-4a4c-aad5-3157d89efc0c/a3b8a78f-65f2-4cac-9987-78bbcd791655';
const SIDE_KO = { support: '지지', resistance: '저항' } as const;
const TF_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d'];
/** Symbol links shown before the `+N` link opens the whole list. */
export const SYMBOLS_SHOWN = 12;

const price = (v: number, p: number): string => v.toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
const pct = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const ageText = (h: number | null): string => (h === null ? '시각 미상' : h < 1 ? `${Math.max(1, Math.round(h * 60))}분 전` : h < 48 ? `${h.toFixed(1)}시간 전` : `${Math.round(h / 24)}일 전`);
const yn = (v: boolean | null): string => (v === null ? '미보고' : v ? '예' : '아니오');
const n = (v: number | null): string => (v === null ? '미보고' : v.toLocaleString('en-US'));
const scalarText = (v: SrScalar): string => (v === null ? '미보고' : typeof v === 'boolean' ? (v ? '예' : '아니오') : typeof v === 'number' ? v.toLocaleString('en-US') : v);

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

/** The symbol the links point at: the hash's if the snapshot knows it, else BTCUSDT, else the first. */
export const pickSymbol = (symbols: readonly string[], wanted: string | null): string | null => (wanted && symbols.includes(wanted) ? wanted : symbols.includes('BTCUSDT') ? 'BTCUSDT' : symbols[0] ?? null);

/** The first few symbols plus the current one, or all of them once `#sr-all` is followed. */
export function visibleSymbols(symbols: readonly string[], current: string | null, all: boolean): { shown: string[]; hidden: number } {
  if (all || symbols.length <= SYMBOLS_SHOWN) return { shown: [...symbols], hidden: 0 };
  const shown = symbols.slice(0, SYMBOLS_SHOWN);
  if (current && !shown.includes(current)) shown.push(current);
  return { shown, hidden: symbols.length - shown.length };
}

/** The PAPER ONLY badge is a verdict on the room's reported flags, never a decoration. */
export function paperBadge(s: Pick<SrSnapshot, 'room'> | null): { text: string; tone: 'ok' | 'warn' | 'bad'; title: string } {
  const v = s ? srPaperVerdict(s) : 'unverified';
  if (v === 'paper') return { text: 'PAPER ONLY', tone: 'ok', title: 'stage=paper · adaptive_paper_only=true · 실주문 플래그 없음' };
  if (v === 'live-risk') return { text: 'PAPER ONLY · 라이브 플래그 감지', tone: 'bad', title: '/api/status 가 라이브 관련 플래그를 보고함 — 확인 필요' };
  return { text: 'PAPER ONLY · 상태 미확인', tone: 'warn', title: '/api/status 미응답 또는 stage·paper 플래그 미보고 — 이 화면은 어차피 읽기 전용' };
}

const FeedLine = ({ meta, what }: { meta: SrFeedMeta; what: string }) => (
  meta.ok ? (meta.stale ? <div className="tr-band warn" role="status"><b>{what} 이전 값 표시 중</b><span className="tr-dim"> · {meta.error ?? '갱신 실패'} · 마지막 정상 {fmtKstFull(meta.lastGoodAt)}</span></div> : null)
    : <div className="tr-down" role="status"><b>{what} 응답 없음</b>{meta.error && <span className="tr-dim"> · {meta.error}</span>}<p>트레이딩룸(:8830)이 {meta.endpoint} 를 내주면 여기에 나타납니다.</p></div>
);

function RoomRows({ room, now }: { room: SrRoomStatus; now: number }) {
  const rows: { k: string; v: string; tone?: 'ok' | 'warn' | 'bad' }[] = [
    { k: '룸 상태 · 단계', v: `${room.state ?? '미보고'} · ${room.stage ?? '미보고'}`, tone: room.stage === 'paper' ? 'ok' : room.stage === null ? undefined : 'bad' },
    { k: 'adaptive 페이퍼 전용', v: yn(room.paper.adaptivePaperOnly), tone: room.paper.adaptivePaperOnly === true ? 'ok' : room.paper.adaptivePaperOnly === false ? 'bad' : undefined },
    { k: 'adaptive 라이브', v: yn(room.paper.adaptiveLive), tone: room.paper.adaptiveLive === false ? 'ok' : room.paper.adaptiveLive === true ? 'bad' : undefined },
    { k: '메이커 페이퍼', v: room.paper.makerPaperEnabled === null && room.paper.makerPaperMode === null ? '미보고' : `${yn(room.paper.makerPaperEnabled)} · ${room.paper.makerPaperMode ?? '모드 미보고'}`, tone: room.paper.makerPaperMode === 'paper' ? 'ok' : room.paper.makerPaperMode === null ? undefined : 'bad' },
    { k: '승격 가능 (maker · graft)', v: `${yn(room.paper.promotionEligible)} · ${yn(room.paper.makerGraftPromotionEligible)}` },
    { k: '메이커 유니버스', v: `${n(room.maker.universeCount)}종목 · 갱신 ${fmtKstFull(room.maker.updatedAt)}` },
    { k: '온체인 알림', v: `${n(room.onchain.alertsCount)}건 · 최근 ${fmtKstFull(room.onchain.lastAlertAt)}${room.onchain.source ? ` · ${room.onchain.source}` : ''}` },
    { k: 'DWF 바스켓 · 감시', v: `${n(room.dwf.basketCount)} · ${n(room.dwf.watchTotal)}종목 · ${fmtKstFull(room.dwf.watchMtime)}` },
    { k: '섀도 하트비트', v: room.shadowHeartbeatAgeS === null ? '미보고' : `${room.shadowHeartbeatAgeS}초 전`, tone: room.shadowHeartbeatAgeS === null ? undefined : room.shadowHeartbeatAgeS > 600 ? 'bad' : 'ok' },
    { k: '박스 스냅샷', v: room.snapshotAgeH === null ? '미보고' : `${ageText(room.snapshotAgeH)} · ${fmtKstFull(room.snapshotGeneratedAt)}`, tone: room.snapshotAgeH === null ? undefined : room.snapshotAgeH > 24 ? 'warn' : 'ok' },
    { k: '운영 문서', v: room.opsDocsCount === null ? '미보고' : `${n(room.opsDocsCount)}건` },
  ];
  return (
    <div className="sr-room" data-testid="sr-room">
      <dl className="hs-rows">{rows.map((r) => <div key={r.k}><dt>{r.k}</dt><dd className={r.tone ?? ''}>{r.v}</dd></div>)}</dl>
      {room.dwf.basketCoins.length > 0 && <p className="tr-rule">바스켓 {room.dwf.basketCoins.join(' · ')}</p>}
      {room.alerts.length > 0 && (
        <ul className="att inner tr-att" aria-label="룸 알림">
          {room.alerts.map((a, i) => <li key={i} className={a.level}><i className={`hub-dot ${a.level}`} /><span className="t">{a.text}</span><span className="at">{a.at ? relTime(a.at, now) : ''}</span></li>)}
        </ul>
      )}
      {room.extra.length > 0 && <dl className="hs-rows sr-extra" aria-label="추가 보고 지표">{room.extra.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{scalarText(v)}</dd></div>)}</dl>}
    </div>
  );
}

/** DCA, honestly: the fills and stages the bot does not export are 미보고; what it does export about paper mode is listed. */
function DcaBand({ s }: { s: SrSnapshot }) {
  const room = s.room;
  const dca = room?.dca;
  const reported: string[] = [];
  if (room?.stage) reported.push(`stage ${room.stage}`);
  if (room?.paper.adaptivePaperOnly !== null && room?.paper.adaptivePaperOnly !== undefined) reported.push(`adaptive_paper_only ${room.paper.adaptivePaperOnly}`);
  if (room?.paper.makerPaperMode) reported.push(`maker ${room.paper.makerPaperMode}`);
  if (room?.srSnapshot) reported.push(`sr_snapshot ${room.srSnapshot.rangeCount ?? '?'}구간 · ${room.srSnapshot.symbolCount ?? '?'}심볼`);
  if (dca?.reported || s.splitBuy.reported) {
    const rows: [string, string][] = [...(dca?.reported ? dca.rows.map(([k, v]) => [k, scalarText(v)] as [string, string]) : []), ...(s.splitBuy.reported ? s.splitBuy.rows : [])];
    return <div className="tr-band" data-testid="sr-dca"><b>분할매수(DCA) 페이퍼</b>{rows.map(([k, v]) => <span key={k}>{k} <b>{v}</b></span>)}</div>;
  }
  return (
    <div className="tr-band warn sr-dca" data-testid="sr-dca">
      <b>분할매수(DCA) 체결 · 단계 미보고</b>
      <span className="tr-dim">{dca ? dca.note : s.splitBuy.note}</span>
      {reported.length > 0 && <span className="sr-dca-rep">보고 중인 항목 · {reported.join(' · ')}</span>}
    </div>
  );
}

export function SrPanel({ api = liveSrApi, now = Date.now(), feed }: SrPanelProps) {
  const own = useSrFeed(api, feed === undefined);
  const { all, error: allError } = feed ?? (own === undefined ? EMPTY_SR_FEED : own);
  const hash = useHash();
  const wanted = hashSymbol(hash);
  const showAll = hash === '#sr-all';
  const symbols = all?.symbols ?? [];
  const symbol = pickSymbol(symbols, wanted);
  const [cur, setCur] = useState<SrSnapshot | null>(null);
  const [curError, setCurError] = useState<string | null>(null);
  const [candles, setCandles] = useState<ReplayCandle[] | null>(null);
  const [candleError, setCandleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const req = useRef(0);
  const candleColors = useMemo(() => readReplayPrefs().candleColors, []);

  // One symbol: its candles, read when the symbol changes; a late answer for an old symbol is dropped.
  useEffect(() => {
    if (!symbol) return;
    const id = ++req.current;
    setCandles(null); setCandleError(null);
    api.klines(symbol).then((c) => { if (req.current === id) setCandles(c); }, (e: unknown) => { if (req.current === id) setCandleError(e instanceof Error ? e.message : String(e)); });
  }, [api, symbol]);

  // The symbol's zones, server-filtered: read when the symbol changes AND again after every successful poll of the
  // unfiltered snapshot (`all` is a new object each time), so the chart and table move with the upstream file instead
  // of keeping the first read while the header clock advances. A symbol change drops the old zones at once; a refresh
  // keeps them until the new ones land, and a failed refresh keeps them and says so (see `curError` below).
  const zoneReq = useRef(0);
  const curSymbol = useRef<string | null>(null);
  useEffect(() => {
    if (!symbol) return;
    const id = ++zoneReq.current;
    const changed = curSymbol.current !== symbol;
    curSymbol.current = symbol;
    setBusy(true);
    if (changed) { setCur(null); setCurError(null); }
    api.sr(symbol).then(
      (s) => { if (zoneReq.current === id) { setCur(s); setCurError(null); setBusy(false); } },
      (e: unknown) => { if (zoneReq.current === id) { setCurError(e instanceof Error ? e.message : String(e)); setBusy(false); } },
    );
  }, [api, symbol, all]);

  const last = candles && candles.length > 0 ? candles[candles.length - 1]! : null;
  const rows = useMemo(() => sortRows(cur?.ranges ?? NO_RANGES, last?.c ?? null), [cur, last]);
  const p = precisionOf(last?.c ?? rows[0]?.r.mid ?? 0);
  const support = rows.filter((x) => x.r.side === 'support').length;
  const resistance = rows.length - support;
  const meta = all ?? cur;
  const room = meta?.room ?? null;
  const badge = paperBadge(meta);
  const { shown, hidden } = visibleSymbols(symbols, symbol, showAll);
  const unknownWanted = wanted && all && !symbols.includes(wanted) && SR_SYMBOL_RE.test(wanted);

  return (
    <section id="hub-sr" className="sec open-static tr-sec sr" data-testid="sr-panel" aria-label="SR / DCA · 지지·저항 · 분할매수(DCA)">
      <div className="sh sr-head">
        <span className="sec-title"><span className="tr-src-name">SR / DCA</span> 지지·저항 · 분할매수(DCA)</span>
        <span className={`hs-badge sr-paper ${badge.tone}`} title={badge.title} data-testid="sr-paper">{badge.text}</span>
        <span className="n sr-src">출처 트레이딩룸 :8830 · /api/sr + /api/status · 읽기 전용</span>
        <span className="tr-right sr-clock" data-testid="sr-clock">
          <span>스냅샷 <b>{fmtKstFull(meta?.snapshotAt ?? room?.srSnapshot?.mtime ?? null)}</b>{meta?.ageHours !== null && meta?.ageHours !== undefined ? <span className="tr-dim"> · {ageText(meta.ageHours)}</span> : null}</span>
          <span>룸 상태 <b>{fmtKstFull(room?.generatedAt ?? null)}</b></span>
        </span>
      </div>
      <div className="b">
        {allError && !all && <div className="tr-down" role="status"><b>SR 스냅샷 응답 없음</b><span className="tr-dim"> · {allError}</span><p>트레이딩룸(:8830)이 /api/sr 를 내주면 여기에 구간이 나타납니다.</p></div>}
        {allError && all && <div className="tr-band warn" role="status" data-testid="sr-client-stale"><b>SR 스냅샷 갱신 실패 · 이전 값 표시 중</b><span className="tr-dim"> · {allError} · 마지막 정상 {fmtKstFull(all.feeds.sr.fetchedAt ?? all.generatedAt)} · 60초 뒤 다시 읽습니다</span></div>}
        {all && <FeedLine meta={all.feeds.sr} what="SR 스냅샷" />}
        {all && <FeedLine meta={all.feeds.status} what="룸 상태(/api/status)" />}
        {!all && !allError && <p className="sec-empty" role="status">SR 스냅샷 불러오는 중…</p>}
        {all && symbols.length === 0 && all.feeds.sr.ok && <p className="sec-empty">스냅샷에 심볼이 없어요.</p>}
        {symbols.length > 0 && (
          <nav className="sr-syms" aria-label="심볼">
            <span className="sr-syms-k">심볼 {symbols.length}</span>
            {shown.map((s) => <a key={s} href={`#sr=${s}`} className={`sr-sym-link${s === symbol ? ' on' : ''}`} aria-current={s === symbol ? 'true' : undefined}>{s}</a>)}
            {hidden > 0 && <a href="#sr-all" className="sr-sym-link more">+{hidden} 전체</a>}
            {showAll && symbols.length > SYMBOLS_SHOWN && <a href={`#sr=${symbol ?? ''}`} className="sr-sym-link more">접기</a>}
          </nav>
        )}
        {unknownWanted && <p className="tr-err" role="status">{wanted}: 스냅샷에 없는 심볼 · {symbol} 표시 중</p>}
        {symbol && (
          <div className="sr-grid">
            <div className="sr-chart-wrap">
              <div className="sr-cap">
                <b className="sr-sym">{symbol}</b>
                <span>선물 1h · {last ? <>마지막 <b className="sr-num">{price(last.c, p)}</b> · {relTime(new Date(last.t).toISOString(), now)}</> : candleError ? <span className="tr-dim">캔들 없음 · {candleError}</span> : candles ? <span className="tr-dim">캔들 없음</span> : '캔들 불러오는 중…'}</span>
                <span className="sr-cnt"><i className="sr-sw support" />지지 {support}<i className="sr-sw resistance" />저항 {resistance}</span>
              </div>
              {candles && candles.length > 0 && <SrChart candles={candles} ranges={cur?.ranges ?? NO_RANGES} candleColors={candleColors} />}
              {candles && candles.length === 0 && <div className="sr-chart-wait" role="status">이 심볼의 선물 캔들이 없어요 · 표만 보여요</div>}
              {!candles && candleError && <div className="sr-chart-wait" role="status">캔들을 받지 못했어요 · 표는 등급순</div>}
              <p className="sr-static tr-rule">정지 화면 · 확대·이동 없음 · 가격 축 자동</p>
            </div>
            <div className="sr-side">
              {curError && !cur && <div className="tr-down" role="status"><b>{symbol} 구간 응답 없음</b><span className="tr-dim"> · {curError}</span></div>}
              {curError && cur && <div className="tr-band warn" role="status" data-testid="sr-zones-stale"><b>{symbol} 구간 갱신 실패 · 이전 값 표시 중</b><span className="tr-dim"> · {curError}</span></div>}
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
            <div className="sr-two">
              <div className="sr-col">
                <h4 className="sr-h4">룸 상태 <span className="tr-dim">/api/status</span></h4>
                {room ? <RoomRows room={room} now={now} /> : <p className="sec-empty">룸 상태 미보고 · /api/status 응답 없음</p>}
              </div>
              <div className="sr-col">
                <h4 className="sr-h4">분할매수(DCA) <span className="tr-dim">보고된 것만</span></h4>
                <DcaBand s={meta} />
                {room?.srSnapshot && <dl className="hs-rows sr-snapmeta" aria-label="SR 스냅샷 메타">
                  <div><dt>스냅샷 파일</dt><dd>{room.srSnapshot.source ?? '미보고'}</dd></div>
                  <div><dt>파일 시각 (mtime)</dt><dd>{fmtKstFull(room.srSnapshot.mtime)}</dd></div>
                  <div><dt>구간 · 심볼</dt><dd>{n(room.srSnapshot.rangeCount)} · {n(room.srSnapshot.symbolCount)}</dd></div>
                </dl>}
                <p className="tr-rule">정책 {meta.policy || '—'} · 등급 {meta.method.tiers || '—'} · 파일 {meta.source || '—'}{meta.generatedAt ? ` · 응답 생성 ${fmtKstFull(meta.generatedAt)}` : ''} · 읽기 전용</p>
                <a className="hub-open ext" href={SR_DASHBOARD_URL} target="_blank" rel="noopener noreferrer" data-testid="sr-dashboard">SR 대시보드 · 새 탭 ↗</a>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
