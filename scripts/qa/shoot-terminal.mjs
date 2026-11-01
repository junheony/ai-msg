// BRIEF6 terminal screenshot driver. Usage: node scripts/qa/shoot-terminal.mjs <outDir> <tag>
// QA_STATE defaults to /tmp/msg-terminal-qa-state.json; DIST overrides its frozen UI build.
// SIZES=desktop,mobile (1440x900 / 390x844), RDP_PORT=9343, SETTLE_MS=2500.
// ANSWER_HASH overrides the saved normalized answer hash. EVAL runs an optional read-only DOM inspection.
// HEADER_CHECKS=1 requires the BRIEF7b single-identity header, quiet approval chip, and error-aware PARTIAL status.
// file:// CDP proxy is required on this host; browser HTTP navigation stalls. No real service traffic.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../package.json', import.meta.url));
const WebSocket = require('ws');
const ts = require('typescript');

// Vite can inline its preload helper into any chunk and rename every binding. Match the small root-prefix
// function by syntax, not the output filename or minified variable names. Absolute file URLs also work
// across Vite versions that resolve preload URLs against either import.meta.url or the document.
function offlinePreloads(source, fileRoot) {
  if (!source.includes('Unable to preload CSS')) return { source, count: 0 };
  const ast = ts.createSourceFile('chunk.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  const visit = (node) => {
    if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) && node.body) {
      const body = node.body;
      const expr = ts.isBlock(body)
        ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]) ? body.statements[0].expression : null
        : body;
      if (expr && ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken
          && ts.isStringLiteralLike(expr.left) && expr.left.text === '/' && ts.isIdentifier(expr.right)
          && node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === expr.right.text)) {
        edits.push({ start: expr.left.getStart(ast), end: expr.left.end });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + JSON.stringify(fileRoot) + source.slice(edit.end);
  }
  return { source, count: edits.length };
}


