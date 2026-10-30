/**
 * MSG mini: the compact, read-only status `GET /api/mini/status` answers for the /mini page and the lock-screen widget.
 * Small by design (under 4 kB): at most three sessions, one line per seat, one state per hub mode. Never a path, never
 * a secret (the server strips both before answering).
 */

export type MiniSessionState = 'running' | 'idle' | 'waiting';

export interface MiniSession {
  /** The session's title (the first prompt, or the deck title); never a path. */
  title: string;
  engine: 'claude' | 'codex' | 'gemini' | 'grok' | null;
  /** Deck model id (opus, fable, gpt-5…) or wire id; null = unknown. */
  model: string | null;
  /** The seat the last turn ran on (a, b, c, gpt…); null = unknown. */
  account: string | null;
  /** Context fill of the last main-model call, 0–100; null = not measured (GPT/Gemini/Grok, or no turn yet). */
  contextPct: number | null;
  /** Context size (input + cache read + cache write) of that call; null = unknown. Named without "token" so the secret filter leaves it. */
  context: number | null;
  /** Output of the running turn so far, or of the last finished turn (tokens). */
  out: number;
  /** Cache-read tokens of the last finished turn. */
  cacheRead: number;
  /** Rough USD cost of the turns seen since the server started; null = no price for the model. */
  costUsd: number | null;
  /** Turns started since the server started (this session). */
  turns: number;
  /** The last user prompt, cut to 80 characters; '' = none seen. */
  lastPrompt: string;
  state: MiniSessionState;
  /** How long ago the session last changed (ms); null = never. */
  updatedAgoMs: number | null;
  /** How long the running turn has been going (ms); 0 when not running. */
  forMs: number;
}

export interface MiniSeat {
  id: string;
  label: string;
  status: 'ok' | 'stale' | 'down';
  /** Left in the 5-hour window, 0–100; null = unknown. */
  left5h: number | null;
  /** Left in the weekly window, 0–100; null = unknown. */
  leftWeek: number | null;
  /** ISO resets of those windows; null = unknown. */
  resets5h: string | null;
  resetsWeek: string | null;
}

export type MiniHubState = 'ok' | 'warn' | 'down' | 'idle' | 'unknown';

export interface MiniHubMode {
  id: string;
  name: string;
  state: MiniHubState;
}

export interface MiniHub {
  modes: MiniHubMode[];
  counts: Record<MiniHubState, number>;
  /** The worst state of any mode: down > warn > unknown > idle > ok. */
  worst: MiniHubState;
  /** When the hub aggregator last answered; null = never (not reachable yet). */
  generated_at: string | null;
}

export interface MiniStatus {
  /** Sessions with a turn in flight right now. */
  running: number;
  /** Sessions waiting on a permission / question card. */
  waiting: number;
  sessions: MiniSession[];
  seats: MiniSeat[];
  hub: MiniHub | null;
  generated_at: string;
}

export const MINI_MAX_SESSIONS = 3;
export const MINI_PROMPT_CHARS = 80;
export const MINI_MAX_BYTES = 4096;

/** The hub states, worst first (MiniHub.worst). */
export const MINI_HUB_WORST_ORDER: readonly MiniHubState[] = ['down', 'warn', 'unknown', 'idle', 'ok'];
