import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import type { HubDeps } from './shared';
import { blockerKo, collectGame, collectVideo, episodeSteps, fmtBytes, gateWord, parseBacklogNow, parseProjectYaml } from './studios';

const NOW = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST
const HOME = '/Users/alice';
const at = (s: string): number => Date.parse(s);

interface Fx { files?: Record<string, string>; dirs?: Record<string, string[]>; mtimes?: Record<string, number>; render?: { mtimeMs: number; name: string }; commit?: string | null }

/** Deps over an in-memory filesystem; paths are relative to HOME. */
function deps(fx: Fx, stats?: { n: number }): HubDeps {
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  return {
    fetchJson: async () => { throw new Error('offline'); },
    latestRender: async () => fx.render ?? null,
    countEntries: async (d) => fx.dirs?.[rel(d)]?.length ?? null,
    gitLastCommit: async () => fx.commit ?? null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async (d) => fx.dirs?.[rel(d)] ?? null,
    fileMtime: async (f) => { if (stats) stats.n++; return fx.mtimes?.[rel(f)] ?? null; },
    systemdShow: async () => null,
    now: () => NOW, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const noHome = (v: unknown): void => { const j = JSON.stringify(v); expect(j).not.toContain(HOME); expect(j).not.toMatch(/\/home\/[a-z]/); };

/* ───────── 영상 fixtures ───────── */

const EP = 'sprinkler-independent-activation';
const QA = {
  episode: EP, stage: 'silent_visual_draft', reviewed_at: '2026-09-01T15:10:47+09:00',
  gates: {
    factual_gate: { status: 'pass', evidence: '4/4 core claims verified' },
    title_overstatement_gate: { status: 'pass', evidence: 'Title stays within scope' },
    copyright_gate: { status: 'pass', evidence: 'All 15 shots are original; renderer at /Users/alice/engineering-shorts/render' },
    synthetic_media_gate: { status: 'pass_for_draft', evidence: 'SH01 carries the label 설명용 재현' },
    technical_video_gate: { status: 'pass', evidence: '1080x1920, 30 fps, 90.048 s' },
    audio_gate: { status: 'blocked', evidence: 'Silent AAC track only. TYPECAST_API_KEY and TYPECAST_VOICE_ID are not configured.' },
    human_publish_approval: false,
  },
  artifacts: { draft_mp4: 'renders/draft.mp4' },
  blocking_next_actions: [
    'Create or supply a local Typecast API key and select a Voice ID (provisional public-demo style choice: low-tone Jinwoo)',
    '.venv-typecast/bin/python scripts/typecast_tts.py episodes/sprinkler-independent-activation',
    'Re-render with narration.wav and Typecast timestamps',
    'Run loudness, subtitle timing/overflow and final editorial review',
    'Obtain explicit human approval before any upload',
  ],
};
const DRAFT_QA = { file: '/Users/alice/engineering-shorts/episodes/x/renders/draft.mp4', width: 1080, height: 1920, duration_s: 90.048, fps: 30, size_bytes: 18497751, technical_video_pass: true, black_frame_heuristic: { event_count: 0 }, frozen_frame_heuristic: { event_count: 1, total_duration_s: 2.6 }, has_audible_audio: false, audio_gate: 'blocked_typecast_voice_pending' };

function videoFx(): Fx {
  const e = `engineering-shorts/episodes/${EP}`;
  return {
    files: {
      'engineering-shorts/project.yaml': 'name: "공학쇼츠 자동화"\nstatus: pilot_storyboard\nworkdir: /Users/alice/engineering-shorts\nauto_publish: false\nhuman_approval_required: true\n',
      'engineering-shorts/backlog.md': '# Backlog\n\n## Now\n- [x] 대본 작성\n- [ ] Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성\n\n## Later\n- [ ] 채널 아트\n',
      [`${e}/qa_report.json`]: JSON.stringify(QA),
      [`${e}/renders/draft.qa.json`]: JSON.stringify(DRAFT_QA),
      [`${e}/script.ko.yaml`]: 'title_working: "화재경보가 울려도 스프링클러가 전부 터지지 않는 이유"\ntarget_duration_s: 90\nbeats:\n  - beat_id: B1\n  - beat_id: B2\n  - beat_id: B3\n',
      [`${e}/storyboard.yaml`]: 'shots:\n  - shot_id: SH01\n  - shot_id: SH02\n',
      [`${e}/claim_ledger.yaml`]: 'claims:\n  - claim_id: C1\n    verification: verified\n  - claim_id: C2\n    verification: single_source\n',
    },
    dirs: { 'engineering-shorts/episodes': [EP], [`${e}/renders`]: ['contact-sheet.png', 'draft.mp4', 'draft.qa.json', 'poster.png'] },
    mtimes: {
      'engineering-shorts/backlog.md': at('2026-09-01T06:11:00Z'), 'engineering-shorts/project.yaml': at('2026-08-31T00:01:00Z'), 'engineering-shorts/scripts/typecast_tts.py': at('2026-09-01T06:12:00Z'),
      [`${e}/qa_report.json`]: at('2026-09-01T06:13:00Z'), [`${e}/script.ko.yaml`]: at('2026-08-30T23:58:00Z'), [`${e}/storyboard.yaml`]: at('2026-08-30T23:58:30Z'),
      [`${e}/renders/draft.mp4`]: at('2026-09-01T06:10:00Z'), [`${e}/renders/poster.png`]: at('2026-09-01T06:09:00Z'), [`${e}/renders/contact-sheet.png`]: at('2026-09-01T06:10:30Z'), [`${e}/renders/draft.qa.json`]: at('2026-09-01T06:11:00Z'),
    },
    render: { mtimeMs: at('2026-09-01T06:10:30Z'), name: 'contact-sheet.png' },
  };
}

describe('영상 스튜디오', () => {
  it('derives the pipeline steps from the stage, files and gates', async () => {
    const m = await collectVideo(deps(videoFx()));
    const steps = section(m.page!.sections, /파이프라인/)!;
    expect(steps.kind).toBe('steps');
    if (steps.kind !== 'steps') return;
    expect(steps.items.map((s) => [s.label, s.state])).toEqual([
      ['대본', 'done'], ['콘티', 'done'], ['무음 시각 초안', 'done'], ['나레이션(TTS)', 'blocked'], ['최종 렌더', 'todo'], ['검수', 'todo'], ['사람 승인', 'todo'], ['업로드', 'todo'],
    ]);
    expect(steps.items[0]!.hint).toBe('3비트 · 목표 90초');
    expect(steps.items[1]!.hint).toBe('2샷');
    expect(steps.items[2]!.hint).toBe('90초 · 17.6 MB · 기술 검사 통과');
    expect(steps.items[3]!.hint).toMatch(/^오디오 게이트 차단 — /);
    expect(steps.items[6]!.hint).toBe('미승인');
  });
  it('episodeSteps: narration present and stage review ⇒ 렌더·검수 done, 사람 승인 active', () => {
    const s = episodeSteps({ stage: 'review', hasScript: true, hasStoryboard: true, hasDraft: true, hasNarration: true, gates: [], approval: null, shots: null, beats: null, targetS: null, qa: null, reviewedAt: null });
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'active', 'todo']);
    const none = episodeSteps({ stage: null, hasScript: false, hasStoryboard: false, hasDraft: false, hasNarration: false, gates: [], approval: null, shots: null, beats: null, targetS: null, qa: null, reviewedAt: null });
    expect(none.map((x) => x.state)).toEqual(['active', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(none[0]!.hint).toBe('기록 없음');
  });
  it('maps the gates to Korean names and verdicts with scrubbed evidence', async () => {
    const m = await collectVideo(deps(videoFx()));
    const gates = section(m.page!.sections, /^게이트$/)!;
    expect(gates.kind).toBe('table');
    if (gates.kind !== 'table') return;
    expect(gates.columns).toEqual(['게이트', '판정', '근거']);
    expect(gates.wrap).toEqual([2]);
    expect(gates.rows.map((r) => [r[0], r[1]])).toEqual([
      ['사실 확인', '통과'], ['제목 과장', '통과'], ['저작권', '통과'], ['합성 표기', '초안 통과'], ['기술(영상)', '통과'], ['오디오', '차단'], ['사람 승인', '미승인'],
    ]);
    expect(gates.rows[2]![2]).toBe('All 15 shots are original; renderer at …');
    expect(gates.rows[6]![2]).toBe('게시 전 사람 승인 필수 (project.yaml)');
    expect(gateWord('fail')).toEqual({ word: '실패', level: 'bad' });
    expect(gateWord('pass_for_draft')).toEqual({ word: '초안 통과', level: 'info' });
  });
  it('renders poster, contact sheet and the draft mp4 through the file route', async () => {
    const m = await collectVideo(deps(videoFx()));
    const images = section(m.page!.sections, /^렌더$/)!;
    expect(images.kind).toBe('images');
    if (images.kind !== 'images') return;
    expect(images.items).toEqual([
      { src: `/api/hub/file/video/episodes/${EP}/renders/poster.png`, label: '포스터', href: `/api/hub/file/video/episodes/${EP}/renders/poster.png`, kind: 'image' },
      { src: `/api/hub/file/video/episodes/${EP}/renders/contact-sheet.png`, label: '접촉시트 (2샷)', href: `/api/hub/file/video/episodes/${EP}/renders/contact-sheet.png`, kind: 'image' },
      { src: `/api/hub/file/video/episodes/${EP}/renders/draft.mp4`, label: '초안 draft.mp4 · 90초 · 17.6 MB · 무음', href: `/api/hub/file/video/episodes/${EP}/renders/draft.mp4`, kind: 'video' },
    ]);
    const cards = section(m.page!.sections, /에피소드/)!;
    if (cards.kind !== 'cards') throw new Error('cards');
    expect(cards.items[0]).toMatchObject({ title: '화재경보가 울려도 스프링클러가 전부 터지지 않는 이유', badge: '무음 시각 초안', state: 'warn', sub: EP });
    expect(cards.items[0]!.links).toEqual([{ label: '초안 영상', href: `/api/hub/file/video/episodes/${EP}/renders/draft.mp4` }, { label: '포스터', href: `/api/hub/file/video/episodes/${EP}/renders/poster.png` }]);
    expect(cards.items[0]!.rows.map((r) => [r.label, r.value])).toEqual([
      ['검토', '09-01 15:10 · 59일 6시간 전'], ['게이트', '5/6 통과 · 오디오 차단'], ['초안', '90초 · 17.6 MB · 무음'], ['대본·콘티', '3비트 · 2샷 · 주장 1/2 검증'], ['승인', '미승인'], ['다음', 'Typecast API 키·Voice ID 설정'],
    ]);
  });
  it('translates the blockers into actions, keeps the original as hint, and builds a concrete headline/decision', async () => {
    const m = await collectVideo(deps(videoFx()));
    expect(m.state).toBe('warn');
    expect(m.page!.headline).toBe(`'${EP}' 무음 시각 초안 · 게이트 5/6 · 오디오 게이트 차단 — Typecast 키 필요`);
    expect(m.page!.decision).toBe('Typecast API 키·Voice ID 설정 → 나레이션 생성: scripts/typecast_tts.py 실행 → 나레이션(narration.wav)·Typecast 타임스탬프 포함 재렌더');
    const blockers = section(m.page!.sections, /블로커/)!;
    if (blockers.kind !== 'list') throw new Error('list');
    expect(blockers.items.map((i) => i.text)).toEqual([
      'Typecast API 키·Voice ID 설정 (.env: TYPECAST_API_KEY, TYPECAST_VOICE_ID) — provisional public-demo style choice: low-tone Jinwoo',
      `나레이션 생성: scripts/typecast_tts.py 실행 (episodes/${EP})`,
      '나레이션(narration.wav)·Typecast 타임스탬프 포함 재렌더',
      '라우드니스·자막 타이밍/넘침·최종 편집 검토',
      '업로드 전 사람 승인 (자동 게시 금지)',
    ]);
    expect(blockers.items[0]).toMatchObject({ level: 'warn', hint: QA.blocking_next_actions[0] });
    expect(blockerKo('Fix the thing at /Users/alice/x', 'e')).toBe('Fix the thing at …');
    expect(m.alerts[0]).toMatchObject({ level: 'warn', text: `${EP} · 오디오 게이트 차단` });
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['에피소드', '1'], ['단계', '무음 시각 초안'], ['게이트 통과', '5/6'], ['초안 길이', '90s'], ['Now 체크', '1/2'], ['게시 승인', '미승인']]);
    expect(m.metrics).toMatchObject({ '에피소드': 1, '최근 렌더': '59일 6시간 전', '파일': 'contact-sheet.png', '단계': '무음 시각 초안' });
  });
  it('logs episode and project file events newest first with the backlog Now items', async () => {
    const m = await collectVideo(deps(videoFx()));
    const log = section(m.page!.sections, /작업 로그/)!;
    if (log.kind !== 'table') throw new Error('table');
    expect(log.columns).toEqual(['시각', '대상', '무엇', '파일']);
    expect(log.rows.slice(0, 4)).toEqual([
      ['09-01 15:13', EP, 'QA 보고서 갱신 (무음 시각 초안)', 'qa_report.json'],
      ['09-01 15:12', '프로젝트', 'Typecast TTS 어댑터 작성', 'scripts/typecast_tts.py'],
      ['09-01 15:11', EP, '기계 QA 결과', 'renders/draft.qa.json'],
      ['09-01 15:11', '프로젝트', '백로그 갱신 (Now 1/2)', 'backlog.md'],
    ]);
    expect(log.rows.at(-1)).toEqual(['08-31 08:58', EP, '대본 작성', 'script.ko.yaml']);
    const now = section(m.page!.sections, /백로그 Now/)!;
    if (now.kind !== 'list') throw new Error('list');
    expect(now.items).toEqual([{ text: '대본 작성', level: 'ok' }, { text: 'Typecast API 키·Voice ID 연결 후 실제 한국어 내레이션 생성', level: 'info' }]);
    expect(section(m.page!.sections.slice(), /기계 QA/)).toMatchObject({ kind: 'kv', rows: expect.arrayContaining([['길이', '90.048s'], ['오디오', '무음'], ['오디오 게이트', '차단 (Typecast 음성 대기)']]) });
    expect(m.page!.sections.map((s) => s.title)).toEqual(['에피소드', `파이프라인 · ${EP}`, '렌더', '게이트', '블로커 · 다음 할 일', '작업 로그', '백로그 Now', '기계 QA (draft.qa.json)', '프로젝트']);
  });
  it('says 기록 없음 for an episode without QA/renders and falls back to the backlog for the decision', async () => {
    const m = await collectVideo(deps({ files: { 'engineering-shorts/backlog.md': '## Now\n- [ ] 첫 대본 쓰기\n' }, dirs: { 'engineering-shorts/episodes': ['ep-new'], 'engineering-shorts/episodes/ep-new/renders': [] } }));
    expect(m.state).toBe('unknown');
    expect(m.page!.headline).toBe(`'ep-new' 기록 없음 · 게이트 0/0`);
    expect(m.page!.decision).toBe('다음 백로그: 첫 대본 쓰기');
    const cards = section(m.page!.sections, /에피소드/)!;
    if (cards.kind !== 'cards') throw new Error('cards');
    expect(cards.items[0]).toMatchObject({ title: 'ep-new', badge: '기록 없음', state: 'unknown', sub: 'QA 기록 없음', links: [] });
    expect(cards.items[0]!.rows.map((r) => r.value)).toEqual(['기록 없음', '기록 없음', '기록 없음', '대본 없음 · 콘티 없음', '기록 없음', '기록 없음']);
    expect(section(m.page!.sections, /^렌더$/)).toMatchObject({ items: [], note: '렌더 파일 없음' });
    expect(section(m.page!.sections, /블로커/)).toMatchObject({ items: [{ text: '기록 없음', level: 'info' }] });
    expect(section(m.page!.sections, /작업 로그/)).toMatchObject({ rows: [], note: '기록 없음' });
    const steps = section(m.page!.sections, /파이프라인/)!;
    if (steps.kind !== 'steps') throw new Error('steps');
    expect(steps.items.map((s) => s.state)).toEqual(['active', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  });
  it('is unknown with source error 폴더 없음 when nothing is readable, and never leaks home paths', async () => {
    const empty = await collectVideo(deps({}));
    expect(empty).toMatchObject({ state: 'unknown', lastActivity: null, sources: [{ name: 'engineering-shorts', ok: false, error: '폴더 없음' }] });
    expect(empty.page!.headline).toBe('프로젝트 폴더 없음');
    const full = await collectVideo(deps(videoFx()));
    noHome(full);
    noHome(empty);
    expect(JSON.stringify(full)).not.toContain('workdir');
  });
  it('keeps parseBacklogNow / parseProjectYaml behaviour', () => {
    expect(parseBacklogNow('## Now\n- [x] a\n- [ ] b /Users/alice/c\n## Next\n- [ ] z')).toEqual({ checked: 1, total: 2, items: [{ text: 'a', done: true }, { text: 'b …', done: false }] });
    expect(parseBacklogNow(null)).toEqual({ checked: 0, total: 0, items: [] });
    expect(parseProjectYaml('name: "X"\nstatus: pilot\nauto_publish: true\nhuman_approval_required: false\n')).toEqual({ name: 'X', status: 'pilot', autoPublish: true, approval: false });
    expect(parseProjectYaml(null)).toEqual({ name: null, status: null, autoPublish: null, approval: null });
  });
});

/* ───────── 게임 fixtures ───────── */

const VERIFIED = '2026-09-08T16:25:48.276118+09:00'; // 07:25:48Z
const DEPLOYMENT = `# NEON APEX 3.0.0 — AIRBORNE verified production\n\n- Verified at: ${VERIFIED}\n- Public URL: https://neon-apex-pi.vercel.app\n- Immutable production: https://neon-apex-ksbxk0up8-maxs.vercel.app\n- 34 Node unit/geometry tests: PASS.\n- Public URL mobile: 390×844, 375×667: PASS.\n- Frozen source/test checksums: tests/v3-release-manifest.json\n`;
const SUPERCAR_DEPLOYMENT = `# NEON APEX 3.1 — SUPERCAR candidate\n\n- Prepared 2026-09-08 (Asia/Seoul).\n- Server source: \`/Users/alice/games/neon-apex-supercar\`.\n- Build: \`dist/NEON-APEX.html\` (788117 bytes).\n- Existing public site: https://neon-apex-pi.vercel.app — not replaced by this task.\n\nUnit/rules: 40/40 pass on macOS and Linux.\nThe supercar candidate can be promoted after deciding which version to publish.\n`;
const MANIFEST = { verified_at: VERIFIED, files: { 'src/core.js': 'aaaaaaaaaaaaaaaa', 'src/main.js': 'bbbbbbbbbbbbbbbb', 'dist/NEON-APEX.html': 'cccccccccccccccc' } };
const FAIR_LOG = 'Running 900 finite runs\n{\n  "finiteRuns": 900,\n  "replayChecks": 27,\n  "violations": 0\n}\nCOLLISION COUNTEREXAMPLE {"x":1}\nReport: tests/fairness-report.json\n';
const VERCEL_LOG = '{\n  "id": "dpl_1",\n  "url": "https://temporary-express-draco.vercel.app",\n  "readyState": "READY",\n  "expiresAt": 1788847115910,\n  "claimUrl": "https://vercel.com/claim-deployment?code=SECRETCODE"\n}\nNot authenticated. Deploying anonymously.\n';

function gameFx(o: { changed?: boolean; stale?: boolean } = {}): Fx {
  const g = 'games/neon-apex';
  const s = 'games/neon-apex-supercar';
  const t = (iso: string): number => at(iso);
  return {
    files: {
      [`${g}/package.json`]: JSON.stringify({ name: 'neon-apex', version: '3.0.0' }), [`${g}/DEPLOYMENT.md`]: DEPLOYMENT, [`${g}/tests/v3-release-manifest.json`]: JSON.stringify(MANIFEST),
      [`${g}/tests/fairness-v3.log`]: FAIR_LOG, [`${g}/vercel-temporary-result.log`]: VERCEL_LOG,
      [`${s}/package.json`]: JSON.stringify({ name: 'neon-apex', version: '3.1.0' }), [`${s}/DEPLOYMENT.md`]: SUPERCAR_DEPLOYMENT,
      'games/bbai-concepts/CONCEPT-BRIEF.md': '# BoredBrain standalone game — concept brief\n\nStatus: RESEARCH / CONCEPT PROPOSAL ONLY. No game built. See /Users/alice/boredbrain_ai.\n',
    },
    dirs: {
      games: ['bbai-concepts', 'neon-apex', 'neon-apex-supercar'],
      [g]: ['DEPLOYMENT.md', 'README.md', 'backups', 'deploy', 'dist', 'package.json', 'production', 'src', 'tests', 'vercel-temporary-result.log'],
      [`${g}/backups`]: ['pre-airborne-20260908-152545.zip', 'pre-expansion-20260908-143040.zip'], [`${g}/deploy`]: ['index.html', 'vercel.json'], [`${g}/production`]: ['index.html', 'vercel.json'],
      [`${g}/dist`]: ['NEON-APEX.html', 'NEON-APEX-preview.png', 'v3-menu-390.png', 'v3-play-390.png'], [`${g}/src`]: ['core.js', 'main.js', 'shell.html'], [`${g}/tests`]: ['core.test.js', 'fairness-v3.log', 'fairness-report.json', 'v3-release-manifest.json'],
      [s]: ['DEPLOYMENT.md', 'backups', 'dist', 'package.json', 'release', 'src', 'tests'],
      [`${s}/backups`]: ['pre-ferrari-20260908.tar.gz'], [`${s}/dist`]: ['NEON-APEX.html'], [`${s}/release`]: ['index.html'], [`${s}/src`]: ['core.js', 'vehicle.js'], [`${s}/tests`]: ['supercar.test.js'],
      'games/bbai-concepts': ['CONCEPT-BRIEF.md'],
    },
    mtimes: {
      [`${g}/package.json`]: t('2026-09-08T07:19:00Z'), [`${g}/DEPLOYMENT.md`]: t('2026-09-08T07:25:48Z'), [`${g}/README.md`]: t('2026-09-08T07:21:00Z'),
      [`${g}/backups/pre-airborne-20260908-152545.zip`]: t('2026-09-08T06:25:45Z'), [`${g}/backups/pre-expansion-20260908-143040.zip`]: t('2026-09-08T05:30:40Z'),
      [`${g}/deploy/index.html`]: t('2026-09-08T04:47:00Z'), [`${g}/production/index.html`]: t('2026-09-08T07:22:00Z'), [`${g}/dist/NEON-APEX.html`]: t('2026-09-08T07:19:30Z'),
      [`${g}/dist/NEON-APEX-preview.png`]: t('2026-09-08T04:32:00Z'), [`${g}/dist/v3-menu-390.png`]: t('2026-09-08T07:27:00Z'), [`${g}/dist/v3-play-390.png`]: t('2026-09-08T07:27:10Z'),
      [`${g}/src/core.js`]: o.changed ? t('2026-09-09T01:00:00Z') : t('2026-09-08T06:34:00Z'), [`${g}/src/main.js`]: t('2026-09-08T07:04:00Z'), [`${g}/src/shell.html`]: o.stale ? t('2026-09-08T07:19:35Z') : t('2026-09-08T07:19:00Z'),
      [`${g}/tests/core.test.js`]: t('2026-09-08T06:00:00Z'), [`${g}/tests/fairness-v3.log`]: t('2026-09-08T07:20:00Z'), [`${g}/vercel-temporary-result.log`]: t('2026-09-08T04:58:00Z'),
      [`${s}/package.json`]: t('2026-09-08T06:54:00Z'), [`${s}/DEPLOYMENT.md`]: t('2026-09-08T07:05:00Z'), [`${s}/backups/pre-ferrari-20260908.tar.gz`]: t('2026-09-08T07:27:00Z'),
      [`${s}/dist/NEON-APEX.html`]: t('2026-09-08T07:29:00Z'), [`${s}/release/index.html`]: t('2026-09-08T07:29:01Z'), [`${s}/src/core.js`]: t('2026-09-08T06:58:00Z'), [`${s}/src/vehicle.js`]: t('2026-09-08T07:25:00Z'),
      'games/bbai-concepts/CONCEPT-BRIEF.md': t('2026-09-08T05:25:00Z'),
    },
  };
}

describe('게임 스튜디오', () => {
  it('shows one card per game with version, verification, deploy, fairness and play links', async () => {
    const m = await collectGame(deps(gameFx()));
    expect(m.state).toBe('idle');
    expect(m.metrics).toEqual({ '마지막 변경': '52일 5시간 전', '배포 검증': '2026-09-08', '배포': 'Vercel', '버전': 'v3.0.0', '게임': 3 });
    expect(m.links).toEqual([{ label: 'Vercel', href: 'https://neon-apex-pi.vercel.app' }]);
    expect(m.sources).toEqual([{ name: 'file mtime', ok: true, ms: 0 }]);
    expect(m.page!.headline).toBe('neon-apex v3.0.0 검증 09-08 16:25 · neon-apex-supercar v3.1.0 릴리스 후보 · 콘셉트 1 · 검증 후 변경 0');
    expect(m.page!.decision).toBe('neon-apex-supercar v3.1.0 후보를 공개할지 결정 (현재 공개: neon-apex v3.0.0)');
    const cards = section(m.page!.sections, /^게임$/)!;
    if (cards.kind !== 'cards') throw new Error('cards');
    expect(cards.items.map((c) => [c.title, c.badge, c.state, c.sub])).toEqual([
      ['neon-apex', 'v3.0.0', 'ok', '공개 배포 · 검증 완료'], ['neon-apex-supercar', 'v3.1.0', 'idle', '릴리스 후보 · 미공개'], ['bbai-concepts', '콘셉트', 'idle', 'RESEARCH / CONCEPT PROPOSAL ONLY'],
    ]);
    expect(cards.items[0]!.rows.map((r) => [r.label, r.value])).toEqual([
      ['마지막 변경', '09-08 16:27 · 52일 5시간 전'], ['검증', '09-08 16:25 · 테스트 34 PASS'], ['배포', 'Vercel · neon-apex-pi.vercel.app'], ['공정성', '900회 · 위반 0 · 리플레이 27'], ['검증 후 변경', '0개'], ['백업', '2개 · 최근 09-08 15:25'],
    ]);
    expect(cards.items[0]!.links).toEqual([{ label: '플레이', href: '/api/hub/file/game/neon-apex/dist/NEON-APEX.html' }, { label: 'Vercel', href: 'https://neon-apex-pi.vercel.app' }]);
    // The supercar DEPLOYMENT.md mentions the existing site as "not replaced" — it must not count as its own deployment.
    expect(cards.items[1]!.links).toEqual([{ label: '플레이', href: '/api/hub/file/game/neon-apex-supercar/dist/NEON-APEX.html' }]);
    expect(cards.items[1]!.rows.map((r) => [r.label, r.value])).toEqual([
      ['마지막 변경', '09-08 16:29 · 52일 5시간 전'], ['검증', '후보 준비 2026-09-08 · 테스트 40/40 PASS'], ['배포', '미공개 후보'], ['공정성', '기록 없음'], ['검증 후 변경', '검증 기준 없음'], ['백업', '1개 · 최근 09-08 16:27'],
    ]);
    expect(cards.items[1]!.note).toBe('기존 공개 사이트 neon-apex-pi.vercel.app 유지 (이 버전으로 교체 안 됨)');
    expect(cards.items[2]!.rows.map((r) => r.value)).toEqual(['RESEARCH / CONCEPT PROPOSAL ONLY. No game built. See …', '09-08 14:25 · 52일 7시간 전', '없음 (콘셉트 단계)']);
    expect(m.page!.kpis.map((k) => [k.label, k.value])).toEqual([['공개 배포', 'neon-apex v3.0.0'], ['배포 검증', '2026-09-08'], ['검증 후 변경', '0'], ['릴리스 후보', 'supercar v3.1.0'], ['테스트 기록', '34 PASS'], ['최근 작업', '52일 5시간 전']]);
    expect(m.alerts.map((a) => a.text)).toEqual(['neon-apex · Vercel 임시 배포 만료 (temporary-express-draco.vercel.app)', 'neon-apex-supercar v3.1.0 릴리스 후보 — 공개 여부 미결정', '52일 5시간 전 변경 없음']);
  });
  it('assembles the work history from backups, builds, deploy folders, captures, verification and logs (newest first)', async () => {
    const m = await collectGame(deps(gameFx()));
    const hist = section(m.page!.sections, /작업 이력/)!;
    if (hist.kind !== 'table') throw new Error('table');
    expect(hist.open).toBe(true);
    expect(hist.columns).toEqual(['시각', '게임', '무엇', '파일']);
    expect(hist.rows).toEqual([
      ['09-08 16:29', 'neon-apex-supercar', '릴리스 후보 폴더 갱신', 'release/index.html'],
      ['09-08 16:29', 'neon-apex-supercar', '빌드 산출물 dist/NEON-APEX.html (v3.1.0)', 'dist/NEON-APEX.html'],
      ['09-08 16:27', 'neon-apex', '캡처 v3 2장', 'v3-play-390.png'],
      ['09-08 16:27', 'neon-apex-supercar', 'ferrari 작업 전 백업', 'pre-ferrari-20260908.tar.gz'],
      ['09-08 16:25', 'neon-apex', '배포 검증 v3.0.0 · 테스트 34 PASS · neon-apex-pi.vercel.app', 'DEPLOYMENT.md'],
      ['09-08 16:25', 'neon-apex', '릴리스 매니페스트 동결 (3개 파일 체크섬)', 'v3-release-manifest.json'],
      ['09-08 16:25', 'neon-apex-supercar', '소스 수정 src/vehicle.js', 'src/vehicle.js'],
      ['09-08 16:22', 'neon-apex', '프로덕션 배포 폴더 갱신', 'production/index.html'],
      ['09-08 16:21', 'neon-apex', 'README 갱신', 'README.md'],
      ['09-08 16:20', 'neon-apex', '공정성 시뮬레이션 900회 · 위반 0', 'fairness-v3.log'],
      ['09-08 16:19', 'neon-apex', '빌드 산출물 dist/NEON-APEX.html (v3.0.0)', 'dist/NEON-APEX.html'],
      ['09-08 16:19', 'neon-apex', 'package.json v3.0.0', 'package.json'],
      ['09-08 16:19', 'neon-apex', '소스 수정 src/shell.html', 'src/shell.html'],
      ['09-08 16:05', 'neon-apex-supercar', '릴리스 후보 준비 v3.1.0 · 테스트 40/40 PASS', 'DEPLOYMENT.md'],
      ['09-08 16:04', 'neon-apex', '소스 수정 src/main.js', 'src/main.js'],
      ['09-08 15:58', 'neon-apex-supercar', '소스 수정 src/core.js', 'src/core.js'],
      ['09-08 15:54', 'neon-apex-supercar', 'package.json v3.1.0', 'package.json'],
      ['09-08 15:34', 'neon-apex', '소스 수정 src/core.js', 'src/core.js'],
      ['09-08 15:25', 'neon-apex', 'airborne 작업 전 백업', 'pre-airborne-20260908-152545.zip'],
      ['09-08 14:30', 'neon-apex', 'expansion 작업 전 백업', 'pre-expansion-20260908-143040.zip'],
      ['09-08 14:25', 'bbai-concepts', '콘셉트 문서 (RESEARCH / CONCEPT PROPOSAL ONLY. No gam)', 'CONCEPT-BRIEF.md'],
      ['09-08 13:58', 'neon-apex', 'Vercel 임시 배포 temporary-express-draco.vercel.app (READY) · 만료 09-08 14:58', 'vercel-temporary-result.log'],
      ['09-08 13:47', 'neon-apex', '임시 배포 폴더 갱신', 'deploy/index.html'],
      ['09-08 13:32', 'neon-apex', '캡처 neon 1장', 'NEON-APEX-preview.png'],
    ]);
    expect(JSON.stringify(m)).not.toContain('SECRETCODE');
    expect(JSON.stringify(m)).not.toContain('claim');
  });
  it('records tests, fairness, builds and captures per game and lists playable builds + screenshots', async () => {
    const m = await collectGame(deps(gameFx()));
    const rec = section(m.page!.sections, /빌드·테스트 기록/)!;
    if (rec.kind !== 'kvgrid') throw new Error('kvgrid');
    expect(rec.rows.map((r) => [r.label, r.value])).toEqual([
      ['neon-apex · 단위 테스트', '34 PASS'], ['neon-apex · 공정성 시뮬레이션', '위반 0'], ['neon-apex · 빌드 산출물', '09-08 16:19'], ['neon-apex · 캡처', '3장'], ['neon-apex · 검증 항목', '2건'],
      ['neon-apex-supercar · 단위 테스트', '40/40 PASS'], ['neon-apex-supercar · 공정성 시뮬레이션', '—'], ['neon-apex-supercar · 빌드 산출물', '09-08 16:29'], ['neon-apex-supercar · 캡처', '없음'],
    ]);
    expect(rec.rows[1]!.sub).toBe('900회 · 리플레이 27 · 반례 1건 (naive policy) · 09-08 16:20');
    expect(rec.rows[2]!.sub).toBe('production/index.html 09-08 16:22 · deploy/index.html 09-08 13:47');
    expect(rec.rows[6]).toMatchObject({ desc: '로그 없음', status: 'info' });
    const images = section(m.page!.sections, /플레이·캡처/)!;
    if (images.kind !== 'images') throw new Error('images');
    expect(images.items.map((i) => [i.kind, i.src])).toEqual([
      ['html', '/api/hub/file/game/neon-apex/dist/NEON-APEX.html'], ['image', '/api/hub/file/game/neon-apex/dist/v3-play-390.png'], ['image', '/api/hub/file/game/neon-apex/dist/v3-menu-390.png'], ['image', '/api/hub/file/game/neon-apex/dist/NEON-APEX-preview.png'],
      ['html', '/api/hub/file/game/neon-apex-supercar/dist/NEON-APEX.html'],
    ]);
    expect(images.items[0]!.label).toBe('neon-apex v3.0.0 플레이 (dist/NEON-APEX.html)');
    const manifest = section(m.page!.sections, /매니페스트 체크섬 · neon-apex/)!;
    if (manifest.kind !== 'table') throw new Error('table');
    expect(manifest.open).toBeUndefined();
    expect(manifest.rows).toEqual([['src/core.js', 'aaaaaaaaaaaa', '아니오'], ['src/main.js', 'bbbbbbbbbbbb', '아니오'], ['dist/NEON-APEX.html', 'cccccccccccc', '아니오']]);
    expect(section(m.page!.sections, /배포 사이트/)).toMatchObject({ kind: 'raw', href: 'https://neon-apex-pi.vercel.app' });
    expect(m.page!.sections.map((s) => s.title)).toEqual(['게임', '진행 중', '작업 이력', '빌드·테스트 기록', '플레이·캡처', '매니페스트 체크섬 · neon-apex', '배포 사이트 · neon-apex']);
  });
  it('flags manifest files changed after verification and sources newer than the build', async () => {
    const changed = await collectGame(deps(gameFx({ changed: true })));
    expect(changed.state).toBe('warn');
    expect(changed.page!.decision).toBe('neon-apex: 검증 후 소스 1개 변경 — npm test → build → 재검증 후 DEPLOYMENT.md 갱신');
    expect(changed.page!.headline).toMatch(/검증 후 변경 1$/);
    expect(changed.alerts[0]).toMatchObject({ level: 'warn', text: 'neon-apex · 검증 후 소스 1개 변경 — 재검증 필요', hint: 'src/core.js' });
    const prog = section(changed.page!.sections, /진행 중/)!;
    if (prog.kind !== 'list') throw new Error('list');
    expect(prog.open).toBe(true);
    expect(prog.items[0]).toMatchObject({ text: 'neon-apex · src/core.js — 검증 후 변경', level: 'warn', hint: '09-09 10:00' });
    expect(prog.items.filter((i) => i.level === 'warn')).toHaveLength(1); // newer-than-build is folded into the same row
    const cards = section(changed.page!.sections, /^게임$/)!;
    if (cards.kind !== 'cards') throw new Error('cards');
    expect(cards.items[0]).toMatchObject({ state: 'warn', note: '검증 후 바뀐 소스가 있어 DEPLOYMENT.md의 검증은 더 이상 유효하지 않음' });
    expect(cards.items[0]!.rows.find((r) => r.label === '검증 후 변경')).toEqual({ label: '검증 후 변경', value: '1개 · 빌드 후 1개', status: 'warn' });
    const manifest = section(changed.page!.sections, /매니페스트 체크섬/)!;
    if (manifest.kind !== 'table') throw new Error('table');
    expect(manifest.rows[0]).toEqual(['src/core.js', 'aaaaaaaaaaaa', '예']);

    const stale = await collectGame(deps(gameFx({ stale: true })));
    expect(stale.page!.decision).toBe('neon-apex: 빌드보다 나중에 수정된 소스 1개 (src/shell.html) — 재빌드·테스트 필요');
    expect(stale.alerts[0]).toMatchObject({ level: 'warn', text: 'neon-apex · 빌드 이후 소스 1개 수정 — 재빌드·테스트 필요' });
  });
  it('says 기록 없음 for a bare game folder and is unknown with 폴더 없음 when nothing exists', async () => {
    const bare = await collectGame(deps({ dirs: { games: ['proto'], 'games/proto': ['index.html', 'src'], 'games/proto/src': ['a.js'] }, mtimes: { 'games/proto/src/a.js': at('2026-10-29T13:00:00Z') } }));
    expect(bare.state).toBe('ok');
    expect(bare.page!.headline).toBe('proto 기록 없음 · 검증 후 변경 0');
    expect(bare.page!.decision).toBe('proto: 검증 기록 없음 — 테스트·배포 검증 필요');
    expect(bare.metrics).toEqual({ '마지막 변경': '1일 0시간 전', '배포': '없음' });
    const cards = section(bare.page!.sections, /^게임$/)!;
    if (cards.kind !== 'cards') throw new Error('cards');
    expect(cards.items[0]).toMatchObject({ title: 'proto', badge: '버전 미상', state: 'unknown', sub: '빌드 없음', links: [] });
    expect(cards.items[0]!.rows.map((r) => r.value)).toEqual(['10-29 22:00 · 1일 0시간 전', '기록 없음', '없음', '기록 없음', '—', '없음']);
    expect(section(bare.page!.sections, /빌드·테스트 기록/)).toMatchObject({ rows: [expect.objectContaining({ label: 'proto · 단위 테스트', value: '—', desc: '기록 없음' }), expect.objectContaining({ value: '—', desc: '로그 없음' }), expect.objectContaining({ value: '—', desc: 'dist/*.html 없음' }), expect.objectContaining({ value: '없음' })] });
    expect(section(bare.page!.sections, /플레이·캡처/)).toMatchObject({ items: [], note: '빌드·캡처 없음' });
    expect(bare.alerts.map((a) => a.text)).toEqual(['proto · 검증 기록 없음', '배포 URL 미확인']);

    const none = await collectGame(deps({}));
    expect(none).toMatchObject({ state: 'unknown', lastActivity: null, metrics: { '배포': '없음' }, links: [], sources: [{ name: 'file mtime', ok: false, error: '폴더 없음' }] });
    expect(none.page!.headline).toBe('프로젝트 폴더 없음');
    expect(section(none.page!.sections, /작업 이력/)).toMatchObject({ rows: [], note: '기록 없음' });
    expect(section(none.page!.sections, /진행 중/)).toMatchObject({ items: [{ text: '기록 없음', level: 'info' }] });
  });
  it('falls back to neon-apex when ~/games cannot be listed, uses git when available, and bounds stat calls', async () => {
    const stats = { n: 0 };
    const m = await collectGame(deps({ files: { 'games/neon-apex/DEPLOYMENT.md': 'Production: https://acme-app.vercel.app\nVerified at: 2026-09-08T16:25:48+09:00' }, commit: '2026-10-28T01:00:00Z' }, stats));
    expect(m).toMatchObject({ state: 'ok', lastActivity: '2026-10-28T01:00:00.000Z', metrics: { '마지막 커밋': '2일 12시간 전', '배포': 'Vercel', '배포 검증': '2026-09-08' }, links: [{ label: 'Vercel', href: 'https://acme-app.vercel.app' }], sources: [{ name: 'git log', ok: true }] });
    expect(stats.n).toBeLessThanOrEqual(200);
    const big = gameFx();
    big.dirs!['games/neon-apex/dist'] = Array.from({ length: 300 }, (_, i) => `shot-${i}.png`);
    const s2 = { n: 0 };
    await collectGame(deps(big, s2));
    expect(s2.n).toBeLessThanOrEqual(200);
  });
  it('never leaks home paths or the vercel claim code', async () => {
    noHome(await collectGame(deps(gameFx({ changed: true }))));
    noHome(await collectGame(deps({})));
  });
});

describe('fmtBytes', () => {
  it('formats B / KB / MB', () => {
    expect(fmtBytes(934)).toBe('934 B');
    expect(fmtBytes(559482)).toBe('546 KB');
    expect(fmtBytes(18497751)).toBe('17.6 MB');
  });
});
