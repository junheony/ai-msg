import type { Readable, Writable } from 'node:stream';

/**
 * Line-delimited JSON-RPC 2.0 client for an Agent Client Protocol agent over stdio (one message per line). It knows
 * nothing about any particular agent. Receiving and handling are apart: the read loop parses a line and dispatches it
 * without awaiting, so an agent request whose handler waits (a permission card) never stops later messages.
 */

type Rec = Record<string, unknown>;
export type JsonRpcId = number | string;

/** JSON-RPC 2.0 reserved codes used here. */
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

/** Default cap on one incoming line; longer = connection error (a runaway agent must not grow the buffer forever). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** A JSON-RPC error response (`error: { code, message, data? }`) to one of our requests. */
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

/** A request got no response within its own time limit. */
export class AcpTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method}: no response within ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

/** The connection ended (agent exited, oversized line, write failure, close()) — every waiting request gets this. */
export class AcpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpClosedError';
  }
}

/** The caller's signal fired while a request was waiting; its response (if any) is dropped. */
export class AcpAbortError extends Error {
  constructor(readonly method: string) {
    super(`${method}: aborted`);
    this.name = 'AcpAbortError';
  }
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void; onResponse?: () => void };

export type RequestOptions = {
  /** No time limit when absent. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Called synchronously when the response line is read, before any later line is dispatched — so a caller can mark
   * "answered" before the agent's next message is handled (a promise continuation would run too late).
   */
  onResponse?: () => void;
};
export type NotificationHandler = (method: string, params: unknown) => void;
export type RequestHandler = (params: unknown) => Promise<unknown>;

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closedError: AcpClosedError | null = null;
  private skipped = 0;
  private readonly maxLineBytes: number;
  private resolveClosed!: (e: AcpClosedError) => void;
  /** Settles once, with the reason, when the connection ends. */
  readonly closed: Promise<AcpClosedError>;

  constructor(private readonly input: Readable, private readonly output: Writable, opts: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
    this.closed = new Promise((r) => { this.resolveClosed = r; });
    input.on('data', this.onData);
    input.once('end', () => this.close('agent closed its output'));
    input.once('error', (e: Error) => this.close(`agent output error: ${e.message}`));
    // EPIPE when the agent died: the write's own callback reports it; this keeps the stream error from crashing the server.
    output.on('error', () => {});
  }

  /** Non-JSON lines skipped so far (agents may print banners or logs on stdout). */
  get skippedLines(): number {
    return this.skipped;
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  /** One handler per method; an agent request for a method with none gets -32601 method not found. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Sends a request and waits for its response; `timeoutMs` absent = no time limit. */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number | RequestOptions, signalArg?: AbortSignal): Promise<T> {
    const opts: RequestOptions = typeof timeoutMs === 'object' ? timeoutMs : { timeoutMs, signal: signalArg };
    const signal = opts.signal;
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(new AcpAbortError(method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => this.settle(id, new AcpAbortError(method));
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, cleanup, onResponse: opts.onResponse });
      const limit = opts.timeoutMs;
      if (limit !== undefined) timer = setTimeout(() => this.settle(id, new AcpTimeoutError(method, limit)), limit);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params }).catch((e: Error) => this.settle(id, e));
    });
  }

  /** Sends a notification (no id, no response). Resolves once written. */
  notify(method: string, params: unknown): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return this.write({ jsonrpc: '2.0', method, params });
  }

  /** Ends the connection: waiting requests reject, in-flight agent requests will get no response, input is ignored. */
  close(reason = 'connection closed'): void {
    if (this.closedError) return;
    const err = new AcpClosedError(reason);
    this.closedError = err;
    this.input.off('data', this.onData);
    this.chunks = [];
    this.buffered = 0;
    for (const [id] of [...this.pending]) this.settle(id, err);
    this.resolveClosed(err);
  }

  private settle(id: JsonRpcId, err: Error | null, value?: unknown, fromAgent = false): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    if (fromAgent) {
      try { p.onResponse?.(); } catch { /* caller's hook */ }
    }
    if (err) p.reject(err);
    else p.resolve(value);
  }

  /** Writes are queued so lines never interleave, and each waits for `drain` when the pipe is full (backpressure). */
  private write(msg: Rec): Promise<void> {
    const line = JSON.stringify(msg) + '\n';
    const run = () => new Promise<void>((resolve, reject) => {
      if (this.closedError) { reject(this.closedError); return; }
      let ok: boolean;
      try {
        ok = this.output.write(line, (e) => { if (e) reject(new AcpClosedError(`write failed: ${e.message}`)); });
      } catch (e) {
        reject(new AcpClosedError(`write failed: ${(e as Error).message}`));
        return;
      }
      if (ok) { resolve(); return; }
      const done = () => resolve();
      this.output.once('drain', done);
      // The connection may end while waiting for drain: do not wait forever.
      void this.closed.then((e) => { this.output.off('drain', done); reject(e); });
    });
    const p = this.writeChain.then(run);
    this.writeChain = p.catch(() => {});
    return p;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let nl = buf.indexOf(0x0a);
    while (nl !== -1 && !this.closedError) {
      const part = buf.subarray(0, nl);
      if (this.buffered + part.length > this.maxLineBytes) { this.close(`line exceeds ${this.maxLineBytes} bytes`); return; }
      const line = this.chunks.length ? Buffer.concat([...this.chunks, part]) : part;
      this.chunks = [];
      this.buffered = 0;
      this.dispatchLine(line.toString('utf8'));
      buf = buf.subarray(nl + 1);
      nl = buf.indexOf(0x0a);
    }
    if (this.closedError || buf.length === 0) return;
    if (this.buffered + buf.length > this.maxLineBytes) { this.close(`line exceeds ${this.maxLineBytes} bytes`); return; }
    this.chunks.push(Buffer.from(buf));
    this.buffered += buf.length;
  };

  private dispatchLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { this.skipped += 1; return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { this.skipped += 1; return; }
    const m = msg as Rec;
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (typeof m.method === 'string') {
      if (hasId) this.handleRequest(m.id as JsonRpcId, m.method, m.params);
      else for (const h of this.notificationHandlers) {
        try { h(m.method, m.params); } catch (e) { console.warn('deck: acp notification handler failed:', (e as Error).message); }
      }
      return;
    }
    if (!hasId) { this.skipped += 1; return; }
    const id = m.id as JsonRpcId;
    if (m.error && typeof m.error === 'object') {
      const e = m.error as Rec;
      this.settle(id, new AcpRpcError(typeof e.code === 'number' ? e.code : INTERNAL_ERROR, typeof e.message === 'string' ? e.message : 'error', e.data), undefined, true);
    } else {
      this.settle(id, null, m.result, true);
    }
  }

  /** Runs the handler on its own (never awaited by the read loop); after close() its answer is dropped. */
  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    const reply = (body: Rec) => {
      if (this.closedError) return;
      this.write({ jsonrpc: '2.0', id, ...body }).catch(() => {});
    };
    if (!handler) { reply({ error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } }); return; }
    void (async () => {
      try {
        const result = await handler(params);
        reply({ result: result ?? null });
      } catch (e) {
        const code = e instanceof AcpRpcError ? e.code : INTERNAL_ERROR;
        reply({ error: { code, message: e instanceof Error ? e.message : 'internal error' } });
      }
    })();
  }
}
