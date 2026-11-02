/** Fixed read-only projection: no imports from yapping-bot (its getters may mutate state). */
export const YAPPING_READ_SCRIPT = String.raw`
import json, pathlib, sqlite3, sys
from datetime import datetime, timedelta, timezone
root = pathlib.Path(sys.argv[1])
now = datetime.fromtimestamp(float(sys.argv[2])/1000, timezone(timedelta(hours=9)))
out = {'at': now.isoformat(), 'day': (now-timedelta(hours=3)).date().isoformat(), 'errors': []}
def error(name): out['errors'].append(name)
try:
    import yaml
    cfg = yaml.safe_load((root/'config/targets.yaml').read_text()) or {}
    b, r, a, rep = (cfg.get(k) or {} for k in ('breaking','data_reports','ai_news','replies_auto'))
    out['caps'] = {'breaking': b.get('max_qt_per_day'), 'report': r.get('max_qt_per_day'), 'total': b.get('total_qt_max_per_day'), 'replies': rep.get('daily_soft_cap')}
    channel = a.get('tg_channel') or ''
except Exception:
    channel = ''
    error('운영 설정')
try:
    w = json.loads((root/'data/watchdog.json').read_text())
    f = w.get('followers') or {}
    out['followers'] = {k:f.get(k) for k in ('at','followers','delta_since_last_run')}
except Exception: error('팔로워 관측')
try:
    c = sqlite3.connect((root/'data/yb.db').as_uri()+'?mode=ro', uri=True, timeout=.3)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    def rows(sql, args=()): return [dict(r) for r in c.execute(sql,args)]
    r = c.execute('SELECT value FROM kv WHERE key=?',('qt_auto_plan',)).fetchone()
    p = json.loads(r[0]) if r else {}
    slots = p.get('slots') or []
    live = [s for s in slots if s.get('state') in ('done','pending','leased')]
    out['plan'] = {'day':p.get('day'), 'created_at':p.get('created_at'), 'breaking':sum(s.get('lane')=='breaking' for s in live), 'report':sum(s.get('lane')=='report' for s in live), 'reserved':sum(s.get('state') in ('pending','leased') for s in slots)}
    base = datetime.fromisoformat(out['day']).replace(tzinfo=now.tzinfo)+timedelta(hours=3)
    n = c.execute("SELECT COUNT(*) FROM post_drafts WHERE kind='ai_news_qt' AND status='posted' AND posted_at>=? AND posted_at<?", (base.isoformat(), (base+timedelta(days=1)).isoformat())).fetchone()[0]
    out['plan']['posted'] = n
    out['replies'] = c.execute("SELECT COUNT(*) FROM reply_items WHERE status='done' AND done_at>=? AND done_at<?", (now.replace(hour=0,minute=0,second=0,microsecond=0).isoformat(), (now.replace(hour=0,minute=0,second=0,microsecond=0)+timedelta(days=1)).isoformat())).fetchone()[0]
    out['posts'] = rows("SELECT tweet_id,posted_at,text FROM post_drafts WHERE status='posted' AND tweet_id IS NOT NULL AND tweet_id<>'' ORDER BY posted_at DESC LIMIT 3")
    out['mirrors'] = rows("SELECT tg_posted_at,tg_message_id,headline FROM ai_news_items WHERE tg_message_id IS NOT NULL AND tg_message_id<>'' AND tg_posted_at<>'pending' ORDER BY tg_posted_at DESC LIMIT 3")
    # Only a public channel handle may leave this projection, never a bot credential or private chat identifier.
    import re
    out['channel'] = channel.lstrip('@') if isinstance(channel,str) and re.fullmatch(r'@?[A-Za-z][A-Za-z0-9_]{3,}',channel) else None
    c.close()
except Exception: error('게시 기록')
print(json.dumps(out, ensure_ascii=False))
`;
