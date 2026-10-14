import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../shared/accounts';
import { StubEngine } from '../engine/StubEngine';
import { SessionIndex } from '../sessions/SessionIndex';
import { projectSlug } from '../sessions/slug';
import { UsageService } from '../usage/UsageService';
import { SessionStateStore } from './SessionState';
import { TurnRunner, type TurnRunnerDeps } from './TurnRunner';
import { rootsOf, testRegistry } from '../../shared/accounts.testkit';

const SID = '44444444-4444-4444-8444-444444444444';
const GPT = '45454545-4545-4545-8545-454545454545';
const GEM = '46464646-4646-4646-8646-464646464646';

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-cwd-'));
  const roots = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c') } as Record<Account, string>;
  for (const r of Object.values(roots)) await fs.mkdir(r, { recursive: true });
  const index = new SessionIndex({ roots: rootsOf(roots), pinnedFile: path.join(base, 'projects.json') });
  const store = new SessionStateStore(path.join(base, 'state.json'));
  await store.load();
  const usage = new UsageService({ accounts: testRegistry(), deckUrl: 'http://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
  const deps: TurnRunnerDeps = {
    accounts: testRegistry(), engine: new StubEngine(async () => []), index, store, usage,
    cooldownDir: path.join(base, 'cooldown'), protectedAccount: null, auditFile: path.join(base, 'audit.log'), projectsRoots: rootsOf(roots),
    codex: null, attachments: null, codexSessionsRoot: path.join(base, 'codex'),
  };
  /** The session's transcript (and its `<id>/` dir) in `account`'s `/w/one` project dir. */
  const seed = async (account: Account) => {
    const dir = path.join(roots[account]!, projectSlug('/w/one'));
    await fs.mkdir(path.join(dir, SID), { recursive: true });
    await fs.writeFile(path.join(dir, SID, 'tool.txt'), 'x');
    await fs.writeFile(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w/one', message: { role: 'user', content: 'seed' } }) + '\n');
    return dir;
  };
  return { deps, store, index, roots, seed };
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe('TurnRunner.setCwd (작업 폴더 바꾸기)', () => {
  it('moves every copy of a Claude transcript (and its <id>/ dir) to the new folder\'s project dir and stores the new cwd', async () => {
    const c = await setup();
    const fromA = await c.seed('a');
    const fromB = await c.seed('b');
    await c.index.refresh();
    const runner = new TurnRunner(c.deps);
    expect(await runner.setCwd(SID, '/w/two')).toEqual({ ok: true, engine: 'claude' });
    for (const [from, root] of [[fromA, c.roots.a!], [fromB, c.roots.b!]] as const) {
      const to = path.join(root, projectSlug('/w/two'));
      expect(await exists(path.join(from, `${SID}.jsonl`))).toBe(false);
      expect(await exists(path.join(to, `${SID}.jsonl`))).toBe(true);
      expect(await fs.readFile(path.join(to, SID, 'tool.txt'), 'utf8')).toBe('x');
    }
    // The index's copy (either profile) is the one deck runs: its dir in the new folder.
    expect(c.store.get(SID)).toMatchObject({ cwd: '/w/two' });
    expect(path.basename((c.store.get(SID) as { projectDir: string }).projectDir)).toBe(projectSlug('/w/two'));
  });

  it('the same slug moves nothing; an existing transcript at the target is refused and nothing moves', async () => {
    const c = await setup();
    const dir = await c.seed('a');
    await c.index.refresh();
    const runner = new TurnRunner(c.deps);
    // '/w/one' and '/w.one' share a slug: only the stored cwd changes.
    expect(await runner.setCwd(SID, '/w.one')).toEqual({ ok: true, engine: 'claude' });
    expect(c.store.get(SID)).toMatchObject({ cwd: '/w.one', projectDir: dir });
    const clash = path.join(c.roots.a!, projectSlug('/w/three'));
    await fs.mkdir(clash, { recursive: true });
    await fs.writeFile(path.join(clash, `${SID}.jsonl`), '{}\n');
    const r = await runner.setCwd(SID, '/w/three');
    expect(r.ok).toBe(false);
    expect(await exists(path.join(dir, `${SID}.jsonl`))).toBe(true);
    expect(c.store.get(SID)).toMatchObject({ cwd: '/w.one' });
  });

  it('a Codex session only changes its cwd; Gemini and unknown sessions are refused', async () => {
    const c = await setup();
    await c.store.set({ engine: 'codex', sessionId: GPT, cwd: '/w/one', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gpt-6-sol', sandbox: 'read-only', rolloutFile: null, createdAtMs: 1 });
    await c.store.set({ engine: 'gemini', sessionId: GEM, account: 'gemini', cwd: '/w/one', lastTurnAtMs: 1, justCompacted: false, defaultModel: 'gemini-pro', sandbox: 'read-only', createdAtMs: 1 } as never);
    const runner = new TurnRunner(c.deps);
    expect(await runner.setCwd(GPT, '/w/two')).toEqual({ ok: true, engine: 'codex' });
    expect(c.store.get(GPT)).toMatchObject({ cwd: '/w/two', sandbox: 'read-only' });
    expect((await runner.setCwd(GEM, '/w/two')).ok).toBe(false);
    expect((await runner.setCwd('47474747-4747-4747-8747-474747474747', '/w/two')).ok).toBe(false);
  });
});
