// src/server/engine/claudeCli/bridge.ts
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { asPermissionUpdates, type PermissionUpdate } from './permissionTypes';
import { COMMANDER_GATE_FAILED_MESSAGE, PERMISSION_ERROR_MESSAGE, PERMISSION_TIMEOUT_MESSAGE } from './texts';

export type PermissionCall = { tool_name: string; input: Record<string, unknown>; tool_use_id: string; permission_suggestions?: PermissionUpdate[] };
export type PermissionReply =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string };
export type BridgeHandlers = {
  permission(call: PermissionCall, signal: AbortSignal): Promise<PermissionReply>;
  hook(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
};
export type BridgeRegistration = { token: string; socketPath: string; abortAll(): void; dispose(): void };

/** Passed to the claude child as `MCP_TOOL_TIMEOUT` (the CLI's limit for one MCP tool call, the prompt tool included — spike `permission-slow`). */
export const MCP_TOOL_TIMEOUT_MS = 12 * 60 * 60_000;
/**
 * A permission card may wait for the user this long. Kept 2 minutes below MCP_TOOL_TIMEOUT_MS so
 * deck's own Korean deny always reaches the CLI before the CLI gives up on the tool call itself
 * (a CLI-side timeout would surface as an MCP error, not as deck's message). If spike
 * `permission-slow` shows the CLI ignores MCP_TOOL_TIMEOUT for the prompt tool, set this to the
 * CLI's internal limit minus 2 minutes (see "Lost or changed features").
 */
export const PERMISSION_WAIT_MS = MCP_TOOL_TIMEOUT_MS - 2 * 60_000;
/** Below the 30 s command-hook timeout written into the settings file. */
export const HOOK_WAIT_MS = 25_000;
/**
 * A fail-closed registration (총사령탑 자동 턴): its hook answers a deny after this long. Order (each layer answers before
 * the one outside it gives up): relay deadline 20 s (hookRelay CLOSED_RELAY_DEADLINE_MS) < this < CLI hook timeout 30 s
 * (args HOOK_TIMEOUT_S) — a hook the CLI times out on would let the tool run.
 */
export const CLOSED_HOOK_WAIT_MS = 22_000;
/** What a fail-closed registration's hook answers when the handler timed out or threw. */
const CLOSED_HOOK_DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: COMMANDER_GATE_FAILED_MESSAGE } };
const MAX_BODY = 1024 * 1024;

/** `failClosed`: a hook that times out or throws answers a deny instead of `{}` (no opinion). */
export type RegisterOptions = { failClosed?: boolean };
type Reg = { handlers: BridgeHandlers; inflight: Set<AbortController>; failClosed: boolean };

function parseCall(v: unknown): PermissionCall | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tool_name !== 'string' || !r.input || typeof r.input !== 'object' || Array.isArray(r.input)) return null;
  const suggestions = asPermissionUpdates(r.permission_suggestions);
  return { tool_name: r.tool_name, input: r.input as Record<string, unknown>, tool_use_id: typeof r.tool_use_id === 'string' ? r.tool_use_id : '', ...(suggestions ? { permission_suggestions: suggestions } : {}) };
}

/**
 * One per deck server: an HTTP server on a unix socket inside a private temp dir (0700). Each
 * claude process gets its own registration token, handed only to its MCP prompt server and hook
 * relay through 0600 config files, always as the env variable `DECK_BRIDGE_TOKEN` (the MCP server's
 * `env` entry; a `DECK_BRIDGE_TOKEN=` prefix in the hook command) — never in the claude process env
 * and never as an argv flag of node or claude.
 */
export class PermissionBridge {
  private readonly regs = new Map<string, Reg>();
  /** Disposed registrations answer 410 (a process outliving its turn), unknown tokens 401. */
  private readonly disposedTokens = new Set<string>();
  private constructor(private readonly server: http.Server, readonly socketPath: string, private readonly dir: string, private readonly waitMs: number, private readonly hookWaitMs: number, private readonly closedHookWaitMs: number) {}

  static async open(opts: { waitMs?: number; hookWaitMs?: number; closedHookWaitMs?: number } = {}): Promise<PermissionBridge> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-'));
    await fs.chmod(dir, 0o700);
    const socketPath = path.join(dir, 'b.sock');
    let self: PermissionBridge | null = null;
    const server = http.createServer((req, res) => { void self!.handle(req, res); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
    await fs.chmod(socketPath, 0o600);
    server.unref();
    self = new PermissionBridge(server, socketPath, dir, opts.waitMs ?? PERMISSION_WAIT_MS, opts.hookWaitMs ?? HOOK_WAIT_MS, opts.closedHookWaitMs ?? CLOSED_HOOK_WAIT_MS);
    return self;
  }

  get registrations(): number { return this.regs.size; }

  register(handlers: BridgeHandlers, opts: RegisterOptions = {}): BridgeRegistration {
    const token = randomBytes(24).toString('hex');
    const reg: Reg = { handlers, inflight: new Set(), failClosed: !!opts.failClosed };
    this.regs.set(token, reg);
    const abortAll = () => { for (const ac of reg.inflight) ac.abort(); };
    const dispose = () => {
      abortAll();
      if (!this.regs.delete(token)) return;
      this.disposedTokens.add(token);
      if (this.disposedTokens.size > 1000) this.disposedTokens.delete(this.disposedTokens.values().next().value!);
    };
    return { token, socketPath: this.socketPath, abortAll, dispose };
  }

  async close(): Promise<void> {
    for (const reg of this.regs.values()) for (const ac of reg.inflight) ac.abort();
    this.regs.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const kind = req.method === 'POST' && req.url === '/v1/permission' ? 'permission' : req.method === 'POST' && req.url === '/v1/hook' ? 'hook' : null;
    if (!kind) return send(404, { error: 'not found' });
    const token = req.headers['x-deck-token'];
    if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return send(401, { error: 'unauthorized' });
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) return send(413, { error: 'too large' }); }
    } catch { return; }
    const reg = this.regs.get(token);
    if (!reg) return send(this.disposedTokens.has(token) ? 410 : 401, { error: 'gone' });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
    const ac = new AbortController();
    reg.inflight.add(ac);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const hookFailed = reg.failClosed ? CLOSED_HOOK_DENY : {};
    const cap = setTimeout(() => {
      ac.abort();
      send(200, kind === 'permission' ? { behavior: 'deny', message: PERMISSION_TIMEOUT_MESSAGE } : hookFailed);
    }, kind === 'permission' ? this.waitMs : reg.failClosed ? this.closedHookWaitMs : this.hookWaitMs);
    cap.unref();
    try {
      if (kind === 'permission') {
        const call = parseCall(body);
        if (!call) return send(400, { error: 'bad call' });
        send(200, await reg.handlers.permission(call, ac.signal));
      } else {
        if (!body || typeof body !== 'object') return send(400, { error: 'bad hook input' });
        send(200, await reg.handlers.hook(body as Record<string, unknown>, ac.signal));
      }
    } catch {
      send(200, kind === 'permission' ? { behavior: 'deny', message: PERMISSION_ERROR_MESSAGE } : hookFailed);
    } finally {
      clearTimeout(cap);
      reg.inflight.delete(ac);
    }
  }
}
