/**
 * Studio collectors — a WORK environment, not a status template:
 *  · 영상 스튜디오 (~/engineering-shorts): per episode the pipeline (대본 → … → 업로드) with done/active/blocked derived
 *    from the QA report, the gates in Korean with their evidence, the blockers as things the owner must do, the draft
 *    poster / contact sheet / mp4 as thumbnails, and a file-event log of what was produced when.
 *  · 게임 스튜디오 (~/games/*): per game (none is a git repo) the version, verification, deploy and test record from
 *    DEPLOYMENT.md / release manifest / fairness logs, a work history assembled from backups, builds, deploys and
 *    captures, what changed after the last verification, and playable builds / screenshots via the file route.
 * Read-only; every file is optional; absent records say "기록 없음" rather than inventing anything.
 */
import path from 'node:path';
import type { HubAlert, HubCardItem, HubImage, HubKpi, HubLink, HubMetricValue, HubMode, HubSection, HubSource, HubState, HubStep } from '../../shared/hub-types';
import { hubFileUrl } from './files';
import { DAY_MS, IDLE_DAYS, agoFrom, fmtAgo, fmtDate, fmtKst, fmtNum, isObj, kpi, latestIso, num, page, scrub, sec, sortAlerts, str, toIso, type HubDeps } from './shared';

/* ───────── helpers (studio-local; `fmtBytes` and `statBudget` would belong in shared.ts) ───────── */

const parseJson = (text: string | null): Record<string, unknown> | null => { if (!text) return null; try { const v: unknown = JSON.parse(text); return isObj(v) ? v : null; } catch { return null; } };
const msIso = (ms: number | null): string | null => (ms !== null && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const isoMs = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
/** `17.6 MB` / `540 KB` / `934 B`. */
export const fmtBytes = (b: number): string => (b >= 1048576 ? `${fmtNum(b / 1048576, 1)} MB` : b >= 1024 ? `${fmtNum(b / 1024, 0)} KB` : `${fmtNum(b, 0)} B`);

/** `fileMtime` with a global call budget (≤ `max` stats per collection); over budget or on error → null. */
function statBudget(deps: HubDeps, max = 200): (file: string) => Promise<number | null> {
  let n = 0;
  return async (file) => { if (n++ >= max) return null; try { return await deps.fileMtime(file); } catch { return null; } };
}
const readOpt = (deps: HubDeps, file: string): Promise<string | null> => deps.readText(file).catch(() => null);
const listOpt = (deps: HubDeps, dir: string): Promise<string[] | null> => deps.listDir(dir).catch(() => null);

interface FileEvent { at: string; who: string; what: string; hint?: string }
const byNewest = (a: { at: string | null }, b: { at: string | null }): number => (b.at ?? '').localeCompare(a.at ?? '');

/* ═══════════════════════════════ 영상 스튜디오 ═══════════════════════════════ */

export function parseBacklogNow(md: string | null): { checked: number; total: number; items: { text: string; done: boolean }[] } {
  const items: { text: string; done: boolean }[] = [];
  if (!md) return { checked: 0, total: 0, items };
  let inNow = false;
  for (const line of md.split('\n')) {
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

/** Pipeline stages in order; a QA report's `stage` maps onto this ladder (unknown stages fall back to file evidence). */
const STAGE_ORDER = ['idea', 'source_pack', 'script', 'storyboard', 'silent_visual_draft', 'narration', 'final_render', 'review', 'approved', 'published'] as const;
const STAGE_KO: Record<string, string> = { idea: '아이디어', source_pack: '출처 팩', script: '대본', storyboard: '콘티', pilot_storyboard: '파일럿 콘티', silent_visual_draft: '무음 시각 초안', narration: '나레이션', narrated: '나레이션', final_render: '최종 렌더', review: '검수', approved: '승인', published: '게시', uploaded: '게시' };
export const stageKo = (stage: string | null): string => (stage ? STAGE_KO[stage] ?? stage : '기록 없음');
const stageRank = (stage: string | null): number => { if (!stage) return -1; const i = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]); if (i >= 0) return i; if (/draft/.test(stage)) return STAGE_ORDER.indexOf('silent_visual_draft'); if (/storyboard/.test(stage)) return STAGE_ORDER.indexOf('storyboard'); if (/script/.test(stage)) return STAGE_ORDER.indexOf('script'); if (/narrat|tts|voice/.test(stage)) return STAGE_ORDER.indexOf('narration'); if (/final|render/.test(stage)) return STAGE_ORDER.indexOf('final_render'); if (/review|qa/.test(stage)) return STAGE_ORDER.indexOf('review'); if (/approv/.test(stage)) return STAGE_ORDER.indexOf('approved'); if (/publish|upload/.test(stage)) return STAGE_ORDER.indexOf('published'); return -1; };

const GATE_KO: Record<string, string> = { factual_gate: '사실 확인', title_overstatement_gate: '제목 과장', copyright_gate: '저작권', synthetic_media_gate: '합성 표기', technical_video_gate: '기술(영상)', audio_gate: '오디오', human_publish_approval: '사람 승인', loudness_gate: '라우드니스', subtitle_gate: '자막' };
export const gateKo = (key: string): string => GATE_KO[key] ?? key.replace(/_gate$/, '').replace(/_/g, ' ');
type GateLevel = 'ok' | 'info' | 'warn' | 'bad';
/** `pass` → 통과, `pass_for_draft` → 초안 통과, `blocked*` → 차단, `fail*` → 실패; anything else is shown as-is. */
export function gateWord(status: string): { word: string; level: GateLevel } {
  if (/^pass(ed)?$/i.test(status)) return { word: '통과', level: 'ok' };
  if (/pass_for|draft|provisional/i.test(status)) return { word: '초안 통과', level: 'info' };
  if (/block|pending|wait/i.test(status)) return { word: '차단', level: 'warn' };
  if (/fail|error|reject/i.test(status)) return { word: '실패', level: 'bad' };
  if (/skip|n\/a|not_applicable/i.test(status)) return { word: '해당 없음', level: 'info' };
  return { word: status, level: 'info' };
}

/** The five known English `blocking_next_actions` → what the owner must do, in Korean; unknown lines stay as written. */
export function blockerKo(text: string, episodeId: string): string {
  const t = text;
  if (/typecast/i.test(t) && /api key/i.test(t) && /voice/i.test(t)) { const voice = /\(([^)]*)\)/.exec(t)?.[1]; return `Typecast API 키·Voice ID 설정 (.env: TYPECAST_API_KEY, TYPECAST_VOICE_ID)${voice ? ` — ${scrub(voice, 80)}` : ''}`; }
  if (/typecast_tts\.py/i.test(t)) return `나레이션 생성: scripts/typecast_tts.py 실행 (episodes/${episodeId})`;
  if (/re-?render/i.test(t)) return '나레이션(narration.wav)·Typecast 타임스탬프 포함 재렌더';
  if (/loudness|subtitle|editorial/i.test(t)) return '라우드니스·자막 타이밍/넘침·최종 편집 검토';
  if (/human approval|approval before|explicit approval/i.test(t)) return '업로드 전 사람 승인 (자동 게시 금지)';
  return scrub(t, 200);
}

interface Gate { key: string; label: string; status: string; word: string; level: GateLevel; evidence: string }
interface Episode {
  id: string; title: string | null; stage: string | null; reviewedAt: string | null; gates: Gate[]; approval: boolean | null; blockers: { ko: string; en: string }[];
  renders: { name: string; at: string | null }[]; hasDraft: boolean; hasPoster: boolean; hasSheet: boolean; hasNarration: boolean; hasScript: boolean; hasStoryboard: boolean;
  shots: number | null; beats: number | null; targetS: number | null; claims: { total: number; verified: number } | null;
  qa: { durationS: number | null; sizeBytes: number | null; width: number | null; height: number | null; fps: number | null; techPass: boolean | null; black: number | null; frozen: number | null; frozenS: number | null; audible: boolean | null; audioGate: string | null } | null;
  events: FileEvent[]; lastAt: string | null;
}

const EP_FILES: [string, string][] = [['qa_report.json', 'QA 보고서'], ['script.ko.yaml', '대본'], ['storyboard.yaml', '콘티'], ['claim_ledger.yaml', '주장 원장'], ['asset_manifest.yaml', '에셋 매니페스트'], ['source_pack.yaml', '출처 팩']];
const RENDER_WHAT = (name: string): string => (/^draft\.qa\.json$/i.test(name) ? '기계 QA 결과' : /\.qa\.json$/i.test(name) ? '기계 QA 결과' : /poster/i.test(name) ? '포스터 렌더' : /contact/i.test(name) ? '접촉시트 렌더' : /narration|\.wav$|\.mp3$/i.test(name) ? '나레이션 음성' : /\.srt$|\.vtt$/i.test(name) ? '자막 파일' : /draft/i.test(name) ? '무음 초안 렌더' : /\.(mp4|mov|webm)$/i.test(name) ? '영상 렌더' : '렌더 파일');

