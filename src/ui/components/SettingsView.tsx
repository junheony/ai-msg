import { useId, useRef, useState, type ReactNode } from 'react';
import { usePrefs } from '../usePrefs';
import { useCodeWrap } from '../codeWrap';
import type { ChatWidth, FontSize, Prefs, SendKey, Theme } from '../prefs';
import { PERM_MODES, PERM_MODE_HINT, PERM_MODE_LABEL, type PermMode } from '../../shared/permission';
import { ENGINE_KINDS, type RoutingPolicy } from '../../shared/protocol';
import type { EngineKind } from '../../shared/models';
import { NotifyMenu } from './NotifyMenu';
import { describeShell } from '../shellFit';
import { Sheet } from './Dialogs';
import { TASK_SOFT_CAP_MAX, TASK_SOFT_CAP_MIN } from '../../shared/tasks';
import { MemoryEditor } from './MemoryEditor';

/** What turning 같은 벤더 계정 자동 순환 on asks the user to agree to (spec: paid design §3 rule 3). */
export const ROTATION_CONSENT = '본인이 결제하는 본인 계정에만 씁니다. 계정 공유·재판매·한도 회피 목적의 계정 생성은 각 제공자 약관 위반입니다.';
/** What letting 자동 분배 pick Gemini / Grok asks the user to agree to (auto-route design §10-3). */
export const AUTO_CONSENT_TEXT = '자동 세션의 코드·대화가 Google(Gemini)/xAI(Grok)로 갈 수 있습니다';
export type AutoRouteView = { autoEngines: EngineKind[]; autoConsent: EngineKind[]; grokFast: boolean };
const AUTO_ENGINE_LABEL: Record<EngineKind, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok' };
const needsConsent = (e: EngineKind) => e === 'gemini' || e === 'grok';

/** Injected by vite.config.ts (package.json version); absent under vitest. */
declare const __DECK_VERSION__: string | undefined;

