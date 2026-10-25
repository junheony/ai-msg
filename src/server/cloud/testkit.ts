/**
 * Test doubles for the local cloud client. `FakeRelay` mimics the relay Durable Object's host side
 * (cloud/src/relay/routes.ts `relayHost` + RelayRoom): the upgrade checks only the Bearer token (no entitlement),
 * the first text after accept is `{t:'ent', ok, until}`, `ping` is answered with `pong`, `{"t":"recheck"}` is
 * recorded, a second host socket closes the first with 4409, and control messages / close codes are sent on demand.
 * Plain `ws` on 127.0.0.1 — no real network.
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { toB64u } from '../../shared/cloud/b64';
import { CLOSE, EnvKind, decodeEnvelope, encodeEnvelope, parseTunnelFrame, type TunnelFrame } from '../../shared/cloud/frames';
import { deviceHandshake, generateStaticKey, importStaticPrivate, type StaticKey, type Transport } from '../../shared/cloud/noise';
import { COOKIE_NAME, checkUpgrade, cookieValueFor } from '../auth';
import type { CloudState } from './CloudState';

export type FakeRelayOpts = {
  token?: string;
  /** Answer upgrades with this HTTP status instead of accepting (401, 402, 503 …). `null` accepts. */
  upgradeStatus?: number | null;
  /** First text sent after accept; `null` sends none. Default: entitled for a day. */
  ent?: { ok: boolean; until: number } | null;
  /** Answer `ping` with `pong` (the DO's auto-response). */
  autoPong?: boolean;
};

export class FakeRelay {
  readonly url: string;
  token: string;
  upgradeStatus: number | null;
  ent: { ok: boolean; until: number } | null;
  autoPong: boolean;
  /** Upgrade requests seen, refused ones included. */
  attempts = 0;
  readonly textsReceived: string[] = [];
  readonly binReceived: Uint8Array[] = [];
  readonly authHeaders: (string | undefined)[] = [];
  socket: WebSocket | null = null;
  private readonly events = new EventEmitter();
  private readonly binListeners: ((u8: Uint8Array) => void)[] = [];

