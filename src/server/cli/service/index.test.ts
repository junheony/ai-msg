import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliCommand } from '../args';
import { serviceAction, type RunResult, type ServiceDeps } from './index';
import { LAUNCHD_LABEL, MANAGED_MARKER } from './record';

type Svc = Extract<CliCommand, { kind: 'service' }>;
const install: Svc = { kind: 'service', action: 'install', dryRun: false, yes: true };
const uninstall: Svc = { kind: 'service', action: 'uninstall', dryRun: false, yes: true };

type Handler = number | Partial<RunResult> | ((args: string[]) => number | Partial<RunResult>);
/** A fake runner: every call is recorded; the answer is looked up by `cmd args…` (longest matching prefix), default exit 0. */
function recordRun(table: Record<string, Handler> = {}) {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = [];
  const run = Object.assign(async (cmd: string, args: string[], o?: { timeoutMs?: number }): Promise<RunResult> => {
    calls.push({ cmd, args, ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) });
    const line = [cmd, ...args].join(' ');
    const key = Object.keys(table).filter((k) => line === k || line.startsWith(`${k} `)).sort((a, b) => b.length - a.length)[0];
    let h: Handler = key === undefined ? 0 : table[key]!;
    if (typeof h === 'function') h = h(args);
    const r = typeof h === 'number' ? { code: h } : h;
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }, { calls, lines: () => calls.map((c) => [c.cmd, ...c.args].join(' ')) });
  return run;
}

let root: string;
let home: string;
let configDir: string;
let out: string[];
let err: string[];
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-svc-')));
  home = path.join(root, 'home');
  configDir = path.join(home, '.config', 'deck');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'sessions.json'), '{}');
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const unitFile = () => path.join(home, '.config', 'systemd', 'user', 'quarterdeck.service');
const plistFile = (label = LAUNCHD_LABEL) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
const writeLock = (pid: number, port: number, supervisor: string | null) =>
  fs.writeFileSync(path.join(configDir, 'server.lock'), JSON.stringify({ pid, port, addresses: [], version: '0.1.0', configDir, startedAt: '', supervisor }));

function deps(o: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    platform: 'linux', home, env: { PATH: '/usr/bin', HOME: home }, configDir, execPath: '/usr/bin/node', bin: '/g/lib/node_modules/q/dist/server/bin.js',
    uid: 501, port: 9400, isTTY: false, ask: async () => false, run: recordRun(), portBusy: async () => false, httpProbe: async () => 401,
    out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {}, realpath: (p) => p, exists: fs.existsSync,
    isAlive: (pid) => pid === 4242 || pid === 777, commandOf: () => '/bin/sh /x/relaunch.sh', packageVersion: () => '0.1.0', verifyMs: 2000,
    ...o,
  };
}

/** systemd answers for a service that comes up as pid 4242 on port 9400 once enabled/restarted. */
const systemdUp = (extra: Record<string, Handler> = {}) => recordRun({
  'systemctl --user enable --now': () => { writeLock(4242, 9400, 'systemd'); return 0; },
  'systemctl --user restart': () => { writeLock(4242, 9400, 'systemd'); return 0; },
  'systemctl --user show -p MainPID': { stdout: '4242\n' },
  ...extra,
});

