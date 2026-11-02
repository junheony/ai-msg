import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { YAPPING_READ_SCRIPT } from './yapping-read';

let python = true;
try { execFileSync('python3', ['-c', 'import sqlite3, yaml'], { stdio: 'ignore' }); } catch { python = false; }
/** Integration exercise of the real SQL, service-day boundary and safe projection; all writes are temporary setup. */
describe.skipIf(!python)('read-only Python projection', () => {
  it('reads correct cap counters and whitelisted records without modifying sqlite or leaking config fields', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yapping-reader-'));
    try {
      mkdirSync(path.join(root, 'config')); mkdirSync(path.join(root, 'data'));
      writeFileSync(path.join(root, 'config/targets.yaml'), 'breaking:\n  max_qt_per_day: 5\n  total_qt_max_per_day: 7\ndata_reports:\n  max_qt_per_day: 2\nreplies_auto:\n  daily_soft_cap: 40\nai_news:\n  tg_channel: "@blockschool"\n  irrelevant_value: "DO_NOT_PROJECT"\n');
      writeFileSync(path.join(root, 'data/watchdog.json'), JSON.stringify({ at: '2026-11-02T02:00:00+09:00', followers: { at: '2026-11-02T02:00:00+09:00', followers: 508, delta_since_last_run: 3, irrelevant_value: 'DO_NOT_PROJECT' } }));
      execFileSync('python3', ['-c', String.raw`
import sqlite3, sys, json, pathlib
c=sqlite3.connect(str(pathlib.Path(sys.argv[1])/'data/yb.db'))
c.executescript('CREATE TABLE kv(key TEXT,value TEXT); CREATE TABLE post_drafts(tweet_id TEXT,posted_at TEXT,text TEXT,status TEXT,kind TEXT); CREATE TABLE reply_items(status TEXT,done_at TEXT); CREATE TABLE ai_news_items(tg_message_id,tg_posted_at TEXT,headline TEXT);')
c.execute('INSERT INTO kv VALUES(?,?)',('qt_auto_plan',json.dumps({'day':'2026-11-01','created_at':'2026-11-01T03:00:00+09:00','slots':[{'lane':'breaking','state':'done'},{'lane':'breaking','state':'pending'},{'lane':'breaking','state':'missed'},{'lane':'report','state':'leased'}]})))
for i, t in enumerate(['2026-11-01T02:59:59+09:00','2026-11-01T03:00:00+09:00','2026-11-01T12:00:00+09:00','2026-11-02T01:00:00+09:00']):
    c.execute('INSERT INTO post_drafts VALUES(?,?,?,?,?)',(str(100+i),t,'post'+str(i),'posted','ai_news_qt'))
    c.execute('INSERT INTO ai_news_items VALUES(?,?,?)',(200+i if i%2 else str(200+i),t,'mirror'+str(i)))
for t in ['2026-11-01T23:59:59+09:00','2026-11-02T00:00:00+09:00','2026-11-02T01:00:00+09:00']:
    c.execute('INSERT INTO reply_items VALUES(?,?)',('done',t))
c.commit(); c.close()
`, root]);
      const db = path.join(root, 'data/yb.db');
      const digest = () => createHash('sha256').update(readFileSync(db)).digest('hex');
      const hash = digest(), mtime = statSync(db).mtimeMs;
      const raw = execFileSync('python3', ['-c', YAPPING_READ_SCRIPT, root, String(Date.parse('2026-11-01T17:00:00Z'))], { encoding: 'utf8', timeout: 3000 });
      const data = JSON.parse(raw);
      expect(data.errors).toEqual([]);
      expect(data.caps).toEqual({ breaking: 5, report: 2, total: 7, replies: 40 });
      expect(data.plan).toMatchObject({ day: '2026-11-01', breaking: 2, report: 1, posted: 3, reserved: 2 });
      expect(data.replies).toBe(2);
      expect(data.posts).toHaveLength(3); expect(data.mirrors).toHaveLength(3);
      expect(data.posts[0].tweet_id).toBe('103'); expect(data.mirrors[0].tg_message_id).toBe(203);
      expect(data.followers.delta_since_last_run).toBe(3);
      expect(raw).not.toContain('DO_NOT_PROJECT');
      expect(raw).not.toContain(root);
      expect(digest()).toBe(hash); expect(statSync(db).mtimeMs).toBe(mtime);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
