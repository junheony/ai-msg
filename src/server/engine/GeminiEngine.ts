import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { GEMINI_ACCOUNTS, geminiEnv, geminiSeatHome, type GeminiAccount } from '../../shared/accounts';
import { ensureGeminiSeatHome } from './geminiHome';
import { GEMINI_CLI_ALIAS, type CodexSandbox, type Effort, type GeminiModel } from '../../shared/models';
import { ZERO_USAGE, type TurnUsage } from '../../shared/turn-types';
import type { SpawnFn } from './CodexEngine';
import type { EngineEvent, EngineResult } from './Engine';
import { STDERR_MAX } from './redact';
const STDERR_DRAIN_MS = 1000;

type Rec = Record<string, unknown>;

/** A resume id lands in argv after `--conversation`: an agy conversation id, nothing flag-shaped. */
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** agy's stderr when no Google account is logged in (`authentication required. Run 'agy' to log in`). */
const NOT_LOGGED_IN_RE = /authentication required/i;
export const GEMINI_LOGIN_HINT = 'Gemini 로그인 필요 — 사용량에서 재로그인';

export type GeminiTurnRequest = {
  account: GeminiAccount;
  cwd: string;
  /** agy conversation id (= deck session id); null starts a new conversation. */
  resumeSessionId: string | null;
  model: GeminiModel;
  /** `--effort`. */
  effort: Effort;
  /** read-only → `--mode plan` (the measured path; headless denies writes and shell on its own); workspace-write → `--mode accept-edits --sandbox` (edits only; shell needs approval, which headless denies). */
  sandbox: CodexSandbox;
  prompt: string;
  signal: AbortSignal;
};

/**
 * Headless agy (Antigravity CLI 1.4.2). `-p` takes a value, so the prompt is one argv element `-p=<prompt>` (a separate
 * element would let a following flag be read as the prompt). Never `--dangerously-skip-permissions`. Read-only keeps
 * `--mode plan`: agy warns it has no effect with `--disable-slash-commands` and headless soft-denies writes and shell on
 * its own (docs/gemini-spike.md "실측 4"), but every read-only fixture was captured with it — dropping it is unmeasured.
 */
export function geminiArgs(req: Pick<GeminiTurnRequest, 'resumeSessionId' | 'model' | 'sandbox' | 'effort' | 'prompt'>): string[] {
  const write = req.sandbox === 'workspace-write';
  return [
    `-p=${req.prompt}`,
    '--output-format', 'stream-json',
    '--model', GEMINI_CLI_ALIAS[req.model],
    '--effort', req.effort,
    ...(write ? ['--mode', 'accept-edits', '--sandbox'] : ['--mode', 'plan']),
    '--disable-slash-commands',
    '--print-timeout', '0',
    ...(req.resumeSessionId ? ['--conversation', req.resumeSessionId] : []),
  ];
}

function usageOf(u: unknown): TurnUsage {
  const r = (u && typeof u === 'object' ? u : {}) as Rec;
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadTokens: n('cache_read_tokens'), cacheCreationTokens: 0 };
}

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && typeof (x as Rec).message === 'string') return (x as Rec).message as string;
  return x === undefined || x === null ? '' : JSON.stringify(x);
}

const addUsage = (a: TurnUsage, b: TurnUsage): TurnUsage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

/** agy permission names (`denied_actions[].action`, stderr `required the "<x>" permission`) → what the user reads. */
const DENIED_LABEL: Record<string, string> = { write_file: '파일 쓰기', command: '셸 명령 실행', read_file: '파일 읽기', browser: '브라우저 사용', mcp: 'MCP 도구' };

/** The turn note for headless soft-denials: action kinds only — never a path, command line or credential. */
export function geminiDeniedNotice(actions: readonly string[]): string | null {
  const labels = [...new Set(actions.map((a) => DENIED_LABEL[a] ?? '도구 실행'))];
  return labels.length ? `Gemini가 거부함: ${labels.join(', ')} — 헤드리스 agy 는 승인을 물을 수 없어 자동 거부됩니다` : null;
}

