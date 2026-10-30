// MSG mini — Scriptable widget (iOS lock screen + home screen).
// Reads MSG's read-only status (GET /api/mini/status) with the 위젯 토큰 from MSG settings → 계정.
// Nothing is hardcoded: the first run asks for the URL and the token and keeps them in Scriptable's Keychain.
// Read-only: this script can neither start, stop nor approve anything.
//
// Install: Scriptable → + → paste → name it "MSG" → run once (enter URL + token) → add a Scriptable widget
// (lock screen: rectangular / inline / circular; home screen: small / medium / large) and pick this script.
// Reset the saved URL/token: run the script in-app with the parameter "reset" (or pick "다시 설정" from the menu).

const KEY_URL = 'msg.mini.url';
const KEY_TOKEN = 'msg.mini.token';
const TIMEOUT_S = 8;
const REFRESH_MIN = 5;

const C = {
  bg: new Color('#0b0b12'),
  fg: new Color('#f1f0f7'),
  muted: new Color('#aaa8bb'),
  faint: new Color('#7f7d92'),
  accent: new Color('#a78bfa'),
  ok: new Color('#7fae7a'),
  warn: new Color('#d6a24a'),
  danger: new Color('#e2675b'),
};

// ---- setup (Keychain) ----

async function ask(title, message, secure) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  if (secure) a.addSecureTextField('', ''); else a.addTextField('', '');
  a.addAction('저장');
  a.addCancelAction('취소');
  const i = await a.presentAlert();
  if (i < 0) return null;
  return a.textFieldValue(0).trim();
}

async function setup(force) {
  if (!config.runsInApp) return false; // widgets cannot show dialogs
  if (force || !Keychain.contains(KEY_URL)) {
    let url = await ask('MSG 주소', '예: https://msg.example.ts.net (끝에 / 없이)', false);
    if (!url) return false;
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    Keychain.set(KEY_URL, url);
  }
  if (force || !Keychain.contains(KEY_TOKEN)) {
    const token = await ask('위젯 토큰', 'MSG → 설정 → 계정 → 위젯 토큰 → 복사 한 값을 붙여넣으세요.', true);
    if (!token) return false;
    Keychain.set(KEY_TOKEN, token);
  }
  return true;
}

function creds() {
  if (!Keychain.contains(KEY_URL) || !Keychain.contains(KEY_TOKEN)) return null;
  return { url: Keychain.get(KEY_URL), token: Keychain.get(KEY_TOKEN) };
}

// ---- data ----

async function load(c) {
  const req = new Request(`${c.url}/api/mini/status`);
  req.method = 'GET';
  req.timeoutInterval = TIMEOUT_S;
  req.headers = { Authorization: `Bearer ${c.token}`, Accept: 'application/json' };
  const body = await req.loadJSON();
  const code = req.response && req.response.statusCode;
  if (code === 401) throw new Error('토큰 거부됨');
  if (code && code >= 400) throw new Error(`HTTP ${code}`);
  if (!body || !Array.isArray(body.sessions)) throw new Error('응답 형식 오류');
  return body;
}

