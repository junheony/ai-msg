import { describe, expect, it } from 'vitest';
import { GROK_COMPAT_OFF, GROK_COMPAT_VARS, grokEnv } from './grokEnv';

describe('grokEnv', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', LC_CTYPE: 'UTF-8',
    TERM: 'xterm', TMPDIR: '/tmp/x', TZ: 'Asia/Seoul', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', GROK_AUTO_PERMISSION_MODE: 'auto', GROK_DEFAULT_PERMISSION_MODE: 'bypassPermissions',
    GROK_HOME: '/shell/grok', XAI_API_KEY: 'k', XAI_BASE_URL: 'u', GROK_MODEL: 'm', GROK_CLAUDE_HOOKS_ENABLED: 'true',
    OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k', HTTPS_PROXY: 'p', http_proxy: 'p',
    CLAUDE_CONFIG_DIR: 'c', CODEX_HOME: 'c', DECK_TOKEN: 't', NODE_OPTIONS: '--x',
  };

  it('keeps only the allow-list (LC_* included) plus what deck sets', () => {
    const env = grokEnv(base, '/seat/grok');
    expect(Object.keys(env).sort()).toEqual([
      'GROK_CLAUDE_AGENTS_ENABLED', 'GROK_CLAUDE_HOOKS_ENABLED', 'GROK_CLAUDE_MCPS_ENABLED', 'GROK_CLAUDE_RULES_ENABLED', 'GROK_CLAUDE_SKILLS_ENABLED',
      'GROK_DISABLE_AUTOUPDATER', 'GROK_HOME', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL', 'SSH_AUTH_SOCK', 'TERM', 'TMPDIR', 'TZ', 'USER',
    ]);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it("ignores the shell's GROK_HOME and every XAI_* / other GROK_* / provider / proxy var", () => {
    const env = grokEnv(base, '/seat/grok');
    expect(env.GROK_HOME).toBe('/seat/grok');
    for (const k of ['XAI_API_KEY', 'XAI_BASE_URL', 'GROK_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HTTPS_PROXY', 'http_proxy', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NODE_OPTIONS', 'GROK_AUTO_PERMISSION_MODE', 'GROK_DEFAULT_PERMISSION_MODE']) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it('turns the autoupdater and every Claude-compat loader off (spelling pinned until S6 confirms it)', () => {
    const env = grokEnv(base, '/seat/grok');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(GROK_COMPAT_OFF).toBe('false');
    for (const k of GROK_COMPAT_VARS) expect(env[k], k).toBe(GROK_COMPAT_OFF);
  });

  it('HOME is the shadow HOME when given (§14.9-1); SSH_AUTH_SOCK passes so git over ssh works', () => {
    const env = grokEnv(base, '/seat/grok', '/cfg/homes/grok/t1');
    expect(env.HOME).toBe('/cfg/homes/grok/t1');
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
    expect(grokEnv(base, '/seat/grok').HOME).toBe('/home/u');
  });

  it('an absent allow-listed var stays absent', () => {
    expect(grokEnv({ PATH: '/bin' }, '/g')).not.toHaveProperty('HOME');
  });
});
