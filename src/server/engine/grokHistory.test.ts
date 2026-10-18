import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findGrokSessionDir, grokUserText, readGrokFirstPrompt, readGrokTranscriptTail } from './grokHistory';

let base: string;
beforeEach(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-grokhist-')); });
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe('grokUserText', () => {
  it('keeps only the inside of <user_query> when there is one', () => {
    expect(grokUserText([{ type: 'text', text: '<user_info>os</user_info>' }, { type: 'text', text: 'x <user_query>\n  고쳐줘\n</user_query> y' }])).toBe('고쳐줘');
  });
  it('otherwise keeps the text, dropping only injected <system-reminder> / <user_info> items', () => {
    expect(grokUserText([{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'hello <b>tag</b>' }, { type: 'image', url: 'x' }])).toBe('hello <b>tag</b>');
    expect(grokUserText('plain')).toBe('plain');
    expect(grokUserText([{ type: 'text', text: '<user_info>only</user_info>' }])).toBeNull();
    expect(grokUserText(42)).toBeNull();
  });
});

describe('readGrokTranscriptTail', () => {
  it('maps user / assistant (+tool calls) / tool_result lines, skipping system, reasoning and broken lines', async () => {
    const f = path.join(base, 'chat_history.jsonl');
    const lines = [
      { type: 'system', content: 'sys' },
      { type: 'user', content: [{ type: 'text', text: '<user_query>ls 해줘</user_query>' }] },
      { type: 'reasoning', content: 'think' },
      { type: 'assistant', content: '볼게요', model_id: 'grok-4.7', tool_calls: [{ id: 'c1', name: 'run', arguments: '{"cmd":"ls"}' }, { id: 'c2', name: 'bad', arguments: 'not json' }] },
      { type: 'tool_result', tool_call_id: 'c1', content: 'a'.repeat(20) },
    ].map((l) => JSON.stringify(l));
    await fs.writeFile(f, `${lines.join('\n')}\n{"type":"user","content":"half`);
    const msgs = await readGrokTranscriptTail(f, undefined, { maxToolResultChars: 5 });
    expect(msgs).toEqual([
      { kind: 'user', text: 'ls 해줘', ts: null },
      { kind: 'assistant', text: '볼게요', model: 'grok-4.7', toolCalls: [{ id: 'c1', name: 'run', input: { cmd: 'ls' } }, { id: 'c2', name: 'bad', input: 'not json' }], ts: null },
      { kind: 'tool_result', toolUseId: 'c1', content: 'aaaaa', isError: false, ts: null, truncated: true },
    ]);
  });

  it('reads only the tail (a cut first line is dropped) and caps the message count', async () => {
    const f = path.join(base, 'chat_history.jsonl');
    await fs.writeFile(f, Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: 'user', content: `m${i}` })).join('\n'));
    const tail = await readGrokTranscriptTail(f, 100);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.at(-1)).toMatchObject({ text: 'm49' });
    expect(tail.every((m) => m.kind === 'user' && /^m\d+$/.test(m.text))).toBe(true);
    expect(await readGrokTranscriptTail(f, undefined, { maxMessages: 3 })).toHaveLength(3);
  });

  it('readGrokFirstPrompt: the first real prompt line', async () => {
    const f = path.join(base, 'chat_history.jsonl');
    await fs.writeFile(f, [{ type: 'system', content: 's' }, { type: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] }, { type: 'user', content: '\n첫 줄\n둘째 줄' }].map((l) => JSON.stringify(l)).join('\n'));
    expect(await readGrokFirstPrompt(f)).toBe('첫 줄');
  });
});

describe('findGrokSessionDir', () => {
  it('finds sessions/<group>/<id>, refusing bad ids and dirs whose real path leaves sessions', async () => {
    const home = path.join(base, 'grok');
    await fs.mkdir(path.join(home, 'sessions', 'g1', 'sess-1'), { recursive: true });
    await fs.mkdir(path.join(base, 'outside', 'sess-2'), { recursive: true });
    await fs.mkdir(path.join(home, 'sessions', 'g2'), { recursive: true });
    await fs.symlink(path.join(base, 'outside', 'sess-2'), path.join(home, 'sessions', 'g2', 'sess-2'));
    expect(await findGrokSessionDir(home, 'sess-1')).toBe(await fs.realpath(path.join(home, 'sessions', 'g1', 'sess-1')));
    expect(await findGrokSessionDir(home, 'sess-2')).toBeNull();
    expect(await findGrokSessionDir(home, '../x')).toBeNull();
    expect(await findGrokSessionDir(home, 'a..b')).toBeNull();
    expect(await findGrokSessionDir(path.join(base, 'none'), 'sess-1')).toBeNull();
  });
});
