import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { CLAUDE_MODELS, CODEX_MODELS, CODEX_SANDBOXES, MODEL_LABEL, SANDBOX_LABEL, type AnyModel, type CodexSandbox, type EngineChoice, type EngineKind } from '../../shared/models';
import type { PermissionDecision, QuestionAnswers } from '../../shared/turn-types';
import type { ChatItem, PendingPermission, PendingQuestion, UploadedAttachment } from '../state';
import { filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AttachmentBar } from './AttachmentBar';
import { MessageView } from './MessageView';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';

export type ChatProps = {
  items: ChatItem[];
  pending: PendingPermission[];
  questions: PendingQuestion[];
  activeTurnId: string | null;
  busy: boolean;
  title: string;
  model: AnyModel;
  /** New-session choices (D2, D3). */
  engine: EngineChoice;
  sandbox: CodexSandbox;
  /** The open session's engine/sandbox (null until known); ignored while the session is new (PF11). */
  sessionEngine: EngineKind | null;
  sessionSandbox: CodexSandbox | null;
  isNew: boolean;
  codexAvailable: boolean;
  attachments: UploadedAttachment[];
  uploadFn?: UploadFn;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  onModel: (m: AnyModel) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
};

const ATTACHMENT_ONLY_TEXT = '첨부 파일을 확인해 주세요.';

export function Chat(p: ChatProps) {
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [p.items, p.pending, p.questions]);
  const { addFiles, uploading, error } = useUploads({ uploadFn: p.uploadFn ?? uploadFile, current: p.attachments.length, onUploaded: p.onAttach });

  // Review M12: a failed last turn can be re-sent as-is.
  const last = p.items.at(-1);
  const retryPrompt = !p.busy && last?.kind === 'assistant' && last.error !== null && !last.streaming
    ? ([...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null
    : null;

  // D3 / PF11: a new session follows the picker (the engine recorded at open time is ignored while it is new);
  // once the session exists its engine is fixed.
  const effectiveEngine: EngineChoice = p.isNew ? p.engine : (p.sessionEngine ?? 'claude');
  const models: readonly AnyModel[] = effectiveEngine === 'codex' ? CODEX_MODELS : effectiveEngine === 'claude' ? CLAUDE_MODELS : [...CLAUDE_MODELS, ...CODEX_MODELS];
  const canSend = (text.trim().length > 0 || p.attachments.length > 0) && !p.busy && uploading === 0;

  const submit = () => {
    if (!canSend) return;
    p.onSend(text.trim() || ATTACHMENT_ONLY_TEXT);
    setText('');
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDrag(false);
    const files = filesFrom(e.dataTransfer);
    if (files.length) void addFiles(files);
  };

  return (
    <main className="chat">
      <div className="chat-head">
        <span className="chat-title">{p.title}</span>
        {!p.isNew && p.sessionEngine === 'codex' && <span className="chip sandbox" title="D2: GPT 세션은 승인 카드 대신 샌드박스로 보호됩니다">GPT · 샌드박스: {SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
      </div>
      <div className="chat-body">
        {p.items.map((it, i) => <MessageView key={i} item={it} />)}
        {retryPrompt !== null && <button type="button" className="retry" onClick={() => p.onSend(retryPrompt)}>재시도</button>}
        {p.pending.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={p.onDecide} />)}
        {p.questions.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={p.onAnswer} />)}
        <div ref={endRef} />
      </div>
      <AttachmentBar attachments={p.attachments} uploading={uploading} error={error} onFiles={(f) => void addFiles(f)} onRemove={p.onUnattach} />
      <div className={`composer ${drag ? 'dragover' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          onPaste={onPaste}
          placeholder="메시지 (⌘/Ctrl+Enter 로 보내기 · 이미지 붙여넣기/끌어놓기)"
          rows={3}
        />
        <div className="composer-actions">
          {p.isNew && p.codexAvailable && (
            <select value={p.engine} onChange={(e) => p.onEngine(e.target.value as EngineChoice)} title="이 세션의 엔진 (세션 생성 후 변경 불가)" data-testid="engine-select">
              <option value="claude">Claude</option>
              <option value="codex">GPT</option>
              <option value="auto">자동</option>
            </select>
          )}
          {p.isNew && p.codexAvailable && effectiveEngine !== 'claude' && (
            <select value={p.sandbox} onChange={(e) => p.onSandbox(e.target.value as CodexSandbox)} title="GPT 샌드박스 (승인 없음 · 세션 생성 후 변경 불가)" data-testid="sandbox-select">
              {CODEX_SANDBOXES.map((s) => <option key={s} value={s}>{SANDBOX_LABEL[s]}</option>)}
            </select>
          )}
          <select value={p.model} onChange={(e) => p.onModel(e.target.value as AnyModel)} title="이 세션의 기본 모델" data-testid="model-select">
            {models.map((m) => <option key={m} value={m}>{MODEL_LABEL[m]}</option>)}
          </select>
          {p.activeTurnId ? <button type="button" className="deny" onClick={p.onInterrupt}>중단</button> : <button type="button" onClick={submit} disabled={!canSend}>보내기</button>}
        </div>
      </div>
    </main>
  );
}
