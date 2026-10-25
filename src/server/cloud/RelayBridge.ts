import { WebSocket } from 'ws';
import { fromB64u } from '../../shared/cloud/b64';
import { EnvKind, MAX_FRAME, TUNNEL_CHUNK, chunkString, decodeEnvelope, encodeEnvelope, encodeTunnel, parseTunnelFrame, type TunnelFrame } from '../../shared/cloud/frames';
import { DecryptError, hostHandshake, importStaticPrivate, type StaticKey, type Transport } from '../../shared/cloud/noise';
import { MAX_ATTACHMENT_BYTES } from '../attachments/AttachmentStore';
import { sm } from '../i18n';
import type { CloudState } from './CloudState';
import { loopbackHeaders, type LoopbackTarget } from './loopback';
import { relayPathPolicy } from './pathPolicy';
import type { RelayClient } from './RelayClient';
import { relayWsPolicy, type RelayWsContext } from './wsPolicy';

export type DropReason = 'revoked' | 'decrypt' | 'peer_down' | 'replaced';

const HS_TIMEOUT_MS = 5000;
/** Until a response starts; after that, the longest gap between its pieces. */
const HTTP_TIMEOUT_MS = 60_000;
/** Request bodies one device may have in flight at once (all its unfinished uploads together). */
const SESSION_BODY_BYTES = 16 * 1024 * 1024;
/** One response; past this the stream is cut (`http.abort`). */
const RESPONSE_BYTES = 100 * 1024 * 1024;
/** Responses stop reading from the loopback while the relay socket holds more than this, unsent. */
const RELAY_HIGH_WATER = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 20;
/** Lines per minute for handshakes from untrusted devices (anyone can send them through the relay). */
const UNTRUSTED_LOG_PER_MIN = 5;
const MAX_STREAMS = 8;
const MAX_HTTP = 32;
/** A phone's reassembled socket message, and its socket backlog before the loopback socket opens. */
const MAX_WS_MESSAGE = MAX_FRAME;
/** Request bodies: an attachment upload plus room for the multipart/JSON around it. */
const MAX_REQUEST_BODY = MAX_ATTACHMENT_BYTES + 64 * 1024;
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'range', 'if-none-match', 'x-deck-filename']);
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition', 'content-range', 'accept-ranges', 'location'];
/** Close codes a `ws.close` frame may carry (frames.ts `closeCode`). */
const sendableClose = (c: number) => Number.isInteger(c) && c >= 1000 && c <= 4999 && c !== 1005 && c !== 1006 && c !== 1015;
/** Device ids as the cloud makes them; anything else in a control message or envelope is ignored. */
const isDeviceId = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[\x21-\x7e]+$/.test(v);

type Stream = { ws: WebSocket; open: boolean; backlog: string[]; backlogBytes: number; frag: string[]; fragBytes: number };
/** `size` = body bytes held (counted in the session's `bodyBytes` until released); `forwarding` once the body is complete. */
type HttpReq = { ac: AbortController; timer: ReturnType<typeof setTimeout> | null; timedOut: boolean; forwarding: boolean; m: string; p: string; h: Record<string, string>; parts: Buffer[]; size: number };
type Session = {
  id: string;
  transport: Transport;
  ready: boolean;
  dead: boolean;
  streams: Map<number, Stream>;
  http: Map<number, HttpReq>;
  /** Sum of `size` over `http`. */
  bodyBytes: number;
  hsTimer: ReturnType<typeof setTimeout> | null;
  /** Outgoing frames, encrypted and sent strictly in nonce order. */
  out: Promise<void>;
};

