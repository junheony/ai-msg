#!/usr/bin/env node
// pack-smoke stand-in for the `claude` CLI (node: built-ins only).
//   --version            → 2.1.283 (Claude Code)
//   auth status --json   → {"loggedIn":false}, exit 1
//   turn mode (-p … --settings=<f> --mcp-config=<f>): reads the files deck wrote and drives deck's own children the way
//   the real CLI does — ① runs the PreToolUse hook `command` with `sh -c` (hook JSON on stdin → hookRelay round trip),
//   ② spawns the permission MCP server from mcp-config (`initialize` → `tools/call` round trip). The prompt picks the
//   case: a prompt containing "timeout" ① runs the hook in deck's fail-closed form (`--fail closed`, `( … ) || exit 2`, as
//   a 총사령탑 turn would get it) and requires deck's own relay to deny with exit 2 — pack-smoke starts the server with
//   DECK_HOOK_RELAY_DEADLINE_MS=1, so the relay's deadline fires before the bridge can answer; ② gives up on the
//   permission call after FAKE_PERMISSION_WAIT_MS (default 3 s) and cancels it. The answer goes out as a stream-json `result`:
//   `allow|deny|timeout hook=<hook script> mcp=<mcp script>`. Any failure: reason on stderr, exit 2.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const die = (why) => { process.stderr.write(`fake-claude: ${why}\n`); process.exit(2); };
const argValue = (flag) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
  }
  return undefined;
};

if (argv[0] === '--version') { process.stdout.write('2.1.283 (Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') { process.stdout.write('{"loggedIn":false}\n'); process.exit(1); }
if (!argv.includes('-p')) die(`모르는 호출: ${argv.join(' ')}`);

const settingsPath = argValue('--settings');
const mcpPath = argValue('--mcp-config');
if (!settingsPath || !mcpPath) die('--settings / --mcp-config 가 없음');
let settings, mcp;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
} catch (e) { die(`설정 파일을 읽지 못함: ${e.message}`); }
const sid = argValue('--resume') ?? argValue('--session-id') ?? randomUUID();
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function runHook(cwd, closed) {
  let command = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string') die('PreToolUse 훅 command 가 없음');
  if (closed) {
    const swapped = command.replace(/(--fail'?\s+'?)(?:open|deny)\b/, '$1closed');
    if (swapped === command) die(`훅 command 에 --fail 이 없음: ${command}`);
    command = `( ${swapped} ) || exit 2`;
  }
  const script = (command.match(/'([^']*hookRelay\.[jt]s)'/) ?? [])[1] ?? '?';
  return new Promise((resolve) => {
    const c = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      if (closed) {
        let decision;
        try { decision = JSON.parse(out).hookSpecificOutput?.permissionDecision; } catch { /* checked below */ }
        if (code !== 2 || decision !== 'deny') die(`닫힘 실패가 동작하지 않음: 종료 ${code}, 출력 ${out.trim()}`);
        resolve(script);
        return;
      }
      if (code !== 0) die(`훅 종료 ${code}: ${err.trim()}`);
      try { JSON.parse(out || '{}'); } catch { die(`훅 출력이 JSON 아님: ${out}`); }
      resolve(script);
    });
    c.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: `${cwd}/smoke.txt`, content: 'x' }, tool_use_id: 'toolu_hook' }));
  });
}

function askPermission(timeoutCase) {
  const server = Object.values(mcp?.mcpServers ?? {})[0];
  if (!server?.command) die('mcp-config 에 서버가 없음');
  const script = (server.args ?? []).find((a) => /permissionMcp\.[jt]s$/.test(a)) ?? '?';
  const c = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: c.stdout }).on('line', (l) => {
    let m;
    try { m = JSON.parse(l); } catch { return; }
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const rpc = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return (async () => {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
    if (!init.result) die(`initialize 실패: ${JSON.stringify(init)}`);
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const call = rpc(2, 'tools/call', { name: 'permission', arguments: { tool_name: 'Bash', input: { command: 'echo smoke' }, tool_use_id: 'toolu_smoke' } });
    let answer;
    if (timeoutCase) {
      const wait = Number(process.env.FAKE_PERMISSION_WAIT_MS) || 3000;
      answer = await Promise.race([call, new Promise((r) => setTimeout(() => r(null), wait))]);
      if (answer === null) {
        c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'timeout' } }) + '\n');
        c.stdin.end();
        return { decision: 'timeout', script };
      }
    } else {
      answer = await call;
    }
    c.stdin.end();
    const text = answer?.result?.content?.[0]?.text;
    let decision;
    try { decision = JSON.parse(text).behavior; } catch { die(`권한 응답이 JSON 아님: ${JSON.stringify(answer)}`); }
    if (decision !== 'allow' && decision !== 'deny') die(`모르는 권한 응답: ${text}`);
    return { decision, script };
  })();
}

const input = readline.createInterface({ input: process.stdin });
let busy = false;
input.on('line', (line) => {
  if (!line.trim() || busy) return;
  let msg;
  try { msg = JSON.parse(line); } catch { die(`입력이 JSON 아님: ${line}`); }
  if (msg.type !== 'user') return;
  busy = true;
  const content = msg.message?.content;
  const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b.text ?? '').join('') : '';
  (async () => {
    emit({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5', cwd: process.cwd(), tools: ['Bash', 'Write'] });
    const timeoutCase = /timeout/.test(prompt);
    const hookScript = await runHook(process.cwd(), timeoutCase);
    const { decision, script } = await askPermission(timeoutCase);
    const text = `${decision} hook=${hookScript} mcp=${script}`;
    emit({ type: 'stream_event', parent_tool_use_id: null, session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
    busy = false;
  })().catch((e) => die(e?.stack ?? String(e)));
});
input.on('close', () => { if (!busy) process.exit(0); else setInterval(() => { if (!busy) process.exit(0); }, 50); });
