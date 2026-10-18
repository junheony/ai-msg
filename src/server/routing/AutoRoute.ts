import type { Account, AccountNames } from '../../shared/accounts';
import {
  AUTO_EFFORT, EFFORTS, MODEL_EFFORTS, isClaudeModel, isCodexModel, isGeminiModel,
  type AnyModel, type ClaudeModel, type EngineChoice, type EngineKind, type Effort, type GrokModel, type ModelChoice,
} from '../../shared/models';
import { parseIsoUtc, usageOf, type UsageSnapshot } from '../../shared/usage-types';
import { FABLE_MAX_PCT, WEEKLY_SWITCH_PCT, isLax, noFableWhy, rankCandidates } from './AccountRouter';
import { LONG_PROMPT, classifyPrompt } from './AutoModel';
import { GPT_MARGIN_PCT } from './EngineChoice';

/**
 * 자동 분배 (docs/superpowers/specs/2026-10-18-auto-route-design.md, §10 wins over the earlier sections): pick
 * (engine, model, effort) for the first turn of a new session from the turn's kind and difficulty, each engine's
 * capabilities and its limit state. Pure: no I/O, the clock is `nowMs`, the same input gives the same result.
 */

export type TaskKind = 'explain' | 'build' | 'design';
export type TaskDifficulty = 'easy' | 'medium' | 'hard';
/** `ambiguous`: no cue of any kind ("계속", "좋아") — routed as build, but no reason to stop a session's flow (turnFits). */
export type Task = { kind: TaskKind; difficulty: TaskDifficulty; needsShell: boolean; needsEdit: boolean; vision: boolean; ambiguous: boolean; why: string };

/** §10-6: a limit observation older than this is unknown (GPT, Gemini; Claude keeps the router's own stale/trustUntil rules). */
export const OBSERVATION_MAX_MS = 15 * 60_000;
/** §5: a Gemini bucket with less than this much left is blocked. */
export const GEMINI_MIN_REMAINING_PCT = 15;
/** §10-7: 곧 리셋되는 여유 — the last this-fraction of the period, with at least RESET_MIN_REMAINING_PCT left. */
export const RESET_WINDOW_FRACTION = 0.15;
export const RESET_MIN_REMAINING_PCT = 50;
/** Claude and GPT weekly windows (the only ones 리셋 승격 applies to, §10-7). */
export const WEEK_MS = 7 * 24 * 3_600_000;

const KIND_LABEL: Record<TaskKind, string> = { explain: '설명', build: '구현', design: '설계' };

// ── classifyTask ────────────────────────────────────────────────────────────────────────────────────────────────

/** The existing MEDIUM cues (AutoModel) plus 고칠 / fix…: implementation / bug fixing — a build turn (§3). */
const BUILD_CUES: RegExp[] = [
  /구현|만들어|추가해|추가\s*(하|해)|작성해|개발해|리팩터|리팩토링|고쳐|고칠|수정해|버그|오류\s*(가|를)?\s*(나|고치)|에러|기능|여러\s*파일|연동|통합|테스트\s*(를)?\s*(작성|추가|짜)|마이그레이션/,
  /\bimplement|\bbuild\b|\badd (a |an |the )?(feature|endpoint|test|support)|\brefactor|\bfix\w*|\bbug\b|\berror\b|\bcrash|\bmulti-?file|\bintegrat|\bmigrat|\bwrite (a |the )?(test|function|module|script)/i,
];

/** Edits beyond BUILD_CUES (a rename, a typo, a delete): the turn writes files. */
const EDIT_CUES: RegExp[] = [
  /오타|이름\s*(을)?\s*바꿔|이름\s*변경|바꿔\s*줘|바꿔$|변경해|삭제해|지워|수정\s*(하|해)|넣어\s*줘|주석\s*(을)?\s*(달|추가|넣)/,
  /\b(change|edit|update|modify|delete|remove|rename|create|typo)\b|\badd (a |an |the )?comment/i,
];

/**
 * §10-2: shell cues — tests, run, build, install, logs, git (push·merge·commit·branch·diff·status, PR comments), CI,
 * lint, tsc / type check, compile, test runners, servers·ports·processes, verify·reproduce, "why does it fail", a `$` prompt.
 */
