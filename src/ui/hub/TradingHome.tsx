/**
 * Trading room mode: the READ-ONLY merged view of the two trading bots, rendered from `mode.trading`
 * (built server-side by src/server/hub/tradingRoom.ts + cblabx.ts from GET-only probes).
 *
 *  - 트레이딩룸 :8830 — taker / maker / adaptive workstreams, each its own card with its own PnL line. Nothing is summed.
 *  - 트레이딩-ver2 — paper engine :8771 (books, equity curves, open positions, trades, events) + hash-chained ledger :8793.
 *
 * There are no controls here: not a single <button>, form or link that could act on a bot. A bot that is down gets a
 * plain "응답 없음" block in its place and the rest of the page stays up. Snapshot fallbacks older than 24 h are banded.
 */
import type { HubAlert, HubState, TradingMerged, TradingRoomView, TradingWorkstream, Ver2Book, Ver2Ledger, Ver2Paper } from '../../shared/hub-types';
import { Chart, Spark } from './HubSections';
import { STATE_LABEL, stateClass } from './modes';
import { relTime } from './time';
import './trading.css';

/* ───────── formatting ───────── */

const fmt = (v: number | null | undefined, d = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const int = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US'));
/** `$60,187.61`; nothing → —. */
export const usd = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : ''}$${fmt(Math.abs(v))}`);
/** `+41.34` / `-27.07` with the sign kept; nothing → —. */
export const sgn = (v: number | null | undefined, d = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmt(Math.abs(v), d)}`);
const tone = (v: number | null | undefined): string => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
/** Price with as many decimals as the magnitude needs (BTC 77,257.6 vs XRP 1.2819). */
const px = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v >= 1000 ? fmt(v, 1) : v >= 10 ? fmt(v, 2) : fmt(v, 4));
const hm = (kst: string | null | undefined): string => (kst ? kst.slice(5, 16) : '—'); // '2026-10-31 15:00' → '10-31 15:00'
const uptime = (s: number | null): string => (s === null ? '—' : s >= 86_400 ? `${Math.floor(s / 86_400)}일 ${Math.floor((s % 86_400) / 3600)}시간` : s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${Math.floor(s / 60)}분`);
const SIDE: Record<string, string> = { long: '롱', short: '숏' };
const side = (s: string): string => SIDE[s] ?? s;
const REASON: Record<string, string> = { tp: '익절', stop: '손절', time: '시간', manual: '수동', signal: '신호' };
const reason = (r: string): string => REASON[r] ?? r;

const Pill = ({ state }: { state: HubState }) => <span className={`hub-st ${stateClass(state)}`}><i />{STATE_LABEL[state]}</span>;

const Sec = ({ title, note, right, children, testid, className }: { title: string; note?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; testid: string; className?: string }) => (
  <section className={`sec open-static tr-sec ${className ?? ''}`} data-testid={testid}>
    <div className="sh"><span className="sec-title">{title}</span>{note !== undefined && <span className="n tr-note">{note}</span>}{right !== undefined && <span className="tr-right">{right}</span>}</div>
    <div className="b">{children}</div>
  </section>
);

/** What a silent bot leaves behind: one calm line, no retry button (this page cannot act). */
const Down = ({ what, error, hint }: { what: string; error: string | null; hint?: string }) => (
  <div className="tr-down" role="status">
    <b>{what} 응답 없음</b>{error && <span className="tr-dim"> · {error}</span>}
    {hint && <p>{hint}</p>}
  </div>
);

const Mini = ({ items }: { items: { k: string; v: React.ReactNode; s?: string }[] }) => (
  <div className="tr-mini">
    {items.map((it) => <div key={it.k} className={`tr-mi ${it.s ?? ''}`}><span className="k">{it.k}</span><b>{it.v}</b></div>)}
  </div>
);

const Alerts = ({ alerts, now }: { alerts: HubAlert[]; now: number }) => (
  <ul className="att inner tr-att">
    {alerts.map((a, i) => (
      <li key={i} className={a.level}>
        <span className={`hub-dot ${a.level === 'bad' ? 'bad' : a.level}`} />
        <span className="tx">{a.text}{a.hint && <span className="tr-dim"> · {a.hint}</span>}</span>
        <span className="at">{a.at ? relTime(a.at, now) : ''}</span>
      </li>
    ))}
  </ul>
);

/* ───────── 트레이딩룸 :8830 ───────── */

const VIA: Record<TradingRoomView['via'], string> = { live: '실시간', snapshot: '스냅샷', none: '응답 없음' };

function Workstream({ w }: { w: TradingWorkstream }) {
  return (
    <article className={`hs-card tr-ws ${stateClass(w.state)}`} aria-label={`${w.label} 워크스트림`} data-testid={`tr-ws-${w.id}`}>
      <div className="hs-card-top">
        <h4>{w.label}</h4>
        {w.badge && <span className={`hs-badge ${w.badge === 'LIVE' ? 'tr-live' : ''}`}>{w.badge}</span>}
        <Pill state={w.state} />
      </div>
      {w.rows.length > 0 ? (
        <dl className="hs-rows">
          {w.rows.map((r, i) => <div key={i}><dt>{r.label}</dt><dd className={r.status ?? ''}>{r.value}</dd></div>)}
        </dl>
      ) : <div className="sec-empty">지표 없음</div>}
      {/* each workstream's own PnL line, kept inside its card so nothing invites adding them up */}
      <div className="tr-pnl" data-testid={`tr-pnl-${w.id}`}>
        <span className="k">{w.label} PnL</span>
        <b className={w.pnl === null ? 'tr-dim' : ''}>{w.pnl ?? '미보고'}</b>
        <span className="tr-dim">{w.pnlNote}</span>
      </div>
      {w.note && <p className="hs-card-note">{w.note}</p>}
    </article>
  );
}

function Room({ r, now }: { r: TradingRoomView; now: number }) {
  const okN = r.workstreams.filter((w) => w.state === 'ok').length;
  const note = r.via === 'none' ? '봇도 스냅샷도 없음' : <>{VIA[r.via]}{r.stage ? ` · ${r.stage}` : ''}{r.generatedAt ? ` · ${r.via === 'live' ? '생성' : '스냅샷'} ${relTime(r.generatedAt, now)}` : ''}</>;
  return (
    <Sec title="트레이딩룸 :8830" testid="tr-room" note={note} right={<span className={`hub-st ${r.via === 'none' ? 'bad' : r.stale ? 'warn' : r.via === 'snapshot' ? '' : 'ok'}`}><i />{VIA[r.via]}</span>}>
      {r.via === 'snapshot' && (
        <div className={`tr-band ${r.stale ? 'warn' : 'info'}`} role="status" data-testid="tr-snapshot-band">
          <b>{r.stale ? '오래된 스냅샷' : '스냅샷으로 표시 중'}</b>
          <span> · :8830 이 응답하지 않아 ~/trading-status 스냅샷 파일을 보여줌{r.ageH !== null ? ` · ${fmt(r.ageH, 1)}h 전 생성` : ''}{r.stale ? ' · 24h 초과 — 현재 상태와 다를 수 있음' : ''}{r.error ? ` · ${r.error}` : ''}</span>
        </div>
      )}
      {r.via === 'none' && <Down what=":8830 /api/status" error={r.error} hint="스냅샷 파일(~/trading-status/snapshot/trading_room_snapshot.json)도 읽지 못함. 여기서는 읽기만 하므로 trading-status.service 는 봇 쪽에서 확인." />}
      <Mini items={[
        { k: '워크스트림', v: `${okN}/${r.workstreams.length} 정상`, s: okN === r.workstreams.length ? 'ok' : okN ? 'warn' : 'bad' },
        { k: '상태 · 단계', v: `${r.state ?? '—'} · ${r.stage ?? '—'}` },
        { k: '봇 자체 스냅샷', v: r.botSnapshotAgeH === null ? '—' : `${fmt(r.botSnapshotAgeH, 1)}h 전`, s: r.botSnapshotAgeH !== null && r.botSnapshotAgeH > 24 ? 'warn' : '' },
        { k: '알림', v: int(r.alerts.length), s: r.alerts.some((a) => a.level === 'bad') ? 'bad' : r.alerts.some((a) => a.level === 'warn') ? 'warn' : '' },
      ]} />
      <p className="tr-rule">세 워크스트림은 따로 본다 · PnL 은 워크스트림별 표시, 합산 없음</p>
      <div className="tr-wss" data-testid="tr-workstreams">
        {r.workstreams.map((w) => <Workstream key={w.id} w={w} />)}
      </div>
      {r.alerts.length > 0 && <Alerts alerts={r.alerts} now={now} />}
    </Sec>
  );
}

/* ───────── 트레이딩-ver2 페이퍼 :8771 ───────── */

function Book({ b }: { b: Ver2Book }) {
  const ret = b.cashStart && b.equity !== null ? ((b.equity - b.cashStart) / b.cashStart) * 100 : null;
  const win = b.nTrades && b.wins !== null ? (b.wins / b.nTrades) * 100 : null;
  return (
    <article className="hs-card tr-book" aria-label={b.label} data-testid={`tr-book-${b.id}`}>
      <div className="hs-card-top">
        <h4>{b.label}</h4>
        <span className="hs-badge">{b.id}</span>
        {b.openN > 0 && <span className="hub-st warn"><i />열린 {b.openN}</span>}
      </div>
      <div className="tr-eq">
        <b>{usd(b.equity)}</b>
        <span className={tone(ret)}>{ret === null ? '' : `${sgn(ret)}%`}</span>
        <span className="tr-dim">시작 {usd(b.cashStart)}</span>
      </div>
      <Spark values={b.spark} unit="$" label="자산" />
      <dl className="hs-rows">
        <div><dt>실현 · 미실현</dt><dd><span className={tone(b.realized)}>{sgn(b.realized)}</span> · <span className={tone(b.unrealized)}>{sgn(b.unrealized)}</span></dd></div>
        <div><dt>체결 · 승률</dt><dd>{int(b.nTrades)}{win === null ? '' : ` · ${fmt(win, 0)}%`}</dd></div>
        <div><dt>평균 R · MDD</dt><dd>{fmt(b.avgR)} · {b.maxDdPct === null ? '—' : `${fmt(b.maxDdPct)}%`}</dd></div>
        <div><dt>신호 · 마지막 봉</dt><dd>{int(b.signalsSeen)} · {hm(b.lastBarKst)}</dd></div>
      </dl>
      <p className="hs-card-note">{b.strategy} · {b.tf} · {b.symbols.join(' ')}</p>
    </article>
  );
}

function Paper({ p }: { p: Ver2Paper }) {
  const openN = p.open.length;
  const note = p.ok ? <>{p.books.length}북 · 열린 {openN} · 마지막 폴 {hm(p.lastPollKst)}</> : '응답 없음';
  return (
    <Sec title="트레이딩-ver2 페이퍼 :8771" testid="tr-paper" note={note} right={p.ok ? <span className={`hub-st ${p.live ? 'bad' : 'ok'}`}><i />{p.live ? 'LIVE?!' : 'PAPER'}</span> : <span className="hub-st bad"><i />응답 없음</span>}>
      {!p.ok && <Down what=":8771 /api/paper/state" error={p.error} hint="cblabx-paper 가 내려갔거나 느림. 이 페이지는 재시작하지 않음." />}
      {p.ok && (
        <>
          {p.live && <div className="tr-band bad" role="alert"><b>엔진이 LIVE=true 로 응답</b><span> · 모의 전용이어야 함 — 봇 쪽에서 확인</span></div>}
          <Mini items={[
            { k: '모드', v: p.mode ?? '—', s: p.live ? 'bad' : 'ok' },
            { k: '가동', v: uptime(p.uptimeS) },
            { k: '루프 · 오류', v: `${int(p.loops)} · ${int(p.errors)}`, s: p.errors ? 'warn' : '' },
            { k: '폴 주기 · 수수료', v: `${p.pollS === null ? '—' : `${p.pollS}s`} · ${p.feePct === null ? '—' : `${p.feePct}%`}` },
            { k: '시작', v: hm(p.startedKst) },
            { k: '시세', v: p.exchangeData ?? '—' },
          ]} />
          {p.lastError && <p className="tr-err">마지막 오류 · {p.lastError}</p>}
          {p.books.length === 0 ? <div className="sec-empty">북 없음</div> : <div className="tr-books" data-testid="tr-books">{p.books.map((b) => <Book key={b.id} b={b} />)}</div>}
          {p.disclaimer && <p className="tr-rule">{p.disclaimer}{p.rules ? ` · ${p.rules}` : ''}</p>}
        </>
      )}
    </Sec>
  );
}

function Equity({ p }: { p: Ver2Paper }) {
  if (!p.ok || !p.equity || p.equity.series.length === 0) return null;
  const e = p.equity;
  return (
    <Sec title="ver2 북별 자산 곡선" testid="tr-equity" note={`${e.series.length}북 · ${e.x.length}점 · KST`}>
      <Chart s={{ kind: 'chart', title: 'ver2 북별 자산 곡선', x: e.x, series: e.series, unit: '$' }} />
    </Sec>
  );
}

function Positions({ p }: { p: Ver2Paper }) {
  if (!p.ok) return null;
  return (
    <Sec title="열린 포지션 (모의)" testid="tr-open" note={p.open.length ? `${p.open.length}건` : '없음'}>
      {p.open.length === 0 ? <div className="sec-empty">열린 모의 포지션 없음</div> : (
        <div className="tr-tw"><table className="t tr-t">
          <thead><tr><th>북</th><th>심볼</th><th>방향</th><th className="n">진입</th><th className="n">현재</th><th className="n">손절</th><th className="n">익절</th><th className="n">수량</th><th className="n">미실현</th><th>진입 시각</th></tr></thead>
          <tbody>
            {p.open.map((o, i) => (
              <tr key={i}><td>{o.book}</td><td><b>{o.sym}</b></td><td className={o.side === 'long' ? 'st-ok' : 'st-bad'}>{side(o.side)}</td><td className="n">{px(o.entry)}</td><td className="n">{px(o.mark)}</td><td className="n">{px(o.stop)}</td><td className="n">{px(o.tp)}</td><td className="n">{fmt(o.qty, 4)}</td><td className={`n ${tone(o.upnl)}`}>{sgn(o.upnl)}{o.upnlPct === null ? '' : ` (${sgn(o.upnlPct)}%)`}</td><td className="tr-dim">{hm(o.entryKst)}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Sec>
  );
}

function Trades({ p }: { p: Ver2Paper }) {
  if (!p.ok) return null;
  return (
    <Sec title="최근 모의 체결" testid="tr-trades" note={p.trades.length ? `최근 ${p.trades.length}건 · PnL 은 북별 개별 값` : '없음'}>
      {p.trades.length === 0 ? <div className="sec-empty">체결 없음</div> : (
        <div className="tr-tw"><table className="t tr-t">
          <thead><tr><th>청산 시각</th><th>북</th><th>심볼</th><th>방향</th><th className="n">진입</th><th className="n">청산</th><th>사유</th><th className="n">PnL</th><th className="n">R</th></tr></thead>
          <tbody>
            {p.trades.map((t, i) => (
              <tr key={i}><td className="tr-dim">{hm(t.exitKst)}</td><td>{t.book}</td><td><b>{t.sym}</b></td><td>{side(t.side)}</td><td className="n">{px(t.entry)}</td><td className="n">{px(t.exit)}</td><td className={t.reason === 'tp' ? 'st-ok' : t.reason === 'stop' ? 'st-bad' : ''}>{reason(t.reason)}</td><td className={`n ${tone(t.pnl)}`}>{sgn(t.pnl)}</td><td className={`n ${tone(t.r)}`}>{sgn(t.r)}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Sec>
  );
}

function Events({ p }: { p: Ver2Paper }) {
  if (!p.ok || p.events.length === 0) return null;
  return (
    <Sec title="ver2 이벤트" testid="tr-events" note={`최근 ${p.events.length}건`}>
      <ul className="tr-ev">
        {p.events.map((e, i) => <li key={i}><span className="tr-dim tr-mono">{e.kst ?? '—'}</span><span className={`hs-badge ev-${e.kind}`}>{e.kind}</span><span className="tx">{e.msg}</span></li>)}
      </ul>
    </Sec>
  );
}

/* ───────── 원장 :8793 ───────── */

function Ledger({ l }: { l: Ver2Ledger }) {
  const v = l.verify;
  const vState: HubState = v === null ? 'unknown' : v.ok === true ? 'ok' : 'down';
  return (
    <Sec title="ver2 원장 :8793" testid="tr-ledger" note={l.ok ? <>{int(l.records)}건 · 마지막 폴 {hm(l.lastPollKst)}</> : '응답 없음'} right={l.ok ? <span className={`hub-st ${stateClass(vState)}`}><i />검증 {v === null ? '—' : v.ok === true ? '통과' : '실패'}</span> : <span className="hub-st bad"><i />응답 없음</span>}>
      {!l.ok && <Down what=":8793 /health" error={l.error} hint="cblabx-ledger 가 내려갔거나 느림. ledger.jsonl / anchors.jsonl 은 여기서 건드리지 않음." />}
      {l.ok && (
        <>
          <Mini items={[
            { k: '해시 체인 검증', v: v === null ? '—' : v.ok === true ? `통과 · ${int(v.n)}건` : `실패 · ${v.msg}`, s: v === null ? '' : v.ok === true ? 'ok' : 'bad' },
            { k: '엔진 준비', v: l.engineReady === null ? '—' : l.engineReady ? '예' : '아니오', s: l.engineReady === false ? 'warn' : '' },
            { k: '오류', v: int(l.errors), s: l.errors ? 'warn' : '' },
            { k: '지연 한도', v: l.maxLatencyS === null ? '—' : `${l.maxLatencyS}s` },
          ]} />
          {v && v.warnings.length > 0 && <ul className="tr-warns">{v.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          {l.lastError && <p className="tr-err">마지막 오류 · {l.lastError}</p>}
          {l.stats.length > 0 && (
            <div className="tr-tw"><table className="t tr-t" aria-label="북별 원장 통계">
              <thead><tr><th>북</th><th className="n">신호 (인증)</th><th className="n">청산 (인증)</th><th className="n">인증 R 합</th><th className="n">지연 중앙값</th><th>진행</th></tr></thead>
              <tbody>
                {l.stats.map((s) => <tr key={s.book}><td><b>{s.book}</b></td><td className="n">{int(s.signals)} ({int(s.signalsCert)})</td><td className="n">{int(s.exits)} ({int(s.exitsCert)})</td><td className="n">{sgn(s.rCertSum)}</td><td className="n">{s.latencyMedianS === null ? '—' : `${fmt(s.latencyMedianS, 0)}s`}</td><td>{s.progress ?? '—'}</td></tr>)}
              </tbody>
            </table></div>
          )}
          {l.recent.length > 0 && (
            <div className="tr-tw"><table className="t tr-t" aria-label="최근 원장 기록">
              <thead><tr><th className="n">#</th><th>시각</th><th>종류</th><th>전략</th><th>심볼</th><th>방향</th><th>사유</th><th className="n">모의 PnL</th><th className="n">R</th><th>인증</th></tr></thead>
              <tbody>
                {l.recent.map((r, i) => <tr key={i}><td className="n tr-dim">{int(r.seq)}</td><td className="tr-dim">{r.tsKst ? r.tsKst.slice(5) : '—'}</td><td>{r.kind}</td><td>{r.strategy}</td><td><b>{r.sym}</b></td><td>{side(r.side)}</td><td>{r.reason ? reason(r.reason) : ''}</td><td className={`n ${tone(r.pnlPaper)}`}>{sgn(r.pnlPaper)}</td><td className="n">{sgn(r.rPaper)}</td><td className={r.certifiable ? 'st-ok' : 'tr-dim'}>{r.certifiable === null ? '—' : r.certifiable ? '예' : '아니오'}</td></tr>)}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </Sec>
  );
}

/* ───────── page ───────── */

export function TradingHome({ t, now }: { t: TradingMerged; now: number }) {
  const { room, ver2 } = t;
  return (
    <div className="tr" data-testid="trading-home">
      <div className="tr-ro" role="note">
        <b>읽기 전용</b>
        <span>두 봇(:8830 트레이딩룸 · :8771/:8793 트레이딩-ver2)의 결과만 GET 으로 합쳐 보여줌 · 제어 없음 · 워크스트림 PnL 합산 안 함</span>
      </div>
      <div className="tr-grid">
        <Room r={room} now={now} />
        <Paper p={ver2.paper} />
      </div>
      <Equity p={ver2.paper} />
      <div className="tr-grid">
        <Positions p={ver2.paper} />
        <Trades p={ver2.paper} />
      </div>
      <Ledger l={ver2.ledger} />
      <Events p={ver2.paper} />
    </div>
  );
}
