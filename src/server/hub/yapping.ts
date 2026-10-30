/**
 * 야핑봇 (@cblabx X reply bot) — strictly read-only: systemd introspection of the service and its two timers, two GET
 * endpoints on 127.0.0.1:8095, and the tail of its logs for 402 (credits depleted) / ERROR counts. Never runs or
 * triggers anything.
 */
import path from 'node:path';
import type { HubAlert, HubKpi, HubLevel, HubMetricValue, HubMode, HubSection, HubSource, HubState } from '../../shared/hub-types';
import { DAY_MS, HUB_TIMEOUTS, HUB_URLS, UNIT_STATE_KO, agoFrom, fmtClock, fmtDuration, fmtInt, fmtKst, fmtNum, isObj, kpi, num, objs, page, probe, scrub, sec, showUnit, sortAlerts, str, toIso, type HubDeps, type UnitInfo } from './shared';

export const YAPPING_UNITS = { service: 'yapping-bot.service', timers: [{ timer: 'yapping-free-x.timer', service: 'yapping-free-x.service', label: 'X 무료 수집' }, { timer: 'yapping-tg-agg.timer', service: 'yapping-tg-agg.service', label: 'TG 집계' }] } as const;
export const YAPPING_LOGS = ['logs/yb.log', 'logs/app.out', 'logs/free_x_collector.log'] as const;
const LOG_TAIL_BYTES = 96 * 1024;
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;
const CREDITS_RE = /\b402\b.*?(credit|depleted|insufficient)|credits? depleted|CreditsDepleted/i;

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

