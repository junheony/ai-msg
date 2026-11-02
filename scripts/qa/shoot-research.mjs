/**
 * Screenshots of the isolated research host, 1440 and 390 wide, both surfaces.
 * Usage: PLAYWRIGHT=<path to playwright/index.mjs> node scripts/qa/shoot-research.mjs <state-file> [out-dir] [theme]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [stateFile, outDir = 'shots-research', theme = 'dark'] = process.argv.slice(2);
if (!stateFile || !process.env.PLAYWRIGHT) throw new Error('Usage: PLAYWRIGHT=<playwright/index.mjs> node scripts/qa/shoot-research.mjs <state-file> [out-dir] [theme]');
const { chromium } = await import(process.env.PLAYWRIGHT);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(state.server) || state.server.endsWith(':9377')) throw new Error('Expected an isolated loopback QA server (not the live demo on 9377)');
const token = fs.readFileSync(state.tokenFile, 'utf8').trim();
const cookie = createHash('sha256').update(`deck-cookie:${token}`).digest('hex');
fs.mkdirSync(outDir, { recursive: true });
const suffix = theme === 'dark' ? '' : `-${theme}`;

const browser = await chromium.launch();
const problems = [];
for (const [size, width, height, mobile] of [['desktop', 1440, 900, false], ['mobile', 390, 844, true]]) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: theme === 'light' ? 'light' : 'dark' });
  await context.addCookies([{ name: 'deck_session', value: cookie, url: state.server }]);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${size}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${size}: ${e.message}`));
  for (const [name, hub] of [['overview', 'home'], ['research', 'research']]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${state.server}/?hub=${hub}`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="research-lead"], [data-testid="research-empty"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    const out = await page.evaluate(() => {
      const main = document.querySelector('.hub-main');
      return { over: document.documentElement.scrollWidth - window.innerWidth, inner: main ? main.scrollWidth - main.clientWidth : 0, scroller: [...document.querySelectorAll('*')].reduce((n, e) => Math.max(n, e.scrollHeight), 0), serif: document.fonts.check('48px "Hahmlet Variable"', '리서치') };
    });
    console.log(size, name, JSON.stringify(out));
    await page.setViewportSize({ width, height: Math.min(out.scroller + 40, 6000) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${name}-${size}${suffix}.png`) });
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: path.join(outDir, `${name}-${size}-fold${suffix}.png`) });
  }
  await context.close();
}
await browser.close();
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
