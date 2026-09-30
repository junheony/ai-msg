import type { Account } from './accounts';

export type SessionEntry = {
  sessionId: string;
  account: Account;
  cwd: string;
  /** Absolute project dir the jsonl currently lives in (never derived from cwd). */
  projectDir: string;
  file: string;
  title: string;
  lastModified: number;
  sizeBytes: number;
};

export type PinnedProject = { cwd: string; name?: string };

export type ProjectEntry = { cwd: string; name: string; pinned: boolean; sessions: SessionEntry[] };

export type TranscriptMessage =
  | { kind: 'user'; text: string; ts: string | null }
  | { kind: 'assistant'; text: string; model: string | null; toolCalls: { id: string; name: string; input: unknown }[]; ts: string | null }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean; ts: string | null; /** content was cut to the size cap */ truncated?: boolean };
