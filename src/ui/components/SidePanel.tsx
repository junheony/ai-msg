import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { relPath } from '../diff';
import { has } from '../features';
import { listFiles, readFile, type FilePreview } from '../sessionApi';
import { viewFor, type SideDoc } from '../sidePanel';
import { activeTab, canHighlight, langFor, type SideTab, type SideTabs } from '../sideTabs';
import { CopyButton } from './CopyButton';
import { DiffList } from './DiffView';
import { useFileActions } from './FileMenu';
import { Markdown } from './MessageView';

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
  const count = useMemo(() => text.split('\n').length - (text.endsWith('\n') ? 1 : 0), [text]);
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

/** 파일 button: type (or pick from the @ list) a path of the session folder. */
function FilePick({ cwd, onOpen }: { cwd: string; onOpen: (doc: SideDoc) => void }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    listFiles(cwd).then((r) => { if (live) setFiles(r.files); }, () => {});
    return () => { live = false; };
  }, [cwd]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onOpen({ kind: 'file', path: value.trim() });
  };
  return (
    <form className="side-pick" onSubmit={submit}>
      <label className="muted" htmlFor="side-pick-input">세션 폴더의 파일 경로</label>
      <input id="side-pick-input" list="side-pick-files" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="src/App.tsx" />
      <datalist id="side-pick-files">{files.slice(0, 2000).map((f) => <option key={f} value={f} />)}</datalist>
      <button type="submit" className="btn ghost">열기</button>
    </form>
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
  const [data, setData] = useState<{ key: string; file?: FilePreview; error?: string } | null>(null);
  const filePath = doc.kind === 'file' ? doc.path : null;
  const key = `${cwd}\n${filePath}\n${reload}`;
  useEffect(() => {
    if (filePath === null) return;
    let live = true;
    readFile(cwd, sessionId, filePath).then(
      (file) => { if (live) setData({ key, file }); },
      (err: unknown) => { if (live) setData({ key, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
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
  else if (!current) body = <div className="side-msg muted">불러오는 중…</div>;
  else if (current.error) body = <div className="side-msg error" role="alert">{current.error}</div>;
  else if (current.file?.kind === 'image') body = <div className="side-image"><img src={`data:${current.file.mediaType};base64,${current.file.base64}`} alt={shownPath} /></div>;
  else if (text !== null) {
    if (active === '보기' && view === 'markdown') body = <div className="side-md"><Markdown text={text} /></div>;
    else if (active === '미리보기') body = <HtmlPreview key={reload} html={text} title={shownPath} />;
    else body = <NumberedText text={text} lang={filePath && langFor(filePath)} />;
  }

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
        <div className="side-tabs" role="tablist">
          {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={t === active} className={t === active ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
        </div>
      )}
      <div className="side-body">{body}</div>
      {act.node}
    </>
  );
}
