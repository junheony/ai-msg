import { describe, expect, it, vi } from 'vitest';
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

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, p);
    out[rel] = e.isDirectory() ? '<dir>' : await sha256File(p);
  }
  return out;
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

  it('accepts a target that is a byte-prefix of the source (older deck copy) and keeps target-only companions', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 100));
    await fs.writeFile(path.join(tDir, ID, 'only-on-target.txt'), 'k');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r).toMatchObject({ ok: true });
    expect(await sha256File(path.join(tDir, `${ID}.jsonl`))).toBe(await sha256File(path.join(srcDir, `${ID}.jsonl`)));
    expect(await fs.readFile(path.join(tDir, ID, 'only-on-target.txt'), 'utf8')).toBe('k');
    expect(await fs.readFile(path.join(tDir, ID, 'custom-title.json'), 'utf8')).toBe('{"customTitle":"T"}');
    expect((await fs.readdir(tDir)).filter((n) => n.includes('deck-tmp'))).toEqual([]);
  });

  it('refuses a diverged target and leaves it byte-identical', async () => {
    const { srcDir, dstRoot } = await fixture();
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), 'old\n');
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const snap = await snapshot(tDir);
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('대상 세션이 따로 진행됨');
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('leaves the target unchanged when the companion copy fails after staging the jsonl', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 40));
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const locked = path.join(srcDir, ID, 'subagents', 'agent-1.jsonl');
    await fs.chmod(locked, 0o000);
    const snap = await snapshot(tDir);
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
    } finally {
      await fs.chmod(locked, 0o600);
    }
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('rolls the companions back when the final jsonl rename (commit point) fails', async () => {
    const { srcDir, dstRoot } = await fixture();
    const src = await fs.readFile(path.join(srcDir, `${ID}.jsonl`));
    const tDir = path.join(dstRoot, '-Users-x-proj');
    await fs.mkdir(path.join(tDir, ID), { recursive: true });
    await fs.writeFile(path.join(tDir, `${ID}.jsonl`), src.subarray(0, 40));
    await fs.writeFile(path.join(tDir, ID, 'keep.txt'), 'k');
    const snap = await snapshot(tDir);
    const real = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (String(b) === path.join(tDir, `${ID}.jsonl`)) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
      return real(a, b);
    });
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot(tDir)).toEqual(snap);
  });

  it('refuses when the source changes mid-copy and leaves the target untouched', async () => {
    const { srcDir, dstRoot } = await fixture();
    const srcFile = path.join(srcDir, `${ID}.jsonl`);
    const real = fs.cp.bind(fs);
    const spy = vi.spyOn(fs, 'cp').mockImplementation(async (...args: Parameters<typeof fs.cp>) => {
      await real(...args);
      await fs.appendFile(srcFile, '{"type":"user","late":true}\n');
    });
    try {
      const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('원본이 복사 중 바뀜');
    } finally {
      spy.mockRestore();
    }
    const tDir = path.join(dstRoot, '-Users-x-proj');
    expect(await fs.readdir(tDir).catch(() => [])).toEqual([]);
  });

  it('refuses when the same session id already exists in another directory of the target profile', async () => {
    const { srcDir, dstRoot } = await fixture();
    const other = path.join(dstRoot, '-Users-x-proj-nfd');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, `${ID}.jsonl`), 'x\n');
    const r = await moveSession({ sessionId: ID, sourceProjectDir: srcDir, targetProjectsRoot: dstRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('-Users-x-proj-nfd');
    await expect(fs.stat(path.join(dstRoot, '-Users-x-proj', `${ID}.jsonl`))).rejects.toThrow();
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
