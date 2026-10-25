import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { CLOSE } from '../../shared/cloud/frames';

export type RelayState = 'connecting' | 'up' | 'down' | 'not_entitled' | 'unlinked' | 'replaced';
type Backoff = { minMs: number; maxMs: number };

const PING_MS = 25_000;
const SILENCE_MS = 60_000;
const GOOD_CONNECTION_MS = 60_000;
const REPLACED_WAIT_MS = 600_000;
const JITTER = 0.2;

/**
 * The Mac's one WebSocket to the relay (`wss://<relay>/relay/host`, host Bearer token).
 *
 * - The upgrade does not look at the entitlement: after it the room sends `{t:'ent', ok, until}` (first text, then on
 *   every alarm/recheck). Until the first one the state stays `connecting`; each one flips `up` ↔ `not_entitled`
 *   without dropping the socket, so a payment's recheck reaches an attached Mac within seconds (2차 필수 1).
 * - Binary messages are envelopes (`'envelope'`); other JSON texts (`peer`, `revoked`) are `'control'`.
 * - Text `ping` every 25 s (the room auto-answers `pong`); 60 s without receiving anything → drop and reconnect.
 * - Upgrade 401 / close 4401 → `unlinked`, stop. Upgrade 402 / close 4402 → `not_entitled`, entitlement backoff
 *   (30 s doubling, at most 5 min). 4409 → `replaced`, retry in 10 min. Anything else → exponential backoff ±20 %;
 *   a drop while not entitled uses the entitlement backoff, so it also stays within 5 min. 60 s attached resets both.
 */
export class RelayClient extends EventEmitter {
  private readonly o: { url: string; token: () => string | null; WebSocketImpl: typeof WebSocket; backoff: Backoff; entitlementBackoff: Backoff; random: () => number };
  private ws: WebSocket | null = null;
  private running = false;
  private st: RelayState | null = null;
  private ent: { ok: boolean; until: number } | null = null;
  /** Last word on the entitlement: an `ent` message, a 402 upgrade or a 4402 close. */
  private notEntitled = false;
  private attempt = 0;
  private entAttempt = 0;
  private retry: { timer: ReturnType<typeof setTimeout>; kind: 'normal' | 'ent' | 'replaced' } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pinger: ReturnType<typeof setInterval> | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;

  constructor(o: { url: string; token: () => string | null; WebSocketImpl?: typeof WebSocket; backoff?: Backoff; entitlementBackoff?: Backoff; random?: () => number }) {
    super();
    this.o = {
      url: o.url,
      token: o.token,
      WebSocketImpl: o.WebSocketImpl ?? WebSocket,
      backoff: o.backoff ?? { minMs: 1000, maxMs: 60_000 },
      entitlementBackoff: o.entitlementBackoff ?? { minMs: 30_000, maxMs: 300_000 },
      random: o.random ?? Math.random,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearRetry();
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
    const ws = new this.o.WebSocketImpl(this.o.url, { headers: { authorization: `Bearer ${token}` } });
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
        this.schedule('replaced', REPLACED_WAIT_MS);
        return;
      }
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

  /** Something arrived: restart the silence watchdog. */
  private heard(ws: WebSocket): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => ws.terminate(), SILENCE_MS);
  }

  /** `min·2^n` capped at `max`, ±20 % jitter, never above `max`. */
  private delay(b: Backoff, n: number): number {
    const base = Math.min(b.maxMs, b.minMs * 2 ** Math.min(n, 30));
    return Math.min(b.maxMs, Math.round(base * (1 + (this.o.random() * 2 - 1) * JITTER)));
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
