import { describe, expect, it } from 'vitest';
import { testRegistry } from '../../shared/accounts.testkit';
import { MODEL_EFFORTS, type AnyModel, type EngineKind } from '../../shared/models';
import type { AccountUsage, UsageSnapshot } from '../../shared/usage-types';
import {
  OBSERVATION_MAX_MS, RESET_WINDOW_FRACTION, WEEK_MS, chooseRoute, classifyTask, engineState, routeEffort, turnFits,
  type EngineLimits, type RouteDecision, type RouteInput, type Task,
} from './AutoRoute';
import { chooseAutoModel } from './AutoModel';

const NOW = Date.parse('2026-10-18T03:00:00Z');
const H = 3_600_000;
const ALL: EngineKind[] = ['claude', 'codex', 'gemini', 'grok'];

type ClaudeOpts = { weekly?: number; fable?: number | null; ageMs?: number; status?: AccountUsage['status']; resetInMs?: number; fiveHour?: number };
function acct(o: ClaudeOpts = {}): AccountUsage {
  const resetsAt = new Date(NOW + (o.resetInMs ?? 84 * H)).toISOString();
  return {
    status: o.status ?? 'ok',
    fetchedAt: new Date(NOW - (o.ageMs ?? 10_000)).toISOString(),
    fiveHour: { usedPct: o.fiveHour ?? 10, resetsAt: null },
    weekly: { usedPct: o.weekly ?? 40, resetsAt },
    fable: o.fable === null ? null : { usedPct: o.fable ?? 10, resetsAt },
  };
}
function claudeUsage(o: ClaudeOpts = {}): UsageSnapshot {
  return { generatedAt: new Date(NOW).toISOString(), deckReachable: true, accounts: { a: acct(o), b: acct(o), c: acct(o) } };
}

type LimitOpts = {
  claude?: ClaudeOpts;
  claudeUsage?: UsageSnapshot;
  claudeCooldown?: Record<string, number>;
  gpt?: Partial<EngineLimits['codex']>;
  gemini?: Partial<EngineLimits['gemini']>;
  grok?: Partial<EngineLimits['grok']>;
};
function limits(o: LimitOpts = {}): EngineLimits {
  return {
    claude: { usage: o.claudeUsage ?? claudeUsage(o.claude), cooldownUntilMs: o.claudeCooldown ?? {}, protectedAccount: null, accounts: testRegistry() },
    codex: { installed: true, weeklyUsedPct: 40, weeklyResetsAtMs: NOW + 84 * H, observedAtMs: NOW - 10_000, cooldownUntilMs: null, ...o.gpt },
    gemini: { installed: true, loggedIn: true, observedAtMs: NOW - 10_000, seats: [{ seat: 'g1', enabled: true, remainingPct: { pro: 80, flash: 80 } }], ...o.gemini },
    grok: { installed: true, cooldownUntilMs: null, lastError: null, ...o.grok },
  };
}

// Blocked presets. Claude is blocked only when every account is out (EXCLUDE_PCT 95): 85–94 % steps the model down instead.
const CLAUDE_BLOCKED: ClaudeOpts = { weekly: 95 };
const CB = 'Claude 쓸 계정 없음(주간 95%)';
const GPT_BLOCKED: Partial<EngineLimits['codex']> = { weeklyUsedPct: 90 };
const GEMINI_BLOCKED: Partial<EngineLimits['gemini']> = { seats: [{ seat: 'g1', enabled: true, remainingPct: { pro: 5, flash: 5 } }] };
const GROK_BLOCKED: Partial<EngineLimits['grok']> = { cooldownUntilMs: NOW + H };

// One prompt per cell (classification checked below).
const P = {
  explainEasy: '이 함수 이름 뭐야?',
  explainMedium: 'README 문서를 요약해줘\n' + '가나다 '.repeat(400),
  buildEasy: 'README 오타 고쳐줘',
  buildMedium: '로그인 페이지에 비밀번호 재설정 기능을 구현해줘',
  designHard: '멀티 계정 라우팅 구조를 새로 설계해줘. 쿨다운, 세션 이전, 캐시 보존을 모두 고려해야 해',
  explainHard: '이 인증 흐름에 보안 취약점이 있는지 검토해줘',
  buildHard: '테스트가 간헐적으로 실패하는데 원인을 모르겠어',
};

function input(text: string, over: Partial<RouteInput> = {}, lim: LimitOpts = {}): RouteInput {
  return {
    text, images: 0, engine: 'auto', model: 'auto', limits: limits(lim), nowMs: NOW, cwdInsideHome: true,
    autoEngines: ALL, consented: ['gemini', 'grok'], ...over,
  };
}
const route = (text: string, over: Partial<RouteInput> = {}, lim: LimitOpts = {}) => chooseRoute(input(text, over, lim));
function picked(d: RouteDecision): string {
  return d.kind === 'route' ? `${d.engine}/${d.model}/${d.effort}` : 'no_route';
}

