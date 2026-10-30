import type { MiniHubState, MiniSeat, MiniSession, MiniStatus } from '../../shared/mini-types';
import { ago, countdown, escapeHtml as esc, fmtCost, fmtTokens, forText } from './format';

export const MINI_TEXTS = {
  title: 'MSG',
  running: '실행 중',
  waiting: '승인 대기',
  idle: '대기',
  noSessions: '실행 중인 세션이 없습니다',
  sessions: '세션',
  seats: '사용량',
  hub: '허브',
  refresh: '새로고침',
  login: '로그인이 필요합니다',
  loginLink: 'MSG 열기',
  offline: '서버에 연결할 수 없습니다',
  stale: '오래된 정보',
  left5h: '5시간',
  leftWeek: '주간',
  ctx: '컨텍스트',
  out: '출력',
  cache: '캐시',
  cost: '비용',
  turns: '턴',
} as const;

const STATE_TEXT: Record<MiniSession['state'], string> = { running: MINI_TEXTS.running, waiting: MINI_TEXTS.waiting, idle: MINI_TEXTS.idle };

/** Colour class for a percentage used: ok under 60, warn under 85, danger above. */
export function pctTone(pct: number | null): 'ok' | 'warn' | 'danger' | 'none' {
  if (pct === null) return 'none';
  if (pct >= 85) return 'danger';
  if (pct >= 60) return 'warn';
  return 'ok';
}

/** Remaining-percentage tone: plenty is ok, under 25 warn, under 10 danger. */
export function leftTone(pct: number | null): 'ok' | 'warn' | 'danger' | 'none' {
  if (pct === null) return 'none';
  if (pct < 10) return 'danger';
  if (pct < 25) return 'warn';
  return 'ok';
}

function hubTone(state: MiniHubState): string {
  return state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'down' ? 'danger' : 'none';
}

function sessionCard(s: MiniSession): string {
  const pct = s.contextPct;
  const tone = pctTone(pct);
  const meta = [s.model, s.account].filter((x): x is string => !!x).map(esc).join(' · ');
  // A turn in flight (running, or waiting on a card) shows how long it has been going; otherwise when it last changed.
  const when = s.state !== 'idle' && s.forMs > 0 ? `${forText(s.forMs)} 째` : ago(s.updatedAgoMs);
  return `<article class="card session state-${s.state}">
  <header class="card-head">
    <h3 class="title">${esc(s.title)}</h3>
    <span class="pill ${s.state}">${STATE_TEXT[s.state]}</span>
  </header>
  <p class="meta">${meta || '—'} <span class="when">· ${esc(when)}</span></p>
  <div class="big-row">
    <div class="big ${tone}"><span class="num">${pct === null ? '—' : pct}</span><span class="unit">%</span><span class="lbl">${MINI_TEXTS.ctx}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${pct === null ? '' : `aria-valuenow="${pct}"`}><i class="${tone}" style="width:${pct ?? 0}%"></i></div>
  </div>
  <dl class="stats">
    <div><dt>${MINI_TEXTS.out}</dt><dd>${fmtTokens(s.out)}</dd></div>
    <div><dt>${MINI_TEXTS.cache}</dt><dd>${fmtTokens(s.cacheRead)}</dd></div>
    <div><dt>${MINI_TEXTS.cost}</dt><dd>${fmtCost(s.costUsd)}</dd></div>
    <div><dt>${MINI_TEXTS.turns}</dt><dd>${s.turns}</dd></div>
  </dl>
  ${s.lastPrompt ? `<p class="prompt">${esc(s.lastPrompt)}</p>` : ''}
</article>`;
}

function seatRow(seat: MiniSeat, now: number): string {
  const cell = (label: string, pct: number | null, reset: string | null) =>
    `<div class="seat-cell ${leftTone(pct)}"><span class="num">${pct === null ? '—' : pct}</span><span class="unit">%</span><span class="lbl">${label} · ${esc(countdown(reset, now))}</span></div>`;
  return `<div class="seat ${esc(seat.status)}">
  <span class="seat-name">${esc(seat.label)}</span>
  ${cell(MINI_TEXTS.left5h, seat.left5h, seat.resets5h)}
  ${cell(MINI_TEXTS.leftWeek, seat.leftWeek, seat.resetsWeek)}
</div>`;
}

export function renderStatus(s: MiniStatus, now: number): string {
  const sessions = s.sessions.length ? s.sessions.map(sessionCard).join('\n') : `<p class="empty">${MINI_TEXTS.noSessions}</p>`;
  const seats = s.seats.map((seat) => seatRow(seat, now)).join('\n');
  const hub = s.hub;
  const modes = hub ? hub.modes.map((m) => `<span class="chip ${hubTone(m.state)}" title="${esc(m.state)}">${esc(m.name)}</span>`).join('') : '';
  const counts = hub ? Object.entries(hub.counts).filter(([, n]) => n > 0).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') : '';
  const worst = hub ? hub.worst : 'unknown';
  return `<section class="col main">
  <h2>${MINI_TEXTS.sessions} <span class="count">${s.running} ${MINI_TEXTS.running}${s.waiting ? ` · ${s.waiting} ${MINI_TEXTS.waiting}` : ''}</span></h2>
  ${sessions}
</section>
<section class="col side">
  <h2>${MINI_TEXTS.seats}</h2>
  <div class="seats">${seats || '<p class="empty">—</p>'}</div>
  <h2>${MINI_TEXTS.hub} <span class="count ${hubTone(worst)}">${esc(worst)}</span></h2>
  <div class="chips">${modes || '<p class="empty">—</p>'}</div>
  ${counts ? `<p class="meta">${counts}</p>` : ''}
</section>`;
}

/** Header line: app name, overall badge, how old the data is. */
export function renderHead(s: MiniStatus | null, fetchedAt: number | null, now: number, error: string | null): string {
  const badge = s ? `<span class="badge ${s.waiting ? 'warn' : s.running ? 'ok' : 'none'}">${s.waiting ? `${s.waiting} ${MINI_TEXTS.waiting}` : `${s.running} ${MINI_TEXTS.running}`}</span>` : '';
  const stale = fetchedAt !== null && now - fetchedAt > 60_000;
  const when = fetchedAt === null ? '' : `<span class="when ${stale ? 'warn' : ''}">${stale ? `${MINI_TEXTS.stale} · ` : ''}${ago(now - fetchedAt)}</span>`;
  const err = error ? `<span class="err">${esc(error)}</span>` : '';
  return `<h1>${MINI_TEXTS.title}</h1>${badge}${err}${when}<button type="button" class="refresh" aria-label="${MINI_TEXTS.refresh}">↻</button>`;
}

export function renderLogin(): string {
  return `<section class="col main"><p class="empty">${MINI_TEXTS.login}</p><p class="empty"><a href="/">${MINI_TEXTS.loginLink}</a></p></section>`;
}
