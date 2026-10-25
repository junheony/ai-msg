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
import { CLOSE } from '../../shared/cloud/frames';

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
        if (isBinary) { this.binReceived.push(new Uint8Array(data as Buffer)); return; }
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
