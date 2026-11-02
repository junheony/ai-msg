/** BRIEF10c daily capture: real built App; opt-in synthetic data is visibly labelled. */
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
if (sourceManifest.rising !== 'live') throw new Error('BRIEF10c captures require live Rising data; only daily may be synthetic');
const scenario = sourceManifest.daily === 'live' ? 'live' : sourceManifest.daily === 'SYNTHETIC FIXTURE: success' ? 'success' : sourceManifest.daily === 'SYNTHETIC FIXTURE: error' ? 'error' : null;
if (!scenario) throw new Error('Preview must explicitly declare daily live/fixture mode');
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
const prefix = `brief10c-daily-${scenario}`;
const results = [];
try {
  const payload = await fetch(`${base}/api/hub/status`).then(r => { if (!r.ok) throw new Error(`status HTTP ${r.status}`); return r.json(); });
  const mode = payload.modes.find(item => item.id === 'yapping');
  if (!mode?.daily) throw new Error('Built preview lacks daily collector data');
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
    await main.locator('.yp-daily').waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // The only injected element is a clear fixture label; no application styles or dimensions change.
    if (scenario !== 'live') await page.evaluate(label => {
      const banner = document.createElement('div');
      banner.textContent = `SYNTHETIC DAILY FIXTURE · ${label.toUpperCase()} · 일별 수치는 검증용`;
      banner.setAttribute('data-capture-fixture', label);
      Object.assign(banner.style, { position: 'fixed', bottom: '4px', left: '4px', right: '4px', zIndex: '99999', padding: '7px', background: '#252525', color: '#fff', font: '11px sans-serif', border: '1px solid #999', pointerEvents: 'none' });
      document.body.append(banner);
    }, scenario);
    const facts = await main.evaluate(root => {
      const section = root.querySelector('.yp-daily');
      return {
        text: section.innerText,
        growth: Array.from(root.querySelectorAll('.yp-growth-item')).map(item => ({ metric: item.getAttribute('data-metric'), label: item.querySelector('.yp-label')?.textContent, value: item.querySelector('strong')?.textContent, hint: item.querySelector('p')?.textContent })),
        days: Array.from(section.querySelectorAll('g[data-day]')).map(day => ({ date: day.getAttribute('data-day'), views: day.getAttribute('data-views'), posts: day.getAttribute('data-posts'), followers: day.getAttribute('data-followers') })),
        viewBars: section.querySelectorAll('rect[data-series="views"]').length,
        postBars: section.querySelectorAll('rect[data-series="posts"]').length,
        followerPaths: Array.from(section.querySelectorAll('path[data-series="followers"]')).map(line => line.getAttribute('d')),
        followerPoints: Array.from(section.querySelectorAll('circle[data-series="followers"]')).map(point => ({ date: point.parentElement.getAttribute('data-day'), x: Number(point.getAttribute('cx')) })),
        missingReason: section.querySelector('.yp-empty')?.textContent ?? null,
        overflow: { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, hub: root.scrollWidth, hubClient: root.clientWidth },
      };
    });
    const kstDate = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const end = Date.parse(`${kstDate}T00:00:00Z`);
    const expectedDays = Array.from({ length: 30 }, (_, index) => {
      const date = new Date(end - (29 - index) * 86_400_000).toISOString().slice(0, 10);
      const row = mode.daily.rows.find(item => item.date === date);
      return { date, views: String(row?.views ?? null), posts: String(row?.posts ?? null), followers: String(row?.followers ?? null) };
    });
    const expectedSegments = [];
    let segment = [];
    const expectedPoints = [];
    expectedDays.forEach((day, index) => {
      if (day.followers === 'null') { if (segment.length) expectedSegments.push(segment); segment = []; return; }
      const x = 600 / 30 * (index + .5);
      segment.push(x);
      expectedPoints.push({ date: day.date, x });
    });
    if (segment.length) expectedSegments.push(segment);
    const actualSegments = facts.followerPaths.map(path => Array.from(path.matchAll(/[ML]\s*([\d.]+)/g), match => Number(match[1])));
    const expectedKpis = ['팔로워 변화', '조회수 변화'].map(label => mode.page.kpis.find(item => item.label === label));
    const assertions = {
      noPageErrors: errors.length === 0, noConsoleErrors: consoleErrors.length === 0, noBlockedRequests: blockedRequests.length === 0,
      noHorizontalOverflow: facts.overflow.document <= viewport.width + 1 && facts.overflow.body <= viewport.width + 1 && facts.overflow.hub <= facts.overflow.hubClient + 1,
      serverDeltasRendered: expectedKpis.every(expected => expected && facts.growth.some(actual => actual.label === expected.label && actual.value === expected.value && actual.hint === expected.hint)),
      ...(scenario !== 'error' ? {
        dailySourceSuccessful: mode.sources.some(source => source.name === '/api/metrics/daily' && source.ok),
        thirtyDaySlots: facts.days.length === 30,
        actualDailyData: JSON.stringify(facts.days) === JSON.stringify(expectedDays),
        twoBarSeries: facts.viewBars === expectedDays.filter(day => day.views !== 'null').length && facts.postBars === expectedDays.filter(day => day.posts !== 'null').length,
        followerSegmentsPreserved: JSON.stringify(actualSegments) === JSON.stringify(expectedSegments),
        followerPointsPreserved: JSON.stringify(facts.followerPoints) === JSON.stringify(expectedPoints),
        historyNote: facts.text.includes('팔로워 기록은 14일치'),
      } : {}),
      ...(scenario === 'success' ? {
        nullFollowersPreserved: facts.days.filter(day => day.followers === 'null').length === 16,
        followerGap: facts.followerPaths.length === 1 && (facts.followerPaths[0].match(/[ML]/g) ?? []).length === 14,
        realDeltaValues: facts.growth.length === 2 && facts.growth.every(item => /[+−-]?\d/.test(item.value) && !item.value.includes('데이터 없음')),
        fixtureLabel: await page.locator('[data-capture-fixture="success"]').count() === 1,
      } : {}),
      ...(scenario === 'error' ? {
        explicitTimeout: facts.missingReason === '데이터 없음 · 시간 초과',
        noStaleDailyData: facts.days.length === 0 && facts.followerPaths.length === 0,
        missingDeltaValues: facts.growth.length === 2 && facts.growth.every(item => item.value === '데이터 없음'),
        fixtureLabel: await page.locator('[data-capture-fixture="error"]').count() === 1,
      } : {}),
    };
    const extent = await main.evaluate(root => {
      const growth = root.querySelector('.yp-growth'), daily = root.querySelector('.yp-daily');
      const header = root.querySelector('.hub-page > .ph');
      const headerStyle = header ? getComputedStyle(header) : null;
      const stickyInset = headerStyle?.position === 'sticky' ? header.getBoundingClientRect().height + (parseFloat(headerStyle.top) || 0) : 0;
      const rootTop = root.getBoundingClientRect().top;
      const contentTop = root.scrollTop + growth.getBoundingClientRect().top - rootTop;
      const bottom = root.scrollTop + daily.getBoundingClientRect().bottom - rootTop + 30;
      root.scrollTop = Math.max(0, contentTop - stickyInset - 8);
      const dailyTop = root.scrollTop + daily.getBoundingClientRect().top - root.getBoundingClientRect().top;
      return { top: root.scrollTop, dailyTop: Math.max(0, dailyTop - stickyInset - 8), bottom, max: root.scrollHeight - root.clientHeight, height: root.clientHeight, stickyInset };
    });
    const screenshots = [];
    const visibility = async () => main.evaluate(root => {
      const header = root.querySelector('.hub-page > .ph');
      const bounds = root.getBoundingClientRect();
      const stickyBottom = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : bounds.top;
      const visible = selector => {
        const element = root.querySelector(selector), rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.top >= Math.max(bounds.top, stickyBottom) && rect.bottom <= Math.min(bounds.bottom, innerHeight - 32) && !!hit && element.contains(hit);
      };
      return { growth: visible('.yp-growth-item strong'), dailyHeading: visible('.yp-daily h3') };
    });
    let offset = extent.top;
    for (let i = 0; ; i++) {
      await main.evaluate((root, value) => { root.scrollTop = value; }, offset);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = `${prefix}-${size}${i ? `-scroll-${String(i).padStart(2, '0')}` : ''}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: true });
      screenshots.push({ file, offset, visible: await visibility() });
      if (offset + extent.height >= extent.bottom || offset >= extent.max) break;
      offset = Math.min(extent.max, offset + Math.max(1, Math.floor((extent.height - extent.stickyInset) * 0.8)));
    }
    // Guarantee an unobscured chart heading even when a compact viewport splits the region.
    if (!screenshots.some(shot => shot.visible.dailyHeading)) {
      const offset = Math.min(extent.max, extent.dailyTop);
      await main.evaluate((root, value) => { root.scrollTop = value; }, offset);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = `${prefix}-${size}-chart.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: true });
      screenshots.push({ file, offset, visible: await visibility() });
    }
    assertions.growthNotOccluded = screenshots[0].visible.growth;
    assertions.dailyHeadingNotOccluded = screenshots.some(shot => shot.visible.dailyHeading);
    await fs.writeFile(path.join(dir, `${prefix}-${size}.txt`), `${scenario === 'live' ? 'LIVE READ-ONLY' : `SYNTHETIC FIXTURE: ${scenario}`}\n${facts.growth.map(item => `${item.label}: ${item.value}\n${item.hint}`).join('\n')}\n${facts.text}\n`);
    results.push({ size, viewport, assertions, ...facts, screenshots, errors, consoleErrors, blockedRequests });
    await context.close();
  }
} finally { await browser.close(); }
const report = { capturedAt: new Date().toISOString(), base, scenario, browser: { version: browserVersion, executablePath: executablePath ?? 'Playwright default' }, nature: scenario === 'live' ? 'Production built App with live read-only collectors.' : 'Production built App and daily parser with explicitly synthetic daily data aligned to current KST date; remaining statistics use live read-only collectors. Fixture label added only for capture.', manifest: await fetch(`${base}/api/brief10/manifest`).then(r => r.json()), results };
await fs.writeFile(path.join(dir, `${prefix}-assertions.json`), JSON.stringify(report, null, 2) + '\n');
const failed = results.flatMap(result => Object.entries(result.assertions).filter(([, ok]) => !ok).map(([name]) => `${result.size}: ${name}`));
console.log(JSON.stringify({ output: dir, scenario, captures: results.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
