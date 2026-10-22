import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

/** App's 대화 내용 검색 jump fires this on the found message (bubbling): the chat opens 찾기 with the search term. */
export const FIND_EVENT = 'deck-find';

/** Text never searched: message buttons (복사, 다시 생성…), the fold toggle, an already placed mark. */
const SKIP = '.msg-actions, button, .fold-toggle, mark.find-hit, script, style';

/**
 * Wraps every case-insensitive occurrence of `query` in the rendered messages (`.msg`) under `root` in
 * `<mark class="find-hit">`, in document order. React owns these text nodes, so each one is kept in place holding
 * the text before its first hit (the marks and the gaps follow it as new siblings); `clear` removes the added nodes
 * and gives the text back — unless React rewrote the node meanwhile (a streaming reply), whose new text is kept.
 * A hit split across elements (half bold) is not found.
 */
export function markHits(root: ParentNode, query: string): { marks: HTMLElement[]; clear: () => void } {
  const q = query.toLowerCase();
  const marks: HTMLElement[] = [];
  const pieces: { node: Text; full: string; prefix: string; added: Node[] }[] = [];
  if (!q) return { marks, clear: () => {} };
  const doc = (root as Node).ownerDocument ?? document;
  for (const msg of root.querySelectorAll('.msg')) {
    const walker = doc.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const parent = t.parentElement;
      if (!parent || !t.data || parent.closest(SKIP)) continue;
      // Inside a closed disclosure (thinking, tool details): not on screen, so not a place to jump to.
      const d = parent.closest('details');
      if (d && !d.open && !parent.closest('summary')) continue;
      // A closed meta-line panel (hidden until its › is pressed): same.
      if (parent.closest('[hidden]')) continue;
      texts.push(t);
    }
    for (const node of texts) {
      const full = node.data;
      const lower = full.toLowerCase();
      const at: number[] = [];
      for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) at.push(i);
      if (at.length === 0) continue;
      const added: Node[] = [];
      at.forEach((start, k) => {
        const mark = doc.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = full.slice(start, start + q.length);
        added.push(mark);
        marks.push(mark);
        const gap = full.slice(start + q.length, at[k + 1] ?? full.length);
        if (gap) added.push(doc.createTextNode(gap));
      });
      const prefix = full.slice(0, at[0]);
      const next = node.nextSibling;
      for (const a of added) node.parentNode!.insertBefore(a, next);
      node.data = prefix;
      pieces.push({ node, full, prefix, added });
    }
  }
  const clear = () => {
    for (const p of pieces) {
      for (const a of p.added) a.parentNode?.removeChild(a);
      if (p.node.data === p.prefix) p.node.data = p.full;
    }
    pieces.length = 0;
  };
  return { marks, clear };
}

/**
 * 대화에서 찾기: every hit in the transcript is marked while the bar is open, the current one is `.find-hit.current`
 * and scrolled to. Enter / ↓ = next, Shift+Enter / ↑ = previous (wrapping), Esc closes (unmounting removes the marks).
 * `content` changing (new items, a streaming delta) re-marks without moving the view. `anchor`: the message a search
 * jump landed on — its first hit becomes the current one.
 */
export function FindBar({ root, content, initialQuery = '', anchor = null, onClose }: { root: RefObject<HTMLElement | null>; content: unknown; initialQuery?: string; anchor?: Element | null; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [marks, setMarks] = useState<HTMLElement[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The next marks pass should pick (the anchor's hit) and scroll: set by typing and stepping, not by content refreshes. */
  const jump = useRef(true);
  const pendingAnchor = useRef(anchor);
  // Not after a search jump (a phone would raise its keyboard over the hit); ⌘F / the menu type right away.
  useEffect(() => { if (!anchor) { inputRef.current?.focus(); inputRef.current?.select(); } }, []);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !query) { setMarks([]); return; }
    const r = markHits(el, query);
    setMarks(r.marks);
    const a = pendingAnchor.current;
    if (a && r.marks.length) {
      pendingAnchor.current = null;
      const inside = r.marks.findIndex((m) => a.contains(m));
      if (inside >= 0) setIndex(inside);
      else {
        // The search landed on this message but the term is split there (markdown): stay where it scrolled.
        const after = r.marks.findIndex((m) => !!(a.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING));
        setIndex(after >= 0 ? after : 0);
        jump.current = false;
      }
    }
    return r.clear;
  }, [root, query, content]);

  const current = marks.length ? Math.min(index, marks.length - 1) : -1;
  useEffect(() => {
    const m = current >= 0 ? marks[current] : undefined;
    if (!m) return;
    m.classList.add('current');
    if (jump.current) {
      jump.current = false;
      // A folded long message opens first (the same .search-flash as a search jump), then the hit is centred again.
      const folded = m.closest('pre.folded');
      const msg = folded?.closest('.msg');
      if (msg) {
        msg.classList.add('search-flash');
        setTimeout(() => msg.classList.remove('search-flash'), 2000);
        requestAnimationFrame(() => requestAnimationFrame(() => m.scrollIntoView?.({ block: 'center' })));
      }
      m.scrollIntoView?.({ block: 'center' });
    }
    return () => m.classList.remove('current');
  }, [marks, current]);

  const step = (d: 1 | -1) => {
    if (!marks.length) return;
    jump.current = true;
    setIndex((current + d + marks.length) % marks.length);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <input ref={inputRef} className="find-input" type="search" aria-label="대화에서 찾기" placeholder="대화에서 찾기" value={query}
        autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" enterKeyHint="search"
        onChange={(e) => { jump.current = true; setIndex(0); setQuery(e.target.value); }} onKeyDown={onKeyDown} />
      <span className="find-count" aria-live="polite" data-testid="find-count">{query ? `${current + 1} / ${marks.length}` : ''}</span>
      <button type="button" className="icon-btn find-step" aria-label="이전 찾기 결과" title="이전 (Shift+Enter)" disabled={!marks.length} onClick={() => step(-1)}><span aria-hidden="true">↑</span></button>
      <button type="button" className="icon-btn find-step" aria-label="다음 찾기 결과" title="다음 (Enter)" disabled={!marks.length} onClick={() => step(1)}><span aria-hidden="true">↓</span></button>
      <button type="button" className="icon-btn find-close" aria-label="찾기 닫기" title="닫기 (Esc)" onClick={onClose}>×</button>
    </div>
  );
}
