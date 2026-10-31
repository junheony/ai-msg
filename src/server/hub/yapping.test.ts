import { describe, expect, it } from 'vitest';
import type { HubSection } from '../../shared/hub-types';
import { HUB_URLS, type HubDeps } from './shared';
import { DRAFT_OLD_DAYS, YAPPING_NEWS_URL, YAPPING_REPLIES_DONE_URL, YAPPING_REPLIES_TODO_URL, YAPPING_UNITS, collectYapping, rotationSteps, scanLogs } from './yapping';

const NOON = Date.parse('2026-10-30T03:00:00Z'); // 12:00 KST — 09:30 passed, 15:30 / 21:30 ahead
const NIGHT = Date.parse('2026-10-30T13:00:00Z'); // 22:00 KST — every slot passed
const DAWN = Date.parse('2026-10-29T17:00:00Z'); // 02:00 KST on the 30th — nothing passed yet
const HOME = '/Users/alice';
const isoAt = (base: number, offsetMs: number): string => new Date(base + offsetMs).toISOString();
const DAY = 86_400_000, H = 3_600_000;

interface Fx { urls?: Record<string, unknown>; files?: Record<string, string>; units?: Record<string, Record<string, string>>; now?: number }

/** Fake deps: canned GET answers keyed by full URL (query strings included), log tails relative to HOME, canned systemd units. */
function deps(fx: Fx): HubDeps & { calls: string[] } {
  const calls: string[] = [];
  const rel = (p: string): string => (p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p);
  return {
    calls,
    fetchJson: async (url) => { calls.push(url); const a = fx.urls?.[url]; if (a instanceof Error) throw a; if (a === undefined) throw new Error('fetch failed: ECONNREFUSED'); return a; },
    latestRender: async () => null,
    countEntries: async () => null,
    gitLastCommit: async () => null,
    readText: async (f) => fx.files?.[rel(f)] ?? null,
    readTail: async (f) => fx.files?.[rel(f)] ?? null,
    listDir: async () => null,
    fileMtime: async () => null,
    systemdShow: async (u) => fx.units?.[u] ?? (fx.units ? { LoadState: 'not-found', ActiveState: 'inactive' } : null),
    now: () => fx.now ?? NOON, self: () => ({ uptimeMs: 1000, sessions: 0, activeTurns: 0 }), host: 'h', home: HOME,
  };
}
const section = (secs: HubSection[], title: RegExp): HubSection | undefined => secs.find((s) => title.test(s.title));
const noHome = (v: unknown): void => { const s = JSON.stringify(v); expect(s).not.toContain(HOME); expect(s).not.toMatch(/\/home\/[a-z]/); expect(s).not.toContain('targets.json'); expect(s).not.toContain('run.json'); };

/* ───────── fixtures (shapes verified against the live :8095 responses) ───────── */

