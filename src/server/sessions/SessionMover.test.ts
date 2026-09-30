import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveSession, sha256File } from './SessionMover';

const ID = '44444444-4444-4444-8444-444444444444';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-mv-'));
  const srcRoot = path.join(base, 'src', 'projects');
  const srcDir = path.join(srcRoot, '-Users-x-proj');
  await fs.mkdir(path.join(srcDir, ID, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(srcDir, `${ID}.jsonl`), '{"type":"user","cwd":"/Users/x/proj"}\n'.repeat(50));
  await fs.writeFile(path.join(srcDir, ID, 'subagents', 'agent-1.jsonl'), '{"a":1}\n');
  await fs.writeFile(path.join(srcDir, ID, 'custom-title.json'), '{"customTitle":"T"}');
  const dstRoot = path.join(base, 'dst', 'projects');
  return { base, srcRoot, srcDir, dstRoot };
}

describe('moveSession', () => {
  it('copies the jsonl and companion dir into the same slug dir and verifies', async () => {
    const { srcDir, dstRoot } = await fixture();
    const before = await sha256File(path.join(srcDir, `${ID}.jsonl`));
    const beforeStat = await fs.stat(path.join(srcDir, `${ID}.jsonl`));
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetDir).toBe(path.join(dstRoot, '-Users-x-proj'));
    expect(r.targetFile).toBe(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`));
    expect(await sha256File(r.targetFile)).toBe(before);
    expect(await fs.readFile(path.join(r.targetDir, ID, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(await fs.readFile(path.join(r.targetDir, ID, 'custom-title.json'), 'utf8')).toBe('{"customTitle":"T"}');
    expect(r.copied.sort()).toEqual([`${ID}.jsonl`, `${ID}/`].sort());
    expect(await fs.readdir(r.targetDir)).not.toContain(`${ID}.jsonl.deck-tmp`);
    // source untouched
    expect(await sha256File(path.join(srcDir, `${ID}.jsonl`))).toBe(before);
    expect((await fs.stat(path.join(srcDir, `${ID}.jsonl`))).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('overwrites an older copy at the target', async () => {
    const { srcDir, dstRoot } = await fixture();
    await fs.mkdir(path.join(dstRoot, '-Users-x-proj', ID), { recursive: true });
    await fs.writeFile(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`), 'old\n');
    await fs.writeFile(path.join(dstRoot, '-Users-x-proj', ID, 'stale.txt'), 'x');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(true);
    expect(await sha256File(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`))).toBe(await sha256File(path.join(srcDir, `${ID}.jsonl`)));
    await expect(fs.stat(path.join(dstRoot, '-Users-x-proj', ID, 'stale.txt'))).rejects.toThrow();
  });

  it('works without a companion dir and is a no-op when source == target', async () => {
    const { srcDir, srcRoot, dstRoot } = await fixture();
    await fs.rm(path.join(srcDir, ID), { recursive: true });
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.copied).toEqual([`${ID}.jsonl`]);
    const same = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: srcRoot });
    expect(same).toEqual({ ok: true, targetDir: srcDir, targetFile: path.join(srcDir, `${ID}.jsonl`), copied: [] });
  });

  it('fails cleanly when the source is missing or the target root is not writable', async () => {
    const { srcDir, dstRoot, base } = await fixture();
    const missing = await moveSession({ sessionId: '55555555-5555-4555-8555-555555555555', sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(missing.ok).toBe(false);
    const fileAsRoot = path.join(base, 'not-a-dir');
    await fs.writeFile(fileAsRoot, 'x');
    const bad = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: fileAsRoot });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
  });
});
