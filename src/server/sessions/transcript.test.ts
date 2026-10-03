import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findBranchPoint, hookMessage, parseHead, parseTranscript, readHead, readTranscript, textOfContent } from './transcript';

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
      { kind: 'user', text: 'run ls', ts: 't1', n: 0 },
      { kind: 'assistant', text: 'Sure.', model: 'claude-opus-5-5', toolCalls: [{ id: 'tu1', name: 'Bash', input: { command: 'ls' } }], ts: 't2', thinking: 'hm' },
      { kind: 'tool_result', toolUseId: 'tu1', content: 'a.txt', isError: false, ts: 't3' },
      { kind: 'assistant', text: 'Done.', model: 'claude-opus-5-5', toolCalls: [], ts: 't4' },
    ]);
  });
});

describe('parseTranscript — context usage', () => {
  it('keeps the latest chunk usage on a merged assistant entry; zero-usage (synthetic) messages carry none', () => {
    const text = [
      L({ type: 'assistant', timestamp: 't1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 1 } } }),
      L({ type: 'assistant', timestamp: 't1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 9 } } }),
      L({ type: 'assistant', timestamp: 't2', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 0 } } }),
    ].join('\n');
    const out = parseTranscript(text);
    expect(out[0]).toMatchObject({ kind: 'assistant', usage: { inputTokens: 3, cacheReadTokens: 100, cacheCreationTokens: 20 } });
    expect(out[1]).not.toHaveProperty('usage');
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

describe('readTranscript — streaming with caps', () => {
  async function write(lines: string[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-tr-'));
    const f = path.join(dir, 's.jsonl');
    await fs.writeFile(f, lines.join('\n') + '\n');
    return f;
  }

  it('returns only the last maxMessages messages (default 200), same as parsing the whole text', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => L({ type: 'user', timestamp: `t${i}`, message: { role: 'user', content: `m${i}` } }));
    const f = await write(lines);
    const all = await readTranscript(f);
    expect(all).toHaveLength(200);
    expect(all[0]).toEqual({ kind: 'user', text: 'm100', ts: 't100', n: 100 });
    expect(all[199]).toEqual({ kind: 'user', text: 'm299', ts: 't299', n: 299 });
    expect(await readTranscript(f, { maxMessages: 5 })).toEqual(parseTranscript(lines.join('\n')).slice(-5));
  });

  it('merges streamed assistant chunks across line boundaries like parseTranscript', async () => {
    const lines = [
      L({ type: 'user', message: { role: 'user', content: 'go' } }),
      L({ type: 'assistant', message: { id: 'a1', model: 'm', role: 'assistant', content: [{ type: 'text', text: 'one' }] } }),
      L({ type: 'assistant', message: { id: 'a1', model: 'm', role: 'assistant', content: [{ type: 'text', text: 'two' }] } }),
    ];
    expect(await readTranscript(await write(lines))).toEqual(parseTranscript(lines.join('\n')));
  });

  it('truncates large tool results (default 8 KB) with a marker', async () => {
    const big = 'y'.repeat(20_000);
    const f = await write([L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: big }] } })]);
    const [m] = await readTranscript(f);
    expect(m?.kind).toBe('tool_result');
    if (m?.kind !== 'tool_result') return;
    expect(m.content.length).toBeLessThan(8_300);
    expect(m.content.startsWith('y'.repeat(8192))).toBe(true);
    expect(m.content).toContain('잘림');
    expect(m.truncated).toBe(true);
    const [full] = await readTranscript(f, { maxToolResultChars: Infinity });
    expect(full?.kind === 'tool_result' && full.content).toBe(big);
  });
});

describe('isMeta user lines (hook feedback and other harness injections)', () => {
  const meta = (content: string, extra: Record<string, unknown> = {}) => L({ type: 'user', isMeta: true, timestamp: 'tm', message: { role: 'user', content }, ...extra });
  const LINES = [
    L({ type: 'user', timestamp: 't1', uuid: 'u0', message: { role: 'user', content: '첫 질문' } }),
    L({ type: 'assistant', timestamp: 't2', uuid: 'a0', parentUuid: 'u0', message: { id: 'm1', content: [{ type: 'text', text: '답 0' }] } }),
    meta('Stop hook feedback:\n[verify] 테스트가 아직 실패합니다', { uuid: 'h0', parentUuid: 'a0' }),
    L({ type: 'assistant', timestamp: 't3', uuid: 'a0b', parentUuid: 'h0', message: { id: 'm2', content: [{ type: 'text', text: '고쳤어요' }] } }),
    meta('<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>', { uuid: 'c0', parentUuid: 'a0b' }),
    meta('Base directory for this skill: /x\n\n# Skill body', { uuid: 's0', parentUuid: 'c0' }),
    L({ type: 'user', timestamp: 't4', uuid: 'u1', parentUuid: 's0', message: { role: 'user', content: '두 번째' } }),
  ];

  it('a Stop-hook line becomes a hook entry; other meta lines are hidden; ordinals skip them', () => {
    const msgs = parseTranscript(LINES.join('\n'));
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'assistant', 'hook', 'assistant', 'user']);
    expect(msgs[2]).toEqual({ kind: 'hook', event: 'Stop', text: 'Stop hook feedback:\n[verify] 테스트가 아직 실패합니다', ts: 'tm' });
    expect(msgs.filter((m) => m.kind === 'user').map((m) => (m.kind === 'user' ? [m.text, m.n] : null))).toEqual([['첫 질문', 0], ['두 번째', 1]]);
  });

  it('the hook row splits the assistant reply (the continuation is a new assistant entry)', () => {
    const msgs = parseTranscript(LINES.join('\n'));
    expect(msgs[1]).toMatchObject({ kind: 'assistant', text: '답 0' });
    expect(msgs[3]).toMatchObject({ kind: 'assistant', text: '고쳤어요' });
  });

  it('parseHead titles from the first real prompt, never a meta line', () => {
    expect(parseHead([meta('Stop hook feedback:\nx'), meta('Continue from where you left off.'), L({ type: 'user', cwd: CWD, message: { role: 'user', content: '진짜 질문' } })].join('\n'))).toEqual({ cwd: CWD, title: '진짜 질문' });
  });

  it('findBranchPoint counts only real prompts', () => {
    expect(findBranchPoint(LINES, 1)).toEqual({ n: 1, at: 's0', uuid: 'u1' });
  });

  it('hookMessage recognises feedback and blocking errors (with matcher), nothing else', () => {
    expect(hookMessage('Stop hook feedback:\nkeep going')).toEqual({ event: 'Stop', text: 'Stop hook feedback:\nkeep going' });
    expect(hookMessage('PreToolUse:Bash hook blocking error from command: "x": denied')?.event).toBe('PreToolUse');
    expect(hookMessage('SubagentStop hook feedback:\n…')?.event).toBe('SubagentStop');
    expect(hookMessage('Continue from where you left off.')).toBeNull();
    expect(hookMessage('my Stop hook feedback: is great')).toBeNull();
  });
});
