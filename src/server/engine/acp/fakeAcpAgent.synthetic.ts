import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnFn } from '../CodexEngine';

/**
 * SYNTHETIC test fixture: a fake ACP agent hand-built from the ACP v1 spec shapes (agentclientprotocol.com/protocol/v1)
 * plus the few grok 1.0.62 observations made while logged out (initialize `_meta.modelState`, `-32000 Authentication
 * required`, `_x.ai/session/setup` notifications). To be replaced by recorded fixtures after spike S1.
 *
 * The prelude is a CommonJS script; a test appends its own body (handlers via `on(method, fn)`). argv[2] is a log file
 * that receives every message the agent reads, one JSON per line.
 */
export const FAKE_AGENT_PRELUDE = String.raw`'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const LOG = process.argv[2];
let nextId = 9000;
const waiters = new Map();
const handlers = {};
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const respond = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, data } });
const notify = (method, params) => send({ method, params });
const update = (sessionId, u) => notify('session/update', { sessionId, update: u });
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

const SID = 'sess-synthetic-1';
let mode = 'default';
let model = 'grok-4.6';
let effort = 'high';
const MODE_IDS = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const modesState = () => ({ currentModeId: mode, availableModes: MODE_IDS.map((id) => ({ id, name: id })) });
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'grok-4.6', name: 'Grok 4.6' }, { value: 'grok-4.5', name: 'Grok 4.5' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: ['low', 'medium', 'high', 'xhigh'].map((v) => ({ value: v, name: v })) },
];
const modelState = () => ({ modelState: { currentModelId: model, availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }, { modelId: 'grok-4.5', name: 'Grok 4.5' }] } });

on('initialize', (p, id) => respond(id, {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
  authMethods: [],
  _meta: modelState(),
}));
on('session/new', (p, id) => {
  notify('_x.ai/session/setup', { method: 'session/new', phase: 'auth', sessionId: SID });
  respond(id, { sessionId: SID, modes: modesState(), configOptions: configOptions(), _meta: modelState() });
});
on('session/load', (p, id) => respond(id, { modes: modesState(), configOptions: configOptions(), _meta: modelState() }));
on('session/set_mode', (p, id) => {
  mode = p.modeId;
  update(p.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode });
  respond(id, {});
});
on('session/set_config_option', (p, id) => {
  if (p.configId === 'model') model = p.value;
  if (p.configId === 'effort') effort = p.value;
  respond(id, { configOptions: configOptions() });
});
on('session/prompt', (p, id) => respond(id, { stopReason: 'end_turn' }));
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
