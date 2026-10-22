// What the setup wizard and `ai-msg doctor` know about the installed CLIs (plan ② Task 4).

export type EngineId = 'claude' | 'codex' | 'gemini' | 'grok';
/** From the official status command's output / exit code only. 'unknown' = could not tell (never shown as logged out). */
export type LoginState = 'yes' | 'no' | 'unknown';
export type EngineProbe = { engine: EngineId; bin: string | null; version: string | null; login: LoginState; loginCommand: string; note?: string };
/** `dir` in `~/…` form. */
export type ClaudeProfileProbe = { id: string; label: string; dir: string; home: boolean; active: boolean; login: LoginState; loginCommand: string };
export type SetupStatus = {
  engines: EngineProbe[];
  claudeProfiles: ClaudeProfileProbe[];
  addresses: string[];
  needed: boolean;
  supervised: boolean;
  restartNeeded: boolean;
  /** `accounts.json` exists (without it profiles are discovered automatically until the first add). */
  accountsFile: boolean;
  checkedAt: string;
};
