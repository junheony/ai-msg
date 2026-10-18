import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { AcpConnection, AcpRpcError, AcpTimeoutError, METHOD_NOT_FOUND } from './acp/AcpConnection';
import type { ChildLike, SpawnFn } from './CodexEngine';
import { GROK_AGENT_ARGS, GROK_TIMEOUTS, classifyGrokError, grokEngineLock, type GrokDeps } from './GrokEngine';
import { GROK_BILLING_METHOD, type GrokBillingProbe, parseGrokBilling } from './grokBillingCore';
import { grokEnv } from './grokEnv';
import { checkGrokInspect } from './grokInspect';
import { findGrokProjectConfig } from './grokProjectGuard';
import { redactSecrets } from './redact';
import { GROK_SHADOW_LINKS, createShadowHome, type ShadowHome } from './shadowHome';

// GROK_BILLING_METHOD, parseGrokBilling and GrokBillingProbe now live in grokBillingCore.ts (no import of GrokEngine,
// so GrokEngine can import them with no cycle back here); re-exported so existing imports of this module still work.
export { GROK_BILLING_METHOD, parseGrokBilling, type GrokBillingProbe };

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/**
 * Reads the billing with no turn: the same isolation as a Grok turn (engine lock check, project-config guard, a fresh
 * shadow HOME, deck's env with the seat's GROK_HOME, `grok inspect` fail-closed), then `grok agent --no-leader stdio`
 * in its own process group → initialize → `_x.ai/billing` → stdin closed → the group ended → shadow HOME removed.
 * `signal`: aborts the in-flight ACP requests (the server poller's `stop()`); the process is still torn down normally.
 */
export async function probeGrokBilling(deps: GrokDeps, now: () => number = Date.now, signal?: AbortSignal): Promise<GrokBillingProbe> {
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
    return await askBilling(deps, env, cwd, t, now, signal);
  } finally {
    await shadow.remove();
  }
}

async function askBilling(deps: GrokDeps, env: Record<string, string>, cwd: string, t: typeof GROK_TIMEOUTS, now: () => number, signal?: AbortSignal): Promise<GrokBillingProbe> {
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
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, t.initializeMs, signal);
    const raw = await c.request(GROK_BILLING_METHOD, {}, t.billingMs, signal);
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