export async function collectYapping(deps: HubDeps): Promise<HubMode> {
  const home = path.join(deps.home, 'yapping-bot');
  const [service, ...timerUnits] = await Promise.all([showUnit(deps, YAPPING_UNITS.service), ...YAPPING_UNITS.timers.flatMap((t) => [showUnit(deps, t.timer), showUnit(deps, t.service)])]);
  const [status, metrics_, ...logs] = await Promise.all([
    probe(deps, '/api/status', HUB_URLS.yappingStatus, HUB_TIMEOUTS.default), probe(deps, '/api/metrics', HUB_URLS.yappingMetrics, HUB_TIMEOUTS.default),
    ...YAPPING_LOGS.map((f) => deps.readTail(path.join(home, f), LOG_TAIL_BYTES).catch(() => null)),
  ]);
  const now = deps.now();
  const timers = YAPPING_UNITS.timers.map((t, i) => ({ ...t, u: timerUnits[i * 2] as UnitInfo, svc: timerUnits[i * 2 + 1] as UnitInfo }));
  const svc = service as UnitInfo;
  const st = isObj(status.data) ? status.data : null;
  const me = isObj(metrics_.data) ? metrics_.data : null;
  const scan = scanLogs(logs, now);
  const sources: HubSource[] = [status.source, metrics_.source, { name: 'systemd', ok: svc.active !== 'missing', ms: 0, ...(svc.active === 'missing' ? { error: '유닛 없음' } : {}) }, { name: '로그', ok: logs.some((l) => l !== null), ms: 0, ...(logs.every((l) => l === null) ? { error: '파일 없음' } : {}) }];
  const haveAny = st !== null || me !== null || svc.active !== 'missing';
  const links = [{ label: 'x.com/cblabx', href: 'https://x.com/cblabx' }];
  if (!haveAny) {
    return { id: 'yapping', name: '야핑봇', state: 'unknown', lastActivity: null, metrics: {}, alerts: [{ level: 'warn', text: '서비스·API·systemd 모두 응답 없음' }], links, sources, page: page('상태 확인 불가', '야핑봇 서비스 가동 여부 확인 (읽기 전용)', [], []) };
  }
  // ── facts ──
  const serviceUp = svc.active === 'active' || (svc.active === 'missing' && st !== null);
  const llm = st ? st.llm === true : null;
  const xApi = st && isObj(st.x_api) ? st.x_api : null;
  const xEnabled = xApi ? xApi.enabled === true : null;
  const replies = st ? num(st.replies_done_today) : me ? num(me.replies_done_today) : null;
  const todo = st ? num(st.todo) : null;
  const newsPending = st ? num(st.ai_news_pending) : null;
  const inbox = st && isObj(st.inbox) ? st.inbox : null;
  const pending = inbox ? num(inbox.pending) : null;
  const costs = st && isObj(st.costs) && isObj(st.costs.today) ? st.costs.today : null;
  const llmUsd = costs ? num(costs.llm_usd) : null, xUsd = costs ? num(costs.x_usd) : null;
  const posts = me ? objs(me.posts).slice(0, 50) : [];
  const postTimes = posts.map((p) => ({ at: toIso(p.created_at), reply: p.is_reply === true }));
  const lastPost = postTimes.filter((p) => p.at).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0] ?? null;
  const lastReply = postTimes.filter((p) => p.at && p.reply).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0] ?? null;
  const snapshots = me ? objs(me.snapshots).slice(-7) : [];
  const followers = snapshots.length ? num(snapshots[snapshots.length - 1]!.followers) : null;
  const jobs = st ? objs(st.last_jobs).slice(0, 10) : [];
  const lastJobAt = jobs.map((j) => toIso(j.finished)).filter((x): x is string => x !== null).sort().pop() ?? null;
  const nextTimer = timers.map((t) => ({ t, at: t.svc.active === 'active' || t.svc.active === 'activating' ? null : t.u.nextRun, running: t.svc.active === 'active' || t.svc.active === 'activating' })).sort((a, b) => (a.running ? -1 : b.running ? 1 : (a.at ?? 'z').localeCompare(b.at ?? 'z')))[0] ?? null;
  const timersUp = timers.filter((t) => t.u.active === 'active').length;
  const timersKnown = timers.filter((t) => t.u.active !== 'missing').length;
  const recent402 = scan.last402 && (scan.last402.at === null || now - Date.parse(scan.last402.at) <= DAY_MS);

  // ── alerts & state ──
  const alerts: HubAlert[] = [];
  if (svc.active !== 'missing' && !serviceUp) alerts.push({ level: 'bad', text: `서비스 ${UNIT_STATE_KO[svc.active]}${svc.sub ? ` (${svc.sub})` : ''}${svc.since ? ` · ${agoFrom(svc.since, now)}` : ''}` });
  else if (svc.active === 'missing' && st === null) alerts.push({ level: 'warn', text: 'systemd 유닛 없음 · API 응답 없음' });
  if (st === null && status.source.error) alerts.push({ level: 'warn', text: `/api/status 응답 없음 · ${status.source.error}` });
  if (llm === false) alerts.push({ level: 'bad', text: 'LLM 백엔드 사용 불가' });
  for (const t of timers) {
    if (t.u.active === 'missing') continue;
    if (t.u.active !== 'active') alerts.push({ level: 'warn', text: `타이머 ${t.label} ${UNIT_STATE_KO[t.u.active]}` });
    if (t.svc.result && t.svc.result !== 'success') alerts.push({ level: 'warn', text: `${t.label} 마지막 실행 ${t.svc.result}${t.svc.exitedAt ? ` · ${fmtKst(t.svc.exitedAt)}` : ''}` });
    if (t.svc.active === 'failed') alerts.push({ level: 'warn', text: `${t.label} 서비스 failed` });
  }
  if (scan.last402) alerts.push({ level: recent402 ? 'bad' : 'info', text: `X API 402 크레딧 소진 ${scan.last402.count}회 · 마지막 ${scan.last402.at ? fmtKst(scan.last402.at) : '시각 미상'}${scan.last402.job ? ` · ${scan.last402.job}` : ''}` });
  for (const e of scan.recentErrors.slice(0, 3)) alerts.push({ level: 'warn', text: `로그 오류: ${e.text}`, at: e.at });
  if (st) for (const b of objs(st.banners).slice(0, 5)) { const text = scrub(b.text, 160); if (text) alerts.push({ level: bannerLevel(b.level), text }); }
  if (xEnabled === false && !objs(st?.banners).some((b) => /x_api|X API/i.test(String(b.text)))) alerts.push({ level: 'info', text: 'X API 꺼짐 — 수동 포스팅 모드' });
  if (pending !== null && pending > 0) alerts.push({ level: 'info', text: `받은편지함 대기 ${pending}` });
  let state: HubState = 'ok';
  if (svc.active !== 'missing' && !serviceUp) state = 'down';
  else if (timers.some((t) => t.u.active !== 'missing' && t.u.active !== 'active') || llm === false || recent402 || scan.errors24h > 0) state = 'warn';
  else if (svc.active === 'missing' && st === null) state = 'unknown';

  const lastActivity = [lastPost?.at ?? null, lastJobAt, inbox ? toIso(inbox.checked_at) : null].filter((x): x is string => x !== null).sort().pop() ?? null;
  const metrics: Record<string, HubMetricValue> = { '서비스': svc.active === 'missing' ? (st ? '응답' : '없음') : UNIT_STATE_KO[svc.active] };
  if (replies !== null) metrics['오늘 답글'] = replies;
  if (lastPost?.at) metrics['마지막 포스트'] = agoFrom(lastPost.at, now);
  if (scan.errors24h) metrics['오류 24h'] = scan.errors24h;

  // ── page ──
  const headline = `서비스 ${serviceUp ? `가동${svc.since ? ` (${fmtDuration(now - Date.parse(svc.since))})` : ''}` : svc.active === 'missing' ? '상태 미상' : UNIT_STATE_KO[svc.active]} · 답글 오늘 ${replies ?? '—'} · 마지막 포스트 ${lastPost?.at ? agoFrom(lastPost.at, now) : '—'} · 타이머 ${timersUp}/${timersKnown}`;
  const nextText = nextTimer ? (nextTimer.running ? `${nextTimer.t.label} 실행 중` : nextTimer.at ? `${fmtClock(nextTimer.at)} ${nextTimer.t.label}` : '—') : '—';
  const decision = recent402 ? '402 크레딧 소진 — X API 크레딧 확인' : svc.active !== 'missing' && !serviceUp ? '서비스 정지 — 로그 확인 (여기서 재시작하지 않음)' : llm === false ? 'LLM 불가 — 백엔드 확인' : `다음 수집 ${nextText} · 할 일 ${todo ?? '—'} · AI 뉴스 대기 ${newsPending ?? '—'}`;
  const kpis: HubKpi[] = [
    kpi('서비스', serviceUp ? '가동' : svc.active === 'missing' ? '미상' : UNIT_STATE_KO[svc.active], { status: serviceUp ? 'ok' : 'bad', ...(svc.since ? { hint: `${fmtKst(svc.since)}부터` } : st && str(st.mode) ? { hint: `mode ${str(st.mode, 10)}` } : {}) }),
    kpi('오늘 답글', replies === null ? '—' : String(replies), { status: 'info', ...(me && num(me.replies_done_7d) !== null ? { hint: `7일 ${fmtInt(num(me.replies_done_7d)!)}` } : {}) }),
    kpi('마지막 포스트', lastPost?.at ? agoFrom(lastPost.at, now) : '—', { ...(lastReply?.at ? { hint: `답글 ${agoFrom(lastReply.at, now)}` } : {}), status: lastPost?.at && now - Date.parse(lastPost.at) > DAY_MS ? 'warn' : 'ok' }),
    kpi('다음 타이머', nextText, { status: timersKnown && timersUp < timersKnown ? 'warn' : 'ok', hint: `타이머 ${timersUp}/${timersKnown}` }),
    kpi('오늘 비용', costs ? `LLM $${fmtNum(llmUsd ?? 0, 2)} · X $${fmtNum(xUsd ?? 0, 2)}` : '—', { status: 'info', ...(st && str(st.model) ? { hint: str(st.model, 30)! } : {}) }),
    kpi('오류 24h', String(scan.errors24h + (recent402 ? scan.last402!.count : 0)), { status: recent402 ? 'bad' : scan.errors24h ? 'warn' : 'ok', hint: scan.last402 ? `402 ${scan.last402.count}회` : 'ERROR + 402' }),
  ];
  const sections: HubSection[] = [
    sec.table('타이머', ['타이머', '상태', '마지막 실행', '다음 실행', '결과'], timers.map((t) => [t.label, t.u.active === 'missing' ? '정보 없음' : UNIT_STATE_KO[t.u.active], t.u.lastRun ? `${fmtKst(t.u.lastRun)} · ${agoFrom(t.u.lastRun, now)}` : '—', t.svc.active === 'active' || t.svc.active === 'activating' ? '실행 중' : t.u.nextRun ? fmtKst(t.u.nextRun) : '—', t.svc.result ?? '—']), { open: true, note: 'systemd --user 읽기 전용 · 실행/트리거 없음' }),
    sec.table('최근 작업', ['작업', '완료', '결과', '요약'], jobs.map((j) => [scrub(j.job, 30) || '—', fmtKst(toIso(j.finished)), j.ok === 1 || j.ok === true ? '성공' : '실패', scrub(j.summary, 80)]), { open: true }),
    sec.table('최근 포스트', ['시각', '노출', '좋아요', '답글', '본문'], posts.slice(0, 10).map((p) => [fmtKst(toIso(p.created_at)), String(num(p.impressions) ?? '—'), String(num(p.likes) ?? '—'), p.is_reply === true ? '답글' : '포스트', scrub(p.text, 60).replace(/\s+/g, ' ')]), { num: [1, 2], note: me ? `7일 답글 ${num(me.replies_done_7d) ?? '—'} · 최근 10개 노출 중앙 ${num(me.median_impressions_10) ?? '—'}` : '' }),
    sec.bars('팔로워 (일별)', snapshots.map((s) => ({ label: scrub(s.day, 10), value: num(s.followers) ?? 0, text: fmtInt(num(s.followers) ?? 0) })), { note: followers !== null ? `현재 ${fmtInt(followers)}` : '' }),
    sec.kv('비용 · LLM', [
      ['모드', st ? str(st.mode, 10) ?? '—' : '—'], ['모델', st ? str(st.model, 30) ?? '—' : '—'], ['LLM', llm === null ? '—' : llm ? '사용 가능' : '불가'], ['X API', xEnabled === null ? '—' : xEnabled ? '켬' : '끔'],
      ['오늘 LLM 비용', llmUsd === null ? '—' : `$${fmtNum(llmUsd, 2)}`], ['오늘 X 비용', xUsd === null ? '—' : `$${fmtNum(xUsd, 2)}`], ['X 읽기', costs ? `${num(costs.x_reads) ?? 0} / ${num(costs.x_read_budget) ?? 0}` : '—'],
      ['LLM 호출 (오늘)', costs ? objs(costs.llm_purposes).map((p) => `${scrub(p.purpose, 20)} ${num(p.calls) ?? 0}`).join(' · ') || '—' : '—'],
      ['받은편지함', inbox ? `대기 ${pending ?? 0} · 마지막 ${fmtKst(toIso(inbox.checked_at))}` : '—'], ['할 일 / AI 뉴스 대기', `${todo ?? '—'} / ${newsPending ?? '—'}`],
    ]),
    sec.raw('x.com/cblabx', 'https://x.com/cblabx', { note: '새 탭' }),
  ];
  return { id: 'yapping', name: '야핑봇', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources, tag: st && str(st.mode) ? str(st.mode, 10)!.toUpperCase() : undefined, page: page(headline, decision, kpis, sections) };
}
