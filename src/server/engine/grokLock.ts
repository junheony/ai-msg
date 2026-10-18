/**
 * Design §2-1: one Grok turn per (GROK_HOME realpath, session) at a time, inside this server process. Waiters queue in
 * order; a waiter that gives up (time limit, abort) passes its place on once the holder before it is done, so the queue
 * never stalls. The caller releases only after the previous turn's whole process group has ended. Contention with a
 * terminal `grok` on the same session is not covered here (S11).
 */

export class GrokLockTimeoutError extends Error {
  constructor() {
    super('이전 Grok 프로세스가 아직 끝나지 않음');
    this.name = 'GrokLockTimeoutError';
  }
}

export class GrokLockAbortError extends Error {
  constructor() {
    super('aborted while waiting for the Grok lock');
    this.name = 'GrokLockAbortError';
  }
}

/** A new session has no id yet: give it its own temporary key, so it waits for nothing. */
export function grokLockKey(grokHomeReal: string, sessionId: string | null, newSessionKey: string): string {
  return JSON.stringify([grokHomeReal, sessionId ?? `new:${newSessionKey}`]);
}

export class GrokLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Resolves with the release function (idempotent) once the lock is held; rejects on time limit or abort. */
  async acquire(key: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) { reject(new GrokLockAbortError()); return; }
        timer = setTimeout(() => reject(new GrokLockTimeoutError()), opts.timeoutMs);
        onAbort = () => reject(new GrokLockAbortError());
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        void prev.then(resolve);
      });
    } catch (e) {
      // Give up our place without jumping the queue: the next waiter still waits for the holder before us.
      void prev.then(release);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    }
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }

  /** Keys with a holder or waiters (tests). */
  get size(): number {
    return this.tails.size;
  }
}

/** The server-wide lock every Grok turn shares. */
export const grokLock = new GrokLock();
