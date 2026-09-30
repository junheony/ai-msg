import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionDecision } from '../shared/turn-types';

export type AuditEntry = {
  ts: string;
  turnId: string;
  sessionId: string | null;
  toolName: string;
  /** 'answered' = an AskUserQuestion the user answered (answers themselves are never logged). */
  decision: PermissionDecision | 'answered';
  /** sha256 of the JSON input — lets you correlate without storing secrets (spec §6). */
  inputSha256: string;
};

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
}

export async function appendAudit(file: string, e: AuditEntry): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, JSON.stringify(e) + '\n', { mode: 0o600 });
}
