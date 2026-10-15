// src/server/engine/claudeCli/hookRelay.ts
// Child entry for deck's `--settings` command hooks. The CLI runs:
//   DECK_BRIDGE_TOKEN=<t> node --disable-warning=ExperimentalWarning hookRelay.ts --sock <s> --fail open|deny
// The token comes from the env (never argv). stdin: the hook input JSON; stdout: the hook output JSON.
// node: built-ins only, erasable TS only.
import { pathToFileURL } from 'node:url';
import { postBridge } from './permissionMcp.ts';

const FAILED = '도구 사용 여부를 deck 에 확인하지 못해 거부했습니다';

export function relayOutput(fail: 'open' | 'deny', status: number | null, body: string): string {
  if (status === 200 && body) return body;
  return fail === 'deny'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: FAILED } })
    : '{}';
}

async function main(): Promise<void> {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
  const fail = arg('--fail') === 'deny' ? 'deny' : 'open';
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let status: number | null = null;
  let body = '';
  try {
    const r = await postBridge(arg('--sock'), process.env.DECK_BRIDGE_TOKEN ?? '', '/v1/hook', JSON.parse(raw || '{}'), AbortSignal.timeout(25_000));
    status = r.status;
    body = r.body;
  } catch {
    // dead socket, timeout, bad stdin: decided by the fail mode
  }
  process.stdout.write(relayOutput(fail, status, body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
