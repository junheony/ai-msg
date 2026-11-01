#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// 설치된 Playwright만 사용한다. npm 설치·브라우저 다운로드는 실행하지 않는다.
const help = `사용법: node scripts/capture-screens.mjs <URL|HTML파일> [--out shots] [--viewports 390x844,1280x800]
  [--wait-ms 1000] [--selector '#game'] [--playwright-module /절대경로/playwright/index.mjs]
  [--executable /절대경로/chromium]
기본 화면: 390x844,1280x800. 기존 출력은 덮어쓰지 않으므로 매 실행 새 폴더를 사용한다.`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.log(help); return; }
  const input = args.shift();
  const options = { out: 'shots', viewports: '390x844,1280x800', 'wait-ms': '1000' };
  const accepted = new Set(['out', 'viewports', 'wait-ms', 'selector', 'playwright-module', 'executable']);
  while (args.length) {
    const name = args.shift();
    if (!name.startsWith('--') || !accepted.has(name.slice(2)) || !args.length) throw Error(`잘못된 옵션: ${name}`);
    options[name.slice(2)] = args.shift();
  }
  const viewports = options.viewports.split(',').map(value => {
    const match = /^(\d+)x(\d+)$/.exec(value);
    if (!match) throw Error(`잘못된 화면 크기: ${value}`);
    const [width, height] = match.slice(1).map(Number);
    if (width < 1 || height < 1 || width > 8192 || height > 8192) throw Error('화면 크기는 1~8192 범위여야 함');
    return { width, height };
  });
  if (new Set(viewports.map(v => `${v.width}x${v.height}`)).size !== viewports.length) throw Error('중복 화면 크기');
  const waitMs = Number(options['wait-ms']);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw Error('wait-ms는 0~60000 정수여야 함');
  let url;
  if (/^(https?|file):/i.test(input)) url = new URL(input);
  else {
    await fs.access(path.resolve(input));
    url = pathToFileURL(path.resolve(input));
  }
  if (url.username || url.password) throw Error('인증 정보가 포함된 URL은 허용하지 않음');
  let playwright;
  try {
    const modulePath = options['playwright-module'] || process.env.PLAYWRIGHT_MODULE;
    playwright = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
  } catch {
    throw Error('설치된 Playwright를 찾지 못함. --playwright-module로 설치된 index.mjs 경로를 지정하세요. 자동 설치하지 않습니다.');
  }
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw Error('Playwright Chromium 모듈이 아님');
  const out = path.resolve(options.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(out); // 기존 증거와 혼합·덮어쓰기 금지
  const manifest = { capturedAt: new Date().toISOString(), passed: false, shots: [], errors: [] };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(options.executable ? { executablePath: path.resolve(options.executable) } : {}) });
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        const errors = [];
        // URL·오류 본문에 비밀이 섞일 수 있으므로 보고서에는 건수/종류만 남긴다.
        page.on('pageerror', () => errors.push('pageerror'));
        page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error'); });
        page.on('requestfailed', () => errors.push('requestfailed'));
        page.on('response', response => { if (response.status() >= 400) errors.push(`http-${response.status()}`); });
        await page.goto(url.href, { waitUntil: 'load', timeout: 30000 });
        if (options.selector) await page.waitForSelector(options.selector, { state: 'visible', timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(waitMs);
        const filename = `${viewport.width}x${viewport.height}.png`;
        const bytes = await page.screenshot({ path: path.join(out, filename), fullPage: false, animations: 'disabled' });
        manifest.shots.push({ file: filename, ...viewport, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), errors });
        if (errors.length) manifest.errors.push(`${filename}: 브라우저 오류 ${errors.length}개`);
      } finally { await context.close(); }
    }
    manifest.passed = manifest.errors.length === 0 && manifest.shots.length === viewports.length;
  } catch (error) {
    // 실제 오류는 터미널에만 남기고 evidence에 URL/페이지 내용은 보존하지 않는다.
    manifest.errors.push('캡처 실행 실패 (터미널 로그 확인)');
    throw error;
  } finally {
    try { await browser?.close(); }
    finally { await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`); }
  }
  console.log(`캡처 ${manifest.shots.length}개: ${out}; ${manifest.passed ? 'PASS' : 'FAIL'}`);
  if (!manifest.passed) process.exitCode = 1;
}

main().catch(error => { console.error(`캡처 실패: ${error.message}`); process.exitCode = 1; });