const SHELL_CUES: RegExp[] = [
  /테스트|실행|빌드|설치|로그(?!인|아웃)|돌려|돌리|커밋|푸시|머지|병합|배포|터미널|명령어|브랜치|린트|타입\s*체크|컴파일|서버|포트|프로세스|검증|재현|코멘트\s*(를|도)?\s*달|왜\s*(안\s*)?(실패|깨|안\s*돼|죽|안\s*되)|실패(해|하|했|한)|(에러|오류)\s*(의\s*)?원인/,
  /\btests?\b|\brun\b|\bbuild\b|\binstall\b|\blogs?\b|\bgit\b|\bnpm\b|\bnpx\b|\bpnpm\b|\byarn\b|\bcompil|\bdeploy|\bcommit|\bpush|\bmerg(e|ing)\b|\bbranch|\bdiff\b|\bstatus\b|\bci\b|\blint|\btsc\b|\btype-?check|\bvitest\b|\bjest\b|\bpytest\b|\bservers?\b|\bports?\b|\bprocesses\b|\bpid\b|\bverif|\breproduc|\bpr comments?\b|\bfailing\b|\bwhy (does|is|did|do)\b.*\bfail/i,
  /(^|\s|`)\$\s?[a-z]/im,
];

/** Explicit explain cues (asking, explaining, summarizing, translating, reviewing). A trailing `?` alone is not one. */
const EXPLAIN_CUES: RegExp[] = [
  /뭐야|뭔가요|무엇|무슨\s*뜻|알려\s*줘|설명|요약|번역|리뷰|검토|분석해|비교해|살펴\s*봐|읽어\s*줘|문서|어디|찾아\s*줘|목록|보여\s*줘/,
  /\bwhat\b|\bwhere\b|\bhow (do|can|does)\b|\bexplain|\bdocs?\b|\bdocument|\bsummari[sz]e|\btranslate\b|\blist\b|\bshow me\b|\blook ?up\b|\breview\b|\banaly[sz]e\b|\bcompare\b/i,
];

const SHELL_FENCE_LANG = /^(sh|bash|zsh|shell|console|terminal|shellsession|fish|ps1?|powershell|cmd|bat)$/i;
/** A command line inside an unlabelled (or non-shell) block. `#` lines count only in a sh/bash block (they are comments elsewhere). */
const SHELL_LINE = /^\s*(\$|%)\s+\S|^\s*(npm|npx|pnpm|yarn|node|git|python3?|pip3?|make|cargo|go|ls|cd|cat|grep|rg|curl|docker|bash|sh|brew|vitest|tsc|pytest|sudo|chmod|mkdir|rm|mv|cp)\b(\s|$)/;
/** Pasted log / stack-trace lines: quoted material, not the user's instruction. */
const LOG_LINE = /^\s*(at\s+\S.*:\d+(:\d+)?\)?\s*$|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?(ERROR|WARN(ING)?|INFO|DEBUG|TRACE|FATAL)\]?[\s:]|Traceback \(most recent call last\)|File ".*", line \d+|npm (ERR|WARN)!)/;

const hits = (res: RegExp[], text: string) => res.some((r) => r.test(text));

