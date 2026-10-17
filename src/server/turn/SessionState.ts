import fs from 'node:fs/promises';
import path from 'node:path';
import type { Account, GeminiAccount } from '../../shared/accounts';
import type { ClaudeModel, CodexModel, CodexSandbox, GeminiModel } from '../../shared/models';
import type { PermMode } from '../../shared/permission';
import type { SessionEntry } from '../../shared/session-types';
import { isCommanderState, type CommanderState } from '../commander/types';

type SessionBase = {
  sessionId: string;
  cwd: string;
  lastTurnAtMs: number | null;
  justCompacted: boolean;
  /** First prompt (≤ 80 chars) for the sidebar; Codex sessions have no jsonl title to read. */
  title?: string;
  /**
   * 서버 재시작으로 백그라운드 작업이 끊긴 기록; 다음 턴이 읽고 지운다. `cause`: 재시작이 아닌 원인(예: "C 계정 사용 한도 도달" —
   * 백그라운드 세그먼트가 한도로 끝나 다른 계정에서 이어갈 때).
   */
  interrupted?: { atMs: number; tasks: string[]; cause?: string; /** `'cap'`: the held-open process hit the background wait limit (ClaudeEngine bgMaxMs) — deck itself sends the session on (TurnRunner.continueAfterCap). */ kind?: 'cap' };
  /**
   * 병목 알림(BottleneckWatch): 턴이 실패한 채 멈춰 있다 — 재알림 단계(n번 보냄)를 재시작 뒤에도 이어 가려고 저장한다.
   * 다음 턴의 시작·성공, 또는 사용자가 이 세션에 보내면 지운다(열기만 해서는 지우지 않는다 — 재연결한 탭도 다시 연다).
   * `resetAtMs`: 오류 원문이 알려 준 한도 리셋 시각(있을 때) — 재시작 뒤에도 "HH:MM 쯤 다시 시도 가능"에 쓴다.
   */
  blocked?: { kind: 'turn_failed'; atMs: number; lastPushAtMs: number; n: number; summary: string; resetAtMs?: number };
  /**
   * 대안 계정 없음으로 실패한 턴의 자동 재시도 예약(BottleneckWatch 가 `atMs` 에 ws 의 send 경로로 넣는다). `hops`: 이번이 몇 번째
   * 재시도인지(최대 2). 다음 턴의 시작, 또는 사용자가 먼저 보내면 지운다.
   */
  pendingRetry?: { text: string; atMs: number; hops: number };
  /**
   * 총사령탑(commander) 상태 — `docs/superpowers/specs/2026-10-18-commander-design.md` §6. 변경은 전용 `setCommander`
   * 로만(`accountPin`·`setAccountPin` 과 같은 급): `set()` 에 실려 온 값은 버리고 기존 값을 그대로 지킨다. TurnRunner 가
   * 턴 끝마다 상태를 스프레드 없이 새로 만들어도(`TurnRunner.ts` ~1680행) 이 보존 덕에 지워지지 않는다.
   */
  commander?: CommanderState;
};

export type ClaudeSessionState = SessionBase & {
  /** Absent = Claude (Plan 1 state files). */
  engine?: 'claude';
  account: Account;
  /** Directory the jsonl currently lives in (moves update it). */
  projectDir: string;
  defaultModel: ClaudeModel;
  /** Review I4: permission rules accepted with 이 세션 (SDK suggestions), re-applied on later turns. */
  allowRules?: string[];
  /** Directories accepted with 이 세션 (addDirectories suggestions). */
  allowDirs?: string[];
  /**
   * The session's permission mode (picker / Shift+Tab, an approved plan, or 이 세션's "allow all edits"). Absent = the
   * server's default for new sessions (DeckSettings.defaultPermissionMode). Plan 1 files only ever stored 'acceptEdits'.
   */
  mode?: PermMode;
  /** 이 세션은 B 써: routing always uses this account unless it is unusable. Absent = 자동. Changed only via setAccountPin. */
  accountPin?: Account;
};

/** D4: a Codex thread deck created. sessionId = Codex thread id; the engine never changes afterwards (D3); the sandbox only via TurnRunner.setSandbox (D2). */
export type CodexSessionState = SessionBase & {
  engine: 'codex';
  defaultModel: CodexModel;
  sandbox: CodexSandbox;
  /** ~/.codex/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl once located (history + rate limits). */
  rolloutFile: string | null;
  createdAtMs: number;
};

/**
 * A gemini-cli session deck created. sessionId = the CLI's session id (init.session_id). Pinned to its account and cwd:
 * the CLI keeps chats under `$GEMINI_CLI_HOME/.gemini/tmp/<project>/chats`, so a resume needs both unchanged.
 */
