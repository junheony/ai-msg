import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseUserText, type InjectedNotice } from '../injected';
import { roleSummary } from '../roles';
import type { ChatItem, SentFile } from '../state';
import { Lightbox, attachmentUrl } from './Lightbox';
import { RoleBadge } from './RoleBadge';
import { ToolCalls } from './ToolCallView';
import { TurnBadge, isStoppedTurn } from './TurnBadge';

/** Plain text of a rendered markdown subtree (code blocks arrive as nested elements). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Clipboard API needs a secure context; deck over plain-http Tailnet falls back to execCommand. */
async function copyText(s: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(s); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const id = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <button type="button" className="code-copy" onClick={() => void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'))} aria-label="코드 복사">
      {state === 'ok' ? '복사됨' : state === 'fail' ? '복사 실패' : '복사'}
    </button>
  );
}

/** Fenced code: a header strip with the language and a copy button above the scrolling body. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Array.isArray(children) ? children[0] : children;
  const cls = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : '';
  const lang = /language-([\w+#.-]+)/.exec(cls)?.[1] ?? '';
  const text = textOf(children).replace(/\n$/, '');
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/**
 * Review I8: model output must not make the browser fetch attacker URLs, so a markdown image
 * becomes a plain link the user can choose to open.
 */
const MD_COMPONENTS: Components = {
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} rel="noreferrer noopener" target="_blank">🖼 {alt || (typeof src === 'string' ? src : '이미지')}</a>
  ),
  a: ({ href, children }) => <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>,
  // GFM tables scroll sideways inside the message instead of widening the chat (phone).
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};
const MD_PLUGINS = [remarkGfm];

/** Memoized on its text: parsing is the expensive part, and a streaming turn re-creates its item on every delta. */
const Markdown = memo(function Markdown({ text, className = 'markdown' }: { text: string; className?: string }) {
  return <div className={className}><ReactMarkdown components={MD_COMPONENTS} remarkPlugins={MD_PLUGINS}>{text}</ReactMarkdown></div>;
});

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
 * Desktop style: user = right-aligned bubble; assistant = plain text on the background, tool calls as muted lines.
 * Memoized: the composer's draft lives in Chat, so without this every keystroke re-rendered (and re-parsed the
 * markdown of) the whole transcript. Items are immutable (the reducer replaces what changes), so identity is enough.
 */
export const MessageView = memo(function MessageView({ item, cwd }: { item: ChatItem; /** Session folder: diff card paths are shown relative to it. */ cwd?: string }) {
  if (item.kind === 'user') {
    const { text, notices } = parseUserText(item.text);
    const files = item.attachments ?? [];
    const system = notices.length > 0 && <div className="msg system">{notices.map((n, i) => <SystemNotice key={i} n={n} />)}</div>;
    if (!text && !files.length) return system || null;
    return (
      <>
        {system}
        <div className="msg user">
          {files.length > 0 && <AttachmentTiles files={files} />}
          {text && <pre>{text}</pre>}
        </div>
      </>
    );
  }
  const stopped = !!item.badge && !item.streaming && isStoppedTurn({ badge: item.badge, error: item.error, text: item.text });
  return (
    <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>
      {item.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      {item.attempts.map((t, i) => <Markdown key={i} text={t} className="markdown failed-attempt muted" />)}
      <ToolCalls calls={item.toolCalls} live={item.streaming} cwd={cwd} />
      {item.text && <Markdown text={item.text} />}
      {item.streaming && <span className="cursor">▍</span>}
      {item.error && !(stopped && item.error === '중단됨') && <div className="error">오류: {item.error}</div>}
      {(item.badge || item.toolCalls.length > 0) && (
        <div className="turn-foot">
          {item.badge && <TurnBadge badge={item.badge} stopped={stopped} cacheNote={item.cacheNote ?? null} />}
          <RoleBadge roles={roleSummary(item.toolCalls)} />
        </div>
      )}
    </div>
  );
});
