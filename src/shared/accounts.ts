export type Account = 'a' | 'b' | 'c';

export const ACCOUNTS: readonly Account[] = ['a', 'b', 'c'];

/** The profile Claude Desktop reads and writes (~/.claude): deck mirrors sessions it ran on B/C back there. */
export const HOME_ACCOUNT: Account = 'a';

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

/** Two Google accounts for gemini-cli, each with its own GEMINI_CLI_HOME (never chosen by 자동). */
export type GeminiAccount = 'g1' | 'g2';
export const GEMINI_ACCOUNTS: readonly GeminiAccount[] = ['g1', 'g2'];

export function isGeminiAccount(x: unknown): x is GeminiAccount {
  return x === 'g1' || x === 'g2';
}

/** g1 → ~/.config/deck/gemini/g1: gemini-cli keeps everything (OAuth file, settings, chats) under `$GEMINI_CLI_HOME/.gemini`. */
export function geminiHome(account: GeminiAccount, home: string): string {
  return `${home}/.config/deck/gemini/${account}`;
}

/** The OAuth file gemini-cli writes after "Login with Google". deck only checks that it exists — never reads it. */
export function geminiCredFile(account: GeminiAccount, home: string): string {
  return `${geminiHome(account, home)}/.gemini/oauth_creds.json`;
}

/** Who ran a turn: one of the three Claude accounts, the single ChatGPT Pro account, or a Gemini account. */
export type Seat = Account | 'gpt' | GeminiAccount;
/** Seats with a usage card (Gemini quota is not readable locally). */
export type UsageSeat = Account | 'gpt';
export const SEAT_LABEL: Record<Seat, string> = { a: 'A', b: 'B', c: 'C', gpt: 'GPT', g1: 'G1', g2: 'G2' };

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

/** API keys, ADC, Vertex and endpoint overrides: any of these would bypass the per-account OAuth login. */
const GEMINI_VARS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL', 'GEMINI_CLI_USE_COMPUTE_ADC', 'CLOUD_SHELL',
  // Keychain/encrypted storage uses one shared entry ("gemini-cli-oauth" / "main-account"): g1 and g2 would collide.
  'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
  // The sandbox is chosen by deck, not inherited.
  'GEMINI_SANDBOX', 'SEATBELT_PROFILE', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_CLI_HOME',
] as const;

/**
 * Environment for one gemini-cli turn: the base env minus every Anthropic/OpenAI/Google token and routing variable,
 * GEMINI_CLI_HOME pinned to the account's dir, and GOOGLE_GENAI_USE_GCA so headless runs use the account's
 * "Login with Google" OAuth file. deck never reads that file.
 */
export function geminiEnv(account: GeminiAccount, base: NodeJS.ProcessEnv, home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const v of [...TOKEN_VARS, ...ROUTING_VARS, ...OPENAI_VARS, ...GEMINI_VARS]) delete env[v];
  env.GEMINI_CLI_HOME = geminiHome(account, home);
  env.GOOGLE_GENAI_USE_GCA = 'true';
  // macOS seatbelt: writes only to the workspace, tmp/cache and the account's .gemini dir.
  env.SEATBELT_PROFILE = 'permissive-open';
  return env;
}
