import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLine, type CliMessage } from './messages';
import { mapCliMessage, isActivity, BackgroundTracker } from './stream';
import { toUserMessage } from './prompt';
import { fakeClaudeCli, cli, argValue } from './fakeClaudeCli';

const fixture = (name: string): CliMessage[] =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean).map((l) => parseLine(l)!).filter(Boolean);

describe('parseLine', () => {
  it('accepts objects with a string type, rejects the rest', () => {
    expect(parseLine('{"type":"result","subtype":"success"}')).toMatchObject({ type: 'result' });
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('[1]')).toBeNull();
    expect(parseLine('{"no":"type"}')).toBeNull();
  });
});

describe('basic fixture (real CLI capture)', () => {
  const ms = fixture('basic.jsonl');
  it('maps init → deltas → result like the SDK stream did', () => {
    const evs = ms.flatMap(mapCliMessage);
    expect(evs[0]).toMatchObject({ kind: 'init' });
    expect(typeof (evs[0] as { sessionId: string }).sessionId).toBe('string');
    const text = evs.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text.toLowerCase()).toContain('pong');
    const result = evs.find((e) => e.kind === 'result') as { ok: boolean; text: string; usage: { outputTokens: number } };
    expect(result.ok).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
  it('A3/A4: our uuid comes back as a replay and in the result', () => {
    const ours = '00000000-0000-4000-8000-000000000001';
    const replay = ms.find((m) => m.type === 'user' && (m as Record<string, unknown>).isReplay === true);
    const result = ms.find((m) => m.type === 'result') as Record<string, unknown>;
    const named = [...((result.user_message_uuids as string[] | undefined) ?? []), result.user_message_uuid];
    // Both are what the engine relies on; if the capture recorded otherwise in basic.meta.json notes, this test documents it.
    expect(replay?.uuid ?? null).toBe(ours);
    expect(named).toContain(ours);
  });
  it('A5: assistant frames carry uuid and message.id; replay frames are not activity', () => {
    const a = ms.find((m) => m.type === 'assistant') as Record<string, unknown>;
    expect(typeof a.uuid).toBe('string');
    expect(typeof (a.message as Record<string, unknown>).id).toBe('string');
    expect(ms.filter((m) => m.type === 'user').every((m) => !isActivity(m))).toBe(true);
  });
});

describe('moved helpers keep behaving', () => {
  it('BackgroundTracker reads the level signal', () => {
    const bg = new BackgroundTracker(() => 1);
    expect(bg.apply(cli.bgLevel([{ id: 't1', desc: 'sleep' }]) as CliMessage)).toBe(true);
    expect(bg.tasks()).toEqual(['sleep']);
  });
  it('toUserMessage builds one stdin user message with image blocks', async () => {
    const m = await toUserMessage('hi', [{ path: '/x.png', name: 'x.png', mediaType: 'image/png', isImage: true } as never], async () => Buffer.from('PNG'));
    expect(m.type).toBe('user');
    expect(Array.isArray(m.message.content)).toBe(true);
    expect((m.message.content as { type: string }[]).map((b) => b.type)).toEqual(['text', 'image']);
  });
});

describe('fakeClaudeCli', () => {
  it('records argv, parses stdin lines, streams pushed frames and exits on stdin close', async () => {
    const fake = fakeClaudeCli();
    fake.push(cli.init('s9'));
    const child = fake.spawnFn('claude', ['-p', '--model', 'm', '--settings=/x'], { cwd: '/w', env: {} });
    const lines: string[] = [];
    child.stdout.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
    const exit = new Promise<[number | null, string | null]>((r) => child.once('exit', (c, s) => r([c, s])));
    child.stdin.end();
    expect(await exit).toEqual([0, null]);
    expect(fake.inputs).toHaveLength(1);
    expect(fake.state.inputClosed).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'system', subtype: 'init', session_id: 's9' });
    expect(argValue(fake.spawns[0]!.args, '--model')).toBe('m');
    expect(argValue(fake.spawns[0]!.args, '--settings')).toBe('/x');
  });
  it('SIGINT exits 130 by default, SIGTERM by signal', async () => {
    const fake = fakeClaudeCli();
    const a = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const ea = new Promise((r) => a.once('exit', (c, s) => r([c, s])));
    a.kill('SIGINT');
    expect(await ea).toEqual([130, null]);
    const b = fake.spawnFn('claude', [], { cwd: '/w', env: {} });
    const eb = new Promise((r) => b.once('exit', (c, s) => r([c, s])));
    b.kill('SIGTERM');
    expect(await eb).toEqual([null, 'SIGTERM']);
    expect(fake.state.signals).toEqual(['SIGINT', 'SIGTERM']);
  });
});
