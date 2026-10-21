import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountsFileError } from '../accounts';
import { loadConfig } from '../config';
import { installCrashHandlers } from '../crash';
import { InstanceLockedError, readInstanceLock } from '../instanceLock';
import { resolveConfigDir } from '../paths';
import { PortInUseError, packageVersion, startServer } from '../server';
import { probeEngines, type ProbeExec } from '../setup/detect';
import { TEXTS } from '../setup/texts';
import { parseCli } from './args';
import { formatDoctor } from './doctor';
import { serviceAction, type RunResult, type ServiceDeps } from './service/index';
import { FATAL_EXIT_CODE, FATAL_LAUNCHD_DELAY_SEC } from './service/record';
import { capServiceLog } from '../serviceLog';

export type CliIo = { out: (s: string) => void; err: (s: string) => void; isTTY: boolean; env: NodeJS.ProcessEnv; ask?: (q: string) => Promise<boolean> };

const defaultIo = (): CliIo => ({ out: (s) => console.log(s), err: (s) => console.error(s), isTTY: !!process.stdout.isTTY, env: process.env });

export function loginUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
}

function readToken(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

/** A start failure → one line (conflicts never signal the other server). */
export function startErrorLine(err: unknown): string {
  if (err instanceof PortInUseError) return TEXTS.portInUse(err.port);
  if (err instanceof InstanceLockedError) return err.reason === 'relaunch-loop' ? TEXTS.relaunchLoop(err.configDir) : TEXTS.instanceLocked(err.configDir, err.holder?.pid ?? null, err.holder?.port ?? null);
  if (err instanceof AccountsFileError) return err.message;
  return TEXTS.startFailed(err instanceof Error ? err.message : String(err));
}

/** Start failures a restart cannot fix → FATAL_EXIT_CODE (the service manager stops retrying, or retries slowly). */
const isFatalStart = (err: unknown) => err instanceof PortInUseError || err instanceof InstanceLockedError || err instanceof AccountsFileError;

/** `service`'s real side: commands run without a shell, a y/N question on the terminal, loopback-only port/HTTP probes. */
function serviceDeps(io: CliIo, home: string): ServiceDeps {
  const run = (cmd: string, args: string[], o: { timeoutMs?: number } = {}): Promise<RunResult> => new Promise((resolve) => {
    execFile(cmd, args, { timeout: o.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
  return {
    platform: process.platform, home, env: io.env, configDir: resolveConfigDir(io.env, home), execPath: process.execPath,
    bin: (() => { try { return fs.realpathSync(process.argv[1] ?? ''); } catch { return path.resolve(process.argv[1] ?? ''); } })(),
    uid: process.getuid?.() ?? 0, port: Number(io.env.DECK_PORT) || 9320, isTTY: io.isTTY,
    ask: io.ask ?? ((q) => new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${q} [y/N] `, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    })),
    run,
    portBusy: (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (busy: boolean) => { sock.destroy(); resolve(busy); };
      sock.setTimeout(1000, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    }),
    httpProbe: (port) => new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/me', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode ?? null); });
      req.once('timeout', () => req.destroy());
      req.once('error', () => resolve(null));
    }),
    out: io.out, err: io.err,
    nodeVersion: async (bin) => { const r = await run(bin, ['--version']); return r.code === 0 ? r.stdout.trim() : null; },
    cliBins: () => {
      try {
        const cfg = loadConfig(io.env, home, undefined, () => {});
        const bins: ReturnType<NonNullable<ServiceDeps['cliBins']>> = {};
        if (cfg.claudeBin.ok) bins.DECK_CLAUDE_BIN = cfg.claudeBin.bin;
        if (cfg.codexBin) bins.DECK_CODEX_BIN = cfg.codexBin;
        if (cfg.geminiBin) bins.DECK_GEMINI_BIN = cfg.geminiBin;
        if (cfg.grokBin) bins.DECK_GROK_BIN = cfg.grokBin;
        return bins;
      } catch { return {}; }
    },
    packageVersion,
  };
}

/** The `quarterdeck` command. Resolves with the exit code; `start` resolves once the server is up (it keeps running). */
export async function runCli(argv: string[], io: CliIo = defaultIo(), deps: { start?: typeof startServer; probeExec?: ProbeExec; service?: Partial<ServiceDeps>; sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const cmd = parseCli(argv);
  const home = io.env.HOME || os.homedir();
  switch (cmd.kind) {
    case 'version': io.out(packageVersion()); return 0;
    case 'help': io.out(TEXTS.help); return 0;
    case 'error': io.err(TEXTS.badArgs(cmd.message)); return 2;
    case 'doctor': {
      try {
        const cfg = loadConfig(io.env, home);
        const profiles = cfg.accounts.all().map((id) => ({
          id: String(id), label: cfg.accounts.label(id), dir: cfg.accounts.profileDir(id),
          home: cfg.accounts.isHome(id), active: !cfg.accounts.isRetired(id), env: cfg.accounts.env(id, io.env),
        }));
        const report = await probeEngines({ cfg, profiles, env: io.env, ...(deps.probeExec ? { exec: deps.probeExec } : {}) });
        io.out(cmd.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err));
      }
      return 0;
    }
    case 'service': return serviceAction(cmd, { ...serviceDeps(io, home), ...deps.service });
    case 'login-url': {
      const configDir = resolveConfigDir(io.env, home);
      const running = readInstanceLock(configDir);
      let port = running?.port;
      if (port === undefined) {
        port = Number(io.env.DECK_PORT) || 9320;
      }
      const tokenFile = path.join(configDir, 'token');
      const token = readToken(tokenFile);
      if (!token) { io.err(TEXTS.noToken(tokenFile)); return 1; }
      if (!running) io.err(TEXTS.notRunning(port));
      io.out(loginUrl(port, token));
      return 0;
    }
    case 'start': {
      const env = cmd.port === undefined ? io.env : { ...io.env, DECK_PORT: String(cmd.port) };
      const start = deps.start ?? startServer;
      if (!deps.start) installCrashHandlers(process, { log: (line) => console.error(line), exit: (code) => process.exit(code) });
      const launchd = env.DECK_SUPERVISOR === 'launchd';
      if (launchd) {
        // The LaunchAgent appends to this file forever otherwise: checked now and hourly.
        const log = path.join(resolveConfigDir(env, home), 'quarterdeck.log');
        capServiceLog(log);
        if (!deps.start) setInterval(() => capServiceLog(log), 3_600_000).unref();
      }
      try {
        const cfg = loadConfig(env, home);
        await start({
          cfg,
          onListening: (info) => {
            // The address carries the token: printed on a terminal only, never into a service log.
            const token = io.isTTY ? readToken(info.tokenFile) : null;
            io.out(token ? TEXTS.loginUrlLine(loginUrl(info.port, token)) : TEXTS.tokenFileLine(info.tokenFile));
          },
        });
        return 0;
      } catch (err) {
        io.err(startErrorLine(err));
        if (!isFatalStart(err)) return 1;
        // launchd's KeepAlive cannot skip an exit code: waiting here stretches its 10 s restart loop to minutes.
        if (launchd) {
          io.err(TEXTS.fatalBackoff(FATAL_LAUNCHD_DELAY_SEC));
          await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(FATAL_LAUNCHD_DELAY_SEC * 1000);
        }
        return FATAL_EXIT_CODE;
      }
    }
  }
}

// Development: `npx tsx src/server/cli/app.ts doctor`. In the bundle argv[1] is bin.js, so this never fires there.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]!) === self; } catch { return false; } })()) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
