import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import type { GrokBilling } from '../../shared/usage-types';
import { AcpConnection, AcpRpcError, AcpTimeoutError, METHOD_NOT_FOUND } from './acp/AcpConnection';
import type { ChildLike, SpawnFn } from './CodexEngine';
import { GROK_AGENT_ARGS, GROK_TIMEOUTS, classifyGrokError, grokEngineLock, type GrokDeps } from './GrokEngine';
import { grokEnv } from './grokEnv';
import { checkGrokInspect } from './grokInspect';
import { findGrokProjectConfig } from './grokProjectGuard';
import { redactSecrets } from './redact';
import { GROK_SHADOW_LINKS, createShadowHome, type ShadowHome } from './shadowHome';

/**
 * Grok ACP extension for the subscription's usage (grok 1.0.62; `x.ai/billing` without the underscore is Method not
 * found). Needs only `initialize` — no session, no prompt, so reading it uses no quota.
 */
export const GROK_BILLING_METHOD = '_x.ai/billing';

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : null);
const iso = (x: unknown): string | null => (typeof x === 'string' && x && !Number.isNaN(Date.parse(x)) ? x : null);
/** A number, or protobuf-JSON's `{ val: n }` wrapper (`prepaidBalance` comes that way). */
const numOf = (x: unknown): number | null => {
  const v = rec(x) ? (x as Rec).val : x;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * One `_x.ai/billing` result as deck keeps it; null when it has no usable `config.creditUsagePercent`. The percent is
 * read as "used" (see GrokBilling); a value outside 0–100 is clamped.
 */
export function parseGrokBilling(result: unknown, fetchedAtMs: number): GrokBilling | null {
  const r = rec(result);
  const config = rec(r?.config);
  const pct = numOf(config?.creditUsagePercent);
  if (!r || !config || pct === null) return null;
  const period = rec(config.currentPeriod);
  const usage = rec(config.billingPeriodUsage) ?? rec(config.currentPeriodUsage) ?? rec(config.periodUsage) ?? rec(config.usage);
  const tier = r.subscription_tier ?? r.subscriptionTier ?? config.subscriptionTier;
  const out: GrokBilling = {
    usedPct: Math.max(0, Math.min(100, pct)),
    windowStart: iso(period?.start) ?? iso(config.billingPeriodStart),
    windowEnd: iso(period?.end) ?? iso(config.billingPeriodEnd),
    tier: typeof tier === 'string' && tier.trim() ? tier.trim().slice(0, 80) : null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
  if (typeof period?.type === 'string' && period.type) out.periodType = period.type.slice(0, 60);
  const extra: Array<[keyof GrokBilling, unknown]> = [
    ['monthlyLimit', config.monthlyLimit], ['onDemandCap', config.onDemandCap], ['onDemandUsed', config.onDemandUsed],
    ['includedUsed', usage?.includedUsed], ['totalUsed', usage?.totalUsed],
  ];
  for (const [k, v] of extra) {
    const n = numOf(v);
    if (n !== null) (out as Record<string, unknown>)[k] = n;
  }
  return out;
}

/**
 * The idle poller's answer. `no_bin` / `auth` / `unsupported` stop it; `blocked` (engine locked, the fail-closed checks
 * refused) and `error` are tried again on a later tick.
 */
export type GrokBillingProbe =
  | { kind: 'ok'; billing: GrokBilling }
  | { kind: 'no_bin' | 'auth' | 'unsupported' | 'blocked' | 'error'; message: string };

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/**
 * Reads the billing with no turn: the same isolation as a Grok turn (engine lock check, project-config guard, a fresh
 * shadow HOME, deck's env with the seat's GROK_HOME, `grok inspect` fail-closed), then `grok agent --no-leader stdio`
 * in its own process group → initialize → `_x.ai/billing` → stdin closed → the group ended → shadow HOME removed.
 */
export async function probeGrokBilling(deps: GrokDeps, now: () => number = Date.now): Promise<GrokBillingProbe> {
  const t = { ...GROK_TIMEOUTS, ...deps.timeouts };
  const locked = (deps.engineLock ?? grokEngineLock).reason;
  if (locked !== null) return { kind: 'blocked', message: `Grok 엔진 잠김 — ${locked}` };
  let grokHome: string;
  try { grokHome = await fs.realpath(deps.grokHome); } catch { grokHome = path.resolve(deps.grokHome); }
  const realHome = await fs.realpath(deps.realHome).catch(() => path.resolve(deps.realHome));
  let shadow: ShadowHome;
  try {
    shadow = await createShadowHome({ root: deps.homesDir, realHome, links: GROK_SHADOW_LINKS });
  } catch (e) {
    return { kind: 'error', message: `격리 HOME 준비 실패 — ${(e as Error).message}` };
  }
  try {
    const cwd = shadow.path;
    if ((await findGrokProjectConfig(cwd, grokHome, realHome).catch(() => cwd)) !== null) return { kind: 'blocked', message: 'Grok 프로젝트 설정이 있는 폴더' };
    const env = grokEnv(deps.baseEnv ?? process.env, grokHome, shadow.path);
    let json: unknown;
    try {
      json = await deps.inspect(env, cwd);
    } catch (e) {
      const msg = redactSecrets((e as Error)?.message ?? String(e));
      return /ENOENT/.test(msg) ? { kind: 'no_bin', message: msg } : { kind: 'blocked', message: `grok inspect 실패 — ${msg}` };
    }
    const verdict = await checkGrokInspect(json, deps.readConfig);
    if (!verdict.ok) return { kind: 'blocked', message: `grok inspect 거부 — ${verdict.item}` };
    return await askBilling(deps, env, cwd, t, now);
  } finally {
    await shadow.remove();
  }
}

async function askBilling(deps: GrokDeps, env: Record<string, string>, cwd: string, t: typeof GROK_TIMEOUTS, now: () => number): Promise<GrokBillingProbe> {
  const spawnFn: SpawnFn = deps.spawnFn
    ?? ((b, args, o) => nodeSpawn(b, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
  let child: ChildLike;
  try {
    child = spawnFn(deps.bin, [...GROK_AGENT_ARGS], { cwd, env });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return /ENOENT/.test(msg) ? { kind: 'no_bin', message: msg } : { kind: 'error', message: `grok 실행 실패: ${msg}` };
  }
  let exited = false;
  let spawnError: string | null = null;
  const exitP = new Promise<void>((resolve) => {
    child.once('exit', () => { exited = true; resolve(); });
    child.once('error', (err: Error) => { exited = true; spawnError = err.message; resolve(); });
  });
  child.stderr?.on('data', () => {});
  let conn: AcpConnection | null = null;
  try {
    if (!child.stdout || !child.stdin) return { kind: 'error', message: 'grok: no stdio pipes' };
    const c = new AcpConnection(child.stdout, child.stdin);
    conn = c;
    void exitP.then(() => c.close('agent exited'));
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, t.initializeMs);
    const raw = await c.request(GROK_BILLING_METHOD, {}, t.billingMs);
    const billing = parseGrokBilling(raw, now());
    return billing ? { kind: 'ok', billing } : { kind: 'error', message: 'Grok billing 응답에 사용률이 없음' };
  } catch (e) {
    await Promise.race([exitP, sleep(200)]);
    if (spawnError !== null) return /ENOENT/.test(spawnError) ? { kind: 'no_bin', message: spawnError } : { kind: 'error', message: `grok 실행 실패: ${spawnError}` };
    if (e instanceof AcpRpcError) {
      if (e.code === METHOD_NOT_FOUND) return { kind: 'unsupported', message: `${GROK_BILLING_METHOD} 없음 (이 grok 버전)` };
      if (classifyGrokError(e) === 'auth') return { kind: 'auth', message: 'Grok 로그인 필요' };
      return { kind: 'error', message: redactSecrets(`Grok 오류 (${e.code}): ${e.message}`) };
    }
    if (e instanceof AcpTimeoutError) return { kind: 'error', message: `Grok 응답 없음 (${e.method})` };
    return { kind: 'error', message: redactSecrets((e as Error)?.message ?? String(e)) };
  } finally {
    await endProcess(child, exitP, () => exited, t);
    conn?.close('billing probe ended');
  }
}

/** stdin closed → closeMs to end on its own → group SIGTERM → termMs → group SIGKILL (no session, so no history to flush). */
async function endProcess(child: ChildLike, exitP: Promise<void>, exited: () => boolean, t: typeof GROK_TIMEOUTS): Promise<void> {
  try { child.stdin?.end(); } catch { /* already closed */ }
  const pid = child.pid;
  const wait = (ms: number) => Promise.race([exitP.then(() => true), sleep(ms).then(() => false)]);
  const kill = (sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
  };
  if (await wait(Math.min(t.closeMs, 2_000))) { kill('SIGKILL'); return; }
  kill('SIGTERM');
  if (await wait(t.termMs)) { kill('SIGKILL'); return; }
  kill('SIGKILL');
  if (!exited()) await wait(t.killMs);
}
