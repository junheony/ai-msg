/**
 * 야핑봇 (@cblabx X bot) — phase 3: the owner's work queue, strictly read-only. GET on 127.0.0.1:8095 only
 * (/api/posts, /api/ai_news?days=3, /api/yap, /api/replies?status=…, /api/status, /api/metrics — never /api/news/briefing,
 * never `ext=`), `systemctl --user show` of the service and its two timers, and the tail of its logs for 402 / ERROR
 * counts. Never runs, posts or triggers anything.
 */
import path from 'node:path';
import type { HubAlert, HubKpi, HubLevel, HubMetricValue, HubMode, HubSection, HubSource, HubState, HubStep } from '../../shared/hub-types';
import { DAY_MS, HUB_TIMEOUTS, HUB_URLS, UNIT_STATE_KO, agoFrom, arr, fmtClock, fmtDate, fmtDuration, fmtInt, fmtKst, fmtNum, isObj, kpi, num, objs, page, probe, scrub, sec, showUnit, sortAlerts, str, toIso, type HubDeps, type UnitInfo } from './shared';

export const YAPPING_UNITS = { service: 'yapping-bot.service', timers: [{ timer: 'yapping-free-x.timer', service: 'yapping-free-x.service', label: 'X 무료 수집' }, { timer: 'yapping-tg-agg.timer', service: 'yapping-tg-agg.service', label: 'TG 집계' }] } as const;
export const YAPPING_LOGS = ['logs/yb.log', 'logs/app.out', 'logs/free_x_collector.log'] as const;
export const YAPPING_NEWS_URL = `${HUB_URLS.yappingNews}?days=3`;
export const YAPPING_REPLIES_TODO_URL = `${HUB_URLS.yappingReplies}?status=todo`;
export const YAPPING_REPLIES_DONE_URL = `${HUB_URLS.yappingReplies}?status=done`;
const LOG_TAIL_BYTES = 96 * 1024;
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;
const CREDITS_RE = /\b402\b.*?(credit|depleted|insufficient)|credits? depleted|CreditsDepleted/i;
/** A draft this old is the owner's backlog, not a queue. */
export const DRAFT_OLD_DAYS = 5;
const MAX_ROWS = 60;
const KIND_KO: Record<string, string> = { news: '뉴스', yap: 'yap', ai_news: 'AI 뉴스', ai_news_qt: 'AI 뉴스 QT', lane_post: '레인 포스트', reply: '답글' };
const kindKo = (k: unknown): string => { const s = str(k, 24) ?? '—'; return KIND_KO[s] ?? s; };
const oneLine = (v: unknown, max: number): string => scrub(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
const tweetUrl = (id: unknown): string => (typeof id === 'string' && /^\d+$/.test(id) ? `https://x.com/i/status/${id}` : '—');

export interface LogScan { errors24h: number; last402: { at: string | null; job: string | null; count: number } | null; recentErrors: { at: string | null; text: string }[] }

/** Counts ERROR/Traceback lines in the last 24 h and finds 402 credit exhaustion; lines without a timestamp count as recent. */
export function scanLogs(texts: (string | null)[], nowMs: number): LogScan {
  let errors24h = 0;
  let count402 = 0;
  let last402: { at: string | null; job: string | null } | null = null;
  const recent: { at: string | null; text: string }[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split('\n')) {
      const m = LOG_TS_RE.exec(line);
      const at = m ? toIso(`${m[1]}T${m[2]}+09:00`) : null;
      const fresh = at === null || nowMs - Date.parse(at) <= DAY_MS;
      if (CREDITS_RE.test(line)) {
        count402++;
        if (!last402 || !last402.at || (at && Date.parse(at) >= Date.parse(last402.at))) last402 = { at, job: /job[ =:]+'?([\w-]+)/i.exec(line)?.[1] ?? null };
      }
      if (/\bERROR\b|Traceback \(most recent/.test(line) && fresh) {
        errors24h++;
        const msg = scrub(line.replace(LOG_TS_RE, '').replace(/^[,.\d]*\s*/, '').replace(/^ERROR[: ]*/, '').trim(), 140);
        if (msg && !/^Traceback/.test(msg)) recent.push({ at, text: msg });
      }
    }
  }
  recent.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { errors24h, last402: count402 ? { ...last402!, count: count402 } : null, recentErrors: recent.slice(0, 5) };
}

const bannerLevel = (v: unknown): HubLevel => (v === 'error' || v === 'bad' || v === 'danger' ? 'bad' : v === 'warn' || v === 'warning' ? 'warn' : 'info');

/**
 * Today's rotation as steps: slots whose time has passed are done when the day's post count covers them, else blocked
 * (missed); the next slot is active; later ones todo. `clock` is the Seoul `HH:MM` now; `due` marks the live turn.
 */
export function rotationSteps(plan: { slot: string; kind: string }[], clock: string, postedToday: number, due: boolean): HubStep[] {
  let activeSet = false;
  return plan.slice(0, 12).map((p, i) => {
    const label = `${p.slot} ${kindKo(p.kind)}`;
    if (p.slot <= clock) return postedToday > i ? { label, state: 'done', hint: '게시됨' } : { label, state: 'blocked', hint: '지남 · 게시 없음' };
    if (!activeSet) { activeSet = true; return { label, state: 'active', hint: due ? '지금 차례' : '다음 슬롯' }; }
    return { label, state: 'todo' };
  });
}

export async function collectYapping(deps: HubDeps): Promise<HubMode> {
  const home = path.join(deps.home, 'yapping-bot');
  const [service, ...timerUnits] = await Promise.all([showUnit(deps, YAPPING_UNITS.service), ...YAPPING_UNITS.timers.flatMap((t) => [showUnit(deps, t.timer), showUnit(deps, t.service)])]);
  const [status, metrics_, posts_, news_, yap_, todo_, done_, ...logs] = await Promise.all([
    probe(deps, '/api/status', HUB_URLS.yappingStatus, HUB_TIMEOUTS.default), probe(deps, '/api/metrics', HUB_URLS.yappingMetrics, HUB_TIMEOUTS.default),
    probe(deps, '/api/posts', HUB_URLS.yappingPosts, HUB_TIMEOUTS.default), probe(deps, '/api/ai_news', YAPPING_NEWS_URL, HUB_TIMEOUTS.py), probe(deps, '/api/yap', HUB_URLS.yappingYap, HUB_TIMEOUTS.default),
    probe(deps, '/api/replies todo', YAPPING_REPLIES_TODO_URL, HUB_TIMEOUTS.default), probe(deps, '/api/replies done', YAPPING_REPLIES_DONE_URL, HUB_TIMEOUTS.default),
    ...YAPPING_LOGS.map((f) => deps.readTail(path.join(home, f), LOG_TAIL_BYTES).catch(() => null)),
  ]);
  const now = deps.now();
  const nowIso = new Date(now).toISOString();
  const today = fmtDate(nowIso), clock = fmtClock(nowIso);
  const timers = YAPPING_UNITS.timers.map((t, i) => ({ ...t, u: timerUnits[i * 2] as UnitInfo, svc: timerUnits[i * 2 + 1] as UnitInfo }));
  const svc = service as UnitInfo;
  const st = isObj(status.data) ? status.data : null;
  const me = isObj(metrics_.data) ? metrics_.data : null;
  const po = isObj(posts_.data) ? posts_.data : null;
  const nw = isObj(news_.data) ? news_.data : null;
  const yp = isObj(yap_.data) ? yap_.data : null;
  const todoD = isObj(todo_.data) ? todo_.data : null, doneD = isObj(done_.data) ? done_.data : null;
  const scan = scanLogs(logs, now);
  const sources: HubSource[] = [status.source, metrics_.source, posts_.source, news_.source, yap_.source, todo_.source, done_.source, { name: 'systemd', ok: svc.active !== 'missing', ms: 0, ...(svc.active === 'missing' ? { error: '유닛 없음' } : {}) }, { name: '로그', ok: logs.some((l) => l !== null), ms: 0, ...(logs.every((l) => l === null) ? { error: '파일 없음' } : {}) }];
  const links = [{ label: 'x.com/cblabx', href: 'https://x.com/cblabx' }];
  if (st === null && me === null && po === null && svc.active === 'missing') {
    return { id: 'yapping', name: '야핑봇', state: 'unknown', lastActivity: null, metrics: {}, alerts: [{ level: 'warn', text: '서비스·API·systemd 모두 응답 없음' }], links, sources, page: page('상태 확인 불가', '야핑봇 서비스 가동 여부 확인 (읽기 전용)', [], []) };
  }

  // ── facts: posts / drafts ──
  const serviceUp = svc.active === 'active' || (svc.active === 'missing' && (st !== null || po !== null));
  const xApi = (po && isObj(po.x_api) ? po.x_api : null) ?? (st && isObj(st.x_api) ? st.x_api : null);
  const xEnabled = xApi ? xApi.enabled === true : null;
  const cap = po ? num(po.cap) : null;
  const postedToday = po ? num(po.posted_today) : null;
  const slots = po ? arr(po.slots).filter((s): s is string => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s)) : [];
  const turn = po && isObj(po.turn) ? po.turn : null;
  const nextSlotIso = toIso(turn?.next_slot ?? po?.next_slot);
  const drafts = po ? objs(po.drafts).filter((d) => d.status === 'draft' || d.status === undefined) : [];
  const draftAge = (d: Record<string, unknown>): number | null => { const at = toIso(d.created_at); return at ? now - Date.parse(at) : null; };
  const draftsOldestFirst = [...drafts].sort((a, b) => (toIso(a.created_at) ?? '9').localeCompare(toIso(b.created_at) ?? '9'));
  const oldestDraft = draftsOldestFirst[0] ? toIso(draftsOldestFirst[0].created_at) : null;
  const oldDrafts = drafts.filter((d) => (draftAge(d) ?? 0) > DRAFT_OLD_DAYS * DAY_MS);
  const posted = po ? objs(po.posted).filter((p) => toIso(p.posted_at)).sort((a, b) => Date.parse(toIso(b.posted_at)!) - Date.parse(toIso(a.posted_at)!)) : [];
  const postedTodayList = posted.filter((p) => fmtDate(toIso(p.posted_at)) === today);
  const postedN = postedToday ?? (po ? postedTodayList.length : null);

  // ── facts: AI news / yap / replies ──
  const last = nw && isObj(nw.last) ? nw.last : null;
  const rotation = nw && isObj(nw.rotation) ? nw.rotation : null;
  const plan = rotation ? objs(rotation.plan).map((p) => ({ slot: str(p.slot, 5) ?? '', kind: str(p.kind, 10) ?? '' })).filter((p) => /^\d{2}:\d{2}$/.test(p.slot)) : [];
  const planOrSlots = plan.length ? plan : slots.map((slot) => ({ slot, kind: '—' }));
  const newsItems = nw ? objs(nw.items) : [];
  const newNews = newsItems.filter((i) => i.status === 'new' || i.status === undefined);
  const newsPending = st ? num(st.ai_news_pending) : null;
  const submitLinks = yp ? objs(yp.submit_links) : [];
  const unsubmitted = submitLinks.filter((l) => l.submitted_at === null || l.submitted_at === undefined);
  const campaigns = yp ? objs(yp.campaigns) : [];
  const todoItems = todoD ? objs(todoD.items) : [];
  const todoN = todoD ? todoItems.length : st ? num(st.todo) : null;
  const doneToday = (doneD ? num(doneD.done_today) : null) ?? (st ? num(st.replies_done_today) : null);
  const replies = doneToday;

  // ── facts: service / cost / log (kept from phase 2, collapsed) ──
  const llm = st ? st.llm === true : null;
  const inbox = st && isObj(st.inbox) ? st.inbox : null;
  const costs = st && isObj(st.costs) && isObj(st.costs.today) ? st.costs.today : null;
  const llmUsd = costs ? num(costs.llm_usd) : null, xUsd = costs ? num(costs.x_usd) : null;
  const mePosts = me ? objs(me.posts).slice(0, 50) : [];
  const lastPostAt = [...mePosts.map((p) => toIso(p.created_at)), ...posted.map((p) => toIso(p.posted_at))].filter((x): x is string => x !== null).sort().pop() ?? null;
  const snapshots = me ? objs(me.snapshots).slice(-7) : [];
  const followers = snapshots.length ? num(snapshots[snapshots.length - 1]!.followers) : null;
  const jobs = st ? objs(st.last_jobs).slice(0, 10) : [];
  const lastJobAt = jobs.map((j) => toIso(j.finished)).filter((x): x is string => x !== null).sort().pop() ?? null;
  const timersUp = timers.filter((t) => t.u.active === 'active').length;
  const timersKnown = timers.filter((t) => t.u.active !== 'missing').length;
  const recent402 = scan.last402 && (scan.last402.at === null || now - Date.parse(scan.last402.at) <= DAY_MS);

  // ── steps ──
  const steps = rotationSteps(planOrSlots, clock, postedN ?? 0, turn?.due === true);
  const missed = steps.filter((s) => s.state === 'blocked');
  const nextStep = planOrSlots.find((p) => p.slot > clock) ?? null;

  // ── alerts & state ──
  const alerts: HubAlert[] = [];
  if (svc.active !== 'missing' && !serviceUp) alerts.push({ level: 'bad', text: `서비스 ${UNIT_STATE_KO[svc.active]}${svc.sub ? ` (${svc.sub})` : ''}${svc.since ? ` · ${agoFrom(svc.since, now)}` : ''}` });
  if (llm === false) alerts.push({ level: 'bad', text: 'LLM 백엔드 사용 불가' });
  for (const p of [status, posts_, news_, yap_]) if (!p.source.ok) alerts.push({ level: 'warn', text: `${p.source.name} 응답 없음 · ${p.source.error ?? '오류'}` });
  if (oldDrafts.length) alerts.push({ level: 'warn', text: `초안 ${oldDrafts.length}건 ${DRAFT_OLD_DAYS}일 이상 대기 · 최고 ${fmtKst(oldestDraft)}`, at: oldestDraft, hint: '대기 초안에서 고르거나 버리기' });
  for (const l of unsubmitted.slice(0, 5)) alerts.push({ level: 'warn', text: `${str(l.project, 30) ?? '?'} yap 링크 미제출 · 게시 ${fmtKst(toIso(l.posted_at))}`, at: toIso(l.posted_at), hint: scrub(l.url, 120) });
  for (const s of missed) alerts.push({ level: 'warn', text: `${s.label} 슬롯 지남 · 게시 없음` });
  for (const t of timers) {
    if (t.u.active === 'missing') continue;
    if (t.u.active !== 'active') alerts.push({ level: 'warn', text: `타이머 ${t.label} ${UNIT_STATE_KO[t.u.active]}` });
    if (t.svc.result && t.svc.result !== 'success') alerts.push({ level: 'warn', text: `${t.label} 마지막 실행 ${t.svc.result}${t.svc.exitedAt ? ` · ${fmtKst(t.svc.exitedAt)}` : ''}` });
  }
  if (scan.last402) alerts.push({ level: recent402 ? 'bad' : 'info', text: `X API 402 크레딧 소진 ${scan.last402.count}회 · 마지막 ${scan.last402.at ? fmtKst(scan.last402.at) : '시각 미상'}${scan.last402.job ? ` · ${scan.last402.job}` : ''}` });
  // Log errors as one line: the same failure repeats (ai_news × backends), so group by the message with its numbers cut.
  if (scan.recentErrors.length) {
    const groups = new Map<string, { n: number; at: string | null }>();
    for (const e of scan.recentErrors) {
      const key = e.text.replace(/\s+/g, ' ').replace(/:\s*/g, ': ').replace(/\(char \d+\)|line \d+ column \d+|\d{2,}/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
      const g = groups.get(key); if (g) { g.n += 1; if (!g.at && e.at) g.at = e.at; } else groups.set(key, { n: 1, at: e.at });
    }
    const first = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
    const latest = scan.recentErrors.map((e) => e.at).filter((x): x is string => !!x).sort().at(-1) ?? null;
    alerts.push({ level: 'warn', text: `로그 오류 ${scan.errors24h || scan.recentErrors.length}건 (24h)${latest ? ` · 마지막 ${fmtKst(latest)}` : ''}: ${first[0]![0]}${first[0]![1].n > 1 ? ` ×${first[0]![1].n}` : ''}`, at: latest, ...(first.length > 1 ? { hint: `그 외 ${first.slice(1, 3).map(([k, g]) => `${k.slice(0, 60)}${g.n > 1 ? ` ×${g.n}` : ''}`).join(' / ')}` } : {}) });
  }
  if (st) for (const b of objs(st.banners).slice(0, 5)) { const text = scrub(b.text, 160); if (text) alerts.push({ level: bannerLevel(b.level), text }); }
  if (xEnabled === false && !objs(st?.banners).some((b) => /x_api|X API/i.test(String(b.text)))) alerts.push({ level: 'info', text: 'X API 꺼짐 — 게시는 확장으로 직접' });
  if (nw && nw.running === true) alerts.push({ level: 'info', text: 'AI 뉴스 수집 실행 중' });
  let state: HubState = 'ok';
  if (svc.active !== 'missing' && !serviceUp) state = 'down';
  else if (alerts.some((a) => a.level === 'bad' || a.level === 'warn')) state = 'warn';

  // ── headline / decision / KPIs ──
  const headline = [
    `오늘 ${postedN ?? '—'}/${cap ?? '—'} 게시`,
    `초안 ${drafts.length} 대기${oldestDraft ? `(최고 ${fmtKst(oldestDraft).slice(0, 5)})` : ''}`,
    nw ? `AI 뉴스 신규 ${newNews.length}` : null,
    yp ? `미제출 yap ${unsubmitted.length}` : null,
    xEnabled === null ? null : `X API ${xEnabled ? '켜짐' : '꺼짐'}`,
  ].filter(Boolean).join(' · ');
  const pickFor = (kind: string): number => (kind === 'yap' ? drafts.filter((d) => d.kind === 'yap').length : kind === 'news' ? drafts.filter((d) => typeof d.kind === 'string' && /news/.test(d.kind)).length : drafts.length);
  const decision = recent402 ? '402 크레딧 소진 — X API 크레딧 확인'
    : svc.active !== 'missing' && !serviceUp ? '서비스 정지 — 로그 확인 (여기서 재시작하지 않음)'
    : [
      nextStep ? `${nextStep.slot} 슬롯 ${kindKo(nextStep.kind)} 초안 고르기 (대기 ${pickFor(nextStep.kind)})` : po ? `오늘 슬롯 끝 · 내일 ${slots[0] ?? '첫'} 슬롯 초안 미리 고르기 (대기 ${drafts.length})` : null,
      unsubmitted.length ? `${[...new Set(unsubmitted.map((l) => str(l.project, 30) ?? '?'))].join('·')} yap 링크 제출 ${unsubmitted.length}건` : null,
    ].filter(Boolean).join(' · ') || '조치 없음';
  const kpis: HubKpi[] = [
    kpi('오늘 게시', `${postedN ?? '—'}/${cap ?? '—'}`, { status: missed.length ? 'warn' : postedN !== null && cap !== null && postedN >= cap ? 'ok' : 'info', hint: nextSlotIso ? `다음 ${fmtKst(nextSlotIso)}` : nextStep ? `다음 ${nextStep.slot}` : '' }),
    kpi('대기 초안', String(drafts.length), { status: oldDrafts.length ? 'warn' : 'info', hint: oldestDraft ? `최고 ${fmtAgoDays(now - Date.parse(oldestDraft))} · ${DRAFT_OLD_DAYS}일+ ${oldDrafts.length}건` : '' }),
    kpi('미제출 yap', yp ? String(unsubmitted.length) : '—', { status: unsubmitted.length ? 'warn' : 'ok', hint: yp ? `캠페인 ${campaigns.length}` : '' }),
    kpi('뉴스 수집', last ? `${fmtInt(num(last.gathered) ?? 0)} → ${fmtInt(num(last.candidates) ?? 0)} → ${fmtInt(num(last.made) ?? 0)}` : '—', { status: 'info', hint: last ? `${fmtKst(toIso(last.at))} · 신규 ${newNews.length}${newsPending !== null ? ` · 대기 ${newsPending}` : ''}` : '수집 · 후보 · 생성' }),
    kpi('리플 todo / done', `${todoN ?? '—'} / ${replies ?? '—'}`, { status: 'info', hint: doneD && num(doneD.warn_at) !== null ? `오늘 완료 · 경고선 ${num(doneD.warn_at)}` : '오늘 완료' }),
    kpi('X API', xEnabled === null ? '—' : xEnabled ? '켜짐' : '꺼짐', { status: xEnabled === false ? 'info' : 'ok', hint: xApi ? `${str(xApi.mode, 10) ?? ''}${xApi.halted ? ' · 중단' : ''}${xApi.reads === true ? ' · 읽기' : ''}`.trim() : '' }),
  ];

  // ── sections ──
  const draftRows = draftsOldestFirst.slice(0, MAX_ROWS).map((d) => [fmtKst(toIso(d.created_at)), kindKo(d.kind), arr(d.issues).filter((x): x is string => typeof x === 'string').map((x) => scrub(x, 30)).join(', ') || '—', oneLine(d.text, 120), draftSource(d)]);
  const postedRows = posted.slice(0, 20).map((p) => [fmtKst(toIso(p.posted_at)), kindKo(p.kind), oneLine(p.text, 120), tweetUrl(p.tweet_id)]);
  const yapItems = unsubmitted.slice(0, 20).map((l) => ({ text: `${str(l.project, 30) ?? '?'} · 게시 ${fmtKst(toIso(l.posted_at))} · ${scrub(l.url, 120)}`, level: 'warn' as const, at: toIso(l.posted_at), hint: `@${str(l.handle, 30) ?? '?'} · epoch ${num(l.epoch) ?? '—'} · 초안 #${num(l.draft_id) ?? '—'}` }));
  const submittedRows = submitLinks.filter((l) => !unsubmitted.includes(l)).slice(0, 10).map((l) => ({ text: `${str(l.project, 30) ?? '?'} · 게시 ${fmtKst(toIso(l.posted_at))} · 제출 ${fmtKst(toIso(l.submitted_at))}`, level: 'ok' as const, at: toIso(l.submitted_at) }));
  const byKind = last && isObj(last.by_kind) ? Object.entries(last.by_kind).filter((e): e is [string, number] => typeof e[1] === 'number').map(([k, v]) => `${scrub(k, 16)} ${fmtInt(v)}`).join(' · ') : '—';
  const sched = nw && isObj(nw.schedule) ? nw.schedule : null;
  const newsRows: [string, string][] = last ? [
    ['마지막 실행', `${fmtKst(toIso(last.at))} · ${agoFrom(toIso(last.at), now)} · ${str(last.trigger, 16) ?? '—'}`], ['수집 → 후보 → 생성', `${fmtInt(num(last.gathered) ?? 0)} → ${fmtInt(num(last.candidates) ?? 0)} → ${fmtInt(num(last.made) ?? 0)} (LLM ${fmtInt(num(last.llm_items) ?? 0)}) · ${fmtNum(num(last.secs) ?? 0, 0)}초`],
    ['출처별', byKind], ['신규 / 대기', `${newNews.length} / ${newsPending ?? '—'}`],
    ['일정', sched ? `${arr(sched.hours_kst).filter((h): h is number => typeof h === 'number').map((h) => `${String(h).padStart(2, '0')}:${String(num(sched.minute) ?? 0).padStart(2, '0')}`).join(', ')} KST · ${str(sched.post_style, 10) ?? '—'} · QT 간격 ${num(sched.qt_interval_min) ?? '—'}분` : '—'],
    ['로테이션', rotation ? `뉴스 ${num(rotation.news_today) ?? 0}/${num(rotation.news_target) ?? '—'} · yap ${num(rotation.yap_today) ?? 0}/${num(rotation.yap_target) ?? '—'} · 제안 ${kindKo(rotation.suggest)}` : '—'],
    ['TG 채널', nw && nw.tg_ready === true ? '준비됨' : '꺼짐'],
  ] : [['마지막 실행', news_.source.ok ? '기록 없음' : `응답 없음 · ${news_.source.error ?? '오류'}`]];
  const newsTop = newNews.slice(0, 10).map((i) => [fmtKst(toIso(i.created_at)), scrub(i.company, 20) || '—', oneLine(i.headline, 100), scrub(i.link, 120) || '—']);
  const campRows = campaigns.slice(0, 20).map((c) => [str(c.project, 30) ?? '?', `${num(c.epoch) ?? '—'}`, `${scrub(c.start, 10) || '—'} ~ ${scrub(c.end, 10) || '—'}`, `${num(c.submitted) ?? 0}/${num(c.max_submissions) ?? '—'}`, String(num(c.pending_drafts) ?? 0), num(c.days_left) === null ? '—' : String(num(c.days_left)), str(c.state, 12) ?? '—']);
  const stateRows: [string, string][] = [
    ['리플', `todo ${todoN ?? '—'} · 오늘 완료 ${replies ?? '—'}${doneD && num(doneD.warn_at) !== null ? ` · 경고선 ${num(doneD.warn_at)}` : ''}`],
    ['X API', xApi ? `${xEnabled ? '켜짐' : '꺼짐'} · mode ${str(xApi.mode, 10) ?? '—'} · 읽기 ${xApi.reads === true ? '켬' : '끔'} · 중단 ${xApi.halted ? '예' : '아니오'}` : '—'],
    ['자동 게시', po ? `뉴스 ${po.auto_post === true ? '켬' : '끔'} · yap ${po.yap_autopost === true ? '켬' : '끔'}` : '—'],
    ['yap 초안 생성', yp ? (yp.drafting === true ? '켬' : '끔') : '—'],
    ['간격', po ? `${po.spacing_ok === true ? '충족' : '대기'}${num(po.spacing_wait_min) ? ` · ${num(po.spacing_wait_min)}분` : ''}` : '—'],
    ['캠페인', campaigns.length ? campaigns.map((c) => `${str(c.project, 20) ?? '?'} ${num(c.submitted) ?? 0}/${num(c.max_submissions) ?? '—'}`).join(' · ') : '—'],
  ];
  const opsRows: [string, string][] = [
    ['서비스', svc.active === 'missing' ? (st ? '응답 (유닛 정보 없음)' : '없음') : `${UNIT_STATE_KO[svc.active]}${svc.since ? ` · ${fmtKst(svc.since)}부터` : ''}`],
    ...timers.map((t): [string, string] => [`타이머 ${t.label}`, t.u.active === 'missing' ? '정보 없음' : `${UNIT_STATE_KO[t.u.active]} · 마지막 ${fmtKst(t.u.lastRun)} · 다음 ${t.u.nextRun ? fmtKst(t.u.nextRun) : '—'} · ${t.svc.result ?? '—'}`]),
    ['모드 · 모델', st ? `${str(st.mode, 10) ?? '—'} · ${str(st.model, 30) ?? '—'}` : '—'], ['LLM', llm === null ? '—' : llm ? '사용 가능' : '불가'],
    ['오늘 비용', costs ? `LLM $${fmtNum(llmUsd ?? 0, 2)} · X $${fmtNum(xUsd ?? 0, 2)} · X 읽기 ${num(costs.x_reads) ?? 0}/${num(costs.x_read_budget) ?? 0}` : '—'],
    ['LLM 호출 (오늘)', costs ? objs(costs.llm_purposes).map((p) => `${scrub(p.purpose, 20)} ${num(p.calls) ?? 0}`).join(' · ') || '—' : '—'],
    ['받은편지함', inbox ? `대기 ${num(inbox.pending) ?? 0} · 마지막 ${fmtKst(toIso(inbox.checked_at))}` : '—'],
    ['최근 작업', jobs.length ? jobs.slice(0, 5).map((j) => `${scrub(j.job, 24) || '—'} ${fmtClock(toIso(j.finished))} ${j.ok === 1 || j.ok === true ? '✓' : '✗'}`).join(' · ') : '—'],
    ['팔로워', followers === null ? '—' : `${fmtInt(followers)}${snapshots.length > 1 ? ` (${snapshots.map((s) => fmtInt(num(s.followers) ?? 0)).join(' → ')})` : ''}`],
    ['마지막 포스트', lastPostAt ? `${fmtKst(lastPostAt)} · ${agoFrom(lastPostAt, now)}` : '—'], ['오류 24h', `${scan.errors24h}${scan.last402 ? ` · 402 ${scan.last402.count}회` : ''}`],
  ];
  const sections: HubSection[] = [
    sec.steps('오늘 로테이션', steps, { open: true, note: `${today} ${clock} KST · 게시 ${postedN ?? '—'}/${cap ?? '—'}${turn?.due === true ? ' · 지금 차례' : ''}${nextSlotIso ? ` · 다음 ${fmtKst(nextSlotIso)}` : ''}` }),
    sec.table('대기 초안', ['생성', '종류', '이슈', '텍스트', '출처'], draftRows, { open: true, wrap: [3], note: `${drafts.length}건 · 오래된 것부터${oldDrafts.length ? ` · ${DRAFT_OLD_DAYS}일 이상 ${oldDrafts.length}건` : ''}` }),
    sec.list('미제출 yap 링크', [...yapItems, ...submittedRows], { open: unsubmitted.length > 0, note: yp ? `미제출 ${unsubmitted.length} · 제출 ${submitLinks.length - unsubmitted.length}` : `응답 없음 · ${yap_.source.error ?? '오류'}` }),
    sec.table('최근 게시', ['게시', '종류', '텍스트', '링크'], postedRows, { wrap: [2], note: `${posted.length}건 · 오늘 ${postedTodayList.length}` }),
    sec.kv('AI 뉴스 마지막 수집', newsRows, { open: true }),
    sec.table('신규 AI 뉴스 상위 10', ['수집', '회사', '헤드라인', '링크'], newsTop, { wrap: [2], note: `신규 ${newNews.length} / 3일 ${newsItems.length}` }),
    sec.table('캠페인', ['프로젝트', '에포크', '기간', '제출/최대', '대기 초안', '남은 일', '상태'], campRows, { num: [3, 4, 5] }),
    sec.kv('리플 · 캠페인 · X API', stateRows),
    sec.kv('서비스 · 타이머 · 비용', opsRows, { note: 'systemd --user 읽기 전용 · 실행/트리거 없음' }),
    sec.raw('x.com/cblabx', 'https://x.com/cblabx', { note: '새 탭' }),
  ];

  const lastActivity = [lastPostAt, lastJobAt, inbox ? toIso(inbox.checked_at) : null, last ? toIso(last.at) : null].filter((x): x is string => x !== null).sort().pop() ?? null;
  const metrics: Record<string, HubMetricValue> = { '오늘 게시': postedN === null ? '—' : `${postedN}/${cap ?? '—'}`, '대기 초안': drafts.length, '미제출 yap': yp ? unsubmitted.length : '—' };
  if (replies !== null) metrics['오늘 답글'] = replies;
  if (scan.errors24h) metrics['오류 24h'] = scan.errors24h;
  return { id: 'yapping', name: '야핑봇', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources, tag: st && str(st.mode) ? str(st.mode, 10)!.toUpperCase() : undefined, page: page(headline, decision, kpis, sections) };
}

const fmtAgoDays = (ms: number): string => (ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}일 전` : `${fmtDuration(ms)} 전`);

/** Where a draft came from: the campaign project/handle for yap, the first source label for news. */
function draftSource(d: Record<string, unknown>): string {
  const proj = str(d.project, 30);
  if (proj) return `${proj}${str(d.campaign_id, 30) ? ` · ${str(d.campaign_id, 30)}` : ''}`;
  const srcs = typeof d.sources === 'string' ? (() => { try { return objs(JSON.parse(d.sources as string)); } catch { return []; } })() : objs(d.sources);
  const first = srcs[0];
  if (first) return `${scrub(first.label, 30) || scrub(first.kind, 16) || '—'}${scrub(first.url, 120) ? ` · ${scrub(first.url, 120)}` : ''}`;
  return str(d.news_id, 20) ?? '—';
}
