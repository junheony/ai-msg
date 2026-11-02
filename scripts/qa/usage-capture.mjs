import fs from 'node:fs';
import path from 'node:path';

/** Uses the terminal driver's isolated CDP bridge; no additional network/client. */
export async function captureUsage({ send, evaluate, nav, sleep, selectedUrl, outDir, tag, state, errors, sizes, selectedSizes, settle }) {
  const manifest = { tag, fixture: state.usageFixture, clock: state.usageClock, provenance: 'Synthetic visual comparison only; does not prove live quota or refresh.', views: {}, errors };
  const shot = async (name, clip) => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    if (!result.result?.data) throw new Error('Missing screenshot: ' + name);
    fs.writeFileSync(path.join(outDir, `${tag}-${name}.png`), Buffer.from(result.result.data, 'base64'));
  };
  for (const theme of (process.env.THEMES || 'dark,light').split(',')) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const sizeName of selectedSizes) {
      const size = sizes[sizeName];
      if (!size) throw new Error('Unknown viewport: ' + sizeName);
      await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });
      await nav(selectedUrl); await sleep(settle);
      await evaluate('localStorage.clear(); true');
      await nav(selectedUrl); await sleep(settle);
      await evaluate('document.fonts.ready.then(() => true)');
      const route = await evaluate(`(async () => {
        const visible=e=>{const r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1;};
        const strip=document.querySelector('button.usage-strip');
        if(visible(strip)){strip.click();return 'popover';}
        document.querySelector('button.menu[aria-label="메뉴"]')?.click();
        await new Promise(r=>setTimeout(r,150));
        document.querySelector('button.sidebar-avatar')?.click();
        await new Promise(r=>setTimeout(r,150));
        [...document.querySelectorAll('.foot-menu [role="menuitem"]')].find(e=>/사용량 보기/.test(e.textContent))?.click();
        return 'sheet';
      })()`);
      await sleep(400);
      const capturePanel = async (panelName) => {
        const selector = panelName === 'popover' ? '.usage-strip-pop' : '.usage-sheet';
        const geometry = await evaluate(`(() => {
          const panel=document.querySelector(${JSON.stringify(selector)});
          if(!panel)return null;
          const r=panel.getBoundingClientRect();
          return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
            panelInside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
            panelHorizontalOverflow:panel.scrollWidth>panel.clientWidth+1,
            overflowContainers:[panel,...panel.querySelectorAll('*')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1&&/auto|scroll/.test(getComputedStyle(e).overflowX)).map(e=>({class:e.className,width:e.clientWidth,scrollWidth:e.scrollWidth})),
            rows:[...panel.querySelectorAll('[data-testid]')].filter(e=>/^(pop|account)-(a|b|c|gpt|g1|g2|x1)$/.test(e.dataset.testid)).map(e=>{const q=e.getBoundingClientRect();return {id:e.dataset.testid,text:e.textContent,barCount:e.querySelectorAll('.usage-bar,.usage-seg-bar').length,x:q.x,width:q.width,insideX:q.left>=r.left-1&&q.right<=r.right+1,horizontalOverflow:e.scrollWidth>e.clientWidth+1};}),
            externalImages:[...panel.querySelectorAll('img,image')].filter(e=>/^https?:/.test(e.getAttribute('src')||e.getAttribute('href')||'')).length,
            loginButtons:[...panel.querySelectorAll('button')].filter(e=>e.textContent.trim()==='로그인').length};
        })()`);
        const key = `${theme}-${sizeName}-${panelName}`;
        manifest.views[key] = geometry;
        if (!geometry) { errors.push({ kind: 'missing-usage-panel', key }); return; }
        await shot(key);
        const x = Math.max(0, Math.floor(geometry.x)), y = Math.max(0, Math.floor(geometry.y));
        const width = Math.min(size.width - x, Math.ceil(geometry.width)), height = Math.min(size.height - y, Math.ceil(geometry.height));
        if (width > 0 && height > 0) await shot(key + '-crop', { x, y, width, height });
        // Capture lower content when the original UI requires scrolling; do not resize its panel.
        await evaluate(`(() => {const panel=document.querySelector(${JSON.stringify(selector)});for(const e of [panel,...panel.querySelectorAll('*')]){if(e.scrollHeight>e.clientHeight+2&&/auto|scroll/.test(getComputedStyle(e).overflowY))e.scrollTop=e.scrollHeight;}return true;})()`);
        await sleep(100); await shot(key + '-bottom');
        geometry.lastRowAfterScroll = await evaluate(`(() => {const p=document.querySelector(${JSON.stringify(selector)}),e=p.querySelector('[data-testid="pop-x1"],[data-testid="account-x1"]');if(!e)return null;const r=e.getBoundingClientRect(),q=p.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,visible:r.top>=Math.max(0,q.top)-1&&r.bottom<=Math.min(innerHeight,q.bottom)+1&&r.left>=q.left-1&&r.right<=q.right+1};})()`);
        geometry.contentPassed = !geometry.panelHorizontalOverflow && geometry.overflowContainers.length===0 && geometry.rows.length===7 && geometry.rows.every(row=>row.insideX&&!row.horizontalOverflow) && geometry.lastRowAfterScroll?.visible === true;
      };
      await capturePanel(route);
      if (route === 'popover') {
        await evaluate(`document.querySelector('.usage-strip-more')?.click();true`);
        await sleep(400); await capturePanel('sheet');
      }
    }
  }
  manifest.strictContentChecks = process.env.USAGE_CHECKS === '1' || !tag.includes('before');
  manifest.passed = errors.length === 0 && Object.values(manifest.views).every(v=>v && !v.horizontalOverflow && v.panelInside && v.externalImages===0 && (!manifest.strictContentChecks || v.contentPassed));
  if (!manifest.passed) errors.push({ kind: 'usage-geometry-or-panel-check' });
  fs.writeFileSync(path.join(outDir, `${tag}-inspection.json`), JSON.stringify(manifest, null, 2) + '\n');
}
