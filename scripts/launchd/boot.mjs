// launchd entry point for com.deck.server. install-launchd.sh copies it to ~/.config/deck/boot.mjs.
//
// Why node and not bash: macOS (TCC) judges a launchd job's access to ~/Documents by the job's own program, and its
// children inherit that verdict. Full Disk Access granted to node therefore covers everything below — the relaunch
// loop (sh), run.sh (bash) and the server — while a job started as /bin/bash would need Full Disk Access for bash
// itself (exit 126, 2026-10-07 … 10-12).
//
// It runs the relaunch loop (~/.config/deck/relaunch.sh, which never gives up) and stays its parent. A deck server
// already listening on the port (one started by hand before this agent was installed) is handed to the loop as the
// old server: it drains, then the loop starts the new one — so installing never cuts a running turn.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const conf = process.env.DECK_CONFIG_DIR || join(homedir(), '.config', 'deck');
const relaunch = process.env.DECK_BOOT_RELAUNCH || join(conf, 'relaunch.sh');

function envPort() {
  if (process.env.DECK_PORT) return process.env.DECK_PORT;
  try {
    const m = readFileSync(join(conf, 'env'), 'utf8').match(/^\s*DECK_PORT=["']?(\d+)/m);
    if (m) return m[1];
  } catch { /* no env file: default port */ }
  return '9320';
}

// The pid of a deck server listening on the port, or '' (nothing there, or something that is not deck).
function oldServer(port) {
  try {
    const pid = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (!pid) return '';
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
    return cmd.includes('src/server/main.ts') ? pid : '';
  } catch { return ''; }
}

const old = process.env.DECK_BOOT_ADOPT === '0' ? '' : oldServer(envPort());
const child = spawn('/bin/sh', old ? [relaunch, old] : [relaunch], { stdio: 'inherit' });
// launchd stops the job with SIGTERM: pass it on so the loop ends (the server it started keeps running).
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
child.on('error', (e) => { console.error(`deck: boot — relaunch 실행 실패: ${e.message}`); process.exit(1); });
