/**
 * NEXUS 지금: the standalone dashboard's home (components/v2/InboxPage.tsx + HomeParts.tsx) ported read-only.
 * Same order of things — tabs · 시장 one-liner · 할 일 cards · 오늘 12시간 띠 · 상장 · 지갑 흐름 · 신호 성적표 · 운영 메모 —
 * minus the hero answer block and every decide/act button. Links go to the outside dashboard in a new tab.
 * The data is `mode.nexus` (server-mapped, secrets stripped); this file only formats and lays it out.
 */
import type { NexusAction, NexusHome as NexusHomeData, NexusOp } from '../../shared/hub-types';
import { ExternalIcon } from './HubIcons';
import { relTime } from './time';
import './nexus.css';

/* ───────── formatting ───────── */

const KST = 'Asia/Seoul';
const HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: KST, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MDHM = new Intl.DateTimeFormat('en-GB', { timeZone: KST, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit' });
const ms = (iso: string | null | undefined): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
/** `21:49` in Seoul time; '—' when unknown. */
export const kst = (iso: string | null | undefined): string => { const t = ms(iso); return t === null ? '—' : HHMM.format(new Date(t)); };
/** `21:49` today, `어제 21:49`, otherwise `10/28 21:49` (Seoul). */
export function kstDay(iso: string | null | undefined, now: number): string {
  const t = ms(iso);
  if (t === null) return '—';
  const a = DAY.format(new Date(t)), b = DAY.format(new Date(now));
  if (a === b) return HHMM.format(new Date(t));
  const dd = Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
  if (dd === -1) return `어제 ${HHMM.format(new Date(t))}`;
  if (dd === 1) return `내일 ${HHMM.format(new Date(t))}`;
  return MDHM.format(new Date(t)).replace(',', '');
}
/** `N초 전` under a minute, then relTime's 분/시간/일. */
export function ageOf(iso: string | null | undefined, now: number): string {
  const t = ms(iso);
  if (t === null) return '시각 모름';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}초 전` : relTime(iso, now);
}
/** Seconds of source age → `N초 전` / `N분 전` / `N시간 전`; '나이 모름' for null. */
export const secAgo = (s: number | null | undefined): string => (s === null || s === undefined ? '나이 모름' : s < 120 ? `${Math.round(s)}초 전` : s < 7200 ? `${Math.round(s / 60)}분 전` : `${(s / 3600).toFixed(1)}시간 전`);
export const sgn = (v: number | null | undefined, d = 2): string => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
export const usd = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a >= 100 ? Math.round(a) : a.toFixed(a >= 10 ? 1 : 2)}`;
};
const usd1k = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}`);
const won = (v: number | null | undefined, digits = 0): string => (v === null || v === undefined ? '—' : `₩${v.toLocaleString('en-US', { maximumFractionDigits: digits })}`);
const toneOf = (v: number | null | undefined): string => (v === null || v === undefined ? '' : v > 0 ? ' pos' : v < 0 ? ' neg' : '');
const VKO: Record<string, string> = { bithumb: '빗썸', upbit: '업비트', coinone: '코인원', korbit: '코빗', binance: '바이낸스', bybit: '바이빗', okx: 'OKX', gate: '게이트', bitget: '비트겟', mexc: 'MEXC', htx: 'HTX', kucoin: '쿠코인' };
const vko = (v: string | null | undefined): string => (v ? VKO[v] ?? v : '—');
const SRC_KO: Record<string, string> = { gap_exec: '갭이송', kr_gap: '국내갭', blocked: '막힌경로', crime_cex: '팀→CEX', listing: '상장', listing_live: '상장 진행', alert_broken: '알람', ops: '운영', missed: '놓침', near: '근접' };
const ROUTE_KO: Record<string, string> = { gap_exec_pass: '실행 따리', kr_gap: '국내갭', blocked: '막힌 경로' };
const KIND_KO: Record<string, string> = { kol: 'KOL', team: '팀', deposit: '입금' };
/** Dashboard tones (go/bad/warn/info/q) → the hub's state classes. */
const TONE_CLS: Record<string, string> = { go: 'ok', bad: 'bad', warn: 'warn', q: 'info', info: '' };
const toneCls = (t: string): string => TONE_CLS[t] ?? '';
const TONE_RANK: Record<string, number> = { go: 0, bad: 1, warn: 2, q: 3, info: 4 };
/** Stale thresholds (s), as the dashboard's home_shape STALE_S. */
const STALE = { pulse: 300, peg: 300, kol: 900, bins: 600 } as const;

const Ext = ({ href, children, className = 'nx-ext' }: { href: string; children: React.ReactNode; className?: string }) => (
  <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children} <ExternalIcon /></a>
);
const Empty = ({ text }: { text: string }) => <div className="nx-empty">{text}</div>;
const Sec = ({ title, note, right, children, testid }: { title: string; note?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; testid: string }) => (
  <section className="sec open-static nx-sec" data-testid={testid}>
    <div className="sh"><span className="sec-title">{title}</span>{note !== undefined && <span className="n nx-note">{note}</span>}{right !== undefined && <span className="nx-right">{right}</span>}</div>
    <div className="b">{children}</div>
  </section>
);

/* ───────── parts ───────── */

function Tabs({ home, now }: { home: NexusHomeData; now: number }) {
  const h = home.head;
  return (
    <div className="nx-top">
      <nav className="nx-tabs" aria-label="NEXUS 탭">
        {home.tabs.map((t) => (t.label === '지금'
          ? <span key={t.label} className="nx-tab on" aria-current="page">{t.label}</span>
          : <a key={t.label} className="nx-tab" href={t.href} target="_blank" rel="noopener noreferrer">{t.label} <ExternalIcon /></a>))}
      </nav>
      <div className="nx-fresh">
        <span className={`hub-st ${home.late ? 'warn' : 'ok'}`}><i />데이터 {ageOf(home.ts, now)}{home.late ? ' · 지연' : ''}</span>
        {home.late && home.late_what?.length ? <span className="nx-dim">{home.late_what.join(', ')} 불러오는 중</span> : null}
        {h.kill === true && <span className="hub-st bad"><i />KILL</span>}
        {h.armed_n !== null && <span className="nx-dim">무장 {h.armed_n}</span>}
        {h.failed_nexus !== null && <span className={`nx-dim${h.failed_nexus > 0 ? ' nx-warn' : ''}`}>유닛 실패 {h.failed_nexus}{h.failed_all !== null ? `/${h.failed_all}` : ''}</span>}
      </div>
    </div>
  );
}

/** The one-line 시장 summary that replaces the hero block. */
function Market({ home }: { home: NexusHomeData }) {
  const M = home.market, P = home.peg;
  const kStale = M.pulse_age_s !== null && M.pulse_age_s > STALE.pulse;
  const pStale = P.age_s !== null && P.age_s > STALE.peg;
  const stop = (age: number | null) => <span className="nx-stop">멈춤 {secAgo(age)}</span>;
  const item = (k: string, v: React.ReactNode, s?: React.ReactNode) => <span className="nx-mk"><span className="k">{k}</span><b>{v}</b>{s !== undefined && <span className="s">{s}</span>}</span>;
  const blocked = M.blocked_n;
  return (
    <div className="nx-market" data-testid="nx-market">
      {item('BTC', kStale ? stop(M.pulse_age_s) : M.btc.px === null ? '모름' : `$${Math.round(M.btc.px).toLocaleString('en-US')}`, M.btc.v !== null && !kStale ? <span className={toneOf(M.btc.v)}>{sgn(M.btc.v, 1)} 24h</span> : undefined)}
      {item(`알트${M.alt.n !== null ? ` ${M.alt.n}종` : ''}`, kStale ? stop(M.pulse_age_s) : <span className={toneOf(M.alt.v)}>{sgn(M.alt.v, 1)}</span>, '중앙 24h')}
      {item('김프', kStale ? stop(M.pulse_age_s) : sgn(M.kimp.v), M.kimp.n !== null ? `${M.kimp.n}종` : undefined)}
      {item('테더김프', pStale ? stop(P.age_s) : sgn(P.tprem), P.bank !== null ? `업비트 ${won(P.upbit_usdt)} ÷ 은행 ${won(P.bank, 1)}` : '은행 환율 모름')}
      {item('입출금 중단', home.halts.length ? `${home.halts.length}건` : '없음', home.halts.length ? home.halts.slice(0, 3).join(' · ') : '12시간')}
      {blocked && (blocked.upbit !== null || blocked.bithumb !== null) ? item('막힘', `업비트 ${blocked.upbit ?? '?'} · 빗썸 ${blocked.bithumb ?? '?'}`, '경로') : M.blocked === true ? item('막힘', '있음') : null}
      {item('24h 최고', home.best_24h ?? '—')}
      {item('국내갭 최고', home.kr.fresh === false ? <span className="nx-stop">자료 낡음 {secAgo(home.kr.age_s)}</span> : <>{sgn(home.kr.best_net)}{home.kr.best_sym ? ` ${home.kr.best_sym}` : ''}</>, home.kr.min_net !== null ? `실행 기준 ${home.kr.min_net}%` : undefined)}
    </div>
  );
}

function Card({ a }: { a: NexusAction }) {
  return (
    <article className={`nx-card t-${a.tone}`} data-testid="nx-card">
      <div className="nx-ch">
        {a.verdict && <span className={`nx-badge ${toneCls(a.tone)}`}>{a.verdict}</span>}
        <b className="nx-title">{a.title}</b>
        <span className="nx-dim">{SRC_KO[a.source] ?? a.source}</span>
        {a.href && <Ext href={a.href} className="nx-ext nx-open">열기</Ext>}
      </div>
      {a.action && <div className="nx-act">→ {a.action}</div>}
      {a.nums.length > 0 && <div className="nx-nums">{a.nums.map((n, i) => <span key={i}>{n}</span>)}</div>}
      {a.detail && <div className="nx-detail">{a.detail}</div>}
    </article>
  );
}

function Todo({ home }: { home: NexusHomeData }) {
  const f = home.funnel;
  const open = home.actions.filter((a) => a.fold !== 'fix').sort((a, b) => (TONE_RANK[a.tone] ?? 9) - (TONE_RANK[b.tone] ?? 9));
  const fix = home.actions.filter((a) => a.fold === 'fix');
  const gap = home.tabs.find((t) => t.label === '갭');
  const steps: [string, number | null][] = [['전체', f.total], ['경로', f.route], ['식별', f.ident], ['깊이', f.depth], ['순익', f.net], ['통과', f.pass]];
  return (
    <Sec title="할 일" testid="nx-todo" note={<>{open.length ? `카드 ${open.length}` : '카드 없음'}{fix.length ? ` · 고칠 것 ${fix.length}` : ''}{home.near.length ? ` · 근접 ${home.near.length}` : ''}</>} right={gap && <Ext href={gap.href}>갭 전체</Ext>}>
      <div className="nx-funnel" title="국내갭 깔때기: 전체 → 경로 → 식별 → 깊이 → 순익 → 통과">
        {steps.map(([k, v], i) => <span key={k} className="nx-fs">{i > 0 && <i>→</i>}<span className="k">{k}</span><b>{v ?? '—'}</b></span>)}
      </div>
      {open.length === 0 && fix.length === 0 ? <Empty text="남은 할 일 없음 — 전부 처리했거나 조용함" /> : null}
      <div className="nx-cards">{open.map((a) => <Card key={a.id} a={a} />)}</div>
      {fix.length > 0 && (
        <details className="nx-fold">
          <summary><b>고칠 것 {fix.length}</b> <span className="nx-dim">고장·허수 알람</span></summary>
          <div className="nx-cards">{fix.map((a) => <Card key={a.id} a={a} />)}</div>
        </details>
      )}
      {home.near.length > 0 && (
        <details className="nx-fold">
          <summary><b>근접 {home.near.length}</b> <span className="nx-dim">문턱 아래·경로 막힘 — 카드 아님</span></summary>
          <ul className="nx-near">
            {home.near.map((n) => (
              <li key={n.id}><b>{n.title}</b>{n.verdict && <span className={`nx-badge ${toneCls(n.tone)}`}>{n.verdict}</span>}<span className="nx-nums">{n.nums.map((x, i) => <span key={i}>{x}</span>)}</span>{n.action && <span className="nx-dim">{n.action}</span>}{n.detail && <span className="nx-dim">{n.detail}</span>}</li>
            ))}
          </ul>
        </details>
      )}
    </Sec>
  );
}

/** 오늘 12시간: the 국내갭 10-minute band (bar = max gap before fees), the now marker, and the day's '진짜' scored list. */
function Band({ home, now }: { home: NexusHomeData; now: number }) {
  const B = home.band;
  const t0 = ms(B.t0), t1 = ms(B.t1), tn = ms(B.now) ?? now;
  const span = t0 !== null && t1 !== null && t1 > t0 ? t1 - t0 : null;
  const pct = (t: number): number => (span === null || t0 === null ? 0 : Math.max(0, Math.min(100, ((t - t0) / span) * 100)));
  const bins = B.bins.map((b) => ({ ...b, tm: ms(b.t) })).filter((b): b is typeof b & { tm: number } => b.tm !== null);
  const cap = Math.max(0.01, ...bins.map((b) => b.max ?? 0));
  const binW = span !== null && B.bin_s ? Math.max(0.2, ((B.bin_s * 1000) / span) * 100) : 1;
  const ticks: number[] = [];
  if (t0 !== null && t1 !== null && span !== null) { const H = 3_600_000; for (let t = Math.ceil((t0 + 9 * H) / (2 * H)) * 2 * H - 9 * H; t <= t1; t += 2 * H) ticks.push(t); }
  const stale = B.bins_age_s !== null && B.bins_age_s > STALE.bins;
  const real = home.today.real;
  const sum = `국내갭 10분 칸 ${bins.length}개${bins.length ? ` · 최대 ${sgn(cap)} (수수료 전)` : ''} · 놓침 ${real.length}`;
  return (
    <Sec title="오늘 12시간" testid="nx-band" note={sum}>
      {span === null || bins.length === 0 ? <Empty text={span === null ? '띠 자료 없음' : '국내갭 기록 없음 (12시간)'} /> : (
        <div className="nx-band" role="img" aria-label={sum}>
          <div className="nx-band-tr" data-testid="nx-band-track">
            {bins.map((b) => (
              <span key={b.t} className="nx-bin" style={{ left: `${pct(b.tm)}%`, width: `calc(${binW.toFixed(3)}% - 1px)`, height: `${Math.max(4, Math.min(100, ((b.max ?? 0) / cap) * 100)).toFixed(0)}%` }}
                title={`${kst(b.t)} ${b.sym ?? '?'} ${vko(b.buy)}→${vko(b.sell)} 최대 ${sgn(b.max)}`} />
            ))}
            {real.map((r, i) => { const t = ms(r.t); return t === null ? null : <span key={i} className="nx-miss" style={{ left: `${pct(t)}%` }} title={`${kst(r.t)} ${r.sym} 놓침 $1k당 ${usd1k(r.net1k)} ${r.why}`} />; })}
            <span className="nx-fut" style={{ left: `${pct(tn)}%` }} />
            <span className="nx-now" style={{ left: `${pct(tn)}%` }}><em>지금 {kst(B.now ?? new Date(tn).toISOString())}</em></span>
            {stale && <span className="nx-stop nx-band-stop">스캔 멈춤 {secAgo(B.bins_age_s)}</span>}
          </div>
          <div className="nx-axis">{ticks.map((t) => <span key={t} style={{ left: `${pct(t)}%` }}>{HHMM.format(new Date(t))}</span>)}</div>
        </div>
      )}
      <div className="nx-sub">오늘 놓친 것 <b>{real.length}</b>{home.today.armed_n !== null ? <span className="nx-dim"> · 잡은 것 {home.today.armed_n === 0 ? '0 (자동 실거래 꺼짐 · 무장 0)' : `모름 (무장 ${home.today.armed_n})`}</span> : null}</div>
      {real.length === 0 ? <Empty text="오늘 '진짜'로 채점된 따리 없음" /> : (
        <ul className="nx-list">{real.map((r, i) => <li key={i}><span className="nx-t">{kst(r.t)}</span><b>{r.sym}</b><span>{ROUTE_KO[r.route] ?? r.route}</span><span className={`nx-num${toneOf(r.net1k)}`}>$1k당 {usd1k(r.net1k)}</span>{r.why && <span className="nx-dim">{r.why}</span>}</li>)}</ul>
      )}
    </Sec>
  );
}

function Listing({ home, now }: { home: NexusHomeData; now: number }) {
  const L = home.listing;
  const tab = home.tabs.find((t) => t.label === '상장');
  const note = L.ok === false ? '상장 감시 못 읽음' : `공지 ${L.n_seen !== null ? `${L.n_seen}건` : '?건'} 감시 · 예정 ${L.upcoming ?? 0} · 미정 ${L.pending ?? 0} · ${secAgo(L.age_s)} 확인`;
  return (
    <Sec title="상장" testid="nx-listing" note={note} right={tab && <Ext href={tab.href}>상장 전체</Ext>}>
      <div className="twrap">
        <table className="t nx-t">
          <thead><tr><th>거래소</th><th>종목</th><th>종류</th><th>망</th><th>공지</th><th>개장</th><th>헷지</th><th className="n">10분</th><th className="n">30분</th></tr></thead>
          <tbody>
            {L.recent.length === 0 ? <tr><td colSpan={9} className="nx-none">없음</td></tr> : L.recent.map((r, i) => (
              <tr key={i}>
                <td>{vko(r.ex)}</td><td><b>{r.sym}</b></td><td>{r.kind || '—'}</td><td>{r.network || '—'}</td><td>{kstDay(r.notice_ts, now)}</td><td className={ms(r.open_ts) !== null && ms(r.open_ts)! > now ? 'st-ok' : ''}>{kstDay(r.open_ts, now)}</td><td>{r.hedge_perp ?? '모름'}</td>
                <td className={`n${toneOf(r.m10)}`}>{r.m10 === null ? '미측정' : sgn(r.m10)}</td><td className={`n${toneOf(r.m30)}`}>{r.m30 === null ? '미측정' : sgn(r.m30)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

function Flows({ home, now }: { home: NexusHomeData; now: number }) {
  const W = home.flows;
  const tab = home.tabs.find((t) => t.label === '지갑');
  const kStale = W.kol_age_s !== null && W.kol_age_s > STALE.kol;
  const shown = W.feed.slice(0, 8), rest = W.feed.slice(8);
  const row = (w: typeof W.feed[number], i: number) => (
    <tr key={i}>
      <td className="nx-t">{kst(w.t)}</td><td><span className={`nx-badge ${w.kind === 'team' ? 'warn' : w.kind === 'deposit' ? 'info' : ''}`}>{KIND_KO[w.kind] ?? w.kind}</span></td><td className="nx-wrap"><b>{w.who || '—'}</b></td><td>{w.sym}</td>
      <td className="n">{usd(w.usd)}</td><td>{vko(w.venue)}{w.kr === true ? <span className="nx-tag">국내</span> : null}</td><td className="nx-dim">{ageOf(w.t, now)}</td>
    </tr>
  );
  const note = W.ok === false ? '원천 못 읽음' : <>{`12시간 ${W.feed.length}건`}{W.persons24 !== null ? ` · 24h KOL ${W.persons24}명${W.usd24 !== null ? ` ${usd(W.usd24)}` : ''}` : ''}{W.kol_ok === false ? ' · KOL 원천 못 읽음' : ''}{kStale ? <span className="nx-stop"> KOL 멈춤 {secAgo(W.kol_age_s)}</span> : null}</>;
  return (
    <Sec title="지갑 흐름" testid="nx-flows" note={note} right={tab && <Ext href={tab.href}>지갑 전체</Ext>}>
      <div className="twrap">
        <table className="t nx-t">
          <thead><tr><th>시각</th><th>종류</th><th>누가</th><th>종목</th><th className="n">금액</th><th>어디로</th><th></th></tr></thead>
          <tbody>{shown.length === 0 ? <tr><td colSpan={7} className="nx-none">없음 — 12시간 안에 KOL 입금·팀 지갑 알림·거래소 유입 없음</td></tr> : shown.map(row)}</tbody>
        </table>
      </div>
      {rest.length > 0 && (
        <details className="nx-fold"><summary><b>나머지 {rest.length}건</b></summary>
          <div className="twrap"><table className="t nx-t"><tbody>{rest.map(row)}</tbody></table></div>
        </details>
      )}
      <div className="nx-coins">
        {W.coins.length > 0 ? <><span className="nx-dim">물리는 코인 · KOL 24h 국내 입금: </span>{W.coins.map((c) => <span key={c.sym} className="nx-chip"><b>{c.sym}</b> {c.persons ?? '?'}명{c.usd !== null ? ` ${usd(c.usd)}` : ''}</span>)}</> : <span className="nx-dim">물리는 코인 없음</span>}
        {W.deposits_hidden_n !== null && W.deposits_hidden_n > 0 ? <span className="nx-dim"> · 입금 {W.deposits_hidden_n}건 숨김 (&lt; {usd(W.deposits_min_usd ?? 50_000)})</span> : null}
      </div>
    </Sec>
  );
}

function Score({ home }: { home: NexusHomeData }) {
  const S = home.score;
  const more = home.tabs.find((t) => t.label === '더보기');
  const stripKey = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '');
  const vcls = (v: string) => (/된다|돈 됐다/.test(v) ? 'st-ok' : /허수|안 된다|폐기/.test(v) ? 'st-bad' : '');
  return (
    <Sec title="신호 성적표" testid="nx-score" note={S.ok === false ? '못 읽음' : `7일 · 알림 결과 원장 · ${secAgo(S.age_s)} 채점`} right={more && <Ext href={more.href}>성적 전체</Ext>}>
      <div className="twrap">
        <table className="t nx-t">
          <thead><tr><th>신호</th><th className="n">맞음</th><th className="n">채점</th><th className="n">맞음%</th><th className="n">$1k당 중앙</th><th>판정</th><th>정책</th></tr></thead>
          <tbody>
            {S.rows.length === 0 ? <tr><td colSpan={7} className="nx-none">없음</td></tr> : S.rows.map((r, i) => (
              <tr key={i}>
                <td className="nx-wrap"><b>{stripKey(r.name)}</b>{r.sig && <span className="nx-dim nx-mono"> {r.sig}</span>}</td><td className="n">{r.hit ?? '?'}</td><td className="n">{r.scored ?? '?'}</td><td className="n">{r.hit_pct === null ? '—' : `${Math.round(r.hit_pct)}%`}</td>
                <td className={`n${toneOf(r.med_usd_1k)}`}>{usd1k(r.med_usd_1k)}</td><td className={vcls(r.verdict)}>{r.verdict || '—'}</td><td className="nx-dim">{r.policy === 'ledger_only' ? '기록만' : r.policy || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

function Ops({ ops, now }: { ops: NexusOp[]; now: number }) {
  return (
    <Sec title="운영 메모" testid="nx-ops" note={ops.length ? `${ops.length}건 · 여기서는 읽기만` : '읽기만'}>
      {ops.length === 0 ? <Empty text="없음" /> : (
        <ul className="att inner nx-ops">
          {ops.map((o, i) => (
            <li key={i} className={toneCls(o.tone)}>
              <i className={`hub-dot ${toneCls(o.tone) || 'none'}`} />
              <span className="t">{o.cat && <span className="nx-badge">{o.cat}</span>}{o.title}{o.detail && <span className="hint">{o.detail}</span>}{o.href && <span className="hint"><Ext href={o.href}>대시보드에서 보기</Ext></span>}</span>
              <span className="at">{o.ts ? `${kst(o.ts)} · ${relTime(o.ts, now)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Sec>
  );
}

/* ───────── the view ───────── */

export function NexusHome({ home, now }: { home: NexusHomeData; now: number }) {
  return (
    <div className="nx" data-testid="nexus-home">
      <Tabs home={home} now={now} />
      <Market home={home} />
      <Todo home={home} />
      <Band home={home} now={now} />
      <Listing home={home} now={now} />
      <Flows home={home} now={now} />
      <Score home={home} />
      <Ops ops={home.ops} now={now} />
    </div>
  );
}
