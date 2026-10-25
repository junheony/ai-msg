// The home dashboard's data shaping (pure, unit-tested) and its small lazy fetch cache. Nothing here is new data:
// every list is read from the store (projects, activity, unread, pending, questions) or the two existing endpoints.
import type { EngineKind } from '../shared/models';
import type { SessionActivity } from '../shared/protocol';
import type { ProjectEntry, SessionEntry } from '../shared/session-types';
import type { EngineProbe, LoginState, SetupStatus } from '../shared/setup-types';
import { addCounts, costOf, emptyCounts, totalTokens, weekStart, type TokenCounts, type UsageHistory, type UsageRow } from '../shared/token-usage';
import type { Account, GrokAccount } from '../shared/accounts';
import { grokBillingWindow, parseIsoUtc, type GrokUsage, type UsageSnapshot, type UsageWindow } from '../shared/usage-types';

/** One row of the home lists: a session to open in this pane. */
export type HomeItem = {
  sessionId: string;
  cwd: string;
  title: string;
  project: string;
  engine: EngineKind;
  lastModified: number;
};
export type WaitingItem = HomeItem & { kind: 'permission' | 'question'; detail: string };
export type RunningItem = HomeItem & { running: boolean; bg: number; forMs: number; tasks: string[] };
export type HomeLists = { waiting: WaitingItem[]; running: RunningItem[]; unread: HomeItem[] };

type Prompt = { sessionId: string | null; cwd: string };
type PermissionLike = Prompt & { toolName: string };
type QuestionLike = Prompt & { questions: { header: string; question: string }[] };

const baseName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

/** Every listed session by id (the newest copy when a session shows in two projects), with its project's name. */
export function sessionIndex(projects: readonly ProjectEntry[]): Map<string, { s: SessionEntry; project: string }> {
  const out = new Map<string, { s: SessionEntry; project: string }>();
  for (const p of projects) {
    for (const s of p.sessions ?? []) {
      const had = out.get(s.sessionId);
      if (!had || had.s.lastModified < s.lastModified) out.set(s.sessionId, { s, project: p.name });
    }
  }
  return out;
}

function engineOfEntry(s: Pick<SessionEntry, 'engine' | 'account'> | undefined): EngineKind {
  if (s?.engine) return s.engine;
  return s?.account === 'gpt' ? 'codex' : 'claude';
}

/** A session the list may not know yet (a brand-new one): named by its folder, then by the id's start. */
function itemOf(index: ReturnType<typeof sessionIndex>, sessionId: string, cwd: string): HomeItem {
  const hit = index.get(sessionId);
  if (hit) return { sessionId, cwd: hit.s.cwd || cwd, title: hit.s.title || sessionId.slice(0, 8), project: hit.project, engine: engineOfEntry(hit.s), lastModified: hit.s.lastModified };
  const folder = cwd ? baseName(cwd) : '';
  return { sessionId, cwd, title: folder || sessionId.slice(0, 8), project: folder, engine: 'claude', lastModified: 0 };
}

/**
 * 확인 필요 / 실행 중 / unread, by the sidebar's priority (waiting > running > unread): a session shows once, in the
 * first list it belongs to. Waiting keeps the prompts' order (oldest first); running is longest-running first;
 * unread newest first. Prompts without a session (a turn still opening) are left out — they have nothing to open.
 */
export function homeLists({ projects, activity = [], unread = [], pending = [], questions = [] }: {
  projects: readonly ProjectEntry[];
  activity?: readonly SessionActivity[];
  unread?: readonly string[];
  pending?: readonly PermissionLike[];
  questions?: readonly QuestionLike[];
}): HomeLists {
  const index = sessionIndex(projects);
  const seen = new Set<string>();
  const waiting: WaitingItem[] = [];
  for (const p of pending) {
    if (!p.sessionId || seen.has(p.sessionId)) continue;
    seen.add(p.sessionId);
    waiting.push({ ...itemOf(index, p.sessionId, p.cwd), kind: 'permission', detail: p.toolName });
  }
  for (const q of questions) {
    if (!q.sessionId || seen.has(q.sessionId)) continue;
    seen.add(q.sessionId);
    const first = q.questions?.[0];
    waiting.push({ ...itemOf(index, q.sessionId, q.cwd), kind: 'question', detail: first?.header || first?.question || '' });
  }
  const running: RunningItem[] = [];
  for (const a of activity) {
    if (!a.sessionId || seen.has(a.sessionId) || !(a.running || a.bg > 0)) continue;
    seen.add(a.sessionId);
    running.push({ ...itemOf(index, a.sessionId, a.cwd), running: a.running, bg: a.bg, forMs: a.forMs, tasks: a.tasks ?? [] });
  }
  running.sort((x, y) => Number(y.running) - Number(x.running) || y.forMs - x.forMs);
  const unreadItems: HomeItem[] = [];
  for (const id of unread) {
    if (seen.has(id)) continue;
    seen.add(id);
    unreadItems.push(itemOf(index, id, ''));
  }
  unreadItems.sort((x, y) => y.lastModified - x.lastModified);
  return { waiting, running, unread: unreadItems };
}

