import type { MiniHubMode, MiniHubState, MiniSeat, MiniSession, MiniStatus } from '../../shared/mini-types';
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
  hubOk: '정상',
  hubWarn: '주의',
  hubDown: '장애',
  hubIdle: '대기',
  hubUnknown: '미확인',
} as const;

const STATE_TEXT: Record<MiniSession['state'], string> = { running: MINI_TEXTS.running, waiting: MINI_TEXTS.waiting, idle: MINI_TEXTS.idle };
const HUB_STATE_TEXT: Record<MiniHubState, string> = { ok: MINI_TEXTS.hubOk, warn: MINI_TEXTS.hubWarn, down: MINI_TEXTS.hubDown, idle: MINI_TEXTS.hubIdle, unknown: MINI_TEXTS.hubUnknown };
const turnFor = (ms: number): string => `${forText(ms)} 째`;

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
  const when = s.state !== 'idle' && s.forMs > 0
    ? `<span data-for="${s.forMs}">${turnFor(s.forMs)}</span>`
    : `<span${s.updatedAgoMs === null ? '' : ` data-ago="${s.updatedAgoMs}"`}>${ago(s.updatedAgoMs)}</span>`;
  return `<article class="card session state-${s.state}">
  <header class="card-head">
    <h3 class="title">${esc(s.title)}</h3>
    <span class="pill ${s.state}">${STATE_TEXT[s.state]}</span>
  </header>
  <p class="meta">${meta || '—'} <span class="when">· ${when}</span></p>
  <div class="big-row">
    <div class="big ${tone}"><span class="num">${pct === null ? '—' : pct}</span><span class="unit">%</span><span class="lbl">${MINI_TEXTS.ctx}</span></div>
    <div class="bar" role="progressbar" aria-label="${MINI_TEXTS.ctx}" aria-valuemin="0" aria-valuemax="100" ${pct === null ? '' : `aria-valuenow="${pct}"`}><i class="${tone}" data-pct="${pct ?? 0}"></i></div>
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
    `<div class="seat-cell ${leftTone(pct)}"><span class="num">${pct === null ? '—' : pct}</span><span class="unit">%</span><span class="lbl">${label} · <span data-reset="${esc(reset ?? '')}">${esc(countdown(reset, now))}</span></span></div>`;
  return `<div class="seat ${esc(seat.status)}">
  <span class="seat-name">${esc(seat.label)}</span>
  ${seat.id === 'gpt' ? cell(MINI_TEXTS.left5h, seat.left5h, seat.resets5h) : ''}
  ${cell(MINI_TEXTS.leftWeek, seat.leftWeek, seat.resetsWeek)}
</div>`;
}

/** Colour alone doesn't say the state: anything but ok reads on the chip, and ok is there for a screen reader. */
function hubChip(m: MiniHubMode): string {
  const state = ` · ${HUB_STATE_TEXT[m.state]}`;
  return `<span class="chip ${hubTone(m.state)}">${esc(m.name)}${m.state === 'ok' ? `<span class="vh">${state}</span>` : state}</span>`;
}

export function renderStatus(s: MiniStatus, now: number): string {
  const sessions = s.sessions.length ? s.sessions.map(sessionCard).join('\n') : `<p class="empty">${MINI_TEXTS.noSessions}</p>`;
  const seats = s.seats.map((seat) => seatRow(seat, now)).join('\n');
  const hub = s.hub;
  const modes = hub ? hub.modes.map(hubChip).join('') : '';
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

const isStale = (fetchedAt: number, now: number): boolean => now - fetchedAt > 60_000;
const headWhen = (fetchedAt: number, now: number): string => `${isStale(fetchedAt, now) ? `${MINI_TEXTS.stale} · ` : ''}${ago(now - fetchedAt)}`;

/** Header line: app name, overall badge, how old the data is. */
export function renderHead(s: MiniStatus | null, fetchedAt: number | null, now: number, error: string | null): string {
  const badge = s ? `<span class="badge ${s.waiting ? 'warn' : s.running ? 'ok' : 'none'}">${s.waiting ? `${s.waiting} ${MINI_TEXTS.waiting}` : `${s.running} ${MINI_TEXTS.running}`}</span>` : '';
  const when = fetchedAt === null ? '' : `<span class="when ${isStale(fetchedAt, now) ? 'warn' : ''}">${headWhen(fetchedAt, now)}</span>`;
  const err = error ? `<span class="err">${esc(error)}</span>` : '';
  return `<h1>${MINI_TEXTS.title}</h1>${badge}${err}${when}<button type="button" class="refresh" aria-label="${MINI_TEXTS.refresh}">↻</button>`;
}

export function renderLogin(): string {
  return `<section class="col main"><p class="empty">${MINI_TEXTS.login}</p><p class="empty"><a href="/">${MINI_TEXTS.loginLink}</a></p></section>`;
}

/**
 * The page's CSP blocks inline style attributes, so bar widths go through CSSOM after painting. `from` holds the widths
 * the replaced bars had: a new bar starts there, or its width transition would never run.
 */
export function applyBars(root: ParentNode, from: readonly string[] = []): void {
  root.querySelectorAll<HTMLElement>('.bar i[data-pct]').forEach((el, i) => {
    const width = `${el.dataset.pct}%`;
    const start = from[i];
    if (start && start !== width) {
      el.style.width = start;
      void el.offsetWidth;
    }
    el.style.width = width;
  });
}

/** Moves only the relative-time texts, for the tick between fetches: nodes, focus and any selection stay put. */
export function updateTimes(head: ParentNode, body: ParentNode, fetchedAt: number | null, now: number): void {
  if (fetchedAt === null) return;
  const elapsed = now - fetchedAt;
  const set = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };
  const when = head.querySelector('.when');
  if (when) {
    set(when, headWhen(fetchedAt, now));
    when.classList.toggle('warn', isStale(fetchedAt, now));
  }
  body.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => set(el, turnFor(Number(el.dataset.for) + elapsed)));
  body.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => set(el, ago(Number(el.dataset.ago) + elapsed)));
  body.querySelectorAll<HTMLElement>('[data-reset]').forEach((el) => set(el, countdown(el.dataset.reset || null, now)));
}
