import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installCrashHandlers } from './crash';

function host() {
  const em = new EventEmitter();
  const log: string[] = [];
  const exits: number[] = [];
  installCrashHandlers(em, { log: (l) => log.push(l), exit: (c) => exits.push(c) });
  return { em, log, exits };
}

describe('installCrashHandlers', () => {
  it('an unhandled rejection is logged on one line and the process goes on', () => {
    const h = host();
    h.em.emit('unhandledRejection', new Error('boom\n    at somewhere (file.ts:1:1)\n    at deeper (file.ts:2:2)'));
    expect(h.exits).toEqual([]);
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain('deck: 처리되지 않은 rejection');
    expect(h.log[0]).toContain('boom');
    expect(h.log[0]).toContain('file.ts:1:1');
    expect(h.log[0]).not.toContain('\n');
  });

  it('a non-Error rejection reason is still readable', () => {
    const h = host();
    h.em.emit('unhandledRejection', { code: 'EPERM' });
    expect(h.log[0]).toContain('EPERM');
  });

  it('an uncaught exception is logged and exits 1 so the relaunch loop restarts the server', () => {
    const h = host();
    h.em.emit('uncaughtException', new Error('fatal'));
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain('deck: 치명 오류');
    expect(h.log[0]).toContain('fatal');
    expect(h.exits).toEqual([1]);
  });
});
