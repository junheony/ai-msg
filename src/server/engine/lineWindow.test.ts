import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexBefore, readCodexTranscript, readCodexWindow } from './codexRollout';
import { readGrokBefore, readGrokTranscriptTail, readGrokWindow } from './grokHistory';
import type { ByteWindow } from './lineWindow';
import type { TranscriptMessage } from '../../shared/session-types';

async function write(name: string, lines: unknown[], trailingNewline = true): Promise<string> {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'deck-linewin-')), name);
  await fs.writeFile(f, lines.map((l) => JSON.stringify(l)).join('\n') + (trailingNewline ? '\n' : ''));
  return f;
}

/** Codex turns: turn_context, prompt, assistant note, a tool call (joins the note) and its output, final answer. */
function codexLines(turns: number, pad: number): unknown[] {
  const out: unknown[] = [{ type: 'session_meta', payload: { id: 't' } }];
  for (let i = 0; i < turns; i++) {
    out.push({ type: 'turn_context', payload: { model: `gpt-${i % 3}` } });
    out.push({ timestamp: `t${i}`, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `q${i}` }] } });
    out.push({ timestamp: `t${i}`, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `note${i}` }] } });
    out.push({ timestamp: `t${i}`, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: `c${i}` } });
    out.push({ timestamp: `t${i}`, type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output: 'o'.repeat(pad) } });
    out.push({ timestamp: `t${i}`, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done${i}` }] } });
  }
  return out;
}

function grokLines(n: number, pad: number): unknown[] {
  return Array.from({ length: n }, (_, i) => (i % 3 === 0
    ? { type: 'user', content: `q${i}` }
    : i % 3 === 1
      ? { type: 'assistant', content: `a${i}`, model_id: 'grok', tool_calls: [{ id: `t${i}`, function: { name: 'bash', arguments: '{}' } }] }
      : { type: 'tool', tool_call_id: `t${i - 1}`, content: 'r'.repeat(pad) }));
}

/** Pages from a window back to the start, checking each page's shape; all messages in order. */
async function pageAll(w: ByteWindow, before: (b: number) => Promise<ByteWindow | null>): Promise<{ all: TranscriptMessage[]; pages: number }> {
  let all = w.messages;
  let cursor = w.older;
  let pages = 0;
  while (cursor !== null) {
    const p = await before(cursor);
    expect(p).not.toBeNull();
    expect(p!.older === null || p!.older < cursor).toBe(true);
    all = [...p!.messages, ...all];
    cursor = p!.older;
    pages++;
    expect(pages).toBeLessThan(10_000);
  }
  return { all, pages };
}

/** Older Codex pages may not know an assistant message's model (no turn_context in the region before it). */
const noModel = (ms: TranscriptMessage[]) => ms.map((m) => (m.kind === 'assistant' ? { ...m, model: null } : m));

describe('Codex rollout paging', () => {
  it('window = readCodexTranscript; whole file gives older null', async () => {
    const f = await write('r.jsonl', codexLines(10, 10));
    const w = await readCodexWindow(f);
    expect(w.messages).toEqual(await readCodexTranscript(f));
    expect(w.older).toBeNull();
  });

  it('pages back to the start: every message once, in order (tool calls stay with their message)', async () => {
    const f = await write('r.jsonl', codexLines(1200, 4000));
    expect((await fs.stat(f)).size).toBeGreaterThan(4 * 1024 * 1024);
    const full = await readCodexTranscript(f, { maxMessages: Infinity });
    const w = await readCodexWindow(f);
    expect(w.messages).toEqual(full.slice(-200));
    expect(w.older).not.toBeNull();
    const { all, pages } = await pageAll(w, (b) => readCodexBefore(f, b, 200));
    expect(noModel(all)).toEqual(noModel(full));
    expect(pages).toBeGreaterThanOrEqual(Math.ceil((full.length - 200) / 200));
    // Pages that need more than the first 1MB still come back full.
    const big = await readCodexBefore(f, w.older!, 2000);
    expect(big!.messages.length).toBe(2000);
    expect(noModel(big!.messages)).toEqual(noModel(full.slice(-2200, -200)));
  }, 60_000);

  it('a tail window (maxBytes) pages back into the bytes before it', async () => {
    const f = await write('r.jsonl', codexLines(300, 2000));
    const full = await readCodexTranscript(f, { maxMessages: Infinity });
    const w = await readCodexWindow(f, 64 * 1024, { maxMessages: 10_000 });
    expect(w.older).not.toBeNull();
    const { all } = await pageAll(w, (b) => readCodexBefore(f, b, 100));
    expect(noModel(all)).toEqual(noModel(full));
  });

  it('invalid before: 0, negative, past the end, not an integer → null', async () => {
    const f = await write('r.jsonl', codexLines(5, 10));
    const { size } = await fs.stat(f);
    for (const b of [0, -1, size + 1, 1.5, Number.NaN]) expect(await readCodexBefore(f, b)).toBeNull();
  });
});

describe('Grok chat_history paging', () => {
  it('window = readGrokTranscriptTail; pages back to the start with no gaps or repeats', async () => {
    const f = await write('chat_history.jsonl', grokLines(3000, 1500));
    const full = await readGrokTranscriptTail(f, Infinity, { maxMessages: Infinity });
    const w = await readGrokWindow(f);
    expect(w.messages).toEqual(await readGrokTranscriptTail(f));
    const { all, pages } = await pageAll(w, (b) => readGrokBefore(f, b, 250));
    expect(all).toEqual(full);
    expect(pages).toBe(Math.ceil((full.length - 200) / 250));
  });

  it('a small file: older null; a last line without newline counts', async () => {
    const f = await write('chat_history.jsonl', grokLines(30, 5), false);
    const w = await readGrokWindow(f);
    expect(w.older).toBeNull();
    expect(w.messages).toHaveLength(30);
  });

  it('invalid before → null; a symlink is refused', async () => {
    const f = await write('chat_history.jsonl', grokLines(30, 5));
    const { size } = await fs.stat(f);
    expect(await readGrokBefore(f, 0)).toBeNull();
    expect(await readGrokBefore(f, size + 10)).toBeNull();
    const link = path.join(path.dirname(f), 'link.jsonl');
    await fs.symlink(f, link);
    await expect(readGrokBefore(link, 10)).rejects.toThrow();
    await expect(readGrokWindow(link)).rejects.toThrow();
  });
});
