import type { SetupStatus } from '../shared/setup-types';

/**
 * Seats whose login probe said `no`, and whose re-login is a single allowlisted command (not Gemini's `agy`).
 * The usage strip shows 로그인 만료 · 재로그인 for these.
 */
export function reauthSeats(status: SetupStatus): string[] {
  const seats: string[] = [];
  for (const p of status.claudeProfiles) if (p.active && p.login === 'no') seats.push(p.id);
  for (const e of status.engines) {
    if (e.login !== 'no' || !e.bin) continue;
    if (e.engine === 'codex') seats.push('gpt');
    else if (e.engine === 'grok') seats.push('x1');
  }
  return seats;
}
