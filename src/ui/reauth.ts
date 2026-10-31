import { GEMINI_ACCOUNTS } from '../shared/accounts';
import type { SetupStatus } from '../shared/setup-types';
import type { GeminiUsage, UsageSnapshot } from '../shared/usage-types';

/**
 * Seats whose login probe said `no`. The usage strip shows 로그인 필요 · 로그인 for these.
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

/** A Gemini seat whose `/usage` poll found no Google login (`loggedIn` false), or went down with a login error. */
export function geminiLoggedOut(g: GeminiUsage | undefined): boolean {
  if (!g) return false;
  return !g.loggedIn || (g.status === 'down' && /로그인|login|auth/i.test(g.error ?? ''));
}

/**
 * Setup's logged-out seats, plus what the usage snapshot itself says: Grok when the billing poller marked it logged
 * out (`grokSeats.x1.status === 'down'`), and each Gemini seat whose poll found no Google login (`geminiSeats[g].loggedIn`
 * false; an older snapshot's `gemini` stands for g1). The usage card then offers 로그인 before the next setup probe.
 */
export function reauthWithUsage(seats: readonly string[], usage: UsageSnapshot | null | undefined): string[] {
  const out = [...seats];
  const add = (seat: string) => { if (!out.includes(seat)) out.push(seat); };
  if (usage?.grokSeats?.x1?.status === 'down') add('x1');
  for (const g of GEMINI_ACCOUNTS) {
    const u = usage?.geminiSeats?.[g] ?? (g === 'g1' ? usage?.gemini : undefined);
    if (geminiLoggedOut(u)) add(g);
  }
  return out;
}