export type RecentGroup = { project: string; cwd: string; items: HomeItem[] };

/**
 * 최근: the newest live (not archived) sessions, at most `limit`, grouped by project in the order each project's
 * newest one appears. Sessions in `exclude` (the ones already shown above) are left out.
 */
export function recentByProject(projects: readonly ProjectEntry[], exclude: ReadonlySet<string> = new Set(), limit = 8): RecentGroup[] {
  const live = [...sessionIndex(projects).values()]
    .filter(({ s }) => !s.archived && !exclude.has(s.sessionId))
    .sort((a, b) => b.s.lastModified - a.s.lastModified)
    .slice(0, limit);
  const groups: RecentGroup[] = [];
  for (const { s, project } of live) {
    const item: HomeItem = { sessionId: s.sessionId, cwd: s.cwd, title: s.title || s.sessionId.slice(0, 8), project, engine: engineOfEntry(s), lastModified: s.lastModified };
    const g = groups.find((x) => x.project === project);
    if (g) g.items.push(item);
    else groups.push({ project, cwd: s.cwd, items: [item] });
  }
  return groups;
}

export type UsageTab = 'today' | 'week';
export type UsageEngine = 'claude' | 'codex' | 'grok';
export type EngineUsage = { engine: UsageEngine; tokens: number; messages: number; cost: number };
export type UsageTotals = {
  /** Claude only: the API-rate estimate (GPT runs on the subscription, Grok has no price). */
  cost: number;
  tokens: number;
  messages: number;
  /** Engines with any use, biggest first. */
  byEngine: EngineUsage[];
};

/**
 * 오늘 / 이번 주 sums. The history's 'all' rows already hold Codex (family 'gpt'), so Claude = 'all' rows of any other
 * family and Codex = 'all' rows of family 'gpt' (per-account rows would count Claude twice). Grok is not in the
 * history: its seats' `today` counts join the 오늘 tab only (turns as messages).
 */
export function usageTotals(rows: readonly UsageRow[] | undefined, grokSeats: Partial<Record<GrokAccount, GrokUsage>> | undefined, tab: UsageTab, today: string): UsageTotals {
  const from = tab === 'today' ? today : weekStart(today);
  const inRange = (day: string) => day >= from && day <= today;
  const claude: TokenCounts = emptyCounts();
  const codex: TokenCounts = emptyCounts();
  let cost = 0;
  for (const r of rows ?? []) {
    if (r.source !== 'all' || !inRange(r.day)) continue;
    if (r.family === 'gpt') addCounts(codex, r);
    else { addCounts(claude, r); cost += costOf(r, r.family); }
  }
  let grokTokens = 0;
  let grokTurns = 0;
  if (tab === 'today') {
    for (const g of Object.values(grokSeats ?? {})) {
      if (!g?.today || g.today.day !== today) continue;
      grokTokens += (g.today.inputTokens || 0) + (g.today.outputTokens || 0);
      grokTurns += g.today.turns || 0;
    }
  }
  const byEngine: EngineUsage[] = [
    { engine: 'claude' as const, tokens: totalTokens(claude), messages: claude.messages, cost },
    { engine: 'codex' as const, tokens: totalTokens(codex), messages: codex.messages, cost: 0 },
    { engine: 'grok' as const, tokens: grokTokens, messages: grokTurns, cost: 0 },
  ].filter((e) => e.tokens > 0 || e.messages > 0).sort((a, b) => b.tokens - a.tokens);
  return {
    cost,
    tokens: byEngine.reduce((n, e) => n + e.tokens, 0),
    messages: byEngine.reduce((n, e) => n + e.messages, 0),
    byEngine,
  };
}

export type ProviderState = 'ready' | 'needs-login' | 'unavailable' | 'unknown';

/** The status pill: no binary = 사용 불가; the official status command said logged out = 연결 필요; could not tell = 인증 미확인. */
export function providerState(probe: Pick<EngineProbe, 'bin' | 'login'> | null | undefined, fallback?: { installed: boolean; login?: LoginState }): ProviderState {
  if (!probe && !fallback) return 'unknown';
  const installed = probe ? !!probe.bin : !!fallback?.installed;
  const login = probe ? probe.login : fallback?.login ?? 'unknown';
  if (!installed) return 'unavailable';
  if (login === 'yes') return 'ready';
  if (login === 'no') return 'needs-login';
  return 'unknown';
}

/** Whole minutes / hours / days since `ms` (for "3분 전"); unit 'now' under a minute. */
export function agoParts(ms: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days'; n: number } {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return { unit: 'now', n: 0 };
  if (d < 3_600_000) return { unit: 'minutes', n: Math.floor(d / 60_000) };
  if (d < 86_400_000) return { unit: 'hours', n: Math.floor(d / 3_600_000) };
  return { unit: 'days', n: Math.floor(d / 86_400_000) };
}

