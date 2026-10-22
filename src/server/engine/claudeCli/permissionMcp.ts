// src/server/engine/claudeCli/permissionMcp.ts
// Child entry: deck's permission-prompt MCP server, started by claude via --mcp-config.
// Runs as `node --disable-warning=ExperimentalWarning permissionMcp.ts` (native type stripping):
// node: built-ins only, erasable TypeScript only (no enums, namespaces or parameter properties).
import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const TOOL_NAME = 'permission';
export const RELAY_FAILED_MESSAGE = '권한 요청을 AI-MSG 에 전달하지 못해 거부했습니다';

export function postBridge(sock: string, token: string, urlPath: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath: sock, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-deck-token': token }, signal }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

type Json = Record<string, unknown>;
export type RpcDeps = { post(urlPath: string, body: unknown, signal: AbortSignal): Promise<{ status: number; body: string }>; inflight: Map<string | number, AbortController> };

const TOOL = {
  name: TOOL_NAME,
  description: 'deck internal: relays Claude Code permission prompts to the deck UI. Never call this tool yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
};

const reply = (id: unknown, result: unknown): Json => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });
const denyText = (message: string) => JSON.stringify({ behavior: 'deny', message });

export async function handleRpc(msg: Json, deps: RpcDeps): Promise<Json | null> {
  const id = msg.id;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Json;
  switch (msg.method) {
    case 'initialize':
      return reply(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deck_bridge', version: '1' } });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [TOOL] });
    case 'notifications/cancelled': {
      const target = params.requestId as string | number | undefined;
      if (target !== undefined) deps.inflight.get(target)?.abort();
      return null;
    }
    case 'tools/call': {
      if (params.name !== TOOL_NAME) return fail(id, -32602, `unknown tool ${String(params.name)}`);
      const ac = new AbortController();
      const key = id as string | number;
      deps.inflight.set(key, ac);
      let text: string;
      try {
        const r = await deps.post('/v1/permission', params.arguments ?? {}, ac.signal);
        text = r.status === 200 && r.body ? r.body : denyText(RELAY_FAILED_MESSAGE);
      } catch {
        text = denyText(RELAY_FAILED_MESSAGE);
      } finally {
        deps.inflight.delete(key);
      }
      return reply(id, { content: [{ type: 'text', text }] });
    }
    default:
      return id === undefined ? null : fail(id, -32601, `method not found: ${String(msg.method)}`);
  }
}

function main(): void {
  const sock = process.env.DECK_BRIDGE_SOCK ?? '';
  const token = process.env.DECK_BRIDGE_TOKEN ?? '';
  const deps: RpcDeps = { post: (p, b, s) => postBridge(sock, token, p, b, s), inflight: new Map() };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { return; }
    void handleRpc(msg, deps).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
  });
  rl.on('close', () => { for (const ac of deps.inflight.values()) ac.abort(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
