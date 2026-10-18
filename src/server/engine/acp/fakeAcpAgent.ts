import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnFn } from '../CodexEngine';

/**
 * Test fixture: a fake ACP agent shaped after the grok 1.0.62 recordings in `fixtures/grok-1.0.62/` (docs/grok-spike.md):
 * no `modes` in the session response, config options `model` / `reasoning_effort`, agent request ids from 0, Grok's
 * permission option ids, a first `tool_call` with `_meta["x.ai/tool"]` and no ACP kind, and the end-of-turn trio
 * `turn_completed` → `_x.ai/session/prompt_complete` → PromptResponse (`_meta.usage`, `cancellationCategory`).
 *
 * The prelude is a CommonJS script; a test appends its own body (handlers via `on(method, fn)`). argv[2] is a log file
 * that receives every message the agent reads, one JSON per line.
 */
export const FAKE_AGENT_PRELUDE = String.raw`'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const LOG = process.argv[2];
let nextId = 0;
const waiters = new Map();
const handlers = {};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const respond = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, data } });
const notify = (method, params) => send({ method, params });
const update = (sessionId, u, meta) => notify('session/update', { sessionId, update: u, ...(meta ? { _meta: meta } : {}) });
const ask = (method, params) => { const id = nextId++; send({ id, method, params }); return new Promise((r) => waiters.set(id, r)); };
const on = (m, fn) => { handlers[m] = fn; };
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log(m);
    if (m.method === undefined) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } continue; }
    const h = handlers[m.method];
    if (h) Promise.resolve().then(() => h(m.params, m.id)).catch((e) => log({ agentError: String(e) }));
    else if (m.id !== undefined) fail(m.id, -32601, 'Method not found');
  }
});
let onEnd = () => process.exit(0);
process.stdin.on('end', () => onEnd());

const SID = '01a14e16-8100-7cb3-b038-2b02138059a5';
const CHILD = '01a14e16-aaaa-7cb3-b038-2b02138059a5';
const PROMPT_ID = 'dff7f9b2-9d1e-46b2-aab7-be613b2eb38a';
let model = 'grok-4.7';
let effort = 'high';
const MODELS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'];
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODELS.map((v) => ({ value: v, name: v })) },
  { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: effort, options: ['xhigh', 'high', 'medium', 'low'].map((v) => ({ value: v, name: v })) },
];
const models = () => ({ currentModelId: model, availableModels: MODELS.map((m) => ({ modelId: m, name: m })) });
const EDIT_OPTS = [
  { optionId: 'allow-edits-session', name: 'Yes, for this session', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
];
const BASH_OPTS = [
  { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Never', kind: 'reject_always' },
];
const USAGE = { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cachedReadTokens: 600, cacheCreationTokens: 0, reasoningTokens: 10 };
const xai = (name, kind) => ({ 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build', read_only: kind === 'read' } });
/** The first tool_call: title = tool name, rawInput, x.ai/tool; no ACP kind, no status. */
const toolCall = (sid, id, name, xkind, rawInput) => update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: name, rawInput, _meta: xai(name, xkind) }, { promptId: PROMPT_ID });
const toolUpdate = (sid, id, fields) => update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, ...fields });
/** The permission request as grok sends it: parent sessionId, the requester in toolCall._meta. */
const askPermission = (toolCallFields, options = EDIT_OPTS, requester = SID) =>
  ask('session/request_permission', { sessionId: SID, toolCall: { ...toolCallFields, _meta: { ...(toolCallFields._meta || {}), 'x.ai/requestingSessionId': requester } }, options });
const text = (t) => [{ type: 'content', content: { type: 'text', text: t } }];
/** End of a prompt: turn_completed, prompt_complete, then the PromptResponse (cancelled ones carry the category). */
const complete = (id, stopReason = 'end_turn', category) => {
  const cat = category ? { cancellationCategory: category } : {};
  notify('_x.ai/session_notification', { sessionId: SID, update: { sessionUpdate: 'turn_completed', prompt_id: PROMPT_ID, stop_reason: stopReason, usage: USAGE }, _meta: cat });
  notify('_x.ai/session/prompt_complete', { sessionId: SID, promptId: PROMPT_ID, stopReason, ...cat });
  respond(id, { stopReason, _meta: { promptId: PROMPT_ID, usage: USAGE, ...cat } });
};
const interjects = [];
on('_x.ai/interject', (p, id) => {
  interjects.push(p.interjectionId);
  notify('_x.ai/session/interjection', { sessionId: p.sessionId, text: p.text, interjectionId: p.interjectionId });
  respond(id, { result: { status: 'queued' } });
});

on('initialize', (p, id) => respond(id, {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
  authMethods: [],
}));
on('session/new', (p, id) => {
  notify('_x.ai/session/setup', { method: 'session/new', phase: 'auth', sessionId: null });
  respond(id, { sessionId: SID, models: models(), configOptions: configOptions(), _meta: {} });
});
on('session/load', (p, id) => respond(id, { models: models(), configOptions: configOptions() }));
on('session/set_config_option', (p, id) => {
  if (p.configId === 'model') model = p.value;
  if (p.configId === 'reasoning_effort') effort = p.value;
  respond(id, { configOptions: configOptions() });
});
on('session/prompt', (p, id) => complete(id));
`;

/** Writes prelude + `body` as an agent script in `dir`; returns a SpawnFn running it (detached, like the real one) and its log path. */
export function fakeAgent(dir: string, body: string, name = 'agent'): { spawnFn: SpawnFn; logFile: string; script: string } {
  const script = path.join(dir, `${name}.cjs`);
  const logFile = path.join(dir, `${name}.log.jsonl`);
  fs.writeFileSync(script, `${FAKE_AGENT_PRELUDE}\n${body}\n`);
  fs.writeFileSync(logFile, '');
  const spawnFn: SpawnFn = (_bin, args, o) =>
    nodeSpawn(process.execPath, [script, logFile, ...args], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  return { spawnFn, logFile, script };
}

/** Messages the fake agent received (and agent-side log entries), in order. */
export function agentLog(logFile: string): Array<Record<string, unknown>> {
  let text: string;
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
