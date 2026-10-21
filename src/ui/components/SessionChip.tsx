import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { CODEX_SANDBOXES, GEMINI_SANDBOX_LABEL, SANDBOX_LABEL, type CodexSandbox, type Effort, type EngineChoice, type ModelChoice } from '../../shared/models';
import type { Account, Seat } from '../../shared/accounts';
import type { GeminiStatus, GrokStatus } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage-types';
import { PERM_MODES, PERM_MODE_LABEL, permModeHint, permModesFor, type PermMode } from '../../shared/permission';
import { contextLabel, type ContextInfo } from '../context';
import { has } from '../features';
import { AccountChipName, AccountMenu, useAccountWords } from './AccountPicker';
import { ContextRing, HandoffButton, contextLevel } from './ContextGauge';
import { Sheet, SheetHead } from './Dialogs';
import { ModelMenu, modelLabel } from './ModelPicker';
import { menuStep } from './SessionMenu';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** ↑/↓ (Home/End) move focus between the items of a role="menu" list inside the sheet (model, account). */
function menuArrows(e: KeyboardEvent<HTMLDivElement>) {
  const active = document.activeElement;
  const menu = active instanceof HTMLElement ? active.closest<HTMLElement>('[role="menu"]') : null;
  if (!menu || !e.currentTarget.contains(menu)) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'));
  const next = menuStep(items.indexOf(active as HTMLElement), e.key, items.length);
  if (next === null) return;
  e.preventDefault();
  items[next]?.focus();
}

/** Tab / Shift+Tab wrap inside the sheet (it is modal). */
function trapTab(e: KeyboardEvent<HTMLDivElement>) {
  menuArrows(e);
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** The chip's compact permission wording. */
export const PERM_MODE_SHORT: Record<PermMode, string> = { default: '묻기', acceptEdits: '편집 승인', plan: '계획', bypassPermissions: '자동 승인' };
const ENGINE_NAME: Record<EngineChoice, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok', auto: '자동' };
/** On the chip an auto engine must not read as a permission mode. */
const ENGINE_CHIP: Record<EngineChoice, string> = { ...ENGINE_NAME, auto: '엔진 자동' };

const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4.5c0-.6.4-1 1-1h3.2l1.4 1.5H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </svg>
);

/**
 * A picker over a native <select>: the visible label is a span (it ellipsizes) and the transparent select on top keeps
 * the native menu, keyboard and accessible name.
 */
function Pick({ className, label, children, ...rest }: { className?: string; label: ReactNode } & Omit<ComponentProps<'select'>, 'className'>) {
  return (
    <span className={`pick ${className ?? ''}`} data-disabled={rest.disabled ? '' : undefined}>
      <span className="pick-label" aria-hidden="true">{label}</span>
      <select {...rest}>{children}</select>
    </span>
  );
}

export type SessionChipProps = {
  /** The session does not exist yet: the chip names folder · engine · permission (or sandbox). */
  isNew: boolean;
  /** The folder's last segment (shown on a new session's chip). */
  folder?: string | null;
  /** 폴더 section content (the new-chat screen's project select). */
  folderPicker?: ReactNode;
  /** The engine the session runs (or will run) on. */
  engine: EngineChoice;
  /** The engine picker (a new session); shown only when another engine than Claude is available. */
  engines?: { codexAvailable: boolean; gemini?: GeminiStatus | null; grok?: GrokStatus | null; onEngine: (e: EngineChoice) => void } | null;
  /** GPT/Gemini sandbox: `onChange` absent = a read-only tag; `existing` = an open GPT session's picker (next turn). */
  sandbox?: { value: CodexSandbox; onChange?: (s: CodexSandbox) => void; existing?: boolean } | null;
  models: readonly ModelChoice[];
  model: ModelChoice;
  effort: Effort | null;
  onModel: (m: ModelChoice) => void;
  onEffort: (e: Effort | null) => void;
  /** 이 세션은 B 써 (absent = no account section). */
  account?: { pin: Account | null; current: Seat | null; usage: UsageSnapshot | null; onPin: (pin: Account | null) => void } | null;
  /** A new session's default permission mode, shown as a read-only tail of the chip (absent = no tail). */
  defaultPerm?: PermMode | null;
  /** Permission mode (absent = no permission section); `supported` false = GPT/Gemini, shown disabled. */
  perm?: { mode: PermMode; supported: boolean; onChange: (m: PermMode) => void } | null;
  ctx?: ContextInfo | null;
  onHandoff?: () => void;
  /** A read-only session: the chip is shown, disabled. */
  disabled?: boolean;
};

