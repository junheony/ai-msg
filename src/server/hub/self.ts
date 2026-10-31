/**
 * What the deck server itself tells the MSG 터미널 hub page: recent sessions (no ids, no paths), every seat's quota as
 * the usage header knows it, and the counts. Pure over the server's own readers so it is testable without a server.
 */
import path from 'node:path';
import { type AccountNames, GEMINI_ACCOUNTS, GROK_ACCOUNTS, isGeminiAccount, isGrokAccount } from '../../shared/accounts';
import type { RunningTurn } from '../../shared/protocol';
import type { SessionEntry } from '../../shared/session-types';
import { type UsageSnapshot, usageOf } from '../../shared/usage-types';
import type { HubSelf, HubSelfSeat, HubSelfSession } from './shared';

export interface HubSelfSources {
  startedAt: number;
  sessions: () => SessionEntry[];
  running: () => RunningTurn[];
  activeTurns: () => number;
  usage: () => UsageSnapshot;
  accounts: Pick<AccountNames, 'list' | 'label'>;
  now?: () => number;
}

export const HUB_SELF_RECENT = 12;
const DAY_MS = 86_400_000;

/** The seat's name as the header spells it (`seatLabel` in the UI; the server cannot import that). */
function seatName(accounts: Pick<AccountNames, 'label'>, e: SessionEntry): string {
  const engine = e.engine ?? 'claude';
  if (engine === 'codex') return 'GPT';
  if (engine === 'grok') return 'Grok';
  if (engine === 'gemini') return isGeminiAccount(e.account) && e.account === 'g2' ? 'Gemini 2' : 'Gemini';
  return isGeminiAccount(e.account) || isGrokAccount(e.account) || e.account === 'gpt' ? String(e.account) : accounts.label(e.account);
}

const pct = (v: { usedPct: number } | null | undefined): number | null => (v && Number.isFinite(v.usedPct) ? Math.max(0, Math.min(100, Math.round(v.usedPct))) : null);

export function seatsOf(snap: UsageSnapshot, accounts: Pick<AccountNames, 'list' | 'label'>): HubSelfSeat[] {
  const seats: HubSelfSeat[] = [];
  for (const id of accounts.list()) {
    const u = usageOf(snap, id);
    seats.push({ id, label: accounts.label(id), status: u.status, fiveHour: pct(u.fiveHour), weekly: pct(u.weekly), fable: pct(u.fable), resetsAt: u.fiveHour?.resetsAt ?? null, weeklyResetsAt: u.weekly?.resetsAt ?? null });
  }
  if (snap.gpt) {
    const u = snap.gpt;
    seats.push({ id: 'gpt', label: 'GPT', status: u.status, fiveHour: pct(u.fiveHour), weekly: pct(u.weekly), fable: null, resetsAt: u.fiveHour?.resetsAt ?? null, weeklyResetsAt: u.weekly?.resetsAt ?? null, ...(u.credits?.hasCredits ? { note: u.credits.unlimited ? '크레딧 무제한' : `크레딧 ${u.credits.balance ?? '—'}` } : {}) });
  }
  for (const g of GEMINI_ACCOUNTS) {
    const u = snap.geminiSeats?.[g] ?? (g === 'g1' ? snap.gemini : undefined);
    if (!u) continue;
    const top = [...u.buckets].sort((a, b) => b.usedPct - a.usedPct);
    seats.push({
      id: g, label: g === 'g1' ? 'Gemini' : 'Gemini 2', status: !u.loggedIn ? 'login' : u.status,
      fiveHour: null, weekly: pct(top[0] ?? null), fable: null, resetsAt: null, weeklyResetsAt: top[0]?.resetsAt ?? null,
      note: !u.loggedIn ? '로그인 필요 (agy)' : top.length ? top.slice(0, 3).map((b) => `${b.name} ${Math.round(b.usedPct)}%`).join(' · ') : (u.error ?? '버킷 없음'),
    });
  }
  for (const x of GROK_ACCOUNTS) {
    const u = snap.grokSeats?.[x];
    if (!u) continue;
    const b = u.billing ?? null;
    seats.push({
      id: x, label: 'Grok', status: u.status === 'down' ? 'login' : u.status, fiveHour: null, weekly: b ? pct(b) : null, fable: null, resetsAt: u.cooldownUntil, weeklyResetsAt: b?.windowEnd ?? null,
      note: [u.status === 'down' ? '인증 실패 — 재로그인' : u.lastError === 'limit' ? '한도' : null, b?.tier ? b.tier : null, `오늘 ${u.today.turns}턴`].filter((s): s is string => !!s).join(' · '),
    });
  }
  return seats;
}

export function hubSelfOf(src: HubSelfSources): HubSelf {
  const now = (src.now ?? Date.now)();
  const live = new Set(src.running().map((r) => r.sessionId).filter((x): x is string => !!x));
  const all = src.sessions().filter((e) => !e.archived && !e.headless && !e.codexArchived);
  const sorted = [...all].sort((a, b) => Number(live.has(b.sessionId)) - Number(live.has(a.sessionId)) || b.lastModified - a.lastModified);
  const recent: HubSelfSession[] = sorted.slice(0, HUB_SELF_RECENT).map((e) => ({
    title: e.title, project: path.basename(e.cwd) || '—', engine: e.engine ?? 'claude', seat: seatName(src.accounts, e), lastModified: e.lastModified, running: live.has(e.sessionId), bg: 0,
  }));
  let seats: HubSelfSeat[] | undefined;
  try { seats = seatsOf(src.usage(), src.accounts); } catch { seats = undefined; }
  return { uptimeMs: now - src.startedAt, sessions: all.length, activeTurns: src.activeTurns(), active24h: all.filter((e) => now - e.lastModified < DAY_MS).length, recent, ...(seats ? { seats } : {}) };
}
