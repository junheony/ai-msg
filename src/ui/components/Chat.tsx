import { loadDraft, saveDraft } from '../autoReload';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CLAUDE_MODELS, CODEX_MODELS, CODEX_SANDBOXES, GEMINI_MODELS, GEMINI_SANDBOX_LABEL, SANDBOX_LABEL, type CodexSandbox, type Effort, type EngineChoice, type EngineKind, type ModelChoice } from '../../shared/models';
import type { Account, Seat } from '../../shared/accounts';
import type { GeminiStatus } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { PermissionDecision, QuestionAnswers, TurnPhase } from '../../shared/turn-types';
import type { AgentInfo, ChatItem, PaneBackground, PendingPermission, PendingQuestion, QueueItem, UploadedAttachment } from '../state';
import { latestContext } from '../context';
import { latestTodos } from '../todos';
import { useStickToBottom } from '../stickToBottom';
import { mergeToolRuns } from '../toolRuns';
import { filesFrom, uploadFile, useUploads, type UploadFn } from '../upload';
import { AgentContext, BackgroundPill, StatusRow, type AgentCtx } from './Activity';
import { AccountPicker } from './AccountPicker';
import { AttachmentBar } from './AttachmentBar';
import { ContextGauge, ContextHint } from './ContextGauge';
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
  /** null = no gemini-cli: no Gemini option. Not logged in: the option is shown disabled with 로그인 필요. */
  gemini?: GeminiStatus | null;
  attachments: UploadedAttachment[];
  uploadFn?: UploadFn;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** Stops the background work held by that turn's process (interrupt by its turn id). */
  onStopBackground?: (turnId: string) => void;
  /** Stops one background task (Query.stopTask). */
  onStopTask?: (taskId: string) => void;
  /** Status row: when the running turn started (client clock), its output tokens and phase. */
  runStartedAt?: number | null;
  progress?: { outputTokens: number; phase: TurnPhase } | null;
  /** Subagent cards by Agent call id; the background pill. */
  agents?: Record<string, AgentInfo>;
  bg?: PaneBackground | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
  onEngine: (e: EngineChoice) => void;
  onSandbox: (s: CodexSandbox) => void;
  onAttach: (a: UploadedAttachment) => void;
  onUnattach: (id: string) => void;
  /** 이 세션은 B 써 (Claude sessions): the pinned account (null = 자동), the account it runs on, usage for the menu. */
  accountPin?: Account | null;
  account?: Seat | null;
  usage?: UsageSnapshot | null;
  /** Absent = no account picker. */
  onAccountPin?: (pin: Account | null) => void;
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

/** Enter inserts a newline on touch screens (send with the button), as on Desktop's mobile apps. */
const COARSE_QUERY = '(pointer: coarse), (hover: none)';
function useCoarsePointer(): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
  const [coarse, setCoarse] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(COARSE_QUERY);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

const NO_AGENTS: Record<string, AgentInfo> = {};

