/**
 * Studio collectors: 영상 스튜디오 (~/engineering-shorts, read-only files) and 게임 스튜디오 (~/games/neon-apex).
 * Both answer "what stage, what blocks the next step, has anything changed since the last verification".
 */
import path from 'node:path';
import type { HubAlert, HubKpi, HubMetricValue, HubMode, HubSection, HubSource, HubState } from '../../shared/hub-types';
import { DAY_MS, IDLE_DAYS, agoFrom, fmtAgo, fmtDate, fmtKst, fmtNum, isObj, kpi, latestIso, num, page, scrub, sec, sortAlerts, str, toIso, type HubDeps } from './shared';

/* ───────── 영상 스튜디오 ───────── */

interface Episode { id: string; stage: string; reviewedAt: string | null; gates: [string, string][]; approval: boolean | null; blockers: string[] }

const parseJson = (text: string | null): Record<string, unknown> | null => { if (!text) return null; try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; } };

export function parseBacklogNow(md: string | null): { checked: number; total: number; items: { text: string; done: boolean }[] } {
  const items: { text: string; done: boolean }[] = [];
  if (!md) return { checked: 0, total: 0, items };
  const lines = md.split('\n');
  let inNow = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inNow = /^##\s*Now\b/i.test(line); continue; }
    if (!inNow) continue;
    const m = /^\s*-\s*\[([ xX])\]\s*(.+)$/.exec(line);
    if (m) items.push({ text: scrub(m[2]!.trim(), 160), done: m[1] !== ' ' });
  }
  return { checked: items.filter((i) => i.done).length, total: items.length, items };
}

export function parseProjectYaml(text: string | null): { status: string | null; name: string | null; autoPublish: boolean | null; approval: boolean | null } {
  if (!text) return { status: null, name: null, autoPublish: null, approval: null };
  const pick = (re: RegExp): string | null => { const m = re.exec(text); return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  const flag = (re: RegExp): boolean | null => { const v = pick(re); return v === null ? null : /^(true|yes|on)$/i.test(v); };
  return { status: pick(/^\s*status:\s*(.+)$/m), name: pick(/^\s*name:\s*(.+)$/m), autoPublish: flag(/^\s*auto_publish:\s*(\S+)/m), approval: flag(/^\s*human_approval_required:\s*(\S+)/m) };
}

function parseEpisode(id: string, qa: Record<string, unknown> | null): Episode {
  const gates: [string, string][] = [];
  if (qa && isObj(qa.gates)) for (const [k, v] of Object.entries(qa.gates)) {
    if (k === 'human_publish_approval') continue;
    gates.push([k, isObj(v) ? str(v.status, 30) ?? '—' : typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'pass' : 'fail') : '—']);
  }
  const approvalRaw = qa && isObj(qa.gates) ? qa.gates.human_publish_approval : undefined;
  const blockers = qa && Array.isArray(qa.blocking_next_actions) ? qa.blocking_next_actions.filter((x): x is string => typeof x === 'string').map((x) => scrub(x, 200)) : [];
  return { id, stage: (qa && str(qa.stage, 40)) ?? '—', reviewedAt: qa ? toIso(qa.reviewed_at) : null, gates, approval: typeof approvalRaw === 'boolean' ? approvalRaw : null, blockers };
}

const gateLevel = (status: string): 'ok' | 'info' | 'warn' | 'bad' => (/^pass$/i.test(status) ? 'ok' : /pass_for|draft/i.test(status) ? 'info' : /block/i.test(status) ? 'warn' : /fail|error/i.test(status) ? 'bad' : 'info');

