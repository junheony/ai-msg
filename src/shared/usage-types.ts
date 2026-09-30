import type { Account } from './accounts';

export type UsageWindow = { usedPct: number; resetsAt: string | null };

export type AccountUsage = {
  status: 'ok' | 'stale' | 'down';
  fetchedAt: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  fable: UsageWindow | null;
};

export type UsageSnapshot = {
  generatedAt: string;
  deckReachable: boolean;
  accounts: Record<Account, AccountUsage>;
};

export function remainingPct(w: UsageWindow | null): number | null {
  if (!w) return null;
  return Math.max(0, Math.min(100, 100 - w.usedPct));
}

export function emptyAccountUsage(): AccountUsage {
  return { status: 'down', fetchedAt: null, fiveHour: null, weekly: null, fable: null };
}

export function emptySnapshot(now: Date): UsageSnapshot {
  return {
    generatedAt: now.toISOString(),
    deckReachable: false,
    accounts: { a: emptyAccountUsage(), b: emptyAccountUsage(), c: emptyAccountUsage() },
  };
}