/** Segmented buttons for up to 3 choices; 4 or more become a select (a row of 4 does not fit a phone's line). */
export const SEG_MAX = 3;
function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  // A generated id: a label with spaces would name several ids in aria-labelledby.
  const id = useId();
  if (options.length > SEG_MAX) {
    return (
      <label className="settings-row">
        <span>{label}</span>
        <select value={value} aria-label={label} onChange={(e) => onPick(e.target.value as T)}>
          {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div className="settings-row">
      <span id={id}>{label}</span>
      <div className="seg" role="group" aria-labelledby={id}>
        {options.map(([v, text]) => <button type="button" key={v} aria-pressed={value === v} onClick={() => onPick(v)}>{text}</button>)}
      </div>
    </div>
  );
}

/** The line under a row: a short summary always shown, the long text behind 자세히. */
function Hint({ short, children }: { short: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-hint">
      <p>
        {short}
        {children && <>{' '}<button type="button" className="hint-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '접기' : '자세히'}</button></>}
      </p>
      {open && <p className="settings-hint-body">{children}</p>}
    </div>
  );
}

/** 화면 · 입력 · 권한·알림 · 계정: the sheet's four groups, in order (the desktop's left list jumps to each). */
export const SETTINGS_GROUPS = [['screen', '화면'], ['input', '입력'], ['perm', '권한·알림'], ['account', '계정']] as const;
type GroupId = (typeof SETTINGS_GROUPS)[number][0];

export function SettingsView({ build, defaultPermMode = null, onDefaultPermMode, routingPolicy = null, onRoutingPolicy, sameVendorRotation = null, onSameVendorRotation, commanderEnabled = null, onCommanderEnabled, autoRoute = null, onAutoRoute, claudeAccounts = 0, grokLocked = null, onGrokUnlock, taskCap = null, onTaskCap, onOpenUsage, onOpenHighlights, onClose }: {
  build: string | null;
  /** The mode new sessions start in (null = not known yet); per-session modes live in the composer (Shift+Tab). */
  defaultPermMode?: PermMode | null;
  onDefaultPermMode?: (m: PermMode) => void;
  /** How 자동 picks an account (server setting; null = not known yet). */
  routingPolicy?: RoutingPolicy | null;
  onRoutingPolicy?: (p: RoutingPolicy) => void;
  /** 같은 벤더 계정 자동 순환 (server setting; null = not known yet / an older server). Turning it on asks for consent first. */
  sameVendorRotation?: boolean | null;
  onSameVendorRotation?: (on: boolean) => void;
  /** 총사령탑 (server setting; null = not known yet / a server without it). */
  commanderEnabled?: boolean | null;
  onCommanderEnabled?: (on: boolean) => void;
  /** 자동 분배: engines 자동 may pick, the consented ones, Grok's fast model (server settings; null = not known yet). */
  autoRoute?: AutoRouteView | null;
  onAutoRoute?: (patch: Partial<AutoRouteView>) => void;
  /** Active Claude accounts: with one, there is nothing to rotate between and the switch is disabled. */
  claudeAccounts?: number;
  /** Why the Grok engine is locked (a tripwire fired, §14.9-3); null = not locked. */
  grokLocked?: string | null;
  onGrokUnlock?: () => void;
  /** 백그라운드 작업 running at once before new ones wait (server setting; null = not known yet / an older server). */
  taskCap?: number | null;
  onTaskCap?: (n: number) => void;
  onOpenUsage: () => void;
  onOpenHighlights?: () => void;
  onClose: () => void;
}) {
  const [prefs, dispatch] = usePrefs();
  const [codeWrap, setCodeWrap] = useCodeWrap();
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => dispatch({ type: 'set', key, value });
  const [askConsent, setAskConsent] = useState(false);
  const single = claudeAccounts <= 1;
  const [askAuto, setAskAuto] = useState<EngineKind | null>(null);
  const groupRefs = useRef<Partial<Record<GroupId, HTMLElement | null>>>({});
  const section = (id: GroupId) => ({ ref: (el: HTMLElement | null) => { groupRefs.current[id] = el; }, 'aria-labelledby': `settings-${id}`, className: 'settings-group' });
  const heading = (id: GroupId) => <h3 id={`settings-${id}`}>{SETTINGS_GROUPS.find(([g]) => g === id)![1]}</h3>;
  const foot = `deck ${typeof __DECK_VERSION__ === 'string' ? __DECK_VERSION__ : '—'} · 빌드 ${build ?? '개발 모드'} · ${describeShell()}`;

  return (
    <Sheet className="settings" label="설정" onClose={onClose}>
      <div className="settings-head">
        <h2>설정</h2>
        <button type="button" className="btn ghost" onClick={onClose}>닫기</button>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="설정 그룹">
          {SETTINGS_GROUPS.map(([id, name]) => <button type="button" key={id} onClick={() => groupRefs.current[id]?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{name}</button>)}
        </nav>
        <div className="settings-groups">
          <section {...section('screen')}>
            {heading('screen')}
            <Seg<Theme> label="테마" value={prefs.theme} onPick={(v) => set('theme', v)} options={[['system', '시스템'], ['light', '라이트'], ['dark', '다크']]} />
            <Seg<FontSize> label="글자 크기" value={prefs.fontSize} onPick={(v) => set('fontSize', v)} options={[['small', '작게'], ['normal', '보통'], ['large', '크게'], ['xlarge', '아주 크게']]} />
            <Seg<ChatWidth> label="채팅 폭" value={prefs.chatWidth} onPick={(v) => set('chatWidth', v)} options={[['narrow', '좁게'], ['wide', '넓게']]} />
            <Seg<'off' | 'on'> label="코드 줄바꿈" value={codeWrap ? 'on' : 'off'} onPick={(v) => setCodeWrap(v === 'on')} options={[['off', '가로 스크롤'], ['on', '줄바꿈']]} />
            <Seg<'off' | 'on'> label="간결 모드" value={prefs.conciseMode ? 'on' : 'off'} onPick={(v) => set('conciseMode', v === 'on')} options={[['on', '켜기'], ['off', '끄기']]} />
            <Hint short="짧은 확인 뒤 결과만 보여 줍니다 · 이 기기에만 저장">간결 모드(기본 켜짐): 짧은 확인 뒤 결과만 보여 주고, 생각·도구 본문은 접어둡니다. 끄면 답이 스트리밍으로 보이고 도구 호출도 하나씩 보입니다. 경로 이유·토큰은 어느 쪽이든 답장 끝 모델 알약을 눌러야 보입니다. 이 기기에만 저장됩니다 (폰과 맥이 따로).</Hint>
          </section>
          <section {...section('input')}>
            {heading('input')}
            <Seg<SendKey> label="Enter 동작" value={prefs.sendKey} onPick={(v) => set('sendKey', v)} options={[['enter', 'Enter 전송'], ['mod-enter', '⌘Enter 전송']]} />
            <MemoryEditor />
          </section>
          <section {...section('perm')}>
            {heading('perm')}
            {onDefaultPermMode && defaultPermMode !== null ? (
              <label className="settings-row default-perm" title={`새 세션이 시작할 권한 모드 — ${PERM_MODE_HINT[defaultPermMode]}. 모두 자동 승인이면 새 GPT 세션은 작업폴더 쓰기`}>
                <span>새 세션 기본 권한</span>
                <span className={`pick perm perm-${defaultPermMode}`}>
                  <select value={defaultPermMode} onChange={(e) => onDefaultPermMode(e.target.value as PermMode)} aria-label="새 세션 기본 권한" data-testid="default-perm-select">
                    {PERM_MODES.map((m) => <option key={m} value={m}>{PERM_MODE_LABEL[m]}</option>)}
                  </select>
                </span>
              </label>
            ) : <Hint short="서버 연결 후 표시됩니다." />}
            <Hint short="세션별 모드는 입력창의 권한 선택(Shift+Tab)으로 바꿉니다." />
            {onAutoRoute && autoRoute && (
              <>
                <div className="settings-row auto-engines">
                  <span id="auto-engines">자동 분배</span>
                  <div className="auto-engine-list" role="group" aria-labelledby="auto-engines">
                    {ENGINE_KINDS.map((e) => {
                      const pending = needsConsent(e) && !autoRoute.autoConsent.includes(e);
                      return (
                        <span key={e} className="auto-engine">
                          <label>
                            <input type="checkbox" checked={autoRoute.autoEngines.includes(e)} data-testid={`auto-engine-${e}`}
                              onChange={(ev) => onAutoRoute({ autoEngines: ev.target.checked ? [...autoRoute.autoEngines, e] : autoRoute.autoEngines.filter((x) => x !== e) })} />
                            {' '}{AUTO_ENGINE_LABEL[e]}
                          </label>
                          {pending && <button type="button" className="btn ghost" data-testid={`auto-consent-${e}`} onClick={() => setAskAuto(e)}>동의 필요</button>}
                        </span>
                      );
                    })}
                  </div>
                </div>
                {askAuto && !autoRoute.autoConsent.includes(askAuto) && (
                  <div className="settings-consent" role="group" aria-label={`${AUTO_ENGINE_LABEL[askAuto]} 자동 분배 동의`}>
                    <p>{AUTO_CONSENT_TEXT}</p>
                    <div className="settings-row">
                      <button type="button" className="btn" onClick={() => {
                        const e = askAuto;
                        setAskAuto(null);
                        onAutoRoute({ autoConsent: [...autoRoute.autoConsent, e], ...(autoRoute.autoEngines.includes(e) ? {} : { autoEngines: [...autoRoute.autoEngines, e] }) });
                      }}>동의하고 {AUTO_ENGINE_LABEL[askAuto]} 쓰기</button>
                      <button type="button" className="btn ghost" onClick={() => setAskAuto(null)}>취소</button>
                    </div>
                  </div>
                )}
                <label className="settings-row">
                  <span>Grok 빠른 모델 쓰기(2배 가격)</span>
                  <input type="checkbox" checked={autoRoute.grokFast} data-testid="auto-grok-fast" onChange={(ev) => onAutoRoute({ grokFast: ev.target.checked })} />
                </label>
                <Hint short="체크한 엔진만 자동의 후보가 됩니다.">엔진을 자동으로 두면 첫 턴 내용과 남은 한도로 엔진·모델을 고릅니다. 체크한 엔진만 후보가 되고, Gemini·Grok 은 동의한 뒤에만 고릅니다. 세션이 시작된 뒤에는 엔진이 바뀌지 않습니다.</Hint>
              </>
            )}
            {onTaskCap && taskCap !== null && (
              <>
                <label className="settings-row">
                  <span>동시 백그라운드 작업</span>
                  <select value={taskCap} aria-label="동시 백그라운드 작업" data-testid="task-cap-select" onChange={(e) => onTaskCap(Number(e.target.value))}>
                    {Array.from({ length: TASK_SOFT_CAP_MAX - TASK_SOFT_CAP_MIN + 1 }, (_, i) => i + TASK_SOFT_CAP_MIN).map((n) => <option key={n} value={n}>{n}개</option>)}
                  </select>
                </label>
                <Hint short="넘치면 앞 작업이 끝날 때까지 기다립니다.">입력창의 작업으로 버튼이나 <code>/bg 할 일</code> 로 시작한 작업은 같은 폴더의 새 세션에서 돌고, 이 대화는 계속 쓸 수 있습니다. 이 수를 넘으면 앞 작업이 끝날 때까지 기다리고, 끝나면 늘 알림과 결과 카드가 옵니다.</Hint>
              </>
            )}
            {onCommanderEnabled && commanderEnabled !== null && (
              <>
                <Seg<'off' | 'on'> label="총사령탑" value={commanderEnabled ? 'on' : 'off'} onPick={(v) => { if ((v === 'on') !== commanderEnabled) onCommanderEnabled(v === 'on'); }} options={[['off', '끄기'], ['on', '켜기']]} />
                <Hint short="세션이 쉴 때마다 판정해 다음 지시를 보냅니다.">켜면 Claude 세션의 ⋯ 메뉴에서 목표와 완료 조건을 걸 수 있습니다. 세션이 쉴 때마다 판정해 다음 지시를 자동으로 보내고, 권한 카드·되돌리기 어려운 일은 사람에게 넘깁니다.</Hint>
              </>
            )}
            <div className="settings-row"><span>이 기기 푸시 알림</span><NotifyMenu /></div>
          </section>
          <section {...section('account')}>
            {heading('account')}
            {onRoutingPolicy && routingPolicy !== null && (
              <>
                <Seg<RoutingPolicy> label="자동 계정 선택" value={routingPolicy} onPick={onRoutingPolicy} options={[['balance', '고르게 분산'], ['drain', '리셋 임박 먼저 소진']]} />
                <Hint short="새 세션·오래 쉰 세션·한도 문턱을 넘을 때 적용됩니다.">고르게 분산: 5시간 사용량이 가장 낮은 계정으로 (비슷하면 주간이 낮은 쪽). 리셋 임박 먼저 소진: 주간 한도가 곧 리셋되는 계정부터. 대화 중인 세션은 캐시 때문에 그대로 두고, 새 세션, 오래 쉰 세션, 한도 문턱(5시간 80% · 주간 85%)을 넘어 옮길 때 적용됩니다.</Hint>
              </>
            )}
            {onSameVendorRotation && sameVendorRotation !== null && (
              <>
                <div className="settings-row">
                  <span id="seg-rotation">같은 벤더 계정 자동 순환</span>
                  <div className="seg" role="group" aria-labelledby="seg-rotation">
                    <button type="button" aria-pressed={!sameVendorRotation} disabled={single} onClick={() => { setAskConsent(false); if (sameVendorRotation) onSameVendorRotation(false); }}>끄기</button>
                    <button type="button" aria-pressed={sameVendorRotation} disabled={single} onClick={() => { if (!sameVendorRotation) setAskConsent(true); }}>켜기</button>
                  </div>
                </div>
                {askConsent && !sameVendorRotation && !single && (
                  <div className="settings-consent" role="group" aria-label="자동 순환 동의">
                    <p>{ROTATION_CONSENT}</p>
                    <div className="settings-row">
                      <button type="button" className="btn" onClick={() => { setAskConsent(false); onSameVendorRotation(true); }}>동의하고 켜기</button>
                      <button type="button" className="btn ghost" onClick={() => setAskConsent(false)}>취소</button>
                    </div>
                  </div>
                )}
                {single
                  ? <Hint short="Claude 계정이 1개라 순환할 계정이 없습니다. 계정을 더 등록하면 켤 수 있습니다." />
                  : <Hint short="꺼 두면 세션은 고른 Claude 계정에만 머뭅니다.">꺼짐(기본): 세션은 기본 Claude 계정(또는 세션에서 고른 계정)에만 머물고, 한도에 걸리면 다른 Claude 계정으로 넘기지 않고 리셋 뒤 자동으로 다시 시도합니다. 켜면 위 자동 계정 선택대로 Claude 계정 사이를 옮깁니다. GPT·Gemini 로의 벤더 간 인계는 이 설정과 상관없습니다.</Hint>}
              </>
            )}
            {grokLocked && (
              <div className="settings-row grok-locked" role="alert">
                <span>Grok 엔진 잠김 — {grokLocked}</span>
                {onGrokUnlock && <button type="button" className="btn" onClick={onGrokUnlock}>잠금 해제</button>}
              </div>
            )}
            <div className="settings-row"><span>토큰 사용량 기록</span><button type="button" className="link-btn" onClick={() => { onClose(); onOpenUsage(); }}>사용량 보기</button></div>
            {onOpenHighlights && <div className="settings-row"><span>세션 하이라이트</span><button type="button" className="link-btn" onClick={() => { onClose(); onOpenHighlights(); }}>하이라이트</button></div>}
            <Hint short="계정별 5시간·주간 한도는 상단 사용량 칩의 시트에서 봅니다." />
          </section>
        </div>
      </div>
      {/* What 정보 used to list, as one line (the screen metrics are for bug reports: the whole line is its title). */}
      <p className="settings-foot" data-testid="settings-foot" title={foot}>{foot}</p>
    </Sheet>
  );
}
