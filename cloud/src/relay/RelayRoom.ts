import { DurableObject } from 'cloudflare:workers';
import { CLOSE, MAX_FRAME, decodeEnvelope, encodeEnvelope } from '../../../src/shared/cloud/envelope';
import { entitledState } from '../entitled';
import type { Env } from '../env';

/**
 * Per-socket state; survives hibernation (serializeAttachment). Every socket of one room has the same `user`.
 * `tok`/`tokAt` are the frame token bucket (device sockets only), `bad` marks that this socket's malformed frame was already logged.
 * A socket without an attachment is one still being checked (or refused) by `upgrade`: it routes nothing.
 */
type Att = { role: 'host' | 'device'; host: string; dev?: string; user: string; until: number; lastRecheck: number; tok: number; tokAt: number; bad?: true };

const RECHECK_GAP_MS = 30_000;
/** Frame limit per device socket: 200 frames/s sustained, bursts of 400 — far above a phone's input; past it, 4429. */
const FRAME_RATE = 200;
const FRAME_BURST = 400;
const OPEN = 1; // WebSocket.READY_STATE_OPEN

/** The only log line the relay writes: metadata, never a payload (Global Constraints "클라우드는 평문을 보지 않는다"). */
export function relayLog(ev: string, f: { host?: string; dev?: string; bytes?: number; code?: number } = {}): void {
  const { host, dev, bytes, code } = f;
  console.log(JSON.stringify({ ev, host, dev, bytes, code }));
}

const sendText = (ws: WebSocket, msg: Record<string, unknown>) => { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } };
const closeWs = (ws: WebSocket, code: number, reason: string) => { try { ws.close(code, reason); } catch { /* already closed */ } };
const sendBin = (ws: WebSocket, bytes: Uint8Array) => { try { ws.send(bytes); } catch { /* closing */ } };

/**
 * One relay room per host (`idFromName(hostId)`), Hibernation WebSocket API only — no timers, no in-memory state.
 * Tags: `host` and `dev:<deviceId>`. It reads the envelope head (kind, peer) and nothing else: a device's `peer`
 * is overwritten with its own id, the host's `peer` picks the device and becomes `host`. Entitlement is the
 * attachment `until`, re-read from D1 by `alarm()`.
 */
