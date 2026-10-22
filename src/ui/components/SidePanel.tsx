import { memo, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { relPath } from '../diff';
import { has } from '../features';
import { fuzzyFilter } from '../fuzzy';
import { listFiles, readFile, type FilePreview } from '../sessionApi';
import { DocLinkContext, FileRootContext, SidePanelContext, viewFor, type SideDoc } from '../sidePanel';
import { activeTab, canHighlight, langFor, type SideTab, type SideTabs } from '../sideTabs';
import { errorStatus, fileErrorKind, formatSize, lineCount, pickTarget, type FileErrorKind } from '../sideView';
import { CopyButton } from './CopyButton';
import { DiffList } from './DiffView';
import { baseName, useFileActions } from './FileMenu';
import { Lightbox } from './Lightbox';
import { Markdown } from './MessageView';

/** The panel's words (kept here until the i18n dictionaries take them). */
const T = {
  loading: '불러오는 중…',
  pickLabel: '세션 폴더의 파일 경로',
  pickPlaceholder: '파일 이름이나 경로 (예: App.tsx)',
  pickList: '세션 폴더의 파일',
  pickLoading: '파일 목록을 불러오는 중…',
  pickNone: '맞는 파일이 없어요 — Enter 로 입력한 경로를 열어요',
  pickFailed: '파일 목록을 불러오지 못했어요 — 경로를 직접 입력해 열 수 있어요',
  pickEmptyFolder: '이 폴더에는 보여 줄 파일이 없어요',
  pickMore: (shown: number, total: number) => `${total.toLocaleString()}개 중 ${shown}개 — 더 입력해 좁혀 보세요`,
  pickTruncated: '파일이 많아 일부만 찾아요',
  open: '열기',
  retry: '다시 시도',
  download: '다운로드',
  zoom: '크게 보기',
  lines: (n: number) => `${n.toLocaleString()}줄`,
  errors: {
    missing: { title: '파일을 찾을 수 없어요', hint: '옮겨졌거나 지워졌을 수 있어요' },
    denied: { title: '이 파일은 열 수 없어요', hint: '' },
    tooBig: { title: '너무 커서 미리 볼 수 없어요', hint: '다운로드해서 이 기기에서 열어 보세요' },
    binary: { title: '미리 볼 수 없는 형식이에요', hint: '다운로드해서 이 기기에서 열어 보세요' },
    offline: { title: '서버에 연결하지 못했어요', hint: '연결되면 다시 시도해 주세요' },
    other: { title: '파일을 열지 못했어요', hint: '' },
  } satisfies Record<FileErrorKind, { title: string; hint: string }>,
} as const;

/** How long a file may take before the loading lines show. */
const LOADING_DELAY_MS = 180;
/** 파일 열기 shows at most this many matches (typing narrows them). */
const PICK_LIMIT = 60;

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg>
);
const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" /></svg>
);

/** The iframe shell served by the server with its own sandboxing CSP (server/http.ts PREVIEW_FRAME_CSP). */
export const PREVIEW_FRAME_SRC = '/api/preview-frame';

/**
 * HTML/SVG preview. `sandbox="allow-scripts"` WITHOUT allow-same-origin: the page runs in an opaque origin, so it can't
 * touch deck's DOM, cookies, storage or WebSocket; the shell's CSP also blocks all network. The markup is posted in
 * once the shell has loaded (srcdoc would inherit deck's own CSP, which forbids the inline scripts/styles a preview needs).
 */