describe('serviceAction (linux)', () => {
  it('linux install: record + unit written, daemon-reload, enable --now, then verified against the lock', async () => {
    const run = systemdUp();
    expect(await serviceAction(install, deps({ run }))).toBe(0);
    expect(fs.readFileSync(unitFile(), 'utf8').split('\n')[0]).toContain(MANAGED_MARKER);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'service.json'), 'utf8'))).toMatchObject({ port: 9400, node: '/usr/bin/node', drainMaxMin: 25 });
    expect(fs.existsSync(path.join(configDir, 'service.env'))).toBe(true);
    expect(run.lines()).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now quarterdeck.service',
      'systemctl --user show -p MainPID --value quarterdeck.service',
    ]);
    expect(out.join('\n')).toContain('loginctl enable-linger');
  });

  it('linux install rolls back when enable fails', async () => {
    const run = recordRun({ 'systemctl --user enable --now': { code: 1, stderr: 'Failed to enable unit: boom\nmore' } });
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.env'))).toBe(false);
    expect(run.lines().filter((l) => l === 'systemctl --user daemon-reload')).toHaveLength(2);
    expect(err.join('\n')).toContain('Failed to enable unit: boom');
    expect(err.join('\n')).not.toContain('more');
  });

  it('linux install rolls back when the service does not come up with the recorded port', async () => {
    const run = recordRun({ 'systemctl --user show -p MainPID': { stdout: '4242\n' } });
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(run.lines()).toContain('systemctl --user disable --now --no-block quarterdeck.service');
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    expect(err.join('\n')).toContain('journalctl');
    // A lock on another port, or a pid that is not the unit's main pid, is not "up" either.
    const run2 = recordRun({ 'systemctl --user enable --now': () => { writeLock(4242, 9999, 'systemd'); return 0; }, 'systemctl --user show -p MainPID': { stdout: '4242\n' } });
    fs.rmSync(path.join(configDir, 'server.lock'), { force: true });
    expect(await serviceAction(install, deps({ run: run2 }))).toBe(1);
  });

  it('reinstall of our own unit restores the previous unit on failure', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    const old = `# ${MANAGED_MARKER} (old)\n[Service]\nExecStart=/old\n`;
    fs.writeFileSync(unitFile(), old);
    fs.writeFileSync(path.join(configDir, 'service.json'), '{"old":true}');
    const run = recordRun({ 'systemctl --user restart': { code: 1 } });
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(fs.readFileSync(unitFile(), 'utf8')).toBe(old);
    expect(fs.readFileSync(path.join(configDir, 'service.json'), 'utf8')).toBe('{"old":true}');
    expect(fs.existsSync(path.join(configDir, 'service.env'))).toBe(false);
    expect(run.lines()).toContain('systemctl --user enable quarterdeck.service');
    expect(run.lines()).not.toContain('systemctl --user disable --now --no-block quarterdeck.service');
  });

  it('reinstall of our own unit: enable + queued restart (drain); verified only once a new pid holds the lock', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), `# ${MANAGED_MARKER}\n`);
    writeLock(4242, 9400, 'systemd');
    // The old server (4242) keeps the lock while it drains; the new one (777) takes over after a few polls.
    let polls = 0;
    const sleep = async () => { if (++polls === 5) writeLock(777, 9400, 'systemd'); };
    const run = recordRun({ 'systemctl --user show -p MainPID': () => ({ stdout: polls >= 5 ? '777\n' : '4242\n' }) });
    expect(await serviceAction(install, deps({ run, sleep, portBusy: async () => true }))).toBe(0);
    expect(run.lines().slice(1, 4)).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable quarterdeck.service', 'systemctl --user restart --no-block quarterdeck.service']);
    expect(polls).toBe(5);
  });

  it('reinstall verify window covers the previous drain cap; a failed verify waits for the queued job before rolling back', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), `# ${MANAGED_MARKER}\n`);
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ version: 1, node: 'n', bin: 'b', port: 9400, drainMaxMin: 1 }));
    writeLock(4242, 9400, 'systemd');
    let slept = 0;
    let states = 0;
    const run = recordRun({
      'systemctl --user show -p MainPID': { stdout: '4242\n' }, // the old server never hands over
      'systemctl --user is-active': () => (++states < 3 ? { stdout: 'deactivating\n' } : { stdout: 'active\n' }),
    });
    expect(await serviceAction(install, deps({ run, portBusy: async () => true, sleep: async (ms) => { slept += ms; } }))).toBe(1);
    // 2 s verifyMs + 180 s (drainMaxMin 1) before giving up, then two polls while the job was still deactivating.
    expect(slept).toBeGreaterThanOrEqual(182_000);
    const lines = run.lines();
    const firstState = lines.indexOf('systemctl --user is-active quarterdeck.service');
    const restore = lines.lastIndexOf('systemctl --user daemon-reload');
    expect(firstState).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(firstState + 2);
    expect(lines.at(-1)).toBe('systemctl --user restart --no-block quarterdeck.service');
  });

  it('a unit without our marker is neither overwritten nor removed', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), '[Service]\nExecStart=/theirs\n');
    const run = recordRun();
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(await serviceAction(uninstall, deps({ run }))).toBe(1);
    expect(fs.readFileSync(unitFile(), 'utf8')).toBe('[Service]\nExecStart=/theirs\n');
    expect(run.lines().some((l) => /enable|disable|daemon-reload/.test(l))).toBe(false);
    expect(err.join('\n')).toContain(unitFile());
  });

  it('--dry-run prints files and commands, writes and runs nothing', async () => {
    const run = recordRun();
    expect(await serviceAction({ ...install, dryRun: true, yes: false }, deps({ run }))).toBe(0);
    expect(run.calls).toHaveLength(0);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    const text = out.join('\n');
    expect(text).toContain(unitFile());
    expect(text).toContain('ExecStart=/usr/bin/node /g/lib/node_modules/q/dist/server/bin.js start');
    expect(text).toContain('systemctl --user enable --now quarterdeck.service');
    expect(text).toContain('node: /usr/bin/node');
  });

  it('non-TTY without --yes refuses; TTY asks', async () => {
    const run = systemdUp();
    expect(await serviceAction({ ...install, yes: false }, deps({ run }))).toBe(1);
    expect(err.join('\n')).toContain('--yes');
    expect(fs.existsSync(unitFile())).toBe(false);
    const asked: string[] = [];
    expect(await serviceAction({ ...install, yes: false }, deps({ run, isTTY: true, ask: async (q) => { asked.push(q); return false; } }))).toBe(1);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(await serviceAction({ ...install, yes: false }, deps({ run, isTTY: true, ask: async () => true }))).toBe(0);
    expect(fs.existsSync(unitFile())).toBe(true);
  });

  it('linux uninstall waits for inactive before deleting, keeps the data dir', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), `# ${MANAGED_MARKER}\n`);
    fs.writeFileSync(path.join(configDir, 'service.json'), '{}');
    fs.writeFileSync(path.join(configDir, 'service.env'), '');
    let polls = 0;
    const run = recordRun({
      'systemctl --user is-active': () => {
        polls++;
        expect(fs.existsSync(unitFile())).toBe(true);
        return polls < 3 ? { stdout: 'deactivating\n' } : { code: 3, stdout: 'inactive\n' };
      },
    });
    expect(await serviceAction(uninstall, deps({ run }))).toBe(0);
    expect(polls).toBe(3);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.env'))).toBe(false);
    expect(fs.readFileSync(path.join(configDir, 'sessions.json'), 'utf8')).toBe('{}');
    expect(run.lines().at(-1)).toBe('systemctl --user daemon-reload');
    expect(out.join('\n')).toContain(configDir);
  });

  it('uninstall does not delete while the service is still active', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), `# ${MANAGED_MARKER}\n`);
    const run = recordRun({ 'systemctl --user is-active': { stdout: 'active\n' }, 'systemctl --user disable': 0 });
    // drainMaxMin 1 → 180 s limit; sleep is a no-op so this ends at once.
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ version: 1, node: 'n', bin: 'b', port: 1, drainMaxMin: 1 }));
    expect(await serviceAction(uninstall, deps({ run }))).toBe(1);
    expect(fs.existsSync(unitFile())).toBe(true);
  });

  it('refuses a bin inside the npx cache, writes nothing', async () => {
    const run = recordRun();
    expect(await serviceAction(install, deps({ run, bin: path.join(home, '.npm', '_npx', 'abc', 'node_modules', 'x', 'dist', 'server', 'bin.js') }))).toBe(1);
    expect(run.calls).toHaveLength(0);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(err.join('\n')).toContain('npm i -g');
  });

  it('refuses a version manager node without --node', async () => {
    const run = recordRun();
    expect(await serviceAction(install, deps({ run, execPath: '/h/.nvm/versions/node/v24.1.0/bin/node' }))).toBe(1);
    expect(run.calls).toHaveLength(0);
  });

  it('refuses when the port is busy or another server holds the config dir', async () => {
    const run = recordRun();
    expect(await serviceAction(install, deps({ run, portBusy: async () => true }))).toBe(1);
    expect(err.join('\n')).toContain('9400');
    writeLock(777, 9320, null);
    err = [];
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(err.join('\n')).toContain('777');
    writeLock(777, 9320, 'relaunch');
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(fs.existsSync(unitFile())).toBe(false);
    expect(run.lines().some((l) => /enable|daemon-reload/.test(l))).toBe(false);
  });

  it('no systemd user session → refused before anything is written', async () => {
    const run = recordRun({ 'systemctl --user show-environment': { code: 1, stderr: 'Failed to connect to bus' } });
    expect(await serviceAction(install, deps({ run }))).toBe(1);
    expect(err.join('\n')).toContain('systemd 사용자 세션');
    expect(fs.existsSync(unitFile())).toBe(false);
  });

  it('previous unit names with our marker are cleaned on install; others are left alone', async () => {
    const dir = path.dirname(unitFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old-q.service'), `# ${MANAGED_MARKER}\n`);
    fs.writeFileSync(path.join(dir, 'other.service'), '[Service]\n');
    const run = systemdUp({ 'systemctl --user is-active': { code: 3, stdout: 'inactive\n' } });
    expect(await serviceAction(install, deps({ run, previousNames: ['old-q', 'other'] }))).toBe(0);
    expect(fs.existsSync(path.join(dir, 'old-q.service'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'other.service'))).toBe(true);
    expect(run.lines()).toContain('systemctl --user disable --now --no-block old-q.service');
    expect(run.lines()).not.toContain('systemctl --user disable --now --no-block other.service');
  });

  it('restart and status', async () => {
    fs.mkdirSync(path.dirname(unitFile()), { recursive: true });
    fs.writeFileSync(unitFile(), `# ${MANAGED_MARKER}\n`);
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({ version: 1, node: '/usr/bin/node', bin: '/b', port: 9400, drainMaxMin: 25 }));
    writeLock(4242, 9400, 'systemd');
    const run = recordRun({ 'systemctl --user is-active': { stdout: 'active\n' } });
    expect(await serviceAction({ ...install, action: 'restart' }, deps({ run }))).toBe(0);
    expect(run.lines()).toContain('systemctl --user restart --no-block quarterdeck.service');
    out = [];
    expect(await serviceAction({ ...install, action: 'status' }, deps({ run, packageVersion: () => '0.2.0' }))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('active');
    expect(text).toContain('4242');
    expect(text).toContain('quarterdeck service restart');
  });
});