/**
 * Noise sessions between paired phones and this Mac, over the relay (one per device), proxied to the Mac's own server
 * on 127.0.0.1 with the server cookie — which never leaves the Mac.
 *
 * - A device's `hs_init` (envelope `peer` = the id the relay stamped) is answered only for a trusted device, and makes
 *   a *pending* session. It becomes the device's session only once the device's `ready` decrypts with it; then any old
 *   session of that device is dropped. A replayed msg1 still yields a Transport, but the replayer cannot write the
 *   device's `ready`: the pending session dies after 5 s and the live one is untouched. The Mac's own `ready` goes out
 *   after the device's has opened (so a replayed msg1 never puts frames the phone cannot open on its channel).
 * - Frames per device are handled one at a time, in arrival order. A frame that does not decrypt (a replay, a reorder,
 *   a forgery) drops the device's session.
 * - Requests the Mac must confirm itself (pathPolicy / wsPolicy) are answered here and never reach the loopback.
 */
export class RelayBridge {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Session>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Revoked in this process: never shaken hands with again (the cloud gives a new pairing a new id). */
  private readonly revoked = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;
  private readonly log: (s: string) => void;
  private readonly limits: { httpTimeoutMs: number; sessionBodyBytes: number; responseBytes: number };
  private self: { src: string; key: Promise<StaticKey> } | null = null;
  private closed = false;
  private untrustedLog = { since: 0, n: 0 };

  constructor(private readonly o: {
    relay: Pick<RelayClient, 'send' | 'on' | 'bufferedAmount'>;
    state: CloudState;
    loopback: LoopbackTarget;
    hostVersion: string;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: typeof WebSocket;
    log?: (s: string) => void;
    /** A cloud `revoked` notice removed a device from the trusted list. */
    onDevicesChanged?: () => void;
    /** The Mac's current settings, for the socket policy (absent: judged as if nothing were consented to). */
    settings?: () => RelayWsContext;
    /** Tests: shorter limits. */
    limits?: Partial<{ httpTimeoutMs: number; sessionBodyBytes: number; responseBytes: number }>;
  }) {
    this.limits = { httpTimeoutMs: HTTP_TIMEOUT_MS, sessionBodyBytes: SESSION_BODY_BYTES, responseBytes: RESPONSE_BYTES, ...o.limits };
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
    this.WS = o.WebSocketImpl ?? WebSocket;
    this.log = o.log ?? ((s) => console.error(s));
    o.relay.on('envelope', (u8: Uint8Array) => this.onEnvelope(u8));
    o.relay.on('control', (m: unknown) => this.onControl(m));
  }