export function HtmlPreview({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  return (
    <iframe
      ref={ref}
      className="side-frame"
      title={`${title} 미리보기`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={PREVIEW_FRAME_SRC}
      data-testid="html-preview"
      onLoad={() => {
        if (sent.current) return;
        sent.current = true;
        ref.current?.contentWindow?.postMessage(html, '*');
      }}
    />
  );
}

type Lowlight = ReturnType<typeof import('lowlight').createLowlight>;
type HastNode = ReturnType<Lowlight['highlight']>['children'][number];
let lowlight: Lowlight | null = null;
let lowlightLoading: Promise<void> | null = null;
/** highlight.js's common grammars (the chat's code blocks use the same set), loaded with the first highlighted file. */
function loadLowlight(): Promise<void> {
  return (lowlightLoading ??= import('lowlight').then((m) => { lowlight = m.createLowlight(m.common); }, () => { lowlightLoading = null; }));
}

/** lowlight's tree as React: spans with highlight.js's `hljs-*` classes (themed in styles.css), and text. */
function hastNodes(nodes: HastNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.value;
    if (n.type !== 'element') return null;
    const c = n.properties.className;
    return <span key={i} className={Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : undefined}>{hastNodes(n.children)}</span>;
  });
}

/**
 * Text with a line-number gutter (two <pre>s keep 2 MB files cheap to render), coloured by `lang` when highlight.js
 * knows it and the text is small enough (sideTabs.canHighlight); plain until the grammars have loaded.
 */
const NumberedText = memo(function NumberedText({ text, lang = null }: { text: string; lang?: string | null }) {
  const count = useMemo(() => lineCount(text), [text]);
  const gutter = useMemo(() => Array.from({ length: Math.max(1, count) }, (_, i) => i + 1).join('\n'), [count]);
  const want = lang && canHighlight(text) ? lang : null;
  const [ll, setLl] = useState(lowlight);
  useEffect(() => {
    if (!want || ll) return;
    let live = true;
    void loadLowlight().then(() => { if (live) setLl(lowlight); });
    return () => { live = false; };
  }, [want, ll]);
  const lines = useMemo((): ReactNode => {
    if (!want || !ll) return text;
    try { return ll.registered(want) ? hastNodes(ll.highlight(want, text).children) : text; } catch { return text; }
  }, [want, ll, text]);
  return (
    <div className="side-code" data-testid="side-text">
      <pre className="side-gutter" aria-hidden="true">{gutter}</pre>
      <pre className="side-lines">{lines}</pre>
    </div>
  );
});

/**
 * 파일 열기 (quick open): type part of a name or path, pick from the session folder's files (fuzzy, best first) with
 * ↑/↓ + Enter or a tap; a path the list does not have still opens as typed. A combobox over a listbox, so a screen
 * reader hears the highlighted file.
 */