export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private open(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN && att(ws) !== null);
  }
  private devices(): WebSocket[] {
    return this.open().filter((ws) => att(ws)!.role === 'device');
  }

  /** Arms the alarm at the earliest future `until`, unless an earlier one (a pending recheck) is already set. */
  private async armAlarm(now: number): Promise<void> {
    const untils = this.open().map((ws) => att(ws)!.until).filter((u) => u > now);
    if (untils.length === 0) return; // only a not-entitled host: the next check comes from a recheck
    const at = Math.min(...untils);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/internal/revoke') {
      const body = (await req.json().catch(() => ({}))) as { dev?: unknown };
      const dev = typeof body.dev === 'string' ? body.dev : '';
      for (const ws of this.ctx.getWebSockets(`dev:${dev}`)) closeWs(ws, CLOSE.revoked, 'revoked');
      const host = this.open('host')[0];
      if (host) sendText(host, { t: 'revoked', dev });
      relayLog('revoke', { host: host ? att(host)!.host : undefined, dev, code: CLOSE.revoked });
      return new Response(null, { status: 204 });
    }
    if (path === '/internal/unlink') {
      for (const ws of this.ctx.getWebSockets()) closeWs(ws, CLOSE.unauthorized, 'unlinked');
      await this.ctx.storage.deleteAlarm();
      relayLog('unlink', { code: CLOSE.unauthorized });
      return new Response(null, { status: 204 });
    }
    if (path === '/internal/recheck') {
      await this.ctx.storage.setAlarm(Date.now());
      return new Response(null, { status: 204 });
    }
    return this.upgrade(req);
  }

  private async upgrade(req: Request): Promise<Response> {
    const h = req.headers;
    const role = h.get('x-relay-role');
    const host = h.get('x-relay-host');
    const user = h.get('x-relay-user');
    const untilRaw = h.get('x-relay-until');
    const dev = h.get('x-relay-device');
    const until = Number(untilRaw);
    // Never an attachment without `user` (the alarm reads it): any missing header is the Worker's bug.
    if ((role !== 'host' && role !== 'device') || !host || !user || untilRaw === null || !Number.isFinite(until) || (role === 'device' && !dev)) {
      relayLog('bad_upgrade', { host: host ?? undefined });
      return new Response(null, { status: 500 });
    }
    if ((h.get('upgrade') ?? '').toLowerCase() !== 'websocket') return new Response(null, { status: 426 });

    const tag = role === 'host' ? 'host' : `dev:${dev}`;
    const old = this.ctx.getWebSockets(tag);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [tag]);
    // A revoke/unlink can commit between the Worker's ticket/token check and this accept; its notice then found
    // nothing to close. Re-read D1 now that the socket is visible to later notices: not active → close at once.
    const live = role === 'host'
      ? await this.env.DB.prepare('SELECT 1 FROM hosts WHERE id = ? AND revoked_at IS NULL').bind(host).first()
      : await this.env.DB.prepare("SELECT 1 FROM devices WHERE id = ? AND host_id = ? AND state = 'active'").bind(dev, host).first();
    if (!live) {
      const code = role === 'host' ? CLOSE.unauthorized : CLOSE.revoked;
      closeWs(server, code, role === 'host' ? 'unlinked' : 'revoked');
      relayLog('refused', { host, dev: dev ?? undefined, code });
      return new Response(null, { status: 101, webSocket: client });
    }
    // A revoke/unlink notice may have closed it while D1 answered: then no replacement, attachment or presence.
    if (server.readyState !== OPEN) return new Response(null, { status: 101, webSocket: client });
    const t0 = Date.now();
    const base = { host, user, until, lastRecheck: 0, tok: FRAME_BURST, tokAt: t0 };
    const a: Att = role === 'host' ? { role, ...base } : { role, dev: dev!, ...base };
    server.serializeAttachment(a);
    // Socket replacement between ticket-authenticated sockets only; the Mac keeps its own Noise session rule.
    for (const ws of old) closeWs(ws, CLOSE.replaced, 'replaced');

    const now = Date.now();
    if (role === 'host') {
      for (const d of this.devices()) sendText(d, { t: 'host', up: true });
      sendText(server, { t: 'ent', ok: until > now, until });
    } else {
      const hostWs = this.open('host')[0];
      if (hostWs) sendText(hostWs, { t: 'peer', dev, up: true });
      sendText(server, { t: 'host', up: !!hostWs });
    }
    await this.armAlarm(now);
    relayLog('open', { host, dev: dev ?? undefined, code: old.length > 0 ? CLOSE.replaced : undefined });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const prev = att(ws);
    if (!prev) return; // still being checked by upgrade, or refused
    const now = Date.now();
    let a = prev;
    // Device sockets only: the host socket is the user's own Mac and carries every device's replies (a big answer
    // is hundreds of 32 KiB chunks), so limiting it would cut all devices at once. MAX_FRAME still applies to it.
    if (prev.role === 'device') {
      const tok = Math.min(FRAME_BURST, prev.tok + ((now - prev.tokAt) * FRAME_RATE) / 1000);
      if (tok < 1) {
        relayLog('flood', { host: prev.host, dev: prev.dev, code: CLOSE.rateLimited });
        closeWs(ws, CLOSE.rateLimited, 'too many frames');
        return;
      }
      a = { ...prev, tok: tok - 1, tokAt: now };
      ws.serializeAttachment(a);
    }
    if (typeof message === 'string') {
      // `ping` is answered by the auto-response; the host's `{"t":"recheck"}` is the only other text that means anything.
      const text = message;
      if (a.role !== 'host' || text.length > 64) return;
      let m: unknown;
      try { m = JSON.parse(text); } catch { return; }
      if ((m as { t?: unknown } | null)?.t !== 'recheck') return;
      if (now - a.lastRecheck < RECHECK_GAP_MS) return;
      ws.serializeAttachment({ ...a, lastRecheck: now } satisfies Att);
      await this.ctx.storage.setAlarm(now);
      return;
    }
    const bytes = message.byteLength;
    if (bytes > MAX_FRAME) {
      relayLog('too_large', { host: a.host, dev: a.dev, bytes, code: CLOSE.tooLarge });
      closeWs(ws, CLOSE.tooLarge, 'frame too large');
      return;
    }
    const e = decodeEnvelope(new Uint8Array(message));
    if (!e) {
      if (a.bad) return; // logged once per socket: a stream of junk does not flood the log
      relayLog('bad_frame', { host: a.host, dev: a.dev, bytes });
      ws.serializeAttachment({ ...a, bad: true } satisfies Att);
      return;
    }
    if (a.role === 'host') {
      const target = this.open(`dev:${e.peer}`)[0];
      if (!target) sendText(ws, { t: 'peer', dev: e.peer, up: false });
      else sendBin(target, encodeEnvelope({ ...e, peer: 'host' }));
    } else {
      const hostWs = this.open('host')[0];
      if (!hostWs) sendText(ws, { t: 'host', up: false });
      else sendBin(hostWs, encodeEnvelope({ ...e, peer: a.dev! })); // never the peer the phone wrote
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = att(ws);
    if (!a) return; // refused in upgrade: it was never announced, so nobody is told it left
    relayLog('close', { host: a.host, dev: a.dev, code });
    // A socket replaced by a newer one with the same tag does not read as "gone".
    if (this.open(a.role === 'host' ? 'host' : `dev:${a.dev}`).length > 0) return;
    if (a.role === 'host') {
      for (const d of this.devices()) sendText(d, { t: 'host', up: false });
    } else {
      const hostWs = this.open('host')[0];
      if (hostWs) sendText(hostWs, { t: 'peer', dev: a.dev, up: false });
    }
  }

  /** Re-reads the entitlement of the room's user; past it, closes device sockets only (the host stays, 2차 필수 1). */
  async alarm(): Promise<void> {
    const all = this.open();
    if (all.length === 0) return;
    const now = Date.now();
    const { untilMs } = await entitledState(this.env.DB, att(all[0]!)!.user, now);
    const ok = untilMs > now;
    for (const ws of all) ws.serializeAttachment({ ...att(ws)!, until: untilMs } satisfies Att);
    const hostWs = this.open('host')[0];
    if (hostWs) sendText(hostWs, { t: 'ent', ok, until: untilMs });
    if (ok) {
      await this.ctx.storage.setAlarm(untilMs);
      return;
    }
    for (const d of this.devices()) {
      relayLog('not_entitled', { host: att(d)!.host, dev: att(d)!.dev, code: CLOSE.notEntitled });
      closeWs(d, CLOSE.notEntitled, 'not entitled');
    }
  }
}

function att(ws: WebSocket): Att | null {
  return (ws.deserializeAttachment() as Att | null) ?? null;
}
