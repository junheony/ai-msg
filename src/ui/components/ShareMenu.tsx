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

/** Session header 공유 menu (Desktop's top-right share): copy / export the conversation as markdown, copy its deck link, system share sheet on phones. */
export function ShareMenu({ title, items, cwd, sessionId, assistant }: { title: string; items: ChatItem[]; cwd?: string; sessionId?: string | null; assistant?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPlacement(open, btnRef, popRef, 220);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(null), 1500);
    return () => clearTimeout(id);
  }, [done]);

  const markdown = () => conversationMarkdown({ title, items, ...(cwd ? { cwd } : {}), date: new Date(), ...(assistant ? { assistant } : {}) });
  const finish = (msg: string) => { setDone(msg); setOpen(false); };
  const copyAll = () => void copyText(markdown()).then((ok) => finish(ok ? '대화를 복사했습니다' : '복사 실패'));
  const exportMd = () => { download(exportFileName(title, new Date()), markdown()); finish('내보냈습니다'); };
  const copyLink = () => { if (sessionId) void copyText(sessionLink(sessionId)).then((ok) => finish(ok ? '링크를 복사했습니다' : '복사 실패')); };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = () => {
    setOpen(false);
    const data: ShareData = sessionId ? { title, url: sessionLink(sessionId) } : { title, text: markdown() };
    navigator.share(data).catch(() => { /* dismissed */ });
  };
  const empty = items.length === 0;

  return (
    <div className="share" ref={ref}>
      <button ref={btnRef} type="button" className="icon-btn share-btn" aria-label="공유" title={done ?? '공유'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><ShareIcon /></button>
      {done && <span className="share-toast" role="status">{done}</span>}
      {open && (
        <div ref={popRef} className="share-pop" role="menu" style={pos}>
          {canShare && <button type="button" role="menuitem" className="share-item" onClick={share}>공유…</button>}
          <button type="button" role="menuitem" className="share-item" disabled={empty} onClick={copyAll}>대화 복사 (마크다운)</button>
          <button type="button" role="menuitem" className="share-item" disabled={empty} onClick={exportMd}>마크다운으로 내보내기</button>
          {sessionId && <button type="button" role="menuitem" className="share-item" onClick={copyLink}>링크 복사</button>}
        </div>
      )}
    </div>
  );
}
