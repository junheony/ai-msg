import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { collectEditPaths, editAutoAllowed } from './grokEditPaths';
import { codexEnv } from '../../shared/accounts';
import { DEFAULT_HERMES_MODEL } from '../../shared/models';
import type { PermMode } from '../../shared/permission';
import { ZERO_USAGE, type PermissionDecision } from '../../shared/turn-types';
import type { Attachment } from '../attachments/AttachmentStore';
import type { EngineEvent, PermissionRequest } from './Engine';
import { AcpConnection } from './acp/AcpConnection';
import { redactSecrets, StreamRedactor } from './redact';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v && typeof v === 'object' ? v as Rec : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
export const HERMES_ARGS = ['acp'] as const;
export const HERMES_PLAN_REFUSED = 'Hermes ACP는 읽기 전용 계획 모드를 지원하지 않습니다. 승인 모드를 선택해 주세요.';

export function resolveHermesBin(env: NodeJS.ProcessEnv, home: string, executable: (p: string) => boolean): string | null {
  if (env.DECK_HERMES_BIN) return executable(env.DECK_HERMES_BIN) ? env.DECK_HERMES_BIN : null;
  return [...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'hermes')), path.join(home, '.local/bin/hermes')].find(executable) ?? null;
}

/** No credentials are read here. Hermes owns its provider login and native policy. */
export function hermesEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = codexEnv(base);
  for (const key of ['HERMES_YOLO_MODE', 'HERMES_ACCEPT_HOOKS', 'HERMES_GATEWAY_SESSION', 'HERMES_CRON_SESSION']) delete env[key];
  return { ...env, HERMES_YOLO_MODE: '0', HERMES_ACCEPT_HOOKS: '0' };
}

export type HermesTurnRequest = {
  cwd: string;
  resumeSessionId: string | null;
  prompt: string;
  attachments?: Attachment[];
  signal: AbortSignal;
  permissionMode: PermMode;
  autoApprove: () => boolean;
  editAuto?: () => boolean;
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
  onAutoApproved?: (req: PermissionRequest) => Promise<void>;
  onSessionId?: (id: string) => Promise<void>;
};

export type HermesDeps = {
  bin: string;
  baseEnv?: NodeJS.ProcessEnv;
  spawnFn?: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'pipe' }) => ChildProcessWithoutNullStreams;
  handshakeMs?: number;
  stopMs?: number;
  /** Tests inject a policy result; production checks booleans in Hermes' own interpreter. */
  checkPolicy?: (bin: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
};

export const HERMES_BOOTSTRAP = fileURLToPath(new URL('./hermesAcpBootstrap.py', import.meta.url));

async function hermesInterpreter(bin: string): Promise<string> {
  const handle = await fs.open(await fs.realpath(bin), 'r');
  try {
    const b = Buffer.alloc(512);
    const { bytesRead } = await handle.read(b, 0, b.length, 0);
    const header = b.subarray(0, bytesRead).toString('utf8').split('\n')[0]!;
    const interpreter = /^#!(\/[^\s]+python[\d.]*)$/.exec(header)?.[1];
    if (!interpreter) throw new Error('Hermes Python 실행 경로를 확인하지 못했습니다');
    return interpreter;
  } finally { await handle.close(); }
}

/** Check the same process-local boundary used by live ACP. No model or session is created. */
export async function checkHermesPolicy(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const interpreter = await hermesInterpreter(bin);
    const { stdout } = await promisify(execFile)(interpreter, ['-I', HERMES_BOOTSTRAP, '--check-policy'], { env, timeout: 15_000, maxBuffer: 64 * 1024 });
    return stdout.trim().split('\n').at(-1) === '{"msgPolicySafe": true}';
  } catch { return false; }
}

function contentText(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v.map((b) => { const r = rec(b); const c = rec(r.content); return str(c.text) || str(r.text); }).filter(Boolean).join('\n');
}

/** One isolated ACP process per turn. session/load preserves Hermes' persisted conversation. */
export class HermesEngine {
  constructor(private readonly deps: HermesDeps) {}

