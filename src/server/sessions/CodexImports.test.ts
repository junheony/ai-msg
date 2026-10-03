import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexRolloutIndex, readRolloutHead, rolloutRecentlyActive } from './CodexImports';
import { SessionIndex } from './SessionIndex';
import { CLI_ID, DESKTOP_ID, GONE_ID, SUB_ID, assistant, jsonl, meta, user, writeFixtures } from './codexFixtures';

let base: string;
let root: string;
let work: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-codex-import-'));
  root = path.join(base, 'sessions');
  work = path.join(base, 'work');
  await fs.mkdir(work);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe('readRolloutHead', () => {
  it('reads thread id, cwd and the first real prompt (Desktop request section, first line, trimmed)', async () => {
    const { desktop, cli } = await writeFixtures(root, work);
    expect(await readRolloutHead(desktop)).toEqual({ threadId: DESKTOP_ID, cwd: work, title: '스크린샷의 버그 고쳐줘' });
    expect(await readRolloutHead(cli)).toEqual({ threadId: CLI_ID, cwd: work, title: 'List the files' });
  });

  it('marks `codex exec` automation rollouts with exec: true', async () => {
    const f = path.join(base, 'exec.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work, { originator: 'codex_exec', source: 'exec' }), user('<environment_context>…'), user('You are the 3D asset lane\nmore')]));
    expect(await readRolloutHead(f)).toEqual({ threadId: CLI_ID, cwd: work, title: 'You are the 3D asset lane', exec: true });
    const g = path.join(base, 'exec2.jsonl');
    await fs.writeFile(g, jsonl([meta(CLI_ID, work, { originator: 'codex_exec' }), user('x')]));
    expect((await readRolloutHead(g))?.exec).toBe(true);
  });

  it('takes the prompt after either Desktop request heading', async () => {
    const f = path.join(base, 'r.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work), user('\n# Files mentioned by the user:\n\n## x.png: /tmp/x.png\n## My request:\n이거 파악해봐 \n')]));
    expect((await readRolloutHead(f))?.title).toBe('이거 파악해봐');
  });

  it('null for sub-agent threads and files that do not start with session_meta', async () => {
    await writeFixtures(root, work);
    const dir = path.join(root, '2026', '10', '01');
    expect(await readRolloutHead(path.join(dir, `rollout-2026-10-01T12-00-00-${SUB_ID}.jsonl`))).toBeNull();
    expect(await readRolloutHead(path.join(dir, 'rollout-junk.jsonl'))).toBeNull();
  });

  it('stops at the byte cap: a prompt beyond it leaves the title null', async () => {
    const f = path.join(base, 'big.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work), user(`<huge>${'y'.repeat(200_000)}</huge>`), user('late prompt')]));
    expect(await readRolloutHead(f, 64 * 1024)).toEqual({ threadId: CLI_ID, cwd: work, title: null });
    expect((await readRolloutHead(f))?.title).toBe('late prompt');
  });
});

describe('CodexRolloutIndex', () => {
  it('lists user threads whose folder exists, as gpt/codex entries; heads are read once per file', async () => {
    const { desktop } = await writeFixtures(root, work);
    let reads = 0;
    const idx = new CodexRolloutIndex(root, async (f) => { reads++; return readRolloutHead(f); });
    await idx.refresh();
    const list = idx.list().sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(list.map((e) => e.sessionId)).toEqual([DESKTOP_ID, CLI_ID]);
    expect(list[0]).toMatchObject({ account: 'gpt', engine: 'codex', cwd: work, file: desktop, projectDir: path.dirname(desktop), title: '스크린샷의 버그 고쳐줘', imported: true });
    expect(idx.lookup(CLI_ID)?.title).toBe('List the files');
    expect(idx.lookup(SUB_ID)).toBeNull();
    expect(idx.lookup(GONE_ID)).toBeNull();
    const first = reads;
    expect(first).toBe(5);

    // Appending (the thread goes on) only bumps activity; the head is not re-read.
    await fs.appendFile(desktop, jsonl([assistant('more')]));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(desktop, later, later);
    await idx.refresh();
    expect(reads).toBe(first);
    expect(idx.lookup(DESKTOP_ID)?.lastModified).toBe(later.getTime());
  });

  it('lists `codex exec` threads written within 7 days (codexExec), not older ones, not gone folders, not sub-agents', async () => {
    const dir = path.join(root, '2026', '10', '03');
    await fs.mkdir(dir, { recursive: true });
    const id = (n: string) => `01a0f2d3-0000-7c92-aeea-0000000000${n}`;
    const write = async (n: string, cwd: string, extra: Record<string, unknown>, ageMs: number) => {
      const f = path.join(dir, `rollout-2026-10-03T10-00-${n}-${id(n)}.jsonl`);
      await fs.writeFile(f, jsonl([meta(id(n), cwd, { originator: 'codex_exec', source: 'exec', ...extra }), user('run lane')]));
      const t = new Date(NOW - ageMs);
      await fs.utimes(f, t, t);
    };
    const NOW = Date.now();
    const DAY = 86_400_000;
    await write('e1', work, {}, DAY);
    await write('e2', work, {}, 8 * DAY);
    await write('e3', path.join(work, 'gone'), {}, DAY);
    await write('e4', work, { thread_source: 'subagent' }, DAY);
    const idx = new CodexRolloutIndex(root, readRolloutHead, () => NOW);
    await idx.refresh();
    expect(idx.list().map((e) => e.sessionId)).toEqual([id('e1')]);
    expect(idx.lookup(id('e1'))).toMatchObject({ account: 'gpt', engine: 'codex', imported: true, codexExec: true, title: 'run lane' });

    // Seven days later the same thread has aged out.
    const later = new CodexRolloutIndex(root, readRolloutHead, () => NOW + 7 * DAY);
    await later.refresh();
    expect(later.list()).toEqual([]);
  });

  it('non-exec threads carry no codexExec flag', async () => {
    await writeFixtures(root, work);
    const idx = new CodexRolloutIndex(root);
    await idx.refresh();
    expect(idx.list().every((e) => !('codexExec' in e))).toBe(true);
  });

  it('missing root → empty', async () => {
    const idx = new CodexRolloutIndex(path.join(base, 'nope'));
    await idx.refresh();
    expect(idx.list()).toEqual([]);
  });
});

describe('SessionIndex with codexRoot', () => {
  it('lists imported threads under their project, and not again once deck runs the thread', async () => {
    await writeFixtures(root, work);
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json'), codexRoot: root });
    await index.refresh();
    const project = index.projects().find((p) => p.cwd === work);
    expect(project?.sessions.map((s) => s.sessionId).sort()).toEqual([DESKTOP_ID, CLI_ID]);
    expect(index.codexImport(DESKTOP_ID)?.imported).toBe(true);

    const own = { sessionId: CLI_ID, account: 'gpt' as const, engine: 'codex' as const, cwd: work, projectDir: '', file: '', title: 'deck title', lastModified: 1, sizeBytes: 0 };
    const sessions = index.projects([own]).find((p) => p.cwd === work)!.sessions;
    expect(sessions.filter((s) => s.sessionId === CLI_ID)).toEqual([own]);
  });
});

describe('rolloutRecentlyActive', () => {
  it('true within 2 minutes of the last write, false after or when missing', async () => {
    const { cli } = await writeFixtures(root, work);
    const mtime = (await fs.stat(cli)).mtimeMs;
    expect(await rolloutRecentlyActive(cli, mtime + 60_000)).toBe(true);
    expect(await rolloutRecentlyActive(cli, mtime + 3 * 60_000)).toBe(false);
    expect(await rolloutRecentlyActive(path.join(base, 'missing'), mtime)).toBe(false);
  });
});

describe('SessionIndex codexInBackground', () => {
  it('resolves before the Codex read finishes and calls onChange once threads are in', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-idx-bg-'));
    const work = path.join(base, 'work');
    await fs.mkdir(work);
    const root = path.join(base, 'codex');
    await writeFixtures(root, work);
    const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') };
    const index = new SessionIndex({ roots, pinnedFile: path.join(base, 'p.json'), codexRoot: root });
    const changed = new Promise<void>((r) => { index.onChange = r; });
    await index.refresh({ codexInBackground: true });
    expect(index.codexImport(DESKTOP_ID)).toBeNull();
    await changed;
    expect(index.codexImport(DESKTOP_ID)).not.toBeNull();
    await fs.rm(base, { recursive: true, force: true });
  });
});
