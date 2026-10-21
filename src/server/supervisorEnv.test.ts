import { describe, expect, it } from 'vitest';
import { codexEnv, geminiEnv } from '../shared/accounts';
import { claudeEnv } from './engine/claudeCli/args';
import { grokEnv } from './engine/grokEnv';
import { SUPERVISOR_ENV_KEYS, stripSupervisorEnv } from './supervisorEnv';

const markers = Object.fromEntries(SUPERVISOR_ENV_KEYS.map((k) => [k, 'x'])) as Record<string, string>;
const base: Record<string, string> = { PATH: '/bin', HOME: '/h', ...markers, XPC_SERVICE_NAME: 'local.quarterdeck.server', INVOCATION_ID: 'abc', DECK_SUPERVISOR: 'systemd' };

describe('supervisorEnv', () => {
  it('the key list is the one in the plan', () => {
    expect([...SUPERVISOR_ENV_KEYS].sort()).toEqual(['DECK_SUPERVISED', 'DECK_SUPERVISOR', 'INVOCATION_ID', 'JOURNAL_STREAM', 'LISTEN_FDS', 'LISTEN_PID', 'MANAGERPID', 'NOTIFY_SOCKET', 'SYSTEMD_EXEC_PID', 'XPC_SERVICE_NAME']);
  });

  it('stripSupervisorEnv returns a copy without the markers', () => {
    const out = stripSupervisorEnv(base);
    for (const k of SUPERVISOR_ENV_KEYS) expect(out[k]).toBeUndefined();
    expect(out).toMatchObject({ PATH: '/bin', HOME: '/h' });
    expect(base.INVOCATION_ID).toBe('abc');
  });

  it('claude/codex/gemini child envs drop supervisor markers', () => {
    for (const env of [claudeEnv(base, 1000), codexEnv(base), geminiEnv(base)]) {
      for (const k of SUPERVISOR_ENV_KEYS) expect(env[k]).toBeUndefined();
      expect(env.PATH).toBe('/bin');
    }
  });

  it('grokEnv never passes supervisor markers', () => {
    const env = grokEnv(base, '/h/.grok', '/tmp/shadow');
    for (const k of SUPERVISOR_ENV_KEYS) expect(env[k]).toBeUndefined();
  });
});
