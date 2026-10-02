import { useState } from 'react';
import type { ProjectEntry } from '../../shared/session-types';

const RECENT_CARDS = 4;

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return '좋은 아침이에요';
  if (hour >= 11 && hour < 17) return '좋은 오후예요';
  if (hour >= 17 && hour < 22) return '좋은 저녁이에요';
  return '늦은 시간까지 수고 많아요';
}

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

/**
 * The empty pane, Desktop-style: greeting, project picker (고정 + 최근), a big start box and the latest sessions
 * as cards. Everything is reachable here, so the phone does not need the drawer to start or resume.
 */
export function NewChat({ projects, defaultCwd, onStart, onOpenSession, now }: {
  projects: ProjectEntry[];
  /** Preselected project (the pane's last one); falls back to the first listed. */
  defaultCwd?: string | null;
  /** Opens a new session in `cwd`; non-empty `text` is sent as its first message. */
  onStart: (cwd: string, name: string, text: string) => void;
  onOpenSession?: (sessionId: string, cwd: string, title: string) => void;
  now?: number;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState('');
  const cwd = picked ?? (defaultCwd && projects.some((p) => p.cwd === defaultCwd) ? defaultCwd : projects[0]?.cwd ?? null);
  const project = projects.find((p) => p.cwd === cwd) ?? null;
  const pinned = projects.filter((p) => p.pinned);
  const others = projects.filter((p) => !p.pinned);
  const recent = projects.flatMap((p) => p.sessions.map((s) => ({ s, name: p.name }))).filter(({ s }) => !s.archived)
    .sort((a, b) => b.s.lastModified - a.s.lastModified)
    .filter((r, i, all) => all.findIndex((x) => x.s.sessionId === r.s.sessionId) === i)
    .slice(0, RECENT_CARDS);
  const t = now ?? Date.now();

  const start = () => { if (project) onStart(project.cwd, project.name, text.trim()); };
  const option = (p: ProjectEntry) => <option key={p.cwd} value={p.cwd}>{p.name}</option>;

  return (
    <div className="newchat">
      <div className="newchat-inner">
        <h1 className="newchat-greeting"><span className="spark" aria-hidden="true">✳</span>{greeting(new Date(t).getHours())}</h1>
        {projects.length === 0 ? (
          <p className="muted">프로젝트가 없습니다. 사이드바의 폴더 열기로 시작하거나 ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</p>
        ) : (
          <form className="newchat-box" onSubmit={(e) => { e.preventDefault(); start(); }}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="무엇을 도와드릴까요?" aria-label="첫 메시지"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(); }
              }} />
            <div className="newchat-row">
              <label className="newchat-project">
                <span className="sr-only">프로젝트</span>
                <select value={cwd ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="프로젝트" title={cwd ?? ''}>
                  {pinned.length > 0 && <optgroup label="고정">{pinned.map(option)}</optgroup>}
                  {others.length > 0 && <optgroup label="최근">{others.map(option)}</optgroup>}
                </select>
              </label>
              <span className="grow" />
              <button type="submit" className="btn primary" disabled={!project}>{text.trim() ? '보내기' : '새 대화'}</button>
            </div>
          </form>
        )}
        {recent.length > 0 && onOpenSession && (
          <section className="newchat-recent" aria-label="최근 대화">
            <h2 className="muted">최근 대화</h2>
            <div className="newchat-cards">
              {recent.map(({ s, name }) => (
                <button type="button" key={s.sessionId} className="newchat-card" title={`${s.title}\n${s.cwd}`} onClick={() => onOpenSession(s.sessionId, s.cwd, s.title)}>
                  <span className="newchat-card-title">{s.title}</span>
                  <span className="newchat-card-meta">{name} · {ago(s.lastModified, t)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
