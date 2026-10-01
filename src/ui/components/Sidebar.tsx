import { useState } from 'react';
import type { DesktopSession, ProjectEntry, SessionEntry } from '../../shared/session-types';
import { FolderPicker } from './FolderPicker';

/** Sessions shown per project before "더 보기". */
export const FOLD_AT = 5;
const MAX_SESSIONS = 30;

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

export function Sidebar({ projects, currentSessionId, onOpen, onNew, onRefresh, onOpenFolder, fetchFn, pins = [], onTogglePin, desktop = [], autoApprove = null, onAutoApprove, collapsed: collapsedProp, onCollapsedChange }: {
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
  const toggle = (set: Set<string>, key: string) => { const n = new Set(set); if (n.has(key)) n.delete(key); else n.add(key); return n; };

  const q = query.trim().toLowerCase();
  const match = (s: SessionEntry) => !q || s.title.toLowerCase().includes(q);
  const pinSet = new Set(pins);
  const byId = new Map<string, SessionEntry>();
  for (const p of projects) for (const s of p.sessions) byId.set(s.sessionId, s);
  const pinned = pins.map((id) => byId.get(id)).filter((s): s is SessionEntry => !!s && match(s));
  const desktopShown = desktop.filter((d) => !q || d.title.toLowerCase().includes(q) || d.project.toLowerCase().includes(q));

  const row = (s: SessionEntry) => {
    const on = pinSet.has(s.sessionId);
    return (
      <li key={s.sessionId} className={s.sessionId === currentSessionId ? 'active' : ''} title={s.title} onClick={() => onOpen(s.sessionId, s.cwd, s.title)}>
        <span className="session-row">
          <span className="session-title">{s.title}</span>
          <span className="session-meta">{s.account.toUpperCase()} · {ago(s.lastModified)}</span>
          {onTogglePin && (
            <button type="button" className={`pin-btn ${on ? 'on' : ''}`} aria-label={on ? '고정 해제' : '고정'} title={on ? '고정 해제' : '맨 위에 고정'} onClick={(e) => { e.stopPropagation(); onTogglePin(s.sessionId, !on); }}>
              <PinIcon filled={on} />
            </button>
          )}
        </span>
      </li>
    );
  };

  const visible = projects.map((p) => ({ p, sessions: p.sessions.slice(0, MAX_SESSIONS).filter(match) })).filter(({ sessions }) => !q || sessions.length > 0);
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {onOpenFolder && (
          <button type="button" className="text-btn" onClick={() => setPicking((v) => !v)} title="아무 폴더에서 새 세션" aria-expanded={picking}>
            <FolderIcon /><span>폴더 열기</span>
          </button>
        )}
        <span className="grow" />
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
          <ul>{pinned.map(row)}</ul>
        </section>
      )}
      {desktopShown.length > 0 && (
        <section className="project desktop-group" data-testid="desktop-group">
          <div className="project-head"><span className="project-name">최근 Desktop 세션</span></div>
          <ul>
            {desktopShown.map((d) => (
              <li key={d.sessionId} className={d.sessionId === currentSessionId ? 'active' : ''} title={`${d.title}\n${d.cwd}`} onClick={() => onOpen(d.sessionId, d.cwd, d.title)}>
                <span className="session-row">
                  <span className="session-title">{d.title}</span>
                  <span className="session-meta">{d.project} · {ago(d.lastModified)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {projects.length === 0 && <div className="muted sidebar-empty">세션이 없습니다. ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</div>}
      {q && visible.length === 0 && pinned.length === 0 && <div className="muted sidebar-empty">“{query}” 와 맞는 세션이 없습니다.</div>}
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
                <ul>{shown.map(row)}</ul>
                {hidden > 0 && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>더 보기 ({hidden})</button>}
                {!q && expanded.has(p.cwd) && sessions.length > FOLD_AT && <button type="button" className="more-btn" onClick={() => setExpanded((e) => toggle(e, p.cwd))}>접기</button>}
              </>
            )}
          </section>
        );
      })}
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