const fixtures = (now: number, over: { postedToday?: number; due?: boolean; submitted?: boolean } = {}): Record<string, unknown> => {
  const drafts = [
    { id: 2, news_id: 'n2', text: `오픈AI 사용량 한도 2배 정리 (${HOME}/yapping-bot/data/x)`, status: 'draft', created_at: isoAt(now, -1 * H), kind: 'ai_news_qt', project: null, campaign_id: null, sources: [{ kind: 'x', label: 'OpenAI', url: 'https://x.com/OpenAI/status/1' }], angle: '', issues: ['길이'], image_url: null },
    { id: 1, news_id: null, text: '요즘 나는 AI와 크립토 프로젝트를 볼 때 무엇을 할 수 있다는 설명보다 어떤 위험을 인정하는지부터 읽는다. '.repeat(3), status: 'draft', created_at: isoAt(now, -8 * DAY), kind: 'yap', project: 'primus_labs', campaign_id: 'camp_1', sources: [], angle: '', issues: [], image_url: null },
    { id: 3, text: 'posted already', status: 'posted', created_at: isoAt(now, -9 * DAY), kind: 'yap' },
  ];
  const posts = {
    drafts, posted: [{ id: 9, text: `Binance SAFU 정리 ${HOME}/p`, status: 'posted', posted_at: isoAt(now, -3 * H), tweet_id: '2116159584528441557', kind: 'lane_post' }, { id: 8, text: 'older', status: 'posted', posted_at: isoAt(now, -30 * H), tweet_id: '1', kind: 'ai_news_qt' }],
    auto_post: true, yap_autopost: false, x_api: { enabled: false, halted: false, reads: false, mode: 'live' },
    turn: { due: over.due ?? false, slot: '15:30', draft_id: null, next_slot: '2026-10-30T06:30:00Z' }, posted_today: over.postedToday ?? 0, cap: 3, slots: ['09:30', '15:30', '21:30'], next_slot: '2026-10-30T06:30:00Z', next_pick: 'news',
  };
  const news = {
    items: [
      { id: 'a', run_id: 'r1', created_at: isoAt(now, -20 * 60_000), company: '오픈AI', headline: `오픈AI, Private Intelligence (${HOME}/z)`, x_text: '', link: 'https://x.com/OpenAI/status/2', sources: [], status: 'new' },
      { id: 'b', run_id: 'r1', created_at: isoAt(now, -25 * 60_000), company: '커서', headline: '커서 보안 사고', x_text: '', link: 'https://x.com/cursor_ai/status/3', sources: [], status: 'new' },
      { id: 'c', run_id: 'r0', created_at: isoAt(now, -2 * DAY), company: 'x', headline: 'skipped', link: '', status: 'skipped' },
    ],
    tg_ready: false, running: false,
    last: { run_id: 'r1', trigger: 'schedule', gathered: 204, by_kind: { rss: 40, tg: 100, x_official: 64 }, candidates: 18, made: 2, llm_items: 2, secs: 40.2, file: `${HOME}/yapping-bot/data/ai_news/run.json`, at: isoAt(now, -22 * 60_000) },
    schedule: { hours_kst: [8, 19], minute: 40, post_style: 'quote', qt_interval_min: 90 },
    rotation: { news_today: 0, yap_today: 0, total_today: 0, news_target: 3, yap_target: 1, cap: 3, plan: [{ slot: '09:30', kind: 'news' }, { slot: '15:30', kind: 'yap' }, { slot: '21:30', kind: 'news' }], next_slot: '15:30', suggest: 'news' },
  };
  const yap = {
    autopost: false, drafting: true,
    campaigns: [{ project: 'Primus', handle: 'primus_labs', campaign_id: 'camp_1', epoch: 2, start: '2026-10-23', end: '2026-11-21', campaign: 'Primus S2', max_submissions: 10, top_count: 100, submitted: 1, pending_drafts: 2, days_left: 21, state: 'active' }],
    submit_links: [
      { tweet_id: '111', url: 'https://x.com/cblabx/status/111', project: 'Primus', handle: 'primus_labs', campaign_id: 'camp_1', epoch: 2, draft_id: 5, posted_at: isoAt(now, -7 * DAY), submitted_at: over.submitted ? isoAt(now, -6 * DAY) : null },
      { tweet_id: '110', url: 'https://x.com/cblabx/status/110', project: 'Primus', handle: 'primus_labs', campaign_id: 'camp_1', epoch: 1, draft_id: 4, posted_at: isoAt(now, -9 * DAY), submitted_at: isoAt(now, -9 * DAY + H) },
    ],
    limits: { per_day: 1 },
  };
  const status = {
    mode: 'live', model: 'codex CLI', llm: true, todo: 1, ai_news_pending: 68, replies_done_today: 7,
    inbox: { dir: `${HOME}/yapping-bot/inbox`, targets_file: `${HOME}/yapping-bot/targets.json`, pending: 0, checked_at: isoAt(now, -60_000) },
    costs: { today: { llm_usd: 0, x_usd: 0, x_reads: 0, x_read_budget: 0, llm_purposes: [{ purpose: 'news', calls: 3 }, { purpose: 'reply', calls: 5 }] } },
    last_jobs: [{ job: 'tg_engage', finished: isoAt(now, -2 * 60_000), ok: 1 }, { job: 'expire', finished: isoAt(now, -3 * 60_000), ok: 1 }],
    banners: [{ level: 'info', text: `X API 꺼짐 (x_api.enabled=false) — 게시·팔로우는 확장으로 직접 (${HOME}/yapping-bot/.env)` }],
  };
  const metrics = { posts: [{ created_at: isoAt(now, -3 * H) }], snapshots: [{ followers: 498 }, { followers: 502 }] };
  return {
    [HUB_URLS.yappingStatus]: status, [HUB_URLS.yappingMetrics]: metrics, [HUB_URLS.yappingPosts]: posts, [YAPPING_NEWS_URL]: news, [HUB_URLS.yappingYap]: yap,
    [YAPPING_REPLIES_TODO_URL]: { items: [], done_today: 7, warn_at: 100 }, [YAPPING_REPLIES_DONE_URL]: { items: [{}, {}, {}, {}], done_today: 7, warn_at: 100 },
  };
};
const UNITS: Record<string, Record<string, string>> = {
  [YAPPING_UNITS.service]: { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', ActiveEnterTimestamp: 'Thu 2026-10-29 15:27:00 UTC', NRestarts: '0' },
  ...Object.fromEntries(YAPPING_UNITS.timers.flatMap((t) => [
    [t.timer, { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', LastTriggerUSec: 'Fri 2026-10-30 02:50:00 UTC', NextElapseUSecRealtime: 'Fri 2026-10-30 03:05:00 UTC' }],
    [t.service, { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', Result: 'success' }],
  ])),
};
const LOG = `2026-10-30 11:50:01,123 ERROR yb.sched: job ai_news failed: all LLM backends failed: codex exit -15 (${HOME}/yapping-bot/x)\n2026-10-30 11:55:00,000 INFO ok\n`;

/* ───────── pure helpers ───────── */

describe('yapping helpers', () => {
  const PLAN = [{ slot: '09:30', kind: 'news' }, { slot: '15:30', kind: 'yap' }, { slot: '21:30', kind: 'news' }];
  it('rotationSteps: before the first slot everything is ahead, the first is active', () => {
    expect(rotationSteps(PLAN, '02:00', 0, false)).toEqual([{ label: '09:30 뉴스', state: 'active', hint: '다음 슬롯' }, { label: '15:30 yap', state: 'todo' }, { label: '21:30 뉴스', state: 'todo' }]);
    expect(rotationSteps(PLAN, '02:00', 0, true)[0]!.hint).toBe('지금 차례');
  });
  it('rotationSteps: a passed slot is done when the day has that many posts, otherwise blocked', () => {
    expect(rotationSteps(PLAN, '12:00', 1, false).map((s) => s.state)).toEqual(['done', 'active', 'todo']);
    expect(rotationSteps(PLAN, '12:00', 0, false).map((s) => s.state)).toEqual(['blocked', 'active', 'todo']);
    expect(rotationSteps(PLAN, '12:00', 0, false)[0]!.hint).toBe('지남 · 게시 없음');
    expect(rotationSteps(PLAN, '22:00', 3, false).map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(rotationSteps(PLAN, '22:00', 1, false).map((s) => s.state)).toEqual(['done', 'blocked', 'blocked']);
    expect(rotationSteps([], '12:00', 0, false)).toEqual([]);
  });
  it('scanLogs counts recent errors and finds 402 credit exhaustion', () => {
    const s = scanLogs([LOG, null, '2026-10-30 10:00:00,000 ERROR x: 402 Payment Required credits depleted job=free_x\n'], NOON);
    expect(s.errors24h).toBe(2);
    expect(s.last402).toMatchObject({ count: 1, job: 'free_x' });
    expect(s.recentErrors[0]!.text).not.toContain(HOME);
  });
});

/* ───────── collector ───────── */

describe('collectYapping', () => {
  it('at noon: shows the day queue, the missed morning slot, old drafts, the unsubmitted yap link and X API off', async () => {
    const d = deps({ urls: fixtures(NOON), units: UNITS, files: { 'yapping-bot/logs/yb.log': LOG }, now: NOON });
    const m = await collectYapping(d);
    expect(m.state).toBe('warn');
    expect(m.tag).toBe('LIVE');
    expect(m.page!.headline).toBe('오늘 0/3 게시 · 초안 2 대기(최고 10-22) · AI 뉴스 신규 2 · 미제출 yap 1 · X API 꺼짐');
    expect(m.page!.decision).toBe('15:30 슬롯 yap 초안 고르기 (대기 1) · Primus yap 링크 제출 1건');
    expect(m.page!.kpis.map((k) => k.label)).toEqual(['오늘 게시', '대기 초안', '미제출 yap', '뉴스 수집', '리플 todo / done', 'X API']);
    expect(m.page!.kpis[0]).toMatchObject({ value: '0/3', status: 'warn', hint: '다음 10-30 15:30' });
    expect(m.page!.kpis[1]).toMatchObject({ value: '2', status: 'warn', hint: `최고 8일 전 · ${DRAFT_OLD_DAYS}일+ 1건` });
    expect(m.page!.kpis[2]).toMatchObject({ value: '1', status: 'warn' });
    expect(m.page!.kpis[3]!.value).toBe('204 → 18 → 2');
    expect(m.page!.kpis[4]!.value).toBe('0 / 7');
    expect(m.page!.kpis[5]).toMatchObject({ value: '꺼짐', status: 'info' });
    expect(m.page!.sections.map((s) => s.title)).toEqual(['오늘 로테이션', '대기 초안', '미제출 yap 링크', '최근 게시', 'AI 뉴스 마지막 수집', '신규 AI 뉴스 상위 10', '캠페인', '리플 · 캠페인 · X API', '서비스 · 타이머 · 비용', 'x.com/cblabx']);
    const steps = section(m.page!.sections, /^오늘 로테이션$/)!;
    if (steps.kind === 'steps') { expect(steps.open).toBe(true); expect(steps.items.map((s) => `${s.label}:${s.state}`)).toEqual(['09:30 뉴스:blocked', '15:30 yap:active', '21:30 뉴스:todo']); }
    const drafts = section(m.page!.sections, /^대기 초안$/)!;
    if (drafts.kind === 'table') {
      expect(drafts.open).toBe(true);
      expect(drafts.columns).toEqual(['생성', '종류', '이슈', '텍스트', '출처']);
      expect(drafts.rows).toHaveLength(2); // the posted one is not a draft
      expect(drafts.rows[0]!.slice(0, 3)).toEqual(['10-22 12:00', 'yap', '—']); // oldest first
      expect(drafts.rows[0]![3]!.length).toBeLessThanOrEqual(120);
      expect(drafts.rows[0]![4]).toBe('primus_labs · camp_1');
      expect(drafts.rows[1]!.slice(1, 3)).toEqual(['AI 뉴스 QT', '길이']);
      expect(drafts.rows[1]![4]).toBe('OpenAI · https://x.com/OpenAI/status/1');
      expect(drafts.wrap).toEqual([3]);
    }
    const yap = section(m.page!.sections, /^미제출 yap 링크$/)!;
    if (yap.kind === 'list') { expect(yap.open).toBe(true); expect(yap.items[0]).toMatchObject({ level: 'warn', text: 'Primus · 게시 10-23 12:00 · https://x.com/cblabx/status/111' }); expect(yap.items[1]!.level).toBe('ok'); }
    const posted = section(m.page!.sections, /^최근 게시$/)!;
    if (posted.kind === 'table') { expect(posted.rows[0]![3]).toBe('https://x.com/i/status/2116159584528441557'); expect(posted.rows[0]![1]).toBe('레인 포스트'); expect(posted.rows[0]![2]).toBe('Binance SAFU 정리 …'); }
    const news = section(m.page!.sections, /^AI 뉴스 마지막 수집$/)!;
    if (news.kind === 'kv') { expect(news.open).toBe(true); expect(news.rows[1]![1]).toBe('204 → 18 → 2 (LLM 2) · 40초'); expect(news.rows[2]![1]).toBe('rss 40 · tg 100 · x_official 64'); expect(news.rows[4]![1]).toBe('08:40, 19:40 KST · quote · QT 간격 90분'); }
    const top = section(m.page!.sections, /^신규 AI 뉴스/)!;
    if (top.kind === 'table') { expect(top.rows).toHaveLength(2); expect(top.rows[0]![2]).toBe('오픈AI, Private Intelligence (…)'); }
    const ops = section(m.page!.sections, /^서비스 · 타이머 · 비용$/)!;
    if (ops.kind === 'kv') { expect(ops.open ?? false).toBe(false); expect(ops.rows[0]![1]).toMatch(/^가동 · /); expect(ops.rows.find(([k]) => k === '팔로워')![1]).toBe('502 (498 → 502)'); expect(ops.rows.find(([k]) => k === '오류 24h')![1]).toBe('1'); }
    const texts = m.alerts.map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining([`초안 1건 ${DRAFT_OLD_DAYS}일 이상 대기 · 최고 10-22 12:00`, 'Primus yap 링크 미제출 · 게시 10-23 12:00', '09:30 뉴스 슬롯 지남 · 게시 없음']));
    expect(texts.filter((t) => /X API 꺼짐/.test(t))).toHaveLength(1); // the banner covers it; no duplicate
    expect(m.alerts.find((a) => /X API 꺼짐/.test(a.text))!.level).toBe('info');
    expect(m.alerts.find((a) => /로그 오류/.test(a.text))!.text).not.toContain(HOME);
    expect(m.metrics).toEqual({ '오늘 게시': '0/3', '대기 초안': 2, '미제출 yap': 1, '오늘 답글': 7, '오류 24h': 1 });
    expect(m.links).toEqual([{ label: 'x.com/cblabx', href: 'https://x.com/cblabx' }]);
    expect(m.sources.map((s) => s.name)).toEqual(['/api/status', '/api/metrics', '/api/posts', '/api/ai_news', '/api/yap', '/api/replies todo', '/api/replies done', 'systemd', '로그']);
    // GET-only surface: no briefing, no ext=, days=3 on ai_news
    expect(d.calls.some((u) => /briefing|ext=/.test(u))).toBe(false);
    expect(d.calls).toContain(YAPPING_NEWS_URL);
    expect(YAPPING_NEWS_URL).toMatch(/days=3$/);
    noHome(m);
  });
  it('at 02:00 KST nothing has passed: the first slot is active and no slot alert fires; due turn says 지금 차례', async () => {
    const m = await collectYapping(deps({ urls: fixtures(DAWN, { due: true }), units: UNITS, now: DAWN }));
    const steps = section(m.page!.sections, /^오늘 로테이션$/)!;
    if (steps.kind === 'steps') expect(steps.items.map((s) => `${s.state}:${s.hint ?? ''}`)).toEqual(['active:지금 차례', 'todo:', 'todo:']);
    expect(m.alerts.some((a) => /슬롯 지남/.test(a.text))).toBe(false);
    expect(m.page!.decision).toMatch(/^09:30 슬롯 뉴스 초안 고르기 \(대기 1\)/);
    expect(m.page!.kpis[0]!.status).toBe('info');
  });
  it('at 22:00 KST with all posts made: every slot done, decision points at tomorrow; no draft/yap warnings when fresh', async () => {
    const m = await collectYapping(deps({ urls: fixtures(NIGHT, { postedToday: 3, submitted: true }), units: UNITS, now: NIGHT }));
    const steps = section(m.page!.sections, /^오늘 로테이션$/)!;
    if (steps.kind === 'steps') expect(steps.items.every((s) => s.state === 'done')).toBe(true);
    expect(m.page!.kpis[0]).toMatchObject({ value: '3/3', status: 'ok' });
    expect(m.page!.decision).toBe('오늘 슬롯 끝 · 내일 09:30 슬롯 초안 미리 고르기 (대기 2)');
    expect(m.page!.headline).toContain('미제출 yap 0');
    expect(m.alerts.some((a) => /미제출/.test(a.text))).toBe(false);
    const yap = section(m.page!.sections, /^미제출 yap 링크$/)!;
    if (yap.kind === 'list') { expect(yap.open).toBe(false); expect(yap.items.every((i) => i.level === 'ok')).toBe(true); }
  });
  it('falls back to /api/posts slots when ai_news is down and tolerates a replies answer without items', async () => {
    const urls = fixtures(NOON);
    delete urls[YAPPING_NEWS_URL];
    urls[YAPPING_REPLIES_DONE_URL] = { done_today: 7, warn_at: 100 };
    urls[YAPPING_REPLIES_TODO_URL] = new Error('HTTP 500');
    const m = await collectYapping(deps({ urls, units: UNITS, now: NOON }));
    expect(m.page!.headline).toBe('오늘 0/3 게시 · 초안 2 대기(최고 10-22) · 미제출 yap 1 · X API 꺼짐');
    const steps = section(m.page!.sections, /^오늘 로테이션$/)!;
    if (steps.kind === 'steps') expect(steps.items.map((s) => s.label)).toEqual(['09:30 —', '15:30 —', '21:30 —']);
    expect(m.page!.kpis[3]!.value).toBe('—');
    expect(m.page!.kpis[4]!.value).toBe('1 / 7'); // todo from /api/status, done from /api/replies?status=done
    expect(m.alerts.some((a) => a.text.startsWith('/api/ai_news 응답 없음'))).toBe(true);
    const news = section(m.page!.sections, /^AI 뉴스 마지막 수집$/)!;
    if (news.kind === 'kv') expect(news.rows[0]![1]).toMatch(/^응답 없음/);
    noHome(m);
  });
  it('is down when the service unit is failed, unknown when nothing answers', async () => {
    const units = { ...UNITS, [YAPPING_UNITS.service]: { LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed' } };
    const down = await collectYapping(deps({ urls: fixtures(NOON), units, now: NOON }));
    expect(down.state).toBe('down');
    expect(down.alerts[0]).toMatchObject({ level: 'bad', text: '서비스 실패 (failed)' });
    expect(down.page!.decision).toBe('서비스 정지 — 로그 확인 (여기서 재시작하지 않음)');
    const none = await collectYapping(deps({ urls: {}, units: {}, now: NOON }));
    expect(none.state).toBe('unknown');
    expect(none.page!.headline).toBe('상태 확인 불가');
    noHome(none);
  });
  it('marks a 402 credit exhaustion in the last day as bad and leads the decision with it', async () => {
    const log = '2026-10-30 11:00:00,000 ERROR x: 402 credits depleted job=free_x\n';
    const m = await collectYapping(deps({ urls: fixtures(NOON), units: UNITS, files: { 'yapping-bot/logs/free_x_collector.log': log }, now: NOON }));
    expect(m.alerts[0]).toMatchObject({ level: 'bad', text: 'X API 402 크레딧 소진 1회 · 마지막 10-30 11:00 · free_x' });
    expect(m.page!.decision).toBe('402 크레딧 소진 — X API 크레딧 확인');
  });
});
