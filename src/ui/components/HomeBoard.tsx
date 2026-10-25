import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { EngineKind } from '../../shared/models';
import type { GeminiStatus, GrokStatus, SessionActivity } from '../../shared/protocol';
import type { ProjectEntry } from '../../shared/session-types';
import type { EngineProbe, LoginState, SetupStatus } from '../../shared/setup-types';
import { localDay, type UsageHistory, type UsageRow } from '../../shared/token-usage';
import type { UsageSnapshot } from '../../shared/usage-types';
import { useAccounts } from '../accounts';
import { formatDateTime, formatNumber, ui } from '../i18n';
import {
  agoParts, cachedJson, historyRows, homeLists, providerRows, providerState, recentByProject, setupEngines, untilParts, usageTotals,
  type HomeItem, type ProviderState, type UsageTab,
} from '../home';
import type { PendingPermission, PendingQuestion } from '../state';
import { EngineBadge, EngineMark, engineName } from './EngineMark';
import { BrandMark } from './BrandMark';
import { CheckIcon, PinIcon } from './icons';
import { shownPct, levelClass } from './usageSeats';
import { fmtCost, fmtTokens } from './UsageView';

const HISTORY_URL = '/api/usage/history?days=14';
const SETUP_URL = '/api/setup';
const REFRESH_MS = 60_000;
const RECENT_LIMIT = 8;
const ENGINE_ORDER: EngineKind[] = ['claude', 'codex', 'gemini', 'grok'];

/** undefined = still loading, null = could not load (the section says so quietly). */
export type HomeData = { engines: EngineProbe[] | null | undefined; rows: UsageRow[] | null | undefined; scanning: boolean };

/**
 * `/api/setup` and `/api/usage/history`, read only while the home is mounted (an empty single pane), then once a
 * minute while the tab is visible and again as soon as it shows; the answers are shared for ~50 s across panes and
 * remounts (home.ts cachedJson). `skip` (a render fixture brings its own data): nothing is fetched.
 */
export function useHomeData(fetchFn: typeof fetch, skip = false): HomeData {
  const [data, setData] = useState<HomeData>({ engines: undefined, rows: undefined, scanning: false });
  useEffect(() => {
    if (skip) return;
    let live = true;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const load = () => {
      if (hidden()) return;
      void Promise.all([cachedJson<SetupStatus>(SETUP_URL, fetchFn), cachedJson<UsageHistory>(HISTORY_URL, fetchFn)]).then(([setup, history]) => {
        if (!live) return;
        setData({ engines: setupEngines(setup), rows: historyRows(history), scanning: history?.scanning === true });
      });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', load);
    return () => {
      live = false;
      clearInterval(id);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', load);
    };
  }, [fetchFn, skip]);
  return data;
}

/** `fixed` when given (tests, render fixtures); otherwise the clock, moved on at each whole minute (the "N분 전" texts). */
export function useMinuteNow(fixed?: number): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    let id: ReturnType<typeof setTimeout>;
    const arm = () => { id = setTimeout(() => { setTick(Date.now()); arm(); }, 60_000 - (Date.now() % 60_000)); };
    arm();
    return () => clearTimeout(id);
  }, [fixed]);
  return fixed ?? tick;
}

function agoText(ms: number, now: number): string {
  const p = agoParts(ms, now);
  const t = ui().home.ago;
  return p.unit === 'now' ? t.now : t[p.unit](p.n);
}

function elapsedText(ms: number): string {
  const p = agoParts(0, ms);
  const t = ui().home.elapsed;
  return p.unit === 'now' ? t.minutes(1) : t[p.unit](p.n);
}

/** "10월 25일 일요일 · 2개 검토 대기 · 오늘 $0.04": the date, then only the parts that say something. */
export function homeDateLine(now: number, waiting: number, todayCost: number | null): string {
  const h = ui().home;
  const parts = [formatDateTime(now, { month: 'long', day: 'numeric', weekday: 'long' })];
  if (waiting > 0) parts.push(h.waitingCount(waiting));
  if (todayCost !== null && todayCost > 0) parts.push(h.todayCost(fmtCost(todayCost)));
  return parts.join(' · ');
}

