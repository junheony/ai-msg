import fs from 'node:fs';
import path from 'node:path';

/** systemd user unit name (`quarterdeck.service`). */
export const SERVICE_NAME = 'quarterdeck';
/** macOS LaunchAgent label — fixed for good (plan ② D8), whatever the domain or npm scope becomes. */
export const LAUNCHD_LABEL = 'local.quarterdeck.server';
/** Names used before a rename: install/uninstall/status take down and delete their files when they carry our marker. */
export const PREVIOUS_LAUNCHD_LABELS: string[] = [];
export const PREVIOUS_UNIT_NAMES: string[] = [];
/** This Mac's repo-run service (scripts/launchd): never touched, its presence refuses a package service. */
export const LEGACY_LAUNCHD_LABEL = 'com.deck.server';

export const MANAGED_MARKER = 'managed-by: quarterdeck service';
export const MARKER_LINE = `${MANAGED_MARKER} (수정하지 마세요 — quarterdeck service install 이 다시 씁니다)`;

export const DRAIN_DEFAULT_MIN = 25;
export const DRAIN_MAX_MIN = 28;

export type ServiceRecord = {
  version: 1;
  platform: 'linux' | 'darwin';
  node: string;
  bin: string;
  configDir: string;
  port: number;
  drainMaxMin: number;
  env: Record<string, string>;
  installedAt: string;
  packageVersion: string;
};

/** The service manager's hard stop deadline: drain cap + 2 min, at most 30 min (S3). */
export function stopTimeoutSec(r: Pick<ServiceRecord, 'drainMaxMin'>): number {
  return Math.min(r.drainMaxMin * 60 + 120, 1800);
}

/** Never copied into the service env: the manager sets the supervisor itself, and an env file pointer is the shell's. */
const EXCLUDED = new Set(['DECK_SUPERVISOR', 'DECK_SUPERVISED', 'DECK_ENV_FILE']);
const PASS_IF_SET = ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CLAUDE_PICK_COOLDOWN_DIR'];

/**
 * The record `service install` writes: resolved absolute paths and the allowed env of this shell (PATH, HOME, locale,
 * DECK_* but the supervisor markers, XDG dirs, the CLI paths found now). `drainFlag` (`--drain-max-min`, already 1~28)
 * → `DECK_DRAIN_MAX_MIN` when finite and ≤ 28 → 25; anything else falls back to 25 with a warning.
 */
export function buildServiceRecord(o: {
  platform: 'linux' | 'darwin'; env: NodeJS.ProcessEnv; home: string; configDir: string; port: number; node: string; bin: string;
  drainFlag?: number; cliBins: Partial<Record<'DECK_CLAUDE_BIN' | 'DECK_CODEX_BIN' | 'DECK_GEMINI_BIN' | 'DECK_GROK_BIN', string>>;
  packageVersion: string; now?: () => Date;
}): { record: ServiceRecord; warnings: string[] } {
  const warnings: string[] = [];
  let drainMaxMin = DRAIN_DEFAULT_MIN;
  if (o.drainFlag !== undefined) drainMaxMin = o.drainFlag;
  else if (o.env.DECK_DRAIN_MAX_MIN !== undefined && o.env.DECK_DRAIN_MAX_MIN !== '') {
    const n = Number(o.env.DECK_DRAIN_MAX_MIN);
    if (Number.isInteger(n) && n >= 1 && n <= DRAIN_MAX_MIN) drainMaxMin = n;
    else warnings.push(`DECK_DRAIN_MAX_MIN=${o.env.DECK_DRAIN_MAX_MIN} 는 서비스에 쓸 수 없어(1~${DRAIN_MAX_MIN}분) ${DRAIN_DEFAULT_MIN}분으로 둡니다`);
  }
  const env: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => {
    if (v === undefined || v === '') return;
    if (/[\n\r\0]/.test(v)) { warnings.push(`${k} 에 줄바꿈이 있어 서비스 환경에 넣지 않습니다`); return; }
    env[k] = v;
  };
  put('PATH', o.env.PATH);
  put('HOME', o.home);
  for (const [k, v] of Object.entries(o.env)) if (k === 'LANG' || k.startsWith('LC_')) put(k, v);
  for (const [k, v] of Object.entries(o.env)) if (k.startsWith('DECK_') && !EXCLUDED.has(k)) put(k, v);
  for (const k of PASS_IF_SET) put(k, o.env[k]);
  for (const [k, v] of Object.entries(o.cliBins)) put(k, v);
  env.DECK_CONFIG_DIR = path.resolve(o.configDir);
  env.DECK_PORT = String(o.port);
  env.DECK_DRAIN_MAX_MIN = String(drainMaxMin);
  return {
    record: {
      version: 1, platform: o.platform, node: o.node, bin: o.bin, configDir: path.resolve(o.configDir), port: o.port, drainMaxMin, env,
      installedAt: (o.now ?? (() => new Date()))().toISOString(), packageVersion: o.packageVersion,
    },
    warnings,
  };
}

/**
 * Quoting for a systemd unit's ExecStart (`exec`) or an EnvironmentFile value (`envFile`). exec: plain when safe, else
 * double-quoted with `\` and `"` escaped; `%` → `%%` and `$` → `$$` (specifier and variable expansion). envFile: always
 * double-quoted, with `\`, `"`, `` ` `` and `$` backslash-escaped (no specifiers there).
 */
export function systemdQuote(s: string, kind: 'exec' | 'envFile' = 'exec'): string {
  if (kind === 'envFile') return `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
  const body = s.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  if (body !== '' && !/[\s"'\\;]/.test(body)) return body;
  return `"${body.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export const recordFile = (configDir: string) => path.join(configDir, 'service.json');
export const envFile = (configDir: string) => path.join(configDir, 'service.env');

export function serviceEnvText(r: ServiceRecord): string {
  return [`# ${MARKER_LINE}`, ...Object.entries(r.env).map(([k, v]) => `${k}=${systemdQuote(v, 'envFile')}`), ''].join('\n');
}

/** `<configDir>/service.json` + `<configDir>/service.env` (0600). Only `service install` writes them; the server never reads them. */
export function writeServiceRecord(configDir: string, r: ServiceRecord): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordFile(configDir), `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(recordFile(configDir), 0o600);
  fs.writeFileSync(envFile(configDir), serviceEnvText(r), { mode: 0o600 });
  fs.chmodSync(envFile(configDir), 0o600);
}

export function readServiceRecord(configDir: string): ServiceRecord | null {
  try {
    const v = JSON.parse(fs.readFileSync(recordFile(configDir), 'utf8')) as Partial<ServiceRecord> | null;
    return v && v.version === 1 && typeof v.node === 'string' && typeof v.bin === 'string' && typeof v.port === 'number' ? (v as ServiceRecord) : null;
  } catch {
    return null;
  }
}