/** §10-2: the user's own words (fenced blocks, `>` quotes and pasted log lines removed) and whether a removed block looked like shell. */
export function instructionText(text: string): { text: string; shellBlock: boolean; stripped: boolean } {
  let shellBlock = false;
  let stripped = false;
  const noFences = text.replace(/```([^\n`]*)\n?([\s\S]*?)(```|$)/g, (_m, lang: string, body: string) => {
    stripped = true;
    if (SHELL_FENCE_LANG.test(lang.trim()) || body.split('\n').some((l) => SHELL_LINE.test(l))) shellBlock = true;
    return '\n';
  });
  const lines = noFences.split('\n').filter((l) => {
    const quoted = /^\s*>/.test(l) || LOG_LINE.test(l);
    if (quoted) stripped = true;
    return !quoted;
  });
  return { text: lines.join('\n').trim(), shellBlock, stripped };
}

/**
 * §3 + §10-2/3: kind and difficulty, kept apart. Difficulty is classifyPrompt's (on the user's own words), with a long
 * paste counting as at least medium. Kind leans to the shell: any shell or edit cue → build; else an explicit explain
 * cue → explain; else a design cue → design; else (ambiguous) → build.
 */
export function classifyTask(text: string, attachments: { images: number }): Task {
  const ins = instructionText(text);
  const t = ins.text;
  const c = classifyPrompt(t, attachments.images);
  let difficulty: TaskDifficulty = c.model === 'fable' ? 'hard' : c.model === 'opus' ? 'medium' : 'easy';
  const notes = [c.why];
  if (difficulty === 'easy' && text.trim().length > LONG_PROMPT) { difficulty = 'medium'; notes[0] = '긴 붙여넣기'; }
  const build = hits(BUILD_CUES, t);
  const shellCue = hits(SHELL_CUES, t) || ins.shellBlock;
  // A trivial edit (typo, rename) writes a file but needs no shell; every other build cue assumes one (§3).
  const needsShell = shellCue || (build && c.why !== '간단한 수정');
  const needsEdit = build || hits(EDIT_CUES, t);
  const explain = hits(EXPLAIN_CUES, t);
  const ambiguous = !needsShell && !needsEdit && !explain && c.model !== 'fable';
  const kind: TaskKind = needsShell || needsEdit ? 'build' : explain ? 'explain' : c.model === 'fable' ? 'design' : 'build';
  if (ambiguous) notes.push('종류 애매 → 구현');
  if (shellCue) notes.push(ins.shellBlock && !hits(SHELL_CUES, t) ? '셸 명령 블록' : '셸 단서');
  if (needsEdit) notes.push('수정 단서');
  if (attachments.images > 0) notes.push(`이미지 ${attachments.images}개`);
  if (ins.stripped) notes.push('인용 제외');
  return { kind, difficulty, needsShell, needsEdit, vision: attachments.images > 0, ambiguous, why: [KIND_LABEL[kind], ...notes].join(' · ') };
}

// ── turnFits ────────────────────────────────────────────────────────────────────────────────────────────────────

export type TurnFit = { ok: true } | { ok: false; need: string };

/**
 * §10-4: can this engine take this turn at all (run every turn; the caller shows the "needs ○○" card). Gemini takes an
 * explain turn, a simple edit (no shell) inside HOME, or a cue-less follow-up ("계속") — nothing else.
 */
export function turnFits(engine: EngineKind, task: Task, ctx: { cwdInsideHome: boolean }): TurnFit {
  if (engine === 'gemini') {
    if (task.needsShell) return { ok: false, need: '셸 실행' };
    if (task.needsEdit) return ctx.cwdInsideHome ? { ok: true } : { ok: false, need: '신뢰 폴더(HOME) 밖 파일 편집' };
    if (task.kind !== 'explain' && !task.ambiguous) return { ok: false, need: '설명 외 작업(셸·편집 엔진)' };
  }
  if (engine === 'grok' && task.vision) return { ok: false, need: '이미지 입력' };
  return { ok: true };
}

// ── engineState ─────────────────────────────────────────────────────────────────────────────────────────────────

export type EngineState = 'ok' | 'blocked' | 'unknown';

/** Claude: the existing account usage (routing reuses rankCandidates, the 85 % weekly line and the Fable 80 % rule). */
export type ClaudeLimits = {
  usage: UsageSnapshot;
  cooldownUntilMs: Partial<Record<Account, number>>;
  protectedAccount: Account | null;
  accounts: AccountNames;
};
/** GPT (Codex, one seat): weekly used % with its observation time and reset, the in-memory limit cooldown. */
export type GptLimits = {
  installed: boolean;
  weeklyUsedPct: number | null;
  weeklyResetsAtMs: number | null;
  observedAtMs: number | null;
  cooldownUntilMs: number | null;
};
export type GeminiGroup = 'pro' | 'flash';
/** One Gemini seat (g1, g2): remaining % per model group (Pro → Argon bucket, Flash → Flash bucket); null = not reported. */
export type GeminiSeatLimits = { seat: string; enabled: boolean; remainingPct: Partial<Record<GeminiGroup, number | null>> };
export type GeminiLimits = { installed: boolean; loggedIn: boolean; observedAtMs: number | null; seats: GeminiSeatLimits[] };
/**
 * Grok: a cooldown, the last turn's error kind, and the subscription's period usage (`_x.ai/billing`) when deck has read
 * it — `periodUsedPct` null/absent = never read, or its period has ended (a new period is not judged on old numbers).
 */
export type GrokLimits = { installed: boolean; cooldownUntilMs: number | null; lastError: 'auth' | 'other' | null; periodUsedPct?: number | null };

export type EngineLimits = { claude: ClaudeLimits; codex: GptLimits; gemini: GeminiLimits; grok: GrokLimits };

/** weeklyRemainingPct / weeklyResetsAtMs: Claude·GPT only (the balance and 리셋 승격 read them). */
export type EngineCapacity = { state: EngineState; why: string; weeklyRemainingPct: number | null; weeklyResetsAtMs: number | null };

const cap = (state: EngineState, why: string, weeklyRemainingPct: number | null = null, weeklyResetsAtMs: number | null = null): EngineCapacity =>
  ({ state, why, weeklyRemainingPct, weeklyResetsAtMs });

const stale = (observedAtMs: number | null, nowMs: number) => observedAtMs === null || nowMs - observedAtMs > OBSERVATION_MAX_MS;
const ageMin = (observedAtMs: number, nowMs: number) => Math.round((nowMs - observedAtMs) / 60_000);

const claudeBase = (l: ClaudeLimits, nowMs: number) =>
  ({ current: null, usage: l.usage, nowMs, lastTurnAtMs: null, justCompacted: false, cooldownUntilMs: l.cooldownUntilMs, protectedAccount: l.protectedAccount, accounts: l.accounts });

/**
 * Claude with model 자동 — exactly chooseAutoModel's steps from the difficulty: Fable / Opus / Sonnet; no Fable-eligible
 * account → Opus (unless a lax install simply does not know); best weekly ≥ WEEKLY_SWITCH_PCT → one step down.
 */
export function claudeAutoModel(difficulty: TaskDifficulty, l: ClaudeLimits, nowMs: number): { model: ClaudeModel; notes: string[] } {
  let model: ClaudeModel = difficulty === 'hard' ? 'fable' : difficulty === 'medium' ? 'opus' : 'sonnet';
  const notes: string[] = [];
  const base = claudeBase(l, nowMs);
  const fable = model === 'fable' ? rankCandidates({ ...base, needFable: true }) : null;
  if (fable && fable.candidates.length === 0) {
    const why = isLax(l.usage) && fable.unknown.length > 0 ? null : noFableWhy(base);
    if (why !== null) { model = 'opus'; notes.push(why === 'Fable 여유 계정 없음' ? `Fable ${FABLE_MAX_PCT}%↑` : why); }
  }
  const { candidates } = rankCandidates({ ...base, needFable: false });
  const best = candidates.length ? Math.min(...candidates.map((x) => x.weeklyPct)) : null;
  if (best !== null && best >= WEEKLY_SWITCH_PCT && model !== 'sonnet') {
    model = model === 'fable' ? 'opus' : 'sonnet';
    notes.push(`Claude 주간 ${best}%`);
  }
  return { model, notes };
}

/**
 * Claude keeps the router's rules (stale / trustUntil, EXCLUDE_PCT and the rest): ok while some account can take a turn
 * (85–94 % weekly is ok — the model steps down instead), blocked only when every account is ruled out, unknown when
 * none is usable but some are unknown (a lax install: ok with no remaining % — no balance comparison).
 */
function claudeState(l: ClaudeLimits, model: AnyModel, nowMs: number): EngineCapacity {
  const base = claudeBase(l, nowMs);
  const { candidates, excluded, unknown } = rankCandidates({ ...base, needFable: false });
  let general: EngineCapacity;
  if (candidates.length > 0) {
    const best = candidates.reduce((x, y) => (y.weeklyPct < x.weeklyPct ? y : x));
    const resetIso = usageOf(l.usage, best.account).weekly?.resetsAt ?? null;
    const resetMs = resetIso ? parseIsoUtc(resetIso) : Number.NaN;
    general = cap('ok', `Claude 주간 ${best.weeklyPct}%`, 100 - best.weeklyPct, Number.isNaN(resetMs) ? null : resetMs);
  } else if (unknown.length > 0) {
    general = isLax(l.usage) ? cap('ok', 'Claude 잔여량 모름(usage-deck 없음)') : cap('unknown', 'Claude 잔여량 모름');
  } else {
    const r = [...new Set(Object.values(excluded))];
    general = cap('blocked', r.length ? `Claude 쓸 계정 없음(${r.join(', ')})` : 'Claude 쓸 계정 없음');
  }
  if (model !== 'fable' || general.state === 'blocked') return general;
  // engineState('claude', 'fable'): the Fable rule of chooseAutoModel.
  const fable = rankCandidates({ ...base, needFable: true });
  if (fable.candidates.length > 0) return general;
  const why = isLax(l.usage) && fable.unknown.length > 0 ? null : noFableWhy(base);
  if (why === null) return general;
  return cap('blocked', why === 'Fable 여유 계정 없음' ? `Fable ${FABLE_MAX_PCT}%↑` : why, general.weeklyRemainingPct, general.weeklyResetsAtMs);
}

function gptState(l: GptLimits, nowMs: number): EngineCapacity {
  if (!l.installed) return cap('blocked', 'codex CLI 없음');
  if (l.cooldownUntilMs !== null && l.cooldownUntilMs > nowMs) return cap('blocked', 'GPT 쿨다운 중');
  if (l.weeklyUsedPct === null) return cap('unknown', 'GPT 잔여량 모름');
  if (stale(l.observedAtMs, nowMs)) return cap('unknown', l.observedAtMs === null ? 'GPT 관측 시각 없음' : `GPT 관측 ${ageMin(l.observedAtMs, nowMs)}분 전`);
  const rem = Math.max(0, 100 - l.weeklyUsedPct);
  if (l.weeklyUsedPct >= WEEKLY_SWITCH_PCT) return cap('blocked', `GPT 주간 ${l.weeklyUsedPct}%`, rem, l.weeklyResetsAtMs);
  return cap('ok', `GPT 주간 ${l.weeklyUsedPct}%`, rem, l.weeklyResetsAtMs);
}

function geminiState(l: GeminiLimits, model: AnyModel, nowMs: number): EngineCapacity {
  if (!l.installed) return cap('blocked', 'agy 없음');
  if (!l.loggedIn) return cap('blocked', 'Gemini 로그인 없음');
  const group: GeminiGroup = model === 'gemini-flash' ? 'flash' : 'pro';
  const name = group === 'pro' ? 'Gemini Pro' : 'Gemini Flash';
  if (stale(l.observedAtMs, nowMs)) return cap('unknown', l.observedAtMs === null ? `${name} 관측 없음` : `${name} 관측 ${ageMin(l.observedAtMs, nowMs)}분 전`);
  const enabled = l.seats.filter((s) => s.enabled);
  const known = enabled.map((s) => s.remainingPct[group]).filter((x): x is number => typeof x === 'number');
  if (known.length === 0) return cap('unknown', `${name} 잔여량 모름`);
  const best = Math.max(...known);
  if (best < GEMINI_MIN_REMAINING_PCT) {
    // review #6: a logged-in seat with no number of its own (not in cooldown) is unknown, not a 0 — one blocked (or
    // cooling) seat does not speak for a seat deck has no data on.
    if (enabled.some((s) => typeof s.remainingPct[group] !== 'number')) return cap('unknown', `${name} 잔여량 모름(계정별 다름)`);
    return cap('blocked', `${name} 남은 ${best}%`);
  }
  return cap('ok', `${name} 남은 ${best}%`);
}

function grokState(l: GrokLimits, nowMs: number): EngineCapacity {
  if (!l.installed) return cap('blocked', 'grok CLI 없음');
  if (l.cooldownUntilMs !== null && l.cooldownUntilMs > nowMs) return cap('blocked', 'Grok 쿨다운 중');
  if (l.lastError === 'auth') return cap('blocked', 'Grok 인증 오류');
  const used = l.periodUsedPct ?? null;
  if (used === null) return cap('ok', 'Grok 한도 관측 없음');
  // Usage within a period never goes down, so a reading stays a lower bound until the period ends (the caller drops it then).
  if (used >= WEEKLY_SWITCH_PCT) return cap('blocked', `Grok 구독 ${Math.round(used)}% 사용`);
  return cap('ok', `Grok 구독 ${Math.round(used)}% 사용`);
}

/** §5 + §10-6: one engine model's limit state from the caller's normalized limits. */
export function engineState(engine: EngineKind, model: AnyModel, limits: EngineLimits, nowMs: number): EngineCapacity {
  switch (engine) {
    case 'claude': return claudeState(limits.claude, model, nowMs);
    case 'codex': return gptState(limits.codex, nowMs);
    case 'gemini': return geminiState(limits.gemini, model, nowMs);
    case 'grok': return grokState(limits.grok, nowMs);
  }
}

/** Installed and logged in (capability, §10-6), apart from the limit state. */
function available(engine: EngineKind, l: EngineLimits): string | null {
  if (engine === 'codex' && !l.codex.installed) return 'codex CLI 없음';
  if (engine === 'gemini' && !l.gemini.installed) return 'agy 없음';
  if (engine === 'gemini' && !l.gemini.loggedIn) return 'Gemini 로그인 없음';
  if (engine === 'grok' && !l.grok.installed) return 'grok CLI 없음';
  return null;
}

// ── chooseRoute ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RouteInput = {
  text: string;
  images: number;
  /** What the user picked; chooseRoute is for `engine === 'auto' || model === 'auto'`. */
  engine: EngineChoice;
  model: ModelChoice;
  /** The picked effort: used with a picked model (clamped to MODEL_EFFORTS). */
  effort?: Effort;
  limits: EngineLimits;
  nowMs: number;
  cwdInsideHome: boolean;
  /** 설정 "자동에 쓸 엔진". */
  autoEngines: readonly EngineKind[];
  /** §10-9: engines whose "code goes to Google/xAI" card was accepted (only Gemini and Grok need it). */
  consented: readonly EngineKind[];
  /** §10-1: 설정 "Grok 빠른 모델 쓰기" (default off). */
  grokFast?: boolean;
  /** 총사령탑·자동 실행: Claude only, whatever engine or model is picked (§1, §10-10). */
  commander?: boolean;
  /** §10-8 이어가기: engines to leave out (the one that is blocked now). */
  excludeEngines?: readonly EngineKind[];
};

/** `fit`: on the picked engine / picked model paths only — the caller shows the "needs ○○" card when it is not ok. */
export type RouteDecision =
  | { kind: 'route'; engine: EngineKind; model: AnyModel; effort: Effort; reason: string; why: string[]; fit?: TurnFit }
  | { kind: 'no_route'; reasons: Record<EngineKind, string> };

type Cand = { engine: EngineKind; model: AnyModel; note?: string };

const ENGINES: readonly EngineKind[] = ['claude', 'codex', 'gemini', 'grok'];
const NEEDS_CONSENT: readonly EngineKind[] = ['gemini', 'grok'];

const ROUTE_LABEL: Record<AnyModel, string> = {
  sonnet: 'Claude Sonnet', opus: 'Claude Opus', fable: 'Claude Fable', 'gpt-6-sol': 'GPT Sol', 'gpt-6-astra': 'GPT Astra',
  'gemini-pro': 'Gemini Pro', 'gemini-flash': 'Gemini Flash', 'grok-4.7': 'Grok 4.7', 'grok-4.7-build-fast': 'Grok 4.7 Fast',
  'grok-4.6': 'Grok 4.6', 'grok-4.5': 'Grok 4.5',
};
const ENGINE_LABEL: Record<EngineKind, string> = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', grok: 'Grok' };

/**
 * §4 with §10-1/3: the cell's candidates in preference order. Claude's entry is claudeAutoModel's model (the existing
 * step-down). On hard, a Claude that cannot run Fable comes after GPT Astra (the one exception to the old Claude↔GPT order).
 */
function cellOf(task: Task, grok: GrokModel, claude: { model: ClaudeModel; notes: string[] }): Cand[] {
  const G: Cand = { engine: 'grok', model: grok };
  const note = claude.notes.length ? { note: claude.notes.join(' · ') } : {};
  const C: Cand = { engine: 'claude', model: claude.model, ...note };
  if (task.difficulty === 'hard') {
    const astra: Cand = { engine: 'codex', model: 'gpt-6-astra' };
    const pair = claude.model === 'fable' ? [C, astra] : [{ ...astra, ...note }, C];
    return [...pair, ...(task.kind === 'explain' ? [{ engine: 'gemini', model: 'gemini-pro', note: '읽기 전용 분석' } as Cand] : [])];
  }
  const easy = task.difficulty === 'easy';
  if (task.kind === 'explain') {
    return [C, { engine: 'gemini', model: easy ? 'gemini-flash' : 'gemini-pro' }, { engine: 'codex', model: 'gpt-6-sol' }, G];
  }
  return [C, { engine: 'codex', model: 'gpt-6-sol' }, G];
}

/** An engine picked with model 자동 whose engine the cell does not list (Gemini on build, Grok on hard): its own default by difficulty. */
function engineDefault(engine: EngineKind, d: TaskDifficulty, grok: GrokModel): AnyModel {
  switch (engine) {
    case 'claude': return d === 'hard' ? 'fable' : d === 'medium' ? 'opus' : 'sonnet';
    case 'codex': return d === 'hard' ? 'gpt-6-astra' : 'gpt-6-sol';
    case 'gemini': return d === 'easy' ? 'gemini-flash' : 'gemini-pro';
    case 'grok': return grok;
  }
}

/** The closest supported effort at or below `want`. */
export function clampEffort(model: AnyModel, want: Effort): Effort {
  const allowed = MODEL_EFFORTS[model];
  for (let i = EFFORTS.indexOf(want); i >= 0; i--) {
    const e = EFFORTS[i] as Effort;
    if (allowed.includes(e)) return e;
  }
  return allowed[0] as Effort;
}

/** §4: Claude keeps AUTO_EFFORT; the rest easy=low, medium=medium, hard=high — clamped to the closest lower supported value. */
export function routeEffort(model: AnyModel, difficulty: TaskDifficulty): Effort {
  return clampEffort(model, isClaudeModel(model) ? AUTO_EFFORT[model] : difficulty === 'easy' ? 'low' : difficulty === 'medium' ? 'medium' : 'high');
}

function engineOfModel(m: AnyModel): EngineKind {
  return isClaudeModel(m) ? 'claude' : isCodexModel(m) ? 'codex' : isGeminiModel(m) ? 'gemini' : 'grok';
}

const resetSoon = (c: EngineCapacity, nowMs: number) =>
  c.weeklyResetsAtMs !== null && c.weeklyRemainingPct !== null &&
  c.weeklyResetsAtMs > nowMs && c.weeklyResetsAtMs - nowMs <= RESET_WINDOW_FRACTION * WEEK_MS &&
  c.weeklyRemainingPct >= RESET_MIN_REMAINING_PCT;

function badge(task: Task, label: string, notes: string[]): string {
  return [`자동`, KIND_LABEL[task.kind], ...(task.vision ? ['이미지 첨부'] : []), ...notes].join(' · ') + ` → ${label}`;
}

/** Why Gemini is not in the cell at all (no_route). */
function geminiAbsentWhy(task: Task, cwdInsideHome: boolean): string {
  if (task.needsShell) return '셸 필요';
  if (task.needsEdit && !cwdInsideHome) return '신뢰 폴더(HOME) 밖 편집';
  if (task.needsEdit) return '구현 작업 후보 아님';
  if (task.difficulty === 'hard') return '어려운 작업은 설명만';
  return '설명 단서 없음';
}

/**
 * §4 + §10-7, in a fixed order: commander (Claude only) → picked model → picked engine → capability → autoEngines/consent
 * → limit state → Claude↔GPT balance → 리셋 승격 → table order. Full auto picks the first ok candidate other than Grok,
 * else the cell's first entry (before any filter) if unknown, else any other unknown (한도 불명), else Grok, else no_route.
 */
export function chooseRoute(i: RouteInput): RouteDecision {
  const task = classifyTask(i.text, { images: i.images });
  const grok: GrokModel = i.grokFast ? 'grok-4.7-build-fast' : 'grok-4.7';
  const why: string[] = [`분류: ${task.why}`];
  const route = (c: Cand, notes: string[], extra: string[] = [], opt: { effort?: Effort; fit?: TurnFit } = {}): RouteDecision => {
    const effort = opt.effort ?? routeEffort(c.model, task.difficulty);
    return {
      kind: 'route', engine: c.engine, model: c.model, effort, reason: badge(task, ROUTE_LABEL[c.model], notes),
      why: [...why, ...extra, `→ ${ROUTE_LABEL[c.model]} (${effort})`], ...(opt.fit ? { fit: opt.fit } : {}),
    };
  };
  const ctx = { cwdInsideHome: i.cwdInsideHome };
  const claudeAuto = () => claudeAutoModel(task.difficulty, i.limits.claude, i.nowMs);

  // Commander: Claude only, whatever is picked. A non-Claude pick is ignored (said in why) and Claude goes 자동.
  if (i.commander) {
    const notes = ['총사령탑'];
    let model: ClaudeModel;
    let effort: Effort | undefined;
    if (i.model !== 'auto' && isClaudeModel(i.model)) {
      model = i.model;
      notes.push(`${ROUTE_LABEL[model]} 지정`);
      if (i.effort) effort = clampEffort(model, i.effort);
    } else {
      if (i.model !== 'auto') why.push(`${ROUTE_LABEL[i.model]} 지정 무시: 총사령탑 턴은 Claude 만`);
      else if (i.engine !== 'auto' && i.engine !== 'claude') why.push(`${ENGINE_LABEL[i.engine]} 지정 무시: 총사령탑 턴은 Claude 만`);
      const a = claudeAuto();
      model = a.model;
      notes.push(...a.notes);
    }
    const s = engineState('claude', 'opus', i.limits, i.nowMs);
    why.push(`Claude: ${s.state} (${s.why})`);
    if (s.state === 'blocked') {
      const reasons = Object.fromEntries(ENGINES.map((e) => [e, e === 'claude' ? s.why : '총사령탑 턴은 Claude 만'])) as Record<EngineKind, string>;
      return { kind: 'no_route', reasons };
    }
    return route({ engine: 'claude', model }, notes, [], { effort });
  }

  // A picked model wins whatever the engine choice (its engine is the model's); a picked effort is kept (clamped).
  if (i.model !== 'auto') {
    const engine = engineOfModel(i.model);
    const fit = turnFits(engine, task, ctx);
    return route({ engine, model: i.model }, [`${ROUTE_LABEL[i.model]} 지정`], [], { effort: i.effort ? clampEffort(i.model, i.effort) : undefined, fit });
  }

  // An engine picked, model 자동. Claude: exactly chooseAutoModel. Others: that engine's column — the first model with
  // room, else the first unknown, else the column's first. The user's pick wins over filters (fit says what is missing).
  if (i.engine !== 'auto') {
    const engine = i.engine;
    const fit = turnFits(engine, task, ctx);
    if (engine === 'claude') {
      const a = claudeAuto();
      return route({ engine, model: a.model }, ['Claude 지정', ...a.notes], [], { fit });
    }
    // review #5: the picked engine is not even available (not installed / not logged in) — unlike a merely capacity-
    // blocked engine (cooldown, quota), there is no way to run it at all: fall back to Claude, as before, reason shown.
    const missing = available(engine, i.limits);
    if (missing) {
      const a = claudeAuto();
      return route({ engine: 'claude', model: a.model }, [`${ENGINE_LABEL[engine]} 지정`, missing, ...a.notes]);
    }
    const column = cellOf(task, grok, claudeAuto()).filter((c) => c.engine === engine).map((c) => ({ engine: c.engine, model: c.model }));
    const cands = column.length > 0 ? column : [{ engine, model: engineDefault(engine, task.difficulty, grok) }];
    const states = cands.map((c) => engineState(c.engine, c.model, i.limits, i.nowMs));
    const at = states.findIndex((s) => s.state === 'ok');
    const pick = at >= 0 ? at : Math.max(0, states.findIndex((s) => s.state === 'unknown'));
    const notes = [`${ENGINE_LABEL[engine]} 지정`, ...(pick > 0 ? [states[0]!.why] : [])];
    return route(cands[pick]!, notes, states.map((s, k) => `${ROUTE_LABEL[cands[k]!.model]}: ${s.state} (${s.why})`), { fit });
  }

  // Full auto.
  const claude = claudeAuto();
  if (claude.notes.length) why.push(`Claude 모델: ${claude.notes.join(' · ')} → ${ROUTE_LABEL[claude.model]}`);
  const cell = cellOf(task, grok, claude);
  const blockedWhy: Record<EngineKind, string[]> = { claude: [], codex: [], gemini: [], grok: [] };
  const out = (engine: EngineKind, r: string) => { if (!blockedWhy[engine].includes(r)) blockedWhy[engine].push(r); };
  const cands: Cand[] = [];
  for (const c of cell) {
    const skip = (r: string) => { out(c.engine, r); why.push(`${ROUTE_LABEL[c.model]} 제외: ${r}`); };
    const fit = turnFits(c.engine, task, ctx);
    if (!fit.ok) { skip(`${fit.need} 불가`); continue; }
    const missing = available(c.engine, i.limits);
    if (missing) { skip(missing); continue; }
    if (i.excludeEngines?.includes(c.engine)) { skip('이어가기 대상 아님(지금 엔진)'); continue; }
    if (!i.autoEngines.includes(c.engine)) { skip('자동에 쓸 엔진에서 꺼짐'); continue; }
    if (NEEDS_CONSENT.includes(c.engine) && !i.consented.includes(c.engine)) { skip('외부 전송 동의 전'); continue; }
    cands.push(c);
  }

  // Claude's model is already chosen (claudeAutoModel): its state is the general one.
  const states = new Map<Cand, EngineCapacity>(cands.map((c) => [c, engineState(c.engine, c.engine === 'claude' ? 'opus' : c.model, i.limits, i.nowMs)]));
  for (const c of cands) why.push(`${ROUTE_LABEL[c.model]}: ${states.get(c)!.state} (${states.get(c)!.why})`);
  // Grok is the very last resort: after every ok and unknown candidate.
  const ok = cands.filter((c) => c.engine !== 'grok' && states.get(c)!.state === 'ok');
  let note: string | null = null;

  // Claude↔GPT balance (§10-7: the existing chooseEngine rule — the other side has GPT_MARGIN_PCT more weekly left; these two only, never on hard).
  const first = ok[0];
  if (first && task.difficulty !== 'hard' && (first.engine === 'claude' || first.engine === 'codex')) {
    const other = ok.find((c) => c.engine === (first.engine === 'claude' ? 'codex' : 'claude'));
    const a = states.get(first)!.weeklyRemainingPct;
    const b = other ? states.get(other)!.weeklyRemainingPct : null;
    if (other && a !== null && b !== null && b >= a + GPT_MARGIN_PCT) {
      ok.splice(ok.indexOf(other), 1);
      ok.unshift(other);
      note = `${ENGINE_LABEL[first.engine]} 여유 ${a}% · ${ENGINE_LABEL[other.engine]} ${b}%`;
      why.push(`균형: ${note} → ${ROUTE_LABEL[other.model]}`);
    }
  }

  // 리셋 승격 (§10-7): Claude·GPT weekly only, last 15 % of the period, ≥ 50 % left, easy only.
  if (task.difficulty === 'easy' && ok.length > 1 && !resetSoon(states.get(ok[0]!)!, i.nowMs)) {
    const promo = ok.slice(1).find((c) => (c.engine === 'claude' || c.engine === 'codex') && resetSoon(states.get(c)!, i.nowMs));
    if (promo) {
      ok.splice(ok.indexOf(promo), 1);
      ok.unshift(promo);
      note = '곧 리셋되는 여유';
      why.push(`리셋 승격: ${ROUTE_LABEL[promo.model]} 주간 ${states.get(promo)!.weeklyRemainingPct}% 남음 · 리셋 임박`);
    }
  }

  const blockedBefore = (c: Cand) => cands.slice(0, cands.indexOf(c)).map((x) => states.get(x)!).find((s) => s.state !== 'ok')?.why;
  const pickNotes = (c: Cand, extra: string | null) => {
    const n: string[] = [];
    if (extra) n.push(extra);
    else if (cands.indexOf(c) > 0) { const b = blockedBefore(c); if (b) n.push(b); }
    if (c.note) n.push(c.note);
    return n;
  };

  if (ok.length > 0) return route(ok[0]!, pickNotes(ok[0]!, note));
  const head = cell[0]!;
  if (cands.includes(head) && states.get(head)!.state === 'unknown') return route(head, pickNotes(head, null));
  const blind = cands.find((c) => states.get(c)!.state === 'unknown');
  if (blind) return route(blind, pickNotes(blind, '한도 불명'));
  const lastResort = cands.find((c) => c.engine === 'grok' && states.get(c)!.state === 'ok');
  if (lastResort) return route(lastResort, pickNotes(lastResort, null));

  for (const c of cands) {
    if (c.engine === 'claude') for (const n of claude.notes) out('claude', n); // Fable and weekly causes too
    out(c.engine, states.get(c)!.why);
  }
  for (const e of ENGINES) {
    if (blockedWhy[e].length === 0) out(e, e === 'gemini' ? geminiAbsentWhy(task, i.cwdInsideHome) : task.difficulty === 'hard' ? '어려운 작업 후보 아님' : '이 작업 후보 아님');
  }
  const reasons = Object.fromEntries(ENGINES.map((e) => [e, blockedWhy[e].join(' · ')])) as Record<EngineKind, string>;
  return { kind: 'no_route', reasons };
}
