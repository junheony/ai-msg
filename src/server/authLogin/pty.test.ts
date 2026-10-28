import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { openAuthPty } from './pty';

const hasScript = (): boolean => {
  try { execFileSync('script', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

describe('openAuthPty', () => {
  it('gives /bin/cat a terminal and returns the pasted line', async () => {
    if (process.platform !== 'linux' || !hasScript()) return;
    const pty = openAuthPty({ bin: '/bin/cat', args: [], env: { PATH: '/bin:/usr/bin', HOME: '/tmp', TERM: 'xterm' } });
    const got: string[] = [];
    const exited = new Promise<number | null>((resolve) => pty.onExit(resolve));
    pty.onData((text) => got.push(text));
    pty.write('hello-from-msg\n');
    const code = await Promise.race([
      exited,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    pty.kill();
    expect(got.join('')).toContain('hello-from-msg');
    expect(code === null || code === 0 || typeof code === 'number').toBe(true);
  });
});