export async function collectVideo(deps: HubDeps): Promise<HubMode> {
  const dir = path.join(deps.home, 'engineering-shorts');
  const t0 = deps.now();
  const now = t0;
  const [latest, epNames, projectText, backlogText, renderNames, mtProject, mtBacklog] = await Promise.all([
    deps.latestRender(dir).catch(() => null), deps.listDir(path.join(dir, 'episodes')).catch(() => null), deps.readText(path.join(dir, 'project.yaml')).catch(() => null),
    deps.readText(path.join(dir, 'backlog.md')).catch(() => null), deps.listDir(path.join(dir, 'renders')).catch(() => null),
    deps.fileMtime(path.join(dir, 'project.yaml')).catch(() => null), deps.fileMtime(path.join(dir, 'backlog.md')).catch(() => null),
  ]);
  const epIds = (epNames ?? []).slice(0, 50);
  const epCount = epNames !== null ? epNames.length : await deps.countEntries(path.join(dir, 'episodes')).catch(() => null);
  const episodes = await Promise.all(epIds.map(async (id) => parseEpisode(id, parseJson(await deps.readText(path.join(dir, 'episodes', id, 'qa_report.json')).catch(() => null)))));
  episodes.sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''));
  const qaFiles = (renderNames ?? []).filter((n) => n.endsWith('.qa.json')).slice(0, 10);
  const renderQa = (await Promise.all(qaFiles.map(async (n) => ({ name: n, qa: parseJson(await deps.readText(path.join(dir, 'renders', n)).catch(() => null)) })))).filter((r) => r.qa);
  const project = parseProjectYaml(projectText);
  const backlog = parseBacklogNow(backlogText);

  const any = latest !== null || epCount !== null || projectText !== null || backlogText !== null;
  const source: HubSource = { name: 'engineering-shorts', ok: any, ms: deps.now() - t0, ...(any ? {} : { error: '폴더 없음' }) };
  const metrics: Record<string, HubMetricValue> = {};
  if (epCount !== null) metrics['에피소드'] = epCount;
  const lastActivity = latestIso(latest ? new Date(latest.mtimeMs).toISOString() : null, mtProject ? new Date(mtProject).toISOString() : null, mtBacklog ? new Date(mtBacklog).toISOString() : null, ...episodes.map((e) => e.reviewedAt));
  if (latest) { metrics['최근 렌더'] = fmtAgo(now - latest.mtimeMs); metrics['파일'] = latest.name; }
  if (project.status) metrics['단계'] = project.status;

  const alerts: HubAlert[] = [];
  let gatePass = 0, gateTotal = 0;
  for (const e of episodes) for (const [g, s] of e.gates) {
    gateTotal++;
    const lv = gateLevel(s);
    if (lv === 'ok' || lv === 'info') gatePass++;
    if (lv === 'bad') alerts.push({ level: 'bad', text: `${e.id} · ${g} 실패` });
    else if (lv === 'warn') alerts.push({ level: 'warn', text: `${e.id} · ${g} 차단 (${s})` });
    else if (lv === 'info') alerts.push({ level: 'info', text: `${e.id} · ${g} ${s}` });
  }
  const r0 = renderQa[0]?.qa ?? null;
  const dur = r0 ? num(r0.duration_s) : null;
  const techPass = r0 ? r0.technical_video_pass === true : null;
  if (r0) {
    const frozen = isObj(r0.frozen_frame_heuristic) ? num(r0.frozen_frame_heuristic.event_count) : null;
    const black = isObj(r0.black_frame_heuristic) ? num(r0.black_frame_heuristic.event_count) : null;
    if (frozen) alerts.push({ level: 'info', text: `렌더 정지 프레임 ${frozen}회${isObj(r0.frozen_frame_heuristic) && num(r0.frozen_frame_heuristic.total_duration_s) !== null ? ` · ${fmtNum(num(r0.frozen_frame_heuristic.total_duration_s)!, 1)}s` : ''}` });
    if (black) alerts.push({ level: 'warn', text: `렌더 블랙 프레임 ${black}회` });
    if (techPass === false) alerts.push({ level: 'bad', text: '렌더 기술 검사 실패' });
  }
  const age = lastActivity ? now - Date.parse(lastActivity) : null;
  if (age !== null && age > IDLE_DAYS * DAY_MS) alerts.push({ level: 'info', text: `${fmtAgo(age)} 변경 없음` });
  const worst = alerts.some((a) => a.level === 'bad') ? 'bad' : alerts.some((a) => a.level === 'warn') ? 'warn' : null;
  const state: HubState = !any ? 'unknown' : worst ? 'warn' : age !== null && age > IDLE_DAYS * DAY_MS ? 'idle' : lastActivity ? 'ok' : 'unknown';

  const ep0 = episodes[0];
  const headline = any
    ? `${project.status ?? '단계 미상'} · 에피소드 ${epCount ?? epIds.length}개${ep0 ? ` · 최근 '${ep0.id}' ${ep0.stage}` : ''} · 게이트 ${gatePass}/${gateTotal}`
    : '프로젝트 폴더 없음';
  const nextBlocker = ep0?.blockers[0] ?? backlog.items.find((i) => !i.done)?.text ?? null;
  const decision = nextBlocker ? `다음 블로커: ${nextBlocker}` : any ? '블로커 없음 — 조치 없음' : '폴더 경로 확인';
  const kpis: HubKpi[] = [
    kpi('진행 단계', project.status ?? '—', { status: 'info' }),
    kpi('에피소드', String(epCount ?? epIds.length), { hint: `게이트 통과 ${gatePass}/${gateTotal}`, status: gateTotal > 0 && gatePass === gateTotal ? 'ok' : gateTotal > 0 ? 'warn' : 'info' }),
    kpi('Now 체크', `${backlog.checked}/${backlog.total}`, { status: 'info' }),
    kpi('최근 렌더', latest ? fmtAgo(now - latest.mtimeMs) : '—', { ...(latest ? { hint: latest.name } : {}), status: latest && now - latest.mtimeMs > IDLE_DAYS * DAY_MS ? 'warn' : 'ok' }),
    kpi('렌더 길이', dur === null ? '—' : `${fmtNum(dur, 0)}s`, { ...(r0 ? { hint: `기술 검사 ${techPass ? '통과' : '실패'}`, status: techPass ? 'ok' : 'bad' } : {}) }),
    kpi('자동 게시', project.autoPublish === null ? '—' : project.autoPublish ? '켬' : '끔', { ...(project.approval !== null ? { hint: project.approval ? '사람 승인 필요' : '승인 불필요' } : {}), status: project.autoPublish ? 'warn' : 'ok' }),
  ];
  const sections: HubSection[] = [
    sec.table('에피소드', ['에피소드', '단계', '게이트', '검토'], episodes.map((e) => [e.id, e.stage, e.gates.length ? e.gates.map(([g, s]) => `${g.replace(/_gate$/, '')}: ${s}`).join(' · ') : '—', fmtKst(e.reviewedAt)]), { open: true, note: `게시 승인 ${ep0?.approval === true ? '완료' : '대기'}` }),
    sec.list('백로그 Now', backlog.items.map((i) => ({ text: i.text, level: i.done ? 'ok' as const : 'info' as const })), { open: true, note: `${backlog.checked}/${backlog.total} 완료` }),
    sec.kv('렌더 QA', r0 ? [
      ['파일', renderQa[0]!.name], ['해상도', `${num(r0.width) ?? '?'}×${num(r0.height) ?? '?'} @ ${num(r0.fps) ?? '?'}fps`], ['길이', dur === null ? '—' : `${fmtNum(dur, 1)}s`], ['기술 검사', techPass ? '통과' : '실패'],
      ['오디오', r0.has_audible_audio === true ? '있음' : '없음'], ['오디오 게이트', scrub(r0.audio_gate, 60) || '—'], ['게시 게이트', scrub(r0.publish_gate, 60) || '—'], ['QA', r0.qa_pass === true ? '통과' : '실패'],
    ] : [['상태', 'QA 파일 없음']]),
    sec.kv('프로젝트', [['이름', project.name ?? '—'], ['상태', project.status ?? '—'], ['자동 게시', project.autoPublish === null ? '—' : project.autoPublish ? '켬' : '끔'], ['사람 승인 필요', project.approval === null ? '—' : project.approval ? '예' : '아니오'], ['마지막 변경', agoFrom(lastActivity, now)]]),
  ];
  if (ep0 && ep0.blockers.length) sections.splice(1, 0, sec.list('블로커 (QA 보고서)', ep0.blockers.map((b) => ({ text: b, level: 'warn' as const })), { open: true }));
  return { id: 'video', name: '영상 스튜디오', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: [], sources: [source], page: page(headline, decision, kpis, sections) };
}