describe('classifyTask', () => {
  it.each<[string, Task['kind'], Task['difficulty']]>([
    [P.explainEasy, 'explain', 'easy'],
    [P.explainMedium, 'explain', 'medium'],
    [P.buildEasy, 'build', 'easy'],
    [P.buildMedium, 'build', 'medium'],
    [P.designHard, 'design', 'hard'],
    [P.explainHard, 'explain', 'hard'],
    [P.buildHard, 'build', 'hard'],
    ['세션 목록 보여줘', 'explain', 'easy'],
    ['what does useElapsed return?', 'explain', 'easy'],
    ['summarize the README', 'explain', 'easy'],
    ['이 PR 리뷰해줘', 'explain', 'easy'],
    ['review this function for readability', 'explain', 'easy'],
    ['Design the architecture for a plugin system with sandboxed extensions', 'design', 'hard'],
    ['업로드할 때 500 에러가 나는 버그 고쳐줘', 'build', 'medium'],
    ['fix the bug where the sidebar loses its scroll position', 'build', 'medium'],
    ['rename fooBar to fooBaz in utils.ts', 'build', 'easy'],
    ['아키텍처 문서 어디 있어?', 'explain', 'easy'],
  ])('%s → %s · %s', (text, kind, difficulty) => {
    expect(classifyTask(text, { images: 0 })).toMatchObject({ kind, difficulty });
  });

  it('a review request is not build (no edit, no shell)', () => {
    for (const t of ['이 함수 리뷰해줘', '변경 내용 검토해줘', 'please review this function']) {
      expect(classifyTask(t, { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false, needsEdit: false });
    }
  });

  it('a question with a shell cue is build ("테스트 왜 실패해?")', () => {
    for (const t of ['테스트 왜 실패해?', 'why does the test fail?', '빌드 돌려 볼래?', 'git 로그 뭐야?', '$ npm test 결과 뭐야?']) {
      expect(classifyTask(t, { images: 0 })).toMatchObject({ kind: 'build', needsShell: true });
    }
  });

  // Review regressions: every one of these needs the shell (git, CI, lint, tsc, test runners, servers, verify) → build.
  it.each([
    'review the PR and push fixes', 'why is CI red?', 'show me the diff', 'list running processes', 'merge the PR',
    'typecheck this', 'fixing the lint errors',
    'PR 리뷰하고 코멘트 달아줘', '이거 고칠 수 있어?', 'CI 왜 빨간지 알려줘', 'lint 통과해?', 'tsc 돌리면 뭐 나와?',
    '타입 체크 통과하는지 확인해줘', 'vitest 결과 설명해줘', '현재 브랜치 뭐야?', '서버 켜져 있어?', '포트 3000 누가 쓰고 있어?',
    '검증해줘', '재현해 봐',
  ])('shell regression: %s → build · needsShell', (text) => {
    expect(classifyTask(text, { images: 0 })).toMatchObject({ kind: 'build', needsShell: true });
  });

  it('a trailing ? alone is no explain cue', () => {
    expect(classifyTask('이거 괜찮아?', { images: 0 })).toMatchObject({ kind: 'build', ambiguous: true });
  });

  it('a # line outside a sh/bash block is not shell (a comment / heading)', () => {
    expect(classifyTask('이 코드 설명해줘\n```py\n# compute the total\nx = 1\n```', { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false });
    expect(classifyTask('이 코드 설명해줘\n```\n# heading\n```', { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false });
    expect(classifyTask('이거 뭐야?\n```bash\n# whoami\n```', { images: 0 })).toMatchObject({ kind: 'build', needsShell: true });
  });

  it('explain and edit cues together → build', () => {
    expect(classifyTask('이 함수 설명하고 버그 고쳐줘', { images: 0 })).toMatchObject({ kind: 'build', needsEdit: true, needsShell: true });
  });

  it('a trivial edit writes a file but needs no shell', () => {
    expect(classifyTask(P.buildEasy, { images: 0 })).toMatchObject({ kind: 'build', needsEdit: true, needsShell: false });
  });

  it('ambiguous → build', () => {
    expect(classifyTask('계속', { images: 0 })).toMatchObject({ kind: 'build', needsShell: false, needsEdit: false, ambiguous: true });
    expect(classifyTask(P.buildMedium, { images: 0 }).ambiguous).toBe(false);
    expect(classifyTask('계속', { images: 0 }).why).toContain('종류 애매');
  });

  it('words inside quotes, code blocks and pasted logs are ignored', () => {
    expect(classifyTask('이 문장 무슨 뜻이야?\n> 버그 고쳐줘 그리고 테스트 돌려', { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false, needsEdit: false });
    expect(classifyTask('아래 코드 설명해줘\n```ts\nfunction fix() { /* bug: build test */ }\n```', { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false });
    expect(classifyTask('설명해줘\n2026-10-18T10:00:00 ERROR build failed\n    at foo (src/a.ts:1:2)', { images: 0 })).toMatchObject({ kind: 'explain', needsShell: false });
    // An unterminated fence is still quoted material.
    expect(classifyTask('요약해줘\n```\nfix the bug', { images: 0 })).toMatchObject({ kind: 'explain' });
    expect(classifyTask('요약해줘\n```\nfix the bug', { images: 0 }).why).toContain('인용 제외');
  });

  it('a code block that looks like shell counts as a shell cue', () => {
    expect(classifyTask('이거 뭐야?\n```\n$ npm test\n```', { images: 0 })).toMatchObject({ kind: 'build', needsShell: true });
    expect(classifyTask('```bash\nls -la\n```\n결과 설명해줘', { images: 0 })).toMatchObject({ kind: 'build', needsShell: true });
    expect(classifyTask('결과 설명해줘\n```\ngit status\n```', { images: 0 }).why).toContain('셸 명령 블록');
  });

  it('a long paste makes an easy question at least medium', () => {
    expect(classifyTask('이 로그 요약해줘?\n```\n' + 'line\n'.repeat(400) + '```', { images: 0 }).difficulty).toBe('medium');
  });

  it('image attachments set vision (a constraint, kind unchanged)', () => {
    const t = classifyTask('이 스크린샷 뭐야?', { images: 1 });
    expect(t).toMatchObject({ kind: 'explain', vision: true });
    expect(t.why).toContain('이미지 1개');
    expect(classifyTask('이 스크린샷 뭐야?', { images: 0 }).vision).toBe(false);
  });

  it('is deterministic', () => {
    expect(classifyTask(P.buildHard, { images: 2 })).toEqual(classifyTask(P.buildHard, { images: 2 }));
  });
});

describe('turnFits (§10-4)', () => {
  const t = (text: string, images = 0) => classifyTask(text, { images });
  it.each<[EngineKind, string, number, boolean, string | null]>([
    ['gemini', P.explainEasy, 0, true, null],
    ['gemini', '테스트 돌려서 고쳐줘', 0, true, '셸 실행'],
    ['gemini', P.buildEasy, 0, true, null],
    ['gemini', P.buildEasy, 0, false, '신뢰 폴더(HOME) 밖 파일 편집'],
    ['gemini', P.explainEasy, 0, false, null],
    ['gemini', '이 스크린샷 뭐야?', 1, true, null],
    ['grok', '이 스크린샷 뭐야?', 1, true, '이미지 입력'],
    ['grok', P.buildMedium, 0, false, null],
    ['claude', '테스트 돌려서 고쳐줘', 2, false, null],
    ['codex', '테스트 돌려서 고쳐줘', 2, false, null],
  ])('%s · %s (images %d, cwd in HOME %s) → %s', (engine, text, images, cwdInsideHome, need) => {
    expect(turnFits(engine, t(text, images), { cwdInsideHome })).toEqual(need === null ? { ok: true } : { ok: false, need });
  });

  it('a cue-less follow-up ("계속", "ㅇㅇ", "좋아") stays on Gemini; a design turn does not', () => {
    for (const x of ['계속', 'ㅇㅇ', '좋아']) expect(turnFits('gemini', t(x), { cwdInsideHome: false })).toEqual({ ok: true });
    expect(turnFits('gemini', t(P.designHard), { cwdInsideHome: true })).toEqual({ ok: false, need: '설명 외 작업(셸·편집 엔진)' });
  });

  it('an explain (Gemini) session that gets a build turn needs another engine', () => {
    expect(turnFits('gemini', t(P.explainEasy), { cwdInsideHome: true }).ok).toBe(true);
    expect(turnFits('gemini', t(P.buildMedium), { cwdInsideHome: true })).toEqual({ ok: false, need: '셸 실행' });
  });
});

describe('engineState', () => {
  const st = (engine: EngineKind, model: AnyModel, lim: LimitOpts, nowMs = NOW) => engineState(engine, model, limits(lim), nowMs).state;

  it('GPT: 85 % weekly and cooldown block; 15-minute observation boundary; unknown weekly', () => {
    expect(st('codex', 'gpt-6-sol', { gpt: { weeklyUsedPct: 84 } })).toBe('ok');
    expect(st('codex', 'gpt-6-sol', { gpt: { weeklyUsedPct: 85 } })).toBe('blocked');
    expect(st('codex', 'gpt-6-sol', { gpt: { cooldownUntilMs: NOW + 1 } })).toBe('blocked');
    expect(st('codex', 'gpt-6-sol', { gpt: { cooldownUntilMs: NOW } })).toBe('ok');
    expect(st('codex', 'gpt-6-sol', { gpt: { observedAtMs: NOW - OBSERVATION_MAX_MS } })).toBe('ok');
    expect(st('codex', 'gpt-6-sol', { gpt: { observedAtMs: NOW - OBSERVATION_MAX_MS - 1 } })).toBe('unknown');
    expect(st('codex', 'gpt-6-sol', { gpt: { observedAtMs: null } })).toBe('unknown');
    expect(st('codex', 'gpt-6-sol', { gpt: { weeklyUsedPct: null } })).toBe('unknown');
    expect(st('codex', 'gpt-6-sol', { gpt: { installed: false } })).toBe('blocked');
    expect(engineState('codex', 'gpt-6-sol', limits({ gpt: { weeklyUsedPct: 30 } }), NOW)).toMatchObject({ weeklyRemainingPct: 70, why: 'GPT 주간 30%' });
  });

  it('Gemini: per group, best enabled seat, < 15 % blocks, login, observation age', () => {
    const seats = (g1: { pro: number | null; flash: number | null }, g2?: { pro: number | null; flash: number | null }, g2on = true) =>
      ({ gemini: { seats: [{ seat: 'g1', enabled: true, remainingPct: g1 }, ...(g2 ? [{ seat: 'g2', enabled: g2on, remainingPct: g2 }] : [])] } });
    expect(st('gemini', 'gemini-pro', seats({ pro: 15, flash: 0 }))).toBe('ok');
    expect(st('gemini', 'gemini-pro', seats({ pro: 14, flash: 90 }))).toBe('blocked');
    expect(st('gemini', 'gemini-flash', seats({ pro: 14, flash: 90 }))).toBe('ok');
    expect(st('gemini', 'gemini-flash', seats({ pro: 90, flash: 14 }))).toBe('blocked');
    expect(st('gemini', 'gemini-pro', seats({ pro: 5, flash: 5 }, { pro: 60, flash: 60 }))).toBe('ok');
    expect(st('gemini', 'gemini-pro', seats({ pro: 5, flash: 5 }, { pro: 60, flash: 60 }, false))).toBe('blocked');
    expect(st('gemini', 'gemini-pro', seats({ pro: null, flash: null }))).toBe('unknown');
    expect(st('gemini', 'gemini-pro', { gemini: { loggedIn: false } })).toBe('blocked');
    expect(st('gemini', 'gemini-pro', { gemini: { installed: false } })).toBe('blocked');
    expect(st('gemini', 'gemini-pro', { gemini: { observedAtMs: NOW - OBSERVATION_MAX_MS } })).toBe('ok');
    expect(st('gemini', 'gemini-pro', { gemini: { observedAtMs: NOW - OBSERVATION_MAX_MS - 1 } })).toBe('unknown');
  });

  it('Grok: ok unless cooldown, an auth error or no binary', () => {
    expect(st('grok', 'grok-4.7', {})).toBe('ok');
    expect(st('grok', 'grok-4.7', { grok: { cooldownUntilMs: NOW + 1 } })).toBe('blocked');
    expect(st('grok', 'grok-4.7', { grok: { lastError: 'auth' } })).toBe('blocked');
    expect(st('grok', 'grok-4.7', { grok: { lastError: 'other' } })).toBe('ok');
    expect(st('grok', 'grok-4.7', { grok: { installed: false } })).toBe('blocked');
  });

  it('Claude: the router rules — blocked only when no account is left (EXCLUDE_PCT 95), Fable 80 % rule (Fable only)', () => {
    expect(st('claude', 'opus', { claude: { weekly: 84 } })).toBe('ok');
    expect(st('claude', 'opus', { claude: { weekly: 85 } })).toBe('ok');
    expect(st('claude', 'sonnet', { claude: { weekly: 94 } })).toBe('ok');
    expect(engineState('claude', 'opus', limits({ claude: { weekly: 88 } }), NOW)).toMatchObject({ state: 'ok', weeklyRemainingPct: 12 });
    expect(engineState('claude', 'opus', limits({ claude: { weekly: 95 } }), NOW)).toMatchObject({ state: 'blocked', why: CB });
    expect(engineState('claude', 'opus', limits({ claude: { fiveHour: 95 } }), NOW)).toMatchObject({ state: 'blocked', why: 'Claude 쓸 계정 없음(5h 95%)' });
    expect(st('claude', 'fable', { claude: { fable: 79 } })).toBe('ok');
    expect(st('claude', 'fable', { claude: { fable: 80 } })).toBe('blocked');
    expect(st('claude', 'opus', { claude: { fable: 80 } })).toBe('ok');
    expect(engineState('claude', 'fable', limits({ claude: { fable: 90 } }), NOW).why).toBe('Fable 80%↑');
    // the best account decides: one account with room is enough
    const mixed: UsageSnapshot = { ...claudeUsage({ weekly: 90 }), accounts: { a: acct({ weekly: 90 }), b: acct({ weekly: 30 }), c: acct({ weekly: 90 }) } };
    expect(engineState('claude', 'opus', limits({ claudeUsage: mixed }), NOW)).toMatchObject({ state: 'ok', weeklyRemainingPct: 70 });
    // staleness: the router's stale / trustUntil rules, not the 15-minute observation line
    expect(st('claude', 'opus', { claude: { ageMs: OBSERVATION_MAX_MS + 60_000 } })).toBe('ok');
    expect(st('claude', 'opus', { claude: { status: 'stale', ageMs: 11 * 60_000 } })).toBe('unknown');
    expect(st('claude', 'opus', { claude: { status: 'stale', ageMs: 9 * 60_000 } })).toBe('ok');
    const trustedStale = { ...acct({ status: 'stale', ageMs: 60 * 60_000 }), trustUntil: new Date(NOW + H).toISOString() };
    expect(st('claude', 'opus', { claudeUsage: { ...claudeUsage(), accounts: { a: trustedStale, b: trustedStale, c: trustedStale } } })).toBe('ok');
    expect(st('claude', 'opus', { claude: { status: 'down' } })).toBe('unknown');
    expect(st('claude', 'opus', { claudeCooldown: { a: NOW + H, b: NOW + H, c: NOW + H } })).toBe('blocked');
  });

  it('Claude lax (never had usage-deck): unknown alone is ok, with no remaining % (no balance)', () => {
    const lax: UsageSnapshot = { ...claudeUsage({ status: 'down' }), usageSource: 'none' };
    expect(engineState('claude', 'opus', limits({ claudeUsage: lax }), NOW)).toMatchObject({ state: 'ok', weeklyRemainingPct: null });
  });
});

describe('chooseRoute — table (§4 + §10)', () => {
  it.each<[string, string, string]>([
    ['explain · easy', P.explainEasy, 'claude/sonnet/medium'],
    ['explain · medium', P.explainMedium, 'claude/opus/high'],
    ['build · easy', P.buildEasy, 'claude/sonnet/medium'],
    ['build · medium', P.buildMedium, 'claude/opus/high'],
    ['design · hard', P.designHard, 'claude/fable/high'],
    ['explain · hard', P.explainHard, 'claude/fable/high'],
    ['build · hard', P.buildHard, 'claude/fable/high'],
  ])('%s → first choice %s', (_cell, text, want) => {
    expect(picked(route(text))).toBe(want);
  });

  // Each step blocks one more candidate: the chain must walk the cell in order and end in no_route.
  it.each<[string, string, Array<[LimitOpts, string]>]>([
    ['explain · easy', P.explainEasy, [
      [{ claude: CLAUDE_BLOCKED }, 'gemini/gemini-flash/low'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED }, 'codex/gpt-6-sol/low'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED, gpt: GPT_BLOCKED }, 'grok/grok-4.7/low'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED }, 'no_route'],
    ]],
    ['explain · medium', P.explainMedium, [
      [{ claude: CLAUDE_BLOCKED }, 'gemini/gemini-pro/medium'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED }, 'codex/gpt-6-sol/medium'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED, gpt: GPT_BLOCKED }, 'grok/grok-4.7/medium'],
      [{ claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED }, 'no_route'],
    ]],
    ['build · easy', P.buildEasy, [
      [{ claude: CLAUDE_BLOCKED }, 'codex/gpt-6-sol/low'],
      [{ claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED }, 'grok/grok-4.7/low'],
      [{ claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED }, 'no_route'],
    ]],
    ['build · medium', P.buildMedium, [
      [{ claude: CLAUDE_BLOCKED }, 'codex/gpt-6-sol/medium'],
      [{ claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED }, 'grok/grok-4.7/medium'],
      [{ claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED }, 'no_route'],
    ]],
    ['design · hard', P.designHard, [
      [{ claude: { fable: 85 } }, 'codex/gpt-6-astra/high'],
      [{ claude: { fable: 85 }, gpt: GPT_BLOCKED }, 'claude/opus/high'],
      [{ claude: { fable: 85, weekly: 95 }, gpt: GPT_BLOCKED }, 'no_route'],
    ]],
    ['explain · hard', P.explainHard, [
      [{ claude: { fable: 85 } }, 'codex/gpt-6-astra/high'],
      [{ claude: { fable: 85 }, gpt: GPT_BLOCKED }, 'claude/opus/high'],
      [{ claude: { fable: 85, weekly: 95 }, gpt: GPT_BLOCKED }, 'gemini/gemini-pro/high'],
      [{ claude: { fable: 85, weekly: 95 }, gpt: GPT_BLOCKED, gemini: GEMINI_BLOCKED }, 'no_route'],
    ]],
  ])('%s: blocked first choices fall through in table order', (_cell, text, steps) => {
    for (const [lim, want] of steps) expect(picked(route(text, {}, lim))).toBe(want);
  });

  it('hard never goes to Grok, and Gemini only for explain (badge says 읽기 전용 분석)', () => {
    const allButGrok: LimitOpts = { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, gemini: GEMINI_BLOCKED };
    expect(route(P.designHard, {}, allButGrok)).toMatchObject({ kind: 'no_route', reasons: { grok: '어려운 작업 후보 아님' } });
    expect(route(P.buildHard, {}, { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED })).toMatchObject({ kind: 'no_route' });
    const d = route(P.explainHard, {}, { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED });
    expect(d).toMatchObject({ kind: 'route', engine: 'gemini', model: 'gemini-pro', effort: 'high' });
    expect(d.kind === 'route' && d.reason).toContain('읽기 전용 분석');
  });

  it('build never goes to Gemini (no shell)', () => {
    const d = route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED });
    expect(d).toEqual({ kind: 'no_route', reasons: { claude: CB, codex: 'GPT 주간 90%', gemini: '셸 필요', grok: 'Grok 쿨다운 중' } });
    // a question with a shell cue is build too: Gemini is left out
    expect(picked(route('테스트 왜 실패해?', {}, { claude: CLAUDE_BLOCKED }))).toBe('codex/gpt-6-sol/low');
  });

  it('vision drops Grok', () => {
    const lim: LimitOpts = { claude: CLAUDE_BLOCKED, gemini: GEMINI_BLOCKED, gpt: GPT_BLOCKED };
    expect(picked(route(P.explainEasy, {}, lim))).toBe('grok/grok-4.7/low');
    const d = route(P.explainEasy, { images: 1 }, lim);
    expect(d).toMatchObject({ kind: 'no_route', reasons: { grok: '이미지 입력 불가' } });
    expect(route('이 스크린샷 뭐야?', { images: 1 })).toMatchObject({ kind: 'route', engine: 'claude', reason: '자동 · 설명 · 이미지 첨부 → Claude Sonnet' });
  });

  it('badge: Claude 88 % → GPT by the balance; Claude kept → its step-down is named', () => {
    expect(route(P.buildMedium, {}, { claude: { weekly: 88 } })).toMatchObject({ kind: 'route', reason: '자동 · 구현 · Claude 여유 12% · GPT 60% → GPT Sol' });
    expect(route(P.buildMedium, {}, { claude: { weekly: 88 }, gpt: { weeklyUsedPct: 80 } })).toMatchObject({ engine: 'claude', model: 'sonnet', effort: 'medium', reason: '자동 · 구현 · Claude 주간 88% → Claude Sonnet' });
    expect(route(P.buildMedium)).toMatchObject({ reason: '자동 · 구현 → Claude Opus' });
  });

  it('hard: Fable out → GPT Astra before a lower Claude (the one exception), with the cause in the badge', () => {
    expect(route(P.designHard, {}, { claude: { fable: 85 } })).toMatchObject({ engine: 'codex', model: 'gpt-6-astra', effort: 'high', reason: '자동 · 설계 · Fable 80%↑ → GPT Astra' });
    expect(route(P.designHard, {}, { claude: { weekly: 88 } })).toMatchObject({ engine: 'codex', model: 'gpt-6-astra', reason: '자동 · 설계 · Claude 주간 88% → GPT Astra' });
    expect(route(P.designHard, {}, { claude: { weekly: 88 }, gpt: GPT_BLOCKED })).toMatchObject({ engine: 'claude', model: 'opus', effort: 'high' });
  });

  it('autoEngines: an engine turned off is not a candidate', () => {
    expect(picked(route(P.explainEasy, { autoEngines: ['codex', 'gemini', 'grok'] }))).toBe('gemini/gemini-flash/low');
    expect(picked(route(P.explainEasy, { autoEngines: ['codex', 'grok'] }))).toBe('codex/gpt-6-sol/low');
    const d = route(P.explainEasy, { autoEngines: [] });
    expect(d).toEqual({ kind: 'no_route', reasons: { claude: '자동에 쓸 엔진에서 꺼짐', codex: '자동에 쓸 엔진에서 꺼짐', gemini: '자동에 쓸 엔진에서 꺼짐', grok: '자동에 쓸 엔진에서 꺼짐' } });
  });

  it('consent: Gemini and Grok are left out until their card is accepted', () => {
    const lim: LimitOpts = { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED };
    expect(picked(route(P.explainEasy, {}, lim))).toBe('gemini/gemini-flash/low');
    expect(picked(route(P.explainEasy, { consented: ['grok'] }, lim))).toBe('grok/grok-4.7/low');
    expect(route(P.explainEasy, { consented: [] }, lim)).toMatchObject({ kind: 'no_route', reasons: { gemini: '외부 전송 동의 전', grok: '외부 전송 동의 전' } });
  });

  it('capability: not installed / not logged in is a filter, before the limit state', () => {
    const lim: LimitOpts = { claude: CLAUDE_BLOCKED, gemini: { loggedIn: false }, gpt: { installed: false }, grok: { installed: false } };
    expect(route(P.explainEasy, {}, lim)).toEqual({ kind: 'no_route', reasons: { claude: CB, codex: 'codex CLI 없음', gemini: 'Gemini 로그인 없음', grok: 'grok CLI 없음' } });
  });

  it('cwd outside HOME: a plain question still may go to Gemini', () => {
    expect(picked(route(P.explainEasy, { cwdInsideHome: false }, { claude: CLAUDE_BLOCKED }))).toBe('gemini/gemini-flash/low');
  });
});

