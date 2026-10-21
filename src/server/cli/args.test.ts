import { describe, expect, it } from 'vitest';
import { parseCli } from './args';

describe('parseCli', () => {
  it('parses the commands', () => {
    expect(parseCli([])).toEqual({ kind: 'start' });
    expect(parseCli(['start'])).toEqual({ kind: 'start' });
    expect(parseCli(['start', '--port', '9400'])).toEqual({ kind: 'start', port: 9400 });
    expect(parseCli(['--port=9401'])).toEqual({ kind: 'start', port: 9401 });
    expect(parseCli(['doctor'])).toEqual({ kind: 'doctor', json: false });
    expect(parseCli(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true });
    expect(parseCli(['service', 'install', '--dry-run'])).toMatchObject({ kind: 'service', action: 'install', dryRun: true, yes: false });
    expect(parseCli(['service', 'install', '--yes', '--node', '/usr/bin/node', '--port', '9400', '--drain-max-min', '10'])).toEqual({ kind: 'service', action: 'install', dryRun: false, yes: true, node: '/usr/bin/node', port: 9400, drainMaxMin: 10 });
    expect(parseCli(['service', 'restart'])).toMatchObject({ kind: 'service', action: 'restart' });
    expect(parseCli(['login-url'])).toEqual({ kind: 'login-url' });
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
    expect(parseCli(['-v'])).toEqual({ kind: 'version' });
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['help'])).toEqual({ kind: 'help' });
  });

  it('rejects junk', () => {
    expect(parseCli(['start', '--port', 'x']).kind).toBe('error');
    expect(parseCli(['start', '--port']).kind).toBe('error');
    expect(parseCli(['start', '--port', '70000']).kind).toBe('error');
    expect(parseCli(['service', 'install', '--drain-max-min', '29']).kind).toBe('error');
    expect(parseCli(['service', 'install', '--drain-max-min', '0']).kind).toBe('error');
    expect(parseCli(['service']).kind).toBe('error');
    expect(parseCli(['service', 'bogus']).kind).toBe('error');
    expect(parseCli(['doctor', '--yes']).kind).toBe('error');
    expect(parseCli(['bogus']).kind).toBe('error');
  });
});
