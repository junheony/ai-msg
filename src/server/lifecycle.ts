/**
 * Graceful restart. SIGTERM (launchd stop / kickstart -k) and SIGUSR2 (`npm run restart`) drain:
 * sends that need a new process are refused; running turns and processes whose background work
 * (subagents, Monitor) is still live may finish (a process held open with no work left is ended at
 * once — ws.ts endHeld). With `maxMs` Infinity (the default, DECK_DRAIN_MAX_MIN unset or 0) the drain
 * waits until they all end; with a finite `maxMs` whatever is left at the deadline is aborted
 * (SHUTDOWN_ABORT: the pane says so and the session's next turn tells the model). Then the process
 * exits so the supervisor (launchd KeepAlive) starts it again. A second signal, or SIGINT, skips the
 * wait — the way to force a restart.
 */

export type DrainTarget = {
  drain(): void;
  activeTurns(): number;
  abortAll(): void;
};

export type DrainOptions = {
  /** Infinity: no deadline — wait until no turn is left. */
  maxMs: number;
  pollMs?: number;
  /** After the abort at the deadline: how long aborted turns get to report their end. */
  settleMs?: number;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Drains `target`; resolves 'drained' when no turn is left, 'timeout' when a finite deadline aborted the rest. */
export async function drain(target: DrainTarget, o: DrainOptions): Promise<'drained' | 'timeout'> {
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 1000;
  target.drain();
  const deadline = now() + o.maxMs;
  let lastLogged = -1;
  for (;;) {
    const n = target.activeTurns();
    if (n === 0) return 'drained';
    if (now() >= deadline) break;
    if (n !== lastLogged) { log(`deck: 재시작 대기 — 진행 중인 턴/백그라운드 작업 ${n}개 (${Number.isFinite(deadline) ? `최대 ${Math.ceil((deadline - now()) / 60_000)}분` : '끝날 때까지 — 다시 보내면 즉시 종료'})`); lastLogged = n; }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  log(`deck: 재시작 대기 시간(${Math.round(o.maxMs / 60_000)}분) 초과 — 남은 턴 ${target.activeTurns()}개를 중단합니다`);
  target.abortAll();
  const settleUntil = now() + (o.settleMs ?? 3000);
  while (target.activeTurns() > 0 && now() < settleUntil) await sleep(Math.min(pollMs, 100));
  return 'timeout';
}

/** The last step of a shutdown: wait for `flush` (queued writes such as events.jsonl), at most `timeoutMs`, then `exit` — even if it fails. */
export function flushThenExit(flush: () => Promise<void>, exit: () => void, timeoutMs = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); });
  return Promise.race([flush(), timeout]).catch(() => {}).finally(() => { clearTimeout(timer); exit(); });
}

export type SignalHost = { on(sig: NodeJS.Signals, fn: () => void): unknown };

/**
 * Wires the signals: SIGTERM/SIGUSR2 → drain then `exit`; a repeat or SIGINT → abort now and `exit`.
 * `exit` runs once (it closes sockets/timers and ends the process).
 */
export function installGracefulShutdown(host: SignalHost, target: DrainTarget, o: DrainOptions & { exit: (reason: string) => void; onDrain?: () => void }): { draining: () => boolean } {
  let draining = false;
  let exited = false;
  const log = o.log ?? (() => {});
  const exit = (reason: string) => { if (exited) return; exited = true; o.exit(reason); };
  const now = (sig: NodeJS.Signals) => {
    log(`deck: ${sig} — 기다리지 않고 종료합니다`);
    target.drain();
    target.abortAll();
    exit(sig);
  };
  const graceful = (sig: NodeJS.Signals) => {
    if (draining) { now(sig); return; }
    draining = true;
    try { o.onDrain?.(); } catch (err) { log(`deck: 종료 준비 기록 실패 — ${err instanceof Error ? err.message : String(err)}`); }
    log(`deck: ${sig} — 새 턴을 받지 않고 진행 중인 턴과 살아 있는 백그라운드 작업을 기다린 뒤 종료합니다 — 작업 없는 대기 프로세스는 바로 끊음 (다시 보내면 즉시 종료)`);
    void drain(target, o).then((r) => exit(`${sig}:${r}`), () => exit(`${sig}:error`));
  };
  host.on('SIGTERM', () => graceful('SIGTERM'));
  host.on('SIGUSR2', () => graceful('SIGUSR2'));
  host.on('SIGINT', () => now('SIGINT'));
  return { draining: () => draining };
}
