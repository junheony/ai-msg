import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANAGED_MARKER, stopTimeoutSec, systemdQuote, type ServiceRecord } from './record';
import { systemdUnit } from './systemd';

const rec = (o: Partial<ServiceRecord> = {}): ServiceRecord => ({ version: 1, platform: 'linux', node: '/usr/bin/node', bin: '/opt/q dir/bin.js', configDir: '/h/.config/deck', port: 9320, drainMaxMin: 25, env: { PATH: '/h/.local/bin:/usr/bin', HOME: '/h' }, installedAt: 't', packageVersion: '0.1.0', ...o });

const has = (cmd: string) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

describe('systemdUnit', () => {
  it('unit: marker, ExecStart, EnvironmentFile without -, KillMode=mixed, stop timeout = drain + 2 min', () => {
    const u = systemdUnit(rec(), '/h/.config/deck/service.env');
    expect(u.split('\n')[0]).toContain(MANAGED_MARKER);
    expect(u).toContain('ExecStart=/usr/bin/node "/opt/q dir/bin.js" start');
    expect(u).toContain('EnvironmentFile=/h/.config/deck/service.env');
    expect(u).not.toContain('EnvironmentFile=-');
    expect(u).toContain('KillMode=mixed');
    expect(u).toContain('TimeoutStopSec=1620');
    expect(u).toContain('Environment=DECK_SUPERVISOR=systemd');
    expect(u).toContain('Restart=always');
    expect(u).toContain('RestartPreventExitStatus=78');
    expect(u).toContain('WantedBy=default.target');
  });

  it('stop timeout never exceeds 30 minutes', () => {
    expect(stopTimeoutSec(rec({ drainMaxMin: 28 }))).toBeLessThanOrEqual(1800);
    expect(stopTimeoutSec(rec({ drainMaxMin: 1 }))).toBe(180);
  });

  it('systemdQuote: specifiers, variables, quotes and backslashes', () => {
    expect(systemdQuote('/usr/bin/node')).toBe('/usr/bin/node');
    expect(systemdQuote('/a b/100%/$x')).toBe('"/a b/100%%/$$x"');
    expect(systemdQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(systemdQuote('a $b `c` "d" \\e', 'envFile')).toBe('"a \\$b \\`c\\` \\"d\\" \\\\e"');
  });

  it('unit verifies with systemd-analyze when available', () => {
    if (process.platform !== 'linux' || !has('systemd-analyze')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-unit-'));
    try {
      const envFile = path.join(dir, 'service.env');
      fs.writeFileSync(envFile, 'PATH=/usr/bin\n');
      const unit = path.join(dir, 'quarterdeck.service');
      fs.writeFileSync(unit, systemdUnit(rec({ node: process.execPath, bin: process.execPath, env: { HOME: dir } }), envFile));
      execFileSync('systemd-analyze', ['verify', '--user', unit], { stdio: 'pipe' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