// --- lazy fetch, cached ~50 s per URL (the home asks only while it is on screen) -------------------------------------

/** Shorter than the home's 60 s refresh, so every tick really asks again (equal ones skipped every other tick). */
export const HOME_TTL_MS = 50_000;
const cache = new Map<string, { at: number; value: unknown; pending?: Promise<unknown> }>();

/** Tests: start every case with an empty cache. */
export function clearHomeCache(): void {
  cache.clear();
}

/**
 * GET `url` as JSON through `fetchFn`, reusing an answer younger than HOME_TTL_MS (and an in-flight ask). A failure
 * resolves to null and is not cached, so the next visit asks again.
 */
export function cachedJson<T>(url: string, fetchFn: typeof fetch, now = Date.now()): Promise<T | null> {
  const hit = cache.get(url);
  if (hit?.pending) return hit.pending as Promise<T | null>;
  if (hit && now - hit.at < HOME_TTL_MS) return Promise.resolve(hit.value as T);
  const pending = (async () => {
    try {
      const r = await fetchFn(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const value = (await r.json()) as T;
      cache.set(url, { at: Date.now(), value });
      return value;
    } catch {
      cache.delete(url);
      return null;
    }
  })();
  cache.set(url, { at: 0, value: null, pending });
  return pending;
}

/** A setup answer the home can read (an old server or a stub may send `{}`). */
export function setupEngines(s: SetupStatus | null): EngineProbe[] | null {
  return s && Array.isArray(s.engines) ? s.engines : null;
}

/** A history answer the home can read. */
export function historyRows(h: UsageHistory | null): UsageRow[] | null {
  return h && Array.isArray(h.rows) ? h.rows : null;
}

// --- provider rows: the weekly window per seat, from the usage snapshot hello / usage pushes already carry ------------

/** One bar under a provider: `label` = the account letter, a Gemini bucket, a plan; null = the engine's only seat. */
export type ProviderRow = { key: string; label: string | null; w: UsageWindow | null };
export type ProviderRows = { rows: ProviderRow[]; plan: string | null };

/**
 * The weekly window of every seat, per engine (no new data: the same snapshot the usage strip reads). Claude: one row
 * per active account, its letter as the label. GPT: its weekly. Gemini: per seat the bucket with the least left.
 * Grok: the subscription period (its tier is the plan) and the Grok Bot app's weekly (its planLabel).
 */
export function providerRows(usage: UsageSnapshot | null | undefined, active: readonly { id: Account; label: string }[], now: number): Record<EngineKind, ProviderRows> {
  const out: Record<EngineKind, ProviderRows> = { claude: { rows: [], plan: null }, codex: { rows: [], plan: null }, gemini: { rows: [], plan: null }, grok: { rows: [], plan: null } };
  if (!usage) return out;
  out.claude.rows = active.map((a) => ({ key: a.id, label: a.label, w: usage.accounts?.[a.id]?.weekly ?? null }));
  if (usage.gpt) out.codex.rows = [{ key: 'gpt', label: null, w: usage.gpt.weekly ?? null }];
  const gem = usage.geminiSeats ?? (usage.gemini ? { g1: usage.gemini } : {});
  for (const [seat, g] of Object.entries(gem)) {
    if (!g) continue;
    const least = [...(g.buckets ?? [])].sort((x, y) => y.usedPct - x.usedPct)[0];
    out.gemini.rows.push({ key: seat, label: least?.name ?? null, w: least ? { usedPct: least.usedPct, resetsAt: least.resetsAt } : null });
  }
  for (const [seat, g] of Object.entries(usage.grokSeats ?? {})) {
    if (!g?.billing) continue;
    out.grok.rows.push({ key: seat, label: null, w: grokBillingWindow(g.billing, now) });
    out.grok.plan ??= g.billing.tier ?? null;
  }
  const bot = usage.grokBot;
  if (bot && Number.isFinite(bot.percentUsed)) {
    out.grok.rows.push({ key: 'grokbot', label: bot.planLabel ? `Grok Bot · ${bot.planLabel}` : 'Grok Bot', w: { usedPct: Math.max(0, Math.min(100, bot.percentUsed)), resetsAt: bot.nextResetMs !== null ? new Date(bot.nextResetMs).toISOString() : null } });
  }
  return out;
}

/** Whole minutes / hours / days until `resetsAt`; null without a future reset. */
export function untilParts(resetsAt: string | null, now: number): { unit: 'minutes' | 'hours' | 'days'; n: number } | null {
  if (!resetsAt) return null;
  const ms = parseIsoUtc(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 3_600_000) return { unit: 'minutes', n: Math.max(1, Math.floor(ms / 60_000)) };
  if (ms < 48 * 3_600_000) return { unit: 'hours', n: Math.floor(ms / 3_600_000) };
  return { unit: 'days', n: Math.floor(ms / 86_400_000) };
}
