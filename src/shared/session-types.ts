import type { Seat } from './accounts';
import type { CodexSandbox, EngineKind } from './models';
import type { ContextUsage } from './turn-types';

export type SessionEntry = {
  sessionId: string;
  /** Claude profile the jsonl lives in, or 'gpt' for a deck-created Codex thread (D4). */
  account: Seat;
  /** Absent = 'claude' (Plan 1 entries). */
  engine?: EngineKind;
  sandbox?: CodexSandbox;
  cwd: string;
  /** Claude: absolute project dir the jsonl currently lives in (never derived from cwd). Codex: dir of the rollout file, or '' until known. */
  projectDir: string;
  file: string;
  title: string;
  lastModified: number;
  sizeBytes: number;
  /** deck-side 보관됨 (session-meta.json); hidden from the lists unless the 보관됨 filter is on. */
  archived?: boolean;
  /** A Codex Desktop / CLI thread read from ~/.codex/sessions that deck has not run yet (becomes a deck Codex session on the first turn). */
  imported?: boolean;
};

/** A recent Claude Desktop (Code tab) session; opened like any other session by `sessionId`. */
export type DesktopSession = {
  sessionId: string;
  /** Profile the transcript lives in now (A, or B/C after deck moved it). */
  account: Seat;
  title: string;
  cwd: string;
  /** basename of cwd */
  project: string;
  lastModified: number;
  archived?: boolean;
};

export type PinnedProject = { cwd: string; name?: string };

export type ProjectEntry = { cwd: string; name: string; pinned: boolean; sessions: SessionEntry[] };

export type TranscriptMessage =
  | { kind: 'user'; text: string; ts: string | null }
  | { kind: 'assistant'; text: string; model: string | null; toolCalls: { id: string; name: string; input: unknown }[]; ts: string | null; /** The API call's prompt tokens (Claude transcripts): restores the context gauge. */ usage?: ContextUsage }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; ts: string | null; /** content was cut to the size cap */ truncated?: boolean };
