/** One line of `<configDir>/events.jsonl` (하이라이트): what happened in a session, or to the server itself. */
export type HighlightKind = 'turn' | 'permission' | 'question' | 'task' | 'interrupted' | 'server' | 'commander';

export type HighlightEvent = {
  /** epoch ms */
  at: number;
  kind: HighlightKind;
  /** null = the server itself (start, drain) or a turn before it had a session id. */
  sessionId: string | null;
  cwd: string;
  /** The session's title when it happened. */
  title: string;
  body: string;
  /** kind 'turn' only: completed (true) or failed (false). */
  ok?: boolean;
};

/** GET /api/highlights?hours= — the windows the UI offers; anything else is clamped to the default. */
export const HIGHLIGHT_HOURS = [6, 12, 24] as const;
export const DEFAULT_HIGHLIGHT_HOURS = 24;
