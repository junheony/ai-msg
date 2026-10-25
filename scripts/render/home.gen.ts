// Home dashboard fixtures: the real NewChat in home mode rendered to static HTML (as sidebar.gen.ts does for the
// sidebar), with fixed data in place of the two fetches. Writes home.html (prompts waiting, work running) and
// home-clear.html (nothing waiting, unread threads), then:
//   npx tsx scripts/render/home.gen.ts
//   RENDER_HEIGHT=1500 scripts/render-check.sh home 1440 940 390        (RENDER_THEME=light for the light theme)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLocale } from '../../src/shared/locale';
import { setFeatures } from '../../src/ui/features';
import { NewChat, type NewChatHome } from '../../src/ui/components/NewChat';
import type { HomeData } from '../../src/ui/components/HomeBoard';
import type { ProjectEntry, SessionEntry } from '../../src/shared/session-types';
import type { EngineProbe } from '../../src/shared/setup-types';
import type { UsageRow } from '../../src/shared/token-usage';
import type { AccountUsage, UsageSnapshot } from '../../src/shared/usage-types';

setLocale('ko');
// The composer reads a few browser globals while it renders (speech input, drafts, the phone check): bare stand-ins.
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
setFeatures(['grok']);
// A Sunday afternoon, so the date line and the week tab have something to say.
const now = new Date(2026, 9, 25, 14, 20).getTime();
const min = 60_000;
let n = 0;
const id = () => `7c1e${String(n++).padStart(4, '0')}-2b9d-4f3a-8e6c-0a1b2c3d4e5f`;
const s = (cwd: string, title: string, ago: number, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: id(), cwd, projectDir: `/r${cwd}`, file: `/r${cwd}/f`, title, lastModified: now - ago * min, sizeBytes: 1, account: 'a', engine: 'claude', ...extra,
} as SessionEntry);

const app = '/Users/me/src/app', site = '/Users/me/src/site', notes = '/Users/me/notes';
const list: SessionEntry[] = [
  s(app, '결제 웹훅 재시도 로직', 2),
  s(app, '로그인 토큰 갱신 버그', 9, { engine: 'codex', account: 'gpt' }),
  s(site, '랜딩 페이지 카피 다듬기', 14),
  s(app, '마이그레이션 스크립트 점검', 31),
  s(notes, '주간 회고 정리', 55),
  s(site, '이미지 최적화 파이프라인', 80, { engine: 'gemini' }),
  s(app, 'CI 캐시 키 정리', 140),
  s(notes, '독서 메모 요약', 260, { engine: 'grok' }),
  s(site, '접근성 점검 — 대비와 포커스', 400),
  s(app, '로그 수집기 교체 검토', 1500),
  s(notes, '여행 일정표', 3000),
];
const byCwd = new Map<string, SessionEntry[]>();
for (const e of list) byCwd.set(e.cwd, [...(byCwd.get(e.cwd) ?? []), e]);
const projects = [...byCwd].map(([cwd, sessions]) => ({ cwd, name: cwd.split('/').pop()!, pinned: cwd === app, sessions }) as ProjectEntry);
const at = (title: string) => list.find((e) => e.title === title)!;
const sid = (title: string) => at(title).sessionId;

const iso = (hoursFromNow: number) => new Date(now + hoursFromNow * 3_600_000).toISOString();
const acct = (weekly: number | null, resetH: number): AccountUsage => ({ status: 'ok', fetchedAt: iso(-1), fiveHour: null, weekly: weekly === null ? null : { usedPct: weekly, resetsAt: iso(resetH) }, fable: null });
const usage = {
  generatedAt: iso(0), deckReachable: true,
  accounts: { a: acct(38, 70), b: acct(84, 30), c: acct(null, 0) },
  gpt: acct(52, 100),
  geminiSeats: { g1: { status: 'ok', fetchedAt: iso(-2), loggedIn: true, buckets: [{ name: 'Flash · 5h', usedPct: 12, resetsAt: iso(3) }, { name: 'Pro · 주간', usedPct: 41, resetsAt: iso(120) }] } },
  grokSeats: { x1: { status: 'ok', lastTurnAt: iso(-3), lastError: null, cooldownUntil: null, today: { inputTokens: 18_400, outputTokens: 3_100, turns: 4, day: '2026-10-25' }, billing: { usedPct: 23, windowStart: iso(-72), windowEnd: iso(96), tier: 'SuperGrok', fetchedAt: iso(-3) } } },
  grokBot: { percentUsed: 61, nextResetMs: now + 50 * 3_600_000, planLabel: 'Heavy', readAtMs: now - 3_600_000 },
} as unknown as UsageSnapshot;

