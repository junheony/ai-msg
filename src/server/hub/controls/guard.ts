/**
 * Hub controls — the forbidden-action guard. Every control the hub offers (approve, launch, file a bot task, stop,
 * rerun) asks this file first. Trading stays out of the hub entirely: nothing that arms/disarms, goes live, touches
 * keys, ARMED/FSD, Cont live, a nexus-engine reload, a cblabx-* unit or a service on the protected ports. A match is
 * not an error to work around — the item is shown read-only with LOCKED_LABEL and the endpoint answers 403.
 */
import path from 'node:path';

/** What a locked item says instead of its buttons. */
export const LOCKED_LABEL = 'QUANT/해당 채팅에서만 승인';

/** Modes whose controls live in their own chats only (no approve, no launch, no bot task, no shortcut). */
export const LOCKED_MODES: readonly string[] = ['trading', 'quant'];

/** Services the hub never stops, restarts or reloads (the trading stack and its dashboards). */
export const PROTECTED_PORTS: readonly number[] = [8771, 8783, 8792, 8793, 8830];

/**
 * Text that names a trading control. Kept deliberately broad: a false positive costs a trip to the right chat, a
 * false negative could arm a live book. Matched against kind, mode, title, detail, brief, bot names and command lines.
 */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\b(?:dis)?arm(?:ed|ing|s)?\b/i, why: 'arm/disarm' },
  { re: /무장|아밍|암드/, why: 'arm/disarm' },
  { re: /\bFSD\b/i, why: 'FSD' },
  { re: /\bgo[\s_-]*live\b|\bgoing[\s_-]*live\b|\blive[\s_-]*(?:mode|trad\w*|order\w*|book|desk|switch|on)\b/i, why: 'go live' },
  { re: /\bcont[\s_-]*live\b/i, why: 'Cont live' },
  { re: /live\.conf|go_live/i, why: 'go live' },
  { re: /실거래|라이브\s*(?:전환|모드|매매|주문|켜)|실전\s*(?:전환|매매)/, why: 'go live' },
  { re: /\b(?:api|secret|private|signing|exchange|wallet)[\s_-]*keys?\b|\bkeys?[\s_-]*(?:rotat\w*|swap|change|file)\b|\.env\b|\bmnemonic\b|\bseed[\s_-]*phrase\b/i, why: 'keys' },
  { re: /(?:API|비밀|개인|거래소|지갑)\s*키|키\s*(?:교체|변경|수정|설정|파일)/, why: 'keys' },
  { re: /nexus[\s_-]*engine/i, why: 'nexus-engine' },
  { re: /cblabx[\w.-]*/i, why: 'cblabx-* unit' },
  { re: new RegExp(`(?<!\\d)(?:${PROTECTED_PORTS.join('|')})(?!\\d)`), why: 'protected port' },
  { re: /\b(?:ledger|anchors)\.jsonl\b|\bledger\b|원장/i, why: 'ledger' },
  { re: /\btrading\b|\bquant\b|트레이딩|퀀트/i, why: 'trading' },
];

/** The reason a text is off-limits for the hub, or null when it is not. */
export function forbiddenReason(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    for (const f of FORBIDDEN) if (f.re.test(t)) return f.why;
  }
  return null;
}

export const isLockedMode = (mode: string | null | undefined): boolean => !!mode && LOCKED_MODES.includes(mode);

/** Folders (relative to home) a launched job may not use as its working dir: the trading repos, state and keys. */
const FORBIDDEN_DIRS = ['arbitrage-nexus', 'trading-status', 'quant_analyzer', '.local/state', '.ssh', '.gnupg', '.config/deck', '.msg'];
const FORBIDDEN_DIR_RE = /(?:^|\/)(?:cblabx[^/]*|nexus[-_]?engine[^/]*|[^/]*ledger[^/]*|[^/]*trading[^/]*|[^/]*quant[^/]*)(?:\/|$)/i;

/** Why `dir` cannot be a job's working dir (outside home, a trading folder…), or null. */
export function forbiddenDir(home: string, dir: string): string | null {
  const abs = path.resolve(dir);
  const root = path.resolve(home);
  if (abs !== root && !abs.startsWith(root + path.sep)) return '홈 폴더 밖';
  const rel = path.relative(root, abs);
  if (FORBIDDEN_DIRS.some((d) => rel === d || rel.startsWith(d + path.sep))) return '보호 폴더';
  if (FORBIDDEN_DIR_RE.test(rel)) return '트레이딩 폴더';
  return null;
}

/**
 * Why a running process must never get a signal from the hub: a protected unit (its cgroup), a trading command line,
 * or the server itself. `cgroup` is /proc/<pid>/cgroup, `cmdline` the NUL-joined /proc/<pid>/cmdline.
 */
export function forbiddenProcess(p: { pid: number; cmdline: string; cgroup: string; selfPid: number; parentPid: number }): string | null {
  if (!Number.isInteger(p.pid) || p.pid <= 1) return '잘못된 PID';
  if (p.pid === p.selfPid || p.pid === p.parentPid) return 'MSG 서버 자신';
  if (/cblabx[\w@.-]*\.service|nexus[-_]?engine|ai-msg\.service/i.test(p.cgroup)) return '보호된 서비스 유닛';
  const cmd = p.cmdline.replace(/\0/g, ' ');
  const why = forbiddenReason(cmd);
  return why ? `트레이딩 프로세스 (${why})` : null;
}

/** An approval request is locked when its kind, mode or any of its text names a trading control. */
export function approvalLock(req: { kind?: string; mode?: string; title?: string; detail?: string; from?: string; links?: { label: string; href: string }[] }): string | null {
  if (isLockedMode(req.mode)) return `mode ${req.mode}`;
  return forbiddenReason(req.kind, req.mode, req.title, req.detail, req.from, ...(req.links ?? []).flatMap((l) => [l.label, l.href]));
}

/**
 * Strings that look like credentials. Used both ways: a brief or task containing one is refused (it would be written
 * to a job file), and log/report text shown in the UI has them masked.
 */
const SECRET_RES: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:0x)?[0-9a-fA-F]{64}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(\b(?:bearer|token|api[_-]?key|secret|password|passwd)\b["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi,
];

export function hasSecret(text: string): boolean {
  return SECRET_RES.some((re) => { re.lastIndex = 0; return re.test(text); });
}

/** `text` with anything credential-shaped replaced by «비밀값». `extra` = exact values to hide too (the login token). */
export function redact(text: string, extra: string[] = []): string {
  let out = text;
  for (const v of extra) if (v && v.length >= 8) out = out.split(v).join('«비밀값»');
  for (const re of SECRET_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m, keep?: string) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}«비밀값»` : '«비밀값»'));
  }
  return out;
}
