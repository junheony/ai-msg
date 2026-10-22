import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { splitDeckChoices, type DeckChoices } from '../../shared/choices';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HANDOFF_PROMPT } from '../../shared/handoff';
import { parseUserText, type InjectedNotice } from '../injected';
import { roleSummary } from '../roles';
import { usePrefs } from '../usePrefs';
import { conciseLiveSplit } from '../../shared/concise';
import { codeFileName, useCodeWrap } from '../codeWrap';
import { FileRootContext, SidePanelContext, filePathIn, inSessionFolder, viewFor } from '../sidePanel';
import { has } from '../features';
import { rawFileUrl } from '../sessionApi';
import { Sheet, SheetHead } from './Dialogs';
import { baseName, useFileActions, useFileMenu, useLongPress } from './FileMenu';
import type { ChatItem, SentFile } from '../state';
import { MODEL_INFO, modelLabelOf, type ModelChoice } from '../../shared/models';
import type { ReplyTurn } from '../replyTurn';
import { usePopoverPlacement } from './usePopoverPlacement';
import { CopyButton } from './CopyButton';
import { CopyIcon, EditIcon, RetryIcon } from './icons';
import { Lightbox, attachmentUrl } from './Lightbox';
import { RoleBadge } from './RoleBadge';
import { ToolCalls } from './ToolCallView';
import { TurnBadge, isAbortError, isFailedTurn, isStoppedTurn } from './TurnBadge';

