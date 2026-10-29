// What the setup wizard and `ai-msg doctor` know about the installed CLIs (plan ② Task 4).

import type { GeminiAccount } from './accounts';

export type EngineId = 'claude' | 'codex' | 'gemini' | 'grok';
/** From the official status command's output / exit code only. 'unknown' = could not tell (never shown as logged out). */
export type LoginState = 'yes' | 'no' | 'unknown';
export type EngineProbe = { engine: EngineId; bin: string | null; version: string | null; login: LoginState; loginCommand: string; note?: string };
/** `dir` in `~/…` form. */
export type ClaudeProfileProbe = { id: string; label: string; dir: string; home: boolean; active: boolean; login: LoginState; loginCommand: string };
/** One agy seat. `dir` is the state directory in `~/…` form. Absent on an older server. */
export type GeminiSeatProbe = { id: GeminiAccount; label: string; dir: string; login: LoginState; loginCommand: string };
export type SetupStatus = {
  engines: EngineProbe[];
  claudeProfiles: ClaudeProfileProbe[];
  geminiSeats?: GeminiSeatProbe[];
  addresses: string[];
  needed: boolean;
  supervised: boolean;
  restartNeeded: boolean;
  /** `accounts.json` exists (without it profiles are discovered automatically until the first add). */
  accountsFile: boolean;
  checkedAt: string;
};