async function loadEpisode(deps: HubDeps, dir: string, id: string, stat: (f: string) => Promise<number | null>): Promise<Episode> {
  const ep = path.join(dir, 'episodes', id);
  const [qaText, renderNames, scriptText, storyText, claimText, ...epTimes] = await Promise.all([
    readOpt(deps, path.join(ep, 'qa_report.json')), listOpt(deps, path.join(ep, 'renders')), readOpt(deps, path.join(ep, 'script.ko.yaml')), readOpt(deps, path.join(ep, 'storyboard.yaml')), readOpt(deps, path.join(ep, 'claim_ledger.yaml')),
    ...EP_FILES.map(([f]) => stat(path.join(ep, f))),
  ]);
  const qa = parseJson(qaText);
  const renders = (renderNames ?? []).slice(0, 10);
  const renderTimes = await Promise.all(renders.map((n) => stat(path.join(ep, 'renders', n))));
  const draftQa = renders.some((n) => n === 'draft.qa.json') ? parseJson(await readOpt(deps, path.join(ep, 'renders', 'draft.qa.json'))) : null;
  const gates: Gate[] = [];
  let approval: boolean | null = null;
  if (qa && isObj(qa.gates)) for (const [k, v] of Object.entries(qa.gates)) {
    if (k === 'human_publish_approval') { approval = typeof v === 'boolean' ? v : approval; continue; }
    const status = isObj(v) ? str(v.status, 40) ?? '—' : typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'pass' : 'fail') : '—';
    const { word, level } = gateWord(status);
    gates.push({ key: k, label: gateKo(k), status, word, level, evidence: isObj(v) ? scrub(v.evidence ?? v.reason ?? v.note, 240) : '' });
  }
  const stage = qa ? str(qa.stage, 40) : null;
  const blockers = qa && Array.isArray(qa.blocking_next_actions) ? qa.blocking_next_actions.filter((x): x is string => typeof x === 'string').slice(0, 12).map((x) => ({ ko: blockerKo(x, id), en: scrub(x, 200) })) : [];
  const count = (text: string | null, re: RegExp): number | null => (text ? (text.match(re) ?? []).length : null);
  const claimTotal = count(claimText, /^\s*-\s*claim_id:/gm);
  const claimVerified = count(claimText, /^\s*verification:\s*verified\b/gm);
  const events: FileEvent[] = [];
  EP_FILES.forEach(([f, what], i) => { const at = msIso(epTimes[i] ?? null); if (at) events.push({ at, who: id, what: f === 'qa_report.json' ? `QA 보고서 갱신 (${stageKo(stage)})` : `${what} 작성`, hint: f }); });
  renders.forEach((n, i) => { const at = msIso(renderTimes[i] ?? null); if (at) events.push({ at, who: id, what: RENDER_WHAT(n), hint: `renders/${n}` }); });
  events.sort(byNewest);
  const has = (re: RegExp): boolean => renders.some((n) => re.test(n));
  return {
    id, title: scriptText ? scrub(/^\s*title_working:\s*(.+)$/m.exec(scriptText)?.[1]?.trim().replace(/^["']|["']$/g, ''), 120) || null : null, stage, reviewedAt: qa ? toIso(qa.reviewed_at) : null, gates, approval, blockers,
    renders: renders.map((n, i) => ({ name: n, at: msIso(renderTimes[i] ?? null) })), hasDraft: has(/^draft\.(mp4|mov|webm)$/i) || has(/\.(mp4|mov|webm)$/i), hasPoster: has(/^poster\.(png|jpg|jpeg)$/i), hasSheet: has(/contact-?sheet\.(png|jpg|jpeg)$/i), hasNarration: has(/narration|\.wav$|\.mp3$/i),
    hasScript: scriptText !== null || (epTimes[1] ?? null) !== null, hasStoryboard: storyText !== null || (epTimes[2] ?? null) !== null,
    shots: count(storyText, /^\s*-\s*shot_id:/gm), beats: count(scriptText, /^\s*-\s*beat_id:/gm), targetS: scriptText ? num(Number(/^\s*target_duration_s:\s*(\d+)/m.exec(scriptText)?.[1] ?? NaN)) : null,
    claims: claimTotal !== null ? { total: claimTotal, verified: claimVerified ?? 0 } : null,
    qa: draftQa ? { durationS: num(draftQa.duration_s), sizeBytes: num(draftQa.size_bytes), width: num(draftQa.width), height: num(draftQa.height), fps: num(draftQa.fps), techPass: typeof draftQa.technical_video_pass === 'boolean' ? draftQa.technical_video_pass : null, black: isObj(draftQa.black_frame_heuristic) ? num(draftQa.black_frame_heuristic.event_count) : null, frozen: isObj(draftQa.frozen_frame_heuristic) ? num(draftQa.frozen_frame_heuristic.event_count) : null, frozenS: isObj(draftQa.frozen_frame_heuristic) ? num(draftQa.frozen_frame_heuristic.total_duration_s) : null, audible: typeof draftQa.has_audible_audio === 'boolean' ? draftQa.has_audible_audio : null, audioGate: str(draftQa.audio_gate, 60) } : null,
    events, lastAt: events[0]?.at ?? null,
  };
}

/** 대본 → 콘티 → 무음 시각 초안 → 나레이션(TTS) → 최종 렌더 → 검수 → 사람 승인 → 업로드, from the stage, the files and the gates. */
export function episodeSteps(e: Pick<Episode, 'stage' | 'hasScript' | 'hasStoryboard' | 'hasDraft' | 'hasNarration' | 'gates' | 'approval' | 'shots' | 'beats' | 'targetS' | 'qa' | 'reviewedAt'>): HubStep[] {
  const rank = stageRank(e.stage);
  const at = (s: (typeof STAGE_ORDER)[number]): number => STAGE_ORDER.indexOf(s);
  const audio = e.gates.find((g) => g.key === 'audio_gate');
  const failed = e.gates.filter((g) => g.level === 'bad');
  const scriptDone = e.hasScript || rank >= at('script');
  const boardDone = e.hasStoryboard || rank >= at('storyboard');
  const draftDone = e.hasDraft || rank >= at('silent_visual_draft');
  const ttsDone = e.hasNarration || rank >= at('narration');
  const finalDone = rank >= at('final_render');
  const reviewDone = rank >= at('review');
  const approved = e.approval === true || rank >= at('approved');
  const published = rank >= at('published');
  const steps: HubStep[] = [];
  let activeSet = false;
  const push = (label: string, done: boolean, o: { blocked?: string | null; hint?: string } = {}): void => {
    let state: HubStep['state'] = done ? 'done' : 'todo';
    if (!done && o.blocked) state = 'blocked';
    else if (!done && !activeSet) { state = 'active'; }
    if (state === 'active' || state === 'blocked') activeSet = true;
    const hint = o.blocked ?? o.hint;
    steps.push({ label, state, ...(hint ? { hint } : {}) });
  };
  push('대본', scriptDone, { hint: e.beats !== null ? `${e.beats}비트${e.targetS !== null ? ` · 목표 ${e.targetS}초` : ''}` : scriptDone ? 'script.ko.yaml' : '기록 없음' });
  push('콘티', boardDone, { hint: e.shots !== null ? `${e.shots}샷` : boardDone ? 'storyboard.yaml' : '기록 없음' });
  push('무음 시각 초안', draftDone, { hint: e.qa?.durationS !== null && e.qa?.durationS !== undefined ? `${fmtNum(e.qa.durationS, 1)}초${e.qa.sizeBytes !== null ? ` · ${fmtBytes(e.qa.sizeBytes)}` : ''}${e.qa.techPass === true ? ' · 기술 검사 통과' : e.qa.techPass === false ? ' · 기술 검사 실패' : ''}` : draftDone ? 'renders/draft.mp4' : '기록 없음' });
  push('나레이션(TTS)', ttsDone, { blocked: !ttsDone && audio && audio.level !== 'ok' && audio.level !== 'info' ? `오디오 게이트 ${audio.word}${audio.evidence ? ` — ${audio.evidence.slice(0, 120)}` : ''}` : null, hint: ttsDone ? 'narration 있음' : '대기' });
  push('최종 렌더', finalDone, { hint: finalDone ? stageKo(e.stage) : '대기' });
  push('검수', reviewDone, { blocked: !reviewDone && failed.length ? `${failed.map((g) => g.label).join('·')} 실패` : null, hint: e.reviewedAt ? `최근 검토 ${fmtKst(e.reviewedAt)}` : '대기' });
  push('사람 승인', approved, { hint: approved ? '승인' : e.approval === false ? '미승인' : '기록 없음' });
  push('업로드', published, { hint: published ? '게시됨' : '승인 후' });
  return steps;
}

export async function collectVideo(deps: HubDeps): Promise<HubMode> {
  const dir = path.join(deps.home, 'engineering-shorts');
  const t0 = deps.now();
  const now = t0;
  const stat = statBudget(deps, 200);
  const [latest, epNames, projectText, backlogText, mtProject, mtBacklog, mtTts] = await Promise.all([
    deps.latestRender(dir).catch(() => null), listOpt(deps, path.join(dir, 'episodes')), readOpt(deps, path.join(dir, 'project.yaml')), readOpt(deps, path.join(dir, 'backlog.md')),
    stat(path.join(dir, 'project.yaml')), stat(path.join(dir, 'backlog.md')), stat(path.join(dir, 'scripts', 'typecast_tts.py')),
  ]);
  const epIds = (epNames ?? []).slice(0, 50);
  const epCount = epNames !== null ? epNames.length : await deps.countEntries(path.join(dir, 'episodes')).catch(() => null);
  const episodes = await Promise.all(epIds.map((id) => loadEpisode(deps, dir, id, stat)));
  episodes.sort((a, b) => (latestIso(b.reviewedAt, b.lastAt) ?? '').localeCompare(latestIso(a.reviewedAt, a.lastAt) ?? ''));
  const project = parseProjectYaml(projectText);
  const backlog = parseBacklogNow(backlogText);

  const any = latest !== null || epCount !== null || projectText !== null || backlogText !== null;
  const source: HubSource = { name: 'engineering-shorts', ok: any, ms: deps.now() - t0, ...(any ? {} : { error: '폴더 없음' }) };
  const projectEvents: FileEvent[] = [];
  if (mtBacklog) projectEvents.push({ at: msIso(mtBacklog)!, who: '프로젝트', what: `백로그 갱신 (Now ${backlog.checked}/${backlog.total})`, hint: 'backlog.md' });
  if (mtTts) projectEvents.push({ at: msIso(mtTts)!, who: '프로젝트', what: 'Typecast TTS 어댑터 작성', hint: 'scripts/typecast_tts.py' });
  if (mtProject) projectEvents.push({ at: msIso(mtProject)!, who: '프로젝트', what: `프로젝트 설정 (${project.status ?? '단계 미상'})`, hint: 'project.yaml' });
  const lastActivity = latestIso(msIso(latest?.mtimeMs ?? null), ...projectEvents.map((e) => e.at), ...episodes.map((e) => latestIso(e.reviewedAt, e.lastAt)));

  const metrics: Record<string, HubMetricValue> = {};
  if (epCount !== null) metrics['에피소드'] = epCount;
  if (latest) { metrics['최근 렌더'] = fmtAgo(now - latest.mtimeMs); metrics['파일'] = latest.name; }
  const ep0 = episodes[0];
  if (ep0?.stage) metrics['단계'] = stageKo(ep0.stage);
  else if (project.status) metrics['단계'] = stageKo(project.status);

  const alerts: HubAlert[] = [];
  let gatePass = 0, gateTotal = 0, blockedGates = 0;
  for (const e of episodes) for (const g of e.gates) {
    gateTotal++;
    if (g.level === 'ok' || g.level === 'info') gatePass++;
    if (g.level === 'bad') alerts.push({ level: 'bad', text: `${e.id} · ${g.label} 게이트 실패`, hint: g.evidence || undefined });
    else if (g.level === 'warn') { blockedGates++; alerts.push({ level: 'warn', text: `${e.id} · ${g.label} 게이트 차단`, hint: g.evidence || undefined }); }
    else if (g.level === 'info') alerts.push({ level: 'info', text: `${e.id} · ${g.label} ${g.word}` });
  }
  for (const e of episodes) if (e.qa) {
    if (e.qa.frozen) alerts.push({ level: 'info', text: `${e.id} · 정지 프레임 ${e.qa.frozen}회${e.qa.frozenS !== null ? ` · ${fmtNum(e.qa.frozenS, 1)}s` : ''} (도해 정지 구간일 수 있음)` });
    if (e.qa.black) alerts.push({ level: 'warn', text: `${e.id} · 블랙 프레임 ${e.qa.black}회` });
    if (e.qa.techPass === false) alerts.push({ level: 'bad', text: `${e.id} · 렌더 기술 검사 실패` });
  }
  const age = lastActivity ? now - Date.parse(lastActivity) : null;
  if (age !== null && age > IDLE_DAYS * DAY_MS) alerts.push({ level: 'info', text: `${fmtAgo(age)} 변경 없음` });
  const worst = alerts.some((a) => a.level === 'bad') ? 'bad' : alerts.some((a) => a.level === 'warn') ? 'warn' : null;
  const state: HubState = !any ? 'unknown' : worst ? 'warn' : age !== null && age > IDLE_DAYS * DAY_MS ? 'idle' : lastActivity ? 'ok' : 'unknown';

  // Headline / decision: the current episode, its stage, what blocks it and what the owner does next.
  const blockedGate = ep0?.gates.find((g) => g.level === 'warn' || g.level === 'bad') ?? null;
  const firstBlocker = ep0?.blockers[0]?.ko ?? null;
  const nextBacklog = backlog.items.find((i) => !i.done)?.text ?? null;
  const headline = !any ? '프로젝트 폴더 없음'
    : ep0 ? `'${ep0.id}' ${stageKo(ep0.stage)} · 게이트 ${ep0.gates.filter((g) => g.level === 'ok' || g.level === 'info').length}/${ep0.gates.length}${blockedGate ? ` · ${blockedGate.label} 게이트 ${blockedGate.word}${/typecast/i.test(blockedGate.evidence) ? ' — Typecast 키 필요' : ''}` : ep0.approval === false && ep0.gates.length ? ' · 사람 승인 대기' : ''}`
    : `${stageKo(project.status)} · 에피소드 ${epCount ?? 0}개 · QA 기록 없음`;
  const decision = !any ? '폴더 경로 확인'
    : ep0 && ep0.blockers.length ? ep0.blockers.slice(0, 3).map((b) => b.ko.replace(/\s+\(.*$/, '')).join(' → ')
    : ep0 && ep0.approval === false && !blockedGate && ep0.gates.length ? `'${ep0.id}' 검토 후 게시 승인 여부 결정`
    : nextBacklog ? `다음 백로그: ${nextBacklog}` : '블로커 없음 — 조치 없음';

  const kpis: HubKpi[] = [
    kpi('에피소드', String(epCount ?? epIds.length), { hint: ep0 ? `최근 '${ep0.id}'` : '기록 없음', status: 'info' }),
    kpi('단계', ep0 ? stageKo(ep0.stage) : stageKo(project.status), { status: 'info', ...(ep0?.reviewedAt ? { hint: `검토 ${fmtKst(ep0.reviewedAt)}` } : {}) }),
    kpi('게이트 통과', gateTotal ? `${gatePass}/${gateTotal}` : '—', { status: gateTotal === 0 ? 'info' : blockedGates ? 'warn' : gatePass === gateTotal ? 'ok' : 'warn', hint: blockedGate ? `${blockedGate.label} ${blockedGate.word}` : gateTotal ? '차단 없음' : 'QA 기록 없음' }),
    kpi('초안 길이', ep0?.qa?.durationS !== null && ep0?.qa?.durationS !== undefined ? `${fmtNum(ep0.qa.durationS, 1)}s` : '—', { ...(ep0?.qa ? { hint: `${ep0.qa.width ?? '?'}×${ep0.qa.height ?? '?'} @ ${ep0.qa.fps ?? '?'}fps${ep0.qa.audible === false ? ' · 무음' : ''}`, status: ep0.qa.techPass === false ? 'bad' : 'ok' } : { status: 'info' }) }),
    kpi('Now 체크', `${backlog.checked}/${backlog.total}`, { status: 'info', ...(nextBacklog ? { hint: nextBacklog.slice(0, 60) } : {}) }),
    kpi('게시 승인', ep0 ? (ep0.approval === true ? '승인' : ep0.approval === false ? '미승인' : '—') : '—', { status: ep0?.approval === true ? 'ok' : 'info', hint: project.autoPublish === null ? '자동 게시 설정 없음' : project.autoPublish ? '자동 게시 켬' : '자동 게시 끔' }),
  ];

  const cards: HubCardItem[] = episodes.map((e) => {
    const passed = e.gates.filter((g) => g.level === 'ok' || g.level === 'info').length;
    const blk = e.gates.find((g) => g.level === 'warn' || g.level === 'bad') ?? null;
    const links: HubLink[] = [];
    if (e.hasDraft) { const draft = e.renders.find((r) => /^draft\.(mp4|mov|webm)$/i.test(r.name)) ?? e.renders.find((r) => /\.(mp4|mov|webm)$/i.test(r.name)); if (draft) links.push({ label: '초안 영상', href: hubFileUrl('video', `episodes/${e.id}/renders/${draft.name}`) }); }
    if (e.hasPoster) links.push({ label: '포스터', href: hubFileUrl('video', `episodes/${e.id}/renders/poster.png`) });
    return {
      title: e.title ?? e.id, badge: stageKo(e.stage), state: blk ? (blk.level === 'bad' ? 'down' : 'warn') : e.gates.length ? 'ok' : 'unknown',
      sub: e.title ? e.id : e.reviewedAt ? `검토 ${fmtKst(e.reviewedAt)}` : 'QA 기록 없음',
      rows: [
        { label: '검토', value: e.reviewedAt ? `${fmtKst(e.reviewedAt)} · ${agoFrom(e.reviewedAt, now)}` : '기록 없음' },
        { label: '게이트', value: e.gates.length ? `${passed}/${e.gates.length} 통과${blk ? ` · ${blk.label} ${blk.word}` : ''}` : '기록 없음', status: e.gates.length ? (blk ? (blk.level === 'bad' ? 'bad' : 'warn') : 'ok') : 'info' },
        { label: '초안', value: e.qa?.durationS !== null && e.qa?.durationS !== undefined ? `${fmtNum(e.qa.durationS, 1)}초${e.qa.sizeBytes !== null ? ` · ${fmtBytes(e.qa.sizeBytes)}` : ''}${e.qa.audible === false ? ' · 무음' : ''}` : e.hasDraft ? '렌더 있음 (QA 없음)' : '기록 없음', status: e.qa?.techPass === false ? 'bad' : 'info' },
        { label: '대본·콘티', value: `${e.beats !== null ? `${e.beats}비트` : '대본 없음'} · ${e.shots !== null ? `${e.shots}샷` : '콘티 없음'}${e.claims ? ` · 주장 ${e.claims.verified}/${e.claims.total} 검증` : ''}` },
        { label: '승인', value: e.approval === true ? '승인' : e.approval === false ? '미승인' : '기록 없음', status: e.approval === true ? 'ok' : 'info' },
        { label: '다음', value: e.blockers[0]?.ko.replace(/\s+\(.*$/, '') ?? (e.approval === false && !blk && e.gates.length ? '사람 승인' : '기록 없음'), status: e.blockers.length ? 'warn' : 'info' },
      ],
      links, ...(blk ? { note: blk.evidence.slice(0, 160) || `${blk.label} 게이트 ${blk.word}` } : {}),
    };
  });

  const sections: HubSection[] = [sec.cards('에피소드', cards, { open: true, cols: 2, note: `${episodes.length}개 · 게시 승인 ${ep0?.approval === true ? '완료' : '대기'} · 자동 게시 ${project.autoPublish ? '켬' : '끔'}` })];
  if (ep0) {
    sections.push(sec.steps(`파이프라인 · ${ep0.id}`, episodeSteps(ep0), { open: true, note: `QA 단계 ${stageKo(ep0.stage)}${ep0.reviewedAt ? ` · 검토 ${fmtKst(ep0.reviewedAt)}` : ''}` }));
    const images: HubImage[] = [];
    const draft = ep0.renders.find((r) => /^draft\.(mp4|mov|webm)$/i.test(r.name)) ?? ep0.renders.find((r) => /\.(mp4|mov|webm)$/i.test(r.name));
    if (ep0.hasPoster) images.push({ src: hubFileUrl('video', `episodes/${ep0.id}/renders/poster.png`), label: '포스터', href: hubFileUrl('video', `episodes/${ep0.id}/renders/poster.png`), kind: 'image' });
    if (ep0.hasSheet) { const n = ep0.renders.find((r) => /contact-?sheet\.(png|jpg|jpeg)$/i.test(r.name))!.name; images.push({ src: hubFileUrl('video', `episodes/${ep0.id}/renders/${n}`), label: ep0.shots !== null ? `접촉시트 (${ep0.shots}샷)` : '접촉시트', href: hubFileUrl('video', `episodes/${ep0.id}/renders/${n}`), kind: 'image' }); }
    if (draft) images.push({ src: hubFileUrl('video', `episodes/${ep0.id}/renders/${draft.name}`), label: `초안 ${draft.name}${ep0.qa?.durationS !== null && ep0.qa?.durationS !== undefined ? ` · ${fmtNum(ep0.qa.durationS, 1)}초` : ''}${ep0.qa?.sizeBytes ? ` · ${fmtBytes(ep0.qa.sizeBytes)}` : ''}${ep0.qa?.audible === false ? ' · 무음' : ''}`, href: hubFileUrl('video', `episodes/${ep0.id}/renders/${draft.name}`), kind: 'video' });
    sections.push(sec.images('렌더', images.length ? images : [], { open: images.length > 0, note: images.length ? `episodes/${ep0.id}/renders` : '렌더 파일 없음' }));
    sections.push(sec.table('게이트', ['게이트', '판정', '근거'], [
      ...ep0.gates.map((g) => [g.label, g.word, g.evidence || '기록 없음']),
      ['사람 승인', ep0.approval === true ? '승인' : ep0.approval === false ? '미승인' : '기록 없음', ep0.approval === true ? '게시 가능' : project.approval ? '게시 전 사람 승인 필수 (project.yaml)' : '기록 없음'],
    ], { open: true, wrap: [2], note: ep0.gates.length ? `${ep0.gates.filter((g) => g.level === 'ok' || g.level === 'info').length}/${ep0.gates.length} 통과${blockedGates ? ` · 차단 ${blockedGates}` : ''}` : 'QA 보고서 없음' }));
    sections.push(sec.list('블로커 · 다음 할 일', ep0.blockers.length ? ep0.blockers.map((b, i) => ({ text: b.ko, level: i === 0 ? 'warn' as const : 'info' as const, hint: b.en })) : [{ text: '기록 없음', level: 'info' as const }], { open: true, note: 'qa_report.json의 blocking_next_actions · 순서대로' }));
  }
  const log = [...episodes.flatMap((e) => e.events), ...projectEvents].sort(byNewest).slice(0, 40);
  sections.push(sec.table('작업 로그', ['시각', '대상', '무엇', '파일'], log.map((e) => [fmtKst(e.at), e.who, e.what, e.hint ?? '']), { open: log.length > 0, wrap: [2], note: log.length ? `파일 변경 시각 기준 · ${log.length}건` : '기록 없음' }));
  sections.push(sec.list('백로그 Now', backlog.items.length ? backlog.items.map((i) => ({ text: i.text, level: i.done ? 'ok' as const : 'info' as const })) : [{ text: '기록 없음', level: 'info' as const }], { note: `${backlog.checked}/${backlog.total} 완료` }));
  if (ep0?.qa) sections.push(sec.kv('기계 QA (draft.qa.json)', [
    ['해상도', `${ep0.qa.width ?? '?'}×${ep0.qa.height ?? '?'} @ ${ep0.qa.fps ?? '?'}fps`], ['길이', ep0.qa.durationS === null ? '—' : `${fmtNum(ep0.qa.durationS, 3)}s`], ['크기', ep0.qa.sizeBytes === null ? '—' : fmtBytes(ep0.qa.sizeBytes)], ['기술 검사', ep0.qa.techPass === null ? '—' : ep0.qa.techPass ? '통과' : '실패'],
    ['블랙 프레임', ep0.qa.black === null ? '—' : `${ep0.qa.black}회`], ['정지 프레임', ep0.qa.frozen === null ? '—' : `${ep0.qa.frozen}회${ep0.qa.frozenS !== null ? ` · ${fmtNum(ep0.qa.frozenS, 1)}s` : ''}`], ['오디오', ep0.qa.audible === null ? '—' : ep0.qa.audible ? '있음' : '무음'], ['오디오 게이트', ep0.qa.audioGate ? gateWord(ep0.qa.audioGate).word + (/typecast/i.test(ep0.qa.audioGate) ? ' (Typecast 음성 대기)' : '') : '—'],
  ]));
  sections.push(sec.kv('프로젝트', [['이름', project.name ?? '—'], ['상태', stageKo(project.status)], ['자동 게시', project.autoPublish === null ? '—' : project.autoPublish ? '켬' : '끔'], ['사람 승인 필요', project.approval === null ? '—' : project.approval ? '예' : '아니오'], ['마지막 변경', agoFrom(lastActivity, now)]]));
  return { id: 'video', name: '영상 스튜디오', state, lastActivity, metrics, alerts: sortAlerts(alerts), links: [], sources: [source], page: page(headline, decision, kpis, sections) };
}

/* ═══════════════════════════════ 게임 스튜디오 ═══════════════════════════════ */

const VERCEL_RE = /https:\/\/[a-z0-9-]+\.vercel\.app\b/i;
/** Folders tried when `~/games` cannot be listed (the original single-game layout). */
const DEFAULT_GAMES = ['neon-apex'];
const SRC_RE = /\.(js|mjs|ts|html|css|json)$/i;
const SHOT_RE = /\.(png|jpe?g|webp)$/i;

interface Game {
  slug: string; name: string | null; version: string | null; kind: 'game' | 'concept' | 'empty';
  deployUrl: string | null; deployNote: string | null; verifiedAt: string | null; preparedAt: string | null; candidate: boolean;
  tests: { passed: number; total: number | null } | null; passLines: string[]; fairness: { runs: number | null; replays: number | null; violations: number | null; at: string | null; file: string | null; counterexamples: number } | null;
  manifest: { at: string | null; files: [string, string][] } | null; changedSinceVerify: { file: string; at: string }[]; srcNewerThanBuild: { file: string; at: string }[];
  build: { rel: string; at: string | null } | null; builds: { rel: string; at: string | null }[]; shots: { rel: string; at: string | null }[]; backups: { name: string; at: string | null }[];
  recentSrc: { file: string; at: string }[]; events: FileEvent[]; lastAt: string | null; concept: { status: string | null; at: string | null } | null; tempDeploy: { host: string; state: string | null; expiresAt: string | null; at: string | null } | null;
}

/** `pre-airborne-20260908-152545.zip` → `airborne 작업 전 백업`. */
const backupWhat = (name: string): string => { const m = /^pre-([a-z0-9]+)/i.exec(name); return m ? `${m[1]} 작업 전 백업` : '백업 스냅샷'; };

async function loadGame(deps: HubDeps, root: string, slug: string, stat: (f: string) => Promise<number | null>): Promise<Game> {
  const dir = path.join(root, slug);
  const [top, pkgText, deployText, readmeAt, deployAt, testNames, backupNames, releaseNames, prodNames, deployNames, distNames, srcNames] = await Promise.all([
    listOpt(deps, dir), readOpt(deps, path.join(dir, 'package.json')), readOpt(deps, path.join(dir, 'DEPLOYMENT.md')), stat(path.join(dir, 'README.md')), stat(path.join(dir, 'DEPLOYMENT.md')),
    ...['tests', 'backups', 'release', 'production', 'deploy', 'dist', 'src'].map((d) => listOpt(deps, path.join(dir, d))),
  ]);
  const pkg = parseJson(pkgText);
  const version = pkg ? str(pkg.version, 20) : null;
  const name = pkg ? str(pkg.name, 60) : null;
  const events: FileEvent[] = [];
  const topNames = top ?? [];
  const mdOnly = !pkg && topNames.length > 0 && topNames.every((n) => /\.md$/i.test(n));
  if (!pkg && !deployText && !topNames.length && !testNames && !distNames && readmeAt === null) return { slug, name, version, kind: 'empty', deployUrl: null, deployNote: null, verifiedAt: null, preparedAt: null, candidate: false, tests: null, passLines: [], fairness: null, manifest: null, changedSinceVerify: [], srcNewerThanBuild: [], build: null, builds: [], shots: [], backups: [], recentSrc: [], events, lastAt: null, concept: null, tempDeploy: null };
  if (mdOnly) {
    const md = topNames.find((n) => /brief|readme/i.test(n)) ?? topNames[0]!;
    const [text, at] = await Promise.all([readOpt(deps, path.join(dir, md)), stat(path.join(dir, md))]);
    const status = text ? scrub(/^\s*Status:\s*(.+)$/im.exec(text)?.[1]?.trim(), 80) || null : null;
    const atIso = msIso(at);
    if (atIso) events.push({ at: atIso, who: slug, what: `콘셉트 문서 ${status ? `(${status.slice(0, 40)})` : ''}`.trim(), hint: md });
    return { slug, name, version, kind: 'concept', deployUrl: null, deployNote: null, verifiedAt: null, preparedAt: null, candidate: false, tests: null, passLines: [], fairness: null, manifest: null, changedSinceVerify: [], srcNewerThanBuild: [], build: null, builds: [], shots: [], backups: [], recentSrc: [], events, lastAt: atIso, concept: { status, at: atIso }, tempDeploy: null };
  }

  // DEPLOYMENT.md: verification time, public URL (not "existing site … not replaced"), test counts, PASS lines.
  let deployUrl: string | null = null, deployNote: string | null = null, verifiedAt: string | null = null, preparedAt: string | null = null, candidate = false;
  let tests: Game['tests'] = null;
  const passLines: string[] = [];
  if (deployText) {
    verifiedAt = toIso(/Verified at:\s*([0-9T:.+-]+)/i.exec(deployText)?.[1] ?? null);
    preparedAt = toIso(/Prepared\s+(\d{4}-\d{2}-\d{2})/i.exec(deployText)?.[1] ? `${/Prepared\s+(\d{4}-\d{2}-\d{2})/i.exec(deployText)![1]}T00:00:00+09:00` : null);
    candidate = /candidate|후보/i.test(deployText.split('\n')[0] ?? '') || /not replaced|promoted after/i.test(deployText);
    for (const line of deployText.split('\n')) {
      const labelled = /^\s*-?\s*(Public URL|Production URL|Production|URL|Deployed)\s*:\s*(https?:\/\/\S+)/i.exec(line);
      if (labelled && !deployUrl) { deployUrl = labelled[2]!.replace(/[.,)]+$/, ''); continue; }
      if (/existing public site|not replaced|기존 공개/i.test(line)) { const u = VERCEL_RE.exec(line)?.[0]; if (u) deployNote = `기존 공개 사이트 ${u.replace(/^https?:\/\//, '')} 유지 (이 버전으로 교체 안 됨)`; continue; }
    }
    if (!deployUrl) { for (const line of deployText.split('\n')) { if (/existing|not replaced|기존/i.test(line)) continue; const u = VERCEL_RE.exec(line)?.[0]; if (u) { deployUrl = u; break; } } }
    const t1 = /(\d+)\s+(?:Node\s+)?[\w/ ]*tests?:?\s*PASS/i.exec(deployText);
    const t2 = /(\d+)\s*\/\s*(\d+)\s*pass/i.exec(deployText);
    tests = t1 ? { passed: Number(t1[1]), total: null } : t2 ? { passed: Number(t2[1]), total: Number(t2[2]) } : null;
    for (const line of deployText.split('\n')) { const m = /^\s*-\s*(.+?)\s*:?\s*PASS\.?\s*$/i.exec(line) ?? /^\s*-\s*(.+?)\s+pass\b.*$/i.exec(line); if (m && passLines.length < 8) passLines.push(scrub(m[1]!.replace(/\s*\(.*?\)\s*/g, ' ').trim(), 90)); }
  }
  // Release manifest (frozen checksums at verification) — `tests/*release-manifest*.json`.
  // Without a tests/ listing fall back to the known manifest names (the original neon-apex layout).
  let manifestName = (testNames ?? []).filter((n) => /release-manifest.*\.json$/i.test(n)).sort().reverse()[0] ?? null;
  let manifestRaw = manifestName ? parseJson(await readOpt(deps, path.join(dir, 'tests', manifestName))) : null;
  if (!manifestRaw && testNames === null) for (const n of ['v3-release-manifest.json', 'release-manifest.json']) { manifestRaw = parseJson(await readOpt(deps, path.join(dir, 'tests', n))); if (manifestRaw) { manifestName = n; break; } }
  const manifest: Game['manifest'] = manifestRaw ? { at: toIso(manifestRaw.verified_at), files: isObj(manifestRaw.files) ? Object.entries(manifestRaw.files).filter((e): e is [string, string] => typeof e[1] === 'string').slice(0, 100) : [] } : null;
  verifiedAt ??= manifest?.at ?? null;
  // Fairness simulation: the newest `tests/fairness*.log` tail (summary JSON block + counterexample lines).
  const fairLogs = (testNames ?? []).filter((n) => /^fairness.*\.log$/i.test(n));
  const fairTimes = await Promise.all(fairLogs.map((n) => stat(path.join(dir, 'tests', n))));
  let fairness: Game['fairness'] = null;
  if (fairLogs.length) {
    const best = fairLogs.map((n, i) => ({ n, t: fairTimes[i] ?? 0 })).sort((a, b) => b.t - a.t)[0]!;
    const tail = await deps.readTail(path.join(dir, 'tests', best.n), 8192).catch(() => null);
    const pick = (k: string): number | null => { const m = new RegExp(`"${k}":\\s*(\\d+)`).exec(tail ?? ''); return m ? Number(m[1]) : null; };
    fairness = { runs: pick('finiteRuns'), replays: pick('replayChecks'), violations: pick('violations'), at: msIso(best.t || null), file: best.n, counterexamples: (tail?.match(/COUNTEREXAMPLE/g) ?? []).length };
  }
  // Builds, deploy folders, screenshots, backups, sources: names + mtimes (bounded by the stat budget).
  const builds: { rel: string; at: string | null }[] = [];
  const distHtml = (distNames ?? []).filter((n) => /\.html$/i.test(n)).slice(0, 4);
  const shotsNames = (distNames ?? []).filter((n) => SHOT_RE.test(n)).slice(0, 60);
  const deployFolders: [string, string[] | null, string][] = [['production', prodNames ?? null, '프로덕션 배포 폴더 갱신'], ['release', releaseNames ?? null, '릴리스 후보 폴더 갱신'], ['deploy', deployNames ?? null, '임시 배포 폴더 갱신']];
  const srcFiles = (srcNames ?? []).filter((n) => SRC_RE.test(n)).slice(0, 30).map((n) => `src/${n}`);
  const testFiles = (testNames ?? []).filter((n) => SRC_RE.test(n) && !/manifest|report|\.log$/i.test(n)).slice(0, 40).map((n) => `tests/${n}`);
  const backupList = (backupNames ?? []).slice(0, 20);
  const vercelLogs = topNames.filter((n) => /^vercel.*\.log$/i.test(n)).slice(0, 2);
  const [distTimes, shotTimes, folderTimes, srcTimes, testTimes, backupTimes, pkgAt, vercelLogTimes] = await Promise.all([
    Promise.all(distHtml.map((n) => stat(path.join(dir, 'dist', n)))), Promise.all(shotsNames.map((n) => stat(path.join(dir, 'dist', n)))),
    Promise.all(deployFolders.map(([d, names]) => (names ?? []).some((n) => /\.html$/i.test(n)) ? stat(path.join(dir, d, (names ?? []).find((n) => /\.html$/i.test(n))!)) : Promise.resolve(null))),
    Promise.all(srcFiles.map((f) => stat(path.join(dir, f)))), Promise.all(testFiles.map((f) => stat(path.join(dir, f)))), Promise.all(backupList.map((n) => stat(path.join(dir, 'backups', n)))),
    stat(path.join(dir, 'package.json')), Promise.all(vercelLogs.map((n) => stat(path.join(dir, n)))),
  ]);
  distHtml.forEach((n, i) => builds.push({ rel: `dist/${n}`, at: msIso(distTimes[i] ?? null) }));
  const build = builds.slice().sort(byNewest)[0] ?? null;
  for (const b of builds) if (b.at) events.push({ at: b.at, who: slug, what: `빌드 산출물 ${b.rel}${version ? ` (v${version})` : ''}`, hint: b.rel });
  deployFolders.forEach(([d, names], i) => { const at = msIso(folderTimes[i] ?? null); const html = (names ?? []).find((n) => /\.html$/i.test(n)); if (at && html) { events.push({ at, who: slug, what: deployFolders[i]![2], hint: `${d}/${html}` }); builds.push({ rel: `${d}/${html}`, at }); } });
  const shots = shotsNames.map((n, i) => ({ rel: `dist/${n}`, at: msIso(shotTimes[i] ?? null) })).sort(byNewest);
  // Screenshot batches: grouped by name prefix (v3-, preview-, AIRBORNE-…) → one history row each.
  const groups = new Map<string, { n: number; at: string | null; sample: string }>();
  for (const s of shots) { const base = s.rel.slice(5); const key = (/^([A-Za-z0-9]+)[-_.]/.exec(base)?.[1] ?? base).toLowerCase(); const g = groups.get(key); if (!g) groups.set(key, { n: 1, at: s.at, sample: base }); else { g.n++; if (s.at && (!g.at || s.at > g.at)) g.at = s.at; } }
  for (const [key, g] of groups) if (g.at) events.push({ at: g.at, who: slug, what: `캡처 ${key} ${g.n}장`, hint: g.sample });
  const backups = backupList.map((n, i) => ({ name: n, at: msIso(backupTimes[i] ?? null) })).sort(byNewest);
  for (const b of backups) if (b.at) events.push({ at: b.at, who: slug, what: backupWhat(b.name), hint: b.name });
  if (verifiedAt) events.push({ at: verifiedAt, who: slug, what: `배포 검증${version ? ` v${version}` : ''}${tests ? ` · 테스트 ${tests.passed}${tests.total !== null ? `/${tests.total}` : ''} PASS` : ''}${deployUrl ? ` · ${deployUrl.replace(/^https?:\/\//, '')}` : ''}`, hint: 'DEPLOYMENT.md' });
  else if (preparedAt) events.push({ at: msIso(deployAt) ?? preparedAt, who: slug, what: `릴리스 후보 준비${version ? ` v${version}` : ''}${tests ? ` · 테스트 ${tests.passed}${tests.total !== null ? `/${tests.total}` : ''} PASS` : ''}`, hint: 'DEPLOYMENT.md' });
  if (manifest?.at && manifest.at !== verifiedAt) events.push({ at: manifest.at, who: slug, what: `릴리스 매니페스트 동결 (${manifest.files.length}개 파일)`, hint: manifestName ?? '' });
  else if (manifest?.at) events.push({ at: manifest.at, who: slug, what: `릴리스 매니페스트 동결 (${manifest.files.length}개 파일 체크섬)`, hint: manifestName ?? '' });
  if (fairness?.at) events.push({ at: fairness.at, who: slug, what: `공정성 시뮬레이션${fairness.runs !== null ? ` ${fmtNum(fairness.runs, 0)}회` : ''}${fairness.violations !== null ? ` · 위반 ${fairness.violations}` : ''}`, hint: fairness.file ?? '' });
  const pkgIso = msIso(pkgAt);
  const readmeIso = msIso(readmeAt);
  if (readmeIso) events.push({ at: readmeIso, who: slug, what: 'README 갱신', hint: 'README.md' });
  if (pkgIso && version) events.push({ at: pkgIso, who: slug, what: `package.json v${version}`, hint: 'package.json' });
  // Vercel CLI temporary deploy log (anonymous `vc deploy --temporary`): only the URL host, state and expiry.
  let tempDeploy: Game['tempDeploy'] = null;
  if (vercelLogs[0]) {
    const text = await deps.readTail(path.join(dir, vercelLogs[0]), 4096).catch(() => null);
    const j = parseJson(/\{[\s\S]*?\n\}/.exec(text ?? '')?.[0] ?? null);
    const u = typeof j?.url === 'string' ? VERCEL_RE.exec(j.url)?.[0] ?? null : VERCEL_RE.exec(text ?? '')?.[0] ?? null;
    if (u) {
      tempDeploy = { host: u.replace(/^https?:\/\//, ''), state: j ? str(j.readyState, 20) : null, expiresAt: j ? toIso(j.expiresAt) : null, at: msIso(vercelLogTimes[0] ?? null) };
      if (tempDeploy.at) events.push({ at: tempDeploy.at, who: slug, what: `Vercel 임시 배포 ${tempDeploy.host}${tempDeploy.state ? ` (${tempDeploy.state})` : ''}${tempDeploy.expiresAt ? ` · 만료 ${fmtKst(tempDeploy.expiresAt)}` : ''}`, hint: vercelLogs[0] });
    }
  }
  // Sources/tests with times → changed since verification (manifest files), newer than the build, most recent edits.
  const timed = [...srcFiles.map((f, i) => ({ file: f, ms: srcTimes[i] ?? null })), ...testFiles.map((f, i) => ({ file: f, ms: testTimes[i] ?? null }))].filter((x): x is { file: string; ms: number } => x.ms !== null);
  const manifestFiles = manifest ? manifest.files.map(([f]) => f) : [];
  const extra = manifestFiles.filter((f) => !timed.some((t) => t.file === f) && !builds.some((b) => b.rel === f));
  const extraTimes = await Promise.all(extra.map((f) => stat(path.join(dir, f))));
  const manifestTimed = [...timed.filter((t) => manifestFiles.includes(t.file)), ...extra.map((f, i) => ({ file: f, ms: extraTimes[i] ?? null })).filter((x): x is { file: string; ms: number } => x.ms !== null), ...builds.filter((b) => manifestFiles.includes(b.rel) && b.at).map((b) => ({ file: b.rel, ms: Date.parse(b.at!) }))];
  const vMs = isoMs(verifiedAt);
  const changedSinceVerify = vMs === null ? [] : manifestTimed.filter((t) => t.ms > vMs + 1000).map((t) => ({ file: t.file, at: new Date(t.ms).toISOString() })).sort(byNewest);
  const bMs = build?.at ? Date.parse(build.at) : null;
  const srcNewerThanBuild = bMs === null ? [] : timed.filter((t) => t.file.startsWith('src/') && t.ms > bMs + 1000).map((t) => ({ file: t.file, at: new Date(t.ms).toISOString() })).sort(byNewest);
  const recentSrc = timed.slice().sort((a, b) => b.ms - a.ms).slice(0, 8).map((t) => ({ file: t.file, at: new Date(t.ms).toISOString() }));
  for (const r of recentSrc.slice(0, 3)) events.push({ at: r.at, who: slug, what: `소스 수정 ${r.file}`, hint: r.file });
  events.sort(byNewest);
  const lastAt = latestIso(events[0]?.at ?? null, ...recentSrc.map((r) => r.at), ...builds.map((b) => b.at));
  return { slug, name, version, kind: 'game', deployUrl, deployNote, verifiedAt, preparedAt, candidate, tests, passLines, fairness, manifest, changedSinceVerify, srcNewerThanBuild, build, builds, shots, backups, recentSrc, events, lastAt, concept: null, tempDeploy };
}

export async function collectGame(deps: HubDeps): Promise<HubMode> {
  const root = path.join(deps.home, 'games');
  const t0 = deps.now();
  const now = t0;
  const stat = statBudget(deps, 200);
  const listed = await listOpt(deps, root);
  const slugs = (listed ?? DEFAULT_GAMES).filter((n) => !/^node_modules$/.test(n)).slice(0, 10);
  const commits = await Promise.all(slugs.map((s) => deps.gitLastCommit(path.join(root, s)).catch(() => null)));
  const all = await Promise.all(slugs.map((s) => loadGame(deps, root, s, stat)));
  const games = all.filter((g) => g.kind !== 'empty');
  games.forEach((g) => { const c = toIso(commits[slugs.indexOf(g.slug)] ?? null); if (c) { g.lastAt = latestIso(g.lastAt, c); g.events.push({ at: c, who: g.slug, what: '마지막 git 커밋', hint: 'git log' }); g.events.sort(byNewest); } });
  games.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'game' ? -1 : 1) : (a.deployUrl ? 0 : 1) - (b.deployUrl ? 0 : 1) || byNewest({ at: a.lastAt }, { at: b.lastAt })));
  const anyCommit = commits.some((c) => c !== null);
  const ok = games.length > 0;
  const source: HubSource = { name: anyCommit ? 'git log' : 'file mtime', ok, ms: deps.now() - t0, ...(ok ? {} : { error: '폴더 없음' }) };
  const lastActivity = latestIso(...games.map((g) => g.lastAt));
  const age = lastActivity ? now - Date.parse(lastActivity) : null;
  const deployed = games.filter((g) => g.deployUrl);
  const candidates = games.filter((g) => g.kind === 'game' && !g.deployUrl && (g.candidate || g.builds.some((b) => b.rel.startsWith('release/'))));
  const changed = games.reduce((n, g) => n + g.changedSinceVerify.length, 0);
  const stale = games.filter((g) => g.srcNewerThanBuild.length);

  const metrics: Record<string, HubMetricValue> = {};
  if (age !== null) metrics[anyCommit ? '마지막 커밋' : '마지막 변경'] = fmtAgo(age);
  const publicGame = deployed[0] ?? null;
  if (publicGame?.verifiedAt) metrics['배포 검증'] = fmtDate(publicGame.verifiedAt);
  metrics['배포'] = publicGame ? 'Vercel' : '없음';
  if (publicGame?.version) metrics['버전'] = `v${publicGame.version}`;
  if (games.length > 1) metrics['게임'] = games.length;

  const alerts: HubAlert[] = [];
  for (const g of games) {
    if (g.changedSinceVerify.length) alerts.push({ level: 'warn', text: `${g.slug} · 검증 후 소스 ${g.changedSinceVerify.length}개 변경 — 재검증 필요`, hint: g.changedSinceVerify.slice(0, 3).map((c) => c.file).join(', ') });
    if (g.srcNewerThanBuild.length) alerts.push({ level: 'warn', text: `${g.slug} · 빌드 이후 소스 ${g.srcNewerThanBuild.length}개 수정 — 재빌드·테스트 필요`, hint: g.srcNewerThanBuild.slice(0, 3).map((c) => c.file).join(', ') });
    if (g.kind === 'game' && !g.verifiedAt && !g.preparedAt) alerts.push({ level: 'info', text: `${g.slug} · 검증 기록 없음` });
    if (g.fairness && g.fairness.violations) alerts.push({ level: 'bad', text: `${g.slug} · 공정성 불변식 위반 ${g.fairness.violations}건` });
    if (g.tempDeploy?.expiresAt && Date.parse(g.tempDeploy.expiresAt) < now) alerts.push({ level: 'info', text: `${g.slug} · Vercel 임시 배포 만료 (${g.tempDeploy.host})` });
  }
  for (const g of candidates) alerts.push({ level: 'info', text: `${g.slug}${g.version ? ` v${g.version}` : ''} 릴리스 후보 — 공개 여부 미결정` });
  if (age !== null && age > IDLE_DAYS * DAY_MS) alerts.push({ level: 'info', text: `${fmtAgo(age)} 변경 없음` });
  if (ok && !deployed.length) alerts.push({ level: 'info', text: '배포 URL 미확인' });
  const state: HubState = !ok || age === null ? 'unknown' : alerts.some((a) => a.level === 'bad' || a.level === 'warn') ? 'warn' : age > IDLE_DAYS * DAY_MS ? 'idle' : 'ok';

  const gameWord = (g: Game): string => g.kind === 'concept' ? '콘셉트' : g.deployUrl ? (g.verifiedAt ? `검증 ${fmtKst(g.verifiedAt)}` : '배포 (검증 기록 없음)') : candidates.includes(g) ? '릴리스 후보' : g.build ? '빌드만' : '기록 없음';
  const headline = !ok ? '프로젝트 폴더 없음' : `${games.filter((g) => g.kind === 'game').map((g) => `${g.slug}${g.version ? ` v${g.version}` : ''} ${gameWord(g)}`).join(' · ')}${games.some((g) => g.kind === 'concept') ? ` · 콘셉트 ${games.filter((g) => g.kind === 'concept').length}` : ''} · 검증 후 변경 ${changed}`;
  const firstChanged = games.find((g) => g.changedSinceVerify.length);
  const decision = !ok ? '폴더 경로 확인'
    : firstChanged ? `${firstChanged.slug}: 검증 후 소스 ${firstChanged.changedSinceVerify.length}개 변경 — npm test → build → 재검증 후 DEPLOYMENT.md 갱신`
    : stale[0] ? `${stale[0].slug}: 빌드보다 나중에 수정된 소스 ${stale[0].srcNewerThanBuild.length}개 (${stale[0].srcNewerThanBuild[0]!.file}) — 재빌드·테스트 필요`
    : candidates[0] ? `${candidates[0].slug}${candidates[0].version ? ` v${candidates[0].version}` : ''} 후보를 공개할지 결정${publicGame ? ` (현재 공개: ${publicGame.slug}${publicGame.version ? ` v${publicGame.version}` : ''})` : ''}`
    : games.some((g) => g.kind === 'game' && !g.verifiedAt && !g.preparedAt) ? `${games.find((g) => g.kind === 'game' && !g.verifiedAt && !g.preparedAt)!.slug}: 검증 기록 없음 — 테스트·배포 검증 필요`
    : publicGame ? '소스 변경 없음 — 재검증 불필요' : '검증 기록 없음 — 배포 검증 필요';

  const totalBackups = games.reduce((n, g) => n + g.backups.length, 0);
  const latestTest = games.filter((g) => g.tests).sort((a, b) => ((b.verifiedAt ?? b.preparedAt) ?? '').localeCompare((a.verifiedAt ?? a.preparedAt) ?? ''))[0] ?? null;
  const kpis: HubKpi[] = [
    kpi('공개 배포', publicGame ? `${publicGame.slug}${publicGame.version ? ` v${publicGame.version}` : ''}` : '없음', { status: publicGame ? 'ok' : 'warn', ...(publicGame?.deployUrl ? { hint: publicGame.deployUrl.replace(/^https?:\/\//, '') } : {}) }),
    kpi('배포 검증', publicGame?.verifiedAt ? fmtDate(publicGame.verifiedAt) : '—', { status: publicGame?.verifiedAt ? 'ok' : 'warn', ...(publicGame?.verifiedAt ? { hint: agoFrom(publicGame.verifiedAt, now) } : { hint: '기록 없음' }) }),
    kpi('검증 후 변경', String(changed), { status: changed ? 'warn' : 'ok', hint: games.some((g) => g.manifest) ? `매니페스트 ${games.map((g) => g.manifest?.files.length ?? 0).reduce((a, b) => a + b, 0)}개 파일 기준` : '매니페스트 없음' }),
    kpi('릴리스 후보', candidates.length ? candidates.map((g) => `${g.slug.replace(/^neon-apex-?/, '') || g.slug}${g.version ? ` v${g.version}` : ''}`).join(', ') : '없음', { status: candidates.length ? 'info' : 'ok', hint: candidates.length ? '공개 여부 미결정' : '' }),
    kpi('테스트 기록', latestTest?.tests ? `${latestTest.tests.passed}${latestTest.tests.total !== null ? `/${latestTest.tests.total}` : ''} PASS` : '—', { status: latestTest ? 'ok' : 'info', hint: latestTest ? `${latestTest.slug} · ${fmtKst(latestTest.verifiedAt ?? latestTest.preparedAt)}` : '기록 없음' }),
    kpi('최근 작업', age === null ? '—' : fmtAgo(age), { status: age !== null && age > IDLE_DAYS * DAY_MS ? 'info' : 'ok', hint: `백업 ${totalBackups}개` }),
  ];

  const cards: HubCardItem[] = games.map((g) => {
    const links: HubLink[] = [];
    const play = g.builds.find((b) => b.rel.startsWith('dist/') && /\.html$/i.test(b.rel)) ?? g.builds.find((b) => /\.html$/i.test(b.rel));
    if (play) links.push({ label: '플레이', href: hubFileUrl('game', `${g.slug}/${play.rel}`) });
    if (g.deployUrl) links.push({ label: 'Vercel', href: g.deployUrl });
    const cardState: HubState = g.kind === 'concept' ? 'idle' : g.changedSinceVerify.length || g.srcNewerThanBuild.length ? 'warn' : g.verifiedAt && g.deployUrl ? 'ok' : g.preparedAt || g.build ? 'idle' : 'unknown';
    const rows: HubCardItem['rows'] = g.kind === 'concept'
      ? [{ label: '상태', value: g.concept?.status ?? '기록 없음' }, { label: '문서', value: g.concept?.at ? `${fmtKst(g.concept.at)} · ${agoFrom(g.concept.at, now)}` : '기록 없음' }, { label: '빌드', value: '없음 (콘셉트 단계)' }]
      : [
        { label: '마지막 변경', value: g.lastAt ? `${fmtKst(g.lastAt)} · ${agoFrom(g.lastAt, now)}` : '기록 없음' },
        { label: '검증', value: g.verifiedAt ? `${fmtKst(g.verifiedAt)}${g.tests ? ` · 테스트 ${g.tests.passed}${g.tests.total !== null ? `/${g.tests.total}` : ''} PASS` : ''}` : g.preparedAt ? `후보 준비 ${fmtDate(g.preparedAt)}${g.tests ? ` · 테스트 ${g.tests.passed}${g.tests.total !== null ? `/${g.tests.total}` : ''} PASS` : ''}` : '기록 없음', status: g.verifiedAt ? 'ok' : g.preparedAt ? 'info' : 'warn' },
        { label: '배포', value: g.deployUrl ? `Vercel · ${g.deployUrl.replace(/^https?:\/\//, '')}` : g.deployNote ? '미공개 후보' : g.tempDeploy ? `임시 배포 ${g.tempDeploy.host}` : '없음', status: g.deployUrl ? 'ok' : 'info' },
        { label: '공정성', value: g.fairness ? `${g.fairness.runs !== null ? `${fmtNum(g.fairness.runs, 0)}회` : '기록'} · 위반 ${g.fairness.violations ?? '—'}${g.fairness.replays !== null ? ` · 리플레이 ${g.fairness.replays}` : ''}` : '기록 없음', status: g.fairness ? (g.fairness.violations ? 'bad' : 'ok') : 'info' },
        { label: '검증 후 변경', value: g.verifiedAt ? `${g.changedSinceVerify.length}개${g.srcNewerThanBuild.length ? ` · 빌드 후 ${g.srcNewerThanBuild.length}개` : ''}` : g.srcNewerThanBuild.length ? `빌드 후 소스 ${g.srcNewerThanBuild.length}개 수정` : g.build ? '검증 기준 없음' : '—', status: g.changedSinceVerify.length || g.srcNewerThanBuild.length ? 'warn' : 'ok' },
        { label: '백업', value: g.backups.length ? `${g.backups.length}개 · 최근 ${fmtKst(g.backups[0]!.at)}` : '없음' },
      ];
    return { title: g.slug, badge: g.kind === 'concept' ? '콘셉트' : g.version ? `v${g.version}` : '버전 미상', state: cardState, sub: g.kind === 'concept' ? (g.concept?.status?.split(/\.\s+/)[0] ?? '콘셉트 문서만') : g.deployUrl ? (g.verifiedAt ? '공개 배포 · 검증 완료' : '공개 배포 · 검증 기록 없음') : candidates.includes(g) ? '릴리스 후보 · 미공개' : g.build ? '빌드 있음 · 미배포' : '빌드 없음', rows, links, ...(g.deployNote ? { note: g.deployNote } : g.changedSinceVerify.length ? { note: '검증 후 바뀐 소스가 있어 DEPLOYMENT.md의 검증은 더 이상 유효하지 않음' } : {}) };
  });

  const history = games.flatMap((g) => g.events).sort(byNewest).slice(0, 40);
  const inProgress: { text: string; level: 'warn' | 'info'; hint?: string; at?: string | null }[] = [];
  for (const g of games) for (const c of g.changedSinceVerify) inProgress.push({ text: `${g.slug} · ${c.file} — 검증 후 변경`, level: 'warn', hint: fmtKst(c.at), at: c.at });
  for (const g of games) for (const c of g.srcNewerThanBuild) if (!g.changedSinceVerify.some((x) => x.file === c.file)) inProgress.push({ text: `${g.slug} · ${c.file} — 빌드보다 나중에 수정`, level: 'warn', hint: fmtKst(c.at), at: c.at });
  const recent = games.flatMap((g) => g.recentSrc.map((r) => ({ ...r, slug: g.slug }))).sort(byNewest).slice(0, 8);
  for (const r of recent) if (!inProgress.some((i) => i.text.includes(`${r.slug} · ${r.file}`))) inProgress.push({ text: `${r.slug} · ${r.file}`, level: 'info', hint: fmtKst(r.at), at: r.at });
  const record = games.filter((g) => g.kind === 'game').flatMap((g) => [
    { label: `${g.slug} · 단위 테스트`, desc: g.tests ? 'DEPLOYMENT.md 기록' : '기록 없음', value: g.tests ? `${g.tests.passed}${g.tests.total !== null ? `/${g.tests.total}` : ''} PASS` : '—', sub: g.verifiedAt ? `검증 ${fmtKst(g.verifiedAt)}` : g.preparedAt ? `준비 ${fmtDate(g.preparedAt)}` : '', status: g.tests ? 'ok' as const : 'info' as const },
    { label: `${g.slug} · 공정성 시뮬레이션`, desc: g.fairness?.file ? `tests/${g.fairness.file}` : '로그 없음', value: g.fairness ? `위반 ${g.fairness.violations ?? '—'}` : '—', sub: g.fairness ? `${g.fairness.runs !== null ? `${fmtNum(g.fairness.runs, 0)}회` : ''}${g.fairness.replays !== null ? ` · 리플레이 ${g.fairness.replays}` : ''}${g.fairness.counterexamples ? ` · 반례 ${g.fairness.counterexamples}건 (naive policy)` : ''} · ${fmtKst(g.fairness.at)}` : '', status: g.fairness ? (g.fairness.violations ? 'bad' as const : 'ok' as const) : 'info' as const },
    { label: `${g.slug} · 빌드 산출물`, desc: g.build ? g.build.rel : 'dist/*.html 없음', value: g.build ? fmtKst(g.build.at) : '—', sub: g.builds.filter((b) => b !== g.build).map((b) => `${b.rel} ${fmtKst(b.at)}`).join(' · '), status: g.build ? 'ok' as const : 'warn' as const },
    { label: `${g.slug} · 캡처`, desc: 'dist/*.png|jpg', value: g.shots.length ? `${g.shots.length}장` : '없음', sub: g.shots[0] ? `최근 ${fmtKst(g.shots[0].at)} · ${g.shots[0].rel.slice(5)}` : '', status: 'info' as const },
    ...(g.passLines.length ? [{ label: `${g.slug} · 검증 항목`, desc: 'DEPLOYMENT.md의 PASS 줄', value: `${g.passLines.length}건`, sub: g.passLines.join(' · ').slice(0, 300), status: 'ok' as const }] : []),
  ]);
  const images: HubImage[] = [];
  for (const g of games) {
    const play = g.builds.find((b) => b.rel.startsWith('dist/') && /\.html$/i.test(b.rel));
    if (play) images.push({ src: hubFileUrl('game', `${g.slug}/${play.rel}`), label: `${g.slug}${g.version ? ` v${g.version}` : ''} 플레이 (${play.rel})`, href: hubFileUrl('game', `${g.slug}/${play.rel}`), kind: 'html' });
    for (const s of g.shots.slice(0, 6)) images.push({ src: hubFileUrl('game', `${g.slug}/${s.rel}`), label: `${g.slug} · ${s.rel.slice(5)}${s.at ? ` · ${fmtKst(s.at)}` : ''}`, href: hubFileUrl('game', `${g.slug}/${s.rel}`), kind: 'image' });
  }
  const sections: HubSection[] = [
    sec.cards('게임', cards, { open: true, cols: games.length >= 3 ? 3 : 2, note: 'git 저장소 아님 — 백업·빌드·DEPLOYMENT.md·매니페스트 파일 시각 기준' }),
    sec.list('진행 중', inProgress.length ? inProgress : [{ text: '기록 없음', level: 'info' as const }], { open: inProgress.some((i) => i.level === 'warn'), note: inProgress.some((i) => i.level === 'warn') ? `주의 ${inProgress.filter((i) => i.level === 'warn').length}건 · 최근 수정 소스` : '검증 후 변경 없음 · 최근 수정 소스' }),
    sec.table('작업 이력', ['시각', '게임', '무엇', '파일'], history.map((e) => [fmtKst(e.at), e.who, e.what, e.hint ?? '']), { open: history.length > 0, wrap: [2], note: history.length ? `백업·빌드·배포·검증·캡처 이벤트 ${history.length}건 (파일 시각)` : '기록 없음' }),
    sec.kvgrid('빌드·테스트 기록', record.length ? record : [{ label: '기록 없음', value: '—' }]),
    sec.images('플레이·캡처', images, { note: images.length ? '플레이는 샌드박스 프레임에서 열림 · 캡처는 dist/ 최신 6장' : '빌드·캡처 없음' }),
  ];
  for (const g of games) if (g.manifest) sections.push(sec.table(`매니페스트 체크섬 · ${g.slug}`, ['파일', '체크섬', '검증 후 변경'], g.manifest.files.map(([f, sha]) => [f, sha.slice(0, 12), g.changedSinceVerify.some((c) => c.file === f) ? '예' : '아니오']), { note: g.manifest.at ? `검증 ${fmtKst(g.manifest.at)} · ${g.manifest.files.length}개 파일` : '검증 시각 없음' }));
  for (const g of deployed) sections.push(sec.raw(`배포 사이트 · ${g.slug}`, g.deployUrl!, { note: `${g.deployUrl!.replace(/^https?:\/\//, '')} (새 탭)` }));
  const links: HubLink[] = [];
  for (const g of deployed) if (!links.some((l) => l.href === g.deployUrl)) links.push({ label: deployed.length > 1 ? `Vercel · ${g.slug}` : 'Vercel', href: g.deployUrl! });
  return { id: 'game', name: '게임 스튜디오', state, lastActivity, metrics, alerts: sortAlerts(alerts), links, sources: [source], page: page(headline, decision, kpis, sections) };
}