/* ───────── 게임 스튜디오 ───────── */

const VERCEL_RE = /https:\/\/[a-z0-9-]+\.vercel\.app\b/i;

export async function collectGame(deps: HubDeps): Promise<HubMode> {
  const dir = path.join(deps.home, 'games', 'neon-apex');
  const t0 = deps.now();
  const now = t0;
  const commit = toIso(await deps.gitLastCommit(dir).catch(() => null));
  const metrics: Record<string, HubMetricValue> = {};
  let lastActivity = commit;
  let sourceName = 'git log';
  if (!lastActivity) {
    sourceName = 'file mtime';
    const times = await Promise.all(['DEPLOYMENT.md', 'README.md', 'package.json'].map((f) => deps.fileMtime(path.join(dir, f)).catch(() => null)));
    const best = Math.max(...times.map((t) => t ?? 0));
    if (best > 0) lastActivity = new Date(best).toISOString();
  }
  const [texts, pkgText, manifestText] = await Promise.all([
    Promise.all(['DEPLOYMENT.md', 'README.md', 'vercel.json', 'production/vercel.json'].map((f) => deps.readText(path.join(dir, f)).catch(() => null))),
    deps.readText(path.join(dir, 'package.json')).catch(() => null), deps.readText(path.join(dir, 'tests', 'v3-release-manifest.json')).catch(() => null),
  ]);
  let url: string | null = null;
  let verified: string | null = null;
  let tests: number | null = null;
  for (const t of texts) {
    if (!t) continue;
    url ??= VERCEL_RE.exec(t)?.[0] ?? null;
    verified ??= toIso(/Verified at:\s*([0-9T:.+-]+)/.exec(t)?.[1] ?? null);
    tests ??= (() => { const m = /(\d+)\s+(?:Node\s+)?[\w/ ]*tests?:?\s*PASS/i.exec(t); return m ? Number(m[1]) : null; })();
  }
  const pkg = parseJson(pkgText);
  const version = pkg ? str(pkg.version, 20) : null;
  const manifest = parseJson(manifestText);
  verified ??= manifest ? toIso(manifest.verified_at) : null;
  const files = manifest && isObj(manifest.files) ? Object.entries(manifest.files).filter((e): e is [string, string] => typeof e[1] === 'string').slice(0, 100) : [];
  const verifiedMs = verified ? Date.parse(verified) : null;
  const mtimes = await Promise.all(files.map(async ([f]) => [f, await deps.fileMtime(path.join(dir, f)).catch(() => null)] as const));
  const changed = verifiedMs === null ? [] : mtimes.filter(([, mt]) => mt !== null && mt > verifiedMs + 1000);
  for (const [, mt] of mtimes) if (mt !== null) lastActivity = latestIso(lastActivity, new Date(mt).toISOString());
  const ok = lastActivity !== null || url !== null;
  const source: HubSource = { name: sourceName, ok, ms: deps.now() - t0, ...(ok ? {} : { error: '폴더 없음' }) };
  const age = lastActivity ? now - Date.parse(lastActivity) : null;
  if (age !== null) metrics[commit ? '마지막 커밋' : '마지막 변경'] = fmtAgo(age);
  if (verified) metrics['배포 검증'] = verified.slice(0, 10);
  metrics['배포'] = url ? 'Vercel' : '없음';
  if (version) metrics['버전'] = `v${version}`;
  const alerts: HubAlert[] = [];
  if (changed.length) alerts.push({ level: 'warn', text: `검증 후 소스 ${changed.length}개 변경 — 재검증 필요` });
  if (age !== null && age > IDLE_DAYS * DAY_MS) alerts.push({ level: 'info', text: `${fmtAgo(age)} 변경 없음` });
  if (ok && !url) alerts.push({ level: 'info', text: '배포 URL 미확인' });
  const state: HubState = age === null ? 'unknown' : changed.length ? 'warn' : age > IDLE_DAYS * DAY_MS ? 'idle' : 'ok';

  const headline = ok ? `${version ? `v${version}` : '버전 미상'} ${url ? '배포됨' : '배포 미확인'} · 검증 ${verified ? fmtDate(verified) : '없음'}${tests !== null ? ` · 테스트 ${tests} PASS` : ''}` : '프로젝트 폴더 없음';
  const decision = !ok ? '폴더 경로 확인' : changed.length ? `검증 후 소스 ${changed.length}개 변경 — 재검증 필요` : verified ? '소스 변경 없음 — 재검증 불필요' : '검증 기록 없음 — 배포 검증 필요';
  const host = url ? url.replace(/^https?:\/\//, '') : null;
  const kpis: HubKpi[] = [
    kpi('버전', version ? `v${version}` : '—', { status: 'info' }),
    kpi('배포 검증', verified ? fmtDate(verified) : '—', { status: verified ? 'ok' : 'warn', ...(verified ? { hint: agoFrom(verified, now) } : {}) }),
    kpi('테스트 통과', tests === null ? '—' : String(tests), { status: tests === null ? 'info' : 'ok' }),
    kpi('검증 후 변경', String(changed.length), { status: changed.length ? 'warn' : 'ok', hint: `매니페스트 ${files.length}개 파일` }),
    kpi('최근 변경', age === null ? '—' : fmtAgo(age), { status: age !== null && age > IDLE_DAYS * DAY_MS ? 'info' : 'ok' }),
    kpi('배포', url ? 'Vercel' : '없음', { status: url ? 'ok' : 'warn', ...(host ? { hint: host } : {}) }),
  ];
  const sections: HubSection[] = [
    sec.list('검증 후 변경 파일', changed.map(([f, mt]) => ({ text: f, level: 'warn' as const, hint: fmtKst(new Date(mt!).toISOString()) })), { open: changed.length > 0, note: changed.length ? `${changed.length}개` : '없음' }),
    sec.table('매니페스트 체크섬', ['파일', '체크섬', '검증 후 변경'], files.map(([f, sha]) => [f, sha.slice(0, 12), changed.some(([c]) => c === f) ? '예' : '아니오']), { note: verified ? `검증 ${fmtKst(verified)}` : '검증 기록 없음' }),
  ];
  if (url) sections.push(sec.raw('배포 사이트', url, { note: `${host} (새 탭)` }));
  return { id: 'game', name: '게임 스튜디오', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: url ? [{ label: 'Vercel', href: url }] : [], sources: [source], page: page(headline, decision, kpis, sections) };
}
