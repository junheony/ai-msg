// src/server/engine/claudeCli/fork.test.ts
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { chainUpTo, forkCandidates, writeForkSource } from './fork';
import { FORK_AT_UNSUPPORTED, FORK_SOURCE_MISSING } from './texts';

const e = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', uuid, parentUuid, sessionId: 'p', message: { role: 'user', content: uuid }, ...extra });
const LINES = [
  JSON.stringify({ type: 'summary', summary: 'title', leafUuid: 'a2' }),
  e('u1', null),
  e('a1', 'u1', { type: 'assistant' }),
  e('u2', 'a1'),
  e('a2', 'u2', { type: 'assistant' }),
  e('side', 'a2', { isSidechain: true }),
  e('u3', 'a2'),
  e('a3', 'u3', { type: 'assistant' }),
  e('u2b', 'a1'), // an earlier edit's branch, after the main chain in the file
];

describe('chainUpTo', () => {
  it('keeps the chain from the root to `at`, plus leading metadata; drops later entries and other branches', () => {
    const out = chainUpTo(LINES, 'a2')!;
    expect(out.map((l) => JSON.parse(l).uuid ?? 'meta')).toEqual(['meta', 'u1', 'a1', 'u2', 'a2']);
  });
  it('follows logicalParentUuid across a compact boundary', () => {
    const lines = [e('u1', null), e('a1', 'u1'), e('cb', null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'a1' }), e('s', 'cb', { isCompactSummary: true }), e('a2', 's')];
    expect(chainUpTo(lines, 'a2')!.map((l) => JSON.parse(l).uuid)).toEqual(['u1', 'a1', 'cb', 's', 'a2']);
  });
  it('unknown `at` → null; junk lines are skipped', () => {
    expect(chainUpTo(LINES, 'nope')).toBeNull();
    expect(chainUpTo(['{bad', e('u1', null)], 'u1')).toEqual([e('u1', null)]);
  });
});

describe('forkCandidates', () => {
  it('slug of cwd, of its realpath and of both normal forms, deduplicated', () => {
    const cwd = '/w/작업'.normalize('NFC');
    const c = forkCandidates('/h/projects', cwd, 's1', () => '/private' + cwd);
    const slug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
    expect(c).toEqual([
      path.join('/h/projects', slug(cwd), 's1.jsonl'),
      path.join('/h/projects', slug(cwd.normalize('NFD')), 's1.jsonl'),
      path.join('/h/projects', slug('/private' + cwd), 's1.jsonl'),
      path.join('/h/projects', slug(('/private' + cwd).normalize('NFD')), 's1.jsonl'),
    ]);
  });
});

describe('writeForkSource', () => {
  let dir = '';
  afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });
  it('writes the truncated chain as <sessionId>.jsonl (0600) into the process dir', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-fork-'));
    const src = path.join(dir, 'p.jsonl');
    await fs.writeFile(src, LINES.join('\n') + '\n');
    const r = await writeForkSource({ candidates: [path.join(dir, 'missing.jsonl'), src], at: 'a1', dir, sessionId: 'p' });
    expect(r).toEqual({ ok: true, path: path.join(dir, 'p.jsonl.fork', 'p.jsonl') });
    if (!r.ok) return;
    expect((await fs.readFile(r.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).uuid ?? 'meta')).toEqual(['meta', 'u1', 'a1']);
    expect((await fs.stat(r.path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(src, 'utf8')).toBe(LINES.join('\n') + '\n');
  });
  it('no transcript → FORK_SOURCE_MISSING; `at` not in it → FORK_AT_UNSUPPORTED', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-fork-'));
    expect(await writeForkSource({ candidates: [path.join(dir, 'x.jsonl')], at: 'a1', dir, sessionId: 'p' })).toEqual({ ok: false, text: FORK_SOURCE_MISSING });
    const src = path.join(dir, 's.jsonl');
    await fs.writeFile(src, LINES.join('\n'));
    expect(await writeForkSource({ candidates: [src], at: 'zz', dir, sessionId: 'p' })).toEqual({ ok: false, text: FORK_AT_UNSUPPORTED });
  });
});

describe('fork fixtures (real CLI captures)', () => {
  const meta = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `${n}.meta.json`), 'utf8'));
  it('F0: stdout assistant uuids are the transcript uuids', () => { expect(meta('fork-parent').transcriptUuidsSeenOnStdout).toBe(true); });
  it('F1/F2: the fork saw only the kept history, under a new id in the cwd project', () => {
    const m = meta('fork-file');
    expect(m.result).toMatch(/KIWI/);
    expect(m.result).not.toMatch(/LIME/);
    expect(m.newId).toBe(true);
    expect(m.forkTranscriptInCwdProject).toBe(true);
    expect(m.sourceKeptWhole).toBe(true);
  });
});
