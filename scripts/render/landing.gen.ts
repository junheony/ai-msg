// Landing-page screenshot fixtures (i18n plan ③ Task 7): the real NewChat in home mode — the one-inbox dashboard —
// rendered to static HTML with synthetic data, once per language. Writes gen/landing-home.<locale>.html (work waiting
// and running) and gen/landing-clear.<locale>.html (nothing waiting), then:
//   npx tsx scripts/render/landing.gen.ts
//   RENDER_OUT=/tmp/aimsg-shots RENDER_HEIGHT=900 scripts/render-check.sh gen/landing-home.en 1440
// Until the composer's own strings are in the UI dictionaries, the few Korean ones it still renders are swapped for
// English below (UNTRANSLATED); the script refuses to write an English page with any Hangul left.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLocale, type Locale } from '../../src/shared/locale';
import { setFeatures } from '../../src/ui/features';
import { NewChat, type NewChatHome } from '../../src/ui/components/NewChat';
import type { HomeData } from '../../src/ui/components/HomeBoard';
import type { ProjectEntry, SessionEntry } from '../../src/shared/session-types';
import type { EngineProbe } from '../../src/shared/setup-types';
import type { UsageRow } from '../../src/shared/token-usage';
import type { AccountUsage, UsageSnapshot } from '../../src/shared/usage-types';

const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
const store = new Map<string, string>();
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
setFeatures(['grok']);

const UNTRANSLATED: [string, string][] = [
  ['무엇을 도와드릴까요?', 'What should we work on?'],
  ['첫 메시지', 'First message'],
  ['프로젝트', 'Project'],
  ['"고정"', '"Pinned"'],
  ['"최근"', '"Recent"'],
  ['사진·파일 첨부 (붙여넣기·끌어놓기도 됩니다)', 'Attach images or files (paste or drop works too)'],
  ['세션 설정 — 모델·계정·권한 (모델: 자동)', 'Session settings — model, account, permissions (model: Auto)'],
  ['세션 설정: app · Claude · 모델 자동', 'Session settings: app · Claude · model Auto'],
  ['첨부', 'Attach'],
];
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const TEXT = {
  en: {
    titles: ['Retry logic for payment webhooks', 'Token refresh bug on login', 'Polish the landing copy', 'Review the migration script', 'Weekly retro notes', 'Image optimisation pipeline', 'Tidy the CI cache keys', 'Summarise reading notes', 'Accessibility pass — contrast and focus', 'Evaluate a new log collector', 'Trip itinerary'],
    bucket: ['Flash · 5h', 'Pro · weekly'], qHeader: 'Tone', question: 'Which tone do you prefer?', task: 'npm run test:e2e — 41/120',
  },
  ko: {
    titles: ['결제 웹훅 재시도 로직', '로그인 토큰 갱신 버그', '랜딩 페이지 카피 다듬기', '마이그레이션 스크립트 점검', '주간 회고 정리', '이미지 최적화 파이프라인', 'CI 캐시 키 정리', '독서 메모 요약', '접근성 점검 — 대비와 포커스', '로그 수집기 교체 검토', '여행 일정표'],
    bucket: ['Flash · 5h', 'Pro · 주간'], qHeader: '톤 선택', question: '어떤 톤이 좋을까요?', task: 'npm run test:e2e — 41/120',
  },
} as const;

// A Sunday afternoon, so the date line and the week tab have something to say.
const now = new Date(2026, 9, 25, 14, 20).getTime();
const min = 60_000;
const app = '/Users/me/src/app', site = '/Users/me/src/site', notes = '/Users/me/notes';

