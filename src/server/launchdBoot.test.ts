import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BOOT = path.resolve(__dirname, '../../scripts/launchd/boot.mjs');

/** Runs boot.mjs against a fake relaunch script that records its arguments; resolves with the exit code. */
async function boot(body: string, signal?: NodeJS.Signals) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-boot-'));
  const out = path.join(dir, 'args');
  const fake = path.join(dir, 'relaunch.sh');
  await fs.writeFile(fake, `echo "args:$*" > '${out}'\n${body}\n`);
  // An unused port and no adoption: the real server on 9320 must never be signalled from a test.
  const env = { ...process.env, DECK_CONFIG_DIR: dir, DECK_BOOT_RELAUNCH: fake, DECK_PORT: '1', DECK_BOOT_ADOPT: '0' };
  const p = spawn(process.execPath, [BOOT], { env, stdio: 'ignore' });
  if (signal) {
    for (let i = 0; i < 50; i++) { try { await fs.access(out); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
    p.kill(signal);
  }
  const code = await new Promise<number | null>((resolve) => p.on('close', resolve));
  return { code, args: (await fs.readFile(out, 'utf8')).trim() };
}

describe('scripts/launchd/boot.mjs', () => {
  it('runs the relaunch loop with no old server and exits with its code', async () => {
    expect(await boot('exit 3')).toEqual({ code: 3, args: 'args:' });
  });

  it('passes launchd’s SIGTERM on to the loop', async () => {
    const r = await boot('trap "exit 0" TERM; while :; do sleep 0.1; done', 'SIGTERM');
    expect(r.code).toBe(0);
  });
});