export function homeGreeting(hour: number): string {
  const g = ui().home.greeting;
  if (hour >= 5 && hour < 11) return g.morning;
  if (hour >= 11 && hour < 17) return g.afternoon;
  if (hour >= 17 && hour < 22) return g.evening;
  return g.late;
}

function Card({ title, count, className = '', children, aside }: { title: string; count?: number; className?: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section className={`home-card ${className}`.trim()} aria-labelledby={id}>
      <header className="home-card-head">
        <h2 id={id}>{title}</h2>
        {count !== undefined && count > 0 && <span className="home-count">{count}</span>}
        {aside}
      </header>
      {children}
    </section>
  );
}

type Open = (sessionId: string, cwd: string, title: string) => void;

function Row({ item, meta, tail, open, tone }: { item: HomeItem; meta: ReactNode; tail?: ReactNode; open?: Open | undefined; tone?: string }) {
  return (
    <li>
      <button type="button" className={`home-row${tone ? ` ${tone}` : ''}`} title={`${item.title}\n${item.cwd}`} disabled={!open} onClick={() => open?.(item.sessionId, item.cwd, item.title)}>
        <span className="home-row-main">
          <span className="home-row-title"><EngineMark engine={item.engine} decorative />{item.title}</span>
          <span className="home-row-meta">{meta}</span>
        </span>
        {tail && <span className="home-row-tail">{tail}</span>}
      </button>
    </li>
  );
}

/**
 * 확인 필요 · 실행 중 · 최근: the main column under the composer. Memoised on the store slices only, so typing in the
 * composer above (NewChat's own state) recomputes nothing here.
 */