describe('chooseRoute — unknown (§10-6)', () => {
  it('ok candidates first, in order', () => {
    expect(picked(route(P.buildMedium, {}, { claude: { status: 'down' } }))).toBe('codex/gpt-6-sol/medium');
  });
  it('no ok candidate: the first candidate when unknown (no 한도 불명 note)', () => {
    const d = route(P.buildMedium, {}, { claude: { status: 'down' }, gpt: GPT_BLOCKED, grok: GROK_BLOCKED });
    expect(d).toMatchObject({ kind: 'route', engine: 'claude', model: 'opus', reason: '자동 · 구현 → Claude Opus' });
  });
  it('then the other unknowns, with 한도 불명', () => {
    const d = route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED, gpt: { weeklyUsedPct: null }, grok: GROK_BLOCKED });
    expect(d).toMatchObject({ kind: 'route', engine: 'codex', reason: '자동 · 구현 · 한도 불명 → GPT Sol' });
  });
  it('an observation just over 15 minutes old is unknown', () => {
    const lim = (age: number): LimitOpts => ({ claude: CLAUDE_BLOCKED, gpt: { observedAtMs: NOW - age }, grok: GROK_BLOCKED });
    expect(route(P.buildMedium, {}, lim(OBSERVATION_MAX_MS))).toMatchObject({ engine: 'codex', reason: `자동 · 구현 · ${CB} → GPT Sol` });
    expect(route(P.buildMedium, {}, lim(OBSERVATION_MAX_MS + 1))).toMatchObject({ engine: 'codex', reason: '자동 · 구현 · 한도 불명 → GPT Sol' });
  });
});

