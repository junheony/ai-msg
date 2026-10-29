import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_SANDBOX, type CodexSandbox, type Effort, type EngineChoice, type ModelChoice } from '../../shared/models';
import type { PermMode } from '../../shared/permission';
import type { GeminiStatus, GrokStatus } from '../../shared/protocol';
import type { ProjectEntry } from '../../shared/session-types';
import type { UploadedAttachment } from '../state';
import { ATTACHMENT_ONLY_TEXT, filesFrom, replaceAttachment, uploadFile, usePasteUploads, type UploadFn } from '../upload';
import { AttachmentBar } from './AttachmentBar';
import { Composer } from './Composer';
import { SessionChip } from './SessionChip';
import { ClaudeMark, EngineMark, engineOf } from './EngineMark';
import { has } from '../features';
import { modelChoices, touchEnterIsNewline } from './Chat';
import { PinIcon } from './icons';
import { AvatarFace, avatarIndex, monogram } from './SessionIcon';
import { isAutomatedSession } from '../sessionFilters';
import { useAutoGrow } from '../useAutoGrow';
import { clearDraft, loadDraft, saveDraft } from '../drafts';
import { isMacPlatform } from '../shortcuts';
import { usePrefs } from '../usePrefs';

const RECENT_CARDS = 10;

/** One-line card preview: fences and inline code drop out so a reply that is mostly CSS does not fill the row. */
function cardPreview(raw: string | undefined): string {
  if (!raw) return '';
  const t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 96 ? `${t.slice(0, 95)}…` : t;
}

/** Fills the composer. The first message still starts the session the same way. */
const QUICK_STARTS = [
  { label: '코드 리뷰', text: '이 변경을 짧게 리뷰해 줘. 위험과 빠진 테스트만 말해 줘.' },
  { label: '버그 찾기', text: '막힌 지점을 찾고, 고치기 전에 원인부터 말해 줘.' },
  { label: '짧게 정리', text: '지금까지를 세 줄로 정리해 줘.' },
] as const;

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return '좋은 아침이에요';
  if (hour >= 11 && hour < 17) return '좋은 오후예요';
  if (hour >= 17 && hour < 22) return '좋은 저녁이에요';
  return '늦은 시간까지 수고 많아요';
}

