import ReactMarkdown, { type Components } from 'react-markdown';
import { roleSummary } from '../roles';
import type { ChatItem } from '../state';
import { RoleBadge } from './RoleBadge';
import { ToolCallView } from './ToolCallView';
import { TurnBadge } from './TurnBadge';

/**
 * Review I8: model output must not make the browser fetch attacker URLs, so a markdown image
 * becomes a plain link the user can choose to open.
 */
const MD_COMPONENTS: Components = {
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} rel="noreferrer noopener" target="_blank">🖼 {alt || (typeof src === 'string' ? src : '이미지')}</a>
  ),
  a: ({ href, children }) => <a href={href} rel="noreferrer noopener" target="_blank">{children}</a>,
};

export function MessageView({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return (
    <div className="msg user">
      <pre>{item.text}</pre>
      {item.attachments?.map((n, i) => <span key={i} className="chip">{n}</span>)}
    </div>
  );
  return (
    <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>
      {item.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      {item.attempts.map((t, i) => <div key={i} className="markdown failed-attempt muted"><ReactMarkdown components={MD_COMPONENTS}>{t}</ReactMarkdown></div>)}
      {item.toolCalls.map((c) => <ToolCallView key={c.toolUseId} call={c} />)}
      <div className="markdown"><ReactMarkdown components={MD_COMPONENTS}>{item.text}</ReactMarkdown></div>
      {item.streaming && <span className="cursor">▍</span>}
      {item.error && <div className="error">오류: {item.error}</div>}
      {item.badge && <TurnBadge badge={item.badge} />}
      <RoleBadge roles={roleSummary(item.toolCalls)} />
    </div>
  );
}
