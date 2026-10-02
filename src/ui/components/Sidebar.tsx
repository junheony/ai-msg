import { useEffect, useState } from 'react';
import type { SessionActivity } from '../../shared/protocol';
import type { DesktopSession, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { searchTranscripts, type SearchHit } from '../sessionApi';
import { FolderPicker } from './FolderPicker';

/** Sessions shown per project before "더 보기". */
export const FOLD_AT = 5;
const MAX_SESSIONS = 30;
/** 대화 내용 검색 starts at this many characters (the server's minimum), after a short pause in typing. */
export const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 300;

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

export function Sidebar({ projects, currentSessionId, onOpen, onNew, onRefresh, onOpenFolder, fetchFn, pins = [], onTogglePin, desktop = [], autoApprove = null, onAutoApprove, collapsed: collapsedProp, onCollapsedChange, onRename, onArchive, onOpenHit, searchFn, activity = [], unread = [] }: {
  projects: ProjectEntry[];
  currentSessionId: string | null;
  onOpen: (sessionId: string, cwd: string, title: string) => void;
  onNew: (cwd: string, name: string) => void;
  onRefresh: () => void;
  /** F1: a folder chosen in 폴더 열기 (real path, server-validated) → new session there. */
  onOpenFolder?: (cwd: string) => void;
  fetchFn?: typeof fetch;
  /** F2: pinned session ids in pin order, shown as 고정됨 above the projects. */
  pins?: string[];
  onTogglePin?: (sessionId: string, pinned: boolean) => void;
  /** Recent Claude Desktop sessions (newest first); opened like any session. */
  desktop?: DesktopSession[];
  /** 자동 승인 (null = not known yet); the footer toggle calls onAutoApprove with the new value. */
  autoApprove?: boolean | null;
  onAutoApprove?: (on: boolean) => void;
  /** ux-state: folded project groups (cwd), owned by the app so they survive a reload; absent = local state. */
  collapsed?: string[];
  onCollapsedChange?: (cwds: string[]) => void;
  /** Custom title (null = back to the transcript's own title); stored by deck, the jsonl is untouched. */
  onRename?: (sessionId: string, title: string | null) => void;
  /** 보관 / 보관 해제: archived sessions only show under the 보관됨 filter. */
  onArchive?: (sessionId: string, archived: boolean) => void;
  /** Enables 대화 내용 검색 (full-text over all transcripts); a clicked hit lands here. */
  onOpenHit?: (hit: SearchHit) => void;
  searchFn?: (q: string) => Promise<{ hits: SearchHit[]; truncated: boolean }>;
  /** Sessions with a running turn or background work (any device): spinner / pulsing dot before the title. */
  activity?: SessionActivity[];
  /** Sessions that finished while not shown: unread dot until opened. */
  unread?: string[];
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set(collapsedProp ?? []));
  const collapsed = collapsedProp ? new Set(collapsedProp) : localCollapsed;
  const setCollapsed = (fn: (c: Set<string>) => Set<string>) => {
    const n = fn(collapsed);
    if (onCollapsedChange) onCollapsedChange([...n]);
    else setLocalCollapsed(n);
  };
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  // Keyed `${group}:${sessionId}`: a pinned session is listed twice and only the clicked copy opens its menu / editor.
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; truncated: boolean; error: string | null } | null>(null);
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n; };

  const q = query.trim().toLowerCase();
  const match = (s: SessionEntry) => !q || s.title.toLowerCase().includes(q);
  const inView = (s: { archived?: boolean }) => (showArchived ? !!s.archived : !s.archived);
  const canEdit = !!(onRename || onArchive);

  // 대화 내용 검색: debounced; a stale answer (query changed meanwhile) is dropped.
  const fullQ = query.trim();
  const fullOn = !!onOpenHit && fullQ.length >= SEARCH_MIN_CHARS;
  useEffect(() => {
    if (!fullOn) { setFound(null); return; }
    let live = true;
    const run = searchFn ?? ((x: string) => searchTranscripts(x, fetchFn));
    const t = setTimeout(() => {
      run(fullQ).then(
        (r) => { if (live) setFound({ q: fullQ, hits: r.hits, truncated: r.truncated, error: null }); },
        (err: unknown) => { if (live) setFound({ q: fullQ, hits: [], truncated: false, error: err instanceof Error ? err.message : '검색 실패' }); },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [fullOn, fullQ, searchFn, fetchFn]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target instanceof Element && e.target.closest('.session-menu'))) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  const startEdit = (s: SessionEntry, key: string) => { if (!onRename) return; setMenu(null); setEditing({ id: key, text: s.title }); };
  const commitEdit = (s: SessionEntry, key: string) => {
    if (!editing || editing.id !== key) return;
    const v = editing.text.replace(/\s+/g, ' ').trim();
    setEditing(null);
    if (v !== s.title) onRename?.(s.sessionId, v || null);
  };
  const pinSet = new Set(pins);
  const byId = new Map<string, SessionEntry>();
  for (const p of projects) for (const s of p.sessions) byId.set(s.sessionId, s);
  const pinned = pins.map((id) => byId.get(id)).filter((s): s is SessionEntry => !!s && inView(s) && match(s));
  const desktopShown = desktop.filter((d) => inView(d)).filter((d) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q));

  const actById = new Map(activity.map((a) => [a.sessionId, a]));
  const unreadSet = new Set(unread);
  const dot = (sessionId: string) => {
    const a = actById.get(sessionId);
    if (a?.running) return <span className="row-dot running" role="img" aria-label="실행 중" title="실행 중" />;
    if (a && a.bg > 0) return <span className="row-dot bg" role="img" aria-label={`백그라운드 작업 ${a.bg}개`} title={`백그라운드 작업 ${a.bg}개`} />;
    if (unreadSet.has(sessionId)) return <span className="row-dot unread" role="img" aria-label="새 응답" title="새 응답" />;
    return null;
  };

  const row = (s: SessionEntry, group: string) => {
    const on = pinSet.has(s.sessionId);
    const key = `${group}:${s.sessionId}`;
    const edit = editing?.id === key ? editing : null;
    return (
      <li key={s.sessionId} className={s.sessionId === currentSessionId ? 'active' : ''} title={s.title}
        // The second click of a double-click (rename) must not re-open the session.
        onClick={(e) => { if (e.detail > 1 || edit) return; onOpen(s.sessionId, s.cwd, s.title); }}
        onContextMenu={canEdit ? (e) => { e.preventDefault(); setMenu(key); } : undefined}>
        <span className="session-row">
          {dot(s.sessionId)}
          {edit ? (
            <input className="session-rename" aria-label="세션 이름" value={edit.text} autoFocus maxLength={200}
              onChange={(e) => setEditing({ id: key, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(s, key); }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
              }}
              onBlur={() => commitEdit(s, key)} onClick={(e) => e.stopPropagation()} />
          ) : (
            <span className="session-title" onDoubleClick={onRename ? (e) => { e.stopPropagation(); startEdit(s, key); } : undefined}>{s.title}</span>
          )}
          <span className="session-meta">{s.account.toUpperCase()} · {ago(s.lastModified)}</span>
          {canEdit && !edit && (
            <button type="button" className="row-more-btn" aria-label="세션 메뉴" title="이름 바꾸기 · 보관" aria-haspopup="menu" aria-expanded={menu === key}
              onClick={(e) => { e.stopPropagation(); setMenu((m) => (m === key ? null : key)); }}>⋯</button>
          )}
          {onTogglePin && (
            <button type="button" className={`pin-btn ${on ? 'on' : ''}`} aria-label={on ? '고정 해제' : '고정'} title={on ? '고정 해제' : '맨 위에 고정'} onClick={(e) => { e.stopPropagation(); onTogglePin(s.sessionId, !on); }}>
              <PinIcon filled={on} />
            </button>
          )}
        </span>
        {menu === key && (
          <div className="session-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            {onRename && <button type="button" role="menuitem" onClick={() => startEdit(s, key)}>이름 바꾸기</button>}
            {onArchive && <button type="button" role="menuitem" onClick={() => { setMenu(null); onArchive(s.sessionId, !s.archived); }}>{s.archived ? '보관 해제' : '보관'}</button>}
          </div>
        )}
      </li>
    );
  };

  const hitsShown = (found && found.q === fullQ ? found.hits : []).filter((h) => { const s = byId.get(h.sessionId); return !s || inView(s); });
  const searching = fullOn && found?.q !== fullQ;
  const visible = projects.map((p) => ({ p, sessions: p.sessions.filter(inView).slice(0, MAX_SESSIONS).filter(match) })).filter(({ sessions }) => (!q && !showArchived) || sessions.length > 0);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {onOpenFolder && (
          <button type="button" className="text-btn" onClick={() => setPicking((v) => !v)} title="아무 폴더에서 새 세션" aria-expanded={picking}>
            <FolderIcon /><span>폴더 열기</span>
          </button>
        )}
        <span className="grow" />
        {onArchive && (
          <button type="button" className={`text-btn archived-filter ${showArchived ? 'on' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)} title={showArchived ? '보관된 세션 보는 중 · 클릭하면 전체' : '보관된 세션만 보기'}>보관됨</button>
        )}
        <button type="button" className="icon-btn" onClick={onRefresh} title="세션 목록 다시 읽기" aria-label="세션 목록 다시 읽기">↻</button>
      </div>
      {picking && onOpenFolder && <FolderPicker onOpen={(cwd) => { setPicking(false); onOpenFolder(cwd); }} onClose={() => setPicking(false)} {...(fetchFn ? { fetchFn } : {})} />}
      <label className="sidebar-search">
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.75" /><path d="m10.5 10.5 3.25 3.25" /></svg>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="세션 검색" aria-label="세션 검색" />
      </label>
      {pinned.length > 0 && (
        <section className="project pinned-group" data-testid="pinned-group">
          <div className="project-head"><span className="project-name">고정됨</span></div>
          <ul>{pinned.map((s) => row(s, 'pinned'))}</ul>
        </section>
      )}
      {desktopShown.length > 0 && (
        <section className="project desktop-group" data-testid="desktop-group">
          <div className="project-head"><span className="project-name">최근 Desktop 세션</span></div>
          <ul>
            {desktopShown.map((d) => (
              <li key={d.sessionId} className={d.sessionId === currentSessionId ? 'active' : ''} title={`${d.title}\n${d.cwd}`} onClick={() => onOpen(d.sessionId, d.cwd, d.title)}>
                <span className="session-row">
                  {dot(d.sessionId)}
                  <span className="session-title">{d.title}</span>
                  <span className="session-meta">{d.project} · {ago(d.lastModified)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {projects.length === 0 && <div className="muted sidebar-empty">세션이 없습니다. ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</div>}
      {showArchived && !q && visible.length === 0 && pinned.length === 0 && desktopShown.length === 0 && <div className="muted sidebar-empty">보관된 세션이 없습니다.</div>}
      {q && visible.length === 0 && pinned.length === 0 && hitsShown.length === 0 && !searching && <div className="muted sidebar-empty">“{query}” 와 맞는 세션이 없습니다.</div>}
      {visible.map(({ p, sessions }) => {
        const isCollapsed = !q && collapsed.has(p.cwd);
        const showAll = !!q || expanded.has(p.cwd);
        const shown = showAll ? sessions : sessions.slice(0, FOLD_AT);
        const hidden = sessions.length - shown.length;
        return (
          <section key={p.cwd} className={`project ${isCollapsed ? 'collapsed' : ''}`}>
            <div className="project-head">
              <button type="button" className="project-toggle" aria-expanded={!isCollapsed} title={p.cwd} onClick={() => setCollapsed((c) => toggle(c, p.cwd))}>
                <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="project-name">{p.pinned ? '★ ' : ''}{p.name}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={`${p.name} 새 세션`} title="+ 새 세션" onClick={() => onNew(p.cwd, p.name)}>+</button>
            </div>
            {!isCollapsed && (
              <>
                <ul>{shown.map((s) => row(s, p.cwd))}</ul>
                {hidden > 0 && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>더 보기 ({hidden})</button>}
                {!q && expanded.has(p.cwd) && sessions.length > FOLD_AT && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>접기</button>}
              </>
            )}
          </section>
        );
      })}
      {fullOn && (searching || hitsShown.length > 0 || found?.error) && (
        <section className="project search-group" data-testid="search-group">
          <div className="project-head"><span className="project-name">대화 내용</span></div>
          {searching && hitsShown.length === 0 && <div className="muted sidebar-empty">검색 중…</div>}
          {found?.error && <div className="error sidebar-empty">{found.error}</div>}
          <ul>
            {hitsShown.map((h, i) => (
              <li key={`${h.sessionId}-${i}`} className="search-hit" title={`${h.title}\n${h.cwd}`} onClick={() => onOpenHit?.(h)}>
                <span className="session-row">
                  <span className="session-title">{h.title}</span>
                  <span className="session-meta">{h.role === 'user' ? '나' : h.engine === 'codex' ? 'GPT' : 'Claude'} · {ago(h.lastModified)}</span>
                </span>
                <span className="search-snippet">
                  {h.snippet.slice(0, h.matchStart)}<mark>{h.snippet.slice(h.matchStart, h.matchStart + h.matchLength)}</mark>{h.snippet.slice(h.matchStart + h.matchLength)}
                </span>
              </li>
            ))}
          </ul>
          {found?.q === fullQ && found.truncated && <div className="muted sidebar-empty">결과 일부만 표시됩니다.</div>}
        </section>
      )}
      {onAutoApprove && autoApprove !== null && (
        <div className="sidebar-foot">
          <button type="button" className={`auto-approve-toggle ${autoApprove ? 'on' : ''}`} role="switch" aria-checked={autoApprove} onClick={() => onAutoApprove(!autoApprove)}
            title={autoApprove ? 'Claude 도구 호출을 묻지 않고 허용합니다(감사 로그에 기록). 새 GPT 세션은 작업폴더 쓰기. 클릭하면 매번 묻기로' : '도구 호출마다 권한 카드로 묻습니다. 클릭하면 자동 승인'}>
            <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
            <span>자동 승인 {autoApprove ? '켜짐' : '꺼짐'}</span>
          </button>
        </div>
      )}
    </aside>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M6 1.75h4l-.5 4.5 2.5 2.5v1H4v-1l2.5-2.5z" />
      <path d="M8 9.75v4.5" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  );
}
