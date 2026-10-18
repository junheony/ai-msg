import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GROK_HELD_NOTICE, GrokSessionIndex, grokImportBlockReason, readGrokSummary } from './GrokImports';
import { CWD_MISSING_NOTICE } from './CodexImports';

let base: string;
let home: string;
let work: string;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grokimp-')));
  home = path.join(base, 'grok');
  work = path.join(base, 'work');
  await fs.mkdir(work);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

async function session(id: string, summary: Record<string, unknown>, group = 'g') {
  const dir = path.join(home, 'sessions', group, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd: work }, generated_title: `제목 ${id}`, updated_at: '2026-10-18T00:00:00Z', num_chat_messages: 3, grok_home: home, ...summary }));
  await fs.writeFile(path.join(dir, 'chat_history.jsonl'), `${JSON.stringify({ type: 'user', content: '첫 프롬프트' })}\n`);
  return dir;
}
const quiet = () => {};

describe('readGrokSummary', () => {
  it('reads the fields the list needs; null for a non-absolute cwd or bad id', async () => {
    const dir = await session('s1', { current_model_id: 'grok-4.6', reasoning_effort: 'low', session_kind: 'headless' });
    expect(await readGrokSummary(dir)).toMatchObject({ id: 's1', cwd: work, title: '제목 s1', model: 'grok-4.6', effort: 'low', kind: 'headless', numChatMessages: 3, updatedMs: Date.parse('2026-10-18T00:00:00Z') });
    const bad = await session('s2', { info: { id: 's2', cwd: 'rel' } });
    expect(await readGrokSummary(bad)).toBeNull();
  });
});

describe('GrokSessionIndex', () => {
  it('lists sessions as imported Grok entries; skips subagent, empty, other GROK_HOME and id/dir mismatches; marks headless autoRun', async () => {
    await session('main', { current_model_id: 'grok-4.6', reasoning_effort: 'low' });
    await session('auto', { session_kind: 'headless' });
    await session('sub', { session_kind: 'subagent' });
    await session('empty', { num_chat_messages: 0 });
    await session('other', { grok_home: path.join(base, 'elsewhere') });
    await session('renamed', { info: { id: 'not-renamed', cwd: work } });
    await session('untitled', { generated_title: null });
    const idx = new GrokSessionIndex(home, undefined, undefined, quiet);
    await idx.refresh();
    const byId = new Map(idx.list().map((e) => [e.sessionId, e]));
    expect([...byId.keys()].sort()).toEqual(['auto', 'main', 'untitled']);
    expect(byId.get('main')).toMatchObject({ engine: 'grok', account: 'x1', imported: true, cwd: work, title: '제목 main', grokModel: 'grok-4.6', grokEffort: 'low', file: expect.stringMatching(/chat_history\.jsonl$/) });
    expect(byId.get('main')!.autoRun).toBeUndefined();
    expect(byId.get('auto')).toMatchObject({ autoRun: true });
    expect(byId.get('untitled')).toMatchObject({ title: '첫 프롬프트' });
    expect(idx.lookup('main')).toBe(byId.get('main'));
  });

  it('hides a temp cwd that is gone (logged once), keeps a non-temp gone cwd as cwdMissing', async () => {
    await session('tmpgone', { info: { id: 'tmpgone', cwd: path.join(os.tmpdir(), 'deck-grokimp-gone-x', 'w') } });
    await session('gone', { info: { id: 'gone', cwd: '/nonexistent-deck-test-folder/w' } });
    const logs: string[] = [];
    const idx = new GrokSessionIndex(home, undefined, undefined, (m) => logs.push(m));
    await idx.refresh();
    expect(idx.list().map((e) => e.sessionId)).toEqual(['gone']);
    expect(idx.lookup('gone')).toMatchObject({ cwdMissing: true });
    await idx.refresh();
    expect(logs).toEqual(['grok imports: 1 hidden (temp cwd gone)']);
  });

  it('re-reads a summary only when it changed; a missing sessions dir is empty', async () => {
    const dir = await session('s', {});
    let reads = 0;
    const idx = new GrokSessionIndex(home, async (d) => { reads++; return readGrokSummary(d); }, undefined, quiet);
    await idx.refresh();
    await idx.refresh();
    expect(reads).toBe(1);
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: 's', cwd: work }, generated_title: '바뀐 제목', num_chat_messages: 4 }));
    await idx.refresh();
    expect(reads).toBe(2);
    expect(idx.lookup('s')).toMatchObject({ title: '바뀐 제목' });
    const none = new GrokSessionIndex(path.join(base, 'none'), undefined, undefined, quiet);
    await none.refresh();
    expect(none.list()).toEqual([]);
  });

  it('activeAgeMs: recent updates.jsonl within 2 minutes', async () => {
    const dir = await session('s', {});
    const idx = new GrokSessionIndex(home, undefined, undefined, quiet);
    await idx.refresh();
    await fs.writeFile(path.join(dir, 'updates.jsonl'), '{}\n');
    const st = await fs.stat(path.join(dir, 'updates.jsonl'));
    expect(await idx.activeAgeMs('s', st.mtimeMs + 1000)).toBe(1000);
    expect(await idx.activeAgeMs('s', st.mtimeMs + 10 * 60_000)).toBeNull();
    expect(await idx.activeAgeMs('nope')).toBeNull();
  });
});

describe('grokImportBlockReason', () => {
  it('refuses when a terminal grok holds the id, or the folder is gone', async () => {
    expect(await grokImportBlockReason({ sessionId: 's', cwd: work }, { grokHeldBy: (id) => (id === 's' ? { pid: 1 } : null) })).toBe(GROK_HELD_NOTICE);
    expect(await grokImportBlockReason({ sessionId: 's', cwd: work }, { grokHeldBy: () => null })).toBeNull();
    expect(await grokImportBlockReason({ sessionId: 's', cwd: '/nonexistent-deck-test-folder' }, null)).toBe(`${CWD_MISSING_NOTICE}: /nonexistent-deck-test-folder`);
  });
});