/** Plain text of a rendered markdown subtree (code blocks arrive as nested elements). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

let savedCodeBlocks = 0;
/** 저장: the block's text as a download, `code-N.<ext>` (N counts saves on this page). */
function saveCode(text: string, lang: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = codeFileName(lang, ++savedCodeBlocks);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Fenced code: a header strip with the language, 줄바꿈 · 저장 · copy buttons above the scrolling body. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Array.isArray(children) ? children[0] : children;
  const cls = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : '';
  const lang = /language-([\w+#.-]+)/.exec(cls)?.[1] ?? '';
  const text = textOf(children).replace(/\n$/, '');
  const open = useContext(SidePanelContext);
  const previewable = open && (lang === 'html' || lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/i.test(text)));
  const [wrap, setWrap] = useCodeWrap();
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <span className="code-actions">
          {previewable && <button type="button" className="code-copy" onClick={() => open({ kind: 'html', title: `${lang.toUpperCase()} 미리보기`, html: text })}>미리보기</button>}
          <button type="button" className="code-tool code-wrap-toggle" aria-pressed={wrap} title="긴 줄 접기 (모든 코드 블록)" onClick={() => setWrap(!wrap)}>줄바꿈</button>
          <button type="button" className="code-tool code-save" title="파일로 저장" onClick={() => saveCode(text, lang)}>저장</button>
          <CopyButton text={text} label="코드 복사" />
        </span>
      </div>
      <pre className={wrap ? 'code-wrap' : undefined}>{children}</pre>
    </div>
  );
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * A file path in a reply: a button opening it in the side panel when the pane has one, else `fallback`. Right-click /
 * long press opens the file menu. In an assistant reply (FileRootContext set) an image of the session folder shows as
 * a thumbnail instead, back to the chip if it fails to load (403/404, an older server).
 */
function FileLink({ path, fallback, children }: { path: string | null; fallback: ReactNode; children: ReactNode }) {
  const open = useContext(SidePanelContext);
  const root = useContext(FileRootContext);
  const [broken, setBroken] = useState(false);
  const menu = useFileMenu(path);
  if (!path || !open) return <>{fallback}</>;
  // Thumbnails need the server's raw route ('fileRaw'); an older server gets the plain chip (the panel preview still works).
  if (root !== null && !broken && has('fileRaw') && viewFor(path) === 'image' && inSessionFolder(path, root)) {
    const name = baseName(path);
    return (
      <>
        <button type="button" className="file-thumb" title={`${path} — 사이드 패널에서 크게 보기`} onClick={() => open({ kind: 'file', path })} {...menu.bind}>
          <img src={rawFileUrl(root, path)} alt={name} loading="lazy" onError={() => setBroken(true)} />
          <span className="file-thumb-cap">{name}</span>
        </button>
        {menu.node}
      </>
    );
  }
  return (
    <>
      <button type="button" className="file-link" title={`${path} — 사이드 패널에서 열기`} onClick={() => open({ kind: 'file', path })} {...menu.bind}>{children}</button>
      {menu.node}
    </>
  );
}

/**
 * Review I8: model output must not make the browser fetch attacker URLs, so a markdown image becomes a plain link the
 * user can choose to open. Only a path inside the session folder (fetched through deck's own /api/file) is a thumbnail.
 */
function MdImage({ src, alt }: { src?: unknown; alt?: string }) {
  const root = useContext(FileRootContext);
  const s = typeof src === 'string' ? src : undefined;
  const link = <a href={s} title={s} rel="noreferrer noopener" target="_blank">🖼 {alt || s || '이미지'}</a>;
  const path = s && root !== null && !/^[a-z][\w+.-]*:/i.test(s) && !s.startsWith('//') ? filePathIn(decodeSafe(s)) : null;
  if (!path || viewFor(path) !== 'image' || !inSessionFolder(path, root!)) return link;
  return <FileLink path={path} fallback={link}>🖼 {alt || path}</FileLink>;
}

/** `a/b/c` → a/<wbr>b/<wbr>c. */
function breakAfterSlash(text: string): ReactNode[] {
  return text.split('/').flatMap((part, i, all) => (i < all.length - 1 ? [part, '/', <wbr key={i} />] : [part]));
}

const MD_COMPONENTS: Components = {
  img: ({ src, alt }) => <MdImage src={src} alt={alt} />,
  a: ({ href, children }) => <FileLink path={href && !/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('#') ? filePathIn(decodeSafe(href)) : null} fallback={<a href={href} title={href} rel="noreferrer noopener" target="_blank">{children}</a>}>{children}</FileLink>,
  // Inline code naming a file opens it in the pane's side panel (fenced code ends with a newline, so it never matches).
  code: ({ className, children }) => {
    const text = typeof children === 'string' ? children : null;
    // A long inline path wraps after a `/` (a <wbr>) before it would break mid-name; copying the text is unchanged.
    const shown = text && !className && text.includes('/') && !text.includes('\n') ? breakAfterSlash(text) : children;
    const plain = <code className={className}>{shown}</code>;
    return <FileLink path={text && !className ? filePathIn(text) : null} fallback={plain}><code>{shown}</code></FileLink>;
  },
  // GFM tables scroll sideways inside the message instead of widening the chat (phone).
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};
const MD_PLUGINS = [remarkGfm];

type Enhance = typeof import('../mdEnhance');
let enhance: Enhance | null = null;
let enhancing: Promise<void> | null = null;
/** Highlighting + math are a separate chunk, fetched the first time a message has a code fence or a `$`. */
function loadEnhance(): Promise<void> {
  return (enhancing ??= import('../mdEnhance').then((m) => { enhance = m; }, () => { enhancing = null; }));
}
const NEEDS_ENHANCE = /```|~~~|\$\$/;

/** Memoized on its text: parsing is the expensive part, and a streaming turn re-creates its item on every delta. */
export const Markdown = memo(function Markdown({ text, className = 'markdown' }: { text: string; className?: string }) {
  const wants = NEEDS_ENHANCE.test(text);
  const [, ready] = useState(enhance !== null);
  useEffect(() => {
    if (wants && !enhance) void loadEnhance().then(() => ready(enhance !== null));
  }, [wants, ready]);
  const on = wants && enhance !== null;
  return (
    <div className={className}>
      <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={on ? [...MD_PLUGINS, ...enhance!.REMARK_ENHANCE] : MD_PLUGINS} rehypePlugins={on ? enhance!.REHYPE_ENHANCE : undefined}>{text}</ReactMarkdown>
    </div>
  );
});

/** Claude's thinking as a collapsed disclosure above the reply (Desktop: "N초 동안 생각함"). Concise: label only while streaming. */
function Thinking({ t, streaming, concise = false }: { t: NonNullable<Extract<ChatItem, { kind: 'assistant' }>['thinking']>; streaming: boolean; concise?: boolean }) {
  const secs = t.ms === null ? null : Math.max(1, Math.round(t.ms / 1000));
  const label = t.ms === null && streaming ? '생각하는 중…' : secs === null ? '생각 과정' : `${secs}초 동안 생각함`;
  const body = t.text.trim();
  if (concise && streaming) return <div className="thinking-line concise" data-testid="thinking">{label}</div>;
  if (!body && !t.redacted) return <div className="thinking-line" data-testid="thinking">{label}</div>;
  return (
    <details className="thinking" data-testid="thinking">
      <summary>{label}</summary>
      {body ? <Markdown text={body} className="markdown thinking-body" /> : <div className="thinking-body muted">(암호화된 생각)</div>}
    </details>
  );
}

const NOTICE_ICON: Record<InjectedNotice['kind'], string> = { task: '⚙', command: '›_', output: '›_', hook: '↪' };

/** A harness-injected block (task notification, slash command…) as one muted, expandable line. */
function SystemNotice({ n }: { n: InjectedNotice }) {
  return (
    <details className={`sys-notice ${n.kind} ${n.status}`} data-testid="sys-notice">
      <summary>
        <span className="sys-icon" aria-hidden="true">{NOTICE_ICON[n.kind]}</span>
        <span className="sys-label">{n.label}</span>
        {n.summary && <><span className="sys-sep" aria-hidden="true">·</span><span className="sys-summary">{n.summary}</span></>}
        <span className="tool-caret" aria-hidden="true">›</span>
      </summary>
      <div className="sys-detail">
        {n.body && (n.kind === 'task' ? <Markdown text={n.body} /> : <pre className="sys-body">{n.body}</pre>)}
        <details className="sys-raw">
          <summary>원문 보기</summary>
          <pre>{n.raw}</pre>
        </details>
      </div>
    </details>
  );
}

const SYSTEM_ICON: Record<string, string> = { peer: '✉', scheduled: '⏰', goal: '◎', task: '✓', auto: '·' };

/** A message the harness injected as a user line (hook feedback, another session's message, a task notification…): one muted row, its text collapsed. */
function SystemRow({ item }: { item: Extract<ChatItem, { kind: 'system' }> }) {
  // "Stop hook feedback:\n…": the header line is the label already; the feedback itself is the body.
  const body = item.text.replace(/^[^\n]*?hook (?:feedback|blocking error)[^:\n]*:\s*/, '').trim() || item.text;
  return (
    <div className="msg system" data-testid="system-row" data-source={item.source}>
      <details className="sys-notice injected">
        <summary>
          <span className="sys-icon" aria-hidden="true">{SYSTEM_ICON[item.source] ?? '↻'}</span>
          <span className="sys-label">{item.label}</span>
          <span className="tool-caret" aria-hidden="true">›</span>
        </summary>
        <div className="sys-detail"><pre className="sys-body">{body}</pre></div>
      </details>
    </div>
  );
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1]!.toUpperCase() : '';
}
const IMAGE_EXT = /^(PNG|JPE?G|GIF|WEBP|HEIC|BMP|SVG|AVIF)$/;

/** One sent image: a thumbnail from the server (falls back to a tile once the upload is purged); click = lightbox. */
function ImageThumb({ file }: { file: SentFile }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  if (broken) return <FileTile name={file.name} image />;
  return (
    <>
      <button type="button" className="attach-thumb" title={file.name} aria-label={`${file.name} 크게 보기`} onClick={() => setOpen(true)}>
        <img src={attachmentUrl(file.id)} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
      </button>
      {open && <Lightbox src={attachmentUrl(file.id)} alt={file.name} onClose={() => setOpen(false)} />}
    </>
  );
}

function FileTile({ name, image }: { name: string; image: boolean }) {
  const ext = extOf(name);
  return (
    <span className={`chip attach-tile ${image ? 'image' : 'file'}`} title={name}>
      <span className="attach-glyph" aria-hidden="true">{image ? '🖼' : ext || '📄'}</span>
      <span className="attach-name">{name}</span>
    </span>
  );
}

/** Sent attachments: images as thumbnails (GET /api/attachments/:id), other files as small tiles. */
function AttachmentTiles({ files }: { files: SentFile[] }) {
  return (
    <div className="msg-attachments">
      {files.map((f, i) => (f.isImage ? <ImageThumb key={f.id || i} file={f} /> : <FileTile key={f.id || i} name={f.name} image={IMAGE_EXT.test(extOf(f.name))} />))}
    </div>
  );
}

/**
 * Message actions supplied by the chat (a context so MessageView's memo still holds across composer keystrokes).
 * onEdit: put a sent message back in the composer; onRetry: re-send the last prompt (only given while idle).
 */
export type MessageActions = {
  onEdit?: (text: string) => void;
  onRetry?: () => void;
  /** 메시지 편집 갈래: send `text` in place of user message `n` (shown as `original`); absent = 편집 uses onEdit. */
  onBranch?: (n: number, text: string, original: string) => void;
  /** Why 편집 uses onEdit (tooltip). */
  editNote?: string | null;
  /** `< i/N >` under a user message with several versions. */
  versions?: (n: number) => Versions | null;
  /** Touch screen: Enter adds a newline (send with the button), like the composer. */
  coarse?: boolean;
  /** deck-choices option card clicked: send its text as the user's reply. Absent = cannot send now (busy, read-only). */
  onReply?: (text: string) => void;
};
export const MessageActionsContext = createContext<MessageActions>({});
type Versions = { index: number; count: number; go: (i: number) => void };

/**
 * 메시지 편집 갈래: the bubble as an editor. Enter sends (or ⌘Enter only, per 설정 › Enter 동작), Shift+Enter is a
 * newline, Esc cancels; IME-safe like the composer. Shift+Tab (권한 모드) stays a composer-only key.
 */
function InlineEdit({ initial, coarse, onCancel, onSubmit }: { initial: string; coarse: boolean; onCancel: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const [{ sendKey }] = usePrefs();
  const composing = useRef(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const can = text.trim().length > 0;
  const submit = () => { if (can) onSubmit(text.trim()); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same rule as the composer: a key that is part of a composition (keyCode 229: Safari's committing Enter) is not ours.
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    if (e.shiftKey || e.altKey || coarse || sendKey === 'mod-enter') return;
    e.preventDefault();
    submit();
  };
  return (
    <div className="msg user editing" data-testid="inline-edit">
      <textarea
        ref={ta}
        className="inline-edit"
        aria-label="메시지 편집"
        autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off"
        value={text}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      />
      <div className="inline-edit-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>취소</button>
        <button type="button" className="btn primary" disabled={!can} onClick={submit}>보내기</button>
      </div>
    </div>
  );
}

/** `< 2/3 >`: switches the pane to another version of this message (a sibling branch session). */
function VersionSwitcher({ v }: { v: Versions }) {
  return (
    <div className="msg-versions" data-testid="msg-versions">
      <button type="button" className="msg-act" aria-label="이전 버전" title="이전 버전" disabled={v.index <= 0} onClick={() => v.go(v.index - 1)}>‹</button>
      <span>{v.index + 1}/{v.count}</span>
      <button type="button" className="msg-act" aria-label="다음 버전" title="다음 버전" disabled={v.index >= v.count - 1} onClick={() => v.go(v.index + 1)}>›</button>
    </div>
  );
}

/**
 * 다시 생성, supplied by the pane around the chat (the chat's own MessageActions do not know the session's models).
 * `turnOf`: the user message a reply answers when it ends its turn and could be branched from (replyTurn).
 * `branch`: runs that message again as a new branch (like 편집 with the text unchanged); `model` = that branch's model (its default from then on).
 * `retryWith`: GPT / Gemini — the last prompt sent again with `model` for this one turn (their sessions keep their own model).
 */
export type Regenerate = {
  turnOf: (item: ChatItem) => ReplyTurn | null;
  branch?: (turn: ReplyTurn, model?: ModelChoice) => void;
  retryWith?: (model: ModelChoice) => void;
  /** The session's models (the composer picker's list, 자동 left out); the menu is offered only with another one to pick. */
  models: readonly ModelChoice[];
  current: ModelChoice;
};
export const RegenerateContext = createContext<Regenerate | null>(null);

const CaretIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>;

/** ⌄ next to 다시 생성: pick a model — a Claude branch keeps it as its model (`sticky`), GPT / Gemini use it for this one run. */
function RegenModelMenu({ models, current, sticky, onPick }: { models: readonly ModelChoice[]; current: ModelChoice; sticky: boolean; onPick: (m: ModelChoice) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPlacement(open, btnRef, popRef, 240);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btnRef.current?.focus(); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <>
      <button ref={btnRef} type="button" className="msg-act regen-caret" aria-label="다른 모델로 다시 생성" title={sticky ? '다른 모델로 다시 생성 (새 갈래의 기본 모델이 돼요)' : '다른 모델로 다시 생성 (이번 한 번만)'} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><CaretIcon /></button>
      {open && (
        <div ref={popRef} className="mp-pop regen-pop" role="menu" aria-label="다시 생성할 모델" style={pos} data-testid="regen-menu">
          <div className="mp-head">이 모델로 다시 생성</div>
          {models.map((m) => (
            <button key={m} type="button" role="menuitem" className={`mp-item ${m === current ? 'on' : ''}`} onClick={() => { setOpen(false); onPick(m); }}>
              <span className="mp-text">
                <span className="mp-name">{m === 'auto' ? '자동' : MODEL_INFO[m].name}</span>
                {m === current && <span className="mp-desc">지금 모델</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const SelectIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4h7M3 8h10M3 12h5" /><path d="M12 10v4M10.5 10h3M10.5 14h3" /></svg>;

/**
 * 텍스트 선택: selects all of `body` (a message's text) so the phone's own selection handles can narrow it — the long press
 * that opens the sheet is the gesture a phone would otherwise use to start a selection.
 */
function selectAll(body: Element | null | undefined) {
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (!body || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(body);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** A message's first non-empty line, markdown marks dropped: the long-press sheet's head (CSS cuts it to one line). */
function excerptOf(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^(#+|[-*>]|\d+\.)\s+/, '').replace(/[*_`~]/g, '').slice(0, 200);
}