describe('chooseRoute — Grok is the very last resort', () => {
  it('every unknown comes before an ok Grok', () => {
    // the cell's first (Claude) unknown → Claude, no note
    expect(route(P.buildMedium, {}, { claude: { status: 'down' }, gpt: GPT_BLOCKED })).toMatchObject({ engine: 'claude', model: 'opus', reason: '자동 · 구현 → Claude Opus' });
    // the other unknowns → 한도 불명
    expect(route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED, gpt: { weeklyUsedPct: null } })).toMatchObject({ engine: 'codex', reason: '자동 · 구현 · 한도 불명 → GPT Sol' });
    expect(route(P.explainEasy, {}, { claude: CLAUDE_BLOCKED, gemini: { observedAtMs: null }, gpt: GPT_BLOCKED })).toMatchObject({ engine: 'gemini', reason: '자동 · 설명 · 한도 불명 → Gemini Flash' });
    // then Grok
    expect(picked(route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED }))).toBe('grok/grok-4.7/medium');
  });
  it('"the first entry" is the table order before filters: Claude filtered out → GPT unknown is 한도 불명', () => {
    expect(route(P.buildMedium, { autoEngines: ['codex', 'grok'] }, { gpt: { weeklyUsedPct: null } })).toMatchObject({ engine: 'codex', reason: '자동 · 구현 · 한도 불명 → GPT Sol' });
  });
});

