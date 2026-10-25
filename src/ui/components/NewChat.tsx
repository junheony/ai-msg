import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SANDBOX, type CodexSandbox, type Effort, type EngineChoice, type ModelChoice } from '../../shared/models';
import type { PermMode } from '../../shared/permission';
import type { GeminiStatus, GrokStatus, SessionActivity } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import type { ProjectEntry } from '../../shared/session-types';
import type { PendingPermission, PendingQuestion, UploadedAttachment } from '../state';
import { ATTACHMENT_ONLY_TEXT, filesFrom, replaceAttachment, uploadFile, usePasteUploads, type UploadFn } from '../upload';
import { AttachmentBar } from './AttachmentBar';
import { Composer } from './Composer';
import { SessionChip } from './SessionChip';
import { EngineBadge, EngineMark, engineOf } from './EngineMark';
import { BrandMark } from './BrandMark';
import { has } from '../features';
import { modelChoices, touchEnterIsNewline } from './Chat';
import { PinIcon } from './icons';
import { useAutoGrow } from '../useAutoGrow';
import { clearDraft, loadDraft, saveDraft } from '../drafts';
import { isMacPlatform } from '../shortcuts';
import { usePrefs } from '../usePrefs';
import { FolderPicker } from './FolderPicker';
import { ui } from '../i18n';
import { agoParts } from '../home';
import { HomeFrame, homeGreeting, type HomeData } from './HomeBoard';

const RECENT_CARDS = 10;
const baseName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

export const greeting = homeGreeting;

function ago(ms: number, now = Date.now()): string {
  const p = agoParts(ms, now);
  const t = ui().home.ago;
  return t[p.unit === 'now' ? 'minutes' : p.unit](Math.max(1, p.n));
}

/** The home's extra store slices (Pane passes them only to a single docked pane): absent = the plain new-chat screen. */
export type NewChatHome = {
  activity: readonly SessionActivity[];
  unread: readonly string[];
  pending: readonly PendingPermission[];
  questions: readonly PendingQuestion[];
  usage: UsageSnapshot | null;
  onMarkRead?: (sessionIds: string[]) => void;
  /** A render fixture's data (no fetch). */
  data?: HomeData;
};

/** The engine and sandbox the new session opens with (D3: the engine is fixed once it exists; a GPT sandbox can change later). */
export type NewChatOptions = { engine: EngineChoice; sandbox: CodexSandbox };

/**
 * The empty pane, Desktop-style: greeting, the same composer card as a chat (session chip — folder, engine, model —
 * above the auto-growing text; [+] · mic · ↑ in its bottom row), the pinned sessions (pin order) and the latest others as compact cards. Everything is reachable here, so the phone does not need
 * the drawer to start or resume. Attachments upload as soon as they are picked and ride the first message.
 */
