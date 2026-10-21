#!/usr/bin/env node
// pack-smoke: three Claude turns against an installed server, each ending in one permission card.
//   node turn.mjs <installed package dir> <port> <token file> <work dir>
// The `ws` client is the installed package's own dependency. Expected (fake-claude.mjs answers):
//   approve → "allow …", deny → "deny …", no answer → "timeout …" (the call is cancelled; the tool never runs).
// Each result line also names the hook / MCP child scripts the CLI was given: they must be the bundled .js files
// inside the installed package. Prints one line per turn; exit 1 on anything unexpected.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [pkgDir, port, tokenFile, workDir] = process.argv.slice(2);
if (!pkgDir || !port || !tokenFile || !workDir) { console.error('usage: turn.mjs <pkgDir> <port> <tokenFile> <workDir>'); process.exit(2); }
const WebSocket = createRequire(path.join(pkgDir, 'package.json'))('ws');
const origin = `http://127.0.0.1:${port}`;
const fail = (why) => { console.error(`turn: ${why}`); process.exit(1); };
setTimeout(() => fail('60초 안에 끝나지 않음'), 60_000).unref();

const token = fs.readFileSync(tokenFile, 'utf8').trim();
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token }) });
if (login.status !== 200) fail(`로그인 ${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie) fail('로그인 쿠키 없음');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin } });
const inbox = [];
let waiter = null;
ws.on('message', (d) => { inbox.push(JSON.parse(String(d))); waiter?.(); });
ws.on('error', (e) => fail(`ws: ${e.message}`));
await new Promise((r) => ws.once('open', r));

async function next(pred, what) {
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    const err = inbox.find((m) => m.type === 'error');
    if (err) fail(`${what} 대신 오류: ${err.message}`);
    await new Promise((r) => { waiter = r; });
  }
}

const realPkg = fs.realpathSync(pkgDir);
let sessionId = null;
for (const [i, kind] of ['approve', 'deny', 'timeout'].entries()) {
  const clientRef = `smoke-${i}`;
  ws.send(JSON.stringify({ type: 'send', sessionId, cwd: workDir, text: `smoke ${kind}`, engine: 'claude', model: 'sonnet', clientRef }));
  const started = await next((m) => m.type === 'turn_started' && m.clientRef === clientRef, 'turn_started');
  const card = await next((m) => m.type === 'permission_request' && m.turnId === started.turnId, 'permission_request');
  if (kind === 'approve') ws.send(JSON.stringify({ type: 'permission_response', requestId: card.requestId, decision: 'once' }));
  if (kind === 'deny') ws.send(JSON.stringify({ type: 'permission_response', requestId: card.requestId, decision: 'deny' }));
  const res = await next((m) => m.type === 'turn_result' && m.turnId === started.turnId, 'turn_result');
  const want = { approve: 'allow', deny: 'deny', timeout: 'timeout' }[kind];
  const m = /^(\w+) hook=(.+) mcp=(.+)$/.exec(res.text ?? '');
  if (!res.ok || !m) fail(`${kind}: 결과 ${JSON.stringify({ ok: res.ok, text: res.text, errorText: res.errorText })}`);
  if (m[1] !== want) fail(`${kind}: ${want} 를 기대했으나 ${m[1]}`);
  for (const [name, script] of [['hookRelay', m[2]], ['permissionMcp', m[3]]]) {
    if (script !== path.join(realPkg, 'dist', 'server', `${name}.js`)) fail(`${kind}: ${name} 가 설치본의 번들 .js 가 아님: ${script}`);
  }
  sessionId = started.sessionId ?? (inbox.find((x) => x.turnId === started.turnId && x.sessionId)?.sessionId) ?? res.sessionId ?? sessionId;
  console.log(`turn ${kind}: ${m[1]}`);
}
ws.close();
process.exit(0);
