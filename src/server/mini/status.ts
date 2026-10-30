import type { HubStatus } from '../../shared/hub-types';
import { MINI_HUB_WORST_ORDER, MINI_MAX_SESSIONS, type MiniHub, type MiniHubState, type MiniSeat, type MiniSession, type MiniStatus } from '../../shared/mini-types';
import { contextWindowOf } from '../../shared/models';
import type { RunningTurn } from '../../shared/protocol';
import { costOf, familyOf } from '../../shared/token-usage';
import { remainingPct, usageOf, type AccountUsage, type UsageSnapshot, type UsageWindow } from '../../shared/usage-types';
import type { AccountNames } from '../../shared/accounts';
import type { HubStatusService } from '../hub/status';
import { stripSecrets } from '../hub/status';
import type { TrackedSession } from './MiniTracker';

export interface MiniDeps {
  /** The sessions the tracker has seen since the server started. */
  tracked(): TrackedSession[];
  /** Turns in flight (WsHandle.running). */
  running(): RunningTurn[];
  usage(): UsageSnapshot;
  accounts: Pick<AccountNames, 'list' | 'label'>;
  /** The hub aggregator; absent = `hub: null` in the answer. */
  hub?: HubStatusService | null;
  /** The session's title (index / meta); null = none known. */
  titleOf(sessionId: string): string | null;
  /** The home dir: any occurrence in a title or prompt is shown as `~`. */
  home?: string;
  now?: () => number;
  /** How long one answer waits for the hub before it answers with the last hub summary it had (default 2.5 s). */
  hubTimeoutMs?: number;
}

export interface MiniStatusService { status(): Promise<MiniStatus> }

const HUB_TIMEOUT_MS = 2_500;
const STATE_RANK = { waiting: 0, running: 1, idle: 2 } as const;

function hidePaths(text: string, home: string | undefined): string {
  return home && home.length > 1 ? text.split(home).join('~') : text;
}

/** One hub answer, reduced to a state per mode, the counts and the worst state. */
export function summarizeHub(hub: HubStatus): MiniHub {
  const counts: Record<MiniHubState, number> = { ok: 0, warn: 0, down: 0, idle: 0, unknown: 0 };
  const modes = hub.modes.map((m) => {
    const state: MiniHubState = m.state in counts ? m.state : 'unknown';
    counts[state] += 1;
    return { id: m.id, name: m.name, state };
  });
  const worst = MINI_HUB_WORST_ORDER.find((s) => counts[s] > 0) ?? 'ok';
  return { modes, counts, worst, generated_at: hub.generated_at };
}

/** Whole percentages: a sliver above 0 still reads 1 (like the UI's leftPct). */
function wholeLeft(w: UsageWindow | null): number | null {
  const r = remainingPct(w);
  return r === null ? null : r > 0 && r < 1 ? 1 : Math.floor(r);
}

function seatOf(id: string, label: string, u: AccountUsage): MiniSeat {
  return { id, label, status: u.status, left5h: wholeLeft(u.fiveHour), leftWeek: wholeLeft(u.weekly), resets5h: u.fiveHour?.resetsAt ?? null, resetsWeek: u.weekly?.resetsAt ?? null };
}

/** The seats line: every active Claude account in configured order, then GPT when the snapshot has it. */
export function summarizeSeats(snapshot: UsageSnapshot, accounts: Pick<AccountNames, 'list' | 'label'>): MiniSeat[] {
  const seats = accounts.list().map((id) => seatOf(id, accounts.label(id), usageOf(snapshot, id)));
  if (snapshot.gpt) seats.push(seatOf('gpt', 'GPT', snapshot.gpt));
  return seats;
}

function sessionOf(t: TrackedSession, running: boolean, title: string | null, home: string | undefined, now: number): MiniSession {
  const u = t.usage;
  const ctx = u?.context ?? u?.lastCall ?? null;
  const context = ctx ? ctx.inputTokens + ctx.cacheReadTokens + ctx.cacheCreationTokens : null;
  const window = u?.contextWindow ?? contextWindowOf(t.model);
  const family = familyOf(t.model);
  const hasTurn = t.totals.input + t.totals.output + t.totals.cacheRead + t.totals.cacheWrite > 0;
  const cost = hasTurn && family !== 'other' ? Math.round(costOf({ ...t.totals, messages: 0 }, family) * 100) / 100 : null;
  const state = t.waitingOn ? 'waiting' : running ? 'running' : 'idle';
  return {
    title: hidePaths(title || t.lastPrompt || '(제목 없음)', home),
    engine: t.engine,
    model: t.model,
    account: t.account,
    contextPct: context !== null && window > 0 ? Math.min(100, Math.round((context / window) * 100)) : null,
    context,
    out: running ? t.progressOut : (u?.outputTokens ?? t.progressOut),
    cacheRead: u?.cacheReadTokens ?? 0,
    costUsd: cost,
    turns: t.turns,
    lastPrompt: hidePaths(t.lastPrompt, home),
    state,
    updatedAgoMs: Math.max(0, now - t.updatedAt),
    forMs: running && t.runningSince !== null ? Math.max(0, now - t.runningSince) : 0,
  };
}

/** The sessions the widget shows: waiting first, then running, then the most recently changed — at most MINI_MAX_SESSIONS. */
export function pickSessions(deps: Pick<MiniDeps, 'tracked' | 'running' | 'titleOf' | 'home'>, now: number): MiniSession[] {
  const live = new Set(deps.running().map((r) => r.sessionId).filter((id): id is string => !!id));
  return deps.tracked()
    .map((t) => sessionOf(t, live.has(t.sessionId), deps.titleOf(t.sessionId), deps.home, now))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.updatedAgoMs ?? 0) - (b.updatedAgoMs ?? 0))
    .slice(0, MINI_MAX_SESSIONS);
}

/** One answer from live parts (`hub` already reduced, or null). Pure apart from `deps.now`. */
export function buildMiniStatus(deps: MiniDeps, hub: MiniHub | null): MiniStatus {
  const now = deps.now?.() ?? Date.now();
  const tracked = deps.tracked();
  const live = new Set(deps.running().map((r) => r.sessionId).filter((id): id is string => !!id));
  const out: MiniStatus = {
    running: live.size,
    waiting: tracked.filter((t) => t.waitingOn !== null).length,
    sessions: pickSessions(deps, now),
    seats: summarizeSeats(deps.usage(), deps.accounts),
    hub,
    generated_at: new Date(now).toISOString(),
  };
  // Belt and braces: no key of the answer may read like a secret (hub/status.ts SECRET_FIELD_RE).
  return stripSecrets(out);
}

/**
 * The service behind GET /api/mini/status. The hub aggregator (cached 15 s on its side) may take seconds on a cold
 * cache; an answer waits `hubTimeoutMs` for it at most and otherwise carries the last hub summary it got.
 */
export function createMiniStatus(deps: MiniDeps): MiniStatusService {
  let lastHub: MiniHub | null = null;
  let pending: Promise<void> | null = null;
  const refreshHub = (): Promise<void> => {
    if (!deps.hub) return Promise.resolve();
    pending ??= deps.hub.status().then((h) => { lastHub = summarizeHub(h); }, () => undefined).finally(() => { pending = null; });
    return pending;
  };
  return {
    async status() {
      const wait = new Promise<void>((r) => setTimeout(r, deps.hubTimeoutMs ?? HUB_TIMEOUT_MS).unref?.());
      await Promise.race([refreshHub(), wait]);
      return buildMiniStatus(deps, lastHub);
    },
  };
}
