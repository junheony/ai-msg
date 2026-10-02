import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBranchPoint, parseTranscript, readBranchPoint } from './transcript';

const rec = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (uuid: string, parentUuid: string | null, text: string, extra: Record<string, unknown> = {}) => rec({ type: 'user', uuid, parentUuid, message: { role: 'user', content: text }, ...extra });
const asst = (uuid: string, parentUuid: string, id: string, content: unknown[]) => rec({ type: 'assistant', uuid, parentUuid, message: { id, role: 'assistant', content } });
const toolResult = (uuid: string, parentUuid: string) => rec({ type: 'user', uuid, parentUuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });

// u0 → a0 (tool_use) → tr → a0b (text) → sys (stop hook) → u1 → a1 → u2 → a2
const LINES = [
  rec({ type: 'summary', summary: 'x' }),
  user('u0', null, '첫 질문'),
  asst('a0', 'u0', 'm0', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
  toolResult('tr', 'a0'),
  asst('a0b', 'tr', 'm0b', [{ type: 'text', text: '답 0' }]),
  rec({ type: 'system', uuid: 'sys', parentUuid: 'a0b', subtype: 'stop_hook_summary' }),
  user('u1', 'sys', '두 번째\n질문'),
  asst('side', 'u1', 'ms', [{ type: 'text', text: 'sidechain' }]).replace('"type":"assistant"', '"type":"assistant","isSidechain":true'),
  asst('a1', 'u1', 'm1', [{ type: 'text', text: '답 1' }]),
  user('u2', 'a1', '세 번째'),
  asst('a2', 'u2', 'm2', [{ type: 'text', text: '답 2' }]),
];

describe('transcript ordinals', () => {
  it('user messages carry their ordinal over the whole transcript (tool results not counted)', () => {
    const msgs = parseTranscript(LINES.join('\n'));
    expect(msgs.filter((m) => m.kind === 'user').map((m) => (m.kind === 'user' ? m.n : null))).toEqual([0, 1, 2]);
    // A tail window keeps the absolute ordinals.
    const tail = parseTranscript(LINES.join('\n'), { maxMessages: 2 });
    expect(tail[0]).toMatchObject({ kind: 'user', text: '세 번째', n: 2 });
  });
});

describe('findBranchPoint', () => {
  it('forks at the entry the edited message was appended after (the kept turn’s last entry)', () => {
    expect(findBranchPoint(LINES, 1)).toEqual({ n: 1, at: 'sys', uuid: 'u1' });
    expect(findBranchPoint(LINES, 2)).toEqual({ n: 2, at: 'a1', uuid: 'u2' });
  });

  it('the first message has no history to keep', () => {
    expect(findBranchPoint(LINES, 0)).toEqual({ n: 0, at: null, uuid: 'u0' });
  });

  it('falls back to the last chain entry before the message when parentUuid is missing', () => {
    const lines = [user('u0', null, 'a'), asst('a0', 'u0', 'm0', [{ type: 'text', text: 'b' }]), rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'c' } })];
    expect(findBranchPoint(lines, 1)).toEqual({ n: 1, at: 'a0', uuid: 'u1' });
  });

  it('an out-of-range ordinal is not found', () => {
    expect(findBranchPoint(LINES, 3)).toBeNull();
  });

  it('with the text the user saw: message n when it matches, else the nearest one that does', () => {
    expect(findBranchPoint(LINES, 1, '두 번째 질문')).toEqual({ n: 1, at: 'sys', uuid: 'u1' });
    // The device counted one message more (e.g. an injected one it never saw).
    expect(findBranchPoint(LINES, 2, '두 번째 질문')).toMatchObject({ n: 1, uuid: 'u1' });
    expect(findBranchPoint(LINES, 0, '세 번째')).toMatchObject({ n: 2, uuid: 'u2' });
    expect(findBranchPoint(LINES, 1, '없는 말')).toBeNull();
  });

  it('readBranchPoint streams a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-branch-'));
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, LINES.join('\n') + '\n');
    expect(await readBranchPoint(file, 2, '세 번째')).toEqual({ n: 2, at: 'a1', uuid: 'u2' });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
