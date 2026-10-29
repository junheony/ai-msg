import type { SetupStatus } from '../shared/setup-types';
import type { UsageSnapshot } from '../shared/usage-types';

/**
 * Seats whose login probe said `no`. The usage strip shows 로그인 만료 · 재로그인 for these.
 * Gemini is per seat (`geminiSeats`): g1 and g2 log in independently. A missing binary stays out.
 */
export function reauthSeats(status: SetupStatus): string[] {
  const seats: string[] = [];
  for (const p of status.claudeProfiles) if (p.active && p.login === 'no') seats.push(p.id);
  for (const e of status.engines) {
    if (e.login !== 'no' || !e.bin) continue;
    if (e.engine === 'codex') seats.push('gpt');
    else if (e.engine === 'grok') seats.push('x1');
  }
  for (const s of status.geminiSeats ?? []) if (s.login === 'no') seats.push(s.id);
  return seats;
}

/**
 * Setup's logged-out seats, plus Grok when the billing poller marked it logged out (`grokSeats.x1.status === 'down'`).
 * The usage card then offers 재로그인 even before the next `grok models` probe.
 */
export function reauthWithUsage(seats: readonly string[], usage: UsageSnapshot | null | undefined): string[] {
  const out = [...seats];
  if (usage?.grokSeats?.x1?.status === 'down' && !out.includes('x1')) out.push('x1');
  return out;
}
