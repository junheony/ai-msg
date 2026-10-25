import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { CLOSE, MAX_FRAME } from '../../shared/cloud/frames';

export type RelayState = 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced';
type Backoff = { minMs: number; maxMs: number };

const PING_MS = 25_000;
const SILENCE_MS = 60_000;
const GOOD_CONNECTION_MS = 60_000;
const REPLACED_WAIT_MS = 600_000;
const REPLACED_MAX = 3;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const JITTER = 0.2;
/** Wall-clock check while running: a gap well past the tick means the Mac slept (its timers may not count the sleep). */
const WAKE_CHECK_MS = 5_000;
const WAKE_GAP_MS = 30_000;

/**
 * The Mac's one WebSocket to the relay (`wss://<relay>/relay/host`, host Bearer token).
 *
 * - The upgrade does not look at the entitlement: after it the room sends `{t:'ent', ok, until}` (first text, then on
 *   every alarm/recheck). Until the first one the state stays `connecting`; each one flips `up` ↔ `not_entitled`
 *   without dropping the socket, so a payment's recheck reaches an attached Mac within seconds (2차 필수 1).
 * - Binary messages are envelopes (`'envelope'`); other JSON texts (`peer`, `revoked`) are `'control'`.
 * - Text `ping` every 25 s (the room auto-answers `pong`); 60 s without receiving anything → drop and reconnect.
 * - Upgrade 401 / close 4401 → `unlinked`, stop. Upgrade 402 / close 4402 → `not_entitled`, entitlement backoff
 *   (30 s doubling, at most 5 min). 4409 → `replaced`, retry in 10 min ±20 %; the third 4409 in a row stops (until
 *   `start()`). Anything else → exponential backoff ±20 %; a drop while not entitled uses the entitlement backoff, so
 *   it also stays within 5 min. 60 s attached resets both backoffs and the 4409 count.
 * - Handshake timeout 15 s, frames over `MAX_FRAME` close the socket (1009), no permessage-deflate.
 * - Sleep/wake: the wall clock is read every 5 s; a jump of more than 30 s past that means the Mac slept, so the
 *   socket (most likely dead) is dropped and redone at once, and an ordinary backoff wait is cut short — no waiting
 *   for the 60 s silence watchdog or the rest of a backoff.
 */
export class RelayClient extends EventEmitter {
  private readonly o: { url: string; token: () => string | null; WebSocketImpl: typeof WebSocket; backoff: Backoff; entitlementBackoff: Backoff; random: () => number; handshakeTimeoutMs: number };
  private ws: WebSocket | null = null;
  private running = false;
  private st: RelayState | null = null;
  private ent: { ok: boolean; until: number } | null = null;
  /** Last word on the entitlement: an `ent` message, a 402 upgrade or a 4402 close. */
  private notEntitled = false;
  private attempt = 0;
  private entAttempt = 0;
  private replacedInRow = 0;
  private retry: { timer: ReturnType<typeof setTimeout>; kind: 'normal' | 'ent' | 'replaced' } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pinger: ReturnType<typeof setInterval> | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private wakeCheck: ReturnType<typeof setInterval> | null = null;

  constructor(o: { url: string; token: () => string | null; WebSocketImpl?: typeof WebSocket; backoff?: Backoff; entitlementBackoff?: Backoff; random?: () => number; handshakeTimeoutMs?: number }) {
    super();
    this.o = {
      url: o.url,
      token: o.token,
      WebSocketImpl: o.WebSocketImpl ?? WebSocket,
      backoff: o.backoff ?? { minMs: 1000, maxMs: 60_000 },
      entitlementBackoff: o.entitlementBackoff ?? { minMs: 30_000, maxMs: 300_000 },
      random: o.random ?? Math.random,
      handshakeTimeoutMs: o.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.replacedInRow = 0;
    this.watchWake();
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearRetry();
    if (this.wakeCheck) clearInterval(this.wakeCheck);
    this.wakeCheck = null;
    const ws = this.ws;
    this.detach();
    if (ws) try { ws.terminate(); } catch { /* already closed */ }
  }

  /** Asks the room to recompute the entitlement (it takes one per 30 s); while waiting out a 402/4402, connects now. */
  recheck(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send('{"t":"recheck"}');
      return;
    }
    if (this.running && this.retry?.kind === 'ent') {
      this.clearRetry();
      this.connect();
    }
  }

  send(env: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(env);
    return true;
  }

  /** Bytes queued on the relay socket and not yet written out (0 while not connected). */
  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  entitled(): { ok: boolean; until: number } | null {
    return this.ent;
  }