/** Touch: a press this long on a message opens its menu (§7.2); moving past FileMenu's slop cancels it (a scroll). */
export const MSG_PRESS_MS = 350;
/** A press starting on a control inside the message keeps its own tap / long press (file chips, code buttons, tool rows). */
const PRESS_IGNORE = 'button, a, input, textarea, select, summary, [role="button"]';

type RegenPick = { models: readonly ModelChoice[]; current: ModelChoice; sticky: boolean; onPick: (m: ModelChoice) => void };

/**
 * A message's actions as a bottom sheet (touch long press): 복사 · 편집 · 재시도 · 다시 생성 · 다른 모델로 · 버전 ‹ ›, the
 * same set the hover row offers. A modal dialog (Sheet: Esc yields to popups over it, focus goes back to the message);
 * Tab stays inside. A portal so a transformed message never clips it, its events kept from the message's long press.
 */
function MessageSheet({ excerpt, copy, select, edit, retry, again, pick, versions, onClose }: {
  /** The message's first line: the sheet's one-line head (which message the menu is for). */
  excerpt: string;
  copy: (() => void) | null; select: (() => void) | null; edit: (() => void) | null; retry: (() => void) | undefined; again: (() => void) | undefined;
  pick: RegenPick | null; versions: Versions | null; onClose: () => void;
}) {
  const [models, setModels] = useState(false);
  // Opened by a long press: the first item takes focus without a ring; the ring comes once a key is pressed.
  const [keyed, setKeyed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true, focusVisible: false } as FocusOptions); }, []);
  // The sheet closes (focus back on the message) before the action runs, so an action that moves focus keeps it.
  const run = (f: () => void) => () => { flushSync(onClose); f(); };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div className="msg-sheet-root" onPointerDown={stop} onClick={stop} onContextMenu={stop} onKeyDownCapture={keyed ? undefined : () => setKeyed(true)}>
      <Sheet className={`msg-sheet${keyed ? '' : ' by-touch'}`} label="메시지 메뉴" onClose={onClose}>
        <SheetHead title={excerpt} onClose={onClose} autoFocus={false} excerpt />
        <div ref={ref} className="msg-sheet-list" data-testid="msg-sheet">
          {copy && <button type="button" className="msg-sheet-item" onClick={run(copy)}><CopyIcon />복사</button>}
          {select && <button type="button" className="msg-sheet-item" onClick={run(select)}><SelectIcon />텍스트 선택</button>}
          {edit && <button type="button" className="msg-sheet-item" onClick={run(edit)}><EditIcon />편집</button>}
          {retry && <button type="button" className="msg-sheet-item" onClick={run(retry)}><RetryIcon />재시도</button>}
          {again && <button type="button" className="msg-sheet-item" onClick={run(again)}><RetryIcon />다시 생성</button>}
          {pick && (
            <>
              <button type="button" className="msg-sheet-item" aria-expanded={models} onClick={() => setModels((o) => !o)}><CaretIcon />다른 모델로 다시 생성</button>
              {models && (
                <div className="msg-sheet-models" role="group" aria-label="다시 생성할 모델">
                  {pick.models.map((m) => (
                    <button key={m} type="button" className={`msg-sheet-item sub${m === pick.current ? ' on' : ''}`} onClick={run(() => pick.onPick(m))}>
                      {m === 'auto' ? '자동' : MODEL_INFO[m].name}{m === pick.current && <span className="msg-sheet-hint">지금 모델</span>}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {versions && (
            <div className="msg-sheet-versions" role="group" aria-label="버전">
              <button type="button" className="msg-sheet-item" aria-label="이전 버전" disabled={versions.index <= 0} onClick={run(() => versions.go(versions.index - 1))}>‹</button>
              <span>버전 {versions.index + 1}/{versions.count}</span>
              <button type="button" className="msg-sheet-item" aria-label="다음 버전" disabled={versions.index >= versions.count - 1} onClick={run(() => versions.go(versions.index + 1))}>›</button>
            </div>
          )}
        </div>
      </Sheet>
    </div>,
    document.body,
  );
}

/** A long user message: folded past this many lines or characters, showing about COLLAPSED_LINES (CSS) until 더 보기. */
const FOLD_LINES = 12;
const FOLD_CHARS = 1200;

/** The user bubble's text; a long one folds (local state, never saved) and unfolds by itself when a search jumps to it. */
function UserText({ text }: { text: string }) {
  const lines = text.split('\n').length;
  const long = lines > FOLD_LINES || text.length > FOLD_CHARS;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const viaSearch = useRef(false);
  const folded = long && !open;
  // App's search jump marks the message with .search-flash: a folded message opens so the hit is on screen.
  useEffect(() => {
    const msg = folded ? ref.current?.closest('.msg') : null;
    if (!msg || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => { if (msg.classList.contains('search-flash')) { viaSearch.current = true; setOpen(true); } });
    mo.observe(msg, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [folded]);
  // Unfolded by a search jump: the message grew, so it is centered again.
  useEffect(() => {
    if (open && viaSearch.current) {
      viaSearch.current = false;
      ref.current?.closest('.msg')?.scrollIntoView?.({ block: 'center' });
    }
  }, [open]);
  if (!long) return <pre>{text}</pre>;
  return (
    <>
      <pre ref={ref} className={folded ? 'folded' : undefined} data-testid="user-text">{text}</pre>
      <button type="button" className="fold-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '접기' : `더 보기 (${lines}줄)`}</button>
    </>
  );
}

/** deck-choices option cards: a click sends the option as the reply; without onPick (not the last reply, or busy) they are shown disabled. */
function ChoiceCards({ choices, onPick }: { choices: DeckChoices; onPick: ((text: string) => void) | undefined }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="choice-cards" role="group" aria-label={choices.question ?? '선택지'} data-testid="choice-cards">
      {choices.question && <div className="choice-q">{choices.question}</div>}
      <div className="choice-list">
        {choices.options.map((o) => (
          <button key={o} type="button" className={`choice${picked === o ? ' picked' : ''}`} data-testid="choice" disabled={!onPick || picked !== null}
            onClick={() => { if (!onPick) return; setPicked(o); onPick(o); }}>{o}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Desktop style: user = right-aligned bubble; assistant = plain text on the background, tool calls as muted lines.
 * Memoized: the composer's draft lives in Chat, so without this every keystroke re-rendered (and re-parsed the
 * markdown of) the whole transcript. Items are immutable (the reducer replaces what changes), so identity is enough.
 * `last`: the conversation's last message (its actions stay visible and it offers 재시도).
 */
export const MessageView = memo(function MessageView({ item, cwd, last = false }: { item: ChatItem; /** Session folder: diff card paths are shown relative to it. */ cwd?: string; last?: boolean }) {
  const actions = useContext(MessageActionsContext);
  const regen = useContext(RegenerateContext);
  const [prefs] = usePrefs();
  const concise = prefs.conciseMode;
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const msgRef = useRef<HTMLDivElement>(null);
  // Touch long press → the action sheet. Not over a text selection the user is making; the message takes focus first so
  // the sheet hands it back there when it closes.
  const press = useLongPress(() => {
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
    const el = msgRef.current;
    if ((sel && !sel.isCollapsed) || !el) return false;
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    setMenu(true);
  }, { ms: MSG_PRESS_MS, ignore: PRESS_IGNORE });
  const closeMenu = () => setMenu(false);
  // Copy feedback as one toast (a status: read out once). The hover row's ✓ already says it on a desktop; on touch the
  // icon alone is easy to miss, so the row's copy toasts too.
  const feedback = useFileActions();
  const copied = actions.coarse ? (ok: boolean) => feedback.toast(ok ? '복사했어요' : '복사하지 못했어요', ok ? 'info' : 'error') : undefined;
  if (item.kind === 'user') {
    if (item.text === HANDOFF_PROMPT) return <div className="msg user handoff-req" title={HANDOFF_PROMPT}><pre>인계 메모 요청 (새 세션으로 이어가기)</pre></div>;
    const { text, notices } = parseUserText(item.text);
    const files = item.attachments ?? [];
    const system = notices.length > 0 && <div className="msg system">{notices.map((n, i) => <SystemNotice key={i} n={n} />)}</div>;
    if (!text && !files.length) return system || null;
    // 메시지 편집 갈래 when the session can fork here; else the composer gets the text (the tooltip says why).
    const n = item.n;
    const branch = actions.onBranch && n !== undefined ? actions.onBranch : null;
    const editTitle = branch ? '편집 — 이 메시지를 고쳐 새 갈래로 다시 보내기' : `편집 — ${actions.editNote ?? (actions.onBranch ? '메시지 위치를 알 수 없어 입력창에 넣습니다' : '입력창에서 고쳐 다시 보내기')}`;
    const versions = n !== undefined ? (actions.versions?.(n) ?? null) : null;
    const edit = branch || actions.onEdit ? () => (branch ? setEditing(true) : actions.onEdit?.(text)) : null;
    if (editing && branch && n !== undefined) {
      return (
        <>
          {system}
          <InlineEdit initial={text} coarse={actions.coarse ?? false} onCancel={() => setEditing(false)} onSubmit={(t) => { setEditing(false); branch(n, t, text); }} />
        </>
      );
    }
    return (
      <>
        {system}
        <div ref={msgRef} className="msg user" {...(text ? press : {})}>
          {files.length > 0 && <AttachmentTiles files={files} />}
          {text && <UserText text={text} />}
          {/* The versions sit right under the bubble, beside its (hover / touch-hidden) action row. */}
          {(text || versions) && (
            <div className="msg-user-foot">
              {versions && <VersionSwitcher v={versions} />}
              {text && (
                <div className="msg-actions" data-testid="user-actions">
                  <CopyButton icon text={text} label="메시지 복사" {...(copied ? { onDone: copied } : {})} />
                  {edit && <button type="button" className="msg-act" aria-label="편집" title={editTitle} onClick={edit}><EditIcon /></button>}
                </div>
              )}
            </div>
          )}
        </div>
        {menu && text && <MessageSheet excerpt={excerptOf(text)} copy={() => feedback.copy(text, '복사했어요')} select={() => selectAll(msgRef.current?.querySelector('pre'))} edit={edit} retry={undefined} again={undefined} pick={null} versions={versions} onClose={closeMenu} />}
        {feedback.node}
      </>
    );
  }
  if (item.kind === 'system') return <SystemRow item={item} />;
  const stopped = !!item.badge && !item.streaming && isStoppedTurn({ badge: item.badge, error: item.error, text: item.text, interrupted: !!item.interrupted });
  const retry = last && !item.streaming ? actions.onRetry : undefined;
  // 다시 생성: the last reply keeps 재시도 (same session); an earlier one runs its prompt again as a new branch (편집, text unchanged).
  const turn = !item.streaming && regen?.branch ? regen.turnOf(item) : null;
  const branchFrom = turn ? regen?.branch : undefined;
  const again = !last && turn && branchFrom ? () => branchFrom(turn) : undefined;
  // Another model: a Claude branch (which keeps it as its model), or GPT / Gemini's last turn sent again with it this one time.
  const pickable = regen && regen.models.some((m) => m !== regen.current);
  const pick = !pickable || item.streaming ? undefined : turn && branchFrom ? (m: ModelChoice) => branchFrom(turn, m) : retry ? regen.retryWith : undefined;
  // deck-choices (GPT, Gemini, Grok): the block becomes option cards; only the last reply's cards can be clicked.
  const { text: shownText, choices } = splitDeckChoices(item.text, item.streaming);
  const split = concise && item.streaming ? conciseLiveSplit(shownText, item.toolCalls.map((t) => t.textAt)) : null;
  const reply = last && !item.streaming ? actions.onReply : undefined;
  const hasActions = !item.streaming && (!!item.text || !!retry || !!again || !!pick);
  const regenPick: RegenPick | null = pick && regen ? { models: regen.models, current: regen.current, sticky: !!(turn && branchFrom), onPick: pick } : null;
  return (
    <FileRootContext.Provider value={cwd || null}>
    <div ref={msgRef} className={`msg assistant ${item.streaming ? 'streaming' : ''}${last ? ' last' : ''}`} {...(hasActions ? press : {})}>
      {/* Concise: mid-turn notes stay (milestones); full-mode attempts always show. */}
      {item.notes.map((n, i) => <div key={i} className={`note${concise ? ' concise-note' : ''}`}>{n}</div>)}
      {(!concise || !item.streaming) && item.attempts.map((t, i) => <Markdown key={i} text={t} className="markdown failed-attempt muted" />)}
      {item.thinking && !(concise && item.streaming && !item.thinking.text && !item.thinking.redacted) && (
        <Thinking t={item.thinking} streaming={item.streaming} concise={concise} />
      )}
      <ToolCalls calls={item.toolCalls} live={item.streaming} cwd={cwd} concise={concise} />
      {/* Concise, mid-turn: text before the last tool call folds into a gray lead line; the text since streams live below it. */}
      {split && (!split.live || item.toolCalls.length > 0) && (
        <div className="concise-progress" data-testid="concise-progress" aria-live="polite">
          {split.lead && <div className="concise-lead" data-testid="concise-lead">{split.lead}</div>}
          {item.toolCalls.length > 0
            ? `계속 작업 중 · 단계 ${item.toolCalls.length}`
            : item.thinking
              ? '생각하는 중…'
              : '처리 중…'}
        </div>
      )}
      {split ? split.live && <Markdown text={split.live} /> : shownText && <Markdown text={shownText} />}
      {choices && !item.streaming && <ChoiceCards choices={choices} onPick={reply} />}
      {item.streaming && (!split || !!split.live) && <span className="cursor">▍</span>}
      {item.error && !(!item.streaming && isAbortError(item.error, !!item.interrupted)) && <div className="error">오류: {item.error}</div>}
      {(item.badge || item.model || item.toolCalls.length > 0 || hasActions) && (
        <div className="turn-foot">
          {item.badge && <TurnBadge badge={item.badge} {...(item.model ? { model: item.model } : {})} stopped={stopped} failed={stopped && isFailedTurn({ error: item.error, interrupted: !!item.interrupted })} cacheNote={item.cacheNote ?? null} ctx={last ? (item.ctx ?? null) : null} />}
          {!item.badge && item.model && <span className="msg-model" data-testid="msg-model" title={item.model}>{modelLabelOf(item.model)}</span>}
          {hasActions && (
            <div className="msg-actions" data-testid="turn-actions">
              {item.text && <CopyButton icon text={shownText || item.text} label="응답 복사" {...(copied ? { onDone: copied } : {})} />}
              {retry && <button type="button" className="msg-act" aria-label="재시도" title="재시도" onClick={retry}><RetryIcon /></button>}
              {again && <button type="button" className="msg-act" aria-label="다시 생성" title="다시 생성 — 이 답장부터 새 갈래로" onClick={again}><RetryIcon /></button>}
              {regenPick && <RegenModelMenu models={regenPick.models} current={regenPick.current} sticky={regenPick.sticky} onPick={regenPick.onPick} />}
            </div>
          )}
          <RoleBadge roles={roleSummary(item.toolCalls)} />
        </div>
      )}
    </div>
    {menu && hasActions && (
      <MessageSheet
        excerpt={excerptOf(shownText || item.text)}
        copy={item.text ? () => feedback.copy(shownText || item.text, '복사했어요') : null}
        select={shownText ? () => selectAll(msgRef.current?.querySelector('.markdown:not(.failed-attempt)')) : null}
        edit={null} retry={retry} again={again} pick={regenPick} versions={null} onClose={closeMenu}
      />
    )}
    {feedback.node}
    </FileRootContext.Provider>
  );
});