export function NewChat({ projects, pins = [], defaultCwd, onStart, onStartSplit, onOpenSession, now, uploadFn, models, model = 'auto', effort = null, onModel, onEffort, draftKey = 'new', engine: engineProp = 'claude', sandbox: sandboxProp = DEFAULT_SANDBOX, codexAvailable = false, gemini = null, grok = null, onEngine, onSandbox, defaultPerm = null, fetchFn = fetch, loaded = false, home = null }: {
  projects: ProjectEntry[];
  /** The home dashboard (the only, docked pane): lists, providers and usage around the composer. */
  home?: NewChatHome | null;
  /** No projects yet (first run): 폴더 고르기 (FolderPicker) and the home folder lookup go through this. */
  fetchFn?: typeof fetch;
  /** The server's project list has arrived (hello): until then an empty list says nothing, so no first-run screen. */
  loaded?: boolean;
  /** The server's default permission mode for a new session (the chip's read-only tail; null = unknown, no tail). */
  defaultPerm?: PermMode | null;
  /** Pinned session ids in pin order (AppState.pins): shown above 최근 대화 and left out of it. */
  pins?: string[];
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
  const recent = live.filter((r) => !pinSet.has(r.s.sessionId)).slice(0, RECENT_CARDS);
  const t = now ?? Date.now();

  // Auto-grow: the card follows the text up to the CSS max-height, then the textarea scrolls.
  useAutoGrow(taRef, text);
  // Unsent picks: their local previews are released with the screen (a sent turn shows the server copy).
  const unsent = useRef(attachments);
  unsent.current = attachments;
  useEffect(() => () => { for (const a of unsent.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); }, []);

  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  // First run (no projects): the composer starts in the home folder; 폴더 고르기 opens a session in a picked one.
  // Only once the list has arrived (an existing user's list is [] until then); a later reconnect does not undo it.
  const listSeen = useRef(false);
  if (loaded) listSeen.current = true;
  const firstRun = listSeen.current && projects.length === 0;
  // Read at the start, not at the press: the home lookup is async and the text / picks may grow while it runs.
  const textNow = useRef(text);
  textNow.current = text;
  const attachmentsNow = useRef(attachments);
  attachmentsNow.current = attachments;
  const uploadingNow = useRef(uploading);
  uploadingNow.current = uploading;
  const [picking, setPicking] = useState(false);
  const [homeBusy, setHomeBusy] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  const canStart = (firstRun || !!project) && uploading === 0 && !homeBusy;
  const [{ sendKey }] = usePrefs();
  /** Opens the new session in `dir` with whatever is typed (an empty text opens it empty: a picked folder). */
  const begin = (dir: string, name: string, split: boolean) => {
    const text = textNow.current;
    const attachments = attachmentsNow.current;
    const msg = text.trim() || (attachments.length ? ATTACHMENT_ONLY_TEXT : '');
    clearDraft(draftKey);
    if (split && onStartSplit) {
      // This screen stays: the text and the picks (their previews now ride the new pane) leave it.
      setText('');
      setAttachments([]);
      onStartSplit(dir, name, msg, attachments, { engine, sandbox });
      return;
    }
    onStart(dir, name, msg, attachments, { engine, sandbox });
  };
  /** The home folder's real path (read-only /api/dirs), then the start there. */
  const startHome = async (split: boolean) => {
    setHomeBusy(true);
    setHomeError(null);
    try {
      const res = await fetchFn(`/api/dirs?path=${encodeURIComponent('~')}`, { credentials: 'same-origin' });
      const home = res.ok ? ((await res.json()) as { path?: string }).path : undefined;
      // While it was looked up the text may have been cleared (nothing to send: stay), or a pick may still be
      // uploading (it would be left out: stay; the user sends again once it is done).
      const drafted = textNow.current.trim().length > 0 || attachmentsNow.current.length > 0;
      if (!home) setHomeError(ui().chat.newChat.homeFailed);
      else if (drafted && uploadingNow.current === 0) begin(home, baseName(home), split);
    } catch {
      setHomeError(ui().chat.newChat.homeFailed);
    } finally {
      setHomeBusy(false);
    }
  };
  // ↑ / Enter in the text needs something to send (C-2); Enter on the 프로젝트 picker still opens an empty session there.
  const start = (split = false, empty = false) => {
    if (!canStart || (!hasDraft && !empty)) return;
    if (firstRun) { void startHome(split); return; }
    if (project) begin(project.cwd, project.name, split);
  };
  /**
   * Enter in the composer or on the 프로젝트 picker: start here; ⌘Enter (Ctrl elsewhere): in a new split pane — unless
   * ⌘Enter is the send key (설정), then it starts here as it always did. ⌘⇧Enter is the global 패널 최대화.
   */
  const startKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; keyCode: number; nativeEvent: { isComposing: boolean }; preventDefault: () => void }, plainEnter: boolean, empty = false): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey) return;
    if (!mod && !plainEnter) return;
    e.preventDefault();
    start(mod && sendKey !== 'mod-enter' && (isMacPlatform() ? e.metaKey : e.ctrlKey), empty);
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
  const card = ({ s, name }: (typeof live)[number], open: NonNullable<typeof onOpenSession>, pin: boolean) => (
    <button type="button" key={s.sessionId} className="newchat-card" title={`${s.title}\n${s.cwd}`} onClick={() => open(s.sessionId, s.cwd, s.title)}>
      <span className="newchat-card-title">{pin && <span className="newchat-card-pin"><PinIcon filled /></span>}<EngineMark engine={engineOf(s)} decorative />{s.title}</span>
      <span className="newchat-card-meta">{name} · {ago(s.lastModified, t)}</span>
    </button>
  );
  const sendLabel = ui().chat.newChat.send;

  const firstSection = firstRun && (
    <section className="newchat-first" aria-label={ui().chat.newChat.firstLabel} data-testid="newchat-first">
      <p className="newchat-first-intro">{ui().chat.newChat.intro}</p>
      {picking
        ? <FolderPicker fetchFn={fetchFn} onOpen={(dir) => { setPicking(false); begin(dir, baseName(dir), false); }} onClose={() => setPicking(false)} />
        : <button type="button" className="btn primary newchat-pick" data-testid="newchat-pick" onClick={() => setPicking(true)}>{ui().chat.newChat.pick}</button>}
      <p className="newchat-first-or muted">{ui().chat.newChat.orHome}</p>
      {homeError && <p className="error" role="alert">{homeError}</p>}
    </section>
  );
  const pickEngine = (v: EngineChoice) => { setEngine(v); onEngine?.(v); };
  const form = (
    <form className="newchat-box" onSubmit={(e) => { e.preventDefault(); start(); }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const files = filesFrom(e.dataTransfer); if (files.length) void addFiles(files); }}>
      {home && engineSelect && <EngineChips value={engine} codexAvailable={codexAvailable} gemini={gemini} grok={grok} onPick={pickEngine} />}
      <Composer
        dragover={drag}
        chip={(
          <SessionChip
            isNew
            defaultPerm={defaultPerm}
            folder={firstRun ? ui().chat.newChat.home : project?.name ?? null}
            folderPicker={firstRun ? undefined : (
              <label className="ss-project" title={cwd ?? ''}>
                <span className="sr-only">프로젝트</span>
                <select value={cwd ?? ''} onChange={(e) => setPicked(e.target.value)} onKeyDown={(e) => startKey(e, !e.shiftKey && !e.altKey, true)} aria-label="프로젝트">
                  {pinned.length > 0 && <optgroup label="고정">{pinned.map(option)}</optgroup>}
                  {others.length > 0 && <optgroup label="최근">{others.map(option)}</optgroup>}
                </select>
              </label>
            )}
            engine={engine}
            engines={{ codexAvailable, gemini, grok, onEngine: pickEngine }}
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
        action={<button type="submit" className="send" disabled={!canStart || !hasDraft} title={sendLabel} aria-label={sendLabel}><span aria-hidden="true">↑</span></button>}
      >
        <textarea ref={taRef} value={text} onChange={(e) => edit(e.target.value)} rows={2} placeholder="무엇을 도와드릴까요?" aria-label="첫 메시지"
          name="deck-message" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="" data-lpignore="true"
          onPaste={onPaste}
          onKeyDown={(e) => startKey(e, !e.shiftKey && !e.altKey && !touchEnterIsNewline())} />
      </Composer>
    </form>
  );

  if (home) {
    return (
      <HomeFrame home={home} projects={projects} pins={pins} now={t} fetchFn={fetchFn} onOpenSession={onOpenSession}
        codexAvailable={codexAvailable} gemini={gemini} grok={grok} first={firstSection} form={form} />
    );
  }

  return (
    <div className="newchat">
      <div className="newchat-inner">
        <h1 className="newchat-greeting"><BrandMark className="spark" />{greeting(new Date(t).getHours())}</h1>
        {firstSection}
        {form}
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

const CHIP_NAME: Record<Exclude<EngineChoice, 'auto'>, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok' };

/**
 * The home's engine row: one tap picks the new session's engine (the session chip keeps the same choice, and the
 * sandbox). Same availability rules as SessionChip: Gemini needs a login, Grok needs its CLI, 자동 needs Codex.
 */
function EngineChips({ value, codexAvailable, gemini, grok, onPick }: { value: EngineChoice; codexAvailable: boolean; gemini: GeminiStatus | null; grok: GrokStatus | null; onPick: (e: EngineChoice) => void }) {
  const h = ui().home;
  const geminiReady = !!gemini && (gemini.loggedIn.g1 || gemini.loggedIn.g2);
  const grokReady = has('grok');
  const options: { v: EngineChoice; label: string; disabled?: boolean; title?: string }[] = [
    { v: 'claude', label: CHIP_NAME.claude },
    ...(codexAvailable ? [{ v: 'codex' as const, label: CHIP_NAME.codex }] : []),
    ...(gemini?.available ? [{ v: 'gemini' as const, label: CHIP_NAME.gemini, disabled: !geminiReady, ...(geminiReady ? {} : { title: h.engineNeedsLogin(CHIP_NAME.gemini) }) }] : []),
    ...(grokReady || grok ? [{ v: 'grok' as const, label: CHIP_NAME.grok, disabled: !grokReady, ...(grokReady ? {} : { title: h.engineNeedsInstall(CHIP_NAME.grok) }) }] : []),
    ...(codexAvailable ? [{ v: 'auto' as const, label: h.engineAuto }] : []),
  ];
  return (
    <div className="home-engines" role="radiogroup" aria-label={h.engineLabel}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={`home-engine${value === o.v ? ' on' : ''}`}
          disabled={o.disabled} title={o.title} onClick={() => onPick(o.v)}>
          {o.v === 'auto' ? <span className="home-engine-auto" aria-hidden="true">✦</span> : <EngineBadge engine={o.v} className="home-engine-badge" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