function ago(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}분 전`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
  return `${Math.floor(d / 86_400_000)}일 전`;
}

/** The engine and sandbox the new session opens with (D3: the engine is fixed once it exists; a GPT sandbox can change later). */
export type NewChatOptions = { engine: EngineChoice; sandbox: CodexSandbox };

/**
 * The empty pane, Desktop-style: greeting, the same composer card as a chat (session chip — folder, engine, model —
 * above the auto-growing text; [+] · mic · ↑ in its bottom row), the pinned sessions (pin order) and the latest others as compact cards. Everything is reachable here, so the phone does not need
 * the drawer to start or resume. Attachments upload as soon as they are picked and ride the first message.
 */
export function NewChat({ projects, pins = [], sessionIcons = {}, defaultCwd, onStart, onStartSplit, onOpenSession, now, uploadFn, models, model = 'auto', effort = null, onModel, onEffort, draftKey = 'new', engine: engineProp = 'claude', sandbox: sandboxProp = DEFAULT_SANDBOX, codexAvailable = false, gemini = null, grok = null, onEngine, onSandbox, defaultPerm = null }: {
  projects: ProjectEntry[];
  /** The server's default permission mode for a new session (the chip's read-only tail; null = unknown, no tail). */
  defaultPerm?: PermMode | null;
  /** Pinned session ids in pin order (AppState.pins): shown above 최근 대화 and left out of it. */
  pins?: string[];
  /** 직접 고른 세션 아이콘 (session id → icon). The home cards use the same face as the sidebar. */
  sessionIcons?: Record<string, string>;
  /** Preselected project (the pane's last one); falls back to the first listed. */
  defaultCwd?: string | null;
  /** Opens a new session in `cwd`; non-empty `text` is sent as its first message, with `attachments`. */
  onStart: (cwd: string, name: string, text: string, attachments: UploadedAttachment[], options: NewChatOptions) => void;
  /** ⌘Enter (Ctrl elsewhere): the same start, in a new split pane; this screen stays, emptied. */
  onStartSplit?: (cwd: string, name: string, text: string, attachments: UploadedAttachment[], options: NewChatOptions) => void;
  onOpenSession?: (sessionId: string, cwd: string, title: string) => void;
  now?: number;
  uploadFn?: UploadFn;
  /** The pane's model and effort (the session chip's sheet): the new session's first turn uses them. */
  models?: readonly ModelChoice[];
  model?: ModelChoice;
  effort?: Effort | null;
  onModel?: (m: ModelChoice) => void;
  onEffort?: (e: Effort | null) => void;
  /** Where the unsent text is kept (see drafts.ts); one per pane, e.g. newChatDraftKey(pane.id). */
  draftKey?: string;
  /** The pane's engine/sandbox the pickers start from (a new session follows the picker, as in Chat). */
  engine?: EngineChoice;
  sandbox?: CodexSandbox;
  /** The engine picker appears only when another engine than Claude is available (same rule as Chat). */
  codexAvailable?: boolean;
  gemini?: GeminiStatus | null;
  /** hello.grok; null = an older server that knows no Grok: no Grok option. Known but no CLI: shown disabled (설치 필요). */
  grok?: GrokStatus | null;
  /** Mirrors a pick to the pane (so its model picker lists the picked engine's models). */
  onEngine?: (engine: EngineChoice) => void;
  onSandbox?: (sandbox: CodexSandbox) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [engine, setEngine] = useState<EngineChoice>(engineProp);
  const [sandbox, setSandbox] = useState<CodexSandbox>(sandboxProp);
  // Follow the pane when it changes the choice itself (e.g. its own picker or a restored pane state).
  useEffect(() => setEngine(engineProp), [engineProp]);
  useEffect(() => setSandbox(sandboxProp), [sandboxProp]);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const onUploaded = useCallback((a: UploadedAttachment) => setAttachments((all) => (all.some((x) => x.id === a.id) ? all : [...all, a])), []);
  const { addFiles, onPaste, uploading, error, pastedTexts, uploadOne } = usePasteUploads({ uploadFn: uploadFn ?? uploadFile, attachments, onUploaded, onUploadFailed: (t) => setText((v) => { const nv = v + t; saveDraft(draftKey, nv); return nv; }) });
  const cwd = picked ?? (defaultCwd && projects.some((p) => p.cwd === defaultCwd) ? defaultCwd : projects[0]?.cwd ?? null);
  const project = projects.find((p) => p.cwd === cwd) ?? null;
  const pinned = projects.filter((p) => p.pinned);
  const others = projects.filter((p) => !p.pinned);
  const live = projects.flatMap((p) => p.sessions.map((s) => ({ s, name: p.name }))).filter(({ s }) => !s.archived)
    .sort((a, b) => b.s.lastModified - a.s.lastModified)
    .filter((r, i, all) => all.findIndex((x) => x.s.sessionId === r.s.sessionId) === i);
  const pinnedCards = [...new Set(pins)].flatMap((id) => live.find((r) => r.s.sessionId === id) ?? []);
  const pinSet = new Set(pins);
  const recent = live.filter((r) => !pinSet.has(r.s.sessionId) && !isAutomatedSession(r.s)).slice(0, RECENT_CARDS);
  const t = now ?? Date.now();

  // Auto-grow: the card follows the text up to the CSS max-height, then the textarea scrolls.
  useAutoGrow(taRef, text);
  // Unsent picks: their local previews are released with the screen (a sent turn shows the server copy).
  const unsent = useRef(attachments);
  unsent.current = attachments;
  useEffect(() => () => { for (const a of unsent.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); }, []);

  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const canStart = !!project && uploading === 0;
  const [{ sendKey }] = usePrefs();
  const start = (split = false) => {
    if (!project || !canStart) return;
    const msg = text.trim() || (attachments.length ? ATTACHMENT_ONLY_TEXT : '');
    clearDraft(draftKey);
    if (split && onStartSplit) {
      // This screen stays: the text and the picks (their previews now ride the new pane) leave it.
      setText('');
      setAttachments([]);
      onStartSplit(project.cwd, project.name, msg, attachments, { engine, sandbox });
      return;
    }
    onStart(project.cwd, project.name, msg, attachments, { engine, sandbox });
  };
  /**
   * Enter in the composer or on the 프로젝트 picker: start here; ⌘Enter (Ctrl elsewhere): in a new split pane — unless
   * ⌘Enter is the send key (설정), then it starts here as it always did. ⌘⇧Enter is the global 패널 최대화.
   */
  const startKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; keyCode: number; nativeEvent: { isComposing: boolean }; preventDefault: () => void }, plainEnter: boolean): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey) return;
    if (!mod && !plainEnter) return;
    e.preventDefault();
    start(mod && sendKey !== 'mod-enter' && (isMacPlatform() ? e.metaKey : e.ctrlKey));
  };
  const edit = (v: string) => { setText(v); saveDraft(draftKey, v); };
  // The sandbox row follows the engine picker (shown only when another engine than Claude is available).
  const engineSelect = codexAvailable || !!gemini?.available || has('grok');
  const remove = (id: string) => setAttachments((all) => {
    const url = all.find((a) => a.id === id)?.previewUrl;
    if (url) URL.revokeObjectURL(url);
    return all.filter((a) => a.id !== id);
  });
  const replace = (old: UploadedAttachment, f: File) =>
    replaceAttachment(old, f, uploadOne, () => unsent.current, (a) => setAttachments((all) => all.map((x) => (x.id === old.id ? a : x))));
  const option = (p: ProjectEntry) => <option key={p.cwd} value={p.cwd}>{p.name}</option>;
  const card = ({ s, name }: (typeof live)[number], open: NonNullable<typeof onOpenSession>, pin: boolean) => {
    const color = avatarIndex(name);
    const preview = cardPreview(s.preview);
    return (
      <button type="button" key={s.sessionId} className="newchat-card" title={`${s.title}\n${s.cwd}`} onClick={() => open(s.sessionId, s.cwd, s.title)}>
        <span className="newchat-card-avatar" data-avatar={color} style={{ '--av': `var(--avatar-${color})` } as CSSProperties} aria-hidden="true">
          <AvatarFace mono={monogram(s.title, name)} icon={sessionIcons[s.sessionId] ?? null} title={s.title} />
        </span>
        <span className="newchat-card-body">
          <span className="newchat-card-title">{pin && <span className="newchat-card-pin"><PinIcon filled /></span>}<EngineMark engine={engineOf(s)} decorative />{s.title}</span>
          {preview && <span className="newchat-card-preview">{preview}</span>}
          <span className="newchat-card-meta">{name} · {ago(s.lastModified, t)}</span>
        </span>
      </button>
    );
  };
  const sendLabel = hasDraft ? '보내기 — 새 대화로 시작 (Enter)' : '빈 새 대화 열기';

  return (
    <div className="newchat">
      <div className="newchat-inner">
        <h1 className="newchat-greeting"><ClaudeMark className="spark" />{greeting(new Date(t).getHours())}</h1>
        {projects.length === 0 ? (
          <p className="muted">프로젝트가 없습니다. 사이드바의 폴더 열기로 시작하거나 ~/.config/deck/projects.json 에 고정 프로젝트를 적어두세요.</p>
        ) : (
          <form className="newchat-box" onSubmit={(e) => { e.preventDefault(); start(); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const files = filesFrom(e.dataTransfer); if (files.length) void addFiles(files); }}>
            <Composer
              dragover={drag}
              chip={(
                <SessionChip
                  isNew
                  defaultPerm={defaultPerm}
                  folder={project?.name ?? null}
                  folderPicker={(
                    <label className="ss-project" title={cwd ?? ''}>
                      <span className="sr-only">프로젝트</span>
                      <select value={cwd ?? ''} onChange={(e) => setPicked(e.target.value)} onKeyDown={(e) => startKey(e, !e.shiftKey && !e.altKey)} aria-label="프로젝트">
                        {pinned.length > 0 && <optgroup label="고정">{pinned.map(option)}</optgroup>}
                        {others.length > 0 && <optgroup label="최근">{others.map(option)}</optgroup>}
                      </select>
                    </label>
                  )}
                  engine={engine}
                  engines={{ codexAvailable, gemini, grok, onEngine: (v) => { setEngine(v); onEngine?.(v); } }}
                  sandbox={engineSelect ? { value: sandbox, onChange: (v) => { setSandbox(v); onSandbox?.(v); } } : null}
                  models={models ?? modelChoices(engine)} model={model} effort={effort} onModel={(m) => onModel?.(m)} onEffort={(e) => onEffort?.(e)}
                />
              )}
              files={(attachments.length > 0 || uploading > 0 || error)
                ? <AttachmentBar attachments={attachments} uploading={uploading} error={error} onRemove={remove} onReplace={replace} pastedTexts={pastedTexts} />
                : null}
              onFiles={(f) => void addFiles(f)}
              text={text}
              onText={edit}
              action={<button type="submit" className="send" disabled={!canStart} title={sendLabel} aria-label={sendLabel}><span aria-hidden="true">↑</span></button>}
            >
              <textarea ref={taRef} value={text} onChange={(e) => edit(e.target.value)} rows={2} placeholder="무엇을 도와드릴까요?" aria-label="첫 메시지"
                name="deck-message" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="" data-lpignore="true"
                onPaste={onPaste}
                onKeyDown={(e) => startKey(e, !e.shiftKey && !e.altKey && !touchEnterIsNewline())} />
            </Composer>
          </form>
        )}
        {projects.length > 0 && (
          <div className="newchat-quick" role="group" aria-label="빠른 시작">
            {QUICK_STARTS.map((q) => (
              <button type="button" key={q.label} className="newchat-quick-btn" onClick={() => { edit(q.text); taRef.current?.focus(); }}>{q.label}</button>
            ))}
          </div>
        )}
        {pinnedCards.length > 0 && onOpenSession && (
          <section className="newchat-recent newchat-pinned" aria-label="고정된 대화">
            <h2 className="muted">고정됨</h2>
            <div className="newchat-cards">{pinnedCards.map((r) => card(r, onOpenSession, true))}</div>
          </section>
        )}
        {recent.length > 0 && onOpenSession && (
          <section className="newchat-recent" aria-label="최근 대화">
            <h2 className="muted">최근 대화</h2>
            <div className="newchat-cards">{recent.map((r) => card(r, onOpenSession, false))}</div>
          </section>
        )}
      </div>
    </div>
  );
}