/** agy's stderr on a soft-denial: `a tool required the "write_file" permission that headless mode cannot prompt for`. */
const DENIED_STDERR_RE = /required the "([A-Za-z_]+)" permission/g;
export function deniedActionsInStderr(stderr: string): string[] {
  return [...stderr.matchAll(DENIED_STDERR_RE)].map((m) => m[1]!);
}

const THINKING_RE = /thought|thinking|reasoning/i;
const TOOL_DONE_RE = /done|complete|finish|success|error|fail/i;
const TOOL_FAILED_RE = /error|fail/i;

/**
 * `agy --output-format stream-json` (1.4.2, docs/gemini-spike.md "실측 1"): one line = `{"event":"<name>",
 * "conversation_id":…,"<name>":{…}}` — init, step_update, result. A payload that is not an object → the line itself.
 * The conversation id is top-level (also read from the payload). Tool steps carry no id: `step_index` pairs a call
 * with its result. A continuation's `result.usage` is the whole conversation's, so the turn's usage is the sum of its
 * steps' own `usage`. Headless soft-denials end as an empty SUCCESS with `denied_actions` → a `notice`.
 */
export class GeminiEventMapper {
  sessionId: string | null;
  private text = '';
  private done = false;
  private initSent = false;
  private steps = 0;
  private denied = false;
  /** `step_update.usage` by step (the DONE line carries the step's own share). */
  private readonly stepUsage = new Map<string, TurnUsage>();
  private readonly called = new Set<string>();
  private readonly resulted = new Set<string>();

  private readonly resumed: boolean;

  constructor(private readonly model: string, resumeSessionId: string | null) {
    this.sessionId = resumeSessionId;
    this.resumed = resumeSessionId !== null;
  }

  get sawResult(): boolean {
    return this.done;
  }

  /** A denial notice already went out (from `denied_actions`). */
  get sawDenied(): boolean {
    return this.denied;
  }

  private init(id: string, model: unknown): EngineEvent {
    this.sessionId = id;
    this.initSent = true;
    return { kind: 'init', sessionId: id, model: str(model) ?? this.model };
  }

  map(ev: unknown): EngineEvent[] {
    if (!ev || typeof ev !== 'object') return [];
    const e = ev as Rec;
    if (typeof e.event !== 'string') return [];
    const inner = e[e.event];
    const p = (inner && typeof inner === 'object' ? inner : e) as Rec;
    switch (e.event) {
      case 'init': {
        const id = str(e.conversation_id) ?? str(p.conversation_id);
        return id ? [this.init(id, p.model)] : [];
      }
      case 'step_update': {
        this.steps += 1;
        const out: EngineEvent[] = [];
        const step = typeof p.step_index === 'number' ? `step-${p.step_index}` : null;
        if (p.usage && typeof p.usage === 'object') this.stepUsage.set(step ?? `n${this.steps}`, usageOf(p.usage));
        const delta = str(p.text_delta);
        if (delta) {
          if (typeof p.step_type === 'string' && THINKING_RE.test(p.step_type)) out.push({ kind: 'thinking', text: delta });
          else { this.text += delta; out.push({ kind: 'delta', text: delta }); }
        }
        const tool = p.tool_info;
        if (tool && typeof tool === 'object') {
          const t = tool as Rec;
          const id = str(t.id) ?? str(t.tool_id) ?? str(t.call_id) ?? step ?? `n${this.steps}`;
          if (!this.called.has(id)) {
            this.called.add(id);
            out.push({ kind: 'tool_call', toolUseId: id, name: str(t.name) ?? str(t.tool_name) ?? str(p.tool_name) ?? 'tool', input: t.input ?? t.args ?? t.parameters ?? {} });
          }
          const state = typeof p.state === 'string' ? p.state : typeof t.state === 'string' ? t.state : '';
          // A finished step always gets its result — agy's write_to_file DONE carries no output.
          const payload = t.output ?? t.result ?? t.error;
          if (TOOL_DONE_RE.test(state) && !this.resulted.has(id)) {
            this.resulted.add(id);
            out.push({ kind: 'tool_result', toolUseId: id, content: textOf(payload), isError: (t.error !== undefined && t.error !== null) || TOOL_FAILED_RE.test(state) });
          }
        }
        return out;
      }
      case 'result': {
        this.done = true;
        const ok = p.status === 'SUCCESS';
        const out: EngineEvent[] = [];
        const id = str(p.conversation_id);
        if (id) {
          if (!this.initSent) out.push(this.init(id, p.model));
          else this.sessionId = id;
        }
        if (ok && !this.text && typeof p.response === 'string') this.text = p.response;
        const actions = Array.isArray(p.denied_actions) ? p.denied_actions.map((a) => (a && typeof a === 'object' ? str((a as Rec).action) ?? '' : '')) : [];
        const notice = geminiDeniedNotice(actions);
        if (notice) { this.denied = true; out.push({ kind: 'notice', message: notice }); }
        // `result.usage` is the whole conversation's total — on a resumed turn it would double-count earlier turns.
        const usage = this.stepUsage.size ? [...this.stepUsage.values()].reduce(addUsage, ZERO_USAGE) : this.resumed ? ZERO_USAGE : usageOf(p.usage);
        out.push(this.result(ok, usage, ok ? null : (str(p.error) ?? 'agy 실패')));
        return out;
      }
      default:
        return [];
    }
  }

