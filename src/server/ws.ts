import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessageSchema, type ClientMessage, type RunningTurn, type ServerMessage } from '../shared/protocol';
import type { PermissionDecision } from '../shared/turn-types';
import { checkUpgrade } from './auth';
import { sessionAllowOffered } from './engine/Engine';
import { displayError } from './engine/redact';
import type { SessionIndex } from './sessions/SessionIndex';
import { readTranscript } from './sessions/transcript';
import type { SessionStateStore } from './turn/SessionState';
import type { TurnRunner, TurnSink } from './turn/TurnRunner';
import type { UsageService } from './usage/UsageService';

type PermissionMsg = Extract<ServerMessage, { type: 'permission_request' }>;

export const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/**
 * Holds unanswered permission prompts so a reconnecting browser sees them again (spec §8).
 * Review I5: a prompt also closes — as 'deny', with permission_resolved to every client —
 * when its signal aborts, when its turn ends (cancelTurn), or after a long timeout.
 */
export class PermissionBroker {
  private waiting = new Map<string, { msg: PermissionMsg; resolve: (d: PermissionDecision) => void; cleanup: () => void }>();
  private readonly timeoutMs: number;

  constructor(private readonly broadcast: (m: ServerMessage) => void, opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? PERMISSION_TIMEOUT_MS;
  }

  ask(msg: PermissionMsg, signal?: AbortSignal): Promise<PermissionDecision> {
    if (signal?.aborted) return Promise.resolve('deny');
    return new Promise((resolve) => {
      const onAbort = () => this.resolve(msg.requestId, 'deny');
      const timer = setTimeout(onAbort, this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.waiting.set(msg.requestId, { msg, resolve, cleanup });
      this.broadcast(msg);
    });
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const w = this.waiting.get(requestId);
    if (!w) return false;
    this.waiting.delete(requestId);
    w.cleanup();
    w.resolve(decision);
    this.broadcast({ type: 'permission_resolved', requestId, decision });
    return true;
  }

  /** Deny every prompt still open for this turn (it finished, failed or was interrupted). */
  cancelTurn(turnId: string): void {
    for (const [id, w] of [...this.waiting]) if (w.msg.turnId === turnId) this.resolve(id, 'deny');
  }

  pending(): ServerMessage[] {
    return [...this.waiting.values()].map((w) => w.msg);
  }
}

/** Deviation (added per review I5): extraHosts feeds the Host allowlist in checkUpgrade. */
export type WsDeps = { token: string; devOrigins: string[]; runner: TurnRunner; index: SessionIndex; usage: UsageService; store: SessionStateStore; extraHosts?: string[] };

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function isDirectory(p: string): Promise<boolean> {
  return fs.stat(p).then((st) => st.isDirectory(), () => false);
}

type Turn = RunningTurn & { origin: WebSocket; ac: AbortController };

export function attachWebSocket(servers: http.Server[], deps: WsDeps): { broadcast(msg: ServerMessage): void; close(): void } {
  // maxPayload: a text frame over 1 MiB is refused (ws emits 'error' on the socket, handled below).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  wss.on('error', (err) => console.error('deck ws: server error', err));
  const clients = new Set<WebSocket>();
  const turns = new Map<string, Turn>();
  /**
   * Review I2: one turn per session. Keyed by sessionId; a new session is keyed by
   * `new:<turnId>` until the CLI reports its id, then by that id as well.
   */
  const busy = new Map<string, string>();
  /** Review I3: the session each socket has open (open_session / send), for routing turn events. */
  const viewing = new Map<WebSocket, string>();

  const send = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg: ServerMessage) => { for (const c of clients) send(c, msg); };
  const broker = new PermissionBroker(broadcast);
  const unsubscribeUsage = deps.usage.onChange((usage) => broadcast({ type: 'usage', usage }));
  const running = (): RunningTurn[] => [...turns.values()].map(({ turnId, sessionId, cwd }) => ({ turnId, sessionId, cwd }));

  /** Turn events reach the socket that started the turn and sockets viewing its session — nobody else. */
  const emitTurn = (turn: Turn, msg: ServerMessage) => {
    const sid = 'sessionId' in msg ? msg.sessionId : null;
    if (sid && turn.sessionId !== sid) {
      turn.sessionId = sid;
      if (!busy.has(sid)) busy.set(sid, turn.turnId);
    }
    const to = new Set<WebSocket>([turn.origin]);
    if (turn.sessionId) for (const [c, v] of viewing) if (v === turn.sessionId) to.add(c);
    for (const c of to) send(c, msg);
  };

