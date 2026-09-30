import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessageSchema, type ServerMessage } from '../shared/protocol';
import type { PermissionDecision } from '../shared/turn-types';
import { checkUpgrade } from './auth';
import type { SessionIndex } from './sessions/SessionIndex';
import { readTranscript } from './sessions/transcript';
import type { SessionStateStore } from './turn/SessionState';
import type { TurnRunner, TurnSink } from './turn/TurnRunner';
import type { UsageService } from './usage/UsageService';

type PermissionMsg = Extract<ServerMessage, { type: 'permission_request' }>;

/** Holds unanswered permission prompts so a reconnecting browser sees them again (spec §8). */
export class PermissionBroker {
  private waiting = new Map<string, { msg: PermissionMsg; resolve: (d: PermissionDecision) => void }>();

  constructor(private readonly broadcast: (m: ServerMessage) => void) {}

  ask(msg: PermissionMsg): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.waiting.set(msg.requestId, { msg, resolve });
      this.broadcast(msg);
    });
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const w = this.waiting.get(requestId);
    if (!w) return false;
    this.waiting.delete(requestId);
    w.resolve(decision);
    this.broadcast({ type: 'permission_resolved', requestId, decision });
    return true;
  }

  pending(): ServerMessage[] {
    return [...this.waiting.values()].map((w) => w.msg);
  }
}

/** Deviation (added per review I5): extraHosts feeds the Host allowlist in checkUpgrade. */
export type WsDeps = { token: string; devOrigins: string[]; runner: TurnRunner; index: SessionIndex; usage: UsageService; store: SessionStateStore; extraHosts?: string[] };

export function attachWebSocket(servers: http.Server[], deps: WsDeps): { broadcast(msg: ServerMessage): void; close(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const activeTurns = new Map<string, AbortController>();

  const send = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg: ServerMessage) => { for (const c of clients) send(c, msg); };
  const broker = new PermissionBroker(broadcast);
  const unsubscribeUsage = deps.usage.onChange((usage) => broadcast({ type: 'usage', usage }));

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

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: 'hello', usage: deps.usage.snapshot(), projects: deps.index.projects() });
    for (const m of broker.pending()) send(ws, m);

    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { send(ws, { type: 'error', turnId: null, message: '메시지를 해석할 수 없습니다(JSON 아님)' }); return; }
      const r = ClientMessageSchema.safeParse(parsed);
      if (!r.success) { send(ws, { type: 'error', turnId: null, message: `메시지 형식 오류: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` }); return; }
      const msg = r.data;
      switch (msg.type) {
        case 'send': {
          const turnId = randomUUID();
          const ac = new AbortController();
          activeTurns.set(turnId, ac);
          const sink: TurnSink = {
            emit: broadcast,
            askPermission: (req) => broker.ask({ type: 'permission_request', turnId: req.turnId, requestId: randomUUID(), toolName: req.toolName, input: req.input }),
            signal: ac.signal,
          };
          void deps.runner
            .run({ turnId, cwd: msg.cwd, sessionId: msg.sessionId, text: msg.text, ...(msg.model ? { model: msg.model } : {}) }, sink)
            .catch((err: unknown) => broadcast({ type: 'error', turnId, message: err instanceof Error ? err.message : String(err) }))
            .then(async () => {
              activeTurns.delete(turnId);
              if (msg.sessionId === null) { await deps.index.refresh(); broadcast({ type: 'index', projects: deps.index.projects() }); }
            });
          break;
        }
        case 'permission_response':
          if (!broker.resolve(msg.requestId, msg.decision)) send(ws, { type: 'error', turnId: null, message: '이미 처리된 권한 요청입니다' });
          break;
        case 'interrupt':
          activeTurns.get(msg.turnId)?.abort();
          break;
        case 'open_session': {
          const entry = deps.index.lookup(msg.sessionId);
          if (!entry) { send(ws, { type: 'error', turnId: null, message: `세션을 찾을 수 없습니다: ${msg.sessionId}` }); break; }
          const state = deps.store.get(msg.sessionId);
          void readTranscript(state ? `${state.projectDir}/${msg.sessionId}.jsonl` : entry.file)
            .catch(() => readTranscript(entry.file))
            .then((messages) => send(ws, { type: 'history', sessionId: msg.sessionId, cwd: entry.cwd, account: state?.account ?? entry.account, messages }))
            .catch((err: unknown) => send(ws, { type: 'error', turnId: null, message: `기록을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` }));
          break;
        }
        case 'refresh_index':
          void deps.index.refresh().then(() => broadcast({ type: 'index', projects: deps.index.projects() }));
          break;
      }
    });

    ws.on('close', () => clients.delete(ws));
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
