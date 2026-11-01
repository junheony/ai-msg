/** Capture the real App from brief10-preview.ts; live failures remain failures in the artifact. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const port = Number(process.env.BRIEF10_PORT ?? 9410);
if (!Number.isInteger(port) || port < 9400 || port > 9499) throw new Error('BRIEF10_PORT must be in 9400–9499');
const base = `http://127.0.0.1:${port}`;
const dir = path.resolve('shots-yapquant');
const marker = await fetch(`${base}/api/me`).then(r => r.json());
if (marker.preview !== 'brief10-live-read-only') throw new Error('Refusing capture from an unrelated server');
let playwrightPath = process.env.BRIEF10_PLAYWRIGHT;
if (!playwrightPath) {
  try { playwrightPath = require.resolve('playwright'); }
  catch { playwrightPath = '/home/max/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'; }
}
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)).href);
await fs.mkdir(dir, { recursive: true });
let executablePath = process.env.BRIEF10_CHROMIUM;
if (!executablePath) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache/ms-playwright');
  const builds = (await fs.readdir(cache).catch(() => [])).filter(name => /^chromium(?:_headless_shell)?-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]) || Number(b.includes('headless')) - Number(a.includes('headless')));
  for (const build of builds) {
    const candidate = path.join(cache, build, build.includes('headless') ? 'chrome-headless-shell-linux64/chrome-headless-shell' : 'chrome-linux64/chrome');
    if (await fs.access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const browserVersion = browser.version();
const results = [];
try {
  // Warm the two production collectors once. No other modes are collected.
  const payload = await fetch(`${base}/api/hub/status`).then(r => { if (!r.ok) throw new Error(`status HTTP ${r.status}`); return r.json(); });
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify(payload, null, 2) + '\n');
  for (const mode of ['yapping', 'quant']) for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    console.error(`BRIEF10 capture: ${mode}-${size} opening`);
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', isMobile: size === 'mobile', hasTouch: size === 'mobile', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], consoleErrors = [], blockedRequests = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.origin === base ? url.pathname : `${url.origin}${url.pathname}` });
      if (url.origin !== base) { blockedRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${base}/?hub=${mode}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.error(`BRIEF10 capture: ${mode}-${size} loaded`);
    const main = page.locator(`.hub-main[data-mode="${mode}"]`);
    await main.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !!document.querySelector('.hub-main [data-testid="yapping-home"], .hub-main .kpi, .hub-main .lead'), undefined, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    console.error(`BRIEF10 capture: ${mode}-${size} checking`);
    const facts = await main.evaluate(root => {
      const links = Array.from(root.querySelectorAll('a[href]')).map(a => ({ text: a.textContent.trim(), href: a.href }));
      const text = root.textContent ?? '';
      const visibleText = root.innerText;
      const x = [...new Set(links.filter(a => /^https:\/\/(?:x|twitter)\.com\/[^?#]*\/status\/\d+/.test(a.href)).map(a => a.href))];
      const tg = [...new Set(links.filter(a => /^https:\/\/t\.me\/[^/?#]+\/\d+/.test(a.href)).map(a => a.href))];
      const overflow = { viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, hub: root.scrollWidth, hubClient: root.clientWidth };
      return { text, visibleText, links, x, tg, overflow, sourcePanels: Array.from(root.querySelectorAll('details')).filter(d => /소스 상태/.test(d.querySelector('summary')?.textContent ?? '')).map(d => ({ open: d.open, text: d.textContent })) };
    });
    const assertions = {
      shellRendered: await page.locator('.topbar').count() > 0,
      noPageErrors: errors.length === 0,
      noConsoleErrors: consoleErrors.length === 0,
      noExternalRequests: blockedRequests.length === 0,
      noHorizontalOverflow: facts.overflow.document <= viewport.width + 1 && facts.overflow.body <= viewport.width + 1 && facts.overflow.hub <= facts.overflow.hubClient + 1,
      ...(mode === 'yapping' ? {
        noOldRotation: !/09:30 슬롯|15:30 yap|21:30 뉴스|오늘의 로테이션|오늘 로테이션/.test(facts.text),
        threeXLinks: facts.x.length >= 3,
        threeTelegramLinks: facts.tg.length >= 3,
        sourcePanelCollapsed: facts.sourcePanels.length > 0 && facts.sourcePanels.every(p => !p.open),
      } : {
        upbitAccountsShown: /업비트1/.test(facts.visibleText) && /업비트2/.test(facts.visibleText),
        nullReasonRendered: /inactive/.test(facts.visibleText) && /401/.test(facts.visibleText) && /IP|아이피/.test(facts.visibleText),
      }),
    };
    await page.screenshot({ path: path.join(dir, `${mode}-${size}.png`), fullPage: true });
    console.error(`BRIEF10 capture: ${mode}-${size} primary screenshot saved`);
    // App owns a fixed-height scroll container. Keep the four primary shots unchanged,
    // and record every lower viewport separately instead of changing layout/CSS to fake full-page height.
    const scroll = await main.evaluate(root => ({ height: root.clientHeight, max: root.scrollHeight - root.clientHeight }));
    const scrollShots = [];
    for (let offset = Math.min(scroll.max, Math.floor(scroll.height * 0.8)), index = 1; offset > 0; index++) {
      await main.evaluate((root, top) => { root.scrollTop = top; }, offset);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = `${mode}-${size}-scroll-${String(index).padStart(2, '0')}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: true });
      scrollShots.push({ file, offset });
      if (offset >= scroll.max) break;
      offset = Math.min(scroll.max, offset + Math.max(1, Math.floor(scroll.height * 0.8)));
    }
    await fs.writeFile(path.join(dir, `${mode}-${size}.txt`), facts.visibleText + '\n');
    results.push({ mode, size, viewport, assertions, ...facts, scrollShots, errors, consoleErrors, blockedRequests, requests });
    await context.close();
  }
} finally { await browser.close(); }
const manifest = await fetch(`${base}/api/brief10/manifest`).then(r => r.json());
const report = { capturedAt: new Date().toISOString(), base, browser: { version: browserVersion, executablePath: executablePath ?? 'Playwright default' }, nature: 'Production built App, live read-only production yapping/quant collectors, empty shell fixtures. No deployed-server/auth/trading verification.', manifest, results };
await fs.writeFile(path.join(dir, 'assertions.json'), JSON.stringify(report, null, 2) + '\n');
const failed = results.flatMap(result => Object.entries(result.assertions).filter(([, ok]) => !ok).map(([name]) => `${result.mode}-${result.size}: ${name}`));
console.log(JSON.stringify({ output: dir, captures: results.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
