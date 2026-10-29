import { randomUUID } from 'node:crypto';
import { ensureGeminiSeatHome } from '../engine/geminiHome';
import { authChildEnv, authInputLine, authTarget, plainTerminal, type AuthAccounts, type AuthBins, type AuthTarget } from './spec';

/** A pty whose stdin is the login program. `write` is bytes, not a command. */
export type AuthPty = {
  write(text: string): void;
  kill(): void;
  onData(cb: (text: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
};

export type AuthSpawn = (spec: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv; cols?: number }) => AuthPty;

export type AuthEvent =
  | { type: 'out'; text: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string };

const TTL_MS = 10 * 60 * 1000;
const OUT_CAP = 64 * 1024;

type Live = {
  id: string;
  seat: string;
  label: string;
  pty: AuthPty;
  buf: string;
  listeners: Set<(ev: AuthEvent) => void>;
  timer: ReturnType<typeof setTimeout>;
  closed: boolean;
};

export type AuthLoginDeps = {
  accounts: AuthAccounts;
  home: string;
  bins: AuthBins;
  spawn: AuthSpawn;
  baseEnv: NodeJS.ProcessEnv;
  /** The login process ended on its own (not cancel, not the 10-minute close). `code` is the process exit code. */
  onExit?: (seat: string, code: number | null) => void;
};

/**
 * One login window at a time. The seat selects an allowlisted command (`authTarget`); input is written to that
 * process only. A second start is refused until this one ends or is cancelled.
 */
export class AuthLoginHub {
  private live: Live | null = null;

  constructor(private readonly deps: AuthLoginDeps) {}

  start(seat: string): { ok: true; id: string; label: string; seat: string } | { ok: false; status: 400 | 409; error: string } {
    if (this.live && !this.live.closed) return { ok: false, status: 409, error: '이미 로그인 창이 열려 있습니다 — 닫은 뒤 다시 시도하세요' };
    const target = authTarget(seat, this.deps.accounts, this.deps.bins, this.deps.home);
    if ('error' in target) return { ok: false, status: 400, error: target.error };
    if (target.seat === 'g1' || target.seat === 'g2') {
      const ensured = ensureGeminiSeatHome(target.seat, this.deps.home);
      if (!ensured.ok) return { ok: false, status: 400, error: ensured.error };
    }
    return this.open(target);
  }

  private open(target: AuthTarget): { ok: true; id: string; label: string; seat: string } | { ok: false; status: 400; error: string } {
    let pty: AuthPty;
    try {
      pty = this.deps.spawn({ bin: target.bin, args: target.args, env: authChildEnv(this.deps.baseEnv, target.extraEnv), ...(target.cols ? { cols: target.cols } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : '로그인 창을 열지 못했습니다';
      return { ok: false, status: 400, error: message };
    }
    const session: Live = {
      id: randomUUID(), seat: target.seat, label: target.label, pty, buf: '', listeners: new Set(), closed: false,
      timer: setTimeout(() => this.finish(session, null, '로그인 시간이 지나 창을 닫았습니다', true), TTL_MS),
    };
    this.live = session;
    pty.onData((chunk) => {
      if (session.closed) return;
      const text = plainTerminal(chunk);
      if (!text) return;
      session.buf = (session.buf + text).slice(-OUT_CAP);
      this.emit(session, { type: 'out', text });
    });
    pty.onExit((code) => this.finish(session, code, null, false));
    return { ok: true, id: session.id, label: session.label, seat: session.seat };
  }

  /** True while this id is the open window (including in the moment it is closing). */
  has(id: string): boolean {
    return !!this.live && this.live.id === id;
  }

  /** Replay what already printed, then live output, until the process ends. Returns an unsubscribe. */
  subscribe(id: string, cb: (ev: AuthEvent) => void): { ok: true; unsub: () => void } | { ok: false } {
    const session = this.live;
    if (!session || session.id !== id) return { ok: false };
    if (session.buf) cb({ type: 'out', text: session.buf });
    if (session.closed) { cb({ type: 'exit', code: null }); return { ok: true, unsub: () => {} }; }
    session.listeners.add(cb);
    return { ok: true, unsub: () => { session.listeners.delete(cb); } };
  }

  write(id: string, line: string): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string } {
    const session = this.live;
    if (!session || session.id !== id) return { ok: false, status: 404, error: '로그인 창이 없습니다' };
    if (session.closed) return { ok: false, status: 409, error: '로그인 창이 이미 닫혔습니다' };
    if (line !== '\n') {
      const checked = authInputLine({ text: line });
      if ('error' in checked || checked.line !== line) return { ok: false, status: 400, error: 'error' in checked ? checked.error : '코드는 한 줄만 보낼 수 있습니다' };
    }
    try { session.pty.write(line); } catch { return { ok: false, status: 409, error: '로그인 창에 쓰지 못했습니다' }; }
    return { ok: true };
  }

  cancel(id: string): boolean {
    const session = this.live;
    if (!session || session.id !== id) return false;
    this.finish(session, null, null, true);
    return true;
  }

  private emit(session: Live, ev: AuthEvent): void {
    for (const cb of session.listeners) cb(ev);
  }

  private finish(session: Live, code: number | null, note: string | null, kill: boolean): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timer);
    if (kill) { try { session.pty.kill(); } catch { /* already gone */ } }
    if (note) this.emit(session, { type: 'error', message: note });
    this.emit(session, { type: 'exit', code });
    session.listeners.clear();
    if (this.live === session) this.live = null;
    if (!kill) this.deps.onExit?.(session.seat, code);
  }
}
