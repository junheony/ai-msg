/** Shoot the hub controls on the isolated controls-demo host with the established CDP/file:// harness, one scene per run. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [stateFile, outDir, only] = process.argv.slice(2);
if (!stateFile) throw new Error('Usage: node scripts/qa/shoot-controls.mjs <state-file> [out-dir] [scene]');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(state.server) || state.server.endsWith(':9377')) throw new Error('Expected an isolated loopback QA server (not the live demo on 9377)');
const harness = path.resolve(process.env.SHOOT_HARNESS ?? path.join(repo, '../tools/shoot.mjs'));
const out = path.resolve(outDir ?? path.join(repo, 'shots-controls'));

// EVAL snippets: click the first button labelled `label` inside `scope` (waiting up to 10 s for the controls feed), type into a React input, wait.
const tap = (scope, label) => `{ const find = () => [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); let b = find(); for (let i = 0; !b && i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); b = find(); } if (!b) return 'missing: ${label}'; b.scrollIntoView({ block: 'center' }); b.click(); }`;
const type = (sel, text) => `{ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing: ${sel}'; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); }`;
const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
const script = (...steps) => `(async () => { ${steps.join(' ')} return 'ok'; })()`;
const click = (scope, label, ms = 1500) => script(tap(scope, label), wait(ms));
const scenes = [
  { tag: '1-overview', modes: 'home' },
  { tag: '2-inbox', modes: 'home', focus: '#hub-inbox' },
  { tag: '3-approve-confirm', modes: 'home', maxh: 1, eval: click('[data-testid="approval-apr-20261102-pr-hub-controls"]', '승인') },
  { tag: '4-composer', modes: 'home', maxh: 1, eval: click('[data-testid="ctl-acts-video"]', '다음 작업') },
  { tag: '5-composer-confirm', modes: 'home', maxh: 1, eval: script(tap('[data-testid="ctl-acts-video"]', '다음 작업'), wait(400),
    type('.ctl-composer input.ctl-input', '영어 자막 만들기'),
    type('.ctl-composer textarea', '지난주 쇼츠 6편의 한국어 자막을 바탕으로 영어 자막(.srt)을 만들어 주세요. 줄당 32자 이내, 단위는 SI 로.'),
    wait(300), tap('.ctl-composer', '다음'), wait(800)) },
  { tag: '6-runs', modes: 'home', focus: '#hub-runs' },
  { tag: '7-report', modes: 'home', maxh: 1, eval: click('[data-testid="run-jobs:20261101-shorts-captions"]', '보고서', 2500) },
  { tag: '8-stop-confirm', modes: 'home', maxh: 1, eval: click('[data-testid="run-jobs:20261102-thumbnail-ab-test"]', '중지') },
  { tag: '9-rerun', modes: 'home', maxh: 1, eval: click('[data-testid="run-jobs:20261101-level-generator"]', '다시 실행') },
  { tag: '10-terminal', modes: 'home', maxh: 1, eval: click('[data-testid="ctl-acts-video"]', '터미널', 2500) },
  { tag: '11-pages', modes: 'video,quant,trading' },
].filter((s) => !only || s.tag.startsWith(only));

let failed = 0;
for (const s of scenes) {
  const result = spawnSync(process.execPath, [harness, out, s.tag], {
    stdio: 'inherit',
    env: { ...process.env, SERVER: state.server, TOKEN_FILE: state.tokenFile, STATUS_JSON: state.statusFile, DIST: state.uiDir,
      MODES: s.modes, SIZES: process.env.SIZES ?? 'desktop,mobile', RDP_PORT: process.env.RDP_PORT ?? '9343',
      SETTLE_MS: process.env.SETTLE_MS ?? '4000', ...(s.focus ? { FOCUS: s.focus } : {}), ...(s.eval ? { EVAL: s.eval } : {}),
      ...(s.maxh ? { MAXH: String(s.maxh) } : {}) },
  });
  if (result.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
