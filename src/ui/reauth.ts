import type { SetupStatus } from '../shared/setup-types';

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
