import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { CLAUDE_MODELS, CODEX_MODELS, CODEX_SANDBOXES, SANDBOX_LABEL, type AnyModel, type CodexSandbox, type Effort, type EngineChoice, type EngineKind } from '../../shared/models';
import type { PermissionDecision, QuestionAnswers } from '../../shared/turn-types';
import type { ChatItem, PendingPermission, PendingQuestion, QueueItem, UploadedAttachment } from '../state';
import { latestTodos } from '../todos';
import { mergeToolRuns } from '../toolRuns';
import { filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AttachmentBar } from './AttachmentBar';
import { useComposerSuggest } from './ComposerSuggest';
import { MessageView } from './MessageView';
import { ModelPicker } from './ModelPicker';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { QueueChips } from './QueueChips';
import { TodoPanel } from './TodoPanel';

export type ChatProps = {
  items: ChatItem[];
  pending: PendingPermission[];
  questions: PendingQuestion[];
  activeTurnId: string | null;
  busy: boolean;
  title: string;
  /** Session folder: the header shows its last segment as a chip, the full path on hover. */
  cwd?: string;
  /** For `/` command suggestions (null while the session is new). */
  sessionId?: string | null;
  /** Right-aligned header buttons (the pane's close button). */
  headActions?: ReactNode;
  model: AnyModel;
  /** Reasoning effort for `model`'s engine. */
  effort: Effort;
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
  /** Stops the background work held by that turn's process (interrupt by its turn id). */
  onStopBackground?: (turnId: string) => void;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  onModel: (m: AnyModel) => void;
  onEffort: (e: Effort) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
  /** ux-state: while busy, a submit queues the message (absent = the composer can't send while busy). */
  queue?: QueueItem[];
  queuePaused?: boolean;
  onQueue?: (text: string) => void;
  onQueueEdit?: (id: string, text: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
  onQueueResume?: () => void;
};

const ATTACHMENT_ONLY_TEXT = '첨부 파일을 확인해 주세요.';

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Seconds since the pane went busy, ticking once a second while it stays busy. */
function useElapsed(busy: boolean): number | null {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) { setStart(null); return; }
    const t0 = Date.now();
    setStart(t0);
    setNow(t0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);
  return start === null ? null : now - start;
}