  result(ok: boolean, usage: TurnUsage, errorText: string | null): EngineResult {
    return {
      kind: 'result', sessionId: this.sessionId, ok, text: ok ? this.text : '', usage,
      errorText: ok ? null : errorText, stderr: null, errorKind: null, terminalReason: ok ? 'completed' : null,
    };
  }
}

export class GeminiEngine {
  private readonly spawnFn: SpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly realHome: string;

  constructor(readonly bin: string, opts: { spawnFn?: SpawnFn; baseEnv?: NodeJS.ProcessEnv; realHome?: string } = {}) {
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.baseEnv = opts.baseEnv ?? process.env;
    this.realHome = opts.realHome ?? this.baseEnv.HOME ?? os.homedir();
  }

  async *runTurn(req: GeminiTurnRequest): AsyncIterable<EngineEvent> {
    const mapper = new GeminiEventMapper(GEMINI_CLI_ALIAS[req.model], req.resumeSessionId);
    if (req.signal.aborted) {
      yield { ...mapper.result(false, ZERO_USAGE, '중단됨'), terminalReason: 'aborted' };
      return;
    }
    if (req.resumeSessionId !== null && !CONVERSATION_ID_RE.test(req.resumeSessionId)) {
      yield mapper.result(false, ZERO_USAGE, '잘못된 세션 ID 형식');
      return;
    }
    if (req.account === 'g2') {
      const ensured = ensureGeminiSeatHome('g2', this.realHome);
      if (!ensured.ok) {
        yield mapper.result(false, ZERO_USAGE, ensured.error);
        return;
      }
    }
    const child = this.spawnFn(this.bin, geminiArgs(req), { cwd: req.cwd, env: geminiEnv(this.baseEnv, { home: geminiSeatHome(req.account, this.realHome) }) });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderrTail = (stderrTail + String(chunk)).slice(-STDERR_MAX); });
    // stderr may still be draining at 'exit', and the soft-denial / login cause lives there (same as CodexEngine).
    const stderrEnded = new Promise<void>((resolve) => {
      if (!child.stderr) { resolve(); return; }
      for (const ev of ['end', 'close', 'error']) child.stderr.once(ev, () => resolve());
    });
    child.stdin?.on('error', () => {});
    let exited = false;
    let spawnError: string | null = null;
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code: number | null) => { exited = true; resolve(code); });
      child.once('error', (err: Error) => { exited = true; spawnError = err.message; resolve(null); });
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    // The result waits for exit: agy's stderr (separate pipe) may name the cause (login, soft-denial) after the result line.
    const failed = (r: EngineResult): EngineResult => ({
      ...r, stderr: stderrTail || null,
      errorText: !req.signal.aborted && NOT_LOGGED_IN_RE.test(`${stderrTail}\n${r.errorText ?? ''}`) ? GEMINI_LOGIN_HINT : r.errorText,
    });
    let pending: EngineResult | null = null;
    try {
      // The prompt is in argv: stdin closes at once.
      child.stdin?.end();
      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          for (const ev of mapper.map(parsed)) {
            if (ev.kind === 'result') pending = ev;
            else yield ev;
          }
        }
      }
      const code = await exit;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([stderrEnded, new Promise<void>((r) => { drainTimer = setTimeout(r, STDERR_DRAIN_MS); (drainTimer as { unref?: () => void }).unref?.(); })]);
      if (drainTimer) clearTimeout(drainTimer);
      if (pending?.ok) {
        // A soft-denial with no `denied_actions` still shows up on stderr.
        const notice = mapper.sawDenied ? null : geminiDeniedNotice(deniedActionsInStderr(stderrTail));
        if (notice) yield { kind: 'notice', message: notice };
        yield pending;
      } else if (pending) yield failed(pending);
      else if (!mapper.sawResult) {
        const aborted = req.signal.aborted;
        const r = mapper.result(false, ZERO_USAGE, aborted ? '중단됨' : spawnError !== null ? `agy 실행 실패: ${spawnError}` : `agy 종료 코드 ${code ?? '?'}`);
        yield { ...failed(r), terminalReason: aborted ? 'aborted' : null };
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (!exited) child.kill('SIGTERM');
    }
  }
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** `DECK_GEMINI_BIN` (as-is when executable) → each `PATH` entry → `~/.local/bin/agy`. Null = Gemini disabled. deck never logs in. */
export function resolveGeminiBin(env: NodeJS.ProcessEnv, home: string, existsFn: (p: string) => boolean = isExecutable): string | null {
  if (env.DECK_GEMINI_BIN) return existsFn(env.DECK_GEMINI_BIN) ? env.DECK_GEMINI_BIN : null;
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const p = path.join(dir, 'agy');
    if (existsFn(p)) return p;
  }
  const local = path.join(home, '.local', 'bin', 'agy');
  return existsFn(local) ? local : null;
}