describe('chooseRoute — Claude↔GPT balance (§10-7, the existing chooseEngine rule)', () => {
  it.each<[number, number, string]>([
    [75, 40, 'codex/gpt-6-sol/medium'], // Claude 25 % left, GPT 60 ≥ 25 + 10
    [71, 61, 'codex/gpt-6-sol/medium'], // 29 left, GPT 39 = 29 + 10: exactly the margin
    [71, 62, 'claude/opus/high'], // GPT 38 < 39
    [40, 30, 'codex/gpt-6-sol/medium'], // no low-water line (the existing chooseEngine rule): 60 left vs GPT 70
    [40, 31, 'claude/opus/high'], // GPT 69 < 70
    [88, 77, 'codex/gpt-6-sol/medium'], // Claude 12 left (Sonnet), GPT 23 ≥ 22
    [88, 79, 'claude/sonnet/medium'], // GPT 21 < 22: Claude, one step down (chooseAutoModel)
    [94, 84, 'codex/gpt-6-sol/medium'], // 6 left, GPT 16 ≥ 16
  ])('build · medium: Claude weekly %d, GPT %d → %s', (cw, gw, want) => {
    expect(picked(route(P.buildMedium, {}, { claude: { weekly: cw }, gpt: { weeklyUsedPct: gw } }))).toBe(want);
  });

  it('lax Claude (no usage-deck): Claude, no balance against GPT', () => {
    const lax: UsageSnapshot = { ...claudeUsage({ status: 'down' }), usageSource: 'none' };
    expect(picked(route(P.buildMedium, {}, { claudeUsage: lax, gpt: { weeklyUsedPct: 0 } }))).toBe('claude/opus/high');
    expect(picked(route(P.designHard, {}, { claudeUsage: lax }))).toBe('claude/fable/high');
  });

  it('badge names both sides', () => {
    expect(route(P.buildMedium, {}, { claude: { weekly: 75 }, gpt: { weeklyUsedPct: 40 } })).toMatchObject({ reason: '자동 · 구현 · Claude 여유 25% · GPT 60% → GPT Sol' });
  });

  it('never on hard (quality first)', () => {
    expect(route(P.designHard, {}, { claude: { weekly: 75 }, gpt: { weeklyUsedPct: 10 } })).toMatchObject({ engine: 'claude', model: 'fable' });
  });

  it('no balance against other vendors (explain: Gemini is not compared by %)', () => {
    expect(route(P.explainMedium, {}, { claude: { weekly: 80 }, gpt: GPT_BLOCKED })).toMatchObject({ engine: 'claude' });
  });

  it('GPT unknown or blocked: no balance move', () => {
    expect(route(P.buildMedium, {}, { claude: { weekly: 80 }, gpt: { weeklyUsedPct: null } })).toMatchObject({ engine: 'claude' });
    expect(route(P.buildMedium, {}, { claude: { weekly: 80 }, gpt: { weeklyUsedPct: 5, cooldownUntilMs: NOW + H } })).toMatchObject({ engine: 'claude' });
  });
});

