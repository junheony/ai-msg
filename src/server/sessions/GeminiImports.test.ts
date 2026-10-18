import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { GEMINI_RUNNING_NOTICE, GeminiConversationIndex, SUMMARIES_DB, geminiRowToEntry, parseGeminiTime, snapshotSqlite, type GeminiRow } from './GeminiImports';

let base: string;
let state: string;
let tmp: string;
let work: string;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-gemimp-')));
  state = path.join(base, 'gemini');
  tmp = path.join(base, 'tmp');
  work = path.join(base, 'work');
  await fs.mkdir(state);
  await fs.mkdir(work);
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

const row = (over: Partial<GeminiRow> = {}): GeminiRow => ({
  conversation_id: 'c1', title: '버그 수정', preview: '첫 메시지\n둘째 줄', step_count: 4, last_modified_time: '2026-10-18 01:02:03.456789+00:00',
  workspace_uris: JSON.stringify([pathToFileURL(work).href]), status: 'IDLE', parent_conversation_id: null, nesting_depth: 0, killed: 0, not_fully_idle: 0, ...over,
});

/** A WAL-mode summaries db whose rows sit in the `-wal` only (no checkpoint) — the shape agy leaves while running. Returns the open db (close = checkpoint). */
function makeDb(rows: GeminiRow[]): DatabaseSync {
  const db = new DatabaseSync(path.join(state, SUMMARIES_DB));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, killed INTEGER, not_fully_idle INTEGER)');
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.conversation_id, r.title, r.preview, r.step_count, r.last_modified_time, r.workspace_uris, r.status, r.parent_conversation_id, r.nesting_depth, r.killed, r.not_fully_idle);
  return db;
}

describe('geminiRowToEntry', () => {
  it('maps a top-level conversation; skips sub-agents, killed, empty and folder-less ones', () => {
    const db = path.join(state, SUMMARIES_DB);
    expect(geminiRowToEntry(row(), 'g1', db, () => false)).toMatchObject({ sessionId: 'c1', account: 'g1', engine: 'gemini', cwd: work, title: '버그 수정', preview: '첫 메시지\n둘째 줄', imported: true, lastModified: Date.parse('2026-10-18T01:02:03.456Z') });
    expect(geminiRowToEntry(row({ title: null }), 'g1', db, () => false)).toMatchObject({ title: '첫 메시지' });
    expect(geminiRowToEntry(row({ nesting_depth: 1 }), 'g1', db, () => false)).toBeNull();
    expect(geminiRowToEntry(row({ parent_conversation_id: 'p' }), 'g1', db, () => false)).toBeNull();
    expect(geminiRowToEntry(row({ killed: 1 }), 'g1', db, () => false)).toBeNull();
    expect(geminiRowToEntry(row({ step_count: 0 }), 'g1', db, () => false)).toBeNull();
    expect(geminiRowToEntry(row({ workspace_uris: '[]' }), 'g1', db, () => false)).toBeNull();
    expect(geminiRowToEntry(row({ workspace_uris: JSON.stringify(['file:///nonexistent-deck-test/w']) }), 'g1', db, () => true)).toMatchObject({ cwdMissing: true });
    expect(geminiRowToEntry(row({ workspace_uris: JSON.stringify([pathToFileURL(path.join(os.tmpdir(), 'gone-x')).href]) }), 'g1', db, () => true)).toBeNull();
  });

  it('parseGeminiTime', () => {
    expect(parseGeminiTime('2026-10-18 01:02:03.456789+00:00')).toBe(Date.parse('2026-10-18T01:02:03.456Z'));
    expect(parseGeminiTime('junk')).toBeNull();
    expect(parseGeminiTime(null)).toBeNull();
  });
});

