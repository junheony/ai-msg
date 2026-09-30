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

/** Inherited from a parent Claude Code / proxy setup, these would send the turn elsewhere or mislabel it. */
const ROUTING_VARS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_ENTRYPOINT'] as const;

/**
 * Environment for one SDK turn. Copies `base`, removes every token variable
 * (env tokens override the config dir and would silently bill another account) and the
 * base-URL / Bedrock / Vertex / entrypoint variables,
 * and selects the profile: a = no CLAUDE_CONFIG_DIR (keychain service name has
 * no hash suffix), b/c = ~/.claude-b / ~/.claude-c.
 */
export function accountEnv(
  account: Account,
  base: NodeJS.ProcessEnv,
  home: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of [...TOKEN_VARS, ...ROUTING_VARS]) delete env[v];
  if (account === 'a') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = profileDir(account, home);
  return env;
}

/** Who ran a turn: one of the three Claude accounts or the single ChatGPT Pro account. */
export type Seat = Account | 'gpt';
export const SEAT_LABEL: Record<Seat, string> = { a: 'A', b: 'B', c: 'C', gpt: 'GPT' };

const OPENAI_VARS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;

/**
 * Environment for one Codex CLI turn: the base env minus every OpenAI/Anthropic token and routing
 * variable. CODEX_HOME passes through untouched — the CLI owns its auth store; deck never reads it.
 */
export function codexEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of [...TOKEN_VARS, ...ROUTING_VARS, ...OPENAI_VARS]) delete env[v];
  return env;
}