export const HomeLists = memo(function HomeLists({ projects, activity, unread, pending, questions, pins, now, onOpenSession, onMarkRead }: {
  projects: ProjectEntry[];
  activity: readonly SessionActivity[];
  unread: readonly string[];
  pending: readonly PendingPermission[];
  questions: readonly PendingQuestion[];
  pins: readonly string[];
  now: number;
  onOpenSession?: Open | undefined;
  onMarkRead?: ((ids: string[]) => void) | undefined;
}) {
  const h = ui().home;
  const lists = useMemo(() => homeLists({ projects, activity, unread, pending, questions }), [projects, activity, unread, pending, questions]);
  const [unreadOpen, setUnreadOpen] = useState(false);
  const { pinned, recent } = useMemo(() => {
    // Pin order by id (the first place a repeated id holds).
    const order = new Map<string, number>();
    pins.forEach((id, i) => { if (!order.has(id)) order.set(id, i); });
    const pinnedItems = recentByProject(projects.map((p) => ({ ...p, sessions: p.sessions.filter((s) => order.has(s.sessionId)) })), new Set(), order.size)
      .flatMap((g) => g.items).sort((a, b) => order.get(a.sessionId)! - order.get(b.sessionId)!);
    const exclude = new Set(order.keys());
    for (const x of [...lists.waiting, ...lists.running, ...lists.unread]) exclude.add(x.sessionId);
    return { pinned: pinnedItems, recent: recentByProject(projects, exclude, RECENT_LIMIT) };
  }, [projects, pins, lists]);
  // 모두 읽음: every unread session the home shows, wherever it is listed (a waiting or running one too), so no
  // sidebar dot is left behind.
  const unreadShown = useMemo(() => {
    const u = new Set(unread);
    return [...lists.waiting, ...lists.running, ...lists.unread].map((x) => x.sessionId).filter((id) => u.has(id));
  }, [lists, unread]);
  const unreadId = useId();

  return (
    <>
      <Card title={h.attention.title} count={lists.waiting.length} className="home-attention">
        {lists.waiting.length > 0 ? (
          <ul className="home-list">
            {lists.waiting.map((w) => (
              <Row key={w.sessionId} item={w} open={onOpenSession} tone="waiting"
                meta={<>{w.project}{w.detail && w.kind === 'question' ? ` · ${w.detail}` : ''}</>}
                tail={<span className="home-tag warn">{w.kind === 'permission' ? h.attention.permission(w.detail) : h.attention.question}</span>} />
            ))}
          </ul>
        ) : (
          <p className="home-clear"><span className="home-clear-mark" aria-hidden="true"><CheckIcon /></span><strong>{h.attention.allClear}</strong><span className="home-clear-note">{h.attention.allClearNote}</span></p>
        )}
        {lists.unread.length > 0 && (
          <div className="home-unread">
            <div className="home-unread-bar">
              <button type="button" className="home-disclose" aria-expanded={unreadOpen} aria-controls={unreadId} onClick={() => setUnreadOpen((v) => !v)}>
                <span className="home-chevron" aria-hidden="true" />{h.attention.unread(lists.unread.length)}
              </button>
              {onMarkRead && <button type="button" className="btn ghost home-markall" onClick={() => onMarkRead(unreadShown)}>{h.attention.markAll}</button>}
            </div>
            {unreadOpen && (
              <ul className="home-list" id={unreadId}>
                {lists.unread.map((u) => (
                  <Row key={u.sessionId} item={u} open={onOpenSession} meta={<>{u.project}{u.lastModified ? ` · ${agoText(u.lastModified, now)}` : ''}</>}
                    tail={<span className="home-tag accent"><span className="home-dot" aria-hidden="true" />{h.attention.unreadTag}</span>} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
      <Card title={h.running.title} count={lists.running.length} className="home-running">
        {lists.running.length > 0 ? (
          <ul className="home-list">
            {lists.running.map((r) => (
              <Row key={r.sessionId} item={r} open={onOpenSession}
                meta={<>{r.project}{r.tasks[0] ? ` · ${r.tasks[0]}` : r.bg > 0 ? ` · ${h.running.bg(r.bg)}` : ''}</>}
                tail={<span className={`home-tag ${r.running ? 'ok' : 'muted'}`}><span className={`home-dot${r.running ? ' pulse' : ''}`} aria-hidden="true" />{r.running ? elapsedText(r.forMs) : h.running.tasks(r.bg)}</span>} />
            ))}
          </ul>
        ) : <p className="home-empty">{h.running.empty}</p>}
      </Card>
      <Card title={h.recent.title} className="home-recent">
        {pinned.length === 0 && recent.length === 0 && <p className="home-empty">{h.recent.empty}</p>}
        {pinned.length > 0 && (
          <div className="home-group">
            <h3><span className="home-group-pin" aria-hidden="true"><PinIcon filled /></span>{h.recent.pinned}</h3>
            <ul className="home-list">{pinned.map((p) => <Row key={p.sessionId} item={p} open={onOpenSession} meta={p.project} tail={<span className="home-ago">{agoText(p.lastModified, now)}</span>} />)}</ul>
          </div>
        )}
        {recent.map((g) => (
          <div className="home-group" key={g.project}>
            <h3 title={g.cwd}>{g.project}</h3>
            <ul className="home-list">{g.items.map((i) => <Row key={i.sessionId} item={i} open={onOpenSession} meta={null} tail={<span className="home-ago">{agoText(i.lastModified, now)}</span>} />)}</ul>
          </div>
        ))}
      </Card>
    </>
  );
});

const PILL: Record<ProviderState, { cls: string; label: () => string }> = {
  ready: { cls: 'ok', label: () => ui().home.providers.ready },
  'needs-login': { cls: 'warn', label: () => ui().home.providers.needsLogin },
  unavailable: { cls: 'danger', label: () => ui().home.providers.unavailable },
  unknown: { cls: 'info', label: () => ui().home.providers.unknown },
};

/**
 * What hello alone says when /api/setup did not answer: installed or not, and Gemini's login. Hello says nothing about
 * Claude's CLI, so Claude has no fallback (shown with its status unknown, not as installed).
 */
function helloFallback(engine: EngineKind, hello: { codexAvailable: boolean; gemini: GeminiStatus | null; grok: GrokStatus | null }): { installed: boolean; login?: LoginState } | null {
  if (engine === 'claude') return null;
  if (engine === 'codex') return hello.codexAvailable ? { installed: true } : null;
  if (engine === 'gemini') return hello.gemini?.available ? { installed: true, login: hello.gemini.loggedIn.g1 || hello.gemini.loggedIn.g2 ? 'yes' : 'no' } : null;
  return hello.grok?.bin ? { installed: true } : null;
}

/** 공급자 · 사용량: the right column (below the lists on a narrow pane). Memoised like HomeLists. */
export const HomeSide = memo(function HomeSide({ data, usage, now, codexAvailable, gemini, grok }: {
  data: HomeData;
  usage: UsageSnapshot | null | undefined;
  now: number;
  codexAvailable: boolean;
  gemini: GeminiStatus | null;
  grok: GrokStatus | null;
}) {
  return (
    <>
      <Providers data={data} usage={usage} now={now} hello={{ codexAvailable, gemini, grok }} />
      <Usage data={data} usage={usage} now={now} />
    </>
  );
});

function Providers({ data, usage, now, hello }: { data: HomeData; usage: UsageSnapshot | null | undefined; now: number; hello: { codexAvailable: boolean; gemini: GeminiStatus | null; grok: GrokStatus | null } }) {
  const h = ui().home.providers;
  const names = useAccounts();
  const rows = providerRows(usage, names.active, now);
  const engines = ENGINE_ORDER.flatMap((engine) => {
    const probe = data.engines?.find((p) => p.engine === engine) ?? null;
    const fallback = helloFallback(engine, hello);
    // With a setup answer every probed engine shows (an uninstalled one says 사용 불가); without one, what hello knows,
    // and Claude (the default engine) always, its status unknown.
    if (data.engines ? !probe : !fallback && engine !== 'claude') return [];
    return [{ engine, probe, state: providerState(probe, fallback ?? undefined), blind: !probe && !fallback }];
  });
  return (
    <Card title={h.title} className="home-providers">
      <ul className="home-providers-list">
        {engines.map(({ engine, probe, state, blind }) => {
          const r = rows[engine];
          const pill = PILL[state];
          return (
            <li key={engine} className="home-provider" data-testid={`home-provider-${engine}`}>
              <div className="home-provider-head">
                <EngineBadge engine={engine} className="home-provider-badge" />
                <span className="home-provider-name">{engineName(engine)}</span>
                {probe?.version && <span className="home-provider-ver">{probe.version.replace(/^v/, '')}</span>}
                {r.plan && <span className="home-provider-plan">{r.plan}</span>}
                <span className={`home-pill ${pill.cls}`}><span className="home-dot" aria-hidden="true" />{blind ? h.statusUnknown : pill.label()}</span>
              </div>
              {r.rows.length > 0 ? r.rows.map((row) => {
                const left = shownPct(row.w);
                const until = untilParts(row.w?.resetsAt ?? null, now);
                return (
                  <div key={row.key} className="home-meter">
                    <span className="home-meter-label">{row.label ?? h.weekly}{until && <span className="home-meter-reset">{h.reset[until.unit](until.n)}</span>}</span>
                    <span className="home-meter-pct">{left === null ? '—' : h.left(left)}</span>
                    <span className={`home-meter-bar ${levelClass(row.w)}`} aria-hidden="true"><span style={{ width: `${left ?? 0}%` }} /></span>
                  </div>
                );
              }) : state !== 'unavailable' && <p className="home-meter-none">{h.noNumbers}</p>}
            </li>
          );
        })}
      </ul>
      {data.engines === null && <p className="home-failed">{h.failed}</p>}
    </Card>
  );
}

function Usage({ data, usage, now }: { data: HomeData; usage: UsageSnapshot | null | undefined; now: number }) {
  const h = ui().home.usage;
  const [tab, setTab] = useState<UsageTab>('today');
  const today = localDay(new Date(now));
  const totals = usageTotals(data.rows ?? [], usage?.grokSeats, tab, today);
  const max = Math.max(1, totals.tokens);
  const tabs: [UsageTab, string][] = [['today', h.today], ['week', h.week]];
  const base = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // ← / → (Home / End) move between the tabs and select them; only the selected tab is in the Tab order.
  const tabKey = (e: ReactKeyboardEvent, i: number) => {
    const n = tabs.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    setTab(tabs[j]![0]);
    tabRefs.current[j]?.focus();
  };
  return (
    <Card title={h.title} className="home-usage" aside={(
      <div className="home-tabs" role="tablist" aria-label={h.title}>
        {tabs.map(([k, label], i) => (
          <button key={k} ref={(el) => { tabRefs.current[i] = el; }} type="button" role="tab" id={`${base}-tab-${k}`} aria-controls={`${base}-panel`}
            aria-selected={tab === k} tabIndex={tab === k ? 0 : -1} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} onKeyDown={(e) => tabKey(e, i)}>{label}</button>
        ))}
      </div>
    )}>
      <div role="tabpanel" tabIndex={0} id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab}`}>
      {data.rows === null ? <p className="home-failed">{h.failed}</p> : (
        <>
          <div className="home-tiles">
            <div className="home-tile"><span className="home-tile-k">{h.cost}</span><span className="home-tile-v">{fmtCost(totals.cost)}</span></div>
            <div className="home-tile"><span className="home-tile-k">{h.tokens}</span><span className="home-tile-v">{fmtTokens(totals.tokens)}</span></div>
            <div className="home-tile"><span className="home-tile-k">{h.count}</span><span className="home-tile-v">{formatNumber(totals.messages)}</span></div>
          </div>
          {totals.byEngine.length > 0 ? (
            <>
              <div className="home-stack" aria-hidden="true">
                {totals.byEngine.map((e) => <span key={e.engine} className={`home-stack-part ${e.engine}`} style={{ flexGrow: e.tokens / max }} />)}
              </div>
              <ul className="home-engines-usage">
                {totals.byEngine.map((e) => (
                  <li key={e.engine}>
                    <EngineBadge engine={e.engine} className="home-eu-badge" />
                    <span className="home-eu-name">{engineName(e.engine)}</span>
                    <span className="home-eu-num">{fmtTokens(e.tokens)}</span>
                    <span className="home-eu-num muted-num">{formatNumber(e.messages)}</span>
                    <span className="home-eu-num">{e.engine === 'claude' ? fmtCost(e.cost) : '—'}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="home-empty">{data.rows === undefined || data.scanning ? h.scanning : h.empty}</p>}
          <p className="home-note">{tab === 'week' && usage?.grokSeats ? `${h.costNote} · ${h.grokToday}` : h.costNote}</p>
        </>
      )}
      </div>
    </Card>
  );
}

/**
 * The home layout around NewChat's own first-run block and composer form: greeting and date line, the lists, and the
 * right column. Its own component so the data hook mounts with the home and leaves with it (a second pane turns the
 * home back into the plain new-chat screen).
 */
export function HomeFrame({ home, projects, pins, now, fetchFn, onOpenSession, codexAvailable, gemini, grok, first, form }: {
  home: {
    activity: readonly SessionActivity[];
    unread: readonly string[];
    pending: readonly PendingPermission[];
    questions: readonly PendingQuestion[];
    usage: UsageSnapshot | null;
    onMarkRead?: ((sessionIds: string[]) => void) | undefined;
    /** Given (a render fixture): shown instead of fetching. */
    data?: HomeData | undefined;
  };
  projects: ProjectEntry[];
  pins: readonly string[];
  now: number;
  fetchFn: typeof fetch;
  onOpenSession?: Open | undefined;
  codexAvailable: boolean;
  gemini: GeminiStatus | null;
  grok: GrokStatus | null;
  first: ReactNode;
  form: ReactNode;
}) {
  const fetched = useHomeData(fetchFn, !!home.data);
  const data = home.data ?? fetched;
  const waiting = useMemo(() => homeLists({ projects, pending: home.pending, questions: home.questions }).waiting.length, [projects, home.pending, home.questions]);
  const todayCost = useMemo(() => (data.rows ? usageTotals(data.rows, undefined, 'today', localDay(new Date(now))).cost : null), [data.rows, now]);
  return (
    <div className="newchat home" data-testid="home">
      <div className="home-grid">
        <div className="home-main">
          <header className="home-head">
            <h1 className="home-greeting"><BrandMark className="spark" />{homeGreeting(new Date(now).getHours())}</h1>
            <p className="home-date" title={todayCost !== null && todayCost > 0 ? ui().home.todayCostNote : undefined}>{homeDateLine(now, waiting, todayCost)}</p>
          </header>
          {first}
          {form}
          <HomeLists projects={projects} activity={home.activity} unread={home.unread} pending={home.pending} questions={home.questions}
            pins={pins} now={now} onOpenSession={onOpenSession} onMarkRead={home.onMarkRead} />
        </div>
        <aside className="home-side">
          <HomeSide data={data} usage={home.usage} now={now} codexAvailable={codexAvailable} gemini={gemini} grok={grok} />
        </aside>
      </div>
    </div>
  );
}