  for (const server of servers) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      const chk = checkUpgrade({ headers: { cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host } }, deps.token, deps.devOrigins, deps.extraHosts ?? []);
      if (!chk.ok) {
        const status = chk.reason === 'unauthenticated' ? '401 Unauthorized' : chk.reason.startsWith('host ') ? '421 Misdirected Request' : '403 Forbidden';
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  const startTurn = (ws: WebSocket, msg: Extract<ClientMessage, { type: 'send' }>) => {
    if (msg.sessionId) viewing.set(ws, msg.sessionId);
    else viewing.delete(ws);
    if (msg.sessionId && busy.has(msg.sessionId)) { send(ws, { type: 'error', turnId: null, message: '이 세션은 이미 실행 중입니다' }); return; }
    const turnId = randomUUID();
    const ac = new AbortController();
    const turn: Turn = { turnId, sessionId: msg.sessionId, cwd: msg.cwd, origin: ws, ac };
    // Taken synchronously, before any await, so two sends in one tick cannot both pass.
    busy.set(msg.sessionId ?? `new:${turnId}`, turnId);
    turns.set(turnId, turn);
    const release = () => {
      turns.delete(turnId);
      for (const [k, v] of [...busy]) if (v === turnId) busy.delete(k);
      broker.cancelTurn(turnId);
    };
    const sink: TurnSink = {
      emit: (m) => emitTurn(turn, m),
      askPermission: (req) => broker.ask(
        {
          type: 'permission_request', turnId, sessionId: req.sessionId, cwd: req.cwd, requestId: randomUUID(), toolName: req.toolName, input: req.input,
          title: req.title ?? null, decisionReason: req.decisionReason ?? null, blockedPath: req.blockedPath ?? null,
          defaultToNo: req.defaultToNo === true, allowSession: sessionAllowOffered(req),
        },
        req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal,
      ),
      signal: ac.signal,
    };
    void (async () => {
      try {
        // Review M8: the working directory must exist before a CLI is started in it.
        if (!(await isDirectory(msg.cwd))) { send(ws, { type: 'error', turnId: null, message: `작업 폴더가 없습니다: ${msg.cwd}` }); return; }
        await deps.runner.run({ turnId, cwd: msg.cwd, sessionId: msg.sessionId, text: msg.text, ...(msg.model ? { model: msg.model } : {}) }, sink);
      } catch (err) {
        // Review I6: a rejected run still ends the turn for the UI.
        console.error('deck: turn failed', err);
        emitTurn(turn, { type: 'turn_result', turnId, sessionId: turn.sessionId, cwd: turn.cwd, ok: false, text: '', badge: null, errorText: displayError(errMsg(err), null) });
      } finally {
        release();
      }
      if (msg.sessionId === null) {
        await deps.index.refresh();
        broadcast({ type: 'index', projects: deps.index.projects() });
      }
    })().catch((err: unknown) => console.error('deck: post-turn index refresh failed', errMsg(err)));
  };

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    // Without this listener a bad frame (invalid UTF-8, oversized) is an uncaught 'error' that kills the process.
    ws.on('error', (err) => { console.error('deck ws: client error', (err as Error & { code?: string }).code ?? err.message); ws.terminate(); });
    send(ws, { type: 'hello', usage: deps.usage.snapshot(), projects: deps.index.projects(), running: running() });
    for (const m of broker.pending()) send(ws, m);

    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { send(ws, { type: 'error', turnId: null, message: '메시지를 해석할 수 없습니다(JSON 아님)' }); return; }
      const r = ClientMessageSchema.safeParse(parsed);
      if (!r.success) { send(ws, { type: 'error', turnId: null, message: `메시지 형식 오류: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` }); return; }
      const msg = r.data;
      switch (msg.type) {
        case 'send':
          startTurn(ws, msg);
          break;
        case 'permission_response':
          if (!broker.resolve(msg.requestId, msg.decision)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다' });
          break;
        case 'interrupt':
          turns.get(msg.turnId)?.ac.abort();
          broker.cancelTurn(msg.turnId);
          break;
        case 'open_session': {
          const entry = deps.index.lookup(msg.sessionId);
          if (!entry) { send(ws, { type: 'error', turnId: null, message: `세션을 찾을 수 없습니다: ${msg.sessionId}` }); break; }
          viewing.set(ws, msg.sessionId);
          const state = deps.store.get(msg.sessionId);
          void readTranscript(state ? `${state.projectDir}/${msg.sessionId}.jsonl` : entry.file)
            .catch(() => readTranscript(entry.file))
            .then((messages) => send(ws, { type: 'history', sessionId: msg.sessionId, cwd: entry.cwd, account: state?.account ?? entry.account, messages, runningTurnId: busy.get(msg.sessionId) ?? null }))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `기록을 읽지 못했습니다: ${errMsg(err)}` }));
          break;
        }
        case 'refresh_index':
          void deps.index.refresh()
            .then(() => broadcast({ type: 'index', projects: deps.index.projects() }))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `세션 목록을 읽지 못했습니다: ${errMsg(err)}` }));
          break;
      }
    });

    ws.on('close', () => { clients.delete(ws); viewing.delete(ws); });
  });

  return {
    broadcast,
    close() {
      unsubscribeUsage();
      for (const c of clients) c.close();
      wss.close();
    },
  };
}
