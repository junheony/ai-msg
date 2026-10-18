/**
 * The environment a `grok` process gets (design §5): an allow-list, not a block-list. Only the basics below are passed
 * on from the server's env; deck sets GROK_HOME (per seat — never the one inherited from the shell), turns the
 * autoupdater off and turns Grok's Claude-compat loaders off. Everything else is dropped: XAI_*, other GROK_*, other
 * providers' keys, proxy vars, CLAUDE_* / CODEX_*.
 */

const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ'] as const;

/**
 * The "off" value for the GROK_CLAUDE_*_ENABLED switches. S6 에서 철자 확정 (`false` vs `0`): a wrong spelling leaves the
 * loader silently on, so the test pins this value once the spike has confirmed it.
 */
export const GROK_COMPAT_OFF = 'false';

/** Grok's Claude Code compatibility loaders (hooks, MCP servers, agents, rules, skills from Claude's config). */
export const GROK_COMPAT_VARS = [
  'GROK_CLAUDE_HOOKS_ENABLED',
  'GROK_CLAUDE_MCPS_ENABLED',
  'GROK_CLAUDE_AGENTS_ENABLED',
  'GROK_CLAUDE_RULES_ENABLED',
  'GROK_CLAUDE_SKILLS_ENABLED',
] as const;

export function grokEnv(base: NodeJS.ProcessEnv, grokHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(base)) if (k.startsWith('LC_') && v !== undefined) env[k] = v;
  env.GROK_HOME = grokHome;
  env.GROK_DISABLE_AUTOUPDATER = '1';
  for (const k of GROK_COMPAT_VARS) env[k] = GROK_COMPAT_OFF;
  return env;
}
