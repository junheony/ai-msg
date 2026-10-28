import { spawn } from 'node:child_process';
import { scriptInvocation } from './spec';
import type { AuthPty } from './hub';

/**
 * A pty via the OS `script` command (macOS and util-linux), so `claude auth login` sees a terminal and can print a
 * URL and read a pasted code. No extra package. The command is the allowlisted argv from `scriptInvocation`; stdin
 * of this process is that program's keyboard, not a shell.
 */
export function openAuthPty(spec: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }): AuthPty {
  const inv = scriptInvocation(process.platform, spec.bin, spec.args);
  if ('error' in inv) throw new Error(inv.error);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(inv.cmd, inv.argv, { env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') throw new Error('이 호스트에 script 명령이 없어 로그인 창을 열 수 없습니다');
    throw new Error('로그인 창을 열지 못했습니다');
  }
  let exited = false;
  const exitWaiters: Array<(code: number | null) => void> = [];
  const fail = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exitWaiters) cb(code);
  };
  child.on('error', (err) => {
    const spawnErr = (err as { code?: unknown }).code;
    if (child.pid === undefined && spawnErr === 'ENOENT') fail(null);
    else if (child.pid === undefined) fail(null);
  });
  child.on('exit', (code) => fail(code));
  child.stderr?.resume();
  return {
    write(text) {
      if (exited) throw new Error('closed');
      child.stdin?.write(text);
    },
    kill() {
      const pid = child.pid;
      if (!pid || pid <= 1) return;
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    },
    onData(cb) { child.stdout?.setEncoding('utf8'); child.stdout?.on('data', (chunk: string) => cb(chunk)); },
    onExit(cb) { if (exited) cb(null); else exitWaiters.push(cb); },
  };
}