describe('serviceAction (darwin)', () => {
  const launchdUp = (o: { loaded?: boolean } = {}) => {
    let loaded = o.loaded ?? false;
    let pid = 4242;
    return recordRun({
      'launchctl print gui/501': 0,
      'launchctl print gui/501/com.deck.server': 113,
      [`launchctl print gui/501/${LAUNCHD_LABEL}`]: () => (loaded ? { code: 0, stdout: `\tstate = running\n\tpid = ${pid}\n` } : 113),
      'launchctl bootout': () => { loaded = false; return 0; },
      // A fresh bootstrap is a new process: 4242 the first time, 777 after a bootout of the running one.
      'launchctl bootstrap': () => { if (o.loaded) pid = 777; loaded = true; writeLock(pid, 9400, 'launchd'); return 0; },
    });
  };

  it('darwin: com.deck.server loaded, or its plist exists, or a relaunch loop lives → refuse, nothing written', async () => {
    const run = recordRun({ 'launchctl print gui/501': 0, 'launchctl print gui/501/com.deck.server': 0 });
    expect(await serviceAction(install, deps({ platform: 'darwin', run }))).toBe(1);
    expect(fs.existsSync(plistFile())).toBe(false);
    expect(run.calls.some((c) => c.args.includes('bootstrap'))).toBe(false);
    expect(err.join('\n')).toContain('com.deck.server');

    const run2 = launchdUp();
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile('com.deck.server'), '<plist/>');
    expect(await serviceAction(install, deps({ platform: 'darwin', run: run2 }))).toBe(1);
    expect(fs.existsSync(plistFile())).toBe(false);
    fs.rmSync(plistFile('com.deck.server'));

    fs.writeFileSync(path.join(configDir, 'relaunch.pid'), '777\n');
    expect(await serviceAction(install, deps({ platform: 'darwin', run: run2 }))).toBe(1);
    expect(fs.existsSync(plistFile())).toBe(false);
    expect(run2.calls.some((c) => c.args.includes('bootstrap'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
  });

  it('darwin: no GUI domain (SSH) → refuse with the hint', async () => {
    const run = recordRun({ 'launchctl print gui/501': 113 });
    expect(await serviceAction(install, deps({ platform: 'darwin', run }))).toBe(1);
    expect(err.join('\n')).toContain('SSH');
    expect(fs.existsSync(plistFile())).toBe(false);
  });

  it('darwin install writes an escaped plist and bootstraps it, verified by pid', async () => {
    const run = launchdUp();
    const env = { PATH: '/usr/bin', HOME: home, DECK_EXTRA_HOSTS: 'a&b<c>' };
    expect(await serviceAction(install, deps({ platform: 'darwin', run, env }))).toBe(0);
    const p = fs.readFileSync(plistFile(), 'utf8');
    expect(p).toContain('<string>a&amp;b&lt;c&gt;</string>');
    expect(p).toContain('<key>DECK_SUPERVISOR</key><string>launchd</string>');
    expect(run.lines()).toContain(`launchctl bootstrap gui/501 ${plistFile()}`);
    expect(run.lines()).not.toContain(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    expect(out.join('\n')).toContain('전체 디스크');
  });

  it('darwin reinstall boots out our label before bootstrap', async () => {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile(), `<?xml version="1.0"?>\n<!-- ${MANAGED_MARKER} -->\n`);
    writeLock(4242, 9400, 'launchd');
    const run = launchdUp({ loaded: true });
    expect(await serviceAction(install, deps({ platform: 'darwin', run }))).toBe(0);
    const lines = run.lines();
    const out_ = lines.indexOf(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    const boot = lines.indexOf(`launchctl bootstrap gui/501 ${plistFile()}`);
    expect(out_).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(out_);
    // bootout may block for the whole drain: its timeout is the stop cap + 1 min, not the 60 s default.
    expect(run.calls.find((c) => c.args[0] === 'bootout')?.timeoutMs).toBe((1800 + 60) * 1000);
  });

  it('darwin restart: SIGTERM to the lock holder (drain, KeepAlive restarts), never kickstart -k on a live server', async () => {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile(), `<?xml version="1.0"?>\n<!-- ${MANAGED_MARKER} -->\n`);
    writeLock(4242, 9400, 'launchd');
    const kills: string[] = [];
    const run = launchdUp({ loaded: true });
    const restart: Svc = { ...install, action: 'restart' };
    expect(await serviceAction(restart, deps({ platform: 'darwin', run, kill: (p, s) => { kills.push(`${p}:${s}`); } }))).toBe(0);
    expect(kills).toEqual(['4242:SIGTERM']);
    expect(run.lines().some((l) => l.includes('kickstart'))).toBe(false);
    // Loaded but not running (e.g. waiting out a fatal start): kickstart without -k.
    fs.rmSync(path.join(configDir, 'server.lock'));
    const idle = recordRun({ 'launchctl print gui/501': 0, [`launchctl print gui/501/${LAUNCHD_LABEL}`]: { stdout: 'state = waiting\n' } });
    expect(await serviceAction(restart, deps({ platform: 'darwin', run: idle, kill: (p, s) => { kills.push(`${p}:${s}`); } }))).toBe(0);
    expect(idle.lines()).toContain(`launchctl kickstart gui/501/${LAUNCHD_LABEL}`);
    expect(kills).toHaveLength(1);
  });

  it('darwin uninstall without a plist still boots out our loaded label (and only ours)', async () => {
    const run = launchdUp({ loaded: true });
    expect(await serviceAction(uninstall, deps({ platform: 'darwin', run }))).toBe(0);
    expect(run.lines()).toContain(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    expect(run.lines().filter((l) => l.startsWith('launchctl bootout'))).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(out.join('\n')).toContain(LAUNCHD_LABEL);
    // Nothing loaded: nothing booted out.
    const idle = recordRun({ 'launchctl print gui/501': 0, [`launchctl print gui/501/${LAUNCHD_LABEL}`]: 113 });
    expect(await serviceAction(uninstall, deps({ platform: 'darwin', run: idle }))).toBe(0);
    expect(idle.lines().some((l) => l.includes('bootout'))).toBe(false);
  });

  it('darwin install rolls back (bootout, files removed) when the job does not come up', async () => {
    let loaded = false;
    const run = recordRun({
      'launchctl print gui/501': 0,
      'launchctl print gui/501/com.deck.server': 113,
      [`launchctl print gui/501/${LAUNCHD_LABEL}`]: () => (loaded ? { code: 0, stdout: 'state = waiting\n' } : 113),
      'launchctl bootstrap': () => { loaded = true; return 0; },
      'launchctl bootout': () => { loaded = false; return 0; },
    });
    expect(await serviceAction(install, deps({ platform: 'darwin', run }))).toBe(1);
    expect(run.lines()).toContain(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    expect(fs.existsSync(plistFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    expect(err.join('\n')).toContain('quarterdeck.log');
  });

  it('previous labels with our marker are cleaned on install', async () => {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile('old.label'), `<?xml version="1.0"?>\n<!-- ${MANAGED_MARKER} -->\n`);
    let oldLoaded = true;
    const base = launchdUp();
    const run = Object.assign(async (cmd: string, args: string[]) => {
      if (args.join(' ') === 'print gui/501/old.label') { base.calls.push({ cmd, args }); return { code: oldLoaded ? 0 : 113, stdout: '', stderr: '' }; }
      if (args.join(' ') === 'bootout gui/501/old.label') { base.calls.push({ cmd, args }); oldLoaded = false; return { code: 0, stdout: '', stderr: '' }; }
      return base(cmd, args);
    }, { calls: base.calls });
    expect(await serviceAction(install, deps({ platform: 'darwin', run, previousNames: ['old.label'] }))).toBe(0);
    expect(fs.existsSync(plistFile('old.label'))).toBe(false);
    expect(base.lines()).toContain('launchctl bootout gui/501/old.label');
  });

  it('darwin uninstall: bootout, wait until unloaded, delete plist and record only', async () => {
    fs.mkdirSync(path.dirname(plistFile()), { recursive: true });
    fs.writeFileSync(plistFile(), `<?xml version="1.0"?>\n<!-- ${MANAGED_MARKER} -->\n`);
    fs.writeFileSync(path.join(configDir, 'service.json'), '{}');
    const run = launchdUp({ loaded: true });
    expect(await serviceAction(uninstall, deps({ platform: 'darwin', run }))).toBe(0);
    expect(fs.existsSync(plistFile())).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'service.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'sessions.json'))).toBe(true);
  });
});

it('win32 is not supported yet', async () => {
  const run = recordRun();
  expect(await serviceAction(install, deps({ platform: 'win32', run }))).toBe(1);
  expect(run.calls).toHaveLength(0);
});
