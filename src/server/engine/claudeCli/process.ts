// src/server/engine/claudeCli/process.ts
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { STDERR_MAX } from '../redact';
import { parseLine, type CliMessage, type CliUserMessage } from './messages';
import type { ClaudeChildLike, ClaudeSpawnFn } from './spawnTypes';

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null };
export interface ClaudeProcessOpts { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; spawnFn?: ClaudeSpawnFn; killGraceMs?: number; drainMs?: number }

export const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;

const defaultSpawn: ClaudeSpawnFn = (bin, args, o) =>
  spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ClaudeChildLike;

export function exitFailureText(e: ProcessExit): string {
  if (e.spawnError !== null) return `Claude Code 실행 실패: ${e.spawnError}`;
  if (e.signal) return `Claude Code 종료 신호 ${e.signal}`;
  return `Claude Code 종료 코드 ${e.code ?? '?'}`;
}

/**
 * One `claude -p --input-format stream-json` child. Abort is SIGINT (the CLI ends the turn and
 * still writes its result); stdin stays open so deck can keep the process for background tasks
 * and steers, and closing it is how a finished process is let go. No control protocol on stdin.
 */
export class ClaudeProcess {
  readonly exited: Promise<ProcessExit>;
  private resolveExit!: (e: ProcessExit) => void;
  private child: ClaudeChildLike | null = null;
  private _exit: ProcessExit | null = null;
  private _stderr = '';
  private _inputOpen = false;
  private _interrupted = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly grace: number;
  private readonly drain: number;

  constructor(private readonly o: ClaudeProcessOpts) {
    this.exited = new Promise((r) => { this.resolveExit = r; });
    this.grace = o.killGraceMs ?? KILL_GRACE_MS;
    this.drain = o.drainMs ?? DRAIN_MS;
  }

  get exit(): ProcessExit | null { return this._exit; }
  get stderrTail(): string { return this._stderr; }
  get inputOpen(): boolean { return this._inputOpen; }
  get interrupted(): boolean { return this._interrupted; }

  start(): void {
    try {
      this.child = (this.o.spawnFn ?? defaultSpawn)(this.o.bin, this.o.args, { cwd: this.o.cwd, env: this.o.env });
    } catch (err) {
      this.finish({ code: null, signal: null, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const c = this.child;
    this._inputOpen = true;
    c.stdin.on('error', () => { this._inputOpen = false; }); // EPIPE once the child is gone
    c.stderr.on('data', (b: Buffer) => { this._stderr = (this._stderr + b.toString('utf8')).slice(-STDERR_MAX); });
    c.once('error', (err) => this.finish({ code: null, signal: null, spawnError: err.message }));
    c.once('exit', (code, signal) => this.finish({ code, signal, spawnError: null }));
  }

  /** stdout frames until stdout closes — or `drainMs` after exit, in case a descendant kept the pipe open. */
  async *messages(): AsyncGenerator<CliMessage> {
    const c = this.child;
    if (!c) return;
    const rl = readline.createInterface({ input: c.stdout, crlfDelay: Infinity });
    void this.exited.then(() => { const t = setTimeout(() => rl.close(), this.drain); t.unref?.(); });
    for await (const line of rl) {
      const m = parseLine(line);
      if (m) yield m;
    }
  }

  write(m: CliUserMessage): boolean {
    if (!this._inputOpen || !this.child || this._exit) return false;
    this.child.stdin.write(JSON.stringify(m) + '\n');
    return true;
  }

  closeInput(): void {
    if (!this._inputOpen || !this.child) return;
    this._inputOpen = false;
    this.child.stdin.end();
  }

  interrupt(): void {
    if (this._interrupted || this._exit || !this.child) return;
    this._interrupted = true;
    this.child.kill('SIGINT');
    this.after(() => { this.closeInput(); this.terminate(); });
  }

  stop(): void {
    this.closeInput();
    if (!this._exit) this.after(() => this.terminate());
  }

  terminate(): void {
    if (this._exit || !this.child) return;
    this.child.kill('SIGTERM');
    this.after(() => { if (!this._exit) this.child?.kill('SIGKILL'); });
  }

  private after(fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); if (!this._exit) fn(); }, this.grace);
    t.unref?.();
    this.timers.add(t);
  }

  private finish(e: ProcessExit): void {
    if (this._exit) return;
    this._exit = e;
    this._inputOpen = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.resolveExit(e);
  }
}
