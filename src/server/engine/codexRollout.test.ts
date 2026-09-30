import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRolloutFile, parseCodexTranscript, readCodexTranscript, readRolloutRateLimits, rolloutRateLimits } from './codexRollout';

const TID = '01a0f2d3-0000-7c92-aeea-000000000001';
// Shapes observed 2026-09-30 in ~/.codex/sessions/2026/09/30/rollout-…-<thread>.jsonl (texts shortened).
const LINES = [
  { timestamp: '2026-09-30T14:59:26.261Z', type: 'session_meta', payload: { id: TID, cwd: '/w', originator: 'codex_exec', source: 'exec' } },
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }, { type: 'input_text', text: '# AGENTS.md instructions\n…' }] } },
  { type: 'turn_context', payload: { turn_id: 'x', cwd: '/w', sandbox_policy: { type: 'read-only' } } },
  { timestamp: '2026-09-30T14:59:28.268Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'List the files' } },
  { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\n' } },
  { type: 'event_msg', payload: { type: 'agent_message', message: 'a.txt' } },
  { timestamp: '2026-09-30T15:01:17.202Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a.txt' }], phase: 'final_answer' } },
  { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 26711 } }, rate_limits: { limit_id: 'codex', primary: { used_percent: 40.0, window_minutes: 10080, resets_at: 1791353807 }, secondary: { used_percent: 12.5, window_minutes: 300, resets_at: 1790790000 } } } },
  { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'a.txt' } },
];
const TEXT = LINES.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('parseCodexTranscript', () => {
  it('keeps the real user prompt, drops injected context, links tool calls and outputs, reads assistant text', () => {
    const t = parseCodexTranscript(TEXT);
    expect(t).toEqual([
      { kind: 'user', text: 'List the files', ts: '2026-09-30T14:59:28.268Z' },
      { kind: 'assistant', text: '', model: null, toolCalls: [{ id: 'call_1', name: 'shell', input: { command: ['ls'] } }], ts: null },
      { kind: 'tool_result', toolUseId: 'call_1', content: 'a.txt\n', isError: false, ts: null },
      { kind: 'assistant', text: 'a.txt', model: null, toolCalls: [], ts: '2026-09-30T15:01:17.202Z' },
    ]);
  });
});

describe('rolloutRateLimits', () => {
  it('maps primary 10080 min → weekly, secondary 300 min → fiveHour, epoch seconds → ISO', () => {
    expect(rolloutRateLimits(LINES)).toEqual({ weekly: { usedPct: 40, resetsAt: '2026-10-07T06:16:47.000Z' }, fiveHour: { usedPct: 13, resetsAt: '2026-09-30T17:40:00.000Z' } });
    expect(rolloutRateLimits(LINES.slice(0, 10))).toBeNull();
  });
});

describe('files', () => {
  it('findRolloutFile walks YYYY/MM/DD and matches the thread-id suffix; readers work on the file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-codex-sessions-'));
    const dir = path.join(root, '2026', '09', '30');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-30T23-59-26-${TID}.jsonl`);
    await fs.writeFile(file, TEXT);
    await fs.writeFile(path.join(dir, 'rollout-2026-09-30T23-00-00-01a0f2d3-0000-7c92-aeea-000000000002.jsonl'), '{}\n');
    expect(await findRolloutFile(root, TID)).toBe(file);
    expect(await findRolloutFile(root, 'nope')).toBeNull();
    expect(await findRolloutFile(path.join(root, 'missing'), TID)).toBeNull();
    expect((await readRolloutRateLimits(file))?.weekly?.usedPct).toBe(40);
    expect((await readCodexTranscript(file)).at(-1)).toMatchObject({ kind: 'assistant', text: 'a.txt' });
    await fs.rm(root, { recursive: true, force: true });
  });
});
