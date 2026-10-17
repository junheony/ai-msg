import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendAudit, hashInput, recordAudit, type AuditEntry } from './audit';

const entry = (i: number): AuditEntry => ({ ts: `t${i}`, turnId: 'tu', sessionId: 's', toolName: 'Bash', decision: 'allow', source: 'rule', inputSha256: hashInput({ i }) });

describe('appendAudit', () => {
  it('rotates to <file>.1 once the log reaches maxBytes, keeps every line exactly once, and never loses order under concurrency', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'sub', 'audit.log');
    const one = JSON.stringify(entry(0)).length + 1;
    await Promise.all(Array.from({ length: 5 }, (_, i) => appendAudit(file, entry(i), one * 3)));
    const cur = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as AuditEntry).ts);
    const old = (await fs.readFile(`${file}.1`, 'utf8')).trim().split('\n').map((l) => (JSON.parse(l) as AuditEntry).ts);
    expect([...old, ...cur]).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(old).toHaveLength(3);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a failed write rejects for its caller but does not block the next one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    await fs.mkdir(file);
    await expect(appendAudit(file, entry(0))).rejects.toThrow();
    await fs.rm(file, { recursive: true });
    await appendAudit(file, entry(1));
    expect(await fs.readFile(file, 'utf8')).toContain('"ts":"t1"');
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('a rotation that fails (the .1 slot is a non-empty directory) still appends every line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    await fs.mkdir(`${file}.1`);
    await fs.writeFile(path.join(`${file}.1`, 'x'), 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i++) await appendAudit(file, entry(i), 10);
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as AuditEntry);
      expect(lines.map((l) => l.ts)).toEqual(['t0', 't1', 't2', 't3']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('commander audit entries / recordAudit', () => {
  it('the three commander kinds go in next to tool lines (which keep their shape without kind)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    const lines: AuditEntry[] = [
      entry(0),
      { kind: 'commander_verdict', ts: 't', sessionId: 's', epoch: 2, digestId: 'd1', verdict: 'human', reason: '확신 없음', judgeAccount: 'a', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { kind: 'commander_send', ts: 't', sessionId: 's', epoch: 2, hop: 3, sendKey: '2:3', inputSha256: hashInput('next') },
      { kind: 'commander_gate', ts: 't', turnId: 'tu:cmd3', sessionId: 's', hop: 3, toolName: 'Bash', decision: 'ask', inputSha256: hashInput('rm x') },
    ];
    for (const l of lines) await recordAudit(file, l);
    const read = (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as AuditEntry);
    expect(read).toEqual(lines);
    expect(read[0]).not.toHaveProperty('kind');
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('recordAudit never rejects (a failed write is logged)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-audit-'));
    const file = path.join(dir, 'audit.log');
    await fs.mkdir(file);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recordAudit(file, entry(0))).resolves.toBeUndefined();
      expect(err).toHaveBeenCalledOnce();
    } finally {
      err.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
