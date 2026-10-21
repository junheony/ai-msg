import fs from 'node:fs';
import path from 'node:path';
import { commandOfPid, pidAlive, readInstanceLock } from '../../instanceLock';
import { RELAUNCH_LOOP_RE } from '../../serverUpdate';
import { SERVICE_TEXTS as T } from '../../setup/texts';
import type { CliCommand } from '../args';
import { launchAgentPlist, parseLaunchctlPid } from './launchd';
import { stableNodePath } from './nodePath';
import {
  LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL, MANAGED_MARKER, PREVIOUS_LAUNCHD_LABELS, PREVIOUS_UNIT_NAMES, SERVICE_NAME,
  buildServiceRecord, envFile, readServiceRecord, recordFile, serviceEnvText, stopTimeoutSec, type ServiceRecord,
} from './record';
import { systemdUnit } from './systemd';

export type RunResult = { code: number; stdout: string; stderr: string };
type CliBins = Partial<Record<'DECK_CLAUDE_BIN' | 'DECK_CODEX_BIN' | 'DECK_GEMINI_BIN' | 'DECK_GROK_BIN', string>>;

export type ServiceDeps = {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  configDir: string;
  execPath: string;
  /** The real path of the running `bin.js`. */
  bin: string;
  uid: number;
  /** Port when `--port` is not given. */
  port: number;
  isTTY: boolean;
  ask: (q: string) => Promise<boolean>;
  /** launchctl / systemctl (no shell). Every exit code is checked. */
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  portBusy: (port: number) => Promise<boolean>;
  /** GET /api/me status on 127.0.0.1, null = no answer. */
  httpProbe: (port: number) => Promise<number | null>;
  out: (s: string) => void;
  err: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  nodeVersion?: (bin: string) => Promise<string | null>;
  isAlive?: (pid: number) => boolean;
  commandOf?: (pid: number) => string | null;
  /** CLI paths `loadConfig` finds now (recorded so the service sees the same CLIs). */
  cliBins?: () => CliBins;
  /** The package version on disk. */
  packageVersion?: () => string;
  previousNames?: string[];
  /** How long the post-install check waits (default 30 s). */
  verifyMs?: number;
  now?: () => Date;
};

type Cmd = string[];
const POLL_MS = 500;
const show = (c: Cmd) => c.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
const hasMarker = (text: string) => text.split('\n').slice(0, 3).some((l) => l.includes(MANAGED_MARKER));
const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

/** What differs between systemd and launchd; the flow around it is shared. */
type Manager = {
  kind: 'systemd' | 'launchd';
  fileOf: (name: string) => string;
  current: string;
  previous: string[];
  logFile: string;
  render: (r: ServiceRecord) => string;
  /** Run-based checks before anything is written (skipped on --dry-run): an error line or null. */
  preflight: () => Promise<string | null>;
  /** darwin: this Mac's repo-run service; never touched, refuses. */
  legacy: (dryRun: boolean) => Promise<string | null>;
  loaded: (name: string) => Promise<boolean>;
  /** Commands that bring the freshly written file up (`reinstall`: ours was there before). */
  upSteps: (reinstall: boolean) => Cmd[];
  /** Waited for after `bootout` before `bootstrap` (launchd). */
  needsUnloadFirst: boolean;
  downSteps: (name: string) => Cmd[];
  stopped: (name: string) => Promise<boolean>;
  afterRemove: Cmd[];
  restart: Cmd;
  mainPid: () => Promise<number | null>;
  state: () => Promise<string>;
};

