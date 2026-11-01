/** Reuse the established CDP/file:// screenshot harness against the isolated lab host. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [stateFile, outDir, tag = 'lab'] = process.argv.slice(2);
if (!stateFile) throw new Error('Usage: node scripts/qa/shoot-lab.mjs <state-file> [out-dir] [tag]');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (state.server !== 'http://127.0.0.1:9378') throw new Error('Expected isolated QA server on port 9378');
const harness = path.resolve(process.env.SHOOT_HARNESS ?? path.join(repo, '../tools/shoot.mjs'));
const result = spawnSync(process.execPath, [harness, path.resolve(outDir ?? path.join(repo, 'shots-lab')), tag], {
  stdio: 'inherit',
  env: { ...process.env, SERVER: state.server, TOKEN_FILE: state.tokenFile, STATUS_JSON: state.statusFile,
    DIST: state.uiDir, MODES: 'trading', SIZES: 'desktop,mobile', RDP_PORT: process.env.RDP_PORT ?? '9341',
    SETTLE_MS: process.env.SETTLE_MS ?? '10000' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