export type GeminiSessionState = SessionBase & {
  engine: 'gemini';
  account: GeminiAccount;
  defaultModel: GeminiModel;
  sandbox: CodexSandbox;
  createdAtMs: number;
};

export type SessionState = ClaudeSessionState | CodexSessionState | GeminiSessionState;

export function isCodexState(s: SessionState): s is CodexSessionState {
  return s.engine === 'codex';
}

export function isGeminiState(s: SessionState): s is GeminiSessionState {
  return s.engine === 'gemini';
}

let tmpCounter = 0;

export class SessionStateStore {
  private map = new Map<string, SessionState>();
  /** Review I6: writes are serialized; each snapshot goes through its own tmp file. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      this.map = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SessionState>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      // 손으로 고쳤거나 예전 모양으로 남은 commander 는 세션 전체가 아니라 그 필드만 버린다.
      for (const s of Object.values(parsed)) {
        if (s && typeof s === 'object' && 'commander' in s && !isCommanderState(s.commander)) delete (s as { commander?: CommanderState }).commander;
      }
      this.map = new Map(Object.entries(parsed));
    } catch (err) {
      const bad = `${this.file}.bad-${Date.now()}`;
      await fs.rename(this.file, bad).catch(() => {});
      console.error(`deck: ${this.file} 을 읽지 못해 ${bad} 로 옮기고 빈 상태로 시작합니다 (${err instanceof Error ? err.message : String(err)})`);
      this.map = new Map();
    }
  }

  get(id: string): SessionState | null {
    return this.map.get(id) ?? null;
  }

  list(): SessionState[] {
    return [...this.map.values()];
  }

  /** D4: Codex and Gemini sessions for the sidebar (Claude ones come from SessionIndex's profile scan). */
  codexEntries(): SessionEntry[] {
    const out: SessionEntry[] = [];
    for (const s of this.map.values()) {
      if (isGeminiState(s)) {
        out.push({
          sessionId: s.sessionId, account: s.account, engine: 'gemini', sandbox: s.sandbox, cwd: s.cwd, projectDir: '', file: '',
          title: s.title ?? '(제목 없음)', lastModified: s.lastTurnAtMs ?? s.createdAtMs, sizeBytes: 0,
        });
        continue;
      }
      if (!isCodexState(s)) continue;
      out.push({
        sessionId: s.sessionId, account: 'gpt', engine: 'codex', sandbox: s.sandbox, cwd: s.cwd,
        projectDir: s.rolloutFile ? path.dirname(s.rolloutFile) : '', file: s.rolloutFile ?? '',
        title: s.title ?? '(제목 없음)', lastModified: s.lastTurnAtMs ?? s.createdAtMs, sizeBytes: 0,
      });
    }
    return out;
  }

  /**
   * The stored pin wins over the one `s` carries (turns hold a state read before the user changed the pin);
   * only a new entry takes `s.accountPin`. Use setAccountPin to change it. commander is kept the same way
   * (§6): a new entry's incoming `s.commander` is dropped — change it only via setCommander.
   */
  set(s: SessionState): Promise<void> {
    const prev = this.map.get(s.sessionId);
    if (prev && !isCodexState(s) && !isGeminiState(s)) {
      const { accountPin: _drop, ...rest } = s;
      const pin = !isCodexState(prev) && !isGeminiState(prev) ? prev.accountPin : undefined;
      s = pin ? { ...rest, accountPin: pin } : rest;
    }
    if ('commander' in s || prev?.commander) {
      const { commander: _drop, ...rest } = s;
      s = prev?.commander ? { ...rest, commander: prev.commander } : rest;
    }
    return this.save(s);
  }

  /** Pins a Claude session to an account (null = 자동). False when there is no Claude state for `id`. */
  setAccountPin(id: string, pin: Account | null): Promise<boolean> {
    const prev = this.map.get(id);
    if (!prev || isCodexState(prev) || isGeminiState(prev)) return Promise.resolve(false);
    const { accountPin: _drop, ...rest } = prev;
    return this.save(pin ? { ...rest, accountPin: pin } : rest).then(() => true);
  }

  /** Sets or clears a session's commander state (§6). False when there is no state for `id`. */
  setCommander(id: string, commander: CommanderState | undefined): Promise<boolean> {
    const prev = this.map.get(id);
    if (!prev) return Promise.resolve(false);
    const { commander: _drop, ...rest } = prev;
    return this.save(commander ? { ...rest, commander } : rest).then(() => true);
  }

  private save(s: SessionState): Promise<void> {
    this.map.set(s.sessionId, s);
    const run = this.chain.then(() => this.write());
    this.chain = run.catch(() => {});
    return run;
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${++tmpCounter}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await fs.chmod(this.file, 0o600);
  }
}
