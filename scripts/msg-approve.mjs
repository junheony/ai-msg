#!/usr/bin/env node
// msg-approve — file an approval request into the MSG hub's 승인함, or read its decision. No dependencies.
//
//   msg-approve request --title "Merge feat/x" [--kind generic|pr-merge|deploy] [--mode msg] [--from my-bot]
//                       [--detail "…" | --detail-file path] [--link "label=https://…"]…
//                       [--pr-url URL --pr-base main --pr-head feat/x --files 3 --additions 120 --deletions 8]
//                       [--deploy-target name --deploy-version v1.2] [--id custom-id]
//       → prints the request id. The file lands in ~/.msg/approvals/pending/<id>.json.
//   msg-approve status <id>     → pending | approved | rejected | missing  (exit 0 / 0 / 0 / 1); --json prints the file
//   msg-approve wait <id> [--timeout 3600]  → blocks until decided; exit 0 approved, 2 rejected, 3 timeout
//   msg-approve list            → pending ids, newest first
//
// Approving in the hub only records the decision (unless ~/.msg/approvals/hooks/<kind> exists and is executable,
// in which case it is run with the decided file's path). Trading requests are shown read-only and never decided there.
// MSG_HOME overrides ~/.msg (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.MSG_HOME || path.join(os.homedir(), '.msg');
const PENDING = path.join(ROOT, 'approvals', 'pending');
const DECIDED = path.join(ROOT, 'approvals', 'decided');
const KINDS = ['generic', 'pr-merge', 'deploy'];

function die(msg, code = 2) { process.stderr.write(`msg-approve: ${msg}\n`); process.exit(code); }

function parse(argv) {
  const out = { _: [], link: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (k === 'json') { out.json = true; continue; }
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) die(`--${k} 에 값이 필요합니다`);
    if (k === 'link') out.link.push(v); else out[k] = v;
  }
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'req';
const num = (v) => (v === undefined ? undefined : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : die(`숫자가 아닙니다: ${v}`));

function request(o) {
  if (!o.title) die('--title 이 필요합니다');
  const kind = o.kind || 'generic';
  if (!KINDS.includes(kind)) die(`--kind 는 ${KINDS.join('|')}`);
  const createdAt = new Date().toISOString();
  const id = o.id || `${createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${slug(o.title)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) die('잘못된 --id');
  const detail = o['detail-file'] ? fs.readFileSync(o['detail-file'], 'utf8') : (o.detail || '');
  const links = o.link.map((l) => { const i = l.indexOf('='); const href = i > 0 ? l.slice(i + 1) : l; if (!/^https?:\/\//.test(href)) die(`링크는 http(s) 만: ${l}`); return { label: i > 0 ? l.slice(0, i) : href, href }; });
  const req = { id, from: o.from || process.env.USER || 'script', mode: o.mode || 'msg', kind, title: o.title, detail: detail.slice(0, 4000), links, createdAt };
  if (kind === 'pr-merge') req.pr = Object.fromEntries(Object.entries({ url: o['pr-url'], base: o['pr-base'], head: o['pr-head'], files: num(o.files), additions: num(o.additions), deletions: num(o.deletions) }).filter(([, v]) => v !== undefined));
  if (kind === 'deploy') req.deploy = Object.fromEntries(Object.entries({ target: o['deploy-target'], version: o['deploy-version'] }).filter(([, v]) => v !== undefined));
  fs.mkdirSync(PENDING, { recursive: true, mode: 0o700 });
  const file = path.join(PENDING, `${id}.json`);
  if (fs.existsSync(file) || fs.existsSync(path.join(DECIDED, `${id}.json`))) die(`이미 있는 id: ${id}`);
  const tmp = path.join(PENDING, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(req, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  process.stdout.write(id + '\n');
}

function status(id, asJson) {
  for (const [dir, fallback] of [[DECIDED, null], [PENDING, 'pending']]) {
    const f = path.join(dir, `${id}.json`);
    if (!fs.existsSync(f)) continue;
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (asJson) process.stdout.write(JSON.stringify(o, null, 2) + '\n');
    else process.stdout.write((o.decision?.status ?? fallback ?? 'pending') + (o.decision?.note ? `\t${o.decision.note}` : '') + '\n');
    return o.decision?.status ?? 'pending';
  }
  process.stdout.write('missing\n');
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest);
switch (cmd) {
  case 'request': request(o); break;
  case 'status': if (!o._[0]) die('id 가 필요합니다'); status(o._[0], o.json); break;
  case 'wait': {
    if (!o._[0]) die('id 가 필요합니다');
    const until = Date.now() + Number(o.timeout || 3600) * 1000;
    const tick = () => {
      const f = path.join(DECIDED, `${o._[0]}.json`);
      if (fs.existsSync(f)) { const d = JSON.parse(fs.readFileSync(f, 'utf8')).decision; process.stdout.write(`${d?.status}\n`); process.exit(d?.status === 'approved' ? 0 : 2); }
      if (Date.now() > until) { process.stdout.write('timeout\n'); process.exit(3); }
      setTimeout(tick, 3000);
    };
    tick();
    break;
  }
  case 'list': {
    let names = [];
    try { names = fs.readdirSync(PENDING).filter((n) => n.endsWith('.json')); } catch { /* none */ }
    names.map((n) => ({ n, t: fs.statSync(path.join(PENDING, n)).mtimeMs })).sort((a, b) => b.t - a.t).forEach(({ n }) => process.stdout.write(n.slice(0, -5) + '\n'));
    break;
  }
  default:
    process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    process.exit(cmd ? 2 : 0);
}
