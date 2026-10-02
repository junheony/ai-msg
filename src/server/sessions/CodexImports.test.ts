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

  it('null for `codex exec` automation rollouts', async () => {
    const f = path.join(base, 'exec.jsonl');
    await fs.writeFile(f, jsonl([meta(CLI_ID, work, { originator: 'codex_exec', source: 'exec' }), user('automated')]));
    expect(await readRolloutHead(f)).toBeNull();
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