// ---- text helpers ----

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (p) => (p === null || p === undefined ? '—' : `${p}%`);
const cost = (c) => (c === null || c === undefined ? '' : c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`);
const SF = { running: 'play.fill', waiting: 'hand.raised.fill', idle: 'pause.fill' };
const HUB = { ok: '●', warn: '▲', down: '✕', idle: '○', unknown: '?' };
const STATE_KO = { running: '실행', waiting: '승인 대기', idle: '대기' };

function toneOfPct(p) { return p === null || p === undefined ? C.faint : p >= 85 ? C.danger : p >= 60 ? C.warn : C.ok; }
function toneOfLeft(p) { return p === null || p === undefined ? C.faint : p < 10 ? C.danger : p < 25 ? C.warn : C.ok; }
function toneOfHub(s) { return s === 'ok' ? C.ok : s === 'warn' ? C.warn : s === 'down' ? C.danger : C.faint; }
function top(s) { return s.sessions && s.sessions[0] ? s.sessions[0] : null; }
function worst(s) { return s.hub ? s.hub.worst : 'unknown'; }

// ---- widgets ----

function text(w, str, size, color, opts) {
  const t = w.addText(str);
  t.font = (opts && opts.bold) ? Font.boldSystemFont(size) : (opts && opts.mono) ? Font.mediumMonospacedSystemFont(size) : Font.systemFont(size);
  t.textColor = color || C.fg;
  t.lineLimit = (opts && opts.lines) || 1;
  t.minimumScaleFactor = (opts && opts.shrink) || 1;
  return t;
}

function accessoryRectangular(s) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  const t = top(s);
  const head = w.addStack();
  head.centerAlignContent();
  const n = s.waiting ? `${s.waiting} 승인 대기` : `${s.running} 실행 중`;
  text(head, `MSG · ${n}`, 12, C.fg, { bold: true });
  head.addSpacer();
  text(head, HUB[worst(s)] || '?', 12, toneOfHub(worst(s)), { bold: true });
  if (t) {
    const row = w.addStack();
    row.centerAlignContent();
    text(row, pct(t.contextPct), 20, toneOfPct(t.contextPct), { bold: true });
    row.addSpacer(6);
    text(row, `${k(t.out)} out · ${t.turns}턴${cost(t.costUsd) ? ' · ' + cost(t.costUsd) : ''}`, 11, C.muted);
    text(w, t.title, 11, C.muted, { shrink: 0.8 });
  } else {
    text(w, '실행 중인 세션 없음', 12, C.muted);
    const a = (s.seats || [])[0];
    if (a) text(w, `${a.label} 5h ${pct(a.left5h)} · 주 ${pct(a.leftWeek)}`, 11, C.muted);
  }
  return w;
}

function accessoryInline(s) {
  const w = new ListWidget();
  const t = top(s);
  const parts = [`MSG ${s.waiting ? '✋' + s.waiting : '▶' + s.running}`];
  if (t) parts.push(`ctx ${pct(t.contextPct)}`);
  parts.push(HUB[worst(s)] || '?');
  text(w, parts.join(' · '), 12, C.fg);
  return w;
}

function accessoryCircular(s) {
  const w = new ListWidget();
  w.addAccessoryWidgetBackground = true;
  const t = top(s);
  const st = w.addStack();
  st.layoutVertically();
  st.centerAlignContent();
  const big = text(st, t ? pct(t.contextPct) : String(s.running), 18, C.fg, { bold: true, shrink: 0.6 });
  big.centerAlignText();
  const small = text(st, t ? `▶${s.running}${s.waiting ? ' ✋' + s.waiting : ''}` : '세션', 9, C.fg);
  small.centerAlignText();
  return w;
}

function homeWidget(s, family) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(12, 14, 12, 14);
  const head = w.addStack();
  head.centerAlignContent();
  text(head, 'MSG', 13, C.accent, { bold: true });
  head.addSpacer(6);
  text(head, s.waiting ? `✋ ${s.waiting} 승인 대기` : `▶ ${s.running} 실행 중`, 12, s.waiting ? C.warn : s.running ? C.ok : C.faint);
  head.addSpacer();
  text(head, `허브 ${HUB[worst(s)] || '?'}`, 12, toneOfHub(worst(s)));
  w.addSpacer(6);
  const count = family === 'large' ? 3 : family === 'medium' ? 2 : 1;
  const sessions = (s.sessions || []).slice(0, count);
  if (!sessions.length) text(w, '실행 중인 세션이 없습니다', 13, C.muted);
  for (const t of sessions) {
    const row = w.addStack();
    row.centerAlignContent();
    const sym = row.addImage(SFSymbol.named(SF[t.state] || 'circle').image);
    sym.imageSize = new Size(10, 10);
    sym.tintColor = t.state === 'waiting' ? C.warn : t.state === 'running' ? C.ok : C.faint;
    row.addSpacer(5);
    text(row, t.title, 13, C.fg, { bold: true, shrink: 0.8 });
    row.addSpacer();
    text(row, pct(t.contextPct), family === 'small' ? 22 : 18, toneOfPct(t.contextPct), { bold: true });
    if (family !== 'small') {
      const meta = [t.model, t.account].filter(Boolean).join('·');
      text(w, `${meta}  ${k(t.out)} out · ${k(t.cacheRead)} cache · ${t.turns}턴${cost(t.costUsd) ? ' · ' + cost(t.costUsd) : ''}`, 11, C.muted);
      if (family === 'large' && t.lastPrompt) text(w, t.lastPrompt, 11, C.faint, { lines: 2 });
    }
    w.addSpacer(4);
  }
  if (family !== 'small') {
    w.addSpacer();
    const seats = w.addStack();
    seats.centerAlignContent();
    for (const a of (s.seats || []).slice(0, 4)) {
      const st = seats.addStack();
      st.layoutVertically();
      text(st, a.label, 10, C.faint);
      const l = st.addStack();
      l.bottomAlignContent();
      text(l, pct(a.left5h), 15, toneOfLeft(a.left5h), { bold: true });
      l.addSpacer(3);
      text(l, `/ ${pct(a.leftWeek)}`, 10, C.muted);
      seats.addSpacer();
    }
  }
  if (family === 'large' && s.hub && s.hub.modes.length) {
    w.addSpacer(6);
    const hub = w.addStack();
    hub.centerAlignContent();
    for (const m of s.hub.modes.slice(0, 6)) {
      text(hub, `${HUB[m.state] || '?'} ${m.name}`, 11, toneOfHub(m.state));
      hub.addSpacer(8);
    }
  }
  w.addSpacer(2);
  const foot = w.addStack();
  foot.addSpacer();
  const df = new DateFormatter();
  df.useShortTimeStyle();
  text(foot, df.string(new Date()), 9, C.faint);
  return w;
}

function errorWidget(msg, family) {
  const w = new ListWidget();
  const acc = typeof family === 'string' && family.startsWith('accessory');
  if (acc) w.addAccessoryWidgetBackground = true; else { w.backgroundColor = C.bg; w.setPadding(12, 14, 12, 14); }
  if (family === 'accessoryInline') { text(w, `MSG · ${msg}`, 12, C.fg); return w; }
  if (family === 'accessoryCircular') { const t = text(w, '!', 20, C.warn, { bold: true }); t.centerAlignText(); return w; }
  text(w, 'MSG', 12, C.accent, { bold: true });
  text(w, msg, acc ? 11 : 13, C.warn, { lines: 2 });
  return w;
}

// ---- main ----

async function main() {
  const family = config.widgetFamily || 'medium';
  const param = (args.widgetParameter || '').trim();
  let c = creds();
  if (!c || param === 'reset') {
    if (!(await setup(true))) {
      const w = errorWidget('앱에서 한 번 실행해 설정하세요', family);
      Script.setWidget(w); if (config.runsInApp) await w.presentMedium(); return;
    }
    c = creds();
  }
  let w;
  try {
    const s = await load(c);
    w = family.startsWith('accessoryRectangular') ? accessoryRectangular(s)
      : family === 'accessoryInline' ? accessoryInline(s)
      : family === 'accessoryCircular' ? accessoryCircular(s)
      : homeWidget(s, family);
  } catch (e) {
    const m = String(e && e.message || e);
    w = errorWidget(/토큰/.test(m) ? '토큰 거부됨 · 다시 설정' : /timed out|network|connection|offline|hostname/i.test(m) ? '오프라인' : m, family);
  }
  w.url = `${c.url}/mini`;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
  Script.setWidget(w);
  if (config.runsInApp) {
    const menu = new Alert();
    menu.title = 'MSG 위젯';
    menu.message = '미리보기를 보거나 저장된 주소·토큰을 다시 설정합니다.';
    menu.addAction('미리보기');
    menu.addAction('다시 설정');
    menu.addCancelAction('닫기');
    const i = await menu.presentAlert();
    if (i === 0) await w.presentMedium();
    else if (i === 1) { await setup(true); }
  }
  Script.complete();
}

await main();