describe('chooseRoute — 리셋 승격 (§10-7)', () => {
  const window = RESET_WINDOW_FRACTION * WEEK_MS; // 25.2 h
  const gpt = (resetInMs: number, used = 40): LimitOpts => ({ gpt: { weeklyUsedPct: used, weeklyResetsAtMs: NOW + resetInMs } });

  it.each<[string, number, number, string]>([
    ['inside the last 15 %', 20 * H, 40, 'codex'],
    ['at the window edge', window, 40, 'codex'],
    ['just before the window', window + 1, 40, 'claude'],
    ['50 % left', 20 * H, 50, 'codex'],
    ['49 % left', 20 * H, 51, 'claude'],
    ['reset already passed', -1, 40, 'claude'],
  ])('explain · easy, GPT %s → %s', (_n, resetIn, used, engine) => {
    expect(route(P.explainEasy, {}, gpt(resetIn, used))).toMatchObject({ engine });
  });

  it('jumps over Gemini and says so', () => {
    expect(route(P.explainEasy, {}, gpt(20 * H))).toMatchObject({ engine: 'codex', model: 'gpt-6-sol', effort: 'low', reason: '자동 · 설명 · 곧 리셋되는 여유 → GPT Sol' });
    expect(route(P.buildEasy, {}, gpt(20 * H))).toMatchObject({ engine: 'codex', reason: '자동 · 구현 · 곧 리셋되는 여유 → GPT Sol' });
  });

  it('easy only', () => {
    expect(route(P.buildMedium, {}, gpt(20 * H))).toMatchObject({ engine: 'claude' });
    expect(route(P.designHard, {}, gpt(20 * H))).toMatchObject({ engine: 'claude' });
  });

  it('not when the first choice is itself in its reset window', () => {
    expect(route(P.explainEasy, {}, { ...gpt(20 * H), claude: { weekly: 30, resetInMs: 10 * H } })).toMatchObject({ engine: 'claude' });
  });

  it('a Claude window promotes Claude back over a balance move', () => {
    // Order: balance first, promotion after. Claude 25 % left → GPT; no Claude promotion (needs ≥ 50 %).
    expect(route(P.buildEasy, {}, { claude: { weekly: 75, resetInMs: 10 * H }, gpt: { weeklyUsedPct: 40 } })).toMatchObject({ engine: 'codex' });
  });
});

describe('chooseRoute — reorder order (§10-7: capability → autoEngines → state → balance → promotion → table)', () => {
  const soon: LimitOpts = { gpt: { weeklyUsedPct: 40, weeklyResetsAtMs: NOW + 20 * H } };
  it('an engine filtered out earlier is never promoted', () => {
    expect(route(P.explainEasy, { autoEngines: ['claude', 'gemini', 'grok'] }, soon)).toMatchObject({ engine: 'claude' });
    expect(route(P.explainEasy, {}, { gpt: { ...soon.gpt, cooldownUntilMs: NOW + H } })).toMatchObject({ engine: 'claude' });
    expect(route(P.explainEasy, {}, { gpt: { ...soon.gpt, installed: false } })).toMatchObject({ engine: 'claude' });
  });
  it('a stale observation is unknown, not promoted', () => {
    expect(route(P.explainEasy, {}, { gpt: { ...soon.gpt, observedAtMs: NOW - OBSERVATION_MAX_MS - 1 } })).toMatchObject({ engine: 'claude' });
  });
  it('Grok has no observation: ok, but never balanced or promoted', () => {
    expect(route(P.buildEasy, {}, { claude: { weekly: 75 }, gpt: GPT_BLOCKED })).toMatchObject({ engine: 'claude' });
  });
});

