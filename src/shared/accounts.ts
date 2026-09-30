export type Account = 'a' | 'b' | 'c';

export const ACCOUNTS: readonly Account[] = ['a', 'b', 'c'];

/** usage-deck card ids (spec §3, claude-pick). */
export const CARD_ID: Record<Account, string> = {
  a: 'claude:main',
  b: 'claude:second',
  c: 'claude:third',
};

export function isAccount(x: unknown): x is Account {
  return x === 'a' || x === 'b' || x === 'c';
}

/** a → ~/.claude (CLAUDE_CONFIG_DIR must stay unset), b → ~/.claude-b, c → ~/.claude-c. */
export function profileDir(account: Account, home: string): string {
  return `${home}/${account === 'a' ? '.claude' : `.claude-${account}`}`;
}

export function projectsDir(account: Account, home: string): string {
  return `${profileDir(account, home)}/projects`;
}

const TOKEN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Environment for one SDK turn. Copies `base`, removes every token variable
 * (env tokens override the config dir and would silently bill another account),
 * and selects the profile: a = no CLAUDE_CONFIG_DIR (keychain service name has
 * no hash suffix), b/c = ~/.claude-b / ~/.claude-c.
 */
export function accountEnv(
  account: Account,
  base: NodeJS.ProcessEnv,
  home: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of TOKEN_VARS) delete env[v];
  if (account === 'a') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = profileDir(account, home);
  return env;
}
