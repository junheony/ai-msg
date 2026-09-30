import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionIndex, groupProjects, readPinned, scanProfile } from './SessionIndex';
import type { SessionEntry } from '../../shared/session-types';

const L = (o: unknown) => JSON.stringify(o) + '\n';
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

async function mkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'deck-idx-'));
}

async function writeSession(root: string, dir: string, id: string, cwd: string, title: string, mtimeMs: number) {
  const d = path.join(root, dir);
  await fs.mkdir(d, { recursive: true });
  const f = path.join(d, `${id}.jsonl`);
  await fs.writeFile(f, L({ type: 'user', cwd, sessionId: id, message: { role: 'user', content: title } }));
  await fs.utimes(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}

describe('scanProfile', () => {
  it('lists uuid.jsonl files with cwd/title and skips other files', async () => {
    const root = await mkRoot();
    await writeSession(root, '-Users-x-proj', ID1, '/Users/x/proj', 'hello', 1_000_000);
    await fs.writeFile(path.join(root, '-Users-x-proj', 'notes.txt'), 'x');
    await fs.mkdir(path.join(root, '-Users-x-proj', ID1, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(root, '-Users-x-proj', ID1, 'subagents', 'agent-1.jsonl'), L({ type: 'user', cwd: '/Users/x/proj', message: { role: 'user', content: 'sub' } }));
    await fs.mkdir(path.join(root, '-Users-x-other'));
    await fs.writeFile(path.join(root, '-Users-x-other', `${ID2}.jsonl`), L({ type: 'queue-operation' }));
    const entries = await scanProfile('b', root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: ID1, account: 'b', cwd: '/Users/x/proj', title: 'hello', lastModified: 1_000_000, projectDir: path.join(root, '-Users-x-proj') });
    expect(entries[0]?.file).toBe(path.join(root, '-Users-x-proj', `${ID1}.jsonl`));
  });

  it('returns [] for a missing root', async () => {
    expect(await scanProfile('a', '/nonexistent/deck-root')).toEqual([]);
  });
});

describe('groupProjects', () => {
  const e = (sessionId: string, account: 'a' | 'b' | 'c', cwd: string, lastModified: number): SessionEntry => ({
    sessionId, account, cwd, projectDir: '/p', file: '/p/' + sessionId + '.jsonl', title: 't', lastModified, sizeBytes: 1,
  });

  it('groups by cwd, pinned first in pinned order, sessions newest first, duplicates keep the newest', () => {
    const projects = groupProjects(
      [e(ID1, 'a', '/w/one', 10), e(ID2, 'b', '/w/two', 50), e(ID3, 'c', '/w/one', 30), e(ID1, 'c', '/w/one', 40)],
      [{ cwd: '/w/two', name: 'Two' }, { cwd: '/w/empty' }],
    );
    expect(projects.map((p) => [p.cwd, p.name, p.pinned])).toEqual([
      ['/w/two', 'Two', true],
      ['/w/empty', 'empty', true],
      ['/w/one', 'one', false],
    ]);
    const one = projects[2]!;
    expect(one.sessions.map((s) => [s.sessionId, s.account])).toEqual([[ID1, 'c'], [ID3, 'c']]);
  });
});

describe('readPinned + SessionIndex', () => {
  it('reads projects.json ([] when missing) and lookup prefers the newest copy across profiles', async () => {
    const ra = await mkRoot();
    const rb = await mkRoot();
    const rc = await mkRoot();
    await writeSession(ra, '-w-one', ID1, '/w/one', 'a copy', 1_000);
    await writeSession(rb, '-w-one', ID1, '/w/one', 'b copy', 2_000);
    const pinnedFile = path.join(ra, 'projects.json');
    expect(await readPinned(pinnedFile)).toEqual([]);
    await fs.writeFile(pinnedFile, JSON.stringify([{ cwd: '/w/one', name: 'One' }]));
    const idx = new SessionIndex({ roots: { a: ra, b: rb, c: rc }, pinnedFile });
    await idx.refresh();
    expect(idx.lookup(ID1)?.account).toBe('b');
    expect(idx.lookup('nope')).toBeNull();
    expect(idx.projects()[0]).toMatchObject({ cwd: '/w/one', name: 'One', pinned: true });
    expect(idx.projects()[0]?.sessions).toHaveLength(1);
  });
});
