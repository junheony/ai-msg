import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_HIGHLIGHT_HOURS, HIGHLIGHT_HOURS, type HighlightEvent } from '../../shared/highlights';
import type { EngineKind } from '../../shared/models';
import { ago } from './Activity';
import { Sheet } from './Dialogs';
import { EngineMark } from './EngineMark';

export type HighlightFilter = 'all' | 'done' | 'failed' | 'ask' | 'task' | 'interrupted';
const FILTERS: { id: HighlightFilter; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'done', label: '완료' }, { id: 'failed', label: '실패' },
  { id: 'ask', label: '승인·질문' }, { id: 'task', label: '작업' }, { id: 'interrupted', label: '끊김' },
];
const HOURS_KEY = 'deck.highlightsHours';

type Look = { icon: string; tone: 'accent' | 'danger' | 'warn' | 'muted'; label: string };
export function lookOf(e: HighlightEvent): Look {
  switch (e.kind) {
    case 'turn': return e.ok === false ? { icon: '✕', tone: 'danger', label: '실패' } : { icon: '✓', tone: 'accent', label: '완료' };
    case 'permission': return { icon: '?', tone: 'warn', label: '승인' };
    case 'question': return { icon: '?', tone: 'warn', label: '질문' };
    case 'task': return { icon: '▸', tone: 'muted', label: '작업' };
    case 'interrupted': return { icon: '⚡', tone: 'warn', label: '끊김' };
    default: return { icon: '●', tone: 'muted', label: '서버' };
  }
}

export function matches(e: HighlightEvent, f: HighlightFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'done': return e.kind === 'turn' && e.ok !== false;
    case 'failed': return e.kind === 'turn' && e.ok === false;
    case 'ask': return e.kind === 'permission' || e.kind === 'question';
    case 'task': return e.kind === 'task';
    case 'interrupted': return e.kind === 'interrupted';
  }
}

export type HighlightCard = { key: string; server: boolean; sessionId: string | null; cwd: string; title: string; last: number; events: HighlightEvent[] };

/**
 * One card per session (newest event first inside), sessions by their latest event, newest first; the server's own
 * events (start, drain) on one 서버 card at the top. A turn whose session id was not known yet groups by its folder.
 */
export function groupHighlights(events: HighlightEvent[], f: HighlightFilter): HighlightCard[] {
  const cards = new Map<string, HighlightCard>();
  for (const e of [...events].sort((a, b) => b.at - a.at)) {
    if (!matches(e, f)) continue;
    const server = e.kind === 'server';
    const key = server ? 'server' : e.sessionId ?? `cwd:${e.cwd}`;
    let c = cards.get(key);
    if (!c) { c = { key, server, sessionId: server ? null : e.sessionId, cwd: e.cwd, title: server ? '서버' : e.title, last: e.at, events: [] }; cards.set(key, c); }
    c.events.push(e);
  }
  return [...cards.values()].sort((a, b) => (a.server !== b.server ? (a.server ? -1 : 1) : b.last - a.last));
}

/**
 * 완료 3 · 실패 1 · 승인 2 · 끊김 1 (zeros left out); the 서버 card counts its events. Background task counts only stand
 * in when the card has nothing else (the 작업 filter): a session's 120 tasks say nothing about what it got done.
 */
export function summaryOf(c: HighlightCard): string {
  if (c.server) return `${c.events.length}건`;
  const n = (p: (e: HighlightEvent) => boolean) => c.events.filter(p).length;
  const main = ([
    ['완료', n((e) => matches(e, 'done'))], ['실패', n((e) => matches(e, 'failed'))], ['승인', n((e) => matches(e, 'ask'))],
    ['끊김', n((e) => matches(e, 'interrupted'))],
  ] as const).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
  if (main.length) return main.join(' · ');
  const tasks = n((e) => matches(e, 'task'));
  return tasks ? `작업 ${tasks}` : '';
}

/** How many lines of what-was-done a card shows before the timeline. */
export const DIGEST_MAX = 3;

/**
 * The card body: what the session got done, newest first — each finished or failed turn's first reply line (the
 * `완료 · ` / `실패 · ` prefix goes; the icon says which) and interruptions, up to DIGEST_MAX. Approvals and background
 * tasks stay in the timeline: they are not outcomes. The 서버 card keeps its latest line only.
 */
export function digestOf(c: HighlightCard): HighlightEvent[] {
  if (c.server) return c.events.slice(0, 1);
  const out: HighlightEvent[] = [];
  for (const e of c.events) {
    if (e.kind !== 'turn' && e.kind !== 'interrupted') continue;
    if (!digestLine(e)) continue;
    out.push(e);
    if (out.length >= DIGEST_MAX) break;
  }
  return out;
}

