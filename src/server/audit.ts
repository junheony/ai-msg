import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionDecision } from '../shared/turn-types';
import type { JudgeUsage } from './commander/Judge';
import type { Verdict } from './commander/types';

/** One tool call (the original line shape — written without `kind`; readers treat a missing `kind` as 'tool'). */
export type ToolAuditEntry = {
  kind?: 'tool';
  ts: string;
  turnId: string;
  sessionId: string | null;
  toolName: string;
  /**
   * 'answered' = an AskUserQuestion the user answered (answers themselves are never logged); 'auto' = allowed by 자동 승인
   * without a card; 'allow' = run without a prompt (see `source`).
   */
  decision: PermissionDecision | 'answered' | 'auto' | 'allow';
  /**
   * Who decided: 'user' = a card the user answered, 'auto' = 모두 자동 승인, 'cli' = the CLI without asking (an allow
   * rule, the permission mode, or a tool that needs no permission), 'rule' = a deny rule (older lines: any no-prompt
   * call), 'deck' = deck refused it itself (malformed question, handoff note turn).
   */
  source?: 'user' | 'auto' | 'cli' | 'rule' | 'deck';
  /** sha256 of the JSON input — lets you correlate without storing secrets (spec §6). */
  inputSha256: string;
};

/** 총사령탑 판정 한 건(설계 §5 감사). */
export type CommanderVerdictEntry = {
  kind: 'commander_verdict';
  ts: string;
  sessionId: string;
  epoch: number;
  digestId: string;
  verdict: Verdict['verdict'];
  reason: string;
  /** 판정을 돌린 계정 id(실패로 계정을 못 골랐으면 null). */
  judgeAccount: string | null;
  usage: JudgeUsage | null;
};

/** 총사령탑 자동 전송 한 건 — 지시 본문은 해시만. */
export type CommanderSendEntry = {
  kind: 'commander_send';
  ts: string;
  sessionId: string;
  epoch: number;
  hop: number;
  sendKey: string;
  inputSha256: string;
};

/** 총사령탑 자동 턴의 3층 훅 판정 한 건 — Bash 는 명령 문자열, 그 밖은 입력 전체의 해시. */
export type CommanderGateEntry = {
  kind: 'commander_gate';
  ts: string;
  turnId: string;
  sessionId: string | null;
  hop: number;
  toolName: string;
  decision: 'allow' | 'ask' | 'deny';
  inputSha256: string;
  /** A person's turn gated only by DECK_DEV_COMMANDER_GATE (개발용), not an automatic turn. */
  dev?: true;
};

export type AuditEntry = ToolAuditEntry | CommanderVerdictEntry | CommanderSendEntry | CommanderGateEntry;

/** Past this size the log is moved to `<file>.1` (replacing the previous one) before the next line: at most ~2× this on disk. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
}

/** Per file: appends (and the size check before each) run one at a time, so two lines never race a rotation. */
const queues = new Map<string, Promise<void>>();

export function appendAudit(file: string, e: AuditEntry, maxBytes = AUDIT_MAX_BYTES): Promise<void> {
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = await fs.stat(file).then((st) => st.size, () => 0);
    // A failed rotation (e.g. `.1` is a directory, or not writable) never costs a line: the log just grows past the cap.
    if (size >= maxBytes) await fs.rename(file, `${file}.1`).catch((err: unknown) => console.warn('deck: audit log rotation failed', err instanceof Error ? err.message : err));
    await fs.appendFile(file, JSON.stringify(e) + '\n', { mode: 0o600 });
  });
  const done = run.catch(() => undefined);
  queues.set(file, done);
  void done.then(() => { if (queues.get(file) === done) queues.delete(file); });
  return run;
}

/** `appendAudit` that never rejects: the audit log is best-effort, a failed line is logged and dropped. */
export async function recordAudit(file: string, e: AuditEntry): Promise<void> {
  try {
    await appendAudit(file, e);
  } catch (err) {
    console.error('deck: audit log write failed', err instanceof Error ? err.message : err);
  }
}