  private constructor(private readonly server: http.Server, private readonly wss: WebSocketServer, o: FakeRelayOpts) {
    this.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/relay/host`;
    this.token = o.token ?? 'host-token';
    this.upgradeStatus = o.upgradeStatus ?? null;
    this.ent = o.ent === undefined ? { ok: true, until: Date.now() + 86_400_000 } : o.ent;
    this.autoPong = o.autoPong ?? true;
  }

  static async start(o: FakeRelayOpts = {}): Promise<FakeRelay> {
    const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const relay = new FakeRelay(server, wss, o);
    server.on('upgrade', (req, sock, head) => relay.onUpgrade(req, sock as import('node:net').Socket, head));
    return relay;
  }

  private onUpgrade(req: http.IncomingMessage, sock: import('node:net').Socket, head: Buffer): void {
    sock.on('error', () => { /* the client may drop mid-handshake */ });
    this.attempts++;
    this.authHeaders.push(req.headers.authorization);
    const refuse = (status: number, code: string) => {
      const body = JSON.stringify({ error: code, code });
      sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
      this.events.emit('attempt');
    };
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/relay/host') return refuse(404, 'not_found');
    if (req.headers.authorization !== `Bearer ${this.token}`) return refuse(401, 'unauthorized');
    if (this.upgradeStatus !== null) return refuse(this.upgradeStatus, this.upgradeStatus === 402 ? 'not_entitled' : 'refused');
    this.wss.handleUpgrade(req, sock, head, (ws) => {
      const old = this.socket;
      this.socket = ws;
      if (old) old.close(CLOSE.replaced, 'replaced');
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const u8 = new Uint8Array(data as Buffer);
          this.binReceived.push(u8);
          for (const cb of this.binListeners) cb(u8);
          return;
        }
        const text = String(data);
        this.textsReceived.push(text);
        if (text === 'ping' && this.autoPong) ws.send('pong');
        this.events.emit('text');
      });
      ws.on('close', () => { if (this.socket === ws) this.socket = null; });
      if (this.ent) ws.send(JSON.stringify({ t: 'ent', ...this.ent }));
      this.events.emit('attempt');
    });
  }

  /** Resolves once `attempts >= n` and that attempt has been answered. */
  attempted(n: number): Promise<void> {
    return this.until('attempt', () => this.attempts >= n);
  }

  /** Resolves once a text message matching `pred` has arrived. */
  received(pred: (text: string) => boolean): Promise<void> {
    return this.until('text', () => this.textsReceived.some(pred));
  }

  /** Every binary message (envelope) the host sends from now on. */
  onBinary(cb: (u8: Uint8Array) => void): void {
    this.binListeners.push(cb);
  }

  control(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

  envelope(bytes: Uint8Array): void {
    this.socket?.send(bytes);
  }

  closeHost(code: number, reason = ''): void {
    this.socket?.close(code, reason);
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private until(ev: string, ok: () => boolean): Promise<void> {
    if (ok()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => { if (ok()) { this.events.off(ev, check); resolve(); } };
      this.events.on(ev, check);
    });
  }
}

/** Polls `cond` on the event loop (setImmediate — untouched by fake timers that fake only timeouts/intervals/Date). */
export async function waitFor(cond: () => boolean, maxTurns = 20_000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor: condition not met');
}

/**
 * Stand-in for the Mac's own server on 127.0.0.1 as the bridge sees it: answers only requests carrying the server
 * cookie, a loopback Host and the matching Origin (the real `checkUpgrade` for `/ws`). Routes: `GET /api/me` (200),
 * `GET /api/big` (100 KiB), `GET /api/slow` (never answers; counted in `aborted` when the bridge gives up),
 * `/api/trickle?n=&gap=` (one byte per `gap` ms), `/api/stall` (one byte, then nothing), `POST /api/echo` (body and headers back), `/ws` echoes each text as `echo:<text>`.
 */
export class FakeLoopback {
  readonly port: number;
  hits = 0;
  aborted = 0;
  wsClosed = 0;
  lastCookie: string | undefined;
  lastHeaders: http.IncomingHttpHeaders = {};
  readonly wsReceived: string[] = [];
  readonly sockets: WebSocket[] = [];

  private constructor(private readonly server: http.Server, private readonly wss: WebSocketServer, readonly token: string) {
    this.port = (server.address() as AddressInfo).port;
  }

  static async start(token = 'tok'): Promise<FakeLoopback> {
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const loop = new FakeLoopback(server, wss, token);
    server.on('request', (req, res) => loop.onRequest(req, res));
    server.on('upgrade', (req, sock, head) => {
      const chk = checkUpgrade({ headers: { cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host } }, token);
      if (req.url !== '/ws' || !chk.ok) { sock.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n'); return; }
      wss.handleUpgrade(req, sock, head, (ws) => {
        loop.sockets.push(ws);
        ws.on('message', (d) => { const t = String(d); loop.wsReceived.push(t); ws.send(`echo:${t}`); });
        ws.on('close', () => { loop.wsClosed++; });
      });
    });
    return loop;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.hits++;
    this.lastCookie = req.headers.cookie;
    this.lastHeaders = req.headers;
    const host = `127.0.0.1:${this.port}`;
    if (req.headers.cookie !== `${COOKIE_NAME}=${cookieValueFor(this.token)}` || req.headers.host !== host || (req.method !== 'GET' && req.headers.origin !== `http://${host}`)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.url === '/api/me') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=y' }).end('{"ok":true}'); return; }
    if (req.url === '/api/big') { res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(100 * 1024, 7)); return; }
    if (req.url === '/api/slow') { res.on('close', () => { if (!res.writableEnded) this.aborted++; }); return; }
    if (req.url?.startsWith('/api/trickle')) {
      // Starts at once, then one byte every `gap` ms, `n` bytes in all (?n=&gap=).
      const q = new URL(req.url, 'http://x').searchParams;
      const n = Number(q.get('n') ?? 5);
      const gap = Number(q.get('gap') ?? 100);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('t');
      let sent = 1;
      const timer = setInterval(() => { if (++sent >= n) { clearInterval(timer); res.end('t'); } else res.write('t'); }, gap);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url === '/api/stall') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('s');
      res.on('close', () => { if (!res.writableEnded) this.aborted++; });
      return;
    }
    if (req.url === '/api/echo' && req.method === 'POST') {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ body: Buffer.concat(parts).toString('utf8'), headers: req.headers })));
      return;
    }
    res.writeHead(404).end();
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export type DeviceHttpRes = { status: number; headers: Record<string, string>; body: string; frames: TunnelFrame[] };
export type DeviceStream = { s: number; send(text: string): void; next(): Promise<string>; closed: Promise<number | undefined> };

