import { useEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, MODEL_LABEL, type ClaudeModel } from '../../shared/models';
import type { PermissionDecision } from '../../shared/turn-types';
import type { ChatItem, PendingPermission } from '../state';
import { MessageView } from './MessageView';
import { PermissionCard } from './PermissionCard';

export function Chat({ items, pending, activeTurnId, busy, model, title, onSend, onInterrupt, onDecide, onModel }: {
  items: ChatItem[];
  pending: PendingPermission[];
  activeTurnId: string | null;
  busy: boolean;
  model: ClaudeModel;
  title: string;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onModel: (m: ClaudeModel) => void;
}) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [items, pending]);

  // Review M12: a failed last turn can be re-sent as-is.
  const last = items.at(-1);
  const retryPrompt = !busy && last?.kind === 'assistant' && last.error !== null && !last.streaming
    ? ([...items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null
    : null;

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText('');
  };

  return (
    <main className="chat">
      <div className="chat-head">{title}</div>
      <div className="chat-body">
        {items.map((it, i) => <MessageView key={i} item={it} />)}
        {retryPrompt !== null && <button type="button" className="retry" onClick={() => onSend(retryPrompt)}>재시도</button>}
        {pending.map((p) => <PermissionCard key={p.requestId} req={p} onDecide={onDecide} />)}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          placeholder="메시지 (⌘/Ctrl+Enter 로 보내기)"
          rows={3}
        />
        <div className="composer-actions">
          <select value={model} onChange={(e) => onModel(e.target.value as ClaudeModel)} title="이 세션의 기본 모델">
            {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
          </select>
          {activeTurnId ? <button type="button" className="deny" onClick={onInterrupt}>중단</button> : <button type="button" onClick={submit} disabled={!text.trim() || busy}>보내기</button>}
        </div>
      </div>
    </main>
  );
}
