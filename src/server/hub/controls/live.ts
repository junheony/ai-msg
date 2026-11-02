/** The hub controls as the server runs them: `~/.msg` queues, `~/jobs`, the deck usage snapshot for Claude seats. */
import path from 'node:path';
import { HUB_MODE_IDS } from '../../../shared/hub-types';
import type { UsageSnapshot } from '../../../shared/usage-types';
import { createApprovals } from './approvals';
import type { SeatUsage } from './engines';
import { createControls } from './http';
import { createBotTasks, createJobs } from './jobs';

export function seatsOf(snap: UsageSnapshot | null): SeatUsage[] {
  if (!snap) return [];
  return Object.entries(snap.accounts ?? {}).map(([id, u]) => ({ id, status: u.status, fiveHourPct: u.fiveHour?.usedPct ?? null, weeklyPct: u.weekly?.usedPct ?? null }));
}

export function createHubControlsLive(o: { home: string; token: string; usage: () => UsageSnapshot | null }) {
  const root = path.join(o.home, '.msg');
  return createControls({
    root, home: o.home, token: o.token, modes: HUB_MODE_IDS,
    approvals: createApprovals({ root }),
    jobs: createJobs({ home: o.home, secrets: [o.token] }),
    tasks: createBotTasks({ root }),
    seats: () => { try { return seatsOf(o.usage()); } catch { return []; } },
  });
}