export function Chat(p: ChatProps) {
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [p.items, p.pending, p.questions]);
  const { addFiles, uploading, error } = useUploads({ uploadFn: p.uploadFn ?? uploadFile, current: p.attachments.length, onUploaded: p.onAttach });
  const runMs = useElapsed(p.busy);
  const shown = useMemo(() => mergeToolRuns(p.items), [p.items]);
  const todos = useMemo(() => latestTodos(p.items), [p.items]);

  // Review M12: a failed last turn can be re-sent as-is.
  const last = p.items.at(-1);
  const retryPrompt = !p.busy && last?.kind === 'assistant' && last.error !== null && !last.streaming
    ? ([...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null
    : null;

  // D3 / PF11: a new session follows the picker (the engine recorded at open time is ignored while it is new);
  // once the session exists its engine is fixed.
  const effectiveEngine: EngineChoice = p.isNew ? p.engine : (p.sessionEngine ?? 'claude');
  const models: readonly AnyModel[] = effectiveEngine === 'codex' ? CODEX_MODELS : effectiveEngine === 'claude' ? CLAUDE_MODELS : [...CLAUDE_MODELS, ...CODEX_MODELS];
  const hasDraft = (text.trim().length > 0 || p.attachments.length > 0) && uploading === 0;
  const queueing = p.busy && !!p.onQueue;
  const canSend = hasDraft && (!p.busy || queueing);
  const live = last?.kind === 'assistant' && last.streaming ? last : null;
  const liveTools = live ? live.toolCalls.length : 0;
  const suggest = useComposerSuggest({ text, setText, textareaRef: taRef, cwd: p.cwd, sessionId: p.sessionId ?? null, commands: effectiveEngine !== 'codex' });
  const folder = p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : null;

  const submit = () => {
    if (!canSend) return;
    const msg = text.trim() || ATTACHMENT_ONLY_TEXT;
    if (p.busy) p.onQueue?.(msg);
    else p.onSend(msg);
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

  const bgItem = p.items.findLast((it) => it.kind === 'assistant' && (it.background?.length ?? 0) > 0);

  return (
    <main className="chat">
      <div className="chat-head">
        <span className="chat-title" title={p.title}><span>{p.title}</span><span className="caret" aria-hidden="true">⌄</span></span>
        {folder && <span className="folder-chip" title={p.cwd}>{folder}</span>}
        {!p.isNew && p.sessionEngine === 'codex' && <span className="chip sandbox" title="D2: GPT 세션은 승인 카드 대신 샌드박스로 보호됩니다">GPT · 샌드박스: {SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
        <span className="spacer" />
        {p.headActions}
      </div>
      <div className="chat-body">
        {shown.map((it, i) => <MessageView key={i} item={it} cwd={p.cwd} />)}
        {retryPrompt !== null && <button type="button" className="btn ghost retry" onClick={() => p.onSend(retryPrompt)}>재시도</button>}
        {p.pending.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={p.onDecide} />)}
        {p.questions.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={p.onAnswer} />)}
        <div ref={endRef} />
      </div>
      <div className="composer-wrap">
        {bgItem?.kind === 'assistant' && bgItem.turnId && (
          <div className="bg-status" role="status" data-testid="bg-status" title={bgItem.background?.join('\n')}>
            <span className="spark spin" aria-hidden="true">✳</span>
            <span>백그라운드 작업 {bgItem.background?.length}개 진행 중</span>
            {p.onStopBackground && <button type="button" className="btn ghost bg-stop" onClick={() => p.onStopBackground?.(bgItem.turnId!)}>중지</button>}
          </div>
        )}
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {p.queue && p.queue.length > 0 && (
          <QueueChips queue={p.queue} paused={!!p.queuePaused} onEdit={(id, t) => p.onQueueEdit?.(id, t)} onRemove={(id) => p.onQueueRemove?.(id)} onClear={() => p.onQueueClear?.()} onResume={() => p.onQueueResume?.()} />
        )}
        {p.busy && (
          <div className="turn-status" role="status" data-testid="turn-status">
            <span className="spark spin" aria-hidden="true">✳</span>
            <span>{p.activeTurnId ? '실행 중인 작업 1개' : '시작하는 중…'}</span>
            {runMs !== null && <><span className="sep">·</span><span>{elapsed(runMs)}</span></>}
            {liveTools > 0 && <><span className="sep">·</span><span>도구 {liveTools}회</span></>}
          </div>
        )}
        <div className={`composer ${drag ? 'dragover' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          {suggest.popup}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); suggest.track(e); }}
            onSelect={suggest.track}
            onKeyDown={(e) => { if (suggest.onKeyDown(e)) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            onPaste={onPaste}
            placeholder={queueing ? '실행 중 · ⌘/Ctrl+Enter 로 대기열에 추가' : '메시지 입력 · ⌘/Ctrl+Enter 보내기 · @ 파일 · / 명령'}
            aria-label="메시지"
            rows={1}
          />
          <div className="composer-row">
            <AttachmentBar attachments={p.attachments} uploading={uploading} error={error} onFiles={(f) => void addFiles(f)} onRemove={p.onUnattach} />
            <div className="composer-actions">
              {p.isNew && p.codexAvailable && (
                <span className="pick">
                  <select value={p.engine} onChange={(e) => p.onEngine(e.target.value as EngineChoice)} title="이 세션의 엔진 (세션 생성 후 변경 불가)" aria-label="엔진" data-testid="engine-select">
                    <option value="claude">Claude</option>
                    <option value="codex">GPT</option>
                    <option value="auto">자동</option>
                  </select>
                </span>
              )}
              {p.isNew && p.codexAvailable && effectiveEngine !== 'claude' && (
                <span className="pick sandbox">
                  <select value={p.sandbox} onChange={(e) => p.onSandbox(e.target.value as CodexSandbox)} title="GPT 샌드박스 (승인 없음 · 세션 생성 후 변경 불가)" aria-label="샌드박스" data-testid="sandbox-select">
                    {CODEX_SANDBOXES.map((s) => <option key={s} value={s}>{SANDBOX_LABEL[s]}</option>)}
                  </select>
                </span>
              )}
              <ModelPicker models={models} model={p.model} effort={p.effort} onModel={p.onModel} onEffort={p.onEffort} />
              {p.activeTurnId && queueing && hasDraft && <button type="button" className="send queue-add" onClick={submit} title="대기열에 추가 (⌘/Ctrl+Enter)"><span aria-hidden="true">+</span><span className="sr-only">대기열에 추가</span></button>}
              {p.activeTurnId
                ? <button type="button" className="send stop" onClick={p.onInterrupt} title="중단"><i aria-hidden="true" /><span className="sr-only">중단</span></button>
                : <button type="button" className="send" onClick={submit} disabled={!canSend} title="보내기 (⌘/Ctrl+Enter)"><span aria-hidden="true">↑</span><span className="sr-only">보내기</span></button>}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