function systemdManager(d: ServiceDeps, previous: string[]): Manager {
  const xdg = d.env.XDG_CONFIG_HOME;
  const dir = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(d.home, '.config'), 'systemd', 'user');
  const unit = (n: string) => `${n}.service`;
  const sc = (...a: string[]): Cmd => ['systemctl', '--user', ...a];
  return {
    kind: 'systemd',
    fileOf: (n) => path.join(dir, unit(n)),
    current: SERVICE_NAME,
    previous,
    logFile: `journalctl --user -u ${unit(SERVICE_NAME)}`,
    render: (r) => systemdUnit(r, envFile(r.configDir)),
    preflight: async () => ((await d.run('systemctl', ['--user', 'show-environment'])).code === 0 ? null : T.noUserBus),
    legacy: async () => null,
    loaded: async () => false,
    upSteps: (reinstall) => [sc('daemon-reload'), ...(reinstall ? [sc('enable', unit(SERVICE_NAME)), sc('restart', unit(SERVICE_NAME))] : [sc('enable', '--now', unit(SERVICE_NAME))])],
    needsUnloadFirst: false,
    downSteps: (n) => [sc('disable', '--now', unit(n))],
    stopped: async (n) => !['active', 'activating', 'deactivating', 'reloading'].includes((await d.run('systemctl', ['--user', 'is-active', unit(n)])).stdout.trim()),
    afterRemove: [sc('daemon-reload')],
    restart: sc('restart', unit(SERVICE_NAME)),
    mainPid: async () => {
      const r = await d.run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit(SERVICE_NAME)]);
      const n = Number(r.stdout.trim());
      return r.code === 0 && Number.isInteger(n) && n > 0 ? n : null;
    },
    state: async () => (await d.run('systemctl', ['--user', 'is-active', unit(SERVICE_NAME)])).stdout.trim() || '?',
  };
}

function launchdManager(d: ServiceDeps, previous: string[]): Manager {
  const dir = path.join(d.home, 'Library', 'LaunchAgents');
  const domain = `gui/${d.uid}`;
  const target = (n: string) => `${domain}/${n}`;
  const fileOf = (n: string) => path.join(dir, `${n}.plist`);
  const isAlive = d.isAlive ?? pidAlive;
  const commandOf = d.commandOf ?? commandOfPid;
  const exists = d.exists ?? fs.existsSync;
  return {
    kind: 'launchd',
    fileOf,
    current: LAUNCHD_LABEL,
    previous,
    logFile: path.join(d.configDir, 'quarterdeck.log'),
    render: (r) => launchAgentPlist(r, { label: LAUNCHD_LABEL, logFile: path.join(r.configDir, 'quarterdeck.log') }),
    preflight: async () => ((await d.run('launchctl', ['print', domain])).code === 0 ? null : T.noGui),
    legacy: async (dryRun) => {
      if (exists(fileOf(LEGACY_LAUNCHD_LABEL))) return T.legacy;
      const loopPid = Number((readText(path.join(d.configDir, 'relaunch.pid')) ?? '').trim());
      if (Number.isInteger(loopPid) && loopPid > 0 && isAlive(loopPid) && RELAUNCH_LOOP_RE.test(commandOf(loopPid) ?? '')) return T.legacy;
      if (!dryRun && (await d.run('launchctl', ['print', target(LEGACY_LAUNCHD_LABEL)])).code === 0) return T.legacy;
      return null;
    },
    loaded: async (n) => (await d.run('launchctl', ['print', target(n)])).code === 0,
    upSteps: () => [['launchctl', 'bootstrap', domain, fileOf(LAUNCHD_LABEL)]],
    needsUnloadFirst: true,
    downSteps: (n) => [['launchctl', 'bootout', target(n)]],
    stopped: async (n) => (await d.run('launchctl', ['print', target(n)])).code !== 0,
    afterRemove: [],
    restart: ['launchctl', 'kickstart', '-k', target(LAUNCHD_LABEL)],
    mainPid: async () => {
      const r = await d.run('launchctl', ['print', target(LAUNCHD_LABEL)]);
      return r.code === 0 ? parseLaunchctlPid(r.stdout) : null;
    },
    state: async () => {
      const r = await d.run('launchctl', ['print', target(LAUNCHD_LABEL)]);
      if (r.code !== 0) return 'not loaded';
      const pid = parseLaunchctlPid(r.stdout);
      return pid ? `running (pid ${pid})` : 'loaded';
    },
  };
}

