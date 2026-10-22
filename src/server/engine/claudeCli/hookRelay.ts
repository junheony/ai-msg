// src/server/engine/claudeCli/hookRelay.ts
// Child entry for deck's `--settings` command hooks. The CLI runs:
//   DECK_BRIDGE_TOKEN=<t> node --disable-warning=ExperimentalWarning hookRelay.ts --sock <s> --fail open|deny|closed
// The token comes from the env (never argv). stdin: the hook input JSON; stdout: the hook output JSON.
// `closed` (총사령탑 자동 턴): every failure — dead socket, non-200, an answer that is not a JSON object, bad stdin, the
// overall deadline, an uncaught error — prints the deny and exits 2 (the CLI blocks the call on exit 2 whatever stdout says).
// node: built-ins only, erasable TS only.
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { postBridge } from './permissionMcp.ts';

const FAILED = '도구 사용 여부를 AI-MSG 에 확인하지 못해 거부했습니다';
const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: FAILED } });
/**
 * `closed`: the whole relay (stdin included) is done within this. Below the bridge's fail-closed cap (bridge.ts
 * CLOSED_HOOK_WAIT_MS, 22 s), itself below the CLI hook timeout (args.ts HOOK_TIMEOUT_S, 30 s).
 */
export const CLOSED_RELAY_DEADLINE_MS = 20_000;

type FailMode = 'open' | 'deny' | 'closed';

/** `DECK_HOOK_RELAY_DEADLINE_MS` (tests) may only shorten the deadline. */
export function relayDeadlineMs(env: NodeJS.ProcessEnv): number {
  const v = Number(env.DECK_HOOK_RELAY_DEADLINE_MS);
  return v > 0 && v < CLOSED_RELAY_DEADLINE_MS ? v : CLOSED_RELAY_DEADLINE_MS;
}

function isJsonObject(body: string): boolean {
  try {
    const v: unknown = JSON.parse(body);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function relayOutput(fail: FailMode, status: number | null, body: string): string {
  if (status === 200 && body && (fail !== 'closed' || isJsonObject(body))) return body;
  return fail === 'open' ? '{}' : DENY;
}

/** `closed` only: print the deny and leave with exit 2 (sync writes: nothing is lost to the exit). */
function denyAndExit(): void {
  try { writeSync(1, DENY); writeSync(2, FAILED); } catch { /* exit 2 alone blocks the call */ }
  process.exit(2);
}

async function main(): Promise<void> {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const mode = arg('--fail');
  const fail: FailMode = mode === 'closed' ? 'closed' : mode === 'deny' ? 'deny' : 'open';
  const deadlineMs = fail === 'closed' ? relayDeadlineMs(process.env) : 25_000;
  if (fail === 'closed') {
    process.on('uncaughtException', denyAndExit);
    process.on('unhandledRejection', denyAndExit);
    setTimeout(denyAndExit, deadlineMs);
  }
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let status: number | null = null;
  let body = '';
  try {
    const r = await postBridge(arg('--sock'), process.env.DECK_BRIDGE_TOKEN ?? '', '/v1/hook', JSON.parse(raw || '{}'), AbortSignal.timeout(deadlineMs));
    status = r.status;
    body = r.body;
  } catch {
    // dead socket, timeout, bad stdin: decided by the fail mode
  }
  const out = relayOutput(fail, status, body);
  if (fail === 'closed') {
    if (out === DENY) { denyAndExit(); return; }
    writeSync(1, out);
    process.exit(0);
  }
  process.stdout.write(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