  private setState(s: RelayState): void {
    if (this.st === s) return;
    this.st = s;
    this.emit('state', s);
  }

  private connect(): void {
    const token = this.o.token();
    if (!token) {
      this.running = false;
      this.setState('unlinked');
      return;
    }
    this.setState('connecting');
    let status: number | null = null;
    const ws = new this.o.WebSocketImpl(this.o.url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: this.o.handshakeTimeoutMs,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
    });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.on('unexpected-response', (_req, res) => {
      status = res.statusCode ?? 0;
      res.resume();
      ws.terminate(); // → 'close'
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.pinger = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, PING_MS);
      this.timers.push(setTimeout(() => { this.attempt = 0; this.entAttempt = 0; }, GOOD_CONNECTION_MS));
      this.heard(ws);
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.heard(ws);
      if (isBinary) {
        this.emit('envelope', new Uint8Array(data as ArrayBuffer));
        return;
      }
      const text = String(data);
      if (text === 'pong') return;
      let m: unknown;
      try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m !== 'object') return;
      const c = m as { t?: unknown; ok?: unknown; until?: unknown };
      if (c.t === 'ent') {
        const ok = c.ok === true;
        this.ent = { ok, until: typeof c.until === 'number' ? c.until : 0 };
        this.notEntitled = !ok;
        this.setState(ok ? 'up' : 'not_entitled');
        this.emit('entitlement', this.ent);
        return;
      }
      this.emit('control', m);
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.detach();
      if (!this.running) return;
      if (status === 401 || code === CLOSE.unauthorized) {
        this.running = false;
        this.ent = null;
        this.notEntitled = false;
        this.setState('unlinked');
        return;
      }
      if (code === CLOSE.replaced) {
        this.setState('replaced');
        if (++this.replacedInRow >= REPLACED_MAX) {
          this.running = false; // another Mac keeps taking this host's place: stop until start()
          return;
        }
        this.schedule('replaced', this.jitter(REPLACED_WAIT_MS));
        return;
      }
      this.replacedInRow = 0; // only a drop for another reason ends a run of 4409s
      if (status === 402 || code === CLOSE.notEntitled) this.notEntitled = true;
      if (this.notEntitled) {
        this.setState('not_entitled');
        this.schedule('ent', this.delay(this.o.entitlementBackoff, this.entAttempt++));
        return;
      }
      this.setState('down');
      this.schedule('normal', this.delay(this.o.backoff, this.attempt++));
    });
  }

  private watchWake(): void {
    if (this.wakeCheck) clearInterval(this.wakeCheck);
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const slept = now - last > WAKE_CHECK_MS + WAKE_GAP_MS;
      last = now;
      if (!this.running) {
        clearInterval(timer);
        if (this.wakeCheck === timer) this.wakeCheck = null;
        return;
      }
      if (slept) this.woke();
    }, WAKE_CHECK_MS);
    timer.unref?.();
    this.wakeCheck = timer;
  }

  /** The Mac slept: an open socket is dropped and redone now; an ordinary backoff wait ends now. Other waits stay. */
  private woke(): void {
    if (this.retry) {
      if (this.retry.kind !== 'normal') return;
      this.attempt = 0;
      this.clearRetry();
      this.connect();
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return; // still connecting: its own timeout decides
    this.attempt = 0;
    this.detach();
    try { ws.terminate(); } catch { /* already closed */ }
    this.connect();
  }

  /** Something arrived: restart the silence watchdog. */
  private heard(ws: WebSocket): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => ws.terminate(), SILENCE_MS);
  }

  /** `min·2^n` capped at `max`, ±20 % jitter, never above `max`. */
  private delay(b: Backoff, n: number): number {
    return Math.min(b.maxMs, this.jitter(Math.min(b.maxMs, b.minMs * 2 ** Math.min(n, 30))));
  }

  private jitter(ms: number): number {
    return Math.round(ms * (1 + (this.o.random() * 2 - 1) * JITTER));
  }

  private schedule(kind: 'normal' | 'ent' | 'replaced', ms: number): void {
    this.clearRetry();
    this.retry = { kind, timer: setTimeout(() => { this.retry = null; if (this.running) this.connect(); }, ms) };
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = null;
  }

  private detach(): void {
    this.ws = null;
    if (this.pinger) clearInterval(this.pinger);
    if (this.silence) clearTimeout(this.silence);
    for (const t of this.timers) clearTimeout(t);
    this.pinger = null;
    this.silence = null;
    this.timers = [];
  }
}
