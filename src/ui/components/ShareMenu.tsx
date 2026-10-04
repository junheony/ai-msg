import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import { conversationMarkdown, exportFileName } from '../exportMarkdown';
import type { ChatItem } from '../state';
import { usePopoverPlacement } from './usePopoverPlacement';
import { ShareIcon } from './icons';

/** The deck link that opens this session (App reads ?session= on load). */
export function sessionLink(sessionId: string, origin = window.location.origin): string {
  return `${origin}/?session=${encodeURIComponent(sessionId)}`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ShareOpts = { title: string; items: ChatItem[]; cwd?: string; sessionId?: string | null; assistant?: string };
export type ShareAction = { key: string; label: string; disabled?: boolean; run: () => void };

/**
 * The 공유 actions (system share sheet, copy / export as markdown, copy the deck link) and their brief result
 * message. Shared by the standalone 공유 button and the chat header's ⋯ menu; `after` runs once an action fires
 * (the caller closes its menu).
 */
export function useShareActions({ title, items, cwd, sessionId, assistant }: ShareOpts, after: () => void = () => {}): { actions: ShareAction[]; done: string | null } {
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(null), 1500);
    return () => clearTimeout(id);
  }, [done]);
  const markdown = () => conversationMarkdown({ title, items, ...(cwd ? { cwd } : {}), date: new Date(), ...(assistant ? { assistant } : {}) });
  const finish = (msg: string) => { setDone(msg); after(); };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const empty = items.length === 0;
  const actions: ShareAction[] = [];
  if (canShare) actions.push({ key: 'share', label: '공유…', run: () => {
    after();
    const data: ShareData = sessionId ? { title, url: sessionLink(sessionId) } : { title, text: markdown() };
    navigator.share(data).catch(() => { /* dismissed */ });
  } });
  actions.push({ key: 'copy', label: '대화 복사 (마크다운)', disabled: empty, run: () => void copyText(markdown()).then((ok) => finish(ok ? '대화를 복사했습니다' : '복사 실패')) });
  actions.push({ key: 'export', label: '마크다운으로 내보내기', disabled: empty, run: () => { download(exportFileName(title, new Date()), markdown()); finish('내보냈습니다'); } });
  if (sessionId) actions.push({ key: 'link', label: '링크 복사', run: () => void copyText(sessionLink(sessionId)).then((ok) => finish(ok ? '링크를 복사했습니다' : '복사 실패')) });
  return { actions, done };
}

/** Standalone 공유 menu (Desktop's top-right share): copy / export the conversation as markdown, copy its deck link, system share sheet on phones. */
export function ShareMenu(opts: ShareOpts) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPlacement(open, btnRef, popRef, 220);
  const { actions, done } = useShareActions(opts, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="share" ref={ref}>
      <button ref={btnRef} type="button" className="icon-btn share-btn" aria-label="공유" title={done ?? '공유'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><ShareIcon /></button>
      {done && <span className="share-toast" role="status">{done}</span>}
      {open && (
        <div ref={popRef} className="share-pop" role="menu" style={pos}>
          {actions.map((a) => <button key={a.key} type="button" role="menuitem" className="share-item" disabled={a.disabled} onClick={a.run}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}
