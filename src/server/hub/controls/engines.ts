/**
 * The engines 다음 작업 can launch, their command lines, and their quota state. Codex and Hermes share one OpenAI
 * quota: when a recent job log says "hit your usage limit … try again at <time>", both are greyed out until then and
 * Claude is suggested. Claude's state comes from the deck usage snapshot (per seat: 5h / weekly).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const ENGINES = ['claude', 'codex', 'hermes'] as const;
export type EngineId = (typeof ENGINES)[number];
export const isEngine = (v: unknown): v is EngineId => typeof v === 'string' && (ENGINES as readonly string[]).includes(v);

export const CLAUDE_ACCOUNTS: Record<'a' | 'b' | 'c', string> = { a: '.claude', b: '.claude-b', c: '.claude-c' };
export type ClaudeAccount = keyof typeof CLAUDE_ACCOUNTS;
export const isClaudeAccount = (v: string): v is ClaudeAccount => v === 'a' || v === 'b' || v === 'c';

export interface EngineState {
  id: EngineId;
  label: string;
  /** false = greyed out (limit hit); the reason and the reset time say why and until when. */
  available: boolean;
  limitedUntil: string | null;
  reason: string | null;
  /** Shared quota group (codex + hermes = 'openai'). */
  quota: 'anthropic' | 'openai';
  /** Short facts for the picker: seat usage, the command it runs. */
  detail: string;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * "try again at Nov 4th, 2026 3:41 PM" → the instant, read as KST (the server's and the owner's zone). Null when the
 * text has no such time.
 */
export function parseLimitReset(text: string): Date | null {
  const m = /try again (?:at|after)\s+([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
  if (mon === undefined) return null;
  let h = Number(m[4]);
  const ap = m[6]?.toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const utc = Date.UTC(Number(m[3]), mon, Number(m[2]), h - 9, Number(m[5]));
  return Number.isNaN(utc) ? null : new Date(utc);
}

export const LIMIT_RE = /hit your usage limit/i;

export interface LimitScanDeps { home: string; now: () => number; extraLogs?: () => Promise<string[]> }

const TAIL = 128 * 1024;
const SCAN_AGE_MS = 8 * 24 * 3600_000;

async function tail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

/** The latest future reset any recent job log announces for the OpenAI quota, or null (not limited). */
export async function scanOpenAiLimit(deps: LimitScanDeps): Promise<Date | null> {
  const jobs = path.join(deps.home, 'jobs');
  let names: string[] = [];
  try { names = await fs.readdir(jobs); } catch { /* no jobs */ }
  const files = [...names.map((n) => path.join(jobs, n, 'run.log')), ...(await deps.extraLogs?.() ?? [])];
  let best: Date | null = null;
  await Promise.all(files.map(async (f) => {
    try {
      const st = await fs.stat(f);
      if (deps.now() - st.mtimeMs > SCAN_AGE_MS) return;
      const text = await tail(f, TAIL);
      if (!LIMIT_RE.test(text)) return;
      // The last announcement in the file is the one that counts.
      const hits = text.split(LIMIT_RE).slice(1);
      const at = parseLimitReset(hits[hits.length - 1] ?? '');
      if (at && at.getTime() > deps.now() && (!best || at > best)) best = at;
    } catch { /* unreadable: skip */ }
  }));
  return best;
}

export const fmtKst = (d: Date): string => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`;
};

export interface SeatUsage { id: string; fiveHourPct: number | null; weeklyPct: number | null; status: string }

export function engineStates(openAiLimit: Date | null, seats: SeatUsage[]): EngineState[] {
  const limited = openAiLimit !== null;
  const why = limited ? `사용 한도 도달 · ${fmtKst(openAiLimit)} 에 재개` : null;
  const seatText = seats.length
    ? seats.map((s) => `${s.id} ${s.weeklyPct === null ? '—' : `주간 ${Math.round(s.weeklyPct)}%`}`).join(', ')
    : '계정 사용량 미확인';
  const claudeOk = seats.length === 0 || seats.some((s) => s.status !== 'down' && (s.weeklyPct ?? 0) < 95 && (s.fiveHourPct ?? 0) < 95);
  return [
    { id: 'claude', label: 'Claude', quota: 'anthropic', available: claudeOk, limitedUntil: null, reason: claudeOk ? null : '모든 계정 한도 근접', detail: `claude-pick 이 계정 선택 (${seatText})` },
    { id: 'codex', label: 'Codex', quota: 'openai', available: !limited, limitedUntil: limited ? openAiLimit.toISOString() : null, reason: why, detail: 'codex exec · Hermes 와 한도 공유' },
    { id: 'hermes', label: 'Hermes', quota: 'openai', available: !limited, limitedUntil: limited ? openAiLimit.toISOString() : null, reason: why, detail: 'hermes -z · Codex 와 한도 공유' },
  ];
}

/** The engine to preselect: the asked one when available, else Claude. */
export function suggestEngine(states: EngineState[], wanted?: EngineId): EngineId {
  const w = wanted && states.find((s) => s.id === wanted);
  if (w && w.available) return w.id;
  return 'claude';
}

/** argv for an engine. `prompt` is the one-line instruction that points the agent at BRIEF.md. */
export function engineArgv(home: string, engine: EngineId, prompt: string): string[] {
  const bin = (n: string) => path.join(home, '.local', 'bin', n);
  switch (engine) {
    case 'claude': return [bin('claude'), '-p', prompt, '--dangerously-skip-permissions'];
    case 'codex': return [bin('codex'), 'exec', '--dangerously-bypass-approvals-and-sandbox', prompt];
    case 'hermes': return [bin('hermes'), '-z', prompt];
  }
}