const probe = (engine: EngineProbe['engine'], version: string | null, login: EngineProbe['login']): EngineProbe => ({ engine, bin: version ? `/usr/local/bin/${engine}` : null, version, login, loginCommand: `${engine} login` });
const engines = [probe('claude', '2.4.1', 'yes'), probe('codex', '0.161.0', 'yes'), probe('gemini', '1.4.2', 'no'), probe('grok', '1.0.62', 'unknown')];
const row = (day: string, family: UsageRow['family'], input: number, output: number, cacheRead: number, messages: number): UsageRow =>
  ({ day, source: 'all', family, input, output, cacheRead, cacheWrite: 0, messages });
const rows: UsageRow[] = [
  row('2026-10-25', 'opus', 2_100, 9_800, 410_000, 23), row('2026-10-25', 'sonnet', 900, 4_100, 120_000, 11), row('2026-10-25', 'gpt', 3_200, 12_000, 260_000, 17),
  row('2026-10-23', 'opus', 8_000, 41_000, 1_900_000, 96), row('2026-10-21', 'gpt', 6_000, 30_000, 900_000, 54), row('2026-10-20', 'fable', 2_000, 6_000, 300_000, 12),
];
const data: HomeData = { engines, rows, scanning: false };

const noop = () => {};
const base = {
  projects, loaded: true, pins: [sid('결제 웹훅 재시도 로직'), sid('주간 회고 정리')], defaultCwd: app, onStart: noop, onOpenSession: noop, now,
  codexAvailable: true, gemini: { available: true, loggedIn: { g1: false, g2: false } }, grok: { bin: true, version: '1.0.62' },
  draftKey: 'fixture-home', fetchFn: (() => Promise.reject(new Error('fixture'))) as unknown as typeof fetch,
};
const busy: NewChatHome = {
  activity: [
    { sessionId: sid('로그인 토큰 갱신 버그'), cwd: app, turnId: 't1', running: true, bg: 0, forMs: 6 * min },
    { sessionId: sid('이미지 최적화 파이프라인'), cwd: site, turnId: 't2', running: true, bg: 0, forMs: 23 * min },
    { sessionId: sid('CI 캐시 키 정리'), cwd: app, turnId: 't3', running: false, bg: 2, forMs: 0, tasks: ['npm run test:e2e — 41/120'] },
  ],
  unread: [sid('독서 메모 요약'), sid('접근성 점검 — 대비와 포커스')],
  pending: [{ sessionId: sid('마이그레이션 스크립트 점검'), cwd: app, turnId: 'p', toolName: 'Bash', title: null, requestId: 'r1', input: {}, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null }],
  questions: [{ sessionId: sid('랜딩 페이지 카피 다듬기'), cwd: site, turnId: 'q', requestId: 'r2', questions: [{ header: '톤 선택', question: '어떤 톤이 좋을까요?', options: [], multiSelect: false }] }],
  usage, onMarkRead: noop, data,
};
const clear: NewChatHome = { ...busy, activity: [], pending: [], questions: [], unread: [sid('독서 메모 요약'), sid('접근성 점검 — 대비와 포커스'), sid('CI 캐시 키 정리')] };

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8">
<!-- ${title} — generated by scripts/render/home.gen.ts from the real NewChat (home mode); do not edit by hand. RENDER_HEIGHT=1500. -->
<link rel="stylesheet" href="../../src/ui/styles.css">
<script>
  // useIsPhone phoneMode(), as the app sets it before the first paint: a 720px-wide window, or a touch screen whose short side is 640 or less.
  (() => {
    const touchPhone = Math.min(screen.width, screen.height) <= 640 && matchMedia('(pointer: coarse)').matches;
    const phone = touchPhone || matchMedia('(max-width: 720px)').matches;
    const mode = !phone ? '' : touchPhone && (screen.orientation?.type ?? '').startsWith('landscape') ? 'landscape' : 'portrait';
    if (mode) document.documentElement.setAttribute('data-phone', mode);
  })();
</script>
<style>
  body { margin: 0; background: var(--bg); }
  .fx-pane { height: 100vh; display: flex; flex-direction: column; }
</style>
</head><body>
<div class="fx-pane">${body}</div>
</body></html>
`;

const dir = fileURLToPath(new URL('.', import.meta.url));
for (const [name, home, label] of [['home', busy, '홈 — 대기·실행 중'], ['home-clear', clear, '홈 — 모두 처리됨']] as const) {
  const html = renderToStaticMarkup(createElement(NewChat, { ...base, home }));
  if (!html.includes('data-testid="home"')) throw new Error('NewChat did not render the home');
  writeFileSync(join(dir, `${name}.html`), page(label, html));
  process.stdout.write(`${name}.html written\n`);
}