/**
 * A fake phone speaking the tunnel protocol through a `FakeRelay` (which plays the Durable Object: envelopes the host
 * sends to this device's id arrive here, and this device's envelopes reach the host as the relay's own messages).
 * Its key is added to the Mac's trusted list by `trust()`.
 */
export class FakeDevice {
  readonly framesReceived: TunnelFrame[] = [];
  /** Every envelope this device sent, as sent (replay tests resend one). */
  readonly sent: Uint8Array[] = [];
  closedByHost = false;
  hsAcks = 0;
  private transport: Transport | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  private onHsAck: ((msg2: Uint8Array) => void) | null = null;
  private hostReady: (() => void) | null = null;
  private nextStream = 1;
  private nextReq = 1;
  private readonly httpReqs = new Map<number, { frames: TunnelFrame[]; parts: Uint8Array[]; resolve(r: DeviceHttpRes): void; reject(e: Error): void }>();
  private readonly streams = new Map<number, { queue: string[]; waiters: ((t: string) => void)[]; parts: string[]; close(code?: number): void }>();
  private ended: (() => void)[] = [];

  private constructor(readonly id: string, readonly key: StaticKey, private readonly relay: FakeRelay) {
    relay.onBinary((u8) => {
      const e = decodeEnvelope(u8);
      if (!e || e.peer !== this.id) return;
      this.inbox = this.inbox.then(() => this.onEnvelope(e.kind, e.payload)).catch(() => undefined);
    });
  }

  static async create(relay: FakeRelay, id = 'dev-1'): Promise<FakeDevice> {
    return new FakeDevice(id, await generateStaticKey({ extractable: false }), relay);
  }

  /** Adds this device to the Mac's trusted list. */
  async trust(state: CloudState, name = 'iPhone'): Promise<void> {
    await state.update({ devices: [...state.get().devices.filter((d) => d.id !== this.id), { id: this.id, name, pub: toB64u(this.key.publicRaw), addedAt: Date.now() }] });
  }

  /** hs_init → hs_ack. With `sendReady` (default) also sends `ready` and waits for the Mac's `ready`. */
  async connect(state: CloudState, o: { sendReady?: boolean; uiVersion?: string } = {}): Promise<{ msg1Envelope: Uint8Array }> {
    const s = state.get();
    const host = await importStaticPrivate(s.hostKey);
    const hs = await deviceHandshake({ self: this.key, hostPublic: host.publicRaw, deviceId: this.id, hostId: s.hostId ?? '', uiVersion: o.uiVersion ?? '1.0.0' });
    const msg2 = new Promise<Uint8Array>((r) => { this.onHsAck = r; });
    const hostReady = new Promise<void>((r) => { this.hostReady = r; });
    const msg1Envelope = this.raw(EnvKind.HsInit, hs.msg1);
    const { transport } = await hs.finish(await msg2);
    this.transport = transport;
    if (o.sendReady !== false) {
      await this.frame({ t: 'ready' });
      await hostReady;
    }
    return { msg1Envelope };
  }

  /** Sends `ready` (after `connect({sendReady:false})`) and waits for the Mac's. */
  async ready(): Promise<void> {
    const hostReady = new Promise<void>((r) => { this.hostReady = r; });
    await this.frame({ t: 'ready' });
    await hostReady;
  }

  /** Sends bytes to the Mac as this device's envelope. */
  raw(kind: EnvKind, payload: Uint8Array): Uint8Array {
    const env = encodeEnvelope({ kind, peer: this.id, payload });
    this.sent.push(env);
    this.relay.envelope(env);
    return env;
  }

  /** Encrypts and sends a frame (in nonce order); resolves with the envelope sent. */
  frame(f: TunnelFrame | Record<string, unknown>): Promise<Uint8Array> {
    const run = this.outbox.then(async () => {
      if (!this.transport) throw new Error('no transport');
      return this.raw(EnvKind.Data, await this.transport.encrypt(new TextEncoder().encode(JSON.stringify(f))));
    });
    this.outbox = run.then(() => undefined, () => undefined);
    return run;
  }

