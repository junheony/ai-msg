import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { CLAUDE_MODELS, CODEX_MODELS, CODEX_SANDBOXES, SANDBOX_LABEL, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../../shared/models';
import type { PermissionDecision, QuestionAnswers } from '../../shared/turn-types';
import type { ChatItem, PendingPermission, PendingQuestion, UploadedAttachment } from '../state';
import { mergeToolRuns } from '../toolRuns';
import { filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AttachmentBar } from './AttachmentBar';
import { MessageView } from './MessageView';
import { ModelPicker } from './ModelPicker';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';

export type ChatProps = {
  items: ChatItem[];
  pending: PendingPermission[];
  questions: PendingQuestion[];
  activeTurnId: string | null;
  busy: boolean;
  title: string;
  /** Session folder: the header shows its last segment as a chip, the full path on hover. */
  cwd?: string;
  /** Right-aligned header buttons (the pane's close button). */
  headActions?: ReactNode;
  model: ModelChoice;
  /** Reasoning effort for `model`'s engine; null = 자동 (model 자동 only). */
  effort: Effort | null;
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
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
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
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [p.items, p.pending, p.questions]);
  const { addFiles, uploading, error } = useUploads({ uploadFn: p.uploadFn ?? uploadFile, current: p.attachments.length, onUploaded: p.onAttach });
  const runMs = useElapsed(p.busy);
  const shown = useMemo(() => mergeToolRuns(p.items), [p.items]);

  // Review M12: a failed last turn can be re-sent as-is.
  const last = p.items.at(-1);
  const retryPrompt = !p.busy && last?.kind === 'assistant' && last.error !== null && !last.streaming
    ? ([...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined)?.text ?? null
    : null;

  // D3 / PF11: a new session follows the picker (the engine recorded at open time is ignored while it is new);
  // once the session exists its engine is fixed.
  const effectiveEngine: EngineChoice = p.isNew ? p.engine : (p.sessionEngine ?? 'claude');
  // 자동 is offered for Claude (and the engine 자동, which may open on Claude); on an existing session it keeps the session's model.
  const models: readonly ModelChoice[] = effectiveEngine === 'codex' ? CODEX_MODELS : effectiveEngine === 'claude' ? ['auto', ...CLAUDE_MODELS] : ['auto', ...CLAUDE_MODELS, ...CODEX_MODELS];
  const canSend = (text.trim().length > 0 || p.attachments.length > 0) && !p.busy && uploading === 0;
  const live = last?.kind === 'assistant' && last.streaming ? last : null;
  const liveTools = live ? live.toolCalls.length : 0;
  const folder = p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : null;

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
        <span className="chat-title" title={p.title}><span>{p.title}</span><span className="caret" aria-hidden="true">⌄</span></span>
        {folder && <span className="folder-chip" title={p.cwd}>{folder}</span>}
        {!p.isNew && p.sessionEngine === 'codex' && <span className="chip sandbox" title="D2: GPT 세션은 승인 카드 대신 샌드박스로 보호됩니다">GPT · 샌드박스: {SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
        <span className="spacer" />
        {p.headActions}
      </div>
      <div className="chat-body">
        {shown.map((it, i) => <MessageView key={i} item={it} />)}
        {retryPrompt !== null && <button type="button" className="btn ghost retry" onClick={() => p.onSend(retryPrompt)}>재시도</button>}
        {p.pending.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={p.onDecide} />)}
        {p.questions.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={p.onAnswer} />)}
        <div ref={endRef} />
      </div>
      <div className="composer-wrap">
        {p.busy && (
          <div className="turn-status" role="status" data-testid="turn-status">
            <span className="spark spin" aria-hidden="true">✳</span>
            <span>{p.activeTurnId ? '실행 중인 작업 1개' : '시작하는 중…'}</span>
            {runMs !== null && <><span className="sep">·</span><span>{elapsed(runMs)}</span></>}
            {liveTools > 0 && <><span className="sep">·</span><span>도구 {liveTools}회</span></>}
          </div>
        )}
        <div className={`composer ${drag ? 'dragover' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            onPaste={onPaste}
            placeholder="메시지 입력 · ⌘/Ctrl+Enter 보내기 · 이미지 붙여넣기"
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