/** `quarterdeck service <install|uninstall|status|restart>`. Resolves with the exit code. */
export async function serviceAction(cmd: Extract<CliCommand, { kind: 'service' }>, d: ServiceDeps): Promise<number> {
  if (d.platform !== 'linux' && d.platform !== 'darwin') { d.err(T.windows); return 1; }
  const m = d.platform === 'linux'
    ? systemdManager(d, d.previousNames ?? PREVIOUS_UNIT_NAMES)
    : launchdManager(d, d.previousNames ?? PREVIOUS_LAUNCHD_LABELS);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Runs one command; a failure is reported (stderr's first line, ≤ 200 chars) and returned. */
  const exec = async (c: Cmd): Promise<boolean> => {
    const r = await d.run(c[0]!, c.slice(1));
    if (r.code === 0) return true;
    d.err(T.commandFailed(show(c), r.code, (r.stderr.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200)));
    return false;
  };
  const execAll = async (cs: Cmd[]): Promise<boolean> => {
    for (const c of cs) if (!(await exec(c))) return false;
    return true;
  };
  const waitStopped = async (name: string, limitSec: number): Promise<boolean> => {
    for (let i = 0; i <= Math.ceil((limitSec * 1000) / POLL_MS); i++) {
      if (await m.stopped(name)) return true;
      await sleep(POLL_MS);
    }
    return false;
  };
  const confirm = async (q: string): Promise<boolean | null> => {
    if (cmd.yes) return true;
    if (!d.isTTY) { d.err(T.needConfirm); return null; }
    if (await d.ask(q)) return true;
    d.err(T.cancelled);
    return false;
  };
  /** Old names (PREVIOUS_*): only files carrying our marker are taken down and deleted. */
  const cleanPrevious = async (): Promise<boolean> => {
    for (const name of m.previous) {
      const file = m.fileOf(name);
      const text = readText(file);
      if (text === null || !hasMarker(text)) continue;
      if (m.kind === 'systemd' || (await m.loaded(name))) {
        if (!(await execAll(m.downSteps(name)))) return false;
        if (!(await waitStopped(name, 1800))) { d.err(T.notStopped(file)); return false; }
      }
      fs.rmSync(file, { force: true });
      if (!(await execAll(m.afterRemove))) return false;
      d.out(T.previousRemoved(name));
    }
    return true;
  };
  const file = m.fileOf(m.current);

  if (cmd.action === 'install') {
    const realpath = d.realpath ?? fs.realpathSync;
    const exists = d.exists ?? fs.existsSync;
    let realBin = d.bin;
    try { realBin = realpath(d.bin); } catch { /* as given */ }
    if (realBin.includes('/_npx/') || d.bin.includes('/_npx/')) { d.err(T.npxCache); return 1; }
    const node = await stableNodePath({ execPath: d.execPath, explicit: cmd.node, platform: d.platform, realpath, exists, nodeVersion: d.nodeVersion ?? (async () => null) });
    if ('error' in node) { d.err(node.error); return 1; }
    if (!cmd.dryRun) {
      const pre = await m.preflight();
      if (pre) { d.err(pre); return 1; }
    }
    const legacy = await m.legacy(cmd.dryRun);
    if (legacy) { d.err(legacy); return 1; }
    const prevUnit = readText(file);
    if (prevUnit !== null && !hasMarker(prevUnit)) { d.err(T.notOurs(file)); return 1; }
    const port = cmd.port ?? d.port;
    const holder = readInstanceLock(d.configDir, d.isAlive ?? pidAlive);
    if (holder && holder.supervisor !== m.kind) { d.err(T.lockHeld(holder.pid, holder.port)); return 1; }
    if (!holder && (await d.portBusy(port))) { d.err(T.portBusy(port)); return 1; }

    const { record, warnings } = buildServiceRecord({
      platform: d.platform, env: d.env, home: d.home, configDir: d.configDir, port, node: node.node, bin: realBin,
      drainFlag: cmd.drainMaxMin, cliBins: d.cliBins?.() ?? {}, packageVersion: d.packageVersion?.() ?? '0.0.0', ...(d.now ? { now: d.now } : {}),
    });
    const reinstall = prevUnit !== null;
    const unitText = m.render(record);
    const files: Array<[string, string]> = [
      [recordFile(d.configDir), `${JSON.stringify(record, null, 2)}\n`],
      [envFile(d.configDir), serviceEnvText(record)],
      [file, unitText],
    ];
    const steps = [...(m.needsUnloadFirst && (cmd.dryRun ? reinstall : await m.loaded(m.current)) ? m.downSteps(m.current) : []), ...m.upSteps(reinstall)];
    if (cmd.dryRun) d.out(T.dryRunHead);
    for (const [f, text] of files) { d.out(T.fileHead(f)); d.out(text.trimEnd()); }
    d.out(T.commandsHead);
    for (const c of steps) d.out(`  ${show(c)}`);
    d.out(T.nodeLine(node.node));
    for (const w of [...(node.warning ? [node.warning] : []), ...warnings]) d.out(T.warning(w));
    if (cmd.dryRun) { d.out(T.dryRunNoProbe); return 0; }
    const ok = await confirm(T.askInstall);
    if (ok !== true) return 1;
    if (!(await cleanPrevious())) return 1;

    // Rollback: files back to what they were (or gone), registration back to before.
    const before = files.map(([f]) => [f, readText(f)] as const);
    const rollback = async (): Promise<number> => {
      const problems: string[] = [];
      const tryCmd = async (c: Cmd) => { if (!(await exec(c))) problems.push(show(c)); };
      if (m.kind === 'systemd' && !reinstall) await tryCmd(['systemctl', '--user', 'disable', '--now', `${SERVICE_NAME}.service`]);
      if (m.kind === 'launchd' && (await m.loaded(m.current))) {
        for (const c of m.downSteps(m.current)) await tryCmd(c);
        if (!(await waitStopped(m.current, stopTimeoutSec(record)))) problems.push(T.notStopped(file));
      }
      for (const [f, text] of before) {
        try {
          if (text === null) fs.rmSync(f, { force: true });
          else fs.writeFileSync(f, text, { mode: 0o600 });
        } catch (e) { problems.push(`${f}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      for (const c of m.afterRemove) await tryCmd(c);
      if (reinstall) for (const c of m.kind === 'systemd' ? [m.restart] : m.upSteps(true)) await tryCmd(c);
      d.err(problems.length ? T.rollbackFailed(problems.join('; ')) : T.rolledBack);
      return 1;
    };

    try {
      fs.mkdirSync(d.configDir, { recursive: true, mode: 0o700 });
      for (const [f, text] of files) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text, { mode: f === file ? 0o644 : 0o600 });
        fs.chmodSync(f, f === file ? 0o644 : 0o600);
      }
    } catch (e) {
      d.err(T.writeFailed(file, e instanceof Error ? e.message : String(e)));
      return rollback();
    }
    if (m.needsUnloadFirst && (await m.loaded(m.current))) {
      if (!(await execAll(m.downSteps(m.current)))) return rollback();
      if (!(await waitStopped(m.current, stopTimeoutSec(record)))) { d.err(T.notStopped(file)); return rollback(); }
    }
    if (!(await execAll(m.upSteps(reinstall)))) return rollback();

    // Up = the lock names the manager's main pid and the recorded port, and that port answers 401 (no token).
    let verified = false;
    for (let i = 0; i < Math.ceil((d.verifyMs ?? 30_000) / POLL_MS); i++) {
      const lock = readInstanceLock(d.configDir, d.isAlive ?? pidAlive);
      if (lock && lock.port === record.port) {
        const pid = await m.mainPid();
        if (pid === lock.pid && (await d.httpProbe(record.port)) === 401) { verified = true; break; }
      }
      await sleep(POLL_MS);
    }
    if (!verified) { d.err(T.notVerified(m.logFile)); return rollback(); }
    d.out(T.installed(record.port));
    if (m.kind === 'systemd') d.out(T.lingerHint);
    else d.out(T.tccHint(record.node));
    return 0;
  }

  if (cmd.action === 'uninstall') {
    const text = readText(file);
    if (text !== null && !hasMarker(text)) { d.err(T.notOurs(file)); return 1; }
    const rec = readServiceRecord(d.configDir);
    const limit = stopTimeoutSec({ drainMaxMin: rec?.drainMaxMin ?? 28 });
    const targets = [file, recordFile(d.configDir), envFile(d.configDir)];
    const steps = text === null ? [] : [...m.downSteps(m.current), ...m.afterRemove];
    if (cmd.dryRun) {
      d.out(T.dryRunHead);
      for (const f of targets) d.out(T.fileHead(f));
      d.out(T.commandsHead);
      for (const c of steps) d.out(`  ${show(c)}`);
      d.out(T.dataKept(d.configDir));
      return 0;
    }
    const pre = await m.preflight();
    if (pre) { d.err(pre); return 1; }
    const ok = await confirm(T.askUninstall);
    if (ok !== true) return 1;
    if (!(await cleanPrevious())) return 1;
    if (text !== null) {
      if ((m.kind === 'systemd' || (await m.loaded(m.current))) && !(await execAll(m.downSteps(m.current)))) return 1;
      if (!(await waitStopped(m.current, limit))) { d.err(T.notStopped(file)); return 1; }
    } else {
      d.out(T.notInstalled);
    }
    for (const f of targets) fs.rmSync(f, { force: true });
    if (text !== null && !(await execAll(m.afterRemove))) return 1;
    if (text !== null) d.out(T.uninstalled);
    d.out(T.dataKept(d.configDir));
    return 0;
  }

  const text = readText(file);
  if (cmd.action === 'restart') {
    if (text === null) { d.err(T.notInstalled); return 1; }
    if (!hasMarker(text)) { d.err(T.notOurs(file)); return 1; }
    if (cmd.dryRun) { d.out(T.dryRunHead); d.out(T.commandsHead); d.out(`  ${show(m.restart)}`); return 0; }
    const pre = await m.preflight();
    if (pre) { d.err(pre); return 1; }
    if (!(await exec(m.restart))) return 1;
    d.out(T.restarted);
    return 0;
  }

  // status: the unit/plist, the record, the running instance (lock) and the package on disk, side by side.
  if (text === null) d.out(T.notInstalled);
  else if (!hasMarker(text)) d.out(T.notOurs(file));
  else d.out(T.statusUnit(file, cmd.dryRun ? '?' : await m.state()));
  const rec = readServiceRecord(d.configDir);
  d.out(rec ? T.statusRecord(rec.node, rec.bin, rec.port, rec.drainMaxMin) : T.statusNoRecord);
  const lock = readInstanceLock(d.configDir, d.isAlive ?? pidAlive);
  d.out(lock ? T.statusLock(lock.pid, lock.port, lock.version, lock.supervisor) : T.statusNoLock);
  const disk = d.packageVersion?.() ?? null;
  if (disk) d.out(T.statusDisk(disk));
  if (rec && lock && rec.port !== lock.port) d.out(T.warning(T.statusPortMismatch(rec.port, lock.port)));
  if (lock && disk && lock.version && lock.version !== disk) d.out(T.warning(T.statusMismatch));
  return 0;
}
