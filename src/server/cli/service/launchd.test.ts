import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { launchAgentPlist, parseLaunchctlPid } from './launchd';
import { LAUNCHD_LABEL, MANAGED_MARKER, type ServiceRecord } from './record';

const rec = (o: Partial<ServiceRecord> = {}): ServiceRecord => ({ version: 1, platform: 'darwin', node: '/usr/bin/node', bin: '/opt/q dir/bin.js', configDir: '/h/.config/deck', port: 9320, drainMaxMin: 25, env: { HOME: '/h' }, installedAt: 't', packageVersion: '0.1.0', ...o });

describe('launchAgentPlist', () => {
  it('plist: marker, AbandonProcessGroup false, ExitTimeOut, escaped env, verifies with plutil when available', () => {
    const p = launchAgentPlist(rec({ platform: 'darwin', env: { HOME: '/h', ODD: 'a<b>&"c\'' } }), { label: LAUNCHD_LABEL, logFile: '/h/.config/deck/ai-msg.log' });
    expect(p.split('\n')[1]).toContain(MANAGED_MARKER);
    expect(p).toContain('<key>AbandonProcessGroup</key><false/>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('<key>ExitTimeOut</key><integer>1620</integer>');
    expect(p).toContain('<key>ODD</key><string>a&lt;b&gt;&amp;&quot;c&apos;</string>');
    expect(p).toContain('<key>DECK_SUPERVISOR</key><string>launchd</string>');
    expect(p).toContain('<string>/opt/q dir/bin.js</string>');
    expect(p).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(p).toContain('<key>StandardErrorPath</key><string>/h/.config/deck/ai-msg.log</string>');
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/plutil')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plist-'));
    try {
      const f = path.join(dir, 'x.plist');
      fs.writeFileSync(f, p);
      execFileSync('/usr/bin/plutil', ['-lint', f], { stdio: 'pipe' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parseLaunchctlPid reads the pid line only', () => {
    expect(parseLaunchctlPid('gui/501/x = {\n\tstate = running\n\tpid = 4242\n}')).toBe(4242);
    expect(parseLaunchctlPid('gui/501/x = {\n\tstate = not running\n}')).toBeNull();
  });
});
