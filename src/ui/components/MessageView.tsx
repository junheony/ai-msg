import ReactMarkdown from 'react-markdown';
import type { ChatItem } from '../state';
import { ToolCallView } from './ToolCallView';
import { TurnBadge } from './TurnBadge';

export function MessageView({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <div className="msg user"><pre>{item.text}</pre></div>;
  return (
    <div className={`msg assistant ${item.streaming ? 'streaming' : ''}`}>
      {item.notes.map((n, i) => <div key={i} className="note">{n}</div>)}
      {item.toolCalls.map((c) => <ToolCallView key={c.toolUseId} call={c} />)}
      <div className="markdown"><ReactMarkdown>{item.text}</ReactMarkdown></div>
      {item.streaming && <span className="cursor">▍</span>}
      {item.error && <div className="error">오류: {item.error}</div>}
      {item.badge && <TurnBadge badge={item.badge} />}
    </div>
  );
}
