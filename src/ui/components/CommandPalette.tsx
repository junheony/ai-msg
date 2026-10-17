import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fuzzyFilter } from '../fuzzy';
import type { SearchHit } from '../sessionApi';
import type { EngineKind } from '../../shared/models';
import { EngineMark } from './EngineMark';
import { isMacPlatform } from '../shortcuts';

export type PaletteSession = { sessionId: string; title: string; cwd: string; project: string; lastModified: number; engine?: EngineKind };
export type PaletteAction = { id: string; label: string; hint?: string; run: () => void };

const RECENT_EMPTY = 8;
const MAX_SESSIONS = 30;
const MAX_HITS = 6;
const HIT_MIN_CHARS = 2;
const HIT_DEBOUNCE_MS = 300;

type Item =
  | { kind: 'action'; key: string; a: PaletteAction }
  | { kind: 'session'; key: string; s: PaletteSession }
  | { kind: 'hit'; key: string; h: SearchHit };

/**
 * ⌘K: actions and sessions (fuzzy over title + project), plus 대화 내용 hits from the transcript search.
 * ↑/↓ move, Enter runs, Esc closes; keys pressed while an IME is composing are left to the IME. On a session, ⌘Enter
 * (Ctrl elsewhere) opens it in a new split pane and ⇧Enter as a floating card, when those are given (a click likewise).
 */
export function CommandPalette({ sessions, actions, onOpenSession, onOpenSessionSplit, onOpenSessionFloat, onOpenHit, searchFn, onClose }: {
  /** Newest first. */
  sessions: PaletteSession[];
  actions: PaletteAction[];
  onOpenSession: (s: PaletteSession) => void;
  /** ⌘Enter / ⌘-click on a session: in a new split pane. */
  onOpenSessionSplit?: (s: PaletteSession) => void;
  /** ⇧Enter / ⇧-click on a session: as a floating card. */
  onOpenSessionFloat?: (s: PaletteSession) => void;
  onOpenHit?: (h: SearchHit) => void;
  searchFn?: (q: string) => Promise<{ hits: SearchHit[] }>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim();

  useEffect(() => {
    if (!searchFn || !onOpenHit || q.length < HIT_MIN_CHARS) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      searchFn(q).then((r) => { if (live) setHits({ q, hits: r.hits.slice(0, MAX_HITS) }); }, () => { if (live) setHits({ q, hits: [] }); });
    }, HIT_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [q, searchFn, onOpenHit]);

  const items = useMemo<Item[]>(() => {
    const acts = fuzzyFilter(actions, q, (a) => `${a.label} ${a.hint ?? ''}`).map((a): Item => ({ kind: 'action', key: `a:${a.id}`, a }));
    const ss = (q ? fuzzyFilter(sessions, q, (s) => `${s.title} ${s.project}`, MAX_SESSIONS) : sessions.slice(0, RECENT_EMPTY)).map((s): Item => ({ kind: 'session', key: `s:${s.sessionId}`, s }));
    const hs = (hits && hits.q === q ? hits.hits : []).map((h, i): Item => ({ kind: 'hit', key: `h:${h.sessionId}:${i}`, h }));
    // Empty query: recent sessions first (the common jump), then the actions.
    return q ? [...acts, ...ss, ...hs] : [...ss, ...acts];
  }, [actions, sessions, q, hits]);

  useEffect(() => { setSel(0); }, [q]);
  const cur = Math.min(sel, Math.max(items.length - 1, 0));
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [cur]);

  const mac = isMacPlatform();
  const run = (it: Item | undefined, how: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } | null = null) => {
    if (!it) return;
    onClose();
    const split = !!how && (mac ? how.metaKey && !how.ctrlKey : how.ctrlKey && !how.metaKey) && !how.shiftKey && !how.altKey;
    const float = !!how && how.shiftKey && !how.metaKey && !how.ctrlKey && !how.altKey;
    if (it.kind === 'action') it.a.run();
    else if (it.kind === 'session') (split && onOpenSessionSplit ? onOpenSessionSplit : float && onOpenSessionFloat ? onOpenSessionFloat : onOpenSession)(it.s);
    else onOpenHit?.(it.h);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(items.length ? (cur + 1) % items.length : 0); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(items.length ? (cur - 1 + items.length) % items.length : 0); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(items[cur], e); }
  };

  let lastKind: Item['kind'] | null = null;
  const heading = (k: Item['kind']) => (k === 'action' ? '명령' : k === 'session' ? (q ? '세션' : '최근 세션') : '대화 내용');
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="명령 팔레트">
        <input className="palette-input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          placeholder="세션 검색 또는 명령…" aria-label="세션 검색 또는 명령" role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-activedescendant={items[cur] ? `palette-${cur}` : undefined} />
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <li className="palette-empty muted">{q && searchFn && onOpenHit && q.length >= HIT_MIN_CHARS && hits?.q !== q ? '찾는 중…' : '맞는 항목이 없습니다'}</li>}
          {items.map((it, i) => {
            const head = it.kind !== lastKind ? <li className="palette-head" role="presentation" key={`head-${it.kind}`}>{heading(it.kind)}</li> : null;
            lastKind = it.kind;
            return [
              head,
              <li key={it.key} id={`palette-${i}`} role="option" aria-selected={i === cur} className={`palette-item ${i === cur ? 'on' : ''}`}
                onMouseMove={() => { if (i !== cur) setSel(i); }} onClick={(e) => run(it, e)}>
                {it.kind === 'action' && <><span className="palette-title">{it.a.label}</span>{it.a.hint && <kbd className="palette-hint">{it.a.hint}</kbd>}</>}
                {it.kind === 'session' && <><span className="palette-title"><EngineMark engine={it.s.engine ?? 'claude'} decorative />{it.s.title}</span><span className="palette-meta">{it.s.project}</span></>}
                {it.kind === 'hit' && (
                  <>
                    <span className="palette-title"><EngineMark engine={it.h.engine} decorative />{it.h.title}</span>
                    <span className="palette-snippet">{it.h.snippet.slice(0, it.h.matchStart)}<mark>{it.h.snippet.slice(it.h.matchStart, it.h.matchStart + it.h.matchLength)}</mark>{it.h.snippet.slice(it.h.matchStart + it.h.matchLength)}</span>
                  </>
                )}
              </li>,
            ];
          })}
        </ul>
        <div className="palette-foot muted">↑↓ 이동 · Enter 열기{onOpenSessionSplit ? ` · ${mac ? '⌘' : 'Ctrl+'}Enter 새 분할` : ''}{onOpenSessionFloat ? ' · ⇧Enter 카드로' : ''} · Esc 닫기</div>
      </div>
    </div>
  );
}