  http(m: string, p: string, o: { h?: Record<string, string>; body?: string } = {}): Promise<DeviceHttpRes> {
    const id = this.nextReq++;
    const res = new Promise<DeviceHttpRes>((resolve, reject) => { this.httpReqs.set(id, { frames: [], parts: [], resolve, reject }); });
    const b = o.body === undefined ? undefined : Buffer.from(o.body).toString('base64');
    void this.frame({ t: 'http.req', id, m, p, h: o.h ?? {}, ...(b === undefined ? {} : { b }), more: false }).catch(() => undefined);
    return res;
  }

  /** An `http.req` with its body in `http.chunk`s; `end: false` never sends the last one. */
  httpChunks(m: string, p: string, chunks: Buffer[], o: { h?: Record<string, string>; end?: boolean } = {}): Promise<DeviceHttpRes> {
    const id = this.nextReq++;
    const res = new Promise<DeviceHttpRes>((resolve, reject) => { this.httpReqs.set(id, { frames: [], parts: [], resolve, reject }); });
    void this.frame({ t: 'http.req', id, m, p, h: o.h ?? {}, more: true }).catch(() => undefined);
    chunks.forEach((c, i) => {
      const last = i === chunks.length - 1 && o.end !== false;
      void this.frame({ t: 'http.chunk', id, b: c.toString('base64'), more: !last }).catch(() => undefined);
    });
    return res;
  }

  async wsOpen(): Promise<DeviceStream> {
    const s = this.nextStream++;
    const st = { queue: [] as string[], waiters: [] as ((t: string) => void)[], parts: [] as string[], close: (_code?: number) => {} };
    const closed = new Promise<number | undefined>((r) => { st.close = r; });
    this.streams.set(s, st);
    await this.frame({ t: 'ws.open', s });
    return {
      s,
      send: (d) => { void this.frame({ t: 'ws.msg', s, d }).catch(() => undefined); },
      next: () => new Promise<string>((r) => { const t = st.queue.shift(); if (t !== undefined) r(t); else st.waiters.push(r); }),
      closed,
    };
  }

  /** Resolves when the Mac closes this device's session (a `close` envelope). */
  whenClosed(): Promise<void> {
    if (this.closedByHost) return Promise.resolve();
    return new Promise((r) => this.ended.push(r));
  }

  private async onEnvelope(kind: EnvKind, payload: Uint8Array): Promise<void> {
    if (kind === EnvKind.HsAck) { this.hsAcks++; this.onHsAck?.(payload); this.onHsAck = null; return; }
    if (kind === EnvKind.Close) {
      this.closedByHost = true;
      for (const r of this.httpReqs.values()) r.reject(new Error('session closed'));
      this.httpReqs.clear();
      for (const e of this.ended.splice(0)) e();
      return;
    }
    if (kind !== EnvKind.Data || !this.transport) return;
    const f = parseTunnelFrame(JSON.parse(new TextDecoder().decode(await this.transport.decrypt(payload))));
    if (!f) return;
    this.framesReceived.push(f);
    if (f.t === 'ready') { this.hostReady?.(); this.hostReady = null; return; }
    if (f.t === 'ws.msg') {
      const st = this.streams.get(f.s);
      if (!st) return;
      st.parts.push(f.d);
      if (f.more) return;
      const text = st.parts.splice(0).join('');
      const w = st.waiters.shift();
      if (w) w(text); else st.queue.push(text);
      return;
    }
    if (f.t === 'ws.close') { this.streams.get(f.s)?.close(f.code); this.streams.delete(f.s); return; }
    if (f.t === 'http.res' || f.t === 'http.chunk' || f.t === 'http.abort') {
      const r = this.httpReqs.get(f.id);
      if (!r) return;
      r.frames.push(f);
      if (f.t === 'http.abort') { this.httpReqs.delete(f.id); r.reject(new Error('aborted')); return; }
      if (f.b) r.parts.push(Buffer.from(f.b, 'base64'));
      if (f.more) return;
      this.httpReqs.delete(f.id);
      const head = r.frames[0] as Extract<TunnelFrame, { t: 'http.res' }>;
      r.resolve({ status: head.st, headers: head.h, body: Buffer.concat(r.parts).toString('utf8'), frames: r.frames });
    }
  }
}
