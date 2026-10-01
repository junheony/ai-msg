import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRolloutFile, latestRolloutRateLimits, newestRolloutFiles, parseCodexTranscript, readCodexTranscript, readRolloutRateLimits, readRolloutRateLimitsAt, rolloutRateLimits, rolloutRateLimitsAt } from './codexRollout';

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

describe('latest rate limits across rollout files (F3)', () => {
  const tc = (ts: string | undefined, weekly: number, fiveHour?: number) => ({
    ...(ts ? { timestamp: ts } : {}),
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: weekly, window_minutes: 10080, resets_at: 1791353807 }, secondary: fiveHour === undefined ? null : { used_percent: fiveHour, window_minutes: 300, resets_at: 1790790000 } } },
  });
  const write = async (root: string, rel: string, lines: unknown[], mtimeSec: number) => {
    const f = path.join(root, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await fs.utimes(f, mtimeSec, mtimeSec);
    return f;
  };

  it('rolloutRateLimitsAt returns the last observation with its event timestamp; a missing secondary is fine', () => {
    const r = rolloutRateLimitsAt([tc('2026-10-01T01:00:00.000Z', 10, 3), tc('2026-10-01T02:16:46.682Z', 100)]);
    expect(r).toEqual({ windows: { weekly: { usedPct: 100, resetsAt: new Date(1791353807 * 1000).toISOString() } }, atMs: Date.parse('2026-10-01T02:16:46.682Z') });
    expect(rolloutRateLimitsAt([tc(undefined, 5)])?.atMs).toBeNull();
    expect(rolloutRateLimitsAt([{ type: 'event_msg', payload: { type: 'agent_message' } }])).toBeNull();
  });

  it('skips entries of another limit_id and entries without a known window instead of giving up (review fix 1)', () => {
    const other = { timestamp: '2026-10-01T03:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex_other', primary: { used_percent: 5, window_minutes: 10080, resets_at: 1791353807 } } } };
    const odd = { timestamp: '2026-10-01T04:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 1, window_minutes: 1440, resets_at: 1791353807 } } } };
    const r = rolloutRateLimitsAt([tc('2026-10-01T02:00:00Z', 60, 6), other, odd]);
    expect(r?.windows.weekly?.usedPct).toBe(60);
    expect(r?.atMs).toBe(Date.parse('2026-10-01T02:00:00Z'));
    expect(rolloutRateLimits([tc('2026-10-01T02:00:00Z', 60), odd])?.weekly?.usedPct).toBe(60);
    // No limit_id at all (older CLI) still counts.
    const legacy = { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 33, window_minutes: 10080, resets_at: 1791353807 } } } };
    expect(rolloutRateLimits([legacy])?.weekly?.usedPct).toBe(33);
    expect(rolloutRateLimitsAt([other, odd])).toBeNull();
  });

  it('newestRolloutFiles orders by mtime across all date dirs (an old thread still being written wins)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rl-'));
    const old = await write(root, '2026/07/04/rollout-2026-07-04T22-58-42-a.jsonl', [tc('2026-10-01T02:00:00Z', 90)], 3000);
    const mid = await write(root, '2026/10/01/rollout-2026-10-01T01-00-00-b.jsonl', [tc('2026-10-01T01:00:00Z', 80)], 2000);
    await write(root, '2026/09/30/rollout-2026-09-30T01-00-00-c.jsonl', [tc('2026-09-30T01:00:00Z', 70)], 1000);
    await write(root, '2026/10/01/notes.txt', ['x'], 4000);
    expect(await newestRolloutFiles(root, 2)).toEqual([old, mid]);
    expect(await newestRolloutFiles(path.join(root, 'missing'), 2)).toEqual([]);
  });

  it('latestRolloutRateLimits picks the newest observation among the newest files and tail-reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rl-'));
    // Newer mtime, but its last token_count is older than the other file's.
    await write(root, '2026/10/01/rollout-x.jsonl', [tc('2026-10-01T01:00:00Z', 50, 5)], 5000);
    await write(root, '2026/10/01/rollout-y.jsonl', [tc('2026-10-01T02:00:00Z', 60, 6), { type: 'event_msg', payload: { type: 'task_complete' } }], 4000);
    // Without a timestamp the file mtime stands in.
    await write(root, '2026/09/01/rollout-z.jsonl', [tc(undefined, 99)], 100);
    const r = await latestRolloutRateLimits(root, 5);
    expect(r?.windows.weekly?.usedPct).toBe(60);
    expect(r?.windows.fiveHour?.usedPct).toBe(6);
    expect(r?.atMs).toBe(Date.parse('2026-10-01T02:00:00Z'));
    expect(await latestRolloutRateLimits(path.join(root, 'missing'))).toBeNull();
  });

  it('readRolloutRateLimitsAt reads only the tail of a large file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-rl-'));
    const pad = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(300 * 1024) }] } };
    const f = await write(root, 'rollout-big.jsonl', [tc('2026-10-01T00:00:00Z', 1), pad, tc('2026-10-01T03:00:00Z', 42)], 1000);
    expect((await readRolloutRateLimitsAt(f))?.windows.weekly?.usedPct).toBe(42);
    // The early observation is beyond the 256 KB tail; a tail without any token_count yields null.
    const g = await write(root, 'rollout-big2.jsonl', [tc('2026-10-01T00:00:00Z', 1), pad], 1000);
    expect(await readRolloutRateLimitsAt(g)).toBeNull();
  });
});
