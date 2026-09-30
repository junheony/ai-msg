import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHead, parseTranscript, readHead, textOfContent } from './transcript';

const L = (o: unknown) => JSON.stringify(o);
const CWD = '/Users/max/Documents/개발/agentic-harness';

describe('textOfContent', () => {
  it('handles string content, text blocks, and image blocks', () => {
    expect(textOfContent('hi')).toBe('hi');
    expect(textOfContent([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }])).toBe('a\n[이미지]\nb');
    expect(textOfContent(null)).toBe('');
  });
});

describe('parseHead', () => {
  it('takes cwd from the first record that has one and title from custom-title', () => {
    const text = [
      L({ type: 'queue-operation', sessionId: 's1' }),
      L({ type: 'custom-title', customTitle: 'Old', sessionId: 's1' }),
      L({ type: 'user', cwd: CWD, message: { role: 'user', content: 'first prompt' } }),
      L({ type: 'custom-title', customTitle: 'Agentic Harness', sessionId: 's1' }),
    ].join('\n');
    expect(parseHead(text)).toEqual({ cwd: CWD, title: 'Agentic Harness' });
  });

  it('falls back to the first real user message, skipping compact summaries and <command> wrappers', () => {
    const text = [
      L({ type: 'user', cwd: CWD, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } }),
      L({ type: 'user', cwd: CWD, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      L({ type: 'user', cwd: CWD, isSidechain: true, message: { role: 'user', content: 'sub agent prompt' } }),
      L({ type: 'user', cwd: CWD, message: { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '이 폴더 어떤지\n둘째 줄' }] } }),
    ].join('\n');
    expect(parseHead(text).title).toBe('[이미지]');
    const text2 = text.split('\n').slice(0, 3).concat(L({ type: 'user', cwd: CWD, message: { role: 'user', content: 'x'.repeat(100) } })).join('\n');
    expect(parseHead(text2).title).toBe('x'.repeat(80));
  });

  it('survives a truncated last line and returns nulls when nothing is found', () => {
    expect(parseHead('{"type":"user","cwd":"/a","message":{"role":"user","content":"ab')).toEqual({ cwd: null, title: null });
    expect(parseHead('')).toEqual({ cwd: null, title: null });
  });
});

describe('parseTranscript', () => {
  it('produces user / assistant (merged per message id) / tool_result entries', () => {
    const text = [
      L({ type: 'user', timestamp: 't1', message: { role: 'user', content: 'run ls' } }),
      L({ type: 'assistant', timestamp: 't2', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Sure.' }] } }),
      L({ type: 'assistant', timestamp: 't2', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
      L({ type: 'user', timestamp: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt', is_error: false }] } }),
      L({ type: 'assistant', timestamp: 't4', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
      L({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary...' } }),
      L({ type: 'system', subtype: 'compact_boundary' }),
      L({ type: 'user', isSidechain: true, message: { role: 'user', content: 'agent prompt' } }),
      'not json',
    ].join('\n');
    expect(parseTranscript(text)).toEqual([
      { kind: 'user', text: 'run ls', ts: 't1' },
      { kind: 'assistant', text: 'Sure.', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], ts: 't2' },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'a.txt', isError: false, ts: 't3' },
      { kind: 'assistant', text: 'Done.', model: 'claude-opus-5-5', toolCalls: [], ts: 't4' },
    ]);
  });
});

describe('readHead — title', () => {
  const ID = '66666666-6666-4666-8666-666666666666';
  async function big(extra: string[] = []): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-title-'));
    const file = path.join(dir, `${ID}.jsonl`);
    const pad = L({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
    const lines = [
      L({ type: 'custom-title', customTitle: 'Early', sessionId: ID }),
      L({ type: 'user', cwd: CWD, message: { role: 'user', content: 'first prompt' } }),
      ...Array(400).fill(pad),
      ...extra,
      ...Array(3).fill(pad),
    ];
    await fs.writeFile(file, lines.join('\n') + '\n');
    expect((await fs.stat(file)).size).toBeGreaterThan(300 * 1024);
    return file;
  }

  it('uses the LAST custom-title even when it is past the first 256 KB', async () => {
    const file = await big([L({ type: 'custom-title', customTitle: 'Mid', sessionId: ID }), L({ type: 'custom-title', customTitle: 'Late', sessionId: ID })]);
    expect(await readHead(file)).toEqual({ cwd: CWD, title: 'Late' });
  });

  it('a custom-title in the tail beats the companion file (the companion can be stale)', async () => {
    const file = await big([L({ type: 'custom-title', customTitle: 'Late', sessionId: ID })]);
    await fs.mkdir(file.replace(/\.jsonl$/, ''), { recursive: true });
    await fs.writeFile(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), '{"customTitle":"Stale companion"}');
    expect((await readHead(file)).title).toBe('Late');
  });

  it('without a tail custom-title, the companion <id>/custom-title.json beats the head', async () => {
    const file = await big();
    await fs.mkdir(file.replace(/\.jsonl$/, ''), { recursive: true });
    await fs.writeFile(path.join(file.replace(/\.jsonl$/, ''), 'custom-title.json'), '{"customTitle":"From companion"}');
    expect((await readHead(file)).title).toBe('From companion');
  });

  it('in a small file the last custom-title also beats a stale companion', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-title-'));
    const f = path.join(dir, `${ID}.jsonl`);
    await fs.writeFile(f, [L({ type: 'user', cwd: CWD, message: { role: 'user', content: 'hi' } }), L({ type: 'custom-title', customTitle: 'Renamed', sessionId: ID })].join('\n') + '\n');
    await fs.mkdir(path.join(dir, ID));
    await fs.writeFile(path.join(dir, ID, 'custom-title.json'), '{"customTitle":"Old"}');
    expect((await readHead(f)).title).toBe('Renamed');
  });

  it('falls back to a head custom-title, then the first user message', async () => {
    expect((await readHead(await big())).title).toBe('Early');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-title-'));
    const f = path.join(dir, `${ID}.jsonl`);
    await fs.writeFile(f, L({ type: 'user', cwd: CWD, message: { role: 'user', content: 'hello there' } }) + '\n');
    await fs.mkdir(path.join(dir, ID));
    await fs.writeFile(path.join(dir, ID, 'custom-title.json'), 'not json');
    expect(await readHead(f)).toEqual({ cwd: CWD, title: 'hello there' });
  });
});
