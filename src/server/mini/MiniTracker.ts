import type { ServerMessage } from '../../shared/protocol';
import type { TurnUsage } from '../../shared/turn-types';
import { MINI_PROMPT_CHARS } from '../../shared/mini-types';

/**
 * What the mini status knows of one session, gathered from the turn events ws hands every hook (WsDeps.notify).
 * In memory only, since the server started: a session that had no turn since then is simply not here.
 */
export type TrackedSession = {
  sessionId: string;
  engine: 'claude' | 'codex' | 'gemini' | 'grok' | null;
  model: string | null;
  account: string | null;
  /** The last turn_started's prompt, cut to MINI_PROMPT_CHARS. */
  lastPrompt: string;
  /** The last finished turn's usage; null until a result arrived. */
  usage: TurnUsage | null;
  /** The running turn's output so far (turn_progress), reset at turn_started. */
  progressOut: number;
  /** Turns started (first turn_started per turn id). */
  turns: number;
  /** Summed usage of the finished turns, for the cost hint. */
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The permission / question card the session waits on; null = none. */
  waitingOn: string | null;
  /** When the running turn started (ms); null = none running (or unknown). */
  runningSince: number | null;
  /** When this session last changed (ms). */
  updatedAt: number;
};

const MAX_SESSIONS = 200;

/** A turn's prompt as the widget shows it: the first line, cut to MINI_PROMPT_CHARS (an ellipsis when cut). */
export function clipPrompt(text: string, max = MINI_PROMPT_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : line;
}

/**
 * Follows the turn events for the mini status: which session runs, waits on a card, what its last prompt and usage
 * were. Bounded (the oldest sessions fall out past MAX_SESSIONS); never throws on a message it does not know.
 */
export class MiniTracker {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly turnsSeen = new Set<string>();
  constructor(private readonly now: () => number = Date.now) {}

  private get(sessionId: string): TrackedSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { sessionId, engine: null, model: null, account: null, lastPrompt: '', usage: null, progressOut: 0, turns: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, waitingOn: null, runningSince: null, updatedAt: this.now() };
      this.sessions.set(sessionId, s);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (oldest) this.sessions.delete(oldest.sessionId);
      }
    }
    return s;
  }

  observe(msg: ServerMessage): void {
    if (!('sessionId' in msg) || typeof msg.sessionId !== 'string' || !msg.sessionId) return;
    const t = this.now();
    switch (msg.type) {
      case 'turn_started': {
        const s = this.get(msg.sessionId);
        if (!this.turnsSeen.has(msg.turnId)) {
          this.turnsSeen.add(msg.turnId);
          if (this.turnsSeen.size > 5000) this.turnsSeen.delete(this.turnsSeen.values().next().value as string);
          s.turns += 1;
        }
        s.engine = msg.engine ?? s.engine ?? 'claude';
        s.model = msg.model;
        s.account = msg.account;
        if (msg.prompt?.text) s.lastPrompt = clipPrompt(msg.prompt.text);
        s.progressOut = 0;
        s.waitingOn = null;
        s.runningSince = t;
        s.updatedAt = t;
        return;
      }
      case 'turn_progress': {
        const s = this.get(msg.sessionId);
        s.progressOut = msg.outputTokens;
        s.waitingOn = null;
        s.updatedAt = t;
        return;
      }
      case 'permission_request':
      case 'question_request': {
        const s = this.get(msg.sessionId);
        s.waitingOn = msg.requestId;
        s.updatedAt = t;
        return;
      }
      case 'turn_result': {
        const s = this.get(msg.sessionId);
        if (msg.badge) {
          s.usage = msg.badge.usage;
          s.model = msg.model ?? msg.badge.model;
          s.account = msg.badge.account;
          const u = msg.badge.usage;
          s.totals.input += u.inputTokens;
          s.totals.output += u.outputTokens;
          s.totals.cacheRead += u.cacheReadTokens;
          s.totals.cacheWrite += u.cacheCreationTokens;
        } else if (msg.model) s.model = msg.model;
        s.waitingOn = null;
        s.runningSince = null;
        s.updatedAt = t;
        return;
      }
      case 'delta':
      case 'thinking':
      case 'tool_call':
      case 'tool_result':
      case 'turn_background': {
        // Any later turn event means the card was answered (the CLI only goes on after it).
        const s = this.get(msg.sessionId);
        s.waitingOn = null;
        s.updatedAt = t;
        return;
      }
      default:
        return;
    }
  }

  /** The permission / question card `requestId` was answered (ws broadcasts permission_resolved / question_resolved). */
  resolved(requestId: string): void {
    for (const s of this.sessions.values()) if (s.waitingOn === requestId) { s.waitingOn = null; s.updatedAt = this.now(); }
  }

  list(): TrackedSession[] {
    return [...this.sessions.values()];
  }

  session(sessionId: string): TrackedSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}
