import { useState } from 'react';
import type { ProjectEntry, SessionEntry } from '../../shared/session-types';
import { FolderPicker } from './FolderPicker';

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return '방금';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

export function Sidebar({ projects, currentSessionId, onOpen, onNew, onRefresh, onOpenFolder, fetchFn, pins = [], onTogglePin }: {
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
}) {
  const [picking, setPicking] = useState(false);
  const pinSet = new Set(pins);
  const byId = new Map<string, SessionEntry>();
  for (const p of projects) for (const s of p.sessions) byId.set(s.sessionId, s);
  const pinned = pins.map((id) => byId.get(id)).filter((s): s is SessionEntry => !!s);
  const row = (s: SessionEntry) => {
    const on = pinSet.has(s.sessionId);
    return (
      <li key={s.sessionId} className={s.sessionId === currentSessionId ? 'active' : ''} onClick={() => onOpen(s.sessionId, s.cwd, s.title)}>
        <span className="session-row">
          <span className="session-title">{s.title}</span>
          {onTogglePin && (
            <button type="button" className={`pin-btn ${on ? 'on' : ''}`} aria-label={on ? '고정 해제' : '고정'} title={on ? '고정 해제' : '맨 위에 고정'} onClick={(e) => { e.stopPropagation(); onTogglePin(s.sessionId, !on); }}>📌</button>
          )}
        </span>
        <span className="session-meta">{s.account.toUpperCase()} · {ago(s.lastModified)}</span>
      </li>
    );
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>프로젝트</span>
        <span>
          {onOpenFolder && <button type="button" onClick={() => setPicking((v) => !v)} title="아무 폴더에서 새 세션">폴더 열기</button>}
          <button type="button" onClick={onRefresh} title="세션 목록 다시 읽기">↻</button>
        </span>
      </div>
      {picking && onOpenFolder && <FolderPicker onOpen={(cwd) => { setPicking(false); onOpenFolder(cwd); }} onClose={() => setPicking(false)} {...(fetchFn ? { fetchFn } : {})} />}
      {pinned.length > 0 && (
        <section className="project pinned-group" data-testid="pinned-group">
          <div className="project-head"><span className="project-name">고정됨</span></div>
          <ul>{pinned.map(row)}</ul>
        </section>
      )}
      {projects.length === 0 && <div className="muted">세션이 없습니다. ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</div>}
      {projects.map((p) => (
        <section key={p.cwd} className="project">
          <div className="project-head">
            <span className="project-name">{p.pinned ? '★ ' : ''}{p.name}</span>
            <button type="button" onClick={() => onNew(p.cwd, p.name)}>+ 새 세션</button>
          </div>
          <ul>
            {p.sessions.slice(0, 30).map(row)}
          </ul>
        </section>
      ))}
    </aside>
  );
}
