import fs from 'node:fs';
import os from 'node:os';
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

/** The `quarterdeck` command. Resolves with the exit code; `start` resolves once the server is up (it keeps running). */
export async function runCli(argv: string[], io: CliIo = defaultIo(), deps: { start?: typeof startServer; probeExec?: ProbeExec } = {}): Promise<number> {
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
    case 'service': io.err(TEXTS.notYet('service')); return 2;
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
        return 1;
      }
    }
  }
}

// Development: `npx tsx src/server/cli/app.ts doctor`. In the bundle argv[1] is bin.js, so this never fires there.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]!) === self; } catch { return false; } })()) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
