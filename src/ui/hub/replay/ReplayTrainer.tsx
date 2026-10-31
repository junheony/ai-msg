/**
 * 차트 리플레이: a practice room inside the Trading mode. A past window of public exchange candles opens with the future
 * hidden; the player calls long, short or skip, the next candles are revealed and the round is scored in percent. No
 * order of any kind leaves this component — there is nothing to connect it to. Settings and finished sessions stay in
 * this browser's localStorage (`history.ts`); market data comes through MSG's own `/api/replay/*` proxy (`api.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REPLAY_INTERVALS, type ReplayCandle, type ReplayFundingPoint, type ReplayInterval, type ReplayMarket, type ReplayOiPoint, type ReplaySource } from '../../../shared/replay-types';
import { FALLBACK_SYMBOLS, liveReplayApi, type ReplayApi } from './api';
import { appendSession, clearHistory, historyStats, INDICATOR_IDS, readHistory, readReplayPrefs, writeReplayPrefs, type CandleColors, type IndicatorId, type ReplayPrefs, type ReplaySession } from './history';
import { fmtFull, precisionOf, ReplayChart, type ChartMarker } from './ReplayChart';
import { HORIZONS, planAt, randomPlayStart, ROUND_COUNTS, snapToInterval, startIndexFor, TAIL } from './scene';
import { buyAndHoldPct, fmtPct, pnlPct, summarize, type Direction, type ReplayRound } from './scoring';
import './replay.css';

const IND_LABEL: Record<IndicatorId, string> = { ema20: 'EMA 20', ema50: 'EMA 50', sma200: 'SMA 200', bb: '볼린저 20·2', volume: '거래량', rsi: 'RSI 14', macd: 'MACD', atr: 'ATR 14', cvd: 'CVD', oi: '미결제약정', funding: '펀딩비' };
const FUTURES_ONLY: IndicatorId[] = ['oi', 'funding'];
/** Binance's open-interest history window, with a day of slack. */
const OI_HISTORY_MS = 29 * 86_400_000;
const OI_PERIOD: Record<ReplayInterval, string> = { '1m': '5m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };

interface Scene {
  candles: ReplayCandle[];
  source: ReplaySource;
  market: ReplayMarket;
  symbol: string;
  interval: ReplayInterval;
  horizon: number;
  rounds: number;
  hidePrice: boolean;
  hideDate: boolean;
  startIndex: number;
  /** The last index a round may end at (the tail after it is for the reveal). */
  lastExit: number;
}
type Phase = 'idle' | 'loading' | 'playing' | 'done';

const fmtPrice = (p: number): string => p.toLocaleString('en-US', { minimumFractionDigits: precisionOf(p), maximumFractionDigits: precisionOf(p) });
const fmtWhen = (ms: number): string => fmtFull.format(new Date(ms));
const pct1 = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);
const toneOf = (v: number | null | undefined): string => (v === null || v === undefined ? '' : v > 0 ? ' pos' : v < 0 ? ' neg' : '');
const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface ReplayTrainerProps {
  api?: ReplayApi;
  random?: () => number;
  now?: () => number;
}