/** The line a digest shows for an event: a turn's reply line without its 완료/실패 prefix ('' = nothing to show). */
export function digestLine(e: HighlightEvent): string {
  if (e.kind !== 'turn') return e.body;
  return e.body.replace(/^(완료|실패)(\s*·\s*|$)/, '').trim();
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function savedHours(): number {
  try {
    const n = Number(sessionStorage.getItem(HOURS_KEY));
    return (HIGHLIGHT_HOURS as readonly number[]).includes(n) ? n : DEFAULT_HIGHLIGHT_HOURS;
  } catch {
    return DEFAULT_HIGHLIGHT_HOURS;
  }
}

function Card({ c, now, engine, onOpen }: { c: HighlightCard; now: number; engine?: EngineKind | undefined; onOpen?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const project = c.server ? 'deck' : c.cwd.split('/').filter(Boolean).pop() ?? c.cwd;
  const summary = summaryOf(c);
  const head = (
    <>
      <span className="hl-title">{engine && <EngineMark engine={engine} decorative />}{c.title}</span>
      <span className="hl-meta"><span className="hl-project">{project}</span><span>{ago(now - c.last)}</span></span>
      {summary && <span className="hl-summary">{summary}</span>}
    </>
  );
  const digest = digestOf(c);
  return (
    <li className={`hl-card${c.server ? ' server' : ''}`} data-testid="hl-card">
      {onOpen
        ? <button type="button" className="hl-head" onClick={onOpen} title="이 세션 열기">{head}</button>
        : <div className="hl-head">{head}</div>}
      {digest.length > 0 && (
        <ul className="hl-digest" data-testid="hl-digest">
          {digest.map((e, i) => {
            const l = lookOf(e);
            return (
              <li key={`${e.at}-${i}`}>
                <span className={`hl-icon tone-${l.tone}`} title={l.label} aria-label={l.label}>{l.icon}</span>
                <span className="hl-body">{digestLine(e)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="text-btn hl-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '타임라인 접기' : `타임라인 ${c.events.length}건`}</button>
      {open && (
        <ol className="hl-timeline">
          {c.events.map((e, i) => {
            const l = lookOf(e);
            return (
              <li key={`${e.at}-${i}`}>
                <time>{hhmm(e.at)}</time>
                <span className={`hl-icon tone-${l.tone}`} title={l.label} aria-label={l.label}>{l.icon}</span>
                <span className="hl-body">{e.body}</span>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

/** 하이라이트: what happened per session over the last 6/12/24 hours (GET /api/highlights). */
export function Highlights({ onClose, onOpenSession, engineOf, fetchFn = fetch, now }: {
  onClose: () => void;
  onOpenSession: (sessionId: string, cwd: string, title: string) => void;
  engineOf?: (sessionId: string) => EngineKind | undefined;
  fetchFn?: typeof fetch;
  now?: number;
}) {
  const [hours, setHours] = useState(savedHours);
  const [filter, setFilter] = useState<HighlightFilter>('all');
  // What was loaded and for which period: another period's events are never shown under this one's caption.
  const [loaded, setLoaded] = useState<{ hours: number; events: HighlightEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest request may land: a slow answer for a period the user already left is dropped.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchFn(`/api/highlights?hours=${hours}`);
      if (!r.ok) throw new Error(`하이라이트를 불러오지 못했습니다 (${r.status})`);
      const list = ((await r.json()) as { events: HighlightEvent[] }).events;
      if (mine !== seq.current) return;
      setLoaded({ hours, events: list });
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err.message : '하이라이트를 불러오지 못했습니다');
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [fetchFn, hours]);

  useEffect(() => { void load(); }, [load]);

  const pickHours = (h: number) => {
    setHours(h);
    try { sessionStorage.setItem(HOURS_KEY, String(h)); } catch { /* private mode: not kept */ }
  };
  const at = now ?? Date.now();
  const events = loaded && loaded.hours === hours ? loaded.events : null;
  const cards = events ? groupHighlights(events, filter) : [];

  return (
    <Sheet className="usage-view highlights-view" label="하이라이트" onClose={onClose}>
      <div className="uv-inner">
        <header className="uv-head">
          <h2>하이라이트</h2>
          <button type="button" className="icon-btn sheet-btn" onClick={() => void load()} disabled={busy} aria-busy={busy} aria-label="새로고침" title={busy ? '읽는 중…' : '새로고침'}>↻</button>
          <button type="button" className="icon-btn sheet-btn" onClick={onClose} aria-label="닫기" title="닫기 (Esc)" autoFocus>✕</button>
        </header>
        <div className="uv-tabs" role="tablist" aria-label="기간">
          {HIGHLIGHT_HOURS.map((h) => <button key={h} type="button" role="tab" aria-selected={hours === h} className={hours === h ? 'on' : ''} onClick={() => pickHours(h)}>{h}시간</button>)}
        </div>
        <div className="hl-filters" role="group" aria-label="종류">
          {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        {error && <div className="uv-note error">{error}</div>}
        {!events && !error && <div className="uv-note muted">불러오는 중…</div>}
        {events && cards.length === 0 && <div className="uv-note muted">지난 {hours}시간 동안 기록된 일이 없습니다</div>}
        {cards.length > 0 && (
          <ul className="hl-grid">
            {cards.map((c) => {
              const sid = c.sessionId;
              return <Card key={c.key} c={c} now={at} engine={sid ? engineOf?.(sid) : undefined} onOpen={sid ? () => onOpenSession(sid, c.cwd, c.title) : undefined} />;
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