/**
 * The composer's one session chip (design §3.4): model · account · permission (a new session: folder · engine ·
 * permission), with the context ring inside. Tapping it opens a sheet (a bottom sheet on a phone) with every choice:
 * folder, engine and sandbox, model and effort, account, permission. A permission change (Shift+Tab) flashes it.
 */
export function SessionChip(p: SessionChipProps) {
  const [open, setOpen] = useState(false);
  // Shift+Tab (or any mode change after the first render): a 150ms flash and a polite announcement.
  const [flash, setFlash] = useState(false);
  const [said, setSaid] = useState('');
  const permMode = p.perm?.mode;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!permMode) return;
    setFlash(true);
    setSaid(`권한: ${PERM_MODE_LABEL[permMode]}`);
    const t = setTimeout(() => setFlash(false), 150);
    return () => clearTimeout(t);
  }, [permMode]);

  const engine = p.engine;
  const gemini = p.engines?.gemini ?? null;
  const geminiReady = !!gemini && (gemini.loggedIn.g1 || gemini.loggedIn.g2);
  const grokReady = has('grok');
  const grokShown = grokReady || !!p.engines?.grok;
  const engineSelect = !!p.engines && (p.engines.codexAvailable || !!gemini?.available || grokReady);
  const sandboxLabel = engine === 'gemini' ? GEMINI_SANDBOX_LABEL : SANDBOX_LABEL;
  const sb = p.sandbox && engine !== 'claude' && engine !== 'grok' ? p.sandbox : null;
  const perm = p.perm;
  const permShown: PermMode = perm?.supported ? perm.mode : 'default';
  const m = modelLabel(p.model, p.effort);
  const modelText = m.effort ? `${m.name} ${m.effort}` : m.name;
  const ctx = p.ctx ? { ...contextLevel(p.ctx), label: contextLabel(p.ctx) } : null;
  const acct = useAccountWords(p.account?.pin ?? null, p.account?.current ?? null);

  // The third part: GPT/Gemini name their sandbox (no approvals there), the others their permission mode.
  const tail = sb ? sandboxLabel[sb.value].split(' · ')[0]! : perm ? PERM_MODE_SHORT[permShown] : p.isNew && p.defaultPerm ? PERM_MODE_SHORT[p.defaultPerm] : null;
  const parts: ReactNode[] = p.isNew
    ? [
        ...(p.folder ? [<span key="f" className="sc-part sc-folder"><FolderIcon />{p.folder}</span>] : []),
        <span key="e" className="sc-part">{ENGINE_CHIP[engine]}</span>,
        ...(p.model !== 'auto' ? [<span key="m" className="sc-part sc-model">{m.name}{m.effort && <span className="sc-extra"> {m.effort}</span>}</span>] : []),
      ]
    : [
        <span key="m" className="sc-part sc-model">{m.name}{m.effort && <span className="sc-extra"> {m.effort}</span>}</span>,
        ...(p.account ? [<AccountChipName key="a" pin={p.account.pin} current={p.account.current} />] : []),
      ];
  if (tail) parts.push(<span key="t" className={`sc-part sc-perm${!sb && perm ? ` perm-${permShown}` : ''}`}>{tail}</span>);
  const aria = [
    p.isNew ? [p.folder, ENGINE_CHIP[engine], `모델 ${modelText}`] : [m.effort ? `${m.name} ${m.effort}` : m.name, p.account ? acct.aria : null],
    tail,
    ctx ? `컨텍스트 ${ctx.pct}%` : null,
  ].flat().filter(Boolean).join(' · ');

  return (
    <span className="session-chip-wrap">
      <button
        type="button"
        className={`session-chip${flash ? ' flash' : ''}${perm?.supported && perm.mode === 'bypassPermissions' ? ' bypass' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`세션 설정: ${aria}`}
        title={`세션 설정 — 모델·계정·권한${p.isNew ? ` (모델: ${modelText})` : ''}${perm?.supported ? ' (Shift+Tab 으로 권한 전환)' : ''}`}
        data-testid="session-chip"
        disabled={p.disabled}
        onClick={() => setOpen(true)}
      >
        {ctx && p.ctx && <ContextRing info={p.ctx} />}
        <span className="sc-label">
          {parts.map((x, i) => <span key={i} className="sc-seg">{i > 0 && <span className="sc-dot" aria-hidden="true">·</span>}{x}</span>)}
        </span>
        <span className="sc-caret" aria-hidden="true">⌄</span>
      </button>
      {ctx && ctx.pct >= 80 && <span className={`ctx-out ${ctx.level}`} data-testid="context-out" title={ctx.label}>{ctx.pct}%</span>}
      <span className="sr-only" aria-live="polite" data-testid="session-chip-said">{said}</span>
      {open && (
        <Sheet className="session-sheet" label="세션 설정" onClose={() => setOpen(false)}>
          <div className="session-sheet-inner" onKeyDown={trapTab}>
            <SheetHead title="세션 설정" onClose={() => setOpen(false)} />
            {ctx && (
              <section className="ss-section ss-ctx" aria-label="컨텍스트">
                <p className="ss-ctx-line" data-testid="context-line">{ctx.label}</p>
                {p.onHandoff && <HandoffButton onHandoff={() => { setOpen(false); p.onHandoff?.(); }} />}
              </section>
            )}
            {p.folderPicker && (
              <section className="ss-section" aria-label="폴더">
                <h3 className="ss-head">폴더</h3>
                {p.folderPicker}
              </section>
            )}
            {(engineSelect || sb) && (
              <section className="ss-section" aria-label="엔진">
                <h3 className="ss-head">엔진</h3>
                {engineSelect && p.engines && (
                  <Pick label={ENGINE_NAME[engine]} value={engine} onChange={(e) => p.engines?.onEngine(e.target.value as EngineChoice)} title="이 세션의 엔진 (세션 생성 후 변경 불가)" aria-label="엔진" data-testid="engine-select">
                    <option value="claude">Claude</option>
                    {p.engines.codexAvailable && <option value="codex">GPT</option>}
                    {gemini?.available && <option value="gemini" disabled={!geminiReady} title={geminiReady ? undefined : 'docs/gemini-spike.md 의 로그인 명령을 먼저 실행하세요'}>{geminiReady ? 'Gemini' : 'Gemini · 로그인 필요'}</option>}
                    {grokShown && <option value="grok" disabled={!grokReady} title={grokReady ? undefined : 'grok CLI 가 없습니다 — README 의 설치 명령 후 grok login'}>{grokReady ? 'Grok' : 'Grok · 설치 필요'}</option>}
                    {p.engines.codexAvailable && <option value="auto">자동</option>}
                  </Pick>
                )}
                {!engineSelect && <p className="ss-note">{ENGINE_NAME[engine]} · 세션을 만든 뒤에는 바꿀 수 없음</p>}
                {sb && (sb.onChange ? (
                  <Pick className="sandbox" label={sandboxLabel[sb.value]} value={sb.value} onChange={(e) => sb.onChange?.(e.target.value as CodexSandbox)}
                    title={sb.existing ? 'GPT 샌드박스 (승인 카드 없음 · 다음 턴부터 적용)' : engine === 'gemini' ? 'Gemini 승인 모드 (승인 카드 없음 · 세션 생성 후 변경 불가)' : 'GPT 샌드박스 (승인 카드 없음 · 세션을 만든 뒤에도 바꿀 수 있음)'}
                    aria-label="샌드박스" data-testid={sb.existing ? 'session-sandbox-select' : 'sandbox-select'}>
                    {CODEX_SANDBOXES.map((x) => <option key={x} value={x}>{sandboxLabel[x]}</option>)}
                  </Pick>
                ) : <p className="ss-note">{engine === 'gemini' ? '승인 모드' : '샌드박스'}: {sandboxLabel[sb.value]}</p>)}
              </section>
            )}
            <section className="ss-section" aria-label="모델">
              <h3 className="ss-head">모델</h3>
              <ModelMenu models={p.models} model={p.model} effort={p.effort} onModel={p.onModel} onEffort={p.onEffort} />
            </section>
            {p.account && (
              <section className="ss-section" aria-label="계정">
                <h3 className="ss-head">이 세션의 계정</h3>
                <AccountMenu pin={p.account.pin} usage={p.account.usage} onPin={p.account.onPin} />
              </section>
            )}
            {perm && (
              <section className="ss-section" aria-label="권한">
                <h3 className="ss-head">권한</h3>
                <Pick className={`perm perm-${permShown}`} label={PERM_MODE_LABEL[permShown]} value={permShown} disabled={!perm.supported} onChange={(e) => perm.onChange(e.target.value as PermMode)}
                  title={perm.supported ? `${permModeHint(perm.mode, engine)} (Shift+Tab 으로 전환)` : 'GPT/Gemini 세션은 샌드박스 선택으로 권한을 정합니다'} aria-label="권한 모드" data-testid="perm-select">
                  {/* Grok has no plan mode yet (§14.2): hidden unless the session already has it. */}
                  {PERM_MODES.filter((x) => x === perm.mode || permModesFor(engine).includes(x)).map((x) => <option key={x} value={x}>{PERM_MODE_LABEL[x]}</option>)}
                </Pick>
                <p className="ss-note">{perm.supported ? `${permModeHint(permShown, engine)} · Shift+Tab 으로 전환` : 'GPT/Gemini 세션은 샌드박스 선택으로 권한을 정합니다'}</p>
              </section>
            )}
          </div>
        </Sheet>
      )}
    </span>
  );
}