/**
 * Is agy logged in on a seat? The probe is `agy models` with that seat's HOME (and no D-Bus session): exit 0 = logged
 * in, anything else = false. Cached for `ttlMs`; one refresh at a time probes g1 then g2. `refresh()` resolves to g1.
 */
export class GeminiLogin {
  private readonly spawnFn: SpawnFn;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly realHome: string;
  private values: Record<GeminiAccount, boolean> = { g1: false, g2: false };
  private checkedAt: number | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(readonly bin: string, opts: { spawnFn?: SpawnFn; ttlMs?: number; timeoutMs?: number; now?: () => number; baseEnv?: NodeJS.ProcessEnv; realHome?: string } = {}) {
    this.spawnFn = opts.spawnFn ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'ignore', 'ignore'] }));
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.realHome = opts.realHome ?? this.baseEnv.HOME ?? os.homedir();
  }

  get(account: GeminiAccount): boolean {
    return this.values[account];
  }

  /** g1's result. Both seats are updated before this resolves. */
  refresh(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.probeAll().then((values) => {
        this.values = values;
        this.checkedAt = this.now();
        this.inFlight = null;
        return values.g1;
      });
    }
    return this.inFlight;
  }

  ensureFresh(): void {
    if (this.inFlight) return;
    if (this.checkedAt === null || this.now() - this.checkedAt >= this.ttlMs) void this.refresh();
  }

  private async probeAll(): Promise<Record<GeminiAccount, boolean>> {
    const out: Record<GeminiAccount, boolean> = { g1: false, g2: false };
    for (const account of GEMINI_ACCOUNTS) out[account] = await this.probeOne(account);
    return out;
  }

  private probeOne(account: GeminiAccount): Promise<boolean> {
    if (account === 'g2') {
      const ensured = ensureGeminiSeatHome('g2', this.realHome);
      if (!ensured.ok) return Promise.resolve(false);
    }
    const home = geminiSeatHome(account, this.realHome);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
      let child: ReturnType<SpawnFn>;
      try {
        child = this.spawnFn(this.bin, ['models'], { cwd: os.tmpdir(), env: geminiEnv(this.baseEnv, { home }) });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, this.timeoutMs);
      timer.unref?.();
      child.stdin?.end();
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('exit', (code: number | null) => done(code === 0));
      child.once('error', () => done(false));
    });
  }
}