const [outDir = 'shots-terminal', tag = 'before'] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.QA_STATE || '/tmp/msg-terminal-qa-state.json', 'utf8'));
const DIST = process.env.DIST || state.uiDir;
const SERVER = state.server;
if (SERVER !== 'http://127.0.0.1:9381') throw new Error('Only isolated QA port 9381 is allowed');
const TOKEN_FILE = state.tokenFile;
const STATUS_JSON = 'live';
const SIZES_SEL = (process.env.SIZES || 'desktop,mobile').split(',');
const RDP = Number(process.env.RDP_PORT || 9343);
try { await fetch(`http://127.0.0.1:${RDP}/json/version`, { signal: AbortSignal.timeout(500) }); throw new Error('CDP port already occupied'); } catch (e) { if (e.message === 'CDP port already occupied') throw e; }
const VERBOSE = false; // Never print proxy data from real transcripts.
const errors = [];
const SETTLE = Number(process.env.SETTLE_MS || 2500);
const SIZES = { desktop: { width: 1440, height: 900, scale: 1, mobile: false }, mobile: { width: 390, height: 844, scale: 1, mobile: true } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const cookie = `deck_session=${createHash('sha256').update(`deck-cookie:${token}`).digest('hex')}`;
// STATUS_JSON=live → /api/hub/status is proxied to SERVER like every other call (real collectors).
const status = STATUS_JSON === 'live' ? null : fs.readFileSync(STATUS_JSON, 'utf8');
fs.mkdirSync(outDir, { recursive: true });

// 1. a file:// copy of the build with relative asset paths
const site = fs.mkdtempSync('/tmp/hubdist-');
fs.cpSync(DIST, site, { recursive: true });
const idx = path.join(site, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/(src|href)="\/(?!\/)/g, '$1="./'));
let preloadHelpers = 0;
const fileRoot = pathToFileURL(site + path.sep).href;
for (const f of fs.readdirSync(path.join(site, 'assets'))) {
  const p = path.join(site, 'assets', f);
  // fonts and images referenced from CSS are emitted as /assets/x: make them relative to the stylesheet
  if (f.endsWith('.css')) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/url\(\/assets\//g, 'url(./'));
  if (!f.endsWith('.js')) continue;
  const patched = offlinePreloads(fs.readFileSync(p, 'utf8'), fileRoot);
  if (patched.count) { fs.writeFileSync(p, patched.source); preloadHelpers += patched.count; }
}

log('offline preload helpers patched:', preloadHelpers);

// 2. chrome + CDP
const profile = fs.mkdtempSync('/tmp/shoot-prof-');
const chrome = spawn('/usr/bin/google-chrome', ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${RDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none',
  '--allow-file-access-from-files', '--disable-extensions', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch {} fs.rmSync(site, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); };
process.on('exit', cleanup);
let page;
for (let i = 0; i < 100 && !page; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${RDP}/json/list`)).json(); page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension')); } catch {}
  if (!page) await sleep(200);
}
if (!page) { log('no page target'); process.exit(2); }
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => cdp.on('open', r));
let id = 0; const waits = new Map(); const handlers = [];
cdp.on('message', (d) => { const m = JSON.parse(d); if (VERBOSE) console.log('<-', JSON.stringify(m).slice(0, 200)); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); if (VERBOSE) console.log('->', method); cdp.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) log('eval error', r.result.exceptionDetails.text, expression.slice(0, 80)); return r.result?.result?.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Network.enable'); await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: process.env.THEME || 'dark' }] });
await send('Runtime.addBinding', { name: '__proxy' });
handlers.push((m) => { if (m.method === 'Runtime.exceptionThrown') errors.push({ kind: 'page-exception', name: m.params.exceptionDetails?.exception?.className, description: m.params.exceptionDetails?.exception?.description?.split('\n')[0], detail: m.params.exceptionDetails?.text, stack: m.params.exceptionDetails?.stackTrace?.callFrames?.map(f => ({fn:f.functionName, line:f.lineNumber})) }); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push({ kind: 'console-error' }); });

// 3. in-page shims: fetch -> node, WebSocket -> node, no animations
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  for (const method of ['replaceState','pushState']) { const nativeHistory = history[method].bind(history); history[method] = (state, title, url) => { if (typeof url === 'string' && url.startsWith('/')) url = location.pathname + (url.includes('?') ? url.slice(url.indexOf('?')) : ''); return nativeHistory(state, title, url); }; }
  const native = window.fetch.bind(window); let seq = 0; const pend = new Map();
  window.__rx = (id, status, ct, body) => { const p = pend.get(id); pend.delete(id); if (p) p(new Response(status === 204 ? null : body, { status, headers: { 'content-type': ct } })); };
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/')) return native(input, init);
    return new Promise((res) => { const id = ++seq; pend.set(id, res); __proxy(JSON.stringify({ kind: 'fetch', id, url, method: init.method || 'GET', body: init.body ?? null, headers: init.headers || null })); });
  };
  let n = 0;
  class FakeWS extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.id = ++n; this.onopen = this.onmessage = this.onclose = this.onerror = null; window.__wss = window.__wss || {}; window.__wss[this.id] = this; __proxy(JSON.stringify({ kind: 'ws_open', id: this.id })); }
    send(d) { __proxy(JSON.stringify({ kind: 'ws_send', id: this.id, data: String(d) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; __proxy(JSON.stringify({ kind: 'ws_close', id: this.id })); this.onclose && this.onclose({ code: 1000 }); }
    _open() { this.readyState = 1; this.onopen && this.onopen({}); }
    _msg(data) { try { if (JSON.parse(data).type === 'hub_status') return; } catch {} this.onmessage && this.onmessage({ data }); }
    _closed() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({ code: 1006 }); }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}'; document.head.appendChild(s); });
})();` });

// 4. node side of the proxy
const sockets = new Map();
handlers.push(async (m) => {
  if (m.method !== 'Runtime.bindingCalled' || m.params.name !== '__proxy') return;
  const msg = JSON.parse(m.params.payload);
  if (msg.kind === 'fetch') {
    let st = 200, ct = 'application/json', body = '';
    if (status !== null && msg.url.startsWith('/api/hub/status')) body = status;
    else {
      try {
        if (!msg.url.startsWith('/api/') || msg.url.startsWith('//')) throw new Error('QA path denied');
        const r = await fetch(SERVER + msg.url, { method: msg.method, headers: { ...(msg.headers || {}), cookie }, body: msg.body });
        st = r.status; ct = r.headers.get('content-type') || ct; body = await r.text();
        if (st >= 400) errors.push({ kind: 'api', status: st, path: msg.url.split('?')[0] });
      } catch (e) { st = 502; body = '{}'; log('proxy fetch failed', msg.url, e.message); }
    }
    if (VERBOSE) log('fetch', msg.method, msg.url, '->', st);
    await send('Runtime.evaluate', { expression: `__rx(${msg.id}, ${st}, ${JSON.stringify(ct)}, ${JSON.stringify(body)})` });
  } else if (msg.kind === 'ws_open') {
    const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws', { headers: { cookie, origin: SERVER } });
    sockets.set(msg.id, ws);
    ws.on('open', () => { if (VERBOSE) log('ws open', msg.id); void send('Runtime.evaluate', { expression: `__wss[${msg.id}]._open()` }); });
    ws.on('message', (d) => { void send('Runtime.evaluate', { expression: `__wss[${msg.id}]._msg(${JSON.stringify(String(d))})` }); });
    ws.on('close', () => { sockets.delete(msg.id); void send('Runtime.evaluate', { expression: `__wss[${msg.id}] && __wss[${msg.id}]._closed()` }); });
    ws.on('error', (e) => log('ws error', e.message));
  } else if (msg.kind === 'ws_send') {
    const ws = sockets.get(msg.id); if (ws && ws.readyState === 1) ws.send(msg.data);
  } else if (msg.kind === 'ws_close') {
    const ws = sockets.get(msg.id); if (ws) ws.close(); sockets.delete(msg.id);
  }
});
const closeSockets = () => { for (const ws of sockets.values()) try { ws.close(); } catch {} sockets.clear(); };

const nav = async (url) => {
  closeSockets();
  const loaded = new Promise((r) => { const h = (m) => { if (m.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(h), 1); r(); } }; handlers.push(h); });
  const res = await send('Page.navigate', { url });
  if (res.result?.errorText) log('navigate error', res.result.errorText);
  await Promise.race([loaded, sleep(8000)]);
};


// 5. Deterministic real-turn framing. The anchor is a text hash, never raw transcript data.
const base = `file://${idx}`;
const manifest = { tag, fixture: state.fixture || 'claude-real-redacted', source: state.sourceFile, counts: state.counts, dist: DIST, conciseMode: true, headerChecks: process.env.HEADER_CHECKS === '1', sizes: {}, errors };
const selectedUrl = base + '?hub=msg&session=' + encodeURIComponent(state.selectedId);
const inspect = `(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth, chat: !!document.querySelector('.chat'), users: document.querySelectorAll('.msg.user').length, answers: document.querySelectorAll('.msg.assistant .markdown').length, steps: document.querySelectorAll('.tool-group,.activity-steps').length, concise: document.documentElement.dataset.concise, login: !!document.querySelector('input[type=password]'), errorToasts: document.querySelectorAll('.toast.error,.error-toast,[role=alert].toast').length, hamburger: !!document.querySelector('button.menu,.sidebar-toggle') }))()`;
for (const sizeName of SIZES_SEL) {
  const size = SIZES[sizeName]; if (!size) throw new Error('Unknown size');
  await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
  await nav(selectedUrl);
  for (let i = 0; i < 40; i++) { if (await evaluate(`document.querySelectorAll('.msg.assistant .markdown').length > 0`)) break; await sleep(250); }
  await sleep(SETTLE); await evaluate('document.fonts.ready.then(() => true)');
  // Choose a long answer with a preceding real user turn; preserve that same text hash in all builds.
  const frame = await evaluate(`(() => {
    const body = document.querySelector('.chat-body');
    const answers = [...document.querySelectorAll('.msg.assistant .markdown')].filter(e => !e.classList.contains('thinking-body'));
    const hash = s => { s = s.replace(/^\\s*(?:SUCCESS|PARTIAL|BLOCKED)\\s*[:.—–-]?\\s*/i, '').replace(/\\s+/g, ' ').trim(); let h=2166136261; for (const c of s) h=Math.imul(h^c.charCodeAt(0),16777619); return (h>>>0).toString(16); };
    const preferred = ${JSON.stringify(process.env.ANSWER_HASH || state.answerHash || '')};
    const answer = preferred ? answers.find(e => hash(e.textContent) === preferred) : answers.filter(e => e.textContent.length > 650 && e.textContent.length < 6000).at(-1) || answers.at(-1);
    if (!body || !answer) return null;
    window.__qaAnswer = answer;
    let user = answer.closest('.msg'); while (user && !user.classList.contains('user')) user = user.previousElementSibling;
    window.__qaUser = user;
    answer.scrollIntoView({block:'start'});
    return { answerHash: hash(answer.textContent), answerChars: answer.textContent.length, user: !!user, toolGroups: document.querySelectorAll('.tool-group,.activity-steps').length };
  })()`);
  if (!frame) { log('diagnostic', JSON.stringify(await evaluate(inspect)), JSON.stringify(errors)); const shot = await send('Page.captureScreenshot', {format:'png'}); if(shot.result?.data) fs.writeFileSync('/tmp/terminal-qa-failure.png',Buffer.from(shot.result.data,'base64')); throw new Error('No fixture answer rendered'); }
  if (!state.answerHash) { state.answerHash = frame.answerHash; fs.writeFileSync(process.env.QA_STATE || '/tmp/msg-terminal-qa-state.json', JSON.stringify(state, null, 2) + '\n', {mode:0o600}); }
  const shots = [];
  const capture = async (name, scope = 'transcript') => {
    await sleep(350);
    const metrics = await evaluate(inspect);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (!shot.result?.data) throw new Error('Screenshot failed');
    const file = path.join(outDir, `${tag}-${sizeName}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    shots.push({ file, scope, ...metrics }); log(file, JSON.stringify(metrics));
  };
  await evaluate(`window.__qaUser?.scrollIntoView({block:'start'}); true`); await capture('turn');
  const interactions = {};
  interactions.header = await evaluate(`(() => {
    const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;};
    const h=[...document.querySelectorAll('[data-pane-head]')].find(visible); if(!h)return null;
    const r=h.getBoundingClientRect();
    const title=h.querySelector('.head-chip-title'),titleWidth=title?.getBoundingClientRect().width||0;
    const chip=h.querySelector('.head-engine-chip'),mode=h.querySelector('[data-testid="perm-badge"]'),modeText=mode?.querySelector('.perm-badge-full');
    const chipVisibleText=chip?.innerText||'',chipAccessibleText=[chipVisibleText,chip?.getAttribute('title'),chip?.getAttribute('aria-label')].filter(Boolean).join(' ');
    const answer=window.__qaAnswer?.closest('.msg.assistant');
    const statusNodes=[...answer?.querySelectorAll('.reply-status')||[]];
    const statuses=statusNodes.map(e=>e.textContent.trim()).filter(s=>/^(SUCCESS|PARTIAL|BLOCKED)$/.test(s));
    const group=answer?.querySelector('[data-testid="activity-steps"]'),error=group?.querySelector('.activity-errors');
    const probe=document.createElement('span');probe.style.color='var(--danger)';h.appendChild(probe);const danger=getComputedStyle(probe).color;probe.remove();
    const modeStyle=mode?getComputedStyle(mode):null;
    return {viewportWidth:innerWidth,visible:r.width>0&&r.height>0,inside:r.left>=0&&r.right<=innerWidth+1,titleWidth,titleVisible:visible(title),
      identityMarks:[...h.querySelectorAll('.head-avatar,.engine-mark')].filter(visible).length,
      hermes:!!h.querySelector('[data-engine="hermes"],.engine-mark.hermes')||/hermes/i.test(h.textContent),
      modelChipVisible:visible(chip),modelChipHasEngine:/hermes/i.test(chipAccessibleText),modelChipHasVisibleLabel:/hermes|astra/i.test(chipVisibleText),
      modelChipModelVisible:/gpt[ -]?6[ -]?astra|gpt[ -]?astra/i.test(chipVisibleText),modelChipHasModel:/gpt[ -]?6[ -]?astra|gpt[ -]?astra/i.test(chipAccessibleText),
      autoApprove:!!mode,autoApproveVisible:visible(mode)&&visible(modeText),autoApproveText:modeText?.textContent.trim()||'',autoApproveTooltip:!!mode?.title,
      autoApproveColor:modeStyle?.color||null,dangerColor:danger,
      autoApproveQuiet:!!modeStyle&&modeStyle.color!==danger&&!/⚠|모두/.test(mode?.textContent||'')&&!mode?.classList.contains('danger')&&mode?.getAttribute('role')!=='alert',
      statuses,statusVisible:statusNodes.some(visible),errorCountVisible:visible(error)&&/오류\\s*1/.test(error?.textContent||''),finished:!!group&&!group.classList.contains('live')};
  })()`);
  interactions.composer = await evaluate(`(() => {
    const t=document.querySelector('.chat textarea'),n=document.querySelector('[data-testid="composer-note"]');
    return {editable:!!t&&!t.disabled&&!t.readOnly,blockedAccount:/설정에 없는 계정|뺀 계정의 세션/.test(n?.textContent||'')};
  })()`);
  await capture('header');
  await evaluate(`window.__qaAnswer.closest('.msg.assistant').scrollIntoView({block:'start'}); true`); await capture('answer-top');
  await evaluate(`window.__qaAnswer.scrollIntoView({block:'end'}); true`); await capture('answer-bottom');
  interactions.options = await evaluate(`(() => { const b=document.querySelector('button.session-chip'); if(!b)return null; b.click(); return true; })()`);
  await sleep(150);
  interactions.modelMenu = await evaluate(`!!document.querySelector('[data-testid=\"model-menu\"]')`);
  interactions.picker = await evaluate(`(() => {
    const m=document.querySelector('[data-testid="model-menu"]'),s=document.querySelector('.session-sheet');
    const r=m?.getBoundingClientRect(),q=s?.getBoundingClientRect();
    const content=s?.textContent||m?.textContent||'';
    return {reachable:!!r&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&(!q||q.bottom<=innerHeight+1),hermes:/hermes/i.test(content),astra:/gpt[ -]?6[ -]?astra|gpt[ -]?astra/i.test(content)};
  })()`);
  await capture('model-picker');
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  interactions.usageRoute = await evaluate(`(async () => {
    const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&s.visibility!=='hidden'&&s.display!=='none';};
    const pause=()=>new Promise(r=>setTimeout(r,150));
    const strip=document.querySelector('button.usage-strip');
    if(visible(strip)){strip.click();return 'topbar';}
    const drawer=document.querySelector('button.menu[aria-label="메뉴"]');
    if(!visible(drawer))return 'missing-opener';
    if(drawer.getAttribute('aria-expanded')!=='true'){drawer.click();await pause();}
    const account=document.querySelector('button.sidebar-avatar[aria-label="설정 및 계정"]');
    if(!visible(account))return 'missing-account-menu';
    if(account.getAttribute('aria-expanded')!=='true'){account.click();await pause();}
    const item=[...document.querySelectorAll('.foot-menu [role="menuitem"]')].find(e=>e.textContent.trim()==='사용량 보기');
    if(!visible(item))return 'missing-usage-action';
    item.click();return 'sidebar-account';
  })()`);
  await sleep(250);
  for(let i=0;i<20;i++){if(await evaluate(`!!document.querySelector('.usage-strip-pop,.usage-sheet')`))break;await sleep(100);}
  interactions.usageMenu = await evaluate(`(() => {const e=document.querySelector('.usage-strip-pop,.usage-sheet');if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1;})()`);
  await evaluate(`(() => {const close=document.querySelector('.usage-sheet button[aria-label="닫기"]');if(close)close.click();else{const strip=document.querySelector('button.usage-strip');if(strip&&strip.getBoundingClientRect().width)strip.click();}return true;})()`);
  await sleep(150);
  await evaluate(`(() => {const menu=document.querySelector('button.menu[aria-label="메뉴"][aria-expanded="true"]');if(menu)menu.click();return true;})()`);
  await sleep(150);
  interactions.usageClosed = await evaluate(`!document.querySelector('.usage-sheet,.usage-strip-pop')&&document.querySelector('button.menu[aria-label="메뉴"]')?.getAttribute('aria-expanded')!=='true'`);
  interactions.expandStep = await evaluate(`(() => { const e=document.querySelector('details.activity-steps,details.tool-group'); if(!e) return null; e.querySelector('summary')?.click(); const opened=e.open; e.querySelector('summary')?.click(); return opened && !e.open; })()`);
  if (process.env.EVAL) interactions.extra = await evaluate(process.env.EVAL);
  if (size.mobile) { await evaluate(`document.querySelector('button.menu[aria-label="메뉴"]')?.click(); true`); await capture('drawer'); }
  else { await evaluate(`window.__qaUser?.scrollIntoView({block:'start'}); true`); await capture('list'); }
  if (process.env.LAYOUT_CHECKS) {
    const layout = await evaluate(`(async () => {
      const drawerButton=document.querySelector('button.menu[aria-expanded=\"true\"]'); if(drawerButton)drawerButton.click();
      document.documentElement.style.setProperty('--font-scale','1.35');
      if (innerWidth > 700) {
        document.querySelector('button.split[aria-label="새 분할"]')?.click();
        await new Promise(r=>setTimeout(r,100));
        const panes=document.querySelector('.panes');
        if (panes) panes.style.gridTemplateColumns='400px 6px minmax(0,1fr)';
      }
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const composer=document.querySelector('.chat .composer'), chat=document.querySelector('.chat-body');
      if(!composer || !chat)return {error:'missing real chat'};
      const c=composer.getBoundingClientRect();
      const buttons=[...composer.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width&&r.height;}).map(b=>{const r=b.getBoundingClientRect();return {label:b.getAttribute('aria-label')||b.getAttribute('title')||b.className, x:r.x,y:r.y,w:r.width,h:r.height,inside:r.left>=c.left-1&&r.right<=c.right+1&&r.top>=c.top-1&&r.bottom<=c.bottom+1};});
      composer.querySelector('button.session-chip')?.click();
      await new Promise(r=>setTimeout(r,100));
      const menu=document.querySelector('[data-testid="model-menu"]'), sheet=document.querySelector('.session-sheet');
      const mr=menu?.getBoundingClientRect(), sr=sheet?.getBoundingClientRect();
      return {fontScale:getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),paneWidth:document.querySelector('.chat').getBoundingClientRect().width, composerWidth:c.width, buttons, documentOverflow:document.documentElement.scrollWidth>innerWidth, chatOverflow:chat.scrollWidth>chat.clientWidth+1, composerOverflow:composer.scrollWidth>composer.clientWidth+1, modelMenuReachable:!!mr&&mr.width>0&&mr.left>=0&&mr.right<=innerWidth+1&&!!sr&&sr.bottom<=innerHeight+1, extras:'Idle composer only; queue/task controls unexercised. No sends simulated.'};
    })()`);
    interactions.layout = layout;
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(shot.result?.data)fs.writeFileSync(path.join(outDir,`${tag}-${sizeName}-xlarge-layout.png`),Buffer.from(shot.result.data,'base64'));
    await evaluate('localStorage.clear(); true'); // Keep stress-test split state out of the next viewport.
  }
  if (state.fixture === 'hermes-synthetic') {
    await nav(selectedUrl); await sleep(SETTLE);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,bubbles:true,cancelable:true})); true`);
    await sleep(300);
    interactions.newSession = await evaluate(`!!document.querySelector('[aria-label="첫 메시지"]')`);
    await capture('empty-state', 'new');
    await evaluate(`document.querySelector('button.session-chip')?.click(); true`); await sleep(150);
    interactions.newHermes = await evaluate(`(() => {
      const s=document.querySelector('[data-testid="engine-select"]');
      if(!s||![...s.options].some(o=>o.value==='hermes'&&!o.disabled))return {available:false};
      s.value='hermes';s.dispatchEvent(new Event('change',{bubbles:true}));return {available:true};
    })()`);
    await sleep(250);
    interactions.newHermes = {...interactions.newHermes,...await evaluate(`(() => {
      const s=document.querySelector('[data-testid="engine-select"]'),m=document.querySelector('[data-testid="model-menu"]');
      const r=m?.getBoundingClientRect(),q=document.querySelector('.session-sheet')?.getBoundingClientRect();
      return {selected:s?.value==='hermes',astra:/gpt[ -]?6[ -]?astra|gpt[ -]?astra/i.test(m?.textContent||''),reachable:!!r&&r.width>0&&r.left>=0&&r.right<=innerWidth+1&&!!q&&q.bottom<=innerHeight+1};
    })()`)};
    await capture('new-hermes-picker', 'new');
  }
  await nav(base+'?hub=home'); await sleep(500); interactions.homeHasHamburger = await evaluate(`!!document.querySelector('button.menu,.sidebar-toggle')`);
  manifest.sizes[sizeName] = { frame, shots, interactions };
}
const layoutPassed = (layout) => !!layout && !layout.error && layout.buttons?.length > 0
  && layout.buttons.every((button) => button.inside) && !layout.documentOverflow
  && !layout.chatOverflow && !layout.composerOverflow && layout.modelMenuReachable;
