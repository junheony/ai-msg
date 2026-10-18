import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionEntry } from '../../shared/session-types';
import { TranscriptSearch } from './search';

const L = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string) => L({ type: 'user', cwd: '/w/p', message: { role: 'user', content: text } });
const assistant = (id: string, text: string) => L({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = (text: string) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });

async function session(dir: string, id: string, body: string, lastModified: number): Promise<SessionEntry> {
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, body);
  return { sessionId: id, account: 'b', engine: 'claude', cwd: '/w/p', projectDir: dir, file, title: `title ${id}`, lastModified, sizeBytes: body.length };
}

describe('TranscriptSearch', () => {
  it('finds user and assistant text (not tool output), newest session first, with a highlighted snippet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const a = await session(dir, 'aaa', user('please fix the Flaky websocket test') + assistant('m1', 'Done.') + toolResult('flaky websocket in tool output'), 1);
    const b = await session(dir, 'bbb', user('hello') + assistant('m2', 'The flaky WEBSOCKET reconnect is fixed now.'), 2);
    const c = await session(dir, 'ccc', user('unrelated'), 3);
    const s = new TranscriptSearch({ sessions: () => [a, b, c] });
    const r = await s.search('flaky websocket');
    expect(r.scanned).toBe(3);
    expect(r.hits.map((h) => [h.sessionId, h.role])).toEqual([['bbb', 'assistant'], ['aaa', 'user']]);
    const h = r.hits[0]!;
    expect(h.title).toBe('title bbb');
    expect(h.snippet.slice(h.matchStart, h.matchStart + h.matchLength).toLowerCase()).toBe('flaky websocket');
  });

  it('short queries return nothing; long text is snipped with ellipses', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const long = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`;
    const a = await session(dir, 'aaa', user(long), 1);
    const s = new TranscriptSearch({ sessions: () => [a] });
    expect((await s.search('n')).hits).toEqual([]);
    const [h] = (await s.search('needle')).hits;
    expect(h!.snippet.startsWith('…')).toBe(true);
    expect(h!.snippet.endsWith('…')).toBe(true);
    expect(h!.snippet.length).toBeLessThan(200);
    expect(h!.snippet.slice(h!.matchStart, h!.matchStart + 6)).toBe('needle');
  });

  it('caches by mtime/size: unchanged files are not re-read, changed ones are', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const a = await session(dir, 'aaa', user('alpha'), 1);
    let reads = 0;
    const { readTranscript } = await import('./transcript');
    const s = new TranscriptSearch({ sessions: () => [a], readClaude: (f) => { reads++; return readTranscript(f, { maxMessages: Infinity }); } });
    await s.search('alpha');
    await s.search('alpha');
    expect(reads).toBe(1);
    await fs.appendFile(a.file, user('beta gamma'));
    expect((await s.search('gamma')).hits).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it('skips files over the size cap (truncated) and missing files; respects the hit limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const big = await session(dir, 'big', user(`match ${'z'.repeat(2000)}`), 1);
    const gone = { ...big, sessionId: 'gone', file: path.join(dir, 'missing.jsonl') };
    const r = await new TranscriptSearch({ sessions: () => [big, gone], maxFileBytes: 100 }).search('match');
    expect(r).toMatchObject({ hits: [], scanned: 0, truncated: true });
    const many = await Promise.all(Array.from({ length: 5 }, (_, i) => session(dir, `s${i}`, user('match here'), i)));
    const limited = await new TranscriptSearch({ sessions: () => many }).search('match', 3);
    expect(limited.hits).toHaveLength(3);
    expect(limited.truncated).toBe(true);
  });

  it('reads Codex sessions through the rollout reader', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const file = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(file, 'x');
    const entry: SessionEntry = { sessionId: 'thr', account: 'gpt', engine: 'codex', cwd: '/w', projectDir: dir, file, title: 'gpt', lastModified: 1, sizeBytes: 1 };
    const s = new TranscriptSearch({ sessions: () => [entry], readCodex: async () => [{ kind: 'assistant', text: 'codex answer here', model: null, toolCalls: [], ts: null }] });
    expect((await s.search('answer')).hits[0]).toMatchObject({ sessionId: 'thr', engine: 'codex', account: 'gpt' });
  });
});

describe('TranscriptSearch: conversations made outside deck', () => {
  const grokLine = (o: unknown) => `${JSON.stringify(o)}\n`;
  const entry = (over: Partial<SessionEntry>): SessionEntry => ({ sessionId: 'x', account: 'x1', engine: 'grok', cwd: '/w/p', projectDir: '/w', file: '', title: 't', lastModified: 1, sizeBytes: 0, imported: true, ...over });

  it('each kind is read in its own format: Grok CLI history, Grok Bot transcript; an agy db is never opened', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const grokFile = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(grokFile, grokLine({ type: 'user', content: [{ type: 'text', text: '<user_query>grok needle 질문</user_query>' }] }) + grokLine({ type: 'assistant', content: '답' }));
    const botFile = path.join(dir, 'bot.blob');
    await fs.writeFile(botFile, '{}');
    const geminiDb = path.join(dir, 'conversation_summaries.db');
    await fs.writeFile(geminiDb, user('needle in a db that must stay closed'));
    const readClaude = vi.fn(async () => []);
    const readGrokBot = vi.fn(async () => [{ kind: 'assistant' as const, text: 'bot needle 답', model: null, toolCalls: [], ts: null }]);
    const s = new TranscriptSearch({
      readClaude, readGrokBot,
      sessions: () => [
        entry({ sessionId: 'g-1', file: grokFile, lastModified: 3 }),
        entry({ sessionId: 'grokbot-a', source: 'grokbot', readOnly: true, file: botFile, lastModified: 2 }),
        entry({ sessionId: 'conv-1', engine: 'gemini', account: 'g1', file: geminiDb, lastModified: 1 }),
      ],
    });
    const r = await s.search('needle');
    expect(r.hits.map((h) => [h.sessionId, h.role])).toEqual([['g-1', 'user'], ['grokbot-a', 'assistant']]);
    expect(r.scanned).toBe(2);
    expect(readGrokBot).toHaveBeenCalledWith(botFile);
    expect(readClaude).not.toHaveBeenCalled();
  });

  it('a Grok CLI history over the file cap is still searched, from its end', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-search-'));
    const file = path.join(dir, 'chat_history.jsonl');
    await fs.writeFile(file, grokLine({ type: 'assistant', content: 'x'.repeat(2000) }) + grokLine({ type: 'user', content: 'late needle' }));
    const s = new TranscriptSearch({ sessions: () => [entry({ sessionId: 'g-big', file })], maxFileBytes: 100 });
    const r = await s.search('needle');
    expect(r.truncated).toBe(false);
    expect(r.hits.map((h) => h.sessionId)).toEqual(['g-big']);
  });
});