  async *runTurn(req: HermesTurnRequest): AsyncGenerator<EngineEvent> {
    const events: EngineEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (e: EngineEvent) => { events.push(e); wake?.(); };
    const lifetime = new AbortController();
    const signal = AbortSignal.any([req.signal, lifetime.signal]);
    const run = this.execute({ ...req, signal }, push).finally(() => { done = true; wake?.(); });
    try {
      while (!done || events.length) {
        while (events.length) yield events.shift()!;
        if (!done) await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      lifetime.abort();
      await run;
    }
  }

  private async execute(req: HermesTurnRequest, push: (e: EngineEvent) => void): Promise<void> {
    let sessionId: string | null = null;
    let text = '';
    let child: ChildProcessWithoutNullStreams | undefined;
    let conn: AcpConnection | undefined;
    let promptActive = false;
    let cancelSent = Promise.resolve();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const permissions = new AbortController();
    const permissionSignal = AbortSignal.any([req.signal, permissions.signal]);
    const redactor = new StreamRedactor();
    const thinking = new StreamRedactor();
    const called = new Set<string>();
    const resulted = new Set<string>();
    const flush = () => {
      const tail = redactor.flush(); if (tail) { text += tail; push({ kind: 'delta', text: tail }); }
      const thought = thinking.flush(); if (thought) push({ kind: 'thinking', text: thought });
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const stop = () => {
      if (sessionId && conn && !conn.isClosed) cancelSent = conn.notify('session/cancel', { sessionId }).catch(() => {});
      stopTimer ??= setTimeout(() => { kill('SIGTERM'); conn?.close('Hermes cancelled'); }, this.deps.stopMs ?? 1000);
      stopTimer.unref?.();
    };
    try {
      if (req.permissionMode === 'plan') throw new Error(HERMES_PLAN_REFUSED);
      if (req.signal.aborted) throw new Error('중단됨');
      if (!(await (this.deps.checkPolicy ?? checkHermesPolicy)(this.deps.bin, hermesEnv(this.deps.baseEnv ?? process.env)))) throw new Error('Hermes 승인 정책을 안전하게 적용하지 못했습니다. MSG 어댑터는 Hermes 0.18.2의 manual 승인 API를 지원합니다.');
      if (req.signal.aborted) throw new Error('중단됨');
      child = (this.deps.spawnFn ?? spawn)(this.deps.spawnFn ? this.deps.bin : await hermesInterpreter(this.deps.bin), this.deps.spawnFn ? [...HERMES_ARGS] : ['-I', HERMES_BOOTSTRAP], { cwd: req.cwd, env: hermesEnv(this.deps.baseEnv ?? process.env), detached: process.platform !== 'win32', stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
      conn = new AcpConnection(child.stdout, child.stdin);
      // Never relay raw CLI diagnostics: the provider may include credentials in stderr.
      child.stderr.resume();
      child.on('error', () => conn?.close('Hermes CLI를 시작하지 못했습니다'));
      child.on('close', (code) => conn?.close(`Hermes CLI 종료 (${code ?? 'signal'})`));
      req.signal.addEventListener('abort', stop, { once: true });
      if (req.signal.aborted) stop();
      conn.onRequest('session/request_permission', async (value) => {
        const p = rec(value);
        const tool = rec(p.toolCall);
        if (!promptActive || p.sessionId !== sessionId || req.signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const options = Array.isArray(p.options) ? p.options.map(rec) : [];
        const allow = options.find((o) => o.kind === 'allow_once' && typeof o.optionId === 'string');
        const deny = options.find((o) => o.kind === 'reject_once' && typeof o.optionId === 'string');
        const pr: PermissionRequest = { toolName: `hermes:${str(tool.kind) || 'tool'}`, input: rec(tool.rawInput), toolUseId: str(tool.toolCallId) || 'hermes-permission', title: str(tool.title) || 'Hermes 권한 요청', signal: permissionSignal, suppressAlwaysAllowRule: true };
        let allowed = false;
        const paths = tool.kind === 'edit' ? collectEditPaths(tool) : null;
        const safeEdit = req.editAuto?.() && paths && await editAutoAllowed({ cwd: await fs.realpath(req.cwd), home: await fs.realpath(os.homedir()), toolCall: tool });
        if (allow && (req.autoApprove() || (safeEdit && req.editAuto?.()))) { await req.onAutoApproved?.(pr); allowed = true; }
        else {
          let onAbort: (() => void) | undefined;
          const cancelled = new Promise<PermissionDecision>((resolve) => { onAbort = () => resolve('deny'); if (permissionSignal.aborted) onAbort(); else permissionSignal.addEventListener('abort', onAbort, { once: true }); });
          try { allowed = (await Promise.race([req.onPermission(pr), cancelled])) !== 'deny'; }
          finally { if (onAbort) permissionSignal.removeEventListener('abort', onAbort); }
        }
        if (permissionSignal.aborted) return { outcome: { outcome: 'cancelled' } };
        const option = allowed ? allow : deny;
        // Never pick allow_always (Hermes persists it beyond this turn).
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
      });
      conn.onNotification((method, value) => {
        if (method !== 'session/update' || !promptActive) return; // load replays are not fresh output
        const p = rec(value); if (p.sessionId !== sessionId) return;
        const u = rec(p.update);
        const kind = str(u.sessionUpdate);
        if (kind === 'agent_message_chunk') { const part = redactor.push(str(rec(u.content).text)); text += part; if (part) push({ kind: 'delta', text: part }); }
        else if (kind === 'agent_thought_chunk') { const part = thinking.push(str(rec(u.content).text)); if (part) push({ kind: 'thinking', text: part }); }
        else if (kind === 'tool_call' || kind === 'tool_call_update') {
          flush();
          const id = str(u.toolCallId); if (!id) return;
          if (!called.has(id)) { called.add(id); push({ kind: 'tool_call', toolUseId: id, name: str(u.title) || str(u.kind) || 'Hermes tool', input: u.rawInput ?? {} }); }
          if ((u.status === 'completed' || u.status === 'failed') && !resulted.has(id)) {
            resulted.add(id);
            push({ kind: 'tool_result', toolUseId: id, content: redactSecrets(contentText(u.content) || (typeof u.rawOutput === 'string' ? u.rawOutput : '')).slice(0, 32 * 1024), isError: u.status === 'failed' });
          }
        }
      });
      const timeoutMs = this.deps.handshakeMs ?? 30_000;
      const opts = { timeoutMs, signal: req.signal };
      const hello = rec(await conn.request('initialize', { protocolVersion: 1, clientInfo: { name: 'msg', version: '1' }, clientCapabilities: {} }, opts));
      if (req.resumeSessionId && rec(hello.agentCapabilities).loadSession !== true) throw new Error('Hermes ACP가 세션 이어쓰기를 지원하지 않습니다');
      const loaded = await conn.request(req.resumeSessionId ? 'session/load' : 'session/new', { cwd: req.cwd, mcpServers: [], ...(req.resumeSessionId ? { sessionId: req.resumeSessionId } : {}) }, opts);
      if (!loaded || typeof loaded !== 'object') throw new Error('Hermes 세션을 찾을 수 없습니다');
      sessionId = req.resumeSessionId ?? str(rec(loaded).sessionId);
      if (!sessionId) throw new Error('Hermes가 세션 ID를 반환하지 않았습니다');
      await req.onSessionId?.(sessionId);
      await conn.request('session/set_mode', { sessionId, modeId: 'default' }, opts);
      await conn.request('session/set_model', { sessionId, modelId: DEFAULT_HERMES_MODEL }, opts);
      push({ kind: 'init', sessionId, model: DEFAULT_HERMES_MODEL, cwd: req.cwd });
      const prompt: unknown[] = [{ type: 'text', text: req.prompt }];
      const images = req.attachments?.filter((a) => a.isImage) ?? [];
      if (images.length && rec(rec(hello.agentCapabilities).promptCapabilities).image !== true) throw new Error('Hermes ACP가 이미지 입력을 지원하지 않습니다');
      for (const image of images) prompt.push({ type: 'image', mimeType: image.mediaType, data: (await fs.readFile(image.path)).toString('base64') });
      promptActive = true;
      const reply = rec(await conn.request('session/prompt', { sessionId, prompt }, { signal: req.signal, onResponse: () => { promptActive = false; permissions.abort(); } }));
      flush();
      const ok = reply.stopReason === 'end_turn' && !req.signal.aborted;
      const usage = rec(reply.usage);
      const n = (key: string) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0;
      push({ kind: 'result', sessionId, ok, text, usage: { inputTokens: n('inputTokens'), outputTokens: n('outputTokens'), cacheReadTokens: n('cachedReadTokens'), cacheCreationTokens: n('cachedWriteTokens') }, errorText: ok ? null : req.signal.aborted || reply.stopReason === 'cancelled' ? '중단됨' : `Hermes 종료: ${str(reply.stopReason) || '결과 없음'}`, stderr: null, errorKind: null, terminalReason: str(reply.stopReason) || null });
    } catch (err) {
      flush();
      push({ kind: 'result', sessionId, ok: false, text, usage: ZERO_USAGE, errorText: req.signal.aborted ? '중단됨' : redactSecrets(err instanceof Error ? err.message : 'Hermes 실행 실패'), stderr: null, errorKind: null, terminalReason: null });
    } finally {
      promptActive = false;
      permissions.abort();
      req.signal.removeEventListener('abort', stop);
      if (stopTimer) clearTimeout(stopTimer);
      await cancelSent;
      if (req.signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, this.deps.stopMs ?? 100));
      conn?.close('Hermes turn complete');
      child?.stdin.end();
      kill('SIGTERM');
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, this.deps.stopMs ?? 1000);
          child!.once('close', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
  }
}