export function ReplayTrainer({ api = liveReplayApi, random = Math.random, now = Date.now }: ReplayTrainerProps) {
  const [prefs, setPrefsState] = useState<ReplayPrefs>(() => readReplayPrefs());
  const setPrefs = useCallback((patch: Partial<ReplayPrefs>) => setPrefsState((p) => { const n = { ...p, ...patch }; writeReplayPrefs(n); return n; }), []);
  const [symbols, setSymbols] = useState<string[]>(FALLBACK_SYMBOLS);
  const [manualStart, setManualStart] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [visibleEnd, setVisibleEnd] = useState(0);
  const [rounds, setRounds] = useState<ReplayRound[]>([]);
  const [oi, setOi] = useState<ReplayOiPoint[] | null>(null);
  const [funding, setFunding] = useState<ReplayFundingPoint[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [history, setHistory] = useState<ReplaySession[]>(() => readHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [saved, setSaved] = useState<ReplaySession | null>(null);
  const runId = useRef(0);

  // The symbol list for the market (the field accepts any symbol either way).
  useEffect(() => {
    let alive = true;
    api.symbols(prefs.market).then((list) => { if (alive && list.length) setSymbols(list); }, () => { /* the fallback list stays */ });
    return () => { alive = false; };
  }, [api, prefs.market]);

  const start = useCallback(async () => {
    const id = ++runId.current;
    const { market, symbol, interval, horizon, rounds: planned, hidePrice, hideDate } = prefs;
    const sym = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(sym)) { setError('심볼을 확인해 주세요 (예: BTCUSDT)'); return; }
    setError(null); setPhase('loading'); setRounds([]); setSaved(null); setOi(null); setFunding(null); setHover(null);
    try {
      let playStart: number | null;
      if (manualStart) {
        const t = Date.parse(manualStart);
        if (!Number.isFinite(t)) throw new Error('시작 날짜를 읽을 수 없어요');
        playStart = snapToInterval(t, interval);
      } else {
        const earliest = await api.earliest(market, sym, interval);
        if (earliest === null) throw new Error('이 심볼의 캔들을 찾지 못했어요');
        playStart = randomPlayStart(earliest, now(), interval, horizon, planned, random);
        if (playStart === null) throw new Error('이 심볼은 상장 기간이 짧아 장면을 만들 수 없어요 · 봉 수나 라운드를 줄여 보세요');
      }
      const plan = planAt(playStart, interval, horizon, planned);
      const k = await api.klines({ market, symbol: sym, interval, endTime: plan.endTime, limit: plan.limit });
      if (id !== runId.current) return;
      const startIndex = startIndexFor(k.candles.length, horizon, planned);
      if (startIndex === null) throw new Error(`캔들이 ${k.candles.length}개뿐이라 장면이 안 나와요 · 더 이른 날짜를 피하거나 라운드를 줄여 보세요`);
      const sc: Scene = { candles: k.candles, source: k.source, market, symbol: sym, interval, horizon, rounds: planned, hidePrice, hideDate, startIndex, lastExit: k.candles.length - 1 - TAIL };
      setScene(sc); setVisibleEnd(startIndex); setPhase('playing');
      if (market === 'futures' && prefs.indicators.some((i) => FUTURES_ONLY.includes(i))) {
        const from = k.candles[0]!.t; const to = k.candles[k.candles.length - 1]!.t;
        // Binance keeps open-interest history for 30 days and answers 400 to anything older: ask only for the part it has.
        const oiFrom = Math.max(from, now() - OI_HISTORY_MS);
        if (prefs.indicators.includes('oi') && to > oiFrom) api.oi(sym, OI_PERIOD[interval], oiFrom, to).then((r) => { if (id === runId.current) setOi(r.points); }, () => { /* OI only covers the last 30 days; the pane stays empty */ });
        if (prefs.indicators.includes('funding')) api.funding(sym, from, to).then((r) => { if (id === runId.current) setFunding(r.points); }, () => { /* the pane stays empty */ });
      }
    } catch (err) {
      if (id !== runId.current) return;
      setPhase('idle'); setScene(null);
      setError(err instanceof Error ? err.message : '장면을 불러오지 못했어요');
    }
  }, [api, prefs, manualStart, now, random]);

  const finish = useCallback((sc: Scene, done: ReplayRound[]) => {
    setPhase('done');
    setVisibleEnd(sc.candles.length - 1);
    const summary = summarize(done);
    const first = done[0]; const last = done[done.length - 1];
    const session: ReplaySession = {
      id: newId(), at: new Date(now()).toISOString(), market: sc.market, symbol: sc.symbol, interval: sc.interval, source: sc.source, horizon: sc.horizon, roundsPlanned: sc.rounds,
      hidePrice: sc.hidePrice, hideDate: sc.hideDate, playStartT: sc.candles[sc.startIndex]!.t, endT: sc.candles[sc.candles.length - 1]!.t, rounds: done, summary,
      buyHoldPct: first && last ? buyAndHoldPct(first.entry, last.exit) : null,
    };
    if (done.length > 0) { setHistory(appendSession(session)); setSaved(session); }
  }, [now]);

  const call = useCallback((dir: Direction) => {
    if (phase !== 'playing' || !scene) return;
    const entryIndex = visibleEnd;
    const exitIndex = Math.min(entryIndex + scene.horizon, scene.lastExit);
    if (exitIndex <= entryIndex) { finish(scene, rounds); return; }
    const entry = scene.candles[entryIndex]!; const exit = scene.candles[exitIndex]!;
    const r: ReplayRound = { n: rounds.length + 1, dir, entryIndex, exitIndex, entryT: entry.t, exitT: exit.t, entry: entry.c, exit: exit.c, pnlPct: pnlPct(dir, entry.c, exit.c) };
    const next = [...rounds, r];
    setRounds(next);
    setVisibleEnd(exitIndex);
    if (next.length >= scene.rounds || exitIndex >= scene.lastExit) finish(scene, next);
  }, [phase, scene, visibleEnd, rounds, finish]);

  const endEarly = useCallback(() => { if (scene && phase === 'playing') finish(scene, rounds); }, [scene, phase, rounds, finish]);
  const reset = useCallback(() => { runId.current++; setPhase('idle'); setScene(null); setRounds([]); setSaved(null); setError(null); }, []);

  // L · S · N while a scene is playing (not while typing in a field).
  useEffect(() => {
    if (phase !== 'playing') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'l') { e.preventDefault(); call('long'); } else if (k === 's') { e.preventDefault(); call('short'); } else if (k === 'n') { e.preventDefault(); call('skip'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, call]);

  const summary = useMemo(() => summarize(rounds), [rounds]);
  const markers = useMemo<ChartMarker[]>(() => rounds.flatMap((r): ChartMarker[] => (r.dir === 'skip' ? [] : [
    { index: r.entryIndex, kind: 'entry', dir: r.dir, text: r.dir === 'long' ? 'L' : 'S' },
    { index: r.exitIndex, kind: 'exit', dir: r.dir, text: fmtPct(r.pnlPct, 1) },
  ])), [rounds]);
  const revealed = phase === 'done';
  const hidePriceNow = !!scene?.hidePrice && !revealed;
  const hideDateNow = !!scene?.hideDate && !revealed;
  const playing = phase === 'playing';
  const busy = phase === 'loading';
  const hist = useMemo(() => historyStats(history), [history]);
  const indicatorsFor = (m: ReplayMarket) => (m === 'futures' ? INDICATOR_IDS : INDICATOR_IDS.filter((i) => !FUTURES_ONLY.includes(i)));

  const toggleInd = (id: IndicatorId) => setPrefs({ indicators: prefs.indicators.includes(id) ? prefs.indicators.filter((x) => x !== id) : [...prefs.indicators, id] });

  // The caption on the chart: hovered (or last visible) candle, in the terms the hide switches allow.
  const capIdx = hover !== null && scene && hover <= visibleEnd ? hover : scene ? visibleEnd : null;
  const cap = scene && capIdx !== null ? scene.candles[capIdx]! : null;
  const capPrev = scene && capIdx !== null && capIdx > 0 ? scene.candles[capIdx - 1]! : null;
  const caption = scene && cap ? (
    <>
      <b>{scene.symbol}</b><span className="rp-dim">{scene.market === 'futures' ? '선물' : '현물'} · {scene.interval}{scene.source === 'bybit' ? ' · Bybit' : ''}</span>
      {hideDateNow ? <span className="rp-dim">{capIdx! - scene.startIndex >= 0 ? `+${capIdx! - scene.startIndex}` : capIdx! - scene.startIndex}봉</span> : <span className="rp-dim">{fmtWhen(cap.t)}</span>}
      {hidePriceNow
        ? <span className={`rp-mono${toneOf(capPrev ? cap.c - capPrev.c : 0)}`}>{capPrev ? fmtPct(((cap.c - capPrev.c) / capPrev.c) * 100) : '—'} <span className="rp-dim">전봉 대비</span></span>
        : <span className="rp-mono">O {fmtPrice(cap.o)} H {fmtPrice(cap.h)} L {fmtPrice(cap.l)} C <span className={toneOf(cap.c - cap.o)}>{fmtPrice(cap.c)}</span></span>}
    </>
  ) : null;

  return (
    <section className="rp" data-testid="replay-trainer" aria-label="차트 리플레이">
      <header className="rp-head">
        <div className="rp-title">
          <h2>차트 리플레이</h2>
          <p>과거 차트를 한 구간씩 열어 보며 방향을 맞혀 보는 연습장. 공개 캔들만 쓰고, 어디에도 주문을 보내지 않아요.</p>
        </div>
        <div className="rp-head-end">
          <span className="pill">모의 예측 · 실제 주문 없음</span>
          <button type="button" className={`pill btn${showHistory ? ' on' : ''}`} onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>연습 기록 {history.length}</button>
        </div>
      </header>

      <div className="rp-setup" data-testid="replay-setup">
        <div className="rp-field">
          <span className="rp-label">시장</span>
          <div className="rp-seg" role="radiogroup" aria-label="시장">
            {(['spot', 'futures'] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={prefs.market === m} className={prefs.market === m ? 'on' : ''} disabled={playing || busy} onClick={() => setPrefs({ market: m, indicators: prefs.indicators.filter((i) => indicatorsFor(m).includes(i)) })}>{m === 'spot' ? '현물' : '선물'}</button>)}
          </div>
        </div>
        <label className="rp-field">
          <span className="rp-label">심볼</span>
          <input className="rp-input rp-mono" list="rp-symbols" value={prefs.symbol} disabled={playing || busy} spellCheck={false} autoCapitalize="characters" onChange={(e) => setPrefs({ symbol: e.target.value.toUpperCase() })} aria-label="심볼" />
          <datalist id="rp-symbols">{symbols.map((s) => <option key={s} value={s} />)}</datalist>
        </label>
        <div className="rp-field">
          <span className="rp-label">봉</span>
          <div className="rp-seg" role="radiogroup" aria-label="봉 간격">
            {REPLAY_INTERVALS.map((i) => <button key={i} type="button" role="radio" aria-checked={prefs.interval === i} className={prefs.interval === i ? 'on' : ''} disabled={playing || busy} onClick={() => setPrefs({ interval: i })}>{i}</button>)}
          </div>
        </div>
        <label className="rp-field">
          <span className="rp-label">한 번에 여는 봉</span>
          <select className="rp-input" value={prefs.horizon} disabled={playing || busy} onChange={(e) => setPrefs({ horizon: Number(e.target.value) })} aria-label="한 번에 여는 봉">{HORIZONS.map((h) => <option key={h} value={h}>{h}봉</option>)}</select>
        </label>
        <label className="rp-field">
          <span className="rp-label">라운드</span>
          <select className="rp-input" value={prefs.rounds} disabled={playing || busy} onChange={(e) => setPrefs({ rounds: Number(e.target.value) })} aria-label="라운드 수">{ROUND_COUNTS.map((r) => <option key={r} value={r}>{r}회</option>)}</select>
        </label>
        <label className="rp-field">
          <span className="rp-label">시작 시점</span>
          <input className="rp-input" type="datetime-local" value={manualStart} disabled={playing || busy} onChange={(e) => setManualStart(e.target.value)} aria-label="시작 시점 (비우면 무작위)" />
          <span className="rp-hint">{manualStart ? <button type="button" className="rp-link" onClick={() => setManualStart('')}>무작위로</button> : '비우면 무작위'}</span>
        </label>
        <div className="rp-field rp-switches">
          <span className="rp-label">숨김</span>
          <label className="rp-check"><input type="checkbox" checked={prefs.hidePrice} disabled={playing || busy} onChange={(e) => setPrefs({ hidePrice: e.target.checked })} /> 가격</label>
          <label className="rp-check"><input type="checkbox" checked={prefs.hideDate} disabled={playing || busy} onChange={(e) => setPrefs({ hideDate: e.target.checked })} /> 날짜</label>
        </div>
        <div className="rp-field">
          <span className="rp-label">캔들 색</span>
          <div className="rp-seg" role="radiogroup" aria-label="캔들 색">
            {([['intl', '초록↑'], ['kr', '빨강↑']] as [CandleColors, string][]).map(([c, l]) => <button key={c} type="button" role="radio" aria-checked={prefs.candleColors === c} className={prefs.candleColors === c ? 'on' : ''} onClick={() => setPrefs({ candleColors: c })}>{l}</button>)}
          </div>
        </div>
        <div className="rp-field rp-go">
          {phase === 'playing'
            ? <button type="button" className="rp-btn ghost" onClick={endEarly}>여기서 끝내기</button>
            : <button type="button" className="rp-btn primary" onClick={() => void start()} disabled={busy} data-testid="replay-start">{busy ? '장면 여는 중…' : phase === 'done' ? '새 장면' : '장면 열기'}</button>}
        </div>
      </div>

      <div className="rp-ind" role="group" aria-label="지표">
        <span className="rp-label">지표</span>
        {indicatorsFor(prefs.market).map((id) => (
          <button key={id} type="button" className={`rp-chip${prefs.indicators.includes(id) ? ' on' : ''}`} aria-pressed={prefs.indicators.includes(id)} onClick={() => toggleInd(id)} data-testid={`ind-${id}`}>{IND_LABEL[id]}</button>
        ))}
        {prefs.market === 'futures' && <span className="rp-hint">미결제약정은 최근 30일 장면에서만 채워져요</span>}
      </div>

      {error && <div className="hub-notice" role="alert">{error}</div>}

      <div className={`rp-stage${scene ? '' : ' empty'}`}>
        <div className="rp-chart-wrap">
          {scene
            ? <ReplayChart candles={scene.candles} visibleEnd={visibleEnd} indicators={prefs.indicators} hidePrice={hidePriceNow} hideDate={hideDateNow} candleColors={prefs.candleColors} markers={markers} oi={oi} funding={funding} onHover={setHover} caption={caption} />
            : (
              <div className="rp-empty" data-testid="replay-empty">
                <div className="rp-empty-art" aria-hidden>
                  {[38, 52, 46, 60, 58, 72, 66, 80, 74, 70, 84, 90].map((h, i) => <i key={i} style={{ height: `${h}%`, animationDelay: `${i * 60}ms` }} className={i % 3 === 2 ? 'dn' : ''} />)}
                  <em />
                </div>
                <p className="rp-empty-h">{busy ? '장면을 여는 중…' : '장면을 열면 과거의 어느 순간이 미래를 가린 채 펼쳐져요.'}</p>
                <p className="rp-empty-d">롱 · 숏 · 건너뛰기 중 하나를 고르면 다음 {prefs.horizon}봉이 열리고 결과가 %로 기록돼요. 키보드 L · S · N.</p>
              </div>
            )}
        </div>
        <aside className="rp-side" aria-label="라운드 기록">
          <div className="rp-side-h">
            <span>라운드</span>
            {scene && <span className="rp-dim">{rounds.length}/{scene.rounds} · {scene.horizon}봉씩</span>}
          </div>
          <ol className="rp-rounds" data-testid="replay-rounds">
            {rounds.map((r) => (
              <li key={r.n} className={r.dir}>
                <span className="n">{r.n}</span>
                <span className={`d ${r.dir}`}>{r.dir === 'long' ? '롱' : r.dir === 'short' ? '숏' : '건너뜀'}</span>
                <span className={`p rp-mono${toneOf(r.pnlPct)}`}>{fmtPct(r.pnlPct)}</span>
              </li>
            ))}
            {rounds.length === 0 && <li className="none">{scene ? '첫 판단을 기다리는 중' : '—'}</li>}
          </ol>
          <dl className="rp-score" data-testid="replay-score">
            <div><dt>누적</dt><dd className={`rp-mono${toneOf(summary.totalPct)}`}>{fmtPct(summary.totalPct)}</dd></div>
            <div><dt>적중</dt><dd className="rp-mono">{summary.trades ? `${summary.wins}/${summary.trades}` : '—'} <span className="rp-dim">{pct1(summary.hitRate)}</span></dd></div>
            <div><dt>평균</dt><dd className={`rp-mono${toneOf(summary.avgPct)}`}>{fmtPct(summary.avgPct)}</dd></div>
            <div><dt>최대 낙폭</dt><dd className="rp-mono">{summary.trades ? fmtPct(-summary.maxDrawdownPct) : '—'}</dd></div>
          </dl>
        </aside>
      </div>

      <div className={`rp-deck${playing ? '' : ' off'}`} data-testid="replay-deck">
        <div className="rp-deck-status">
          {playing && scene ? <><b>라운드 {rounds.length + 1}</b><span className="rp-dim"> / {scene.rounds} · 다음 {Math.min(scene.horizon, scene.lastExit - visibleEnd)}봉의 방향은?</span></>
            : phase === 'done' ? <><b>끝</b><span className="rp-dim"> · 결과를 확인하고 새 장면을 여세요</span></>
            : <span className="rp-dim">장면을 열면 여기서 판단해요</span>}
        </div>
        <div className="rp-deck-btns">
          <button type="button" className="rp-call long" disabled={!playing} onClick={() => call('long')} data-testid="call-long"><span className="k">L</span>롱<small>오를 것 같다</small></button>
          <button type="button" className="rp-call short" disabled={!playing} onClick={() => call('short')} data-testid="call-short"><span className="k">S</span>숏<small>내릴 것 같다</small></button>
          <button type="button" className="rp-call skip" disabled={!playing} onClick={() => call('skip')} data-testid="call-skip"><span className="k">N</span>건너뛰기<small>판단 보류</small></button>
        </div>
      </div>

      {phase === 'done' && scene && (
        <div className="rp-result" data-testid="replay-result" role="status">
          <div className="rp-result-h">
            <span className={`rp-result-score rp-mono${toneOf(summary.totalPct)}`}>{fmtPct(summary.totalPct)}</span>
            <div className="rp-result-t">
              <b>{scene.symbol} · {scene.market === 'futures' ? '선물' : '현물'} · {scene.interval}</b>
              <span className="rp-dim">{fmtWhen(scene.candles[scene.startIndex]!.t)} → {fmtWhen(scene.candles[Math.min(scene.lastExit, scene.candles.length - 1)]!.t)} · 시작가 {fmtPrice(scene.candles[scene.startIndex]!.c)}</span>
            </div>
            <div className="rp-result-actions">
              <button type="button" className="rp-btn primary" onClick={() => void start()}>새 장면</button>
              <button type="button" className="rp-btn ghost" onClick={reset}>닫기</button>
            </div>
          </div>
          <dl className="rp-result-grid">
            <div><dt>판단</dt><dd>{summary.trades}회 <span className="rp-dim">건너뜀 {summary.skips}</span></dd></div>
            <div><dt>적중률</dt><dd>{pct1(summary.hitRate)} <span className="rp-dim">{summary.wins}승 {summary.losses}패</span></dd></div>
            <div><dt>최고 · 최저</dt><dd><span className={toneOf(summary.best)}>{fmtPct(summary.best)}</span> · <span className={toneOf(summary.worst)}>{fmtPct(summary.worst)}</span></dd></div>
            <div><dt>연승</dt><dd>{summary.bestStreak}</dd></div>
            <div><dt>그냥 들고 있었다면</dt><dd className={toneOf(saved?.buyHoldPct)}>{fmtPct(saved?.buyHoldPct ?? null)}</dd></div>
            <div><dt>기록</dt><dd>{saved ? '이 브라우저에 저장됨' : '판단이 없어 저장 안 함'}</dd></div>
          </dl>
        </div>
      )}

      {showHistory && (
        <div className="rp-history" data-testid="replay-history">
          <div className="rp-history-h">
            <span>연습 기록 <span className="rp-dim">{hist.sessions}세션 · {hist.trades}판단 · 적중 {pct1(hist.hitRate)} · 누적 <span className={`rp-mono${toneOf(hist.totalPct)}`}>{fmtPct(hist.totalPct)}</span></span></span>
            {history.length > 0 && <button type="button" className="rp-link" onClick={() => { clearHistory(); setHistory([]); }}>기록 지우기</button>}
          </div>
          {history.length === 0 ? <div className="rp-empty-d">아직 끝낸 장면이 없어요.</div> : (
            <div className="twrap">
              <table className="t">
                <thead><tr><th>끝낸 때</th><th>심볼</th><th>봉</th><th className="n">판단</th><th className="n">적중</th><th className="n">누적</th><th className="n">들고 있었다면</th><th>장면</th></tr></thead>
                <tbody>
                  {history.map((s) => (
                    <tr key={s.id}>
                      <td>{fmtWhen(Date.parse(s.at))}</td>
                      <td className="rp-mono">{s.symbol}<span className="rp-dim"> {s.market === 'futures' ? '선물' : '현물'}</span></td>
                      <td>{s.interval} × {s.horizon}</td>
                      <td className="n">{s.summary.trades}</td>
                      <td className="n">{pct1(s.summary.hitRate)}</td>
                      <td className={`n rp-mono${toneOf(s.summary.totalPct)}`}>{fmtPct(s.summary.totalPct)}</td>
                      <td className={`n rp-mono${toneOf(s.buyHoldPct)}`}>{fmtPct(s.buyHoldPct)}</td>
                      <td className="rp-dim">{fmtWhen(s.playStartT)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
