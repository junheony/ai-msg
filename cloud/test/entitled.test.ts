import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { entitledState } from '../src/entitled';

const NOW = 1_800_000_000_000;
let seq = 0;
async function user(): Promise<string> {
  const id = `u-ent-${seq++}`;
  await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, `${id}@example.test`, NOW).run();
  return id;
}
const trial = (u: string, endsAt: number) => env.DB.prepare('INSERT INTO trials (user_id, started_at, ends_at) VALUES (?, ?, ?)').bind(u, NOW - 1000, endsAt).run();
const grant = (u: string, until: number) => env.DB.prepare("INSERT INTO grants (user_id, plan, until) VALUES (?, 'comp', ?)").bind(u, until).run();

describe('entitledState (trial + comp)', () => {
  it('trial and comp: larger until wins; expired → none', async () => {
    const none = await user();
    expect(await entitledState(env.DB, none, NOW)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const t = await user();
    await trial(t, NOW + 5000);
    expect(await entitledState(env.DB, t, NOW)).toEqual({ plan: 'trial', st: 'trialing', untilMs: NOW + 5000 });
    expect(await entitledState(env.DB, t, NOW + 5000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const both = await user();
    await trial(both, NOW + 5000);
    await grant(both, NOW + 9000);
    expect(await entitledState(env.DB, both, NOW)).toEqual({ plan: 'comp', st: 'active', untilMs: NOW + 9000 });
    expect(await entitledState(env.DB, both, NOW + 9000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const trialWins = await user();
    await trial(trialWins, NOW + 9000);
    await grant(trialWins, NOW + 5000);
    expect(await entitledState(env.DB, trialWins, NOW)).toEqual({ plan: 'trial', st: 'trialing', untilMs: NOW + 9000 });
    expect(await entitledState(env.DB, trialWins, NOW + 9000)).toEqual({ plan: 'none', st: 'none', untilMs: 0 });

    const expiredTrial = await user();
    await trial(expiredTrial, NOW - 1);
    await grant(expiredTrial, NOW + 100);
    expect(await entitledState(env.DB, expiredTrial, NOW)).toEqual({ plan: 'comp', st: 'active', untilMs: NOW + 100 });
  });
});
