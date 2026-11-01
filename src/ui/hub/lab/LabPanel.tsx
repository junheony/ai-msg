import { useEffect, useState } from 'react';
import type { LabResponse, LabSnapshot } from '../../../shared/lab-types';
import { liveLabApi, type LabApi } from './api';
import './lab.css';

const POLL_MS = 60_000;
const signed = (n: number, unit = 'USDT') => `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
const numeric = (n: number, digits = 0) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const kst = (v: string | null) => v ? `${v.replace('T', ' ').replace(/\+09:00$/, '')} KST` : '— 미보고';
const shorten = (v: string) => v.length > 16 ? `${v.slice(0, 12)}…` : v;
const tone = (v: number | null) => v === null || v === 0 ? '' : v > 0 ? 'lab-positive' : 'lab-negative';

/** Missing fields keep their individual source error; unrelated partial failures never infect good fields. */
function Field({ s, path, value, format }: { s: LabSnapshot; path: string; value: string | number | boolean | null; format?: (v: never) => string }) {
  const issue = s.issues[path] ?? Object.entries(s.issues).find(([prefix]) => path.startsWith(`${prefix}.`))?.[1];
  if (value === null) return <span className={issue ? 'lab-missing lab-warning' : 'lab-missing'} title={issue} aria-label={issue ? `오류: ${issue}` : '미보고'}>— {issue ? '⚠ 오류' : '미보고'}</span>;
  return <span title={issue}>{format ? format(value as never) : String(value)}</span>;
}
function Evidence({ s, label, path, value, format }: { s: LabSnapshot; label: string; path: string; value: string | number | boolean | null; format?: (v: never) => string }) {
  return <div><dt>{label}</dt><dd><Field s={s} path={path} value={value} format={format} /></dd></div>;
}
function Progress({ s, label, path, value, target, unit }: { s: LabSnapshot; label: string; path: string; value: number | null; target: number; unit: string }) {
  return <div className="lab-progress"><div><span>{label}</span><b><Field s={s} path={path} value={value} format={(v: number) => numeric(v, unit === '일' ? 2 : 0)} /><small> / {target} {unit}</small></b></div>{value !== null && <progress aria-label={label} max={target} value={value} />}</div>;
}

export function LabPanel({ api = liveLabApi, now = Date.now() }: { api?: LabApi; now?: number }) {
  const [response, setResponse] = useState<LabResponse | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [clientFailures, setClientFailures] = useState(0);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.summary(); if (alive) { setResponse(next); setClientError(null); setClientFailures(0); } }
      catch { if (alive) { setClientError('요약 서버 연결 오류'); setClientFailures(n => n + 1); } }
      finally { if (alive) timer = setTimeout(() => { void poll(); }, POLL_MS); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api]);
  const s = response?.snapshot;
  const age = s?.generated_at ? Math.max(response?.ageSeconds ?? 0, Math.floor((now - Date.parse(s.generated_at)) / 1000)) : null;
  const offline = response?.failures !== undefined && response.failures >= 3 || clientFailures >= 3;
  const stale = response?.stale || clientError !== null || age !== null && age >= 90;
  const failed = s?.verify.ok === false;
  const field = (path: string, value: string | number | boolean | null, format?: (v: never) => string) => s ? <Field s={s} path={path} value={value} format={format} /> : null;
  return <section className={`sec open-static lab${offline ? ' lab-offline' : ''}`} aria-label="연구실 페이퍼 요약" data-testid="lab-panel">
    <header className="sh lab-header"><div><h2>연구실 페이퍼 요약</h2><span className="lab-sub">트레이딩 ver2 · 읽기 전용</span></div><span className="lab-paper">PAPER · LIVE OFF</span><div className="lab-clock">기준 시각 {s ? field('generated_at', s.generated_at, kst) : '—'}{age !== null && age >= 90 && <b className="lab-warning">STALE ({age}초 전)</b>}</div></header>
    <div className="b lab-body">
      {failed && <div className="lab-alert lab-failed" role="alert">원장 검증 실패: {s.verify.msg ?? '상세 미보고'}</div>}
      {offline && <div className="lab-alert" role="status">오프라인 · 마지막 갱신 {s ? kst(s.generated_at) : '없음'}<span>요약 서비스 연결 상태 확인</span></div>}
      {!offline && (clientError || response?.error) && <div className="lab-alert" role="status">{clientError ?? response?.error} · {s ? '이전 값 표시 중' : '요약 미보고'}<span>다음 60초 주기에 다시 확인합니다.</span></div>}
      {!response && !clientError && <p role="status">연구실 요약 불러오는 중…</p>}
      {s && <>
        {s.loading && <div className="lab-alert" role="status">엔진 준비 중(1~2분)</div>}
        {(s.errors.length > 0 || Object.keys(s.issues).length > 0) && <p className="lab-warning" title={s.errors[0] ?? Object.values(s.issues)[0]}>일부 항목 오류 · 해당 값의 경고 확인</p>}
        {stale && !offline && !response?.error && !clientError && age === null && <p className="lab-warning">이전 값 표시 중</p>}
        <div className="lab-health">
          <span>페이퍼 엔진 <b>{field('engine.paper.ok', s.engine.paper.ok, (v: boolean) => v ? '정상' : '오류')}</b></span>
          <span>준비 상태 <b>{field('engine.paper.ready', s.engine.paper.ready, (v: boolean) => v ? '준비 완료' : '준비 중')}</b></span>
          <span>원장 서비스 <b>{field('engine.ledger.ok', s.engine.ledger.ok, (v: boolean) => v ? '정상' : '오류')}</b></span>
          <span>열린 포지션 <b>{field('open_positions_total', s.open_positions_total, (v: number) => `${numeric(v)}건`)}</b></span>
        </div>
        {!s.loading && <div className="lab-books" data-testid="lab-books">
          {s.books === null ? <p>전략 북 {field('books', null)}</p> : s.books.map((book, i) => {
            const p = `books.${i}`;
            return <article className="lab-book" key={i} aria-label={book.label ?? `북 ${i + 1}`}><h3>{field(`${p}.label`, book.label)}</h3><div className="lab-equity">{field(`${p}.equity`, book.equity, (v: number) => numeric(v))}<small>USDT</small></div><div className={`lab-return ${tone(book.return_pct)}`}>{field(`${p}.return_pct`, book.return_pct, (v: number) => signed(v, '%'))}</div><dl>
              <Evidence s={s} label="실현 PnL" path={`${p}.pnl.realized`} value={book.pnl.realized} format={signed} />
              <Evidence s={s} label="미실현 PnL" path={`${p}.pnl.unrealized`} value={book.pnl.unrealized} format={signed} />
              <Evidence s={s} label="청산" path={`${p}.n_trades`} value={book.n_trades} /><Evidence s={s} label="승" path={`${p}.wins`} value={book.wins} />
              <Evidence s={s} label="열린 포지션" path={`${p}.open_positions`} value={book.open_positions} /><Evidence s={s} label="최대 낙폭" path={`${p}.max_dd_pct`} value={book.max_dd_pct} format={(v: number) => `${numeric(v, 2)}%`} />
            </dl></article>;
          })}
        </div>}
        <div className="lab-evidence">
          <section aria-label="인증 진행"><h3>인증 진행</h3><p>{field('ledger.all_pass', s.ledger.all_pass, (v: boolean) => v ? '인증 목표 달성' : '진행 중')}{s.ledger.all_pass === null && ' · 판단 불가'}</p>
            <Progress s={s} label="인증 가능 청산" path="ledger.certifiable_closed_trades" value={s.ledger.certifiable_closed_trades} target={100} unit="건" />
            <Progress s={s} label="기록 기간" path="ledger.span_days" value={s.ledger.span_days} target={90} unit="일" />
            <dl><Evidence s={s} label="기대값 95% 하한" path="ledger.expectancy.ci95_lower" value={s.ledger.expectancy.ci95_lower} format={(v: number) => signed(v, 'R')} /></dl>{s.ledger.expectancy.ci95_lower === null && s.ledger.expectancy.reason && <p className="lab-sub">{s.ledger.expectancy.reason}</p>}
          </section>
          <section aria-label="원장 검증"><h3>원장 무결성 <span className={failed ? 'lab-negative' : ''}>{field('verify.ok', s.verify.ok, (v: boolean) => v ? '✓ 통과' : '✗ 실패')}</span></h3><dl>
            <Evidence s={s} label="레코드" path="verify.entries" value={s.verify.entries} />
            <Evidence s={s} label="체인 head" path="verify.head" value={s.verify.head} format={shorten} />
            <Evidence s={s} label="마지막 Merkle root" path="verify.last_merkle_root" value={s.verify.last_merkle_root} format={shorten} />
            <Evidence s={s} label="Root 날짜 (KST)" path="verify.last_merkle_root_date" value={s.verify.last_merkle_root_date} />
            <Evidence s={s} label="타임스탬프" path="verify.last_ots_status" value={s.verify.last_ots_status} />
            <Evidence s={s} label="Gap 횟수" path="verify.gap_count" value={s.verify.gap_count} />
            <Evidence s={s} label="Gap 시간" path="verify.gap_seconds_total" value={s.verify.gap_seconds_total} format={(v: number) => `${numeric(v)}초`} />
          </dl><p className="lab-sub">Gap은 원장 폴링이 60초 넘게 멈춘 기록입니다.</p></section>
        </div>
        {!s.loading && <>
          <section className="lab-detail" aria-label="열린 모의 포지션"><h3>열린 모의 포지션</h3>
            {s.books === null ? <p>{field('books', null)}</p> : s.books.map((book, i) => <div key={i} className="lab-position-book"><h4>{book.label ?? '북 이름 미보고'}</h4>{book.open === null ? <p>{field(`books.${i}.open`, null)}</p> : !book.open.length ? <p className="lab-sub">열린 포지션 없음</p> : <div className="lab-table-wrap"><table className="t lab-table"><thead><tr><th>종목</th><th>방향</th><th>진입 시각 (KST)</th><th>진입가</th><th>현재가</th><th>미실현 PnL</th><th>미실현 %</th></tr></thead><tbody>{book.open.map((position, j) => <tr key={j}>{(['sym', 'side', 'entry_kst', 'entry', 'mark', 'upnl', 'upnl_pct'] as const).map(key => <td key={key} className={typeof position[key] === 'number' ? 'n' : ''}>{field(`books.${i}.open.${j}.${key}`, position[key], key === 'upnl' ? signed : key === 'upnl_pct' ? (v: number) => signed(v, '%') : undefined)}</td>)}</tr>)}</tbody></table></div>}</div>)}
          </section>
          <section className="lab-detail" aria-label="최근 청산"><h3>최근 청산 <small>최대 10건</small></h3>{s.recent_closed_trades === null ? <p>{field('recent_closed_trades', null)}</p> : !s.recent_closed_trades.length ? <p className="lab-sub">최근 청산 없음</p> : <div className="lab-table-wrap"><table className="t lab-table"><thead><tr><th>청산 시각 (KST)</th><th>북</th><th>종목</th><th>방향</th><th>사유</th><th>PnL</th><th>R</th><th>원장 인증</th></tr></thead><tbody>{s.recent_closed_trades.map((trade, i) => <tr key={i}>{(['exit_kst', 'book', 'sym', 'side', 'reason', 'pnl', 'r', 'ledger_certifiable'] as const).map(key => <td key={key} className={key === 'pnl' || key === 'r' ? `n ${tone(trade[key])}` : ''}>{key === 'ledger_certifiable' && trade[key] === null && !s.issues[`recent_closed_trades.${i}.${key}`] ? <span aria-label="인증 여부 미보고">—</span> : field(`recent_closed_trades.${i}.${key}`, trade[key], key === 'pnl' ? signed : key === 'r' ? (v: number) => signed(v, 'R') : key === 'ledger_certifiable' ? (v: boolean) => v ? '인증' : '불가' : undefined)}</td>)}</tr>)}</tbody></table></div>}</section>
        </>}
      </>}
      <p className="lab-disclaimer">분석·연구용 모의 거래(페이퍼) 기록이며 투자 권유가 아닙니다. 실거래 OFF.</p>
    </div>
  </section>;
}