describe('chooseRoute — engine and model, direct or 자동 (§7, §10-11)', () => {
  it('자동 + 자동: the whole table', () => {
    expect(picked(route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED }))).toBe('codex/gpt-6-sol/medium');
  });

  it.each<[EngineKind, string, string]>([
    ['grok', P.buildEasy, 'grok/grok-4.7/low'],
    ['grok', P.buildMedium, 'grok/grok-4.7/medium'],
    ['grok', P.designHard, 'grok/grok-4.7/high'],
    ['gemini', P.explainEasy, 'gemini/gemini-flash/low'],
    ['gemini', P.explainMedium, 'gemini/gemini-pro/medium'],
    ['gemini', P.buildMedium, 'gemini/gemini-pro/medium'],
    ['gemini', P.explainHard, 'gemini/gemini-pro/high'],
    ['codex', P.buildEasy, 'codex/gpt-6-sol/low'],
    ['codex', P.designHard, 'codex/gpt-6-astra/high'],
    ['claude', P.explainEasy, 'claude/sonnet/medium'],
    ['claude', P.designHard, 'claude/fable/high'],
  ])('engine %s + model 자동: that engine\'s column (%s) → %s', (engine, text, want) => {
    expect(picked(route(text, { engine }))).toBe(want);
  });

  it('engine picked + model 자동: the pick wins over limits, filters and autoEngines', () => {
    expect(picked(route(P.buildMedium, { engine: 'grok', autoEngines: ['claude'], consented: [] }, { grok: GROK_BLOCKED }))).toBe('grok/grok-4.7/medium');
    expect(route(P.buildMedium, { engine: 'grok' })).toMatchObject({ reason: '자동 · 구현 · Grok 지정 → Grok 4.7' });
  });

  it('review #5: engine 지정 + model 자동, but the engine is not even available (codex not installed) → falls back to Claude, with the reason shown', () => {
    const claudeFallback = chooseAutoModel({ text: P.buildMedium, attachmentCount: 0, usage: limits({}).claude.usage, nowMs: NOW, cooldownUntilMs: {}, protectedAccount: null, accounts: testRegistry() });
    expect(picked(route(P.buildMedium, { engine: 'codex' }, { gpt: { installed: false } }))).toBe(`claude/${claudeFallback.model}/${claudeFallback.effort}`);
    expect(route(P.buildMedium, { engine: 'codex' }, { gpt: { installed: false } })).toMatchObject({ engine: 'claude', reason: expect.stringMatching(/GPT 지정.*codex CLI 없음.*→ Claude/) });
    // Unavailability (installed/logged in) ≠ capacity blocked: a cooldown-blocked but installed engine still sticks (unchanged above).
    expect(picked(route(P.buildMedium, { engine: 'gemini' }, { gemini: { installed: false } }))).toBe(`claude/${claudeFallback.model}/${claudeFallback.effort}`);
  });

  // Claude picked + model 자동 = chooseAutoModel, exactly (model and effort).
  it.each<[string, string, ClaudeOpts, string]>([
    ['hard', P.designHard, {}, 'fable'],
    ['hard · 88', P.designHard, { weekly: 88 }, 'opus'],
    ['hard · 88 · Fable 85', P.designHard, { weekly: 88, fable: 85 }, 'sonnet'],
    ['hard · Fable 85', P.designHard, { fable: 85 }, 'opus'],
    ['medium · 88', P.buildMedium, { weekly: 88 }, 'sonnet'],
    ['medium · 94', P.buildMedium, { weekly: 94 }, 'sonnet'],
    ['easy · 88', P.buildEasy, { weekly: 88 }, 'sonnet'],
    ['medium · 95 (no account)', P.buildMedium, { weekly: 95 }, 'opus'],
    ['hard · Fable unknown (deck)', P.designHard, { fable: null }, 'opus'],
  ])('engine Claude + model 자동 = chooseAutoModel: %s → %s', (_n, text, claude, model) => {
    const lim = limits({ claude });
    const want = chooseAutoModel({ text, attachmentCount: 0, usage: lim.claude.usage, nowMs: NOW, cooldownUntilMs: {}, protectedAccount: null, accounts: testRegistry() });
    expect(want.model).toBe(model);
    expect(route(text, { engine: 'claude' }, { claude })).toMatchObject({ engine: 'claude', model: want.model, effort: want.effort, fit: { ok: true } });
  });

  it('engine Claude + model 자동 on hard: Fable at its cap → Opus inside the column', () => {
    expect(route(P.designHard, { engine: 'claude' }, { claude: { fable: 85 } })).toMatchObject({ model: 'opus', reason: '자동 · 설계 · Claude 지정 · Fable 80%↑ → Claude Opus' });
  });

  it('a picked model is used as it is, engine 자동 or not', () => {
    expect(picked(route(P.buildMedium, { model: 'gpt-6-astra' }, { gpt: GPT_BLOCKED }))).toBe('codex/gpt-6-astra/medium');
    expect(picked(route(P.buildMedium, { engine: 'claude', model: 'sonnet' }))).toBe('claude/sonnet/medium');
    expect(route(P.explainEasy, { model: 'gemini-flash' })).toMatchObject({ engine: 'gemini', reason: '자동 · 설명 · Gemini Flash 지정 → Gemini Flash' });
  });

  it('a picked effort is kept with a picked model, clamped down to MODEL_EFFORTS', () => {
    expect(picked(route(P.buildMedium, { model: 'gpt-6-sol', effort: 'xhigh' }))).toBe('codex/gpt-6-sol/xhigh');
    expect(picked(route(P.explainEasy, { model: 'gemini-pro', effort: 'xhigh' }))).toBe('gemini/gemini-pro/high');
    expect(picked(route(P.buildMedium, { model: 'grok-4.5', effort: 'low' }))).toBe('grok/grok-4.5/low');
    // engine picked + model 자동: the effort stays automatic
    expect(picked(route(P.buildMedium, { engine: 'codex', effort: 'xhigh' }))).toBe('codex/gpt-6-sol/medium');
  });

  it('fit: picked engine / model paths say what the engine lacks for this turn', () => {
    expect(route(P.buildMedium, { model: 'gemini-flash' })).toMatchObject({ engine: 'gemini', fit: { ok: false, need: '셸 실행' } });
    expect(route(P.buildMedium, { engine: 'gemini' })).toMatchObject({ engine: 'gemini', fit: { ok: false, need: '셸 실행' } });
    expect(route('이 스크린샷 뭐야?', { engine: 'grok', images: 1 })).toMatchObject({ fit: { ok: false, need: '이미지 입력' } });
    expect(route(P.explainEasy, { model: 'gemini-flash' })).toMatchObject({ fit: { ok: true } });
    expect(route(P.buildMedium, { engine: 'codex' })).toMatchObject({ fit: { ok: true } });
    // full auto carries no fit (the filters already applied it)
    expect('fit' in route(P.buildMedium)).toBe(false);
  });
});