const headerPassed = (header) => !!header && header.identityMarks === 1 && header.modelChipVisible
  && header.titleVisible && (header.viewportWidth > 420 || header.titleWidth >= 90)
  && header.modelChipHasEngine && header.modelChipHasVisibleLabel && header.modelChipHasModel && header.autoApproveVisible
  && header.autoApproveText === '자동 승인' && header.autoApproveTooltip && header.autoApproveQuiet
  && header.finished && header.errorCountVisible && header.statusVisible
  && header.statuses.includes('PARTIAL') && !header.statuses.includes('SUCCESS');
manifest.passed = errors.length === 0 && Object.values(manifest.sizes).every(({ shots, interactions }) =>
  shots.every((m) => (m.scope === 'new' || m.chat && m.users > 0 && m.answers > 0 && m.steps > 0) && !m.overflow && !m.login && m.errorToasts === 0)
  && interactions.options && interactions.modelMenu && interactions.picker?.reachable && interactions.header?.visible && interactions.header?.inside && interactions.usageMenu && ['topbar','sidebar-account'].includes(interactions.usageRoute) && interactions.usageClosed && interactions.expandStep
  && (state.fixture !== 'hermes-synthetic' || interactions.picker?.hermes && interactions.picker?.astra && interactions.header?.hermes && interactions.composer?.editable && !interactions.composer?.blockedAccount && interactions.newSession && interactions.newHermes?.available && interactions.newHermes?.selected && interactions.newHermes?.astra && interactions.newHermes?.reachable)
  && !interactions.homeHasHamburger && (!process.env.LAYOUT_CHECKS || layoutPassed(interactions.layout))
  && (!manifest.headerChecks || state.fixture === 'hermes-synthetic' && headerPassed(interactions.header)));

fs.writeFileSync(path.join(outDir, `${tag}-inspection.json`), JSON.stringify(manifest, null, 2) + '\n');
closeSockets(); cleanup(); process.exit(manifest.passed ? 0 : 1);