function fixtures(locale: Locale) {
  const t = TEXT[locale];
  let n = 0;
  const id = () => `7c1e${String(n++).padStart(4, '0')}-2b9d-4f3a-8e6c-0a1b2c3d4e5f`;
  const s = (cwd: string, title: string, ago: number, extra: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: id(), cwd, projectDir: `/r${cwd}`, file: `/r${cwd}/f`, title, lastModified: now - ago * min, sizeBytes: 1, account: 'a', engine: 'claude', ...extra,
  } as SessionEntry);
  const T = t.titles;
  const list: SessionEntry[] = [
    s(app, T[0], 2), s(app, T[1], 9, { engine: 'codex', account: 'gpt' }), s(site, T[2], 14), s(app, T[3], 31), s(notes, T[4], 55),
    s(site, T[5], 80, { engine: 'gemini' }), s(app, T[6], 140), s(notes, T[7], 260, { engine: 'grok' }), s(site, T[8], 400), s(app, T[9], 1500), s(notes, T[10], 3000),
  ];
  const byCwd = new Map<string, SessionEntry[]>();
  for (const e of list) byCwd.set(e.cwd, [...(byCwd.get(e.cwd) ?? []), e]);
  const projects = [...byCwd].map(([cwd, sessions]) => ({ cwd, name: cwd.split('/').pop()!, pinned: cwd === app, sessions }) as ProjectEntry);
  const sid = (i: number) => list[i]!.sessionId;
  const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const acct = (weekly: number | null, resetH: number): AccountUsage => ({ status: 'ok', fetchedAt: iso(-1), fiveHour: null, weekly: weekly === null ? null : { usedPct: weekly, resetsAt: iso(resetH) }, fable: null });
  const usage = {
    generatedAt: iso(0), deckReachable: true,
    accounts: { a: acct(38, 70), b: acct(84, 30), c: acct(null, 0) },
    gpt: acct(52, 100),
    geminiSeats: { g1: { status: 'ok', fetchedAt: iso(-2), loggedIn: true, buckets: [{ name: t.bucket[0], usedPct: 12, resetsAt: iso(3) }, { name: t.bucket[1], usedPct: 41, resetsAt: iso(120) }] } },
    grokSeats: { x1: { status: 'ok', lastTurnAt: iso(-3), lastError: null, cooldownUntil: null, today: { inputTokens: 18_400, outputTokens: 3_100, turns: 4, day: '2026-10-25' }, billing: { usedPct: 23, windowStart: iso(-72), windowEnd: iso(96), tier: 'SuperGrok', fetchedAt: iso(-3) } } },
  } as unknown as UsageSnapshot;
  const probe = (engine: EngineProbe['engine'], version: string | null, login: EngineProbe['login']): EngineProbe => ({ engine, bin: version ? `/usr/local/bin/${engine}` : null, version, login, loginCommand: `${engine} login` });
  const engines = [probe('claude', '2.4.1', 'yes'), probe('codex', '0.161.0', 'yes'), probe('gemini', '1.4.2', 'yes'), probe('grok', '1.0.62', 'yes')];
  const row = (day: string, family: UsageRow['family'], input: number, output: number, cacheRead: number, messages: number): UsageRow =>
    ({ day, source: 'all', family, input, output, cacheRead, cacheWrite: 0, messages });
  const rows: UsageRow[] = [
    row('2026-10-25', 'opus', 2_100, 9_800, 410_000, 23), row('2026-10-25', 'sonnet', 900, 4_100, 120_000, 11), row('2026-10-25', 'gpt', 3_200, 12_000, 260_000, 17),
    row('2026-10-23', 'opus', 8_000, 41_000, 1_900_000, 96), row('2026-10-21', 'gpt', 6_000, 30_000, 900_000, 54), row('2026-10-20', 'fable', 2_000, 6_000, 300_000, 12),
  ];
  const data: HomeData = { engines, rows, scanning: false };
  const noop = () => {};
  const base = {
    projects, loaded: true, pins: [sid(0), sid(4)], defaultCwd: app, onStart: noop, onOpenSession: noop, now,
    codexAvailable: true, gemini: { available: true, loggedIn: { g1: true, g2: false } }, grok: { bin: true, version: '1.0.62' },
    draftKey: `fixture-landing-${locale}`, fetchFn: (() => Promise.reject(new Error('fixture'))) as unknown as typeof fetch,
  };
  const busy: NewChatHome = {
    activity: [
      { sessionId: sid(1), cwd: app, turnId: 't1', running: true, bg: 0, forMs: 6 * min },
      { sessionId: sid(5), cwd: site, turnId: 't2', running: true, bg: 0, forMs: 23 * min },
      { sessionId: sid(6), cwd: app, turnId: 't3', running: false, bg: 2, forMs: 0, tasks: [t.task] },
    ],
    unread: [sid(7), sid(8)],
    pending: [{ sessionId: sid(3), cwd: app, turnId: 'p', toolName: 'Bash', title: null, requestId: 'r1', input: {}, decisionReason: null, blockedPath: null, defaultToNo: false, allowSession: true, sessionLabel: null }],
    questions: [{ sessionId: sid(2), cwd: site, turnId: 'q', requestId: 'r2', questions: [{ header: t.qHeader, question: t.question, options: [], multiSelect: false }] }],
    usage, onMarkRead: noop, data,
  };
  const clear: NewChatHome = { ...busy, activity: [], pending: [], questions: [], unread: [sid(7), sid(8), sid(6)] };
  return { base, busy, clear };
}

const page = (locale: Locale, title: string, body: string) => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<!-- ${title} — generated by scripts/render/landing.gen.ts from the real NewChat (home mode); do not edit by hand. -->
<link rel="stylesheet" href="../../../src/ui/styles.css">
<script>
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

const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'gen');
mkdirSync(dir, { recursive: true });
for (const locale of ['en', 'ko'] as const) {
  setLocale(locale);
  const { base, busy, clear } = fixtures(locale);
  for (const [name, home] of [['landing-home', busy], ['landing-clear', clear]] as const) {
    let html = renderToStaticMarkup(createElement(NewChat, { ...base, home }));
    if (!html.includes('data-testid="home"')) throw new Error('NewChat did not render the home');
    if (locale === 'en') {
      for (const [ko, en] of UNTRANSLATED) html = html.split(ko).join(en);
      const left = html.match(new RegExp(`.{0,40}${HANGUL.source}.{0,40}`));
      if (left) throw new Error(`Hangul left in the English ${name}: ${left[0]}`);
    }
    writeFileSync(join(dir, `${name}.${locale}.html`), page(locale, name, html));
    process.stdout.write(`gen/${name}.${locale}.html written\n`);
  }
}