export function Chat(p: ChatProps) {
  const [text, setText] = useState(() => loadDraft(p.sessionId));
  // The pane switched sessions: show that session's draft, not the previous one's. Done during render so the save
  // effect below never writes the old text under the new id. A new session getting its id (null → id) keeps the text.
  const [draftId, setDraftId] = useState(p.sessionId);
  if (draftId !== p.sessionId) {
    setDraftId(p.sessionId);
    if (draftId) setText(loadDraft(p.sessionId));
  }
  useEffect(() => { saveDraft(p.sessionId, text); }, [p.sessionId, text]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const content = useMemo(() => ({}), [p.items, p.pending, p.questions]);
  const scroll = useStickToBottom(bodyRef, content, p.sessionId);
  const { addFiles, uploading, error } = useUploads({ uploadFn: p.uploadFn ?? uploadFile, current: p.attachments.length, onUploaded: p.onAttach });
  const coarse = useCoarsePointer();
  // Set between compositionstart/end: some browsers report isComposing late or not at all.
  const composing = useRef(false);
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
  // 자동 is offered for Claude (and the engine 자동, which may open on Claude); on an existing session it keeps the session's model.
  // Gemini is explicit only: its models appear only when the Gemini engine is picked (never under 자동).
  const models: readonly ModelChoice[] = effectiveEngine === 'gemini' ? GEMINI_MODELS : effectiveEngine === 'codex' ? CODEX_MODELS : effectiveEngine === 'claude' ? ['auto', ...CLAUDE_MODELS] : ['auto', ...CLAUDE_MODELS, ...CODEX_MODELS];
  const geminiReady = !!p.gemini && (p.gemini.loggedIn.g1 || p.gemini.loggedIn.g2);
  const engineSelect = p.isNew && (p.codexAvailable || !!p.gemini?.available);
  const sandboxLabel = effectiveEngine === 'gemini' ? GEMINI_SANDBOX_LABEL : SANDBOX_LABEL;
  const hasDraft = (text.trim().length > 0 || p.attachments.length > 0) && uploading === 0;
  const queueing = p.busy && !!p.onQueue;
  const canSend = hasDraft && (!p.busy || queueing);
  const live = last?.kind === 'assistant' && last.streaming ? last : null;
  const agents = p.agents ?? NO_AGENTS;
  const bgLive = !!p.bg;
  const turnActive = p.activeTurnId !== null;
  const agentCtx = useMemo<AgentCtx>(() => ({ agents, bgLive, active: turnActive }), [agents, bgLive, turnActive]);
  const suggest = useComposerSuggest({ text, setText, textareaRef: taRef, cwd: p.cwd, sessionId: p.sessionId ?? null, commands: effectiveEngine !== 'codex' });
  const ctx = useMemo(() => latestContext(p.items), [p.items]);
  const folder = p.cwd ? (p.cwd.split('/').filter(Boolean).pop() ?? p.cwd) : null;

  const submit = () => {
    if (!canSend) return;
    const msg = text.trim() || ATTACHMENT_ONLY_TEXT;
    if (p.busy) p.onQueue?.(msg);
    else p.onSend(msg);
    setText('');
    scroll.attach();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest.onKeyDown(e)) return;
    // IME: never act on a key that is still part of a composition (Korean/Japanese/Chinese input). keyCode 229 is
    // Safari's Enter that commits the syllable (fired after compositionend with isComposing false). Chrome's own Enter
    // after the commit is a real Enter and sends the full text.
    const ime = e.nativeEvent.isComposing || e.keyCode === 229 || composing.current;
    if (ime) return;
    if (e.key === 'Escape') {
      if (p.activeTurnId) { e.preventDefault(); p.onInterrupt(); }
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && e.currentTarget.selectionStart === 0 && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Recall: the last queued message comes back for editing; otherwise the last sent one.
      const queued = p.queue?.at(-1);
      const sent = [...p.items].reverse().find((it) => it.kind === 'user') as Extract<ChatItem, { kind: 'user' }> | undefined;
      const recall = queued?.text ?? sent?.text;
      if (!recall) return;
      e.preventDefault();
      if (queued) p.onQueueRemove?.(queued.id);
      setText(recall);
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    if (e.shiftKey || e.altKey || coarse) return;
    e.preventDefault();
    submit();
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
        {!p.isNew && p.sessionEngine === 'gemini' && <span className="chip sandbox" title="Gemini 세션은 승인 카드 대신 승인 모드와 샌드박스로 보호됩니다">Gemini · {GEMINI_SANDBOX_LABEL[p.sessionSandbox ?? 'read-only']}</span>}
        <span className="spacer" />
        {p.headActions}
      </div>
      <div className="chat-body" ref={bodyRef}>
        <AgentContext.Provider value={agentCtx}>
          {shown.map((it, i) => <MessageView key={i} item={it} cwd={p.cwd} />)}
        </AgentContext.Provider>
        {retryPrompt !== null && <button type="button" className="btn ghost retry" onClick={() => { p.onSend(retryPrompt); scroll.attach(); }}>재시도</button>}
        {p.pending.map((r) => <PermissionCard key={r.requestId} req={r} onDecide={p.onDecide} />)}
        {p.questions.map((q) => <QuestionCard key={q.requestId} req={q} onAnswer={p.onAnswer} />)}
      </div>
      {scroll.detached && (
        <div className="jump-anchor">
          <button type="button" className={`jump-bottom ${scroll.unread ? 'unread' : ''}`} onClick={scroll.attach} title="맨 아래로" data-testid="jump-bottom">
            <span aria-hidden="true">↓</span>{scroll.unread ? ' 새 메시지' : <span className="sr-only">맨 아래로</span>}
          </button>
        </div>
      )}
      <div className="composer-wrap">
        {todos && todos.length > 0 && <TodoPanel todos={todos} />}
        {p.queue && p.queue.length > 0 && (
          <QueueChips queue={p.queue} paused={!!p.queuePaused} onEdit={(id, t) => p.onQueueEdit?.(id, t)} onRemove={(id) => p.onQueueRemove?.(id)} onClear={() => p.onQueueClear?.()} onResume={() => p.onQueueResume?.()} />
        )}
        {(p.busy || p.bg) && (
          <div className="activity-bar">
            {p.busy ? <StatusRow startedAt={p.runStartedAt ?? null} started={!!p.activeTurnId} progress={p.progress ?? null} live={live} onInterrupt={p.activeTurnId ? p.onInterrupt : undefined} /> : <span className="spacer" />}
            {p.bg && <BackgroundPill bg={p.bg} onStopTask={p.onStopTask} onStopAll={() => p.onStopBackground?.(p.bg!.turnId)} />}
          </div>
        )}
        {!p.busy && <ContextHint info={ctx} />}
        <div className={`composer ${drag ? 'dragover' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          {suggest.popup}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => { setText(e.target.value); suggest.track(e); }}
            onSelect={suggest.track}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onPaste={onPaste}
            placeholder={queueing ? (coarse ? '실행 중 · 보내면 대기열에 추가' : '실행 중 · Enter 로 대기열에 추가 · Esc 중단') : coarse ? '메시지 입력 · @ 파일 · / 명령' : '메시지 입력 · Enter 로 보내기 · Shift+Enter 줄바꿈'}
            aria-label="메시지"
            rows={1}
          />
          <div className="composer-row">
            <AttachmentBar attachments={p.attachments} uploading={uploading} error={error} onFiles={(f) => void addFiles(f)} onRemove={p.onUnattach} />
            <div className="composer-actions">
              {engineSelect && (
                <span className="pick">
                  <select value={p.engine} onChange={(e) => p.onEngine(e.target.value as EngineChoice)} title="이 세션의 엔진 (세션 생성 후 변경 불가)" aria-label="엔진" data-testid="engine-select">
                    <option value="claude">Claude</option>
                    {p.codexAvailable && <option value="codex">GPT</option>}
                    {p.gemini?.available && <option value="gemini" disabled={!geminiReady} title={geminiReady ? undefined : 'docs/gemini-spike.md 의 로그인 명령을 먼저 실행하세요'}>{geminiReady ? 'Gemini' : 'Gemini · 로그인 필요'}</option>}
                    {p.codexAvailable && <option value="auto">자동</option>}
                  </select>
                </span>
              )}
              {engineSelect && effectiveEngine !== 'claude' && (
                <span className="pick sandbox">
                  <select value={p.sandbox} onChange={(e) => p.onSandbox(e.target.value as CodexSandbox)} title={effectiveEngine === 'gemini' ? 'Gemini 승인 모드 (승인 카드 없음 · 세션 생성 후 변경 불가)' : 'GPT 샌드박스 (승인 없음 · 세션 생성 후 변경 불가)'} aria-label="샌드박스" data-testid="sandbox-select">
                    {CODEX_SANDBOXES.map((s) => <option key={s} value={s}>{sandboxLabel[s]}</option>)}
                  </select>
                </span>
              )}
              <ContextGauge info={ctx} />
              {p.onAccountPin && (effectiveEngine === 'claude' || (p.isNew && effectiveEngine === 'auto')) && (
                <AccountPicker pin={p.accountPin ?? null} current={p.isNew ? null : (p.account ?? null)} usage={p.usage ?? null} onPin={p.onAccountPin} />
              )}
              <ModelPicker models={models} model={p.model} effort={p.effort} onModel={p.onModel} onEffort={p.onEffort} />
              {p.activeTurnId && queueing && hasDraft && <button type="button" className="send queue-add" onClick={submit} title="대기열에 추가 (Enter)"><span aria-hidden="true">+</span><span className="sr-only">대기열에 추가</span></button>}
              {p.activeTurnId
                ? <button type="button" className="send stop" onClick={p.onInterrupt} title="중단"><i aria-hidden="true" /><span className="sr-only">중단</span></button>
                : <button type="button" className="send" onClick={submit} disabled={!canSend} title="보내기 (Enter)"><span aria-hidden="true">↑</span><span className="sr-only">보내기</span></button>}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