describe('GeminiConversationIndex', () => {
  it('reads rows still in the -wal from a copy, never writing next to the original, and removes the copy', async () => {
    const live = makeDb([row(), row({ conversation_id: 'sub', nesting_depth: 1 })]);
    try {
      expect((await fs.stat(path.join(state, `${SUMMARIES_DB}-wal`))).size).toBeGreaterThan(0);
      const before = (await fs.readdir(state)).sort();
      const idx = new GeminiConversationIndex([{ account: 'g1', dir: state }], tmp, undefined, undefined, () => {});
      await idx.refresh();
      expect(idx.list().map((e) => e.sessionId)).toEqual(['c1']);
      expect(idx.lookup('c1')).toMatchObject({ engine: 'gemini', cwd: work });
      expect((await fs.readdir(state)).sort()).toEqual(before);
      expect(await fs.readdir(tmp)).toEqual([]);
      expect(await idx.activeAgeMs('c1', Date.parse('2026-10-18T01:03:03.456Z'))).toBe(60_000);
    } finally {
      live.close();
    }
  });

  it('a torn copy (snapshot null) or unreadable copy keeps the last list', async () => {
    makeDb([row()]).close();
    const logs: string[] = [];
    let torn = false;
    const idx = new GeminiConversationIndex([{ account: 'g1', dir: state }], tmp, undefined, async (src, root) => (torn ? null : snapshotSqlite(src, root)), (m) => logs.push(m));
    await idx.refresh();
    expect(idx.list()).toHaveLength(1);
    torn = true;
    await fs.appendFile(path.join(state, SUMMARIES_DB), Buffer.alloc(0));
    await fs.utimes(path.join(state, SUMMARIES_DB), new Date(), new Date(Date.now() + 5000));
    await idx.refresh();
    expect(idx.list()).toHaveLength(1);
    expect(logs.some((m) => m.includes('keeping the last list'))).toBe(true);
  });

  it('agy marks a running conversation: activeAgeMs 0', async () => {
    makeDb([row({ not_fully_idle: 1 })]).close();
    const idx = new GeminiConversationIndex([{ account: 'g2', dir: state }], tmp, undefined, undefined, () => {});
    await idx.refresh();
    expect(idx.lookup('c1')).toMatchObject({ account: 'g2' });
    expect(await idx.activeAgeMs('c1', 0)).toBe(0);
  });

  it('heldReason: a RUNNING row touched within 2 minutes refuses (rescanned first); an older RUNNING or an idle one does not', async () => {
    const t = Date.parse('2026-10-18T01:02:03.456Z');
    makeDb([row({ status: 'CASCADE_RUN_STATUS_RUNNING' }), row({ conversation_id: 'c-idle' })]).close();
    const idx = new GeminiConversationIndex([{ account: 'g1', dir: state }], tmp, undefined, undefined, () => {});
    expect(await idx.heldReason('c1', t + 60_000)).toBe(GEMINI_RUNNING_NOTICE);
    expect(await idx.heldReason('c1', t + 3 * 60_000)).toBeNull();
    expect(await idx.activeAgeMs('c1', t + 3 * 60_000)).toBe(0);
    expect(await idx.heldReason('c-idle', t + 1000)).toBeNull();
    expect(await idx.heldReason('nope', t)).toBeNull();
  });

  it('a db torn copy after copy logs each reason once, again only after a good read', async () => {
    makeDb([row()]).close();
    const logs: string[] = [];
    let torn = true;
    const idx = new GeminiConversationIndex([{ account: 'g1', dir: state }], tmp, undefined, async (src, root) => (torn ? null : snapshotSqlite(src, root)), (m) => logs.push(m));
    const touch = async (k: number) => fs.utimes(path.join(state, SUMMARIES_DB), new Date(), new Date(Date.now() + k * 5000));
    for (let k = 1; k <= 3; k++) { await touch(k); await idx.refresh(); }
    expect(logs).toHaveLength(1);
    torn = false;
    await touch(4);
    await idx.refresh();
    torn = true;
    await touch(5);
    await idx.refresh();
    expect(logs).toHaveLength(2);
  });

  it('no db: empty', async () => {
    const idx = new GeminiConversationIndex([{ account: 'g1', dir: path.join(base, 'none') }], tmp, undefined, undefined, () => {});
    await idx.refresh();
    expect(idx.list()).toEqual([]);
  });
});
