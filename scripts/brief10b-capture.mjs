/** BRIEF10b Rising-only capture; opt-in fixtures are visibly labelled and separately named. */
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
const sourceManifest = await fetch(`${base}/api/brief10/manifest`).then(r => r.json());
if (sourceManifest.daily && sourceManifest.daily !== 'live') throw new Error('Use brief10c-capture.mjs for synthetic daily fixtures; BRIEF10b captures require live daily data');
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
const manifest = await fetch(`${base}/api/brief10/manifest`).then(r => r.json());
const scenario = manifest.rising === 'live' ? 'live' : manifest.rising === 'SYNTHETIC FIXTURE: success' ? 'success' : manifest.rising === 'SYNTHETIC FIXTURE: error' ? 'error' : null;
if (!scenario) { await browser.close(); throw new Error('Preview must explicitly declare Rising live/fixture mode'); }
const prefix = `brief10b-rising-${scenario}`;
const results = [];
try {
  const payload = await fetch(`${base}/api/hub/status`).then(r => { if (!r.ok) throw new Error(`status HTTP ${r.status}`); return r.json(); });
  await fs.writeFile(path.join(dir, `${prefix}-status.json`), JSON.stringify(payload, null, 2) + '\n');
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', isMobile: size === 'mobile', hasTouch: size === 'mobile', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], consoleErrors = [], blockedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin !== base || request.method() !== 'GET') { blockedRequests.push(`${request.method()} ${request.url()}`); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${base}/?hub=yapping`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const main = page.locator('.hub-main[data-mode="yapping"]');
    const card = main.locator('.yp-rising');
    await card.waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // The label is capture instrumentation only, deliberately explicit about synthetic data.
    if (scenario !== 'live') await page.evaluate(label => {
      const banner = document.createElement('div');
      banner.textContent = `SYNTHETIC RISING FIXTURE · ${label.toUpperCase()} · 나머지 운영 통계는 로컬 기록`;
      banner.setAttribute('data-capture-fixture', label);
      Object.assign(banner.style, { position: 'fixed', bottom: '4px', left: '4px', right: '4px', zIndex: '99999', padding: '7px', background: '#252525', color: '#fff', font: '11px sans-serif', border: '1px solid #999', pointerEvents: 'none' });
      document.body.append(banner);
    }, scenario);
    const facts = await main.evaluate(root => {
      const rising = root.querySelector('.yp-rising');
      return {
        text: rising.innerText,
        ranks: Array.from(rising.querySelectorAll('.yp-rising-rank')).map(item => Number(item.textContent)),
        links: Array.from(rising.querySelectorAll('a')).map(link => ({ href: link.href, rel: link.rel, target: link.target })),
        singleLineText: Array.from(rising.querySelectorAll('.yp-rising-post a')).every(link => getComputedStyle(link).whiteSpace === 'nowrap' && getComputedStyle(link).textOverflow === 'ellipsis'),
        missingReason: rising.querySelector('.yp-empty')?.textContent ?? null,
        localCaps: root.querySelectorAll('.yp-cap').length,
        sourceCollapsed: !root.querySelector('.yp-sources').open,
        overflow: { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, hub: root.scrollWidth, hubClient: root.clientWidth },
      };
    });
    const assertions = {
      noPageErrors: errors.length === 0, noConsoleErrors: consoleErrors.length === 0, noBlockedRequests: blockedRequests.length === 0,
      noHorizontalOverflow: facts.overflow.document <= viewport.width + 1 && facts.overflow.body <= viewport.width + 1 && facts.overflow.hub <= facts.overflow.hubClient + 1,
      localStatsPresent: facts.localCaps === 4, sourceCollapsed: facts.sourceCollapsed,
      safeLinks: facts.links.every(link => /^https:\/\/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/\d+$/.test(link.href) && link.rel === 'noopener noreferrer' && link.target === '_blank'),
      singleLineText: facts.singleLineText,
      ...(scenario === 'success' ? { tenRanks: JSON.stringify(facts.ranks) === JSON.stringify([1,2,3,4,5,6,7,8,9,10]), fieldsRendered: /12,000.5/.test(facts.text) && /조회\/시간/.test(facts.text) && /AI/.test(facts.text) && /시간 경과/.test(facts.text) && /@fixture_1/.test(facts.text), fixtureLabel: await page.locator('[data-capture-fixture="success"]').count() === 1 } : {}),
      ...(scenario === 'error' ? { explicitTimeout: facts.missingReason === '데이터 없음 · 시간 초과', noStaleRows: facts.links.length === 0, fixtureLabel: await page.locator('[data-capture-fixture="error"]').count() === 1 } : {}),
    };
    const extent = await main.evaluate(root => {
      const rising = root.querySelector('.yp-rising');
      const header = root.querySelector('.hub-page > .ph');
      const headerStyle = header ? getComputedStyle(header) : null;
      const stickyInset = headerStyle?.position === 'sticky' ? header.getBoundingClientRect().height + (parseFloat(headerStyle.top) || 0) : 0;
      const contentTop = root.scrollTop + rising.getBoundingClientRect().top - root.getBoundingClientRect().top;
      // Keep the real sticky mode header in place, and put Rising below its measured edge.
      root.scrollTop = Math.max(0, contentTop - stickyInset - 8);
      return { top: root.scrollTop, bottom: contentTop + rising.getBoundingClientRect().height + 24, max: root.scrollHeight - root.clientHeight, height: root.clientHeight, stickyInset };
    });
    const screenshots = [];
    let offset = extent.top;
    for (let i = 0; ; i++) {
      await main.evaluate((root, value) => { root.scrollTop = value; }, offset);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (i === 0) {
        facts.firstCaptureHeading = await main.evaluate(root => {
          const heading = root.querySelector('.yp-rising h3');
          const header = root.querySelector('.hub-page > .ph');
          const rect = heading.getBoundingClientRect(), bounds = root.getBoundingClientRect();
          const stickyBottom = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : bounds.top;
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { top: rect.top, bottom: rect.bottom, stickyBottom, visible: rect.top >= Math.max(bounds.top, stickyBottom) && rect.bottom <= Math.min(bounds.bottom, innerHeight) && !!hit && heading.contains(hit) };
        });
        assertions.headingNotOccluded = facts.firstCaptureHeading.visible;
      }
      const file = `${prefix}-${size}${i ? `-scroll-${String(i).padStart(2, '0')}` : ''}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: true });
      screenshots.push({ file, offset });
      if (offset + extent.height >= extent.bottom || offset >= extent.max) break;
      offset = Math.min(extent.max, offset + Math.floor(extent.height * 0.8));
    }
    await fs.writeFile(path.join(dir, `${prefix}-${size}.txt`), `${scenario === 'live' ? 'LIVE READ-ONLY' : `SYNTHETIC FIXTURE: ${scenario}`}\n${facts.text}\n`);
    results.push({ size, viewport, assertions, ...facts, screenshots, errors, consoleErrors, blockedRequests });
    await context.close();
  }
} finally { await browser.close(); }
const report = { capturedAt: new Date().toISOString(), base, scenario, browser: { version: browserVersion, executablePath: executablePath ?? 'Playwright default' }, nature: scenario === 'live' ? 'Production built App with live read-only collectors.' : 'Production built App and Rising parser with explicitly synthetic Rising data; remaining stats use live local records. Fixture label added only for capture.', manifest: await fetch(`${base}/api/brief10/manifest`).then(r => r.json()), results };
await fs.writeFile(path.join(dir, `${prefix}-assertions.json`), JSON.stringify(report, null, 2) + '\n');
const failed = results.flatMap(result => Object.entries(result.assertions).filter(([, ok]) => !ok).map(([name]) => `${result.size}: ${name}`));
console.log(JSON.stringify({ output: dir, scenario, captures: results.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