function FilePick({ cwd, onOpen }: { cwd: string; onOpen: (doc: SideDoc) => void }) {
  const [value, setValue] = useState('');
  const [list, setList] = useState<{ files: string[]; truncated: boolean } | 'loading' | 'failed'>('loading');
  const [active, setActive] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    let live = true;
    listFiles(cwd).then((r) => { if (live) setList(r); }, () => { if (live) setList('failed'); });
    return () => { live = false; };
  }, [cwd]);
  const files = typeof list === 'object' ? list.files : [];
  const query = value.trim();
  const matches = useMemo(() => (query ? fuzzyFilter(files, query, (f) => f, PICK_LIMIT) : files.slice(0, PICK_LIMIT)), [files, query]);
  // Typing highlights the best match; an empty box highlights nothing (Enter must not open a file nobody chose).
  useEffect(() => { setActive(query ? 0 : -1); }, [query, files]);
  useEffect(() => {
    if (active >= 0) listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const open = (path: string | null) => { if (path) onOpen({ kind: 'file', path }); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    open(pickTarget(value, matches, files, active));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || !matches.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : matches.length - 1) : (i + step + matches.length) % matches.length));
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;
  const status = list === 'loading' ? T.pickLoading
    : list === 'failed' ? T.pickFailed
    : !files.length ? T.pickEmptyFolder
    : !matches.length ? T.pickNone
    : !query && files.length > matches.length ? T.pickMore(matches.length, files.length)
    : null;
  return (
    <form className="side-pick" onSubmit={submit} role="search">
      <label className="side-pick-label" htmlFor="side-pick-input">{T.pickLabel}</label>
      <div className="side-pick-row">
        <input id="side-pick-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
          placeholder={T.pickPlaceholder} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
          role="combobox" aria-expanded={matches.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active >= 0 && active < matches.length ? optionId(active) : undefined} />
        <button type="submit" className="btn ghost">{T.open}</button>
      </div>
      {status && <div className={`side-pick-status${list === 'failed' ? ' warn' : ''}`} role="status">{status}</div>}
      {matches.length > 0 && (
        <ul className="side-pick-list" id={listId} role="listbox" aria-label={T.pickList} ref={listRef}>
          {matches.map((f, i) => {
            const slash = f.lastIndexOf('/');
            return (
              // A pointer press keeps focus in the box (no blur flicker); the click opens it.
              <li key={f} id={optionId(i)} role="option" aria-selected={i === active} className={i === active ? 'on' : undefined} title={f}
                onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => open(f)}>
                <span className="side-pick-name">{slash >= 0 ? f.slice(slash + 1) : f}</span>
                {slash > 0 && <span className="side-pick-dir">{f.slice(0, slash)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {typeof list === 'object' && list.truncated && <div className="side-pick-status">{T.pickTruncated}</div>}
    </form>
  );
}

/** Why the file did not open, in words, and what can be done: try again, or download what the panel cannot show. */
function FileError({ message, status, onRetry, onDownload }: { message: string; status: number | undefined; onRetry: () => void; onDownload: (() => void) | null }) {
  const kind = fileErrorKind(status);
  const { title, hint } = T.errors[kind];
  const canDownload = onDownload && (kind === 'tooBig' || kind === 'binary');
  return (
    <div className="side-state" role="alert" data-kind={kind}>
      <div className="side-state-title">{title}</div>
      {message && message !== title && <div className="side-state-detail">{message}</div>}
      {hint && <div className="side-state-hint">{hint}</div>}
      <div className="side-state-actions">
        {canDownload && <button type="button" className="btn primary" onClick={onDownload}>{T.download}</button>}
        <button type="button" className="btn ghost" onClick={onRetry}>{T.retry}</button>
      </div>
    </div>
  );
}

/** Before the file arrives: a few quiet lines, shown only if it takes a moment (a fast answer never flashes them). */
function Loading() {
  return (
    <div className="side-loading" role="status" aria-busy="true" data-testid="side-loading">
      <span className="sr-only">{T.loading}</span>
      {[62, 88, 74, 40, 81, 55].map((w, i) => <span key={i} className="skeleton-line" style={{ width: `${w}%` }} aria-hidden="true" />)}
    </div>
  );
}

/** An image of the session folder: fitted; a click (or Enter) opens it full screen. Reports its pixel size. */
function SideImage({ src, alt, onSize }: { src: string; alt: string; onSize: (w: number, h: number) => void }) {
  const [zoom, setZoom] = useState(false);
  return (
    <div className="side-image">
      <button type="button" className="side-image-btn" title={T.zoom} aria-label={`${alt} ${T.zoom}`} onClick={() => setZoom(true)}>
        <img src={src} alt={alt} onLoad={(e) => onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      </button>
      {/* On body: the panel is a size container, which would trap a fixed overlay inside it. */}
      {zoom && createPortal(<Lightbox src={src} alt={alt} onClose={() => setZoom(false)} />, document.body)}
    </div>
  );
}

/**
 * A markdown document's 보기: its relative links and images resolve next to it (DocLinkContext), its images of the
 * session folder show inline (FileRootContext), and a link it opens goes to the pane's panel like any other.
 */
function SideMarkdown({ text, path, cwd }: { text: string; path: string; cwd: string }) {
  const open = useContext(SidePanelContext);
  const md = <div className="side-md"><Markdown text={text} /></div>;
  if (!open) return md;
  return (
    <DocLinkContext.Provider value={path}>
      <FileRootContext.Provider value={cwd}>{md}</FileRootContext.Provider>
    </DocLinkContext.Provider>
  );
}

type Tab = '보기' | '미리보기' | '원문' | '변경 사항';

function tabLabel(doc: SideDoc): { name: string; title: string } {
  if (doc.kind === 'file') return { name: doc.path.replace(/\/+$/, '').split('/').pop() || doc.path, title: doc.path };
  if (doc.kind === 'html') return { name: doc.title, title: doc.title };
  return { name: '파일 열기', title: '파일 열기' };
}

/** The open documents, above the document's own 보기 / 원문 / 변경 사항 tabs: ✕ or a middle click closes one. */
function DocTabs({ tabs, onSelect, onClose }: { tabs: SideTabs; onSelect: (id: string) => void; onClose: (id: string) => void }) {
  const on = activeTab(tabs)?.id;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [on]);
  const middle = (e: ReactMouseEvent, t: SideTab) => {
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(t.id);
  };
  return (
    <div className="side-doc-tabs" role="tablist" aria-label="열린 문서" ref={ref}>
      {tabs.tabs.map((t) => {
        const { name, title } = tabLabel(t.doc);
        return (
          <div key={t.id} className={`side-doc-tab${t.id === on ? ' on' : ''}`} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onAuxClick={(e) => middle(e, t)}>
            <button type="button" role="tab" aria-selected={t.id === on} title={title} className="side-doc-name" onClick={() => onSelect(t.id)}>{name}</button>
            <button type="button" className="side-doc-close" aria-label={`${name} 닫기`} title="탭 닫기" onClick={() => onClose(t.id)}>✕</button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Desktop-style right panel of one pane: the open documents' tabs (when the pane keeps them) over the active one —
 * a file (rendered markdown / image / numbered text, its diff) or a reply's HTML.
 */
export function SidePanel({ doc, docKey, tabs, onSelectTab, onCloseTab, ...rest }: {
  doc: SideDoc;
  /** Changes when the document should start over (another tab, or opened again). */
  docKey?: string;
  tabs?: SideTabs;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onOpen: (doc: SideDoc) => void;
}) {
  return (
    <aside className="side-panel" data-testid="side-panel" aria-label="사이드 패널">
      {tabs && onSelectTab && onCloseTab && <DocTabs tabs={tabs} onSelect={onSelectTab} onClose={onCloseTab} />}
      <DocView key={docKey} doc={doc} {...rest} />
    </aside>
  );
}

function DocView({ doc, cwd, sessionId, onClose, onOpen }: {
  doc: SideDoc;
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onOpen: (doc: SideDoc) => void;
}) {
  const act = useFileActions();
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ key: string; file?: FilePreview; error?: string; status?: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  // A quick answer shows nothing in between; only a slow one gets the loading lines.
  const [slow, setSlow] = useState(false);
  const filePath = doc.kind === 'file' ? doc.path : null;
  const key = `${cwd}\n${filePath}\n${reload}`;
  useEffect(() => {
    if (filePath === null) return;
    let live = true;
    readFile(cwd, sessionId, filePath).then(
      (file) => { if (live) setData({ key, file }); },
      (err: unknown) => { if (live) setData({ key, error: err instanceof Error ? err.message : String(err), status: errorStatus(err) }); },
    );
    setSlow(false);
    setImgSize(null);
    const t = setTimeout(() => { if (live) setSlow(true); }, LOADING_DELAY_MS);
    return () => { live = false; clearTimeout(t); };
  }, [cwd, sessionId, filePath, key]);
  const current = data?.key === key ? data : null;

  const view = filePath ? viewFor(filePath) : 'html';
  const diffs = doc.kind === 'file' ? doc.diffs : undefined;
  const tabs: Tab[] = doc.kind === 'pick' ? [] : doc.kind === 'html' ? ['미리보기', '원문']
    : [...(view === 'markdown' || view === 'image' ? ['보기' as const] : []), ...(view === 'html' ? ['미리보기' as const] : []), ...(view !== 'image' ? ['원문' as const] : []), ...(diffs?.length ? ['변경 사항' as const] : [])];
  const [tab, setTab] = useState<Tab | null>(null);
  // A new document starts on its diff when opened from an edit, else on its first tab.
  const docKey = doc.kind === 'file' ? doc.path : doc.kind === 'html' ? doc.html : '';
  useEffect(() => { setTab(null); }, [docKey]);
  const active: Tab | undefined = tab && tabs.includes(tab) ? tab : diffs?.length ? '변경 사항' : tabs[0];

  const text = doc.kind === 'html' ? doc.html : current?.file?.kind === 'text' ? current.file.text : null;
  const shownPath = doc.kind === 'file' ? relPath(current?.file?.path ?? doc.path, cwd) : doc.kind === 'html' ? doc.title : '파일 열기';
  const fullPath = doc.kind === 'file' ? (current?.file?.path ?? doc.path) : null;

  let body: ReactNode = null;
  if (doc.kind === 'pick') body = <FilePick cwd={cwd} onOpen={onOpen} />;
  else if (active === '변경 사항' && diffs) body = <DiffList diffs={diffs} cwd={cwd} />;
  else if (doc.kind === 'html') body = active === '원문' ? <NumberedText text={doc.html} lang="xml" /> : <HtmlPreview key={reload} html={doc.html} title={doc.title} />;
  else if (!current) body = slow ? <Loading /> : null;
  else if (current.error !== undefined) {
    body = <FileError message={current.error} status={current.status} onRetry={() => setReload((n) => n + 1)}
      onDownload={filePath !== null && has('fileRaw') ? () => act.download(cwd, filePath) : null} />;
  } else if (current.file?.kind === 'image') {
    body = <SideImage src={`data:${current.file.mediaType};base64,${current.file.base64}`} alt={baseName(shownPath)} onSize={(w, h) => setImgSize({ w, h })} />;
  } else if (text !== null) {
    if (active === '보기' && view === 'markdown' && filePath !== null) body = <SideMarkdown text={text} path={filePath} cwd={cwd} />;
    else if (active === '미리보기') body = <HtmlPreview key={reload} html={text} title={shownPath} />;
    else body = <NumberedText text={text} lang={filePath && langFor(filePath)} />;
  }

  // The footer's facts (VS Code's status bar, quietly): lines and size of a text file, pixels and size of an image.
  const file = current?.file;
  const facts = !file || active === '변경 사항' ? []
    : file.kind === 'text' ? [T.lines(lineCount(file.text)), formatSize(file.size)]
    : [...(imgSize ? [`${imgSize.w} × ${imgSize.h}`] : []), formatSize(file.size)];

  return (
    <>
      <div className="side-head">
        <span className="side-path" title={fullPath ?? shownPath}>{shownPath}</span>
        <span className="spacer" />
        {text !== null && <CopyButton text={text} label="내용 복사" compact />}
        {fullPath && <CopyButton text={fullPath} label="경로 복사" caption="경로 복사" compact />}
        {filePath !== null && has('fileRaw') && (
          <>
            <button type="button" className="icon-btn" aria-label="다운로드" title="다운로드 (이 기기에 저장)" onClick={() => act.download(cwd, filePath)}><DownloadIcon /></button>
            <button type="button" className="icon-btn" aria-label="Finder 에서 보기 (서버 Mac)" title="Finder 에서 보기 (서버 Mac)" onClick={() => { void act.reveal(cwd, filePath); }}><FolderIcon /></button>
          </>
        )}
        {doc.kind !== 'pick' && <button type="button" className="icon-btn" aria-label="새로고침" title="새로고침" onClick={() => setReload((n) => n + 1)}>↻</button>}
        <button type="button" className="icon-btn side-close" aria-label="사이드 패널 닫기" title="닫기 (Esc)" onClick={onClose}>✕</button>
      </div>
      {tabs.length > 1 && (
        <div className="side-tabs" role="tablist" aria-label="보기 방식" onKeyDown={(e) => {
          // ←/→ (Home/End) move between 보기 / 원문 / 변경 사항, as a tab strip does.
          const i = tabs.indexOf(active!);
          const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
          if (next < 0) return;
          e.preventDefault();
          setTab(tabs[next]!);
          e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}>
          {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={t === active} tabIndex={t === active ? 0 : -1} className={t === active ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
      )}
      <div className="side-body">{body}</div>
      {facts.length > 0 && <div className="side-foot" data-testid="side-foot">{facts.join(' · ')}</div>}
      {act.node}
    </>
  );
}