describe('chooseRoute — commander (§1, §10-10)', () => {
  it('Claude only, whatever the limits elsewhere', () => {
    expect(picked(route(P.buildMedium, { commander: true }, { claude: { weekly: 75 }, gpt: { weeklyUsedPct: 0 } }))).toBe('claude/opus/high');
    expect(picked(route(P.buildMedium, { commander: true, autoEngines: ['codex'] }))).toBe('claude/opus/high');
    expect(picked(route(P.designHard, { commander: true }, { claude: { fable: 85 } }))).toBe('claude/opus/high');
    expect(picked(route(P.buildMedium, { commander: true, engine: 'codex' }))).toBe('claude/opus/high');
    expect(picked(route(P.buildMedium, { commander: true, excludeEngines: ['claude'] }))).toBe('claude/opus/high');
  });
  it('Claude 85–94 %: not blocked — the model steps down (chooseAutoModel)', () => {
    expect(route(P.buildMedium, { commander: true }, { claude: { weekly: 88 } })).toMatchObject({ engine: 'claude', model: 'sonnet', effort: 'medium', reason: '자동 · 구현 · 총사령탑 · Claude 주간 88% → Claude Sonnet' });
    expect(picked(route(P.designHard, { commander: true }, { claude: { weekly: 88 } }))).toBe('claude/opus/high');
  });
  it('a non-Claude model picked is ignored (said in why) and Claude goes 자동; a Claude model is kept', () => {
    const d = route(P.buildMedium, { commander: true, engine: 'codex', model: 'gpt-6-astra' });
    expect(picked(d)).toBe('claude/opus/high');
    expect(d.kind === 'route' && d.why.join('\n')).toContain('GPT Astra 지정 무시: 총사령탑 턴은 Claude 만');
    expect(picked(route(P.buildMedium, { commander: true, model: 'gemini-pro' }, { claude: { weekly: 88 } }))).toBe('claude/sonnet/medium');
    expect(picked(route(P.buildMedium, { commander: true, model: 'fable' }))).toBe('claude/fable/high');
    expect(picked(route(P.buildMedium, { commander: true, model: 'opus', effort: 'low' }))).toBe('claude/opus/low');
    expect('fit' in route(P.buildMedium, { commander: true, model: 'opus' })).toBe(false);
  });
  it('Claude all blocked → no_route (never another engine)', () => {
    expect(route(P.buildMedium, { commander: true }, { claude: CLAUDE_BLOCKED })).toEqual({
      kind: 'no_route',
      reasons: { claude: CB, codex: '총사령탑 턴은 Claude 만', gemini: '총사령탑 턴은 Claude 만', grok: '총사령탑 턴은 Claude 만' },
    });
  });
});

describe('chooseRoute — 이어가기 candidates (§10-8)', () => {
  it('an image session never continues on Grok', () => {
    expect(picked(route(P.buildMedium, { images: 1, excludeEngines: ['claude'] }))).toBe('codex/gpt-6-sol/medium');
    expect(route(P.buildMedium, { images: 1, excludeEngines: ['claude'] }, { gpt: GPT_BLOCKED })).toMatchObject({
      kind: 'no_route', reasons: { claude: '이어가기 대상 아님(지금 엔진)', grok: '이미지 입력 불가' },
    });
    expect(picked(route(P.buildMedium, { excludeEngines: ['claude'] }, { gpt: GPT_BLOCKED }))).toBe('grok/grok-4.7/medium');
  });
});

describe('chooseRoute — Grok Fast setting (§10-1)', () => {
  const grokOnly: LimitOpts = { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED };
  it('4.7 by default, build-fast only when the setting is on', () => {
    expect(picked(route(P.buildMedium, {}, grokOnly))).toBe('grok/grok-4.7/medium');
    expect(picked(route(P.buildMedium, { grokFast: true }, grokOnly))).toBe('grok/grok-4.7-build-fast/medium');
    expect(picked(route(P.buildEasy, { engine: 'grok', grokFast: true }))).toBe('grok/grok-4.7-build-fast/low');
  });
});

describe('chooseRoute — determinism and no_route', () => {
  it('the same input gives the same result and is not mutated', () => {
    const i = input(P.explainEasy, {}, { claude: { weekly: 75 }, gpt: { weeklyUsedPct: 40, weeklyResetsAtMs: NOW + 20 * H } });
    const snap = JSON.stringify({ ...i, limits: { ...i.limits, claude: { ...i.limits.claude, accounts: null } } });
    const a = chooseRoute(i);
    expect(chooseRoute(i)).toEqual(a);
    expect(JSON.stringify({ ...i, limits: { ...i.limits, claude: { ...i.limits.claude, accounts: null } } })).toBe(snap);
  });

  it('everything blocked → no_route with a reason per engine', () => {
    const d = route(P.explainEasy, {}, { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, gemini: GEMINI_BLOCKED, grok: GROK_BLOCKED });
    expect(d).toEqual({ kind: 'no_route', reasons: { claude: CB, codex: 'GPT 주간 90%', gemini: 'Gemini Flash 남은 5%', grok: 'Grok 쿨다운 중' } });
  });

  it('hard: Claude reasons name both Fable and Opus causes', () => {
    const d = route(P.designHard, {}, { claude: { fable: 85, weekly: 95 }, gpt: GPT_BLOCKED });
    expect(d).toEqual({ kind: 'no_route', reasons: { claude: `Fable 80%↑ · ${CB}`, codex: 'GPT 주간 90%', gemini: '어려운 작업은 설명만', grok: '어려운 작업 후보 아님' } });
  });

  it('no_route: Gemini\'s reason names the real cause', () => {
    const none: LimitOpts = { claude: CLAUDE_BLOCKED, gpt: GPT_BLOCKED, grok: GROK_BLOCKED };
    expect(route(P.buildMedium, {}, none)).toMatchObject({ reasons: { gemini: '셸 필요' } });
    expect(route('README 오타 고쳐줘', { cwdInsideHome: false }, none)).toMatchObject({ reasons: { gemini: '신뢰 폴더(HOME) 밖 편집' } });
    expect(route('계속', {}, none)).toMatchObject({ reasons: { gemini: '설명 단서 없음' } });
  });

  it('route carries a why trail', () => {
    const d = route(P.buildMedium, {}, { claude: CLAUDE_BLOCKED });
    expect(d.kind === 'route' && d.why[0]).toMatch(/^분류: 구현/);
    expect(d.kind === 'route' && d.why.join('\n')).toContain(`Claude Opus: blocked (${CB})`);
  });
});

describe('routeEffort (§4)', () => {
  it('Claude keeps AUTO_EFFORT; others by difficulty; always a supported value', () => {
    expect(routeEffort('sonnet', 'easy')).toBe('medium');
    expect(routeEffort('opus', 'medium')).toBe('high');
    expect(routeEffort('fable', 'hard')).toBe('high');
    expect(routeEffort('gpt-6-sol', 'easy')).toBe('low');
    expect(routeEffort('gpt-6-astra', 'hard')).toBe('high');
    expect(routeEffort('gemini-pro', 'hard')).toBe('high');
    expect(routeEffort('grok-4.5', 'hard')).toBe('high');
    for (const m of Object.keys(MODEL_EFFORTS) as AnyModel[]) {
      for (const d of ['easy', 'medium', 'hard'] as const) expect(MODEL_EFFORTS[m]).toContain(routeEffort(m, d));
    }
  });
});