  /**
   * Drops the device's Noise sessions (live and pending), closes its loopback sockets and aborts its requests — at
   * once: nothing that arrives after this call is handled. `revoked` also tells the device (a `close` envelope) and
   * refuses its handshakes from now on.
   */
  dropDevice(id: string, reason: DropReason): void {
    if (reason === 'revoked') this.revoked.add(id);
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); this.closeSession(p); }
    const s = this.sessions.get(id);
    if (s) { this.sessions.delete(id); this.closeSession(s); }
    if (reason === 'revoked') this.o.relay.send(encodeEnvelope({ kind: EnvKind.Close, peer: id, payload: new Uint8Array(0) }));
  }

  /** Every session gone (the relay link dropped, or the service stops). */
  dropAll(): void {
    for (const id of new Set([...this.sessions.keys(), ...this.pending.keys()])) this.dropDevice(id, 'peer_down');
  }

  close(): void {
    this.closed = true;
    this.dropAll();
  }

  private onControl(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const c = m as { t?: unknown; dev?: unknown; up?: unknown };
    if (!isDeviceId(c.dev)) return;
    if (c.t === 'peer') {
      if (c.up === false) this.dropDevice(c.dev, 'peer_down');
      return;
    }
    if (c.t === 'revoked') {
      const id = c.dev;
      this.dropDevice(id, 'revoked'); // first, synchronously: no frame after this is handled
      this.o.state.removeDevice(id).then(
        (removed) => { if (removed) this.o.onDevicesChanged?.(); },
        (err: unknown) => this.log(`deck: cloud — could not remove a revoked device from the state file (${errName(err)})`),
      );
    }
  }

  private onEnvelope(u8: Uint8Array): void {
    if (this.closed) return;
    const e = decodeEnvelope(u8);
    if (!e || !isDeviceId(e.peer)) return;
    const id = e.peer;
    const next = (this.chains.get(id) ?? Promise.resolve())
      .then(() => this.handle(id, e.kind, e.payload))
      .catch((err: unknown) => this.log(`deck: cloud bridge error (${errName(err)})`));
    this.chains.set(id, next);
    void next.then(() => { if (this.chains.get(id) === next) this.chains.delete(id); });
  }

  private async handle(id: string, kind: EnvKind, payload: Uint8Array): Promise<void> {
    if (kind === EnvKind.HsInit) return this.onHsInit(id, payload);
    if (kind === EnvKind.Data) return this.onData(id, payload);
    if (kind === EnvKind.Close) this.dropDevice(id, 'peer_down');
  }

  private hostKey(): Promise<StaticKey> {
    const src = this.o.state.get().hostKey;
    if (this.self?.src !== src) this.self = { src, key: importStaticPrivate(src) };
    return this.self.key;
  }

  private trusted(id: string) {
    return this.revoked.has(id) ? undefined : this.o.state.get().devices.find((d) => d.id === id);
  }

  private async onHsInit(id: string, msg1: Uint8Array): Promise<void> {
    const dev = this.trusted(id);
    const hostId = this.o.state.get().hostId;
    if (!dev || !hostId) {
      const now = Date.now();
      if (now - this.untrustedLog.since >= 60_000) this.untrustedLog = { since: now, n: 0 };
      if (this.untrustedLog.n++ < UNTRUSTED_LOG_PER_MIN) this.log('deck: cloud — handshake from a device that is not trusted, ignored');
      return;
    }
    let r: Awaited<ReturnType<typeof hostHandshake>>;
    try {
      r = await hostHandshake({ self: await this.hostKey(), devicePublic: fromB64u(dev.pub), deviceId: id, hostId, msg1, hostVersion: this.o.hostVersion });
    } catch (err) {
      this.log(`deck: cloud — device handshake failed (${errName(err)})`);
      return;
    }
    if (this.closed || !this.trusted(id)) return; // revoked while the handshake ran
    const old = this.pending.get(id);
    if (old) this.closeSession(old);
    const sess: Session = { id, transport: r.transport, ready: false, dead: false, streams: new Map(), http: new Map(), bodyBytes: 0, hsTimer: null, out: Promise.resolve() };
    sess.hsTimer = setTimeout(() => {
      if (this.pending.get(id) !== sess) return;
      this.pending.delete(id);
      this.closeSession(sess);
    }, HS_TIMEOUT_MS);
    this.pending.set(id, sess);
    this.o.relay.send(encodeEnvelope({ kind: EnvKind.HsAck, peer: id, payload: r.msg2 }));
  }

  private async onData(id: string, ct: Uint8Array): Promise<void> {
    const pend = this.pending.get(id);
    if (pend) {
      let plain: Uint8Array | null = null;
      try { plain = await pend.transport.decrypt(ct); } catch { /* not this channel's: maybe the live session's */ }
      if (plain) {
        if (this.pending.get(id) !== pend) return;
        if (decodeFrame(plain)?.t !== 'ready') return; // authenticated, but nothing before `ready` counts
        this.pending.delete(id);
        if (pend.hsTimer) clearTimeout(pend.hsTimer);
        pend.hsTimer = null;
        const old = this.sessions.get(id);
        if (old) this.closeSession(old); // 'replaced': only now that the new channel is proven live
        pend.ready = true;
        this.sessions.set(id, pend);
        void this.sendFrame(pend, { t: 'ready' });
        return;
      }
      if (!this.sessions.has(id)) {
        this.pending.delete(id); // a frame the pending channel cannot open, and nothing else to try: give it up
        this.closeSession(pend);
        return;
      }
    }
    const sess = this.sessions.get(id);
    if (!sess) return;
    let plain: Uint8Array;
    try {
      plain = await sess.transport.decrypt(ct);
    } catch (err) {
      if (this.sessions.get(id) === sess) this.dropDevice(id, 'decrypt');
      if (!(err instanceof DecryptError)) this.log(`deck: cloud — device channel closed (${errName(err)})`);
      return;
    }
    if (sess.dead) return;
    const f = decodeFrame(plain);
    if (f) this.onFrame(sess, f);
  }

  private onFrame(sess: Session, f: TunnelFrame): void {
    switch (f.t) {
      case 'ws.open': return this.openStream(sess, f.s);
      case 'ws.msg': return this.streamMessage(sess, f.s, f.d, f.more === true);
      case 'ws.close': return this.closeStream(sess, f.s);
      case 'http.req': return this.httpRequest(sess, f);
      case 'http.chunk': return this.httpChunk(sess, f.id, f.b, f.more);
      case 'http.abort': {
        const r = sess.http.get(f.id);
        if (r) { sess.http.delete(f.id); this.endRequest(sess, r); }
        return;
      }
      default: return; // `ready` again, `http.res`: nothing to do
    }
  }

  // ── sockets ──

  private openStream(sess: Session, s: number): void {
    if (sess.streams.has(s)) return;
    if (sess.streams.size >= MAX_STREAMS) { void this.sendFrame(sess, { t: 'ws.close', s, code: 1013 }); return; }
    const lb = this.o.loopback;
    const ws = new this.WS(`ws://127.0.0.1:${lb.port}/ws`, { headers: loopbackHeaders(lb), perMessageDeflate: false });
    const st: Stream = { ws, open: false, backlog: [], backlogBytes: 0, frag: [], fragBytes: 0 };
    sess.streams.set(s, st);
    const mine = () => !sess.dead && sess.streams.get(s) === st;
    ws.on('open', () => {
      if (!mine()) return;
      st.open = true;
      for (const m of st.backlog.splice(0)) ws.send(m);
      st.backlogBytes = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (!mine()) return;
      this.sendText(sess, s, isBinary ? Buffer.from(data as Buffer).toString('utf8') : String(data));
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', (code) => {
      if (!mine()) return;
      sess.streams.delete(s);
      void this.sendFrame(sess, sendableClose(code) ? { t: 'ws.close', s, code } : { t: 'ws.close', s });
    });
  }

  private streamMessage(sess: Session, s: number, d: string, more: boolean): void {
    const st = sess.streams.get(s);
    if (!st) return;
    st.frag.push(d);
    st.fragBytes += Buffer.byteLength(d);
    if (st.fragBytes > MAX_WS_MESSAGE) { this.closeStream(sess, s, 1009); return; }
    if (more) return;
    const text = st.frag.join('');
    st.frag = [];
    st.fragBytes = 0;
    let msg: unknown = null;
    try { msg = JSON.parse(text); } catch { /* the server refuses it as before */ }
    if (relayWsPolicy(msg, this.o.settings?.()) === 'mac_confirm_required') {
      const o = msg as { clientRef?: unknown; sessionId?: unknown };
      const reply = JSON.stringify({
        type: 'error', turnId: null, message: sm().cloud.macConfirmRequired, code: 'mac_confirm_required',
        ...(typeof o.clientRef === 'string' ? { clientRef: o.clientRef } : {}),
        ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
      });
      this.sendText(sess, s, reply);
      return;
    }
    if (st.open) { st.ws.send(text); return; }
    st.backlogBytes += Buffer.byteLength(text);
    if (st.backlogBytes > MAX_WS_MESSAGE) { this.closeStream(sess, s, 1009); return; }
    st.backlog.push(text);
  }

  /** One socket message to the phone, in `ws.msg` pieces that each fit a Noise message (`more` on all but the last). */
  private sendText(sess: Session, s: number, text: string): void {
    const parts = chunkString(text, TUNNEL_CHUNK);
    if (parts.length === 0) parts.push('');
    parts.forEach((d, i) => { void this.sendFrame(sess, i < parts.length - 1 ? { t: 'ws.msg', s, d, more: true } : { t: 'ws.msg', s, d }); });
  }

  /** Closes the loopback socket; with `code` also tells the phone (the phone's own `ws.close` needs no answer). */
  private closeStream(sess: Session, s: number, code?: number): void {
    const st = sess.streams.get(s);
    if (!st) return;
    sess.streams.delete(s);
    shut(st.ws);
    if (code !== undefined) void this.sendFrame(sess, { t: 'ws.close', s, code });
  }

  // ── HTTP ──

  private httpRequest(sess: Session, f: Extract<TunnelFrame, { t: 'http.req' }>): void {
    if (sess.http.has(f.id)) return;
    if (sess.http.size >= MAX_HTTP) { void this.respond(sess, f.id, 503, { error: 'busy' }); return; }
    const verdict = relayPathPolicy(f.m, f.p);
    if (verdict === 'deny') { void this.respond(sess, f.id, 403, { error: 'forbidden' }); return; }
    if (verdict === 'mac_confirm_required') { void this.respond(sess, f.id, 403, { error: 'mac_confirm_required', code: 'mac_confirm_required' }); return; }
    const r: HttpReq = { ac: new AbortController(), timer: null, timedOut: false, forwarding: false, m: f.m, p: f.p, h: f.h, parts: [], size: 0 };
    r.timer = setTimeout(() => {
      r.timedOut = true;
      if (r.forwarding) { r.ac.abort(); return; } // forward() answers 504
      // The body never completed: nothing will forward it, so answer here and let its bytes go.
      if (sess.http.get(f.id) !== r) return;
      sess.http.delete(f.id);
      this.endRequest(sess, r);
      void this.respond(sess, f.id, 504, { error: 'timeout' });
    }, this.limits.httpTimeoutMs);
    sess.http.set(f.id, r);
    this.httpChunk(sess, f.id, f.b ?? '', f.more);
  }

  private httpChunk(sess: Session, id: number, b: string, more: boolean): void {
    const r = sess.http.get(id);
    if (!r || r.forwarding || r.ac.signal.aborted) return;
    if (b) {
      const buf = Buffer.from(b, 'base64');
      r.size += buf.length;
      sess.bodyBytes += buf.length;
      if (r.size > MAX_REQUEST_BODY || sess.bodyBytes > this.limits.sessionBodyBytes) {
        sess.http.delete(id);
        this.endRequest(sess, r);
        void this.respond(sess, id, 413, { error: 'too_large' });
        return;
      }
      r.parts.push(buf);
    }
    if (!more) { r.forwarding = true; void this.forward(sess, id, r); }
  }

  private async forward(sess: Session, id: number, r: HttpReq): Promise<void> {
    const alive = () => !sess.dead && sess.http.get(id) === r;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.h)) if (REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    Object.assign(headers, loopbackHeaders(this.o.loopback));
    const idle = () => {
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => { r.timedOut = true; r.ac.abort(); }, this.limits.httpTimeoutMs);
    };
    // Backpressure: hold off while the relay socket is backed up (the wait itself is not idleness).
    const drain = async () => {
      if (this.o.relay.bufferedAmount() <= RELAY_HIGH_WATER) return;
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      while (this.o.relay.bufferedAmount() > RELAY_HIGH_WATER) {
        if (!alive() || r.ac.signal.aborted) throw new Error('gone');
        await new Promise((res) => setTimeout(res, DRAIN_POLL_MS));
      }
      idle();
    };
    let started = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let total = 0;
    const read = async () => {
      const c = await reader!.read();
      if (!c.done) {
        total += c.value.length;
        if (total > this.limits.responseBytes) throw new Error('too_large');
      }
      return c;
    };
    try {
      const body = r.m === 'GET' || r.m === 'HEAD' ? undefined : Buffer.concat(r.parts);
      this.release(sess, r); // the bytes are fetch's now
      const res = await this.fetchImpl(`http://127.0.0.1:${this.o.loopback.port}${r.p}`, {
        method: r.m,
        headers,
        body,
        signal: r.ac.signal,
        redirect: 'manual',
      });
      const h: Record<string, string> = {};
      for (const k of RESPONSE_HEADERS) { const v = res.headers.get(k); if (v !== null) h[k] = v; }
      reader = res.body?.getReader() ?? null;
      let acc: Buffer = Buffer.alloc(0);
      let done = reader === null;
      // Read until there is something (or nothing at all) so `http.res.more` is right.
      while (!done && acc.length === 0) {
        const c = await read();
        if (c.done) done = true;
        else acc = Buffer.concat([acc, c.value]);
      }
      if (!alive()) { await reader?.cancel().catch(() => undefined); return; }
      started = true;
      idle(); // from here on the limit is the gap between pieces
      await this.sendFrame(sess, { t: 'http.res', id, st: res.status, h, more: acc.length > 0 });
      let held: Buffer | null = null;
      for (;;) {
        while (acc.length >= TUNNEL_CHUNK) {
          if (held) { await drain(); await this.sendFrame(sess, { t: 'http.chunk', id, b: held.toString('base64'), more: true }); }
          held = acc.subarray(0, TUNNEL_CHUNK);
          acc = acc.subarray(TUNNEL_CHUNK);
        }
        if (!alive()) { await reader?.cancel().catch(() => undefined); return; }
        if (done) break;
        await drain();
        const c = await read();
        if (c.done) done = true;
        else { acc = Buffer.concat([acc, c.value]); idle(); }
      }
      if (acc.length > 0) {
        if (held) { await drain(); await this.sendFrame(sess, { t: 'http.chunk', id, b: held.toString('base64'), more: true }); }
        held = acc;
      }
      if (held) await this.sendFrame(sess, { t: 'http.chunk', id, b: held.toString('base64'), more: false });
    } catch {
      r.ac.abort(); // closes the loopback request too (a cut-off response, a backed-up relay that went away)
      await reader?.cancel().catch(() => undefined);
      if (!alive()) return;
      if (started) void this.sendFrame(sess, { t: 'http.abort', id });
      else void this.respond(sess, id, r.timedOut ? 504 : 502, { error: r.timedOut ? 'timeout' : 'loopback_unreachable' });
    } finally {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      if (sess.http.get(id) === r) sess.http.delete(id);
    }
  }

  private respond(sess: Session, id: number, st: number, body: unknown): Promise<void> {
    return this.sendFrame(sess, { t: 'http.res', id, st, h: { 'content-type': 'application/json' }, b: Buffer.from(JSON.stringify(body)).toString('base64'), more: false });
  }

  /** Lets a request's body bytes go (once): out of the session's in-flight total. */
  private release(sess: Session, r: HttpReq): void {
    sess.bodyBytes -= r.size;
    r.size = 0;
    r.parts = [];
  }

  private endRequest(sess: Session, r: HttpReq): void {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    this.release(sess, r);
    r.ac.abort();
  }

  // ── sessions ──

  private sendFrame(sess: Session, f: TunnelFrame): Promise<void> {
    const run = sess.out.then(async () => {
      if (sess.dead) return;
      const ct = await sess.transport.encrypt(encodeTunnel(f));
      if (sess.dead) return;
      this.o.relay.send(encodeEnvelope({ kind: EnvKind.Data, peer: sess.id, payload: ct }));
    });
    sess.out = run.catch((err: unknown) => {
      if (!sess.dead && this.sessions.get(sess.id) === sess) this.dropDevice(sess.id, 'decrypt');
      this.log(`deck: cloud — could not send to a device (${errName(err)})`);
    });
    return sess.out;
  }

  private closeSession(sess: Session): void {
    sess.dead = true;
    if (sess.hsTimer) clearTimeout(sess.hsTimer);
    sess.hsTimer = null;
    for (const st of sess.streams.values()) shut(st.ws);
    sess.streams.clear();
    for (const r of sess.http.values()) this.endRequest(sess, r);
    sess.http.clear();
  }
}

function decodeFrame(plain: Uint8Array): TunnelFrame | null {
  try {
    return parseTunnelFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  } catch {
    return null;
  }
}

function shut(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    else ws.terminate();
  } catch { /* already closed */ }
}

/** An error's class name only: messages may carry addresses. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
