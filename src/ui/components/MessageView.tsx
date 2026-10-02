import { createContext, isValidElement, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HANDOFF_PROMPT } from '../../shared/handoff';
import { parseUserText, type InjectedNotice } from '../injected';
import { roleSummary } from '../roles';
import type { ChatItem, SentFile } from '../state';
import { CopyButton } from './CopyButton';
import { EditIcon, RetryIcon } from './icons';
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
        <CopyButton text={text} label="코드 복사" />
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

type Enhance = typeof import('../mdEnhance');
let enhance: Enhance | null = null;
let enhancing: Promise<void> | null = null;
/** Highlighting + math are a separate chunk, fetched the first time a message has a code fence or a `$`. */
function loadEnhance(): Promise<void> {
  return (enhancing ??= import('../mdEnhance').then((m) => { enhance = m; }, () => { enhancing = null; }));
}
const NEEDS_ENHANCE = /```|~~~|\$/;

/** Memoized on its text: parsing is the expensive part, and a streaming turn re-creates its item on every delta. */
const Markdown = memo(function Markdown({ text, className = 'markdown' }: { text: string; className?: string }) {
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

/** Claude's thinking as a collapsed disclosure above the reply (Desktop: "N초 동안 생각함"). */
function Thinking({ t, streaming }: { t: NonNullable<Extract<ChatItem, { kind: 'assistant' }>['thinking']>; streaming: boolean }) {
  const secs = t.ms === null ? null : Math.max(1, Math.round(t.ms / 1000));
  const label = t.ms === null && streaming ? '생각하는 중…' : secs === null ? '생각 과정' : `${secs}초 동안 생각함`;
  const body = t.text.trim();
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
export type MessageActions = { onEdit?: (text: string) => void; onRetry?: () => void };
export const MessageActionsContext = createContext<MessageActions>({});

/**
 * Desktop style: user = right-aligned bubble; assistant = plain text on the background, tool calls as muted lines.
 * Memoized: the composer's draft lives in Chat, so without this every keystroke re-rendered (and re-parsed the
 * markdown of) the whole transcript. Items are immutable (the reducer replaces what changes), so identity is enough.
 * `last`: the conversation's last message (its actions stay visible and it offers 재시도).
 */
export const MessageView = memo(function MessageView({ item, cwd, last = false }: { item: ChatItem; /** Session folder: diff card paths are shown relative to it. */ cwd?: string; last?: boolean }) {
  const actions = useContext(MessageActionsContext);
  if (item.kind === 'user') {
    if (item.text === HANDOFF_PROMPT) return <div className="msg user handoff-req" title={HANDOFF_PROMPT}><pre>인계 메모 요청 (새 세션으로 이어가기)</pre></div>;
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
          {text && (
            <div className="msg-actions" data-testid="user-actions">
              <CopyButton icon text={text} label="메시지 복사" />
              {actions.onEdit && <button type="button" className="msg-act" aria-label="편집" title="편집 — 입력창에서 고쳐 다시 보내기" onClick={() => actions.onEdit?.(text)}><EditIcon /></button>}
            </div>
          )}
        </div>
      </>
    );
  }
  const stopped = !!item.badge && !item.streaming && isStoppedTurn({ badge: item.badge, error: item.error, text: item.text });
  const retry = last && !item.streaming ? actions.onRetry : undefined;
  const hasActions = !item.streaming && (!!item.text || !!retry);
  return (
    <div className={`msg assistant ${item.streaming ? 'streaming' : ''}${last ? ' last' : ''}`}>
      {item.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      {item.attempts.map((t, i) => <Markdown key={i} text={t} className="markdown failed-attempt muted" />)}
      {item.thinking && <Thinking t={item.thinking} streaming={item.streaming} />}
      <ToolCalls calls={item.toolCalls} live={item.streaming} cwd={cwd} />
      {item.text && <Markdown text={item.text} />}
      {item.streaming && <span className="cursor">▍</span>}
      {item.error && !(stopped && item.error === '중단됨') && <div className="error">오류: {item.error}</div>}
      {(item.badge || item.toolCalls.length > 0 || hasActions) && (
        <div className="turn-foot">
          {hasActions && (
            <div className="msg-actions" data-testid="turn-actions">
              {item.text && <CopyButton icon text={item.text} label="응답 복사" />}
              {retry && <button type="button" className="msg-act" aria-label="재시도" title="재시도" onClick={retry}><RetryIcon /></button>}
            </div>
          )}
          {item.badge && <TurnBadge badge={item.badge} stopped={stopped} cacheNote={item.cacheNote ?? null} />}
          <RoleBadge roles={roleSummary(item.toolCalls)} />
        </div>
      )}
    </div>
  );
});
